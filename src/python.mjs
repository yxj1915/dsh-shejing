/**
 * 找到 DSH 自带的 Python 运行时并执行摄鲸的脚本。
 *
 * 为什么用 DSH 自带的解释器：系统 `python3` 没有 Pillow / numpy，而摄鲸的体检
 * 依赖它们。DSH 桌面端在每个用户的 `$DSH_HOME/dsh-runtimes/*` 下都带了一份
 * （含 Pillow、numpy），所以「发布给所有人」这个前提是成立的。
 */

import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 包内 `python/` 目录。 */
export const PYTHON_DIR = fileURLToPath(new URL('../python/', import.meta.url))

/**
 * 这个候选解释器能不能用。
 *
 * 两种写法都要认：
 *   · 路径（绝对或带分隔符）——存在、是文件、**且有可执行位**
 *   · 裸命令名（如 `python3`）——到 PATH 上找
 *
 * 原来只做 `stat(target).isFile()`，两个后果都在 CI 上炸过：
 *   1. `SHEJING_PYTHON=python` 这类**裸命令名**被当成相对路径，永远找不到——
 *      而工具自己的报错信息里写的就是「用 SHEJING_PYTHON 指定解释器」，
 *      用户自然会填命令名。CI 第一次跑就是这样挂的。
 *   2. 不检查可执行位，选出一个没有 x 位的文件，直到 spawn 才失败——
 *      那时错误信息已经离原因很远了。
 */
async function isExecutable(target) {
  const looksLikePath = path.isAbsolute(target) || target.includes(path.sep)
  if (looksLikePath) {
    try {
      const info = await stat(target)
      if (!info.isFile()) return false
      await access(target, constants.X_OK)
      return true
    } catch {
      return false
    }
  }
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir === '') continue
    const full = path.join(dir, target)
    try {
      const info = await stat(full)
      if (!info.isFile()) continue
      await access(full, constants.X_OK)
      return true
    } catch {
      // 这个目录里没有，继续找
    }
  }
  return false
}

function dshHome() {
  return process.env.DSH_HOME ?? path.join(homedir(), '.dsh')
}

/**
 * 按优先级寻找解释器：显式环境变量 → DSH 自带运行时 → PATH 上的 python3。
 * @returns {Promise<{command:string, source:string}|null>}
 */
export async function resolvePython() {
  const explicit = process.env.SHEJING_PYTHON
  if (explicit !== undefined && explicit !== '' && (await isExecutable(explicit))) {
    return { command: explicit, source: 'SHEJING_PYTHON' }
  }

  const roots = [path.join(dshHome(), 'dsh-runtimes'), path.join(homedir(), '.dsh', 'dsh-runtimes')]
  const seen = new Set()
  for (const root of roots) {
    if (seen.has(root)) continue
    seen.add(root)
    let runtimes
    try {
      runtimes = await readdir(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const runtime of runtimes) {
      if (!runtime.isDirectory()) continue
      const binDir = path.join(root, runtime.name, 'dependencies', 'python', 'bin')
      let files
      try {
        files = await readdir(binDir)
      } catch {
        continue
      }
      // 优先 python3，其次 python3.N
      const ordered = files
        .filter(f => /^python3(\.\d+)?$/.test(f))
        .sort((a, b) => (a.length - b.length) || a.localeCompare(b))
      for (const file of ordered) {
        const candidate = path.join(binDir, file)
        if (await isExecutable(candidate)) {
          return { command: candidate, source: path.join(runtime.name, 'dependencies/python') }
        }
      }
    }
  }

  return null
}

/**
 * 跑一个摄鲸脚本。
 * @param script 相对 `python/` 的文件名，例如 `10_checkup.py`
 * @param args CLI 参数
 * @param opts timeoutMs / onLog
 * @returns {Promise<{ok:boolean, code:number|null, stdout:string, stderr:string, command:string}>}
 */
export async function runScript(script, args, { timeoutMs = 600_000, signal } = {}) {
  const python = await resolvePython()
  if (python === null) {
    throw new Error(
      '找不到可用的 Python 解释器。摄鲸需要 DSH 自带运行时（含 Pillow / numpy）：'
      + `请确认 ${path.join(dshHome(), 'dsh-runtimes')} 存在，或用 SHEJING_PYTHON 指定解释器。`,
    )
  }

  const scriptPath = path.join(PYTHON_DIR, script)
  return await new Promise((resolve, reject) => {
    const child = spawn(python.command, [scriptPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`${script} 超时（${Math.round(timeoutMs / 1000)}s）`))
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, code, stdout, stderr, command: python.command })
    })
  })
}
