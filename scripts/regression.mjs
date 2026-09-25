/**
 * 端到端回归：对一份**克隆出来的真实批次**跑完整流程。
 *
 * 与 smoke.mjs 的分工：
 *   smoke.mjs      查「插件装对没有」——工具注册面、门禁判定、技能解析、路由。
 *   regression.mjs 查「流程跑得对不对」——用真实的 75 张 ARW 走一遍体检与剔除，
 *                  断言账本、contact sheet、分组数、文件移动结果。
 *
 * 它调用的是**真实工具实现**（注册进假上下文后直接调 execute），不是绕过插件
 * 另跑 Python，所以被覆盖的包括参数翻译、路径解析、账本写入这些编排逻辑。
 *
 * 不碰 Lightroom：导入/调色/渲染预览需要 Lightroom 本体在跑，会明确跳过并说明。
 *
 * 用法：node scripts/regression.mjs <克隆出来的批次目录> [--batch-id <id>]
 */

import assert from 'node:assert/strict'
import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { rm } from 'node:fs/promises'

const source = process.argv[2]
if (source === undefined || !existsSync(source)) {
  console.error('用法：node scripts/regression.mjs <批次目录> [--batch-id <id>]')
  process.exit(2)
}
const batchIdFlag = process.argv.indexOf('--batch-id')
const batchId = batchIdFlag === -1 ? undefined : process.argv[batchIdFlag + 1]
/** 复用已有账本，跳过体检（体检要十几分钟，改下游逻辑时不必每次重跑）。 */
const reuse = process.argv.includes('--reuse')

const dshHome = process.env.DSH_HOME
if (dshHome === undefined) {
  console.error('请设置 DSH_HOME（隔离实例的 home），否则会写到你真实的 ~/.dsh 里。')
  process.exit(2)
}

const t0 = Date.now()
const step = (label) => console.log(`\n━━━ ${label}  (+${((Date.now() - t0) / 1000).toFixed(1)}s)`)

/* ---------------------------------------------------------------- 假上下文 */

const tools = new Map()
const handlers = new Map()
const logs = []

const ctx = {
  logger: { info: (m) => { logs.push(m); console.log('   [log]', m) }, warn: (m) => logs.push(`WARN ${m}`) },
  tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
  skills: { registerProvider() { return () => {} } },
  systemPrompt: { section() { return () => {} } },
  effect(fn) { const d = fn(); return () => { d?.() } },
  on(event, handler) {
    if (!handlers.has(event)) handlers.set(event, [])
    handlers.get(event).push(handler)
    return () => {}
  },
  connection: { fetch: { register(route) { return () => {} } } },
  inject(names, callback) {
    if (names.includes('systemPrompt') || names.includes('connection')) callback(ctx)
  },
}

// 门禁白名单清掉，保证从「全新参数」这个真实初态开始。
await rm(path.join(dshHome, 'shejing', 'gates', 'approved-params.json'), { force: true })

const mod = await import('../src/index.mjs')
mod.apply(ctx, {})
await new Promise(resolve => setTimeout(resolve, 600))

const call = async (name, args) => {
  const tool = tools.get(name)
  assert.ok(tool, `工具未注册：${name}`)
  return await tool.execute(args, { signal: undefined })
}

/* ---------------------------------------------------------------- 1. 体检 */

step('① 体检（shejing_checkup）')
const batchDir = path.join(dshHome, 'shejing', 'batches',
  batchId ?? readdirSync(path.join(dshHome, 'shejing', 'batches'))[0])
const manifestPath = path.join(batchDir, 'manifest.json')

if (reuse) {
  console.log(`   跳过（--reuse）：复用 ${manifestPath}`)
} else {
  const checkupOut = await call('shejing_checkup', { source, ...(batchId === undefined ? {} : { batch_id: batchId }) })
  console.log(checkupOut.split('\n').slice(0, 6).join('\n'))
}

assert.ok(existsSync(manifestPath), '账本没写出来')

const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(manifestPath, 'utf8'))
const checkup = manifest.stages.checkup
assert.equal(checkup.status, 'done')
assert.equal(manifest.photo_count, 75, '应当数到 75 张')
assert.ok(Array.isArray(checkup.groups), 'groups 应当是数组')
assert.ok(existsSync(checkup.contact_sheet), 'contact sheet 没生成')
assert.equal(Object.keys(checkup.frames ?? {}).length, 75, '每张都应当有缩略图记录')

const withEv = Object.values(checkup.frames).filter(f => f.ev !== null).length
console.log(`   机身：${(manifest.camera || []).join('、') || '(未读到)'}`)
console.log(`   分组：${checkup.groups.length} 组；有曝光数据的帧：${withEv}/75`)
const kinds = {}
for (const g of checkup.groups) kinds[g.kind] = (kinds[g.kind] ?? 0) + 1
console.log(`   类型分布：${JSON.stringify(kinds)}`)
const spans = checkup.groups.map(g => g.ev_spread).filter(v => v !== null)
if (spans.length > 0) {
  console.log(`   组内曝光跨度：${spans.map(v => v.toFixed(2)).join(', ')} 档（最大 ${Math.max(...spans).toFixed(2)}）`)
}
assert.ok(withEv > 0, '⚠️ 一张都没读到曝光数据——EXIF 解析可能坏了（这正是 Spotlight 依赖被修掉的那件事）')

/* ---------------------------------------------------------------- 2. 剔除预演 */

step('② 剔除预演（shejing_cull 不带 confirm）')
// 分组必须是**划分**：一帧最多属于一组。否则待剔名单会出现重复项，
// 「传了 N 个名字只剔掉 N-1 张」这种错误就会静默发生。
const frameOwner = new Map()
for (const [index, group] of checkup.groups.entries()) {
  for (const frame of group.frames) {
    assert.ok(!frameOwner.has(frame.name),
      `${frame.name} 同时属于第 ${frameOwner.get(frame.name)} 组和第 ${index} 组——分组不是划分`)
    frameOwner.set(frame.name, index)
  }
}
console.log(`   分组是划分：${frameOwner.size} 帧分属 ${checkup.groups.length} 组，无重叠 ✓`)

const rejectSet = new Set()
for (const group of checkup.groups) {
  // 只有「连拍」才进剔除建议；包围曝光与疑似堆栈一律不碰。
  if (group.kind !== '连拍') continue
  for (const frame of group.frames) {
    if (frame.name !== group.keep) rejectSet.add(frame.name)
  }
}
const reject = [...rejectSet]
console.log(`   建议剔除 ${reject.length} 张（只取连拍组里的非保留帧）`)

const keepDir = path.join(source, '可导入')
const rejectDir = path.join(source, '非导入')
await call('shejing_cull', { source, reject, ...(batchId === undefined ? {} : { batch_id: batchId }) })
assert.ok(!existsSync(keepDir), '预演不该创建 可导入/')
assert.ok(!existsSync(rejectDir), '预演不该创建 非导入/')
assert.equal(readdirSync(source).filter(f => f.endsWith('.ARW')).length, 75, '预演后源目录应当仍是 75 张')
console.log('   预演确认：没建目录、没动文件 ✓')

/* ---------------------------------------------------------------- 3. 真剔除 */

step('③ 真剔除（shejing_cull 带 confirm）')
await call('shejing_cull', { source, reject, confirm: true, ...(batchId === undefined ? {} : { batch_id: batchId }) })
const inKeep = readdirSync(keepDir).length
const inReject = readdirSync(rejectDir).length
console.log(`   可导入/ ${inKeep} 张 · 非导入/ ${inReject} 张`)
assert.equal(inKeep + inReject, 75, '移动后总数应当守恒于 75')
assert.equal(inReject, reject.length, '被剔的张数应当与名单一致')
assert.equal(readdirSync(source).filter(f => f.endsWith('.ARW')).length, 0, '源目录里不该再留下未分类的 ARW')

const after = JSON.parse(await (await import('node:fs/promises')).readFile(manifestPath, 'utf8'))
assert.equal(after.stages.cull.status, 'done', '剔除阶段应当记账')
assert.equal(after.stages.cull.kept, inKeep)
console.log('   账本已记账，文件数守恒 ✓')

/* ---------------------------------------------------------------- 4. 验收（目录库部分） */

step('④ 验收（shejing_verify，目录数据库部分）')
const verifyOut = await call('shejing_verify', { source, ...(batchId === undefined ? {} : { batch_id: batchId }) })
const verifyHead = verifyOut.split('\n').filter(line => line.includes('目录库') || line.includes('可导入目录') || line.includes('尚未导入'))
console.log(verifyHead.slice(0, 4).map(l => `   ${l.trim()}`).join('\n'))
assert.ok(verifyOut.includes('目录库'), '目录数据库核对没跑起来')
console.log('   ⓘ 渲染预览与调色读回需要 Lightroom 在跑——本次跳过。')

/* ---------------------------------------------------------------- 汇总 */

const after2 = JSON.parse(await (await import('node:fs/promises')).readFile(manifestPath, 'utf8'))
step('汇总')
console.log(`   批次目录：${batchDir}`)
console.log(`   账本阶段：${Object.keys(after2.stages).join(' → ')}`)
console.log(`   contact sheet：${(statSync(checkup.contact_sheet).size / 1024).toFixed(0)} KB`)
console.log(`   可导入：${inKeep} 张 · 非导入：${inReject} 张`)
console.log(`   总耗时：${((Date.now() - t0) / 1000).toFixed(1)}s`)
console.log('\n✅ 端到端回归通过（不依赖 Lightroom 的部分）')
