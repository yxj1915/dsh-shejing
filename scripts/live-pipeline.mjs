/**
 * 真机写入验证：在**克隆出来的**批次上跑完整流水线。
 *
 * 覆盖「我们的插件 ↔ 真 bridge ↔ Lightroom 里的 Lua 插件」这条链，是所有假桥接
 * 测试都碰不到的部分：导入、调色、读回、导出。
 *
 * **只碰克隆副本**。请在运行前确认：
 *   · 目标目录是 dsh things/shejing-regression/...，不是你的原片 Desktop/9.25
 *   · 它会往你的 Lightroom 目录里添几张指向克隆文件的记录（不是你的原件）
 * 清理方法在最后会打印出来。
 *
 * 前置：Lightroom 已打开，文件 ▸ 增效工具管理器 ▸ Lightroom MCP ▸ Start Server。
 *
 * 用法：DSH_HOME=<repo>/.dev/dsh-home node scripts/live-pipeline.mjs [--skip-clone]
 */

import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const dshHome = process.env.DSH_HOME
if (dshHome === undefined) {
  console.error('请设置 DSH_HOME（隔离实例的 home）。')
  process.exit(2)
}

const ORIGIN = '/Users/xingjianyan/Desktop/9.25'
const LIVE_DIR = path.resolve(ROOT, '..', 'shejing-regression', 'live-pipeline')
const BATCH_ID = 'live-pipeline'
const COUNT = 3

let failed = 0
function step(label, ok, detail) {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failed += 1
}

/* ---------------------------------------------------------------- 准备克隆 */

if (!process.argv.includes('--skip-clone')) {
  await rm(LIVE_DIR, { recursive: true, force: true })
  await mkdir(LIVE_DIR, { recursive: true })
  const sources = readdirSync(ORIGIN).filter(f => f.toUpperCase().endsWith('.ARW')).sort().slice(0, COUNT)
  for (const name of sources) {
    await cp(path.join(ORIGIN, name), path.join(LIVE_DIR, name))
  }
  console.log(`克隆 ${sources.length} 张到 ${LIVE_DIR}\n`)
  await rm(path.join(dshHome, 'shejing', 'batches', BATCH_ID), { recursive: true, force: true })
  await rm(path.join(dshHome, 'shejing', 'gates'), { recursive: true, force: true })
}

/* ---------------------------------------------------------------- 假上下文（真桥接） */

const tools = new Map()
const handlers = new Map()
const ctx = {
  logger: { info: () => {}, warn: () => {} },
  tools: { register: (d) => { tools.set(d.name, d); return () => {} } },
  skills: { registerProvider: () => () => {} },
  systemPrompt: { section: () => () => {} },
  effect: (fn) => { fn(); return () => {} },
  on: (event, handler) => { if (!handlers.has(event)) handlers.set(event, []); handlers.get(event).push(handler); return () => {} },
  connection: { fetch: { register: () => () => {} } },
  inject: (names, cb) => { if (names.includes('systemPrompt') || names.includes('connection')) cb(ctx) },
}

const mod = await import('../src/index.mjs')
mod.apply(ctx, {})

const allow = async () => ({ kind: 'allow' })
/** 走真实流程；门禁弹两次就自动批准两次（本次运行你已经同意过写入验证）。 */
async function invoke(name, args) {
  const pre = handlers.get('tools/pre-execute')?.[0]
  const exec = { name, arguments: args }
  for (let attempt = 0; attempt < 3; attempt++) {
    const decision = pre === undefined ? { kind: 'allow' } : await pre(exec, allow)
    if (decision.kind === 'ask') {
      console.log(`     [门禁] ${String(decision.reason).split('\n')[0].slice(0, 100)}…（已批准）`)
      continue
    }
    const output = await tools.get(name).execute(args, {})
    const post = handlers.get('tools/post-execute')?.[0]
    if (post !== undefined) await post(exec, { ok: true }, allow)
    return output
  }
  throw new Error(`${name} 的门禁连续要求确认，放弃`)
}

/** 直达桥接，用来做「独立手段复核」。 */
const { LightroomBridge } = await import('../src/lr/bridge.mjs')
const bridge = new LightroomBridge({ log: () => {} })

console.log('真机写入验证（只碰克隆副本）\n')

/* ---------------------------------------------------------------- 1. 体检 */

console.log('—— ① 体检 ——')
const checkup = await invoke('shejing_checkup', { source: LIVE_DIR, batch_id: BATCH_ID })
step('体检跑完', /① 证据/.test(checkup), checkup.split('\n').find(l => /张/.test(l))?.trim())
const batchDir = path.join(dshHome, 'shejing', 'batches', BATCH_ID)
step('账本已写出', existsSync(path.join(batchDir, 'manifest.json')))
step('contact sheet 已生成', existsSync(path.join(batchDir, 'contact_sheet.jpg')))

/* ---------------------------------------------------------------- 2. 剔除 */

console.log('\n—— ② 剔除（无剔除项，全进可导入/）——')
const cull = await invoke('shejing_cull', { batch_id: BATCH_ID, reject: [], confirm: true })
const keepDir = path.join(LIVE_DIR, '可导入')
step('可导入/ 建起来了', existsSync(keepDir), `${existsSync(keepDir) ? readdirSync(keepDir).length : 0} 张`)
step('原件没被删', readdirSync(LIVE_DIR).filter(f => f.endsWith('.ARW')).length === 0,
  '根目录已无 ARW（都移进 可导入/）')
void cull

/* ---------------------------------------------------------------- 3. 整理：原地导入 */

console.log('\n—— ③ 整理：原地导入（真写入目录）——')
const organize = await invoke('shejing_organize', { batch_id: BATCH_ID, import: true })
step('导入调用完成', /导入|import_photos/i.test(organize))
const manifest1 = JSON.parse(await readFile(path.join(batchDir, 'manifest.json'), 'utf8'))
step('账本记下 ingest', Boolean(manifest1.stages?.ingest), JSON.stringify(manifest1.stages?.ingest?.imported))

// 独立复核：导入到底成没成？（你自己的原则：不要只信返回值）
await new Promise(resolve => setTimeout(resolve, 1500))
const firstName = readdirSync(keepDir).sort()[0]
const found = await bridge.call('search_photos', { filename: firstName.replace(/\.[^.]+$/u, ''), limit: 5 })
const foundText = LightroomBridge.toText(found)
const idMatch = /"id"\s*:\s*(\d+)/.exec(JSON.stringify(found?.structuredContent ?? '')) ?? /"id"\s*:\s*(\d+)/.exec(foundText)
step('搜索得到照片（独立复核导入成功）', idMatch !== null,
  idMatch === null ? foundText.replace(/\s+/g, ' ').slice(0, 90) : `id=${idMatch[1]}`)
const photoId = idMatch === null ? null : idMatch[1]
const photoPath = path.join(keepDir, firstName)

/* ---------------------------------------------------------------- 4. 调色（单张先行） */

console.log('\n—— ④ 调色（单张先行，风格 A）——')
const before = photoId === null ? null
  : LightroomBridge.toText(await bridge.call('get_develop_settings', { photo_id: photoId, fields: 'basic' }))
const grade = await invoke('shejing_grade', { photo_ids: [photoPath], style: 'A', batch_id: BATCH_ID })
step('报告说渲染成功', /已写入并渲染 1 张/.test(grade), grade.split('\n').find(l => /渲染/.test(l))?.trim())
const previewPath = /→\s*(\/\S+\.jpg)/.exec(grade)?.[1]
step('给出了预览路径', typeof previewPath === 'string' && existsSync(previewPath), String(previewPath))

// 独立复核：参数真的写进去了吗？
if (photoId !== null) {
  const after = LightroomBridge.toText(await bridge.call('get_develop_settings', { photo_id: photoId, fields: 'basic' }))
  const contrast = /Contrast2012"?\s*[:=]\s*(-?\d+(?:\.\d+)?)/.exec(after)?.[1]
  step('读回 Contrast2012 = 14（风格 A）', Number(contrast) === 14, `读回 ${contrast ?? '未取到'}`)
  step('读回与调色前不同（确实变了）', before !== after)
  const manifest2 = JSON.parse(await readFile(path.join(batchDir, 'manifest.json'), 'utf8'))
  step('账本记下 grade.renders', manifest2.stages?.grade?.renders?.length >= 1,
    `${manifest2.stages?.grade?.renders?.length ?? 0} 条`)
}

/* ---------------------------------------------------------------- 5. 归档：真的导出 */

console.log('\n—— ⑤ 归档：真的导出 ——')
const picks = readdirSync(keepDir).sort()
const archive = await invoke('shejing_archive', { batch_id: BATCH_ID, picks, confirm: true })
step('导出调用完成', /实际文件数/.test(archive))
const manifest3 = JSON.parse(await readFile(path.join(batchDir, 'manifest.json'), 'utf8'))
const exportDir = manifest3.stages?.archive?.export_dir
step('导出目录存在', typeof exportDir === 'string' && existsSync(exportDir), String(exportDir))
step('导出张数与计划一致',
  manifest3.stages?.archive?.export_count === picks.length,
  `计划 ${picks.length}，实际 ${manifest3.stages?.archive?.export_count}`)
step('SUMMARY.md 已生成', existsSync(path.join(batchDir, 'SUMMARY.md')))

/* ---------------------------------------------------------------- 收尾 */

await bridge.close()

console.log('\n—— 清理（需要时手动执行）——')
if (photoId !== null) {
  console.log('  1. 从目录数据库移除本次导入的记录：')
  console.log(`     mcp__lightroom__remove_from_catalog { photo_ids: [...], confirm: true }`)
  console.log('     （先 search_photos 按文件名把本次导入的所有 id 查出来）')
}
console.log(`  2. 删掉克隆目录：rm -rf "${LIVE_DIR}"`)
console.log('  3. 你唯一的原片 Desktop/9.25 全程没有被碰过。')
console.log(`  4. 批次账本留在：${batchDir}`)

console.log()
assert.equal(failed, 0, `${failed} 项未通过`)
console.log('✅ 真机写入验证通过')
process.exit(0)
