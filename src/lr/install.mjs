/**
 * Lightroom 内 `.lrplugin` 的安装器。
 *
 * 为什么不用 bridge 自带的 ensurePluginInstalled：
 *   它只要发现任何位置已经装了 `.lrplugin` 就直接返回（`isPluginInstalledAnywhere`），
 *   而 installPlugin 在目标存在时只报 `already-present`。这导致两个真实问题：
 *     1. 用户装过上游版本 → 我们的（带色标/收藏夹补丁的）Lua 代码永远不会生效；
 *     2. 上游改了 Lua → 已装副本不会更新。
 *   所以这里做**内容比对 + 备份 + 覆盖**，并且永不删除目标目录里我们不认识的
 *   文件（用户自己的 .bak / .orig-dsh 备份要留着）。
 */

import { createHash } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 包内自带的 `.lrplugin`（已打补丁的那份真源）。 */
export const BUNDLED_LRPLUGIN = fileURLToPath(
  new URL('../../lrbridge/dist/LightroomMCP.lrplugin', import.meta.url),
)

/** DSH 的 home 目录（隔离实例通过 DSH_HOME 覆盖）。 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : path.join(homedir(), '.dsh')
}

/** 本插件的私有状态目录：账本、备份、运行期数据都在这里。 */
export const SHEJING_HOME = path.join(dshHome(), 'shejing')

/** Lightroom 的 Modules 目录（与 bridge 的 install-plugin.js 保持一致）。 */
export function lightroomModulesDir() {
  // 允许用环境变量覆盖，**为了测试能在隔离目录里跑**。
  //
  // 不这么做的话，测试只能看到「已是最新」那条空转路径——本机插件本来就装好了。
  // 审计员的变异 21 证明了后果：把 syncLrplugin 改成永远返回 'current'，
  // 测试全绿；而 DESIGN 说这个文件存在的全部理由正是「比对、备份、更新」这三条
  // 分支。用一个临时 HOME 去测也不安全——万一 homedir() 没跟着变，
  // 测试就会覆盖用户真实的 Lightroom 插件。
  const override = process.env.SHEJING_LR_MODULES_DIR
  if (override !== undefined && override !== '') return override
  if (process.platform === 'darwin') {
    return path.join(homedir(), 'Library', 'Application Support', 'Adobe', 'Lightroom', 'Modules')
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming')
    return path.join(appData, 'Adobe', 'Lightroom', 'Modules')
  }
  return path.join(homedir(), '.local', 'share', 'Adobe', 'Lightroom', 'Modules')
}

export function installedLrpluginDir() {
  return path.join(lightroomModulesDir(), 'LightroomMCP.lrplugin')
}

async function hashFile(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex')
}

/** 列出目录下所有 `.lua` 文件（相对路径 → 绝对路径）。 */
async function luaFiles(dir) {
  const out = new Map()
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!entry.name.endsWith('.lua')) continue
    out.set(entry.name, path.join(dir, entry.name))
  }
  return out
}

async function exists(target) {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

/**
 * 比对并同步 Lua 插件。
 * @returns {Promise<{status:'installed'|'updated'|'current'|'missing-source',
 *   destination:string, changed:string[], backedUpTo?:string, message:string}>}
 */
export async function syncLrplugin({ log = () => {} } = {}) {
  const destination = installedLrpluginDir()

  if (!(await exists(path.join(BUNDLED_LRPLUGIN, 'Info.lua')))) {
    return {
      status: 'missing-source',
      destination,
      changed: [],
      message: `包内找不到 .lrplugin：${BUNDLED_LRPLUGIN}`,
    }
  }

  const bundled = await luaFiles(BUNDLED_LRPLUGIN)
  const installed = await luaFiles(destination)
  const wasInstalled = await exists(path.join(destination, 'Info.lua'))

  const changed = []
  for (const [name, sourcePath] of bundled) {
    const targetPath = installed.get(name)
    if (targetPath === undefined) {
      changed.push(name)
      continue
    }
    if ((await hashFile(sourcePath)) !== (await hashFile(targetPath))) changed.push(name)
  }

  if (wasInstalled && changed.length === 0) {
    const extra = [...installed.keys()].filter(name => !bundled.has(name))
    return {
      status: 'current',
      destination,
      changed: [],
      message: extra.length === 0
        ? `Lightroom 插件已是最新（${bundled.size} 个 Lua 文件）。`
        : `Lightroom 插件已是最新（${bundled.size} 个 Lua 文件）；目标目录另有 ${extra.length} 个非本插件文件，未触碰。`,
    }
  }

  // 有差异 → 先备份将要被覆盖的文件，再写入。
  let backedUpTo
  // 备份的判据是「即将被覆盖的文件」，不是「Info.lua 在不在」。
  // 原先由单个文件的存在与否决定要不要备份，而写入是无条件的：用户把 Info.lua
  // 改名来停用插件（很常见）时，他手改过的 JSON.lua 会被直接覆盖且不留备份。
  if (changed.length > 0) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    backedUpTo = path.join(SHEJING_HOME, 'backups', `lrplugin-${stamp}`)
    await mkdir(backedUpTo, { recursive: true })
    for (const name of changed) {
      const targetPath = installed.get(name)
      if (targetPath === undefined) continue
      await copyFile(targetPath, path.join(backedUpTo, name))
    }
    log(`[shejing] 已备份 ${changed.length} 个旧 Lua 文件到 ${backedUpTo}`)
  }

  await mkdir(destination, { recursive: true })
  for (const [name, sourcePath] of bundled) {
    await copyFile(sourcePath, path.join(destination, name))
  }

  const status = wasInstalled ? 'updated' : 'installed'
  const message = status === 'installed'
    ? `已把 Lightroom 插件装到 ${destination}。`
    : `已更新 ${changed.length} 个 Lua 文件：${changed.join('、')}`
      + (backedUpTo === undefined ? '' : `（旧文件备份在 ${backedUpTo}）`)

  return { status, destination, changed, backedUpTo, message }
}

/** 把本次同步结果落盘，便于 doctor 与用户事后核对。 */
export async function recordLrpluginSync(report) {
  await mkdir(SHEJING_HOME, { recursive: true })
  const file = path.join(SHEJING_HOME, 'lrplugin-sync.json')
  await writeFile(
    file,
    `${JSON.stringify({ at: new Date().toISOString(), ...report }, null, 2)}\n`,
    'utf8',
  )
  return file
}
