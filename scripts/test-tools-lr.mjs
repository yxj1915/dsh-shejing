/**
 * 调色阶段的端到端测试（插件 + 假桥接）。
 *
 * 为什么需要它：调色是整份代码里最要紧、也是唯一**成功路径从未被执行过**的一段
 * （真实运行需要 Lightroom）。这个测试把插件与 tests/fake-lr-server.mjs 接起来，
 * 于是下面这些都能验证：
 *
 *   · 单张先行 → 真的下发 create_snapshot / set_develop_settings / set_tone_curve / 预览
 *   · gotcha #24 的曲线首点归零**真的到了线上**（而不只是函数返回值好看）
 *   · 单张渲染会记进账本，同时也记进「已验证参数」的渲染证据
 *   · 批量遇到新参数时，门禁钩子返回 ask；批准后进白名单，同一套参数不再拦
 *   · 批次账本里留下 stages.grade.renders，面板据此做前后对比
 *
 * 用法：node scripts/test-tools-lr.mjs
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const FAKE = path.join(ROOT, 'tests', 'fake-lr-server.mjs')

const dshHome = process.env.DSH_HOME
if (dshHome === undefined) {
  console.error('请设置 DSH_HOME（隔离实例的 home），否则会写到你真实的 ~/.dsh 里。')
  process.exit(2)
}

const LOG = path.join(dshHome, 'fake-lr-calls.jsonl')
const BATCH_ID = 'test-grade-batch'
const BATCH_DIR = path.join(dshHome, 'shejing', 'batches', BATCH_ID)
const PHOTO_DIR = path.join(dshHome, 'fake-photos')

// 清掉上一轮，保证从「无白名单、无账本」这个真实初态开始。
await rm(BATCH_DIR, { recursive: true, force: true })
await rm(path.join(dshHome, 'shejing', 'gates'), { recursive: true, force: true })
await rm(LOG, { force: true })
await mkdir(PHOTO_DIR, { recursive: true })
await mkdir(BATCH_DIR, { recursive: true })
// 可导入目录：归档阶段从这里出计划。
const KEEP_DIR = path.join(PHOTO_DIR, '可导入')
await mkdir(KEEP_DIR, { recursive: true })
const PHOTOS = ['DSC001.ARW', 'DSC002.ARW', 'DSC003.ARW'].map(n => path.join(KEEP_DIR, n))
for (const p of PHOTOS) await writeFile(p, 'not-a-real-raw')
await writeFile(path.join(BATCH_DIR, 'manifest.json'), `${JSON.stringify({
  batch_id: BATCH_ID, source_path: PHOTO_DIR, photo_count: 3, camera: [], updated: null,
  stages: { cull: { status: 'done', keep_dir: KEEP_DIR, kept: 3, rejected: 0 } },
}, null, 1)}\n`)

process.env.SHEJING_BRIDGE_ENTRY = FAKE
process.env.SHEJING_FAKE_LR_LOG = LOG
delete process.env.SHEJING_FAKE_LR_FAIL

/* ---------------------------------------------------------------- 假上下文 */

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
/**
 * 走一遍真实流程：先过门禁钩子；被拦下时，`approve: true` 表示「用户点了同意」，
 * 于是继续执行——**只有真的执行了，post-execute 才会把参数记进白名单**。
 */
async function invoke(name, args, { approve = false } = {}) {
  // 真实 DSH 里 pre-execute 与 post-execute 收到的是**同一个 exec 对象**——
  // 门禁靠它把「这次调用」串起来（seen 就是以它为键）。所以这里必须复用。
  const exec = { name, arguments: args }
  const pre = handlers.get('tools/pre-execute')?.[0]
  const decision = pre === undefined ? { kind: 'allow' } : await pre(exec, allow)
  if (decision.kind === 'ask' && !approve) return { decision, output: null }
  const output = await tools.get(name).execute(args, {})
  const post = handlers.get('tools/post-execute')?.[0]
  if (post !== undefined) await post(exec, { ok: true }, allow)
  return { decision, output }
}

function fakeCalls() {
  if (!existsSync(LOG)) return []
  return readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
}

let failed = 0
function check(label, fn) {
  try {
    fn()
    console.log(`  ✅ ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  ❌ ${label} → ${error && error.message ? error.message : error}`)
  }
}

console.log('阶段工具（插件 + 假桥接）测试\n')

/* ---------------------------------------------------------------- 1. 单张先行 */

console.log('—— 单张先行 ——')
const single = await invoke('shejing_grade', {
  photo_ids: [PHOTOS[0]], style: 'A', batch_id: BATCH_ID,
})
check('单张调用不被门禁拦（那正是「先行」本身）', () => assert.equal(single.decision.kind, 'allow'))
check('报告里说渲染成功 1 张', () => {
  assert.match(single.output, /已写入并渲染 1 张/)
  assert.ok(!/一张都没有渲染成功/.test(single.output), '不该报失败')
})
check('给出了可 read_image 的预览路径', () => assert.match(single.output, /read_image/))

const calls = fakeCalls()
check('真的下发了 建快照 → 滑杆 → 曲线 → 预览', () => {
  const names = calls.map(c => c.tool)
  for (const expected of ['create_snapshot', 'set_develop_settings', 'set_tone_curve', 'get_photo_preview']) {
    assert.ok(names.includes(expected), `没有下发 ${expected}，实际：${names.join(', ')}`)
  }
})

check('风格 A 的滑杆值确实到了线上', () => {
  const settings = calls.find(c => c.tool === 'set_develop_settings')
  assert.equal(settings.args.settings.Contrast2012, 14)
  assert.equal(settings.args.settings.PostCropVignetteAmount, -12, '暗角也应当一起下发')
})

check('gotcha #24：曲线首点归零确实到了线上（不只是返回值好看）', () => {
  const curves = calls.filter(c => c.tool === 'set_tone_curve')
  assert.ok(curves.length >= 1, '应当有曲线调用')
  for (const call of curves) {
    const first = call.args.points[0]
    assert.ok(first[0] !== 0 || first[1] === 0,
      `曲线 ${call.args.channel} 首点是 ${JSON.stringify(first)} —— 首点 x=0 且 y≠0 会触发重复端点陷阱`)
  }
})

const manifest1 = JSON.parse(await readFile(path.join(BATCH_DIR, 'manifest.json'), 'utf8'))
check('账本记下了 stages.grade.renders（面板据此做前后对比）', () => {
  assert.ok(manifest1.stages.grade, '应当有 grade 段')
  assert.equal(manifest1.stages.grade.renders.length, 1)
  assert.equal(manifest1.stages.grade.style, 'A')
  assert.ok(manifest1.stages.grade.fingerprint, '应当记下参数指纹')
})

const gates1 = JSON.parse(await readFile(path.join(dshHome, 'shejing', 'gates', 'approved-params.json'), 'utf8'))
check('单张渲染会记进「已验证参数」的渲染证据', () => {
  assert.equal(Object.keys(gates1.rendered).length, 1)
})

/* ---------------------------------------------------------------- 2. 批量与门禁 */

console.log('\n—— 批量与门禁 ——')
const fingerprint1 = manifest1.stages.grade.fingerprint

const batch = await invoke('shejing_grade', {
  photo_ids: PHOTOS, style: 'A', batch_id: BATCH_ID,
})
check('批量遇到未验证的参数组合 → 门禁返回 ask', () => assert.equal(batch.decision.kind, 'ask'))
check('门禁理由里带上了单张渲染的证据路径', () => {
  assert.match(batch.decision.reason, /单张渲染记录/, `理由应当引用渲染证据：${batch.decision.reason}`)
})
check('闸门拦住后没有真的执行', () => assert.equal(batch.output, null))

// 用户点了同意 → 真的执行 → post-execute 记账 → 进白名单。
const approved = await invoke('shejing_grade', {
  photo_ids: PHOTOS, style: 'A', batch_id: BATCH_ID,
}, { approve: true })
check('批准后批量确实渲染了 3 张', () => assert.match(approved.output, /已写入并渲染 3 张/))

const batchAgain = await invoke('shejing_grade', {
  photo_ids: PHOTOS, style: 'A', batch_id: BATCH_ID,
})
check('同一套参数第二次不再拦（已入白名单）', () => assert.equal(batchAgain.decision.kind, 'allow'))

const gates2 = JSON.parse(await readFile(path.join(dshHome, 'shejing', 'gates', 'approved-params.json'), 'utf8'))
check('白名单里确实多了这一套参数', () => assert.equal(Object.keys(gates2.approved).length, 1))

const differentStyle = await invoke('shejing_grade', {
  photo_ids: PHOTOS, style: 'C', batch_id: BATCH_ID,
})
check('换一套参数（风格 C）仍然会被拦', () => assert.equal(differentStyle.decision.kind, 'ask'))
check('指纹不同才拦得住（白名单是参数级的，不是「用过一次就放行」）', () => {
  assert.notEqual(differentStyle.decision.reason, batch.decision.reason)
  void fingerprint1
})

const files = readdirSync(BATCH_DIR)
check('批次目录里留下了账本与计划', () => assert.ok(files.includes('manifest.json')))

/* ---------------------------------------------------------------- 3. 归档 */

console.log('\n—— 风格 B：曲线首点归零（gotcha #24，整个插件存在的理由）——')
/*
 * 为什么单列一段：风格 B 的每个通道曲线首点都是 (0, y≠0)，而那正是 25 张照片
 * 被染成紫红色的那个条件。审计员做过变异——把 styles.mjs 里的归零保护删掉，
 * 整套测试**依然全绿**：因为其他用例只跑风格 A/C，而它们的首点本来就在 0 上，
 * `first[0] !== 0 || first[1] === 0` 于是恒真，什么都没验到。
 *
 * 所以这里必须**真的用风格 B 跑一次**，并逐通道核对下发到线上的点。
 */
{
  await rm(LOG, { force: true })
  const styleB = path.join(dshHome, 'fake-photos', '可导入', 'DSC001.ARW')
  const { output } = await invoke('shejing_grade', { photo_ids: [styleB], style: 'B' })
  const calls = readFileSync(LOG, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  const curves = calls.filter(c => c.tool === 'set_tone_curve')
  check('风格 B 会把三条通道曲线都下发', () => {
    assert.ok(curves.length >= 3, `应当至少下发 3 条曲线，实际 ${curves.length}`)
  })
  check('每条曲线的首点都被归零成 (0,0)——这正是紫色事故的防线', () => {
    for (const c of curves) {
      const first = (c.args.points ?? [])[0]
      assert.ok(Array.isArray(first) && first[0] === 0 && first[1] === 0,
        `${c.args.channel} 的首点是 ${JSON.stringify(first)}，应当是 [0,0]`)
    }
  })
  check('报告里如实说明了参数被修正', () => {
    assert.match(String(output), /参数修正/, '风格 B 应当触发修正说明')
  })
}

console.log('\n—— 归档（真实导出，经假桥接）——')

const plan = await invoke('shejing_archive', {
  batch_id: BATCH_ID, picks: ['DSC001.ARW', 'DSC003.ARW'],
})
check('不带 confirm 只出计划，不导出', () => {
  assert.equal(plan.decision.kind, 'allow', '出计划不该被门禁拦')
  assert.ok(plan.output.includes('plan') || plan.output.includes('计划') || plan.output.includes('等你'),
    `应当只给计划与建议：${plan.output.slice(0, 200)}`)
  assert.ok(existsSync(path.join(BATCH_DIR, 'export-plan.json')), '应当写出精选计划')
  const p = JSON.parse(readFileSync(path.join(BATCH_DIR, 'export-plan.json'), 'utf8'))
  assert.deepEqual(p.picked, ['DSC001.ARW', 'DSC003.ARW'], '计划里的名单应当与点名一致')
})
check('没有导出目录产生', () => {
  const dirs = readdirSync(BATCH_DIR).filter(name => name.startsWith('精选_'))
  assert.equal(dirs.length, 0, `不该有导出目录，实际：${dirs.join(', ')}`)
})

const exportCall = await invoke('shejing_archive', {
  batch_id: BATCH_ID, picks: ['DSC001.ARW', 'DSC003.ARW'], confirm: true,
})
check('带 confirm → 门禁先问用户', () => assert.equal(exportCall.decision.kind, 'ask'))
check('门禁理由里说清了将导出多少张', () => {
  assert.match(exportCall.decision.reason, /精选|导出/, `理由应当说明导出意图：${exportCall.decision.reason}`)
})

const exported = await invoke('shejing_archive', {
  batch_id: BATCH_ID, picks: ['DSC001.ARW', 'DSC003.ARW'], confirm: true,
}, { approve: true })
check('批准后真的调了 export_photos', () => {
  const call = fakeCalls().find(c => c.tool === 'export_photos')
  assert.ok(call, '应当调用 export_photos')
  assert.equal(call.args.photo_ids.length, 2, '应当传 2 张的绝对路径')
  assert.ok(call.args.destination, '应当给目标目录')
  assert.equal(call.args.quality, 100, '默认 JPEG 质量 100')
  assert.equal(call.args.format, 'jpeg')
})
check('导出结果被核对（实际生成的文件数）', () => assert.match(exported.output, /实际文件数/))

const manifest3 = JSON.parse(await readFile(path.join(BATCH_DIR, 'manifest.json'), 'utf8'))
check('账本记下了 archive 段', () => {
  assert.ok(manifest3.stages.archive, '应当有 archive 段')
  assert.equal(manifest3.stages.archive.export_count, 2)
  assert.deepEqual(manifest3.stages.archive.selected, ['DSC001.ARW', 'DSC003.ARW'])
  assert.ok(existsSync(manifest3.stages.archive.export_dir), '导出目录应当真的存在')
  const written = readdirSync(manifest3.stages.archive.export_dir)
  assert.equal(written.length, 2, `导出目录里应当有 2 个文件，实际 ${written.join(', ')}`)
})
check('顺带生成了批次总结 SUMMARY.md', () => {
  assert.ok(existsSync(path.join(BATCH_DIR, 'SUMMARY.md')), 'SUMMARY.md 应当存在')
  const summary = readFileSync(path.join(BATCH_DIR, 'SUMMARY.md'), 'utf8')
  assert.match(summary, /摄鲸批次总结/, '应当是批次总结')
  assert.match(summary, /归档/, '应当有归档那一节')
})

/* ---------------------------------------------------------------- 4. 协议层失败 */

console.log('\n—— 协议层失败要显式抛错 ——')
// 假桥接对未知工具返回 isError:true。LR 工具包装必须把它抛出去，
// 否则它只是一段普通文本，模型很可能当成正常结果读过去。
let isErrorThrown = null
try {
  await tools.get('mcp__lightroom__list_watermarks').execute({}, {})
} catch (error) {
  isErrorThrown = String(error?.message ?? error)
}
check('isError 的结果会被当成失败抛出', () => {
  assert.ok(isErrorThrown !== null, '应当抛错')
  assert.match(isErrorThrown, /list_watermarks/, '错误里应当带上工具名')
})
check('载荷里的 success:false 不抛（那可能是假失败）', async () => {
  const result = await tools.get('mcp__lightroom__apply_auto').execute({ photo_ids: ['x'] }, {})
  assert.match(result, /success/, '应当把 payload 原样透出来让模型判断')
})

console.log()
if (failed > 0) {
  console.error(`❌ ${failed} 个用例失败`)
}
// 必须显式退出：假桥接是个子进程，MCP 客户端会一直握着它，
// 事件循环不会自己空掉（真机上由 DSH 的 effect 负责关闭）。
console.log(failed === 0 ? '✅ 阶段工具测试通过' : '')
process.exit(failed === 0 ? 0 : 1)
