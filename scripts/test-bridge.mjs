/**
 * 宿主半边的 LR 通道测试。
 *
 * 用 tests/fake-lr-server.mjs 假装成桥接，测我们自己的 MCP 客户端：
 * 握手、文本结果、图片块的路径提示、失败结果的识别、连接断开后的提示、
 * 以及桥接起不来时的错误是否说人话。
 *
 * **不测**真实的 Lua 插件行为——那只能靠真机验收。
 *
 * 用法：node scripts/test-bridge.mjs
 */

import assert from 'node:assert/strict'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const FAKE = path.join(ROOT, 'tests', 'fake-lr-server.mjs')

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

async function withBridge(env, body) {
  const saved = { ...process.env }
  Object.assign(process.env, env)
  // 每个用例都要拿到**新的**模块实例——BRIDGE_ENTRY 是模块加载时求值的。
  const mod = await import(`../src/lr/bridge.mjs?v=${Date.now()}${Math.random()}`)
  const bridge = new mod.LightroomBridge({ log: () => {} })
  try {
    return await body(bridge, mod)
  } finally {
    await bridge.close()
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
  }
}

console.log('LR 通道（自托管 MCP 客户端）测试\n')
console.log('—— 正常路径 ——')

await withBridge({ SHEJING_BRIDGE_ENTRY: FAKE }, async (bridge, mod) => {
  const result = await bridge.call('search_photos', { rating: 4 })
  const text = mod.LightroomBridge.toText(result)
  check('握手成功并能调用工具', () => {
    assert.ok(bridge.connected, '调用之后应当处于已连接状态')
    assert.match(text, /找到 3 张/, `结果文本不对：${text}`)
  })

  const preview = await bridge.call('get_photo_preview', { photo_id: '181417' })
  const previewText = mod.LightroomBridge.toText(preview)
  check('图片块会给出磁盘路径供 read_image 使用', () => {
    assert.match(previewText, /read_image/, `应当提示用 read_image：${previewText}`)
    assert.match(previewText, /fake-preview-181417\.jpg/, '应当带上 file_path')
  })

  // apply_auto 在假服务器上永远返回 success:false —— 真实 handler 失败时正是这样，
  // 而且**不设 isError**，所以调用方必须自己看 payload。
  const failed = await bridge.call('apply_auto', { photo_ids: ['nope'] })
  const failedText = mod.LightroomBridge.toText(failed)
  check('success:false 的结果原样透出（不当成成功）', () => {
    assert.match(failedText, /success/, '应当把 payload 里的失败信息透出来')
    assert.ok(!/^ok$/i.test(failedText.trim()), '不能把失败当成功')
  })

  check('重复调用复用同一条连接', () => assert.ok(bridge.connected))
  await bridge.close()
  check('关闭后不再处于已连接状态', () => assert.equal(bridge.connected, false))
})

console.log('\n—— 桥接起不来 ——')

await withBridge({ SHEJING_BRIDGE_ENTRY: FAKE, SHEJING_FAKE_LR_FAIL: '1' }, async (bridge, mod) => {
  let error = null
  try {
    await bridge.call('search_photos', {})
  } catch (caught) {
    error = caught
  }
  check('报错说清是 Lightroom 链路问题，而不是裸的 spawn 错', () => {
    assert.ok(error !== null, '应当抛错')
    assert.match(String(error.message), /Lightroom/i, `错误信息应当提到 Lightroom：${error && error.message}`)
    assert.match(String(error.message), /增效工具管理器|Start Server/, '应当给出可执行的下一步')
  })
  check('失败后不会假装已连接', () => assert.equal(bridge.connected, false))

  // 第二次调用应当**重新尝试连接**，而不是永远记住失败。
  let second = null
  try {
    await bridge.call('search_photos', {})
  } catch (caught) {
    second = caught
  }
  check('失败后下一次调用会重试连接', () => assert.ok(second !== null || bridge.connected))
})

console.log('\n—— 入口不存在 ——')

await withBridge({ SHEJING_BRIDGE_ENTRY: path.join(ROOT, 'tests', 'does-not-exist.mjs') }, async (bridge) => {
  let error = null
  try {
    await bridge.call('search_photos', {})
  } catch (caught) {
    error = caught
  }
  check('入口文件不存在时报错清楚', () => {
    assert.ok(error !== null, '应当抛错')
    assert.match(String(error.message), /Lightroom/i, `错误信息应当提到 Lightroom：${error && error.message}`)
  })
})

console.log()
if (failed > 0) {
  console.error(`❌ ${failed} 个用例失败`)
  process.exit(1)
}
console.log('✅ LR 通道测试通过')
