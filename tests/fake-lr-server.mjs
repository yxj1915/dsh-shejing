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
    name: 'apply_auto',
    description: '假实现：永远返回 success:false（真实 handler 失败时就是这样，且不设 isError）。',
    inputSchema: { type: 'object', properties: { photo_ids: { type: 'array' } }, additionalProperties: false },
  },
  {
    name: 'create_snapshot',
    description: '假实现：建快照。',
    inputSchema: { type: 'object', properties: { photo_id: {}, name: {} }, additionalProperties: false },
  },
  {
    name: 'set_develop_settings',
    description: '假实现：写入调色参数（会把下发的参数记进 SHEJING_FAKE_LR_LOG）。',
    inputSchema: { type: 'object', properties: { photo_id: {}, settings: {} }, additionalProperties: false },
  },
  {
    name: 'set_tone_curve',
    description: '假实现：写曲线（同样记账）。',
    inputSchema: { type: 'object', properties: { photo_id: {}, channel: {}, points: {} }, additionalProperties: false },
  },
  {
    name: 'export_photos',
    description: '假实现：真的在目标目录里写出文件，好让调用方核对数量。',
    inputSchema: { type: 'object', properties: { photo_ids: {}, destination: {} }, additionalProperties: false },
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

  // 每一次调用都记下来——测试要核对「到底下发了什么」，漏记一次就少一条证据。
  const logFile = process.env.SHEJING_FAKE_LR_LOG
  if (logFile !== undefined && logFile !== '') {
    const { appendFileSync } = await import('node:fs')
    appendFileSync(logFile, `${JSON.stringify({ tool: name, args })}\n`)
  }

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

  if (name === 'apply_auto') {
    // 真实行为：handler 失败时只写 success:false，**不设 isError**。
    return {
      content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'photo not found' }) }],
      structuredContent: { success: false, error: 'photo not found' },
    }
  }

  if (name === 'create_snapshot' || name === 'set_develop_settings' || name === 'set_tone_curve') {
    return { content: [{ type: 'text', text: `${name} ok` }], structuredContent: { ok: true } }
  }

  if (name === 'export_photos') {
    // 真的写出文件：归档工具会核对「目标目录里的实际文件数」。
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const path = await import('node:path')
    const destination = String(args.destination ?? '')
    const ids = Array.isArray(args.photo_ids) ? args.photo_ids : []
    mkdirSync(destination, { recursive: true })
    for (const id of ids) {
      const base = path.basename(String(id)).replace(/\.[^.]+$/u, '')
      writeFileSync(path.join(destination, `${base}.jpg`), 'fake-jpeg')
    }
    return {
      content: [{ type: 'text', text: `导出 ${ids.length} 张 → ${destination}` }],
      structuredContent: { count: ids.length },
    }
  }

  return { content: [{ type: 'text', text: `未知工具 ${name}` }], isError: true }
})

await server.connect(new StdioServerTransport())
