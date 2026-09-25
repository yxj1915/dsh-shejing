/**
 * 拍摄前规则 —— 复盘阶段的写入目标。
 *
 * 一个必须处理的现实：`skills/shejing/references/shooting-rules.md` 在 npm 包里，
 * 装完之后是**只读**的。而复盘的本质就是往里追加东西，所以第一次用到时把它复制到
 * `$SHEJING_HOME/shooting-rules.md`，之后只写那一份。
 *
 * 包内那份是**种子**，不是真源：升级插件时如果只覆盖包内文件，用户积累的教训不会丢，
 * 但也不会自动获得种子里的新增内容。所以这里记录种子指纹，升级后如果种子变了而用户
 * 那份没被手工改过，就自动并入；若两份都变了则**只报告、不自动合并**——教训丢失
 * 比多一条规则严重得多。
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { SHEJING_HOME } from './lr/install.mjs'

/** 包内的种子规则（只读）。 */
export const SEED_RULES_FILE = fileURLToPath(
  new URL('../skills/shejing/references/shooting-rules.md', import.meta.url),
)

/** 用户实际累积的规则文件（可写）。 */
export const RULES_FILE = path.join(SHEJING_HOME, 'shooting-rules.md')

const META_FILE = path.join(SHEJING_HOME, 'rules-meta.json')

async function exists(target) {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

/**
 * 确保可写的规则文件存在，并处理种子更新。
 * @returns {Promise<{status:'seeded'|'current'|'merged'|'diverged', file:string, note:string}>}
 */
export async function ensureRulesFile() {
  await mkdir(SHEJING_HOME, { recursive: true })
  const seed = await readFile(SEED_RULES_FILE, 'utf8')
  const seedHash = sha256(seed)
  const meta = await readJson(META_FILE, {})

  if (!(await exists(RULES_FILE))) {
    await writeFile(RULES_FILE, seed, 'utf8')
    await writeFile(META_FILE, `${JSON.stringify({ seedHash, seededAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
    return { status: 'seeded', file: RULES_FILE, note: `已从包内种子建立规则文件：${RULES_FILE}` }
  }

  const live = await readFile(RULES_FILE, 'utf8')
  const liveHash = sha256(live)

  if (seedHash === meta.seedHash) {
    return { status: 'current', file: RULES_FILE, note: '规则文件已是最新。' }
  }

  // 种子变了。用户那份动过没有？
  if (liveHash !== meta.seedHash) {
    return {
      status: 'diverged',
      file: RULES_FILE,
      note: '包内种子与你累积的规则都变过——**不自动合并**，请人工核对后决定。'
        + `包内种子：${SEED_RULES_FILE}`,
    }
  }

  await writeFile(RULES_FILE, seed, 'utf8')
  await writeFile(META_FILE, `${JSON.stringify({ seedHash, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
  return { status: 'merged', file: RULES_FILE, note: '包内种子有更新，已并入你那份（你没改过它）。' }
}

/**
 * 追加一条规则。**只追加，永不删除**——被否掉的规则留在文件里，防止同一个错犯第二次。
 * @returns {Promise<{file:string, bytes:number}>}
 */
export async function appendRule({ title, body, evidence, batchId }) {
  const state = await ensureRulesFile()
  const before = await readFile(RULES_FILE, 'utf8')
  const lines = [
    '',
    `## ${title}`,
    '',
    body.trim(),
    '',
    evidence === undefined || evidence === '' ? '' : `- 依据：${evidence.trim()}`,
    batchId === undefined || batchId === '' ? '' : `- 来自批次：${batchId}`,
    `- 记入时间：${new Date().toISOString().replace('T', ' ').slice(0, 19)}`,
    '',
  ].filter(line => line !== '')
  const after = `${before.trimEnd()}\n${lines.join('\n')}`
  await writeFile(RULES_FILE, after, 'utf8')
  return { file: RULES_FILE, bytes: after.length, state }
}
