/**
 * 开发用冒烟测试：用一个假的 Cordis 上下文加载插件，检查注册面与关键路径。
 * 不连 Lightroom、不改 profile、不写 ~/.dsh 之外的东西（.lrplugin 同步除外，
 * 可用 --no-sync 跳过）。
 *
 * 用法：node scripts/smoke.mjs [--no-sync]
 */

import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import path from 'node:path'

const noSync = process.argv.includes('--no-sync')
/** 模拟桌面 composition 里某些服务不存在的场景：插件必须照常激活，只是少注册路由。 */
const noConnection = process.argv.includes('--no-connection')

// 门禁白名单会落盘，清掉它才能每次都从「新参数」这个真实初态开始测。
const dshHome = process.env.DSH_HOME ?? path.join(process.env.HOME ?? '', '.dsh')
await rm(path.join(dshHome, 'shejing', 'gates', 'approved-params.json'), { force: true })

const tools = new Map()
const skillProviders = []
const sections = []
const effects = []
const logs = []

const ctx = {
  logger: { info: (m) => logs.push(m), warn: (m) => logs.push(`WARN ${m}`) },
  tools: {
    register(definition) {
      if (tools.has(definition.name)) throw new Error(`duplicate tool: ${definition.name}`)
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
  },
  skills: {
    registerProvider(create) {
      skillProviders.push(create())
      return () => {}
    },
  },
  systemPrompt: {
    section(section) { sections.push(section); return () => {} },
  },
  effect(fn) { const d = fn(); effects.push(d); return () => { d?.() } },
  handlers: new Map(),
  on(event, handler) {
    if (!ctx.handlers.has(event)) ctx.handlers.set(event, [])
    ctx.handlers.get(event).push(handler)
    return () => {}
  },
  inject(names, callback) {
    if (names.includes('systemPrompt')) callback(ctx)
    // --no-connection 时**不**回调：模拟桌面 composition 里没有 connection 服务。
    // 插件用了可选注入，所以必须照常激活，只是面板路由不注册。
    if (names.includes('connection') && !noConnection) callback(ctx)
  },
  connection: {
    fetchRoutes: new Map(),
    fetch: {
      register(route) {
        ctx.connection.fetchRoutes.set(route.path, route)
        return () => ctx.connection.fetchRoutes.delete(route.path)
      },
    },
  },
}

const mod = await import('../src/index.mjs')
console.log('plugin name :', mod.name)
console.log('inject      :', mod.inject.join(', '))

mod.apply(ctx, {})
await new Promise(resolve => setTimeout(resolve, noSync ? 0 : 800))

// --- 工具面 ---
const lrTools = [...tools.keys()].filter(n => n.startsWith('mcp__lightroom__'))
const stageTools = [...tools.keys()].filter(n => n.startsWith('shejing_'))
console.log(`registered  : ${tools.size} tools = ${lrTools.length} LR + ${stageTools.length} shejing`)
console.log('shejing tools:', stageTools.join(', '))
assert.equal(lrTools.length, 56, '应当注册 56 个 LR 工具')
assert.ok(tools.has('mcp__lightroom__get_photo_preview'))
assert.ok(tools.has('shejing_checkup'))
assert.ok(tools.has('shejing_doctor'))
assert.ok(tools.has('shejing_batch_status'))

// 每个 LR 工具都要有 parameters 与 output.render
for (const [name, def] of tools) {
  assert.ok(def.parameters && def.parameters.type === 'object', `${name} 缺 parameters`)
  assert.equal(typeof def.output?.render, 'function', `${name} 缺 output.render`)
  assert.equal(typeof def.execute, 'function', `${name} 缺 execute`)
}

// --- 技能 ---
assert.equal(skillProviders.length, 1, '应当注册一个技能 provider')
const provider = skillProviders[0]
const list = await provider.list()
const skill = await provider.get(list[0])
console.log(`skill       : ${skill.name} (rank ${list[0].rank}), body ${skill.content.length} 字符`)
assert.equal(skill.name, 'shejing')
assert.ok(skill.content.length > 1000, 'skill 正文不应为空')
assert.ok(!skill.content.startsWith('---'), '正文不应残留前置元数据')
assert.ok(!skill.description.includes('\n'), 'description 不应含换行')
console.log('description :', skill.description.slice(0, 46), '…')
console.log('whenToUse   :', String(skill.whenToUse ?? '').slice(0, 46), '…')

// --- 系统提示词段 ---
assert.equal(sections.length, 1)

// --- 门禁（整个插件最该被测试的部分） ---
const pre = ctx.handlers.get('tools/pre-execute') ?? []
assert.ok(pre.length > 0, '门禁应当注册 tools/pre-execute 钩子')
const gate = pre[0]
const post = ctx.handlers.get('tools/post-execute') ?? []
assert.ok(post.length > 0, '门禁应当注册 tools/post-execute 钩子用于记账')
const allow = async () => ({ kind: 'allow' })

const batchCall = {
  name: 'mcp__lightroom__set_develop_settings',
  arguments: { photo_ids: ['a', 'b', 'c'], settings: { Exposure2012: 0.5 } },
}
const asked = await gate(batchCall, allow)
console.log('门禁·批量新参数      →', asked.kind)
assert.equal(asked.kind, 'ask', '批量的新参数组合必须被拦下问用户')

const singleCall = {
  name: 'mcp__lightroom__set_develop_settings',
  arguments: { photo_id: 'a', settings: { Exposure2012: 0.5 } },
}
console.log('门禁·单张            →', (await gate(singleCall, allow)).kind)
assert.equal((await gate(singleCall, allow)).kind, 'allow', '单张调用不该被拦（那正是「先行」本身）')

const readOnly = { name: 'mcp__lightroom__search_photos', arguments: { limit: 50 } }
assert.equal((await gate(readOnly, allow)).kind, 'allow', '只读工具不该被拦')

const marking = { name: 'mcp__lightroom__set_rating', arguments: { photo_ids: ['a', 'b'], rating: 5 } }
assert.equal((await gate(marking, allow)).kind, 'allow', '星级属于标记门禁，不是参数门禁')

const cullConfirm = { name: 'shejing_cull', arguments: { reject: ['x.ARW', 'y.ARW'], confirm: true } }
console.log('门禁·剔除(confirm)   →', (await gate(cullConfirm, allow)).kind)
assert.equal((await gate(cullConfirm, allow)).kind, 'ask', '真移动文件必须让用户看到完整名单再点头')

const cullDry = { name: 'shejing_cull', arguments: { reject: ['x.ARW'] } }
assert.equal((await gate(cullDry, allow)).kind, 'allow', '剔除预演不该被拦（那一趟本来就是给用户看的）')

// shejing_grade 内部直接调桥接、不走 DSH 工具，所以钩子必须专门认它，
// 否则它就是 Q29 要堵的那条旁路。
const gradeBatch = { name: 'shejing_grade', arguments: { photo_ids: ['a', 'b', 'c'], style: 'A' } }
const gradeAsked = await gate(gradeBatch, allow)
console.log('门禁·调色批量        →', gradeAsked.kind)
assert.equal(gradeAsked.kind, 'ask', '批量调色必须被拦下')
assert.ok(String(gradeAsked.reason).includes('没有'), '理由里应当说明缺少单张渲染记录')

const gradeSingle = { name: 'shejing_grade', arguments: { photo_ids: ['a'], style: 'A' } }
console.log('门禁·调色单张        →', (await gate(gradeSingle, allow)).kind)
assert.equal((await gate(gradeSingle, allow)).kind, 'allow', '单张调色不该被拦（那正是「先行」本身）')

const gradeUnknownStyle = { name: 'shejing_grade', arguments: { photo_ids: ['a', 'b'], style: 'X' } }
let threw = false
try { await gate(gradeUnknownStyle, allow) } catch { threw = true }
assert.ok(threw, '未知风格应当在门禁阶段就报错，而不是等到写了一半')

// 不可逆门禁 / 导出确认 / 复盘写入
const renameConfirm = { name: 'shejing_organize', arguments: { rename: true, rename_confirm: true } }
console.log('门禁·重命名(confirm) →', (await gate(renameConfirm, allow)).kind)
assert.equal((await gate(renameConfirm, allow)).kind, 'ask', '改文件名不可逆，必须问用户')
assert.equal((await gate({ name: 'shejing_organize', arguments: { rename: true } }, allow)).kind, 'allow',
  '重命名预演不该被拦')

console.log('门禁·导出(confirm)   →', (await gate({ name: 'shejing_archive', arguments: { confirm: true, picks: ['a'] } }, allow)).kind)
assert.equal((await gate({ name: 'shejing_archive', arguments: { confirm: true, picks: ['a'] } }, allow)).kind, 'ask',
  '导出前必须让用户确认清单')
assert.equal((await gate({ name: 'shejing_archive', arguments: {} }, allow)).kind, 'allow', '出计划不该被拦')

console.log('门禁·复盘(confirm)   →', (await gate({ name: 'shejing_retro', arguments: { title: 't', body: 'b', confirm: true } }, allow)).kind)
assert.equal((await gate({ name: 'shejing_retro', arguments: { title: 't', body: 'b', confirm: true } }, allow)).kind, 'ask',
  '往规则文件里写东西必须问用户')

// 用户同意 → post-execute 记账 → 同一套参数第二次不再拦（白名单）
await post[0](batchCall, { ok: true }, allow)
const again = await gate(batchCall, allow)
console.log('门禁·同参数第二次    →', again.kind)
assert.equal(again.kind, 'allow', '已入白名单的参数不该再拦')

// --- 面板路由 ---
if (noConnection) {
  assert.equal(ctx.connection.fetchRoutes.size, 0, '没有 connection 服务时不该注册任何路由')
  console.log('面板路由     : 跳过（模拟无 connection 服务，插件仍正常激活）')
} else {
  for (const expected of ['/api/shejing/probe', '/api/shejing/batches', '/api/shejing/batch']) {
    assert.ok(ctx.connection.fetchRoutes.has(expected), `应当注册路由 ${expected}`)
  }
  const route = ctx.connection.fetchRoutes.get('/api/shejing/probe')
  assert.ok(route, '探针路由路径应为 /api/shejing/probe')
  assert.deepEqual(route.methods, ['GET'])
  assert.equal(route.requestBody, 'buffered')
  const probeResponse = await route.fetch(new Request('http://x/api/shejing/probe'))
  const probe = await probeResponse.json()
  console.log('面板路由     :', probeResponse.status, 'ok=' + probe.ok, 'lrToolCount=' + probe.lrToolCount, 'batches=' + probe.batches.length)
  assert.equal(probeResponse.status, 200)
  assert.equal(probe.ok, true)
  assert.equal(probe.lrToolCount, 56)
  assert.ok(Array.isArray(probe.batches))
}

// --- Python 运行时 ---
const { resolvePython, PYTHON_DIR } = await import('../src/python.mjs')
const py = await resolvePython()
console.log('python      :', py === null ? '✗ 未找到' : `${py.source} → ${py.command}`)

// --- .lrplugin 同步（幂等性检查，不实际写盘时也能跑） ---
if (!noSync) {
  const { syncLrplugin } = await import('../src/lr/install.mjs')
  const before = await syncLrplugin({})
  const after = await syncLrplugin({})
  console.log(`lrplugin    : 第一次 ${before.status}，第二次 ${after.status}`)
  assert.equal(after.status, 'current', '第二次同步应当判定为已是最新（幂等）')
}

console.log('\nlogs:')
for (const line of logs) console.log('  ', line)
console.log('\n✅ 冒烟测试通过')
