/**
 * 假的 Lightroom 桥接，用于测试宿主半边的 MCP 客户端。
 *
 * 为什么需要它：真实的 LR 通道（自托管 MCP 客户端 + 56 个工具包装）是整份代码里
 * 机关最多、而自动化覆盖最少的一段——没有 Lightroom 就无法执行。这个假服务器把
 * 协议那一侧做出来，于是握手、工具调用、错误、图片块、连接断开这些路径都能测。
 *
 * 它**不**测真实的 Lua 插件行为，那部分只能靠真机验收。这里测的是我们自己的 client。
 *
 * 环境变量：
 *   SHEJING_FAKE_LR_FAIL=1      initialize 时直接退出（模拟桥接起不来）
 *   SHEJING_FAKE_LR_DIE_AFTER=1 处理完第一个工具调用后退出（模拟桥接中途死掉）
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

const TOOLS = [
  {
    name: 'search_photos',
    description: '假实现：按星级搜照片。',
    inputSchema: { type: 'object', properties: { rating: { type: 'number' } }, additionalProperties: false },
  },
  {
    name: 'get_photo_preview',
    description: '假实现：返回一张预览图（结构化字段里带 file_path）。',
    inputSchema: { type: 'object', properties: { photo_id: { type: 'string' } }, required: ['photo_id'], additionalProperties: false },
  },
  {
    name: 'set_develop_settings',
    description: '假实现：永远失败，用来测错误路径。',
    inputSchema: { type: 'object', properties: { photo_id: { type: 'string' } }, required: ['photo_id'], additionalProperties: false },
  },
]

if (process.env.SHEJING_FAKE_LR_FAIL === '1') {
  console.error('[fake-lr] 按 SHEJING_FAKE_LR_FAIL=1 直接退出')
  process.exit(1)
}

let calls = 0
const server = new Server(
  { name: 'fake-lightroom', version: '0.0.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  calls += 1
  const name = request.params.name
  const args = request.params.arguments ?? {}

  if (process.env.SHEJING_FAKE_LR_DIE_AFTER === '1' && calls >= 1) {
    // 先把这一条回答掉，再退出——模拟「调用成功但桥接随后消失」。
    setTimeout(() => process.exit(0), 30)
  }

  if (name === 'search_photos') {
    return {
      content: [{ type: 'text', text: `找到 3 张（rating=${args.rating ?? 0}）` }],
      structuredContent: { count: 3 },
    }
  }

  if (name === 'get_photo_preview') {
    // 真实的 bridge 会把 JPEG 写成文件、把路径放进结构化字段，再附一个 image 块。
    return {
      content: [
        { type: 'text', text: `预览已渲染：/tmp/fake-preview-${args.photo_id}.jpg` },
        { type: 'image', data: 'ZmFrZQ==', mimeType: 'image/jpeg' },
      ],
      structuredContent: { file_path: `/tmp/fake-preview-${args.photo_id}.jpg`, image_attached_by_server: true },
    }
  }

  if (name === 'set_develop_settings') {
    // 真实行为：handler 失败时只写 success:false，**不设 isError**。
    return {
      content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'photo not found' }) }],
      structuredContent: { success: false, error: 'photo not found' },
    }
  }

  return { content: [{ type: 'text', text: `未知工具 ${name}` }], isError: true }
})

await server.connect(new StdioServerTransport())
