/**
 * 真机检查：验证自托管的 LR 通道能真的说上话。
 *
 * **只读**。只做搜索、读参数、取预览——不导入、不调色、不改目录数据库。
 * 唯一会动的是桥接自己的运行期文件（token 读取、实例锁），那是正常运行行为。
 *
 * 为什么需要它：整套自动化测试都用假桥接，测的是「我们自己的 MCP 客户端」；
 * 而「我们的客户端 ↔ 真 bridge ↔ Lightroom 里的 Lua 插件」这条链从来没跑过。
 * 这是发布前最后一个大未知。
 *
 * 用法：DSH_HOME=<repo>/.dev/dsh-home node scripts/live-check.mjs
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { BRIDGE_ENTRY, LightroomBridge, LightroomUnavailable } from '../src/lr/bridge.mjs'

const TOKEN_FILE = path.join(homedir(), '.config', 'lightroom-mcp', 'token')

let failed = 0
function step(label, ok, detail) {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failed += 1
}

console.log('真机检查（只读）\n')

console.log('—— 环境 ——')
step('授权 token 存在', existsSync(TOKEN_FILE), TOKEN_FILE)
step('bridge 入口存在', existsSync(BRIDGE_ENTRY), BRIDGE_ENTRY)

// 刻意**不**用裸 TCP 探测端口来判断「Lightroom 在不在」。
// 你自己的 gotcha 记着：频繁新建连接会把插件的 socket 重绑循环打坏；而一次
// connect-立刻-close 正是那种操作。直接走一次真正的握手，既更准也更安全。
console.log('\n—— 链路（一次握手，不裸连探测）——')
const bridge = new LightroomBridge({ log: (m) => console.log(`     [bridge] ${m}`) })

try {
  const search = await bridge.call('search_photos', { limit: 3 })
  const searchText = LightroomBridge.toText(search)
  step('initialize 握手成功', true)
  step('search_photos 有回应', searchText.length > 0, searchText.split('\n')[0].slice(0, 80))

  // 从返回里挖一个 photo id，继续做只读检查。
  const idMatch = /"id"\s*:\s*(\d+)/.exec(JSON.stringify(search?.structuredContent ?? {}))
    ?? /"id"\s*:\s*(\d+)/.exec(searchText)
  const photoId = idMatch === null ? null : Number(idMatch[1])

  if (photoId === null) {
    console.log('     ⓘ 返回里没找到照片 id（目录可能是空的）——跳过后续只读检查')
  } else {
    const status = await bridge.call('get_photo_status', { photo_ids: [photoId] })
    step('get_photo_status 读得到状态', LightroomBridge.toText(status).length > 0,
      LightroomBridge.toText(status).replace(/\s+/g, ' ').slice(0, 70))

    const settings = await bridge.call('get_develop_settings', { photo_id: photoId, fields: 'basic' })
    const settingsText = LightroomBridge.toText(settings)
    step('get_develop_settings 读得到参数', settingsText.length > 0,
      settingsText.replace(/\s+/g, ' ').slice(0, 70))

    const preview = await bridge.call('get_photo_preview', { photo_id: photoId, size: 'small' })
    const hasImage = Array.isArray(preview?.content)
      && preview.content.some(block => block?.type === 'image')
    const previewPath = preview?.structuredContent?.file_path
    step('get_photo_preview 返回了图片块', hasImage === true)
    step('预览落到了磁盘（read_image 能用）',
      typeof previewPath === 'string' && existsSync(previewPath), String(previewPath))
  }

  step('整条链路可用', true)
} catch (error) {
  const isUnavailable = error instanceof LightroomUnavailable
  step('链路可用', false, `${isUnavailable ? 'Lightroom 不可用' : '出错'}：${error?.message ?? error}`)
  if (isUnavailable) {
    console.log('\n  按这个顺序恢复：')
    console.log('    1. Lightroom 里 文件 ▸ 增效工具管理器 ▸ Lightroom MCP ▸ Start Server')
    console.log('    2. Reload Plug-in')
    console.log('    3. 还不行就重启 Lightroom')
    console.log('    日志：~/Documents/LrClassicLogs/LightroomMCP.log')
  }
} finally {
  await bridge.close()
}

console.log()
if (failed > 0) {
  console.error(`❌ ${failed} 项未通过`)
  process.exit(1)
}
console.log('✅ 真机检查通过（全程只读，没有改动任何照片或目录数据）')
process.exit(0)
