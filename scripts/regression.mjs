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
import { readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'

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

/* ---------------------------------------------------------------- 5. 归档计划 */

step('⑤ 归档计划（shejing_archive 不带 confirm）')
// 先把可导入目录里挑两张，模拟用户点名导出。
const keepFiles = readdirSync(keepDir).filter(f => f.toUpperCase().endsWith('.ARW')).sort()
assert.ok(keepFiles.length >= 2, '可导入目录里应当有照片')
const picks = keepFiles.slice(0, 2)
const planOut = await call('shejing_archive', {
  source, picks, ...(batchId === undefined ? {} : { batch_id: batchId }),
})
const planFile = path.join(batchDir, 'export-plan.json')
assert.ok(existsSync(planFile), '精选计划没写出来')
const plan = JSON.parse(await readFile(planFile, 'utf8'))
assert.deepEqual(plan.picked, picks, '计划里的名单应当与点名的一致')
assert.equal(plan.catalog !== null, true, '应当定位到目录数据库')
console.log(`   计划：${plan.picked.length} 张；目录库 ${plan.catalog ? '已定位' : '未找到'}`)
console.log(`   计划文件内容与点名一致 ✓（导出本身需要 Lightroom，未执行）`)
void planOut

/* ---------------------------------------------------------------- 6. 整理（只重命名） */

step('⑥ 整理 · 只重命名（shejing_organize，不需要 Lightroom）')
// 先故意改成不符合模板的名字，才有东西可测（否则是 no-op，等于没测）。
// 注意模板是 `{date}_{name}`，而 `{date}` 来自**文件内嵌 EXIF**、`{name}` 只剥掉
// 已有的日期前缀。所以 `zz-xxxx-0.ARW` 会被改成 `2026-09-02_zz-xxxx-0.ARW`
// ——不是改回原名。这正是预期行为（日期以 EXIF 为准，不信任文件名）。
//
// 乱名必须**每轮唯一**：脚本会检测目标名冲突并跳过，如果用固定名字，第二次跑
// 就会因为「目标已存在」而计划为空——那时断言 dry-run 字样会失败，而真正的原因
// 只是克隆没还原。
const token = `zz${Date.now().toString(36)}`
const toRename = keepFiles.slice(0, 2)
const scrambled = toRename.map((_, index) => `${token}-${index}.ARW`)
for (const [index, name] of toRename.entries()) {
  await rename(path.join(keepDir, name), path.join(keepDir, scrambled[index]))
}
console.log(`   先改成：${scrambled.join(', ')}`)

const dry = await call('shejing_organize', {
  source, rename: true, ...(batchId === undefined ? {} : { batch_id: batchId }),
})
assert.ok(dry.includes(token), '预演输出里应当列出待改名的乱名文件')
assert.ok(dry.includes('dry-run'), '预演应当明确标注 dry-run')
assert.ok(scrambled.every(name => existsSync(path.join(keepDir, name))), '预演不该改名')
console.log('   预演：文件名未变 ✓')

await call('shejing_organize', {
  source, rename: true, rename_confirm: true, ...(batchId === undefined ? {} : { batch_id: batchId }),
})
for (const name of scrambled) {
  const base = name.replace(/\.ARW$/i, '')
  const hit = readdirSync(keepDir).filter(f => f.endsWith(`_${base}.ARW`))
  assert.equal(hit.length, 1, `应当出现一个带 EXIF 日期前缀的 ${base}.ARW，实际 ${JSON.stringify(hit)}`)
  assert.ok(!existsSync(path.join(keepDir, name)), `${name} 应当已不存在`)
  console.log(`   ${name} → ${hit[0]} ✓（日期取自 EXIF）`)
}

/* ---------------------------------------------------------------- 7. 复盘 */

step('⑦ 复盘（shejing_retro，不需要 Lightroom）')
const rulesFile = path.join(dshHome, 'shejing', 'shooting-rules.md')
const beforeRules = existsSync(rulesFile) ? (await readFile(rulesFile, 'utf8')).length : 0

const retroDry = await call('shejing_retro', {
  title: '回归测试规则', body: '这条是端到端回归写的。', ...(batchId === undefined ? {} : { batch_id: batchId }),
})
assert.ok(retroDry.includes('等你'), '不带 confirm 应当只给建议、不写入')
const afterDry = existsSync(rulesFile) ? (await readFile(rulesFile, 'utf8')).length : 0
assert.equal(afterDry, beforeRules, '预演不该写规则文件')
console.log('   预演：规则文件未变 ✓')

await call('shejing_retro', {
  title: '回归测试规则', body: '这条是端到端回归写的。', evidence: '自动化测试',
  confirm: true, ...(batchId === undefined ? {} : { batch_id: batchId }),
})
const afterRules = await readFile(rulesFile, 'utf8')
assert.ok(afterRules.length > beforeRules, '规则文件应当变长')
assert.ok(afterRules.includes('回归测试规则'), '规则标题应当写进去')
const retroManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
assert.ok(Array.isArray(retroManifest.shooting_lessons) && retroManifest.shooting_lessons.length > 0,
  '账本应当记下 shooting_lessons')
assert.ok(retroManifest.stages.retro, '账本应当记下复盘阶段')
console.log(`   真写入：规则文件 ${beforeRules} → ${afterRules.length} 字符，账本已记账 ✓`)

/* ---------------------------------------------------------------- 8. 降级 */

step('⑧ 降级：Lightroom 不可用时的行为')
// 这台机器上 Lightroom 没开。工具**刻意不抛异常**（逐张 try/catch，把失败记进报告），
// 所以这里断言的是「报告得清楚」，而不是「抛错」。
const gradeOut = await call('shejing_grade', {
  photo_ids: [path.join(keepDir, picks[0])], style: 'A',
  ...(batchId === undefined ? {} : { batch_id: batchId }),
})
assert.ok(/Lightroom|桥接|bridge/i.test(gradeOut), '报告里应当说清是 Lightroom 链路问题')
assert.ok(/失败 1 张|一张都没有渲染成功/.test(gradeOut), '报告里应当明说没有渲染成功')
// 关键：没有图可看时**不能**建议用户去看图——那会诱导模型描述一个不存在的结果。
assert.ok(!/请把渲染图交给用户看/.test(gradeOut), '没有渲染成功时不该建议用户看渲染图')
console.log(`   失败说清楚了：${(gradeOut.match(/⚠️ 失败：[\s\S]*/) ?? [''])[0].split('\n')[1]?.trim().slice(0, 100)}…`)
console.log('   没有图可看时不会诱导模型描述渲染结果 ✓')

/* ---------------------------------------------------------------- 汇总 */

const after2 = JSON.parse(await (await import('node:fs/promises')).readFile(manifestPath, 'utf8'))
step('汇总')
console.log(`   批次目录：${batchDir}`)
console.log(`   账本阶段：${Object.keys(after2.stages).join(' → ')}`)
console.log(`   contact sheet：${(statSync(checkup.contact_sheet).size / 1024).toFixed(0)} KB`)
console.log(`   可导入：${inKeep} 张 · 非导入：${inReject} 张`)
console.log(`   总耗时：${((Date.now() - t0) / 1000).toFixed(1)}s`)
console.log('\n✅ 端到端回归通过（不依赖 Lightroom 的部分）')
