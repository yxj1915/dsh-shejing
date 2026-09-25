/**
 * 开发用冒烟测试：用一个假的 Cordis 上下文加载插件，检查注册面与关键路径。
 * 不连 Lightroom、不改 profile、不写 ~/.dsh 之外的东西（.lrplugin 同步除外，
 * 可用 --no-sync 跳过）。
 *
 * 用法：node scripts/smoke.mjs [--no-sync]
 */

import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

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

/*
 * 参数必须从**工具自己的契约**造出来，并用契约自己的 JSON Schema 校验。
 *
 * 这里踩过一次大坑，值得写在测试里：原先给 `set_develop_settings` 传的是
 * `photo_ids: ['a','b','c']`，而它的真实 schema 是**单数** `photo_id` 且
 * `additionalProperties: false` —— 真实工具会在 schema 层就拒掉那个参数。
 * 于是那条断言测的是一个**不可能发生的输入**，而真实路径上门禁一次都没触发过：
 * 模型只要逐张调 `set_develop_settings`，就能把一套没验证过的参数刷满整批。
 *
 * 现在参数由 schema 生成、再由 schema 校验，测试不可能再漂到真实形状之外。
 */
const { TOOL_CONTRACTS } = await import('../lrbridge/dist/tool-contracts.js')
const { default: Ajv } = await import('ajv')
const ajv = new Ajv({ strict: false, allowUnionTypes: true, validateFormats: false })

function sampleFor(schema) {
  if (schema === undefined || schema === null) return 'x'
  if (schema.oneOf !== undefined || schema.anyOf !== undefined) {
    return sampleFor((schema.oneOf ?? schema.anyOf)[0])
  }
  if (schema.enum !== undefined) return schema.enum[0]
  if (schema.const !== undefined) return schema.const
  if (schema.type === 'number' || schema.type === 'integer') return schema.minimum ?? 1
  if (schema.type === 'boolean') return true
  if (schema.type === 'array') return [sampleFor(schema.items)]
  if (schema.type === 'object') {
    const props = schema.properties ?? {}
    const out = {}
    for (const [key, value] of Object.entries(props)) {
      if ((schema.required ?? []).includes(key)) out[key] = sampleFor(value)
    }
    // 有的 schema 用 minProperties 而不是 required 来要求「至少写一个参数」
    // （`set_develop_settings.settings` 就是），空对象会被拒。
    const min = schema.minProperties ?? 0
    for (const [key, value] of Object.entries(props)) {
      if (Object.keys(out).length >= min) break
      if (out[key] === undefined) out[key] = sampleFor(value)
    }
    return out
  }
  return 'x'
}

/** 按 rawTool 的真实 inputSchema 造一份合法参数；照片身份字段填 photoValues。 */
function lrArgs(rawTool, photoValues) {
  const contract = TOOL_CONTRACTS.find(t => t.name === rawTool)
  assert.ok(contract !== undefined, `找不到工具契约：${rawTool}`)
  const schema = contract.inputSchema
  const validate = ajv.compile(schema)

  const base = {}
  for (const [key, value] of Object.entries(schema.properties ?? {})) {
    if (key === 'photo_id' || key === 'source_id') base[key] = photoValues[0]
    else if (key === 'photo_ids' || key === 'target_ids') base[key] = [...photoValues]
    else if ((schema.required ?? []).includes(key)) base[key] = sampleFor(value)
  }

  // 顶层 anyOf/oneOf 表示「这几组字段里满足一组就行」（`set_tone_curve` 就是
  // points 与 preset 二选一）。依次尝试各分支、补上它 required 的字段，
  // 取第一个能通过校验的——这样测试参数永远落在契约允许的形状里。
  const branches = schema.anyOf ?? schema.oneOf ?? []
  const candidates = branches.length === 0 ? [base] : branches.map((branch) => {
    const candidate = { ...base }
    for (const key of branch.required ?? []) {
      if (candidate[key] === undefined && schema.properties?.[key] !== undefined) {
        candidate[key] = sampleFor(schema.properties[key])
      }
    }
    return candidate
  })

  for (const candidate of candidates) {
    if (validate(candidate)) return candidate
  }
  assert.fail(
    `${rawTool} 的测试参数不符合它自己的 schema：${JSON.stringify(validate.errors)}\n`
    + `  试过的参数：${JSON.stringify(candidates)}`)
}

const lrCall = (rawTool, photoValues) => ({
  name: `mcp__lightroom__${rawTool}`,
  arguments: lrArgs(rawTool, photoValues),
})

/*
 * 受管工具逐个验。关键在第二条断言：**同一套参数用到第二张不同照片时必须拦**，
 * 哪怕它是分两次调用、每次只带一张。那正是上面说的那个漏洞：
 * `set_develop_settings` / `set_tone_curve` 的 schema 是单数 `photo_id`，
 * 按「本次调用有几张」计数的话它们永远算 1 张，门禁形同虚设。
 */
const PARAM_GATED = [
  'set_develop_settings', 'set_tone_curve', 'set_white_balance', 'apply_develop_preset',
  'copy_develop_settings', 'apply_auto', 'set_noise_reduction', 'ai_denoise',
]
for (const rawTool of PARAM_GATED) {
  const first = await gate(lrCall(rawTool, ['photo-1']), allow)
  assert.equal(first.kind, 'allow', `${rawTool}：第一张应当放行（那正是「单张先行」本身）`)
  const second = await gate(lrCall(rawTool, ['photo-2']), allow)
  assert.equal(second.kind, 'ask',
    `${rawTool}：同一套参数用到第二张照片必须拦（逐张调用绕过门禁的漏洞）`)
  console.log(`门禁·${rawTool.padEnd(22)} → 第 1 张 allow，第 2 张 ask`)
}

// 一次调用带多张：立即拦（这是原实现唯一能拦住的形态，不能因为改了判定就丢掉）
const multi = await gate(lrCall('apply_auto', ['m1', 'm2', 'm3']), allow)
assert.equal(multi.kind, 'ask', '一次调用带 3 张必须立即拦')
console.log('门禁·一次带多张        → ask')

// 只拦参数写入。只读工具、以及可逆标记类工具都不该被参数门禁拦。
assert.equal((await gate({ name: 'mcp__lightroom__search_photos', arguments: { limit: 50 } }, allow)).kind, 'allow',
  '只读工具不该被拦')
assert.equal((await gate(lrCall('set_rating', ['a', 'b']), allow)).kind, 'allow',
  '星级属于标记门禁，不是参数门禁')

// 被拦下但**没执行**时不能进白名单——否则「问一次就永久放行」。
await gate(lrCall('apply_develop_preset', ['n1']), allow)
assert.equal((await gate(lrCall('apply_develop_preset', ['n2']), allow)).kind, 'ask',
  '只是被拦下、尚未执行时不能进白名单')

// **被拒绝的调用绝不能进白名单。**
//
// DSH 在拒绝路径上也会跑 post-execute（deny → post-result → postExecute，
// 见 dsh-tools/src/index.ts）。无条件记账的话：用户点拒绝 → 参数进白名单 →
// 第二次同样的调用不再问就执行；在没有审批通道的环境里 serviceAsk 会自动拒绝，
// 于是第一次调用就把参数放行了——等于凭空多出一条 force 旁路。
const deniedCall = lrCall('set_white_balance', ['d1', 'd2'])
assert.equal((await gate(deniedCall, allow)).kind, 'ask', '前置：应当先被拦一次')
await post[0](deniedCall, { isError: true, error: { message: 'the user rejected tool ...' } }, allow)
const afterDenial = await gate(lrCall('set_white_balance', ['d1', 'd2']), allow)
assert.equal(afterDenial.kind, 'ask', '被用户拒绝的调用绝不能进白名单（否则重试就无门禁）')
console.log('门禁·拒绝不入白名单    → ask')

// 执行失败（比如桥接挂了）同样不能入白名单
const failedCall = lrCall('set_noise_reduction', ['f1', 'f2'])
assert.equal((await gate(failedCall, allow)).kind, 'ask', '前置：应当先被拦一次')
await post[0](failedCall, { isError: true }, allow)
assert.equal((await gate(lrCall('set_noise_reduction', ['f1', 'f2']), allow)).kind, 'ask',
  '执行失败的调用不能进白名单')

// 用户同意 → post-execute 记账 → 同一套参数之后不再拦（白名单）
const wlAsk = lrCall('set_noise_reduction', ['w2'])
assert.equal((await gate(wlAsk, allow)).kind, 'ask', '白名单前置：应当先被拦一次')
await post[0](wlAsk, { ok: true }, allow)
const wlAgain = await gate(lrCall('set_noise_reduction', ['w3']), allow)
assert.equal(wlAgain.kind, 'allow', '已入白名单的参数不该再拦')
console.log('门禁·白名单生效        → allow')

const cullConfirm = { name: 'shejing_cull', arguments: { reject: ['x.ARW', 'y.ARW'], confirm: true } }
console.log('门禁·剔除(confirm)   →', (await gate(cullConfirm, allow)).kind)
assert.equal((await gate(cullConfirm, allow)).kind, 'ask', '真移动文件必须让用户看到完整名单再点头')

const cullDry = { name: 'shejing_cull', arguments: { reject: ['x.ARW'] } }
assert.equal((await gate(cullDry, allow)).kind, 'allow', '剔除预演不该被拦（那一趟本来就是给用户看的）')

// shejing_grade 内部直接调桥接、不走 DSH 工具，所以钩子必须专门认它，
// 否则它就是 Q29 要堵的那条旁路。顺序按真实用法：先单张（先行），再整批。
const gradeSingle = { name: 'shejing_grade', arguments: { photo_ids: ['g1'], style: 'A' } }
console.log('门禁·调色单张        →', (await gate(gradeSingle, allow)).kind)
assert.equal((await gate(gradeSingle, allow)).kind, 'allow', '单张调色不该被拦（那正是「先行」本身）')

const gradeBatch = { name: 'shejing_grade', arguments: { photo_ids: ['g1', 'g2', 'g3'], style: 'A' } }
const gradeAsked = await gate(gradeBatch, allow)
console.log('门禁·调色批量        →', gradeAsked.kind)
assert.equal(gradeAsked.kind, 'ask', '批量调色必须被拦下')
assert.ok(String(gradeAsked.reason).includes('没有'), '理由里应当说明缺少单张渲染记录')

// 逐张调用同样拦得住——只看 photo_ids.length 的话这里会漏（和 bridge 工具同一个洞）
assert.equal((await gate({ name: 'shejing_grade', arguments: { photo_ids: ['g9'], style: 'A' } }, allow)).kind,
  'ask', '同一套参数换成另一张照片也必须拦（逐张调用绕不过去）')

// 换一套全新参数则重新从「单张先行」开始
assert.equal((await gate({ name: 'shejing_grade', arguments: { photo_ids: ['h1'], style: 'B' } }, allow)).kind,
  'allow', '换一套新参数时第一张仍应放行')

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

  /*
   * 面板的**数据接口**要端到端跑一遍。
   *
   * 审计员的变异 24 证明过：把 batchSummary 掏空成返回空对象（于是每个批次在面板
   * 上都是空白的），**七套测试全部照样绿**——因为 /batches 与 /batch 从没被执行过，
   * 而 check-client 喂的是手写 fixture，没有任何东西把 fixture 的形状和接口真实的
   * 返回绑在一起。接口改了、面板读不到，两边都不会有人发现。
   */
  {
    const batchesDir = path.join(dshHome, 'shejing', 'batches', 'smoke-route-batch')
    await mkdir(batchesDir, { recursive: true })
    await writeFile(path.join(batchesDir, 'manifest.json'), `${JSON.stringify({
      batch_id: '2026-01-02_smoke',
      source_path: '/tmp/smoke-source',
      photo_count: 3,
      camera: ['ILCE-7M5'],
      updated: '2026-01-02 10:00:00',
      stages: {
        checkup: {
          status: 'done',
          cache_dir: '/tmp/smoke-cache',
          contact_sheet: '/tmp/smoke-sheet.jpg',
          groups: [{
            count: 2, kind: '连拍', reliable: true, span_s: 1.5, ev_spread: 0.25, keep: 'a.ARW',
            frames: [{ name: 'a.ARW' }, { name: 'b.ARW' }],
          }],
          frames: {
            'a.ARW': { small: '/tmp/a.jpg', big: null, sharp: 123.4, ev: -12.5 },
            'b.ARW': { small: null, big: null, sharp: 100.0, ev: -12.5 },
          },
        },
        cull: { status: 'done', keep_dir: '/tmp/smoke-source/可导入', kept: 2, rejected: 1 },
      },
    }, null, 1)}\n`)

    const listRoute = ctx.connection.fetchRoutes.get('/api/shejing/batches')
    const listResponse = await listRoute.fetch(new Request('http://x/api/shejing/batches'))
    const list = await listResponse.json()
    assert.equal(listResponse.status, 200)
    const row = list.batches.find(item => item.id === 'smoke-route-batch')
    assert.ok(row !== undefined, '列表里应当有刚建的这个批次')
    assert.equal(row.source, '/tmp/smoke-source', '列表要带源文件夹，面板的批次页要用')
    assert.equal(row.photoCount, 3)
    assert.deepEqual(row.stages, ['checkup', 'cull'])
    console.log('面板·批次列表 →', list.batches.length, '个，字段齐')

    const oneRoute = ctx.connection.fetchRoutes.get('/api/shejing/batch')
    const oneResponse = await oneRoute.fetch(new Request('http://x/api/shejing/batch?id=smoke-route-batch'))
    const payload = await oneResponse.json()
    assert.equal(oneResponse.status, 200)
    // 接口返回的是 {ok, batch}——**包了一层**。客户端读的是 detail.batch，
    // 这里也必须按同一层级断言，否则测的就不是客户端真正拿到的东西。
    assert.equal(payload.ok, true)
    const one = payload.batch
    assert.ok(one !== undefined, '返回里必须有 batch 字段（客户端读的就是它）')
    assert.equal(one.batchId, '2026-01-02_smoke')
    assert.equal(one.camera.length, 1)
    assert.equal(one.contactSheet, '/tmp/smoke-sheet.jpg')
    assert.equal(one.cacheDir, '/tmp/smoke-cache')
    // 分组与逐帧信息是「剔除审阅」面板的全部依据，掏空这里面板就是个空壳。
    assert.equal(one.groups.length, 1, '分组必须传下去，否则剔除审阅页是空的')
    assert.equal(one.groups[0].frames.length, 2)
    assert.equal(one.groups[0].keep, 'a.ARW')
    assert.equal(one.groups[0].frames[0].name, 'a.ARW')
    assert.equal(one.groups[0].frames[0].sharp, 123.4, '逐帧清晰度必须传下去（用户据此剔帧）')
    assert.equal(one.groups[0].frames[0].small, '/tmp/a.jpg')
    assert.equal(one.cull.kept, 2)
    console.log('面板·单批详情 →', one.groups.length, '组 /', one.groups[0].frames.length, '帧，字段齐')

    // 路径穿越必须被挡住（面板可以传任意 id 进来）
    const bad = await oneRoute.fetch(new Request('http://x/api/shejing/batch?id=../../evil'))
    assert.equal(bad.status, 400, '穿越型 id 必须 400')
    const missing = await oneRoute.fetch(new Request('http://x/api/shejing/batch?id=does-not-exist'))
    assert.equal(missing.status, 404, '不存在的批次应当 404')
    console.log('面板·id 防护  → 穿越 400 / 不存在 404')
  }
  // 版本号必须来自包自己的 package.json。曾经用 process.env.npm_package_version，
  // 那个变量在 DSH 进程里根本不存在，于是永远回退到硬编码字面量——改了版本号
  // 面板上显示的还是旧的，属于「不影响功能所以没人发现」的偏差。
  const { PLUGIN_VERSION } = await import('../src/version.mjs')
  const pkgVersion = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')).version
  assert.equal(PLUGIN_VERSION, pkgVersion, 'PLUGIN_VERSION 应当等于 package.json 的版本')
  assert.equal(probe.plugin.version, pkgVersion, '探针报告的版本应当是包的真实版本')
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
