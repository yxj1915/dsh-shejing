/**
 * 批次账本的位置与读写。
 *
 * 账本放 `$DSH_HOME/shejing/batches/<批次>/`，**不放在照片文件夹里**：
 *   · 插件升级/重装不会丢账本（npm 包目录是只读的）
 *   · 照片目录保持干净——只多出 `可导入/` 与 `非导入/` 这两个由剔除阶段
 *     就地创建的目录
 * 批次身份沿用用户习惯：片子在哪个文件夹，那个文件夹就是一批。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { SHEJING_HOME } from './lr/install.mjs'

export function batchesRoot() {
  return path.join(SHEJING_HOME, 'batches')
}

/** 本地日期，避免 toISOString 的 UTC 偏移把「9.25」写成「9.24」。 */
function localDateStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** `2026-09-25_9.25` 这种形状：日期 + 源文件夹名。 */
export function batchIdFor(source) {
  const base = path.basename(path.resolve(source)).replace(/[/:\\]/g, '_') || 'batch'
  return `${localDateStamp()}_${base}`
}

export function batchDirFor(source, explicitId) {
  return path.join(batchesRoot(), explicitId ?? batchIdFor(source))
}

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true })
  return dir
}

export async function readManifest(batchDir) {
  try {
    return JSON.parse(await readFile(path.join(batchDir, 'manifest.json'), 'utf8'))
  } catch {
    return null
  }
}

export async function writeManifest(batchDir, manifest) {
  await ensureDir(batchDir)
  const file = path.join(batchDir, 'manifest.json')
  await writeFile(file, `${JSON.stringify(manifest, null, 1)}\n`, 'utf8')
  return file
}

/** 列出所有批次目录（新的在前）。 */
export async function listBatches() {
  const { readdir, stat } = await import('node:fs/promises')
  let entries
  try {
    entries = await readdir(batchesRoot(), { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = path.join(batchesRoot(), entry.name)
    let mtime = 0
    try { mtime = (await stat(dir)).mtimeMs } catch { /* 忽略 */ }
    out.push({ id: entry.name, dir, mtime })
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}
