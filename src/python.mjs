/**
 * 找到 DSH 自带的 Python 运行时并执行摄鲸的脚本。
 *
 * 为什么用 DSH 自带的解释器：系统 `python3` 没有 Pillow / numpy，而摄鲸的体检
 * 依赖它们。DSH 桌面端在每个用户的 `$DSH_HOME/dsh-runtimes/*` 下都带了一份
 * （含 Pillow、numpy），所以「发布给所有人」这个前提是成立的。
 */

import { spawn } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 包内 `python/` 目录。 */
export const PYTHON_DIR = fileURLToPath(new URL('../python/', import.meta.url))

async function isExecutable(target) {
  try {
    const info = await stat(target)
    return info.isFile()
  } catch {
    return false
  }
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
