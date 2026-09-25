/**
 * 假的 Lightroom 桥接，用于测试宿主半边的 MCP 客户端。
 *
 * 为什么需要它：真实的 LR 通道（自托管 MCP 客户端 + 56 个工具包装）是整份代码里
 * 机关最多、而自动化覆盖最少的一段——没有 Lightroom 就无法执行。这个假服务器把
 * 协议那一侧做出来，于是握手、工具调用、错误、图片块、连接断开这些路径都能测。
 *
 * 它**不**测真实的 Lua 插件行为，那部分只能靠真机验收。这里测的是我们自己的 client。
 *
 * **工具清单与参数校验都来自真实契约**（`lrbridge/dist/tool-contracts.js`），不再
 * 手抄。手抄的 schema 一定会漂：原先这里 `set_develop_settings` 的 `settings` 是个
 * 无约束的 `{}`，而真实契约有 `minProperties: 1` 和几十个字段；于是「我们下发的参数
 * 形状对不对」这件事在测试里根本没人管。现在我们每收到一次调用就拿真实 schema 校验，
 * **参数形状错了会直接变成 isError**，测试立刻炸——门禁那个「单数 photo_id 被当成
 * 复数用」的漏洞就属于这一类，本来早该在这里被拦住。
 *
 * 环境变量：
 *   SHEJING_FAKE_LR_FAIL=1      initialize 时直接退出（模拟桥接起不来）
 *   SHEJING_FAKE_LR_DIE_AFTER=1 处理完第一个工具调用后退出（模拟桥接中途死掉）
 *   SHEJING_FAKE_LR_LOG=<路径>   把每次调用的工具名与参数追加进去
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

const { TOOL_CONTRACTS } = await import('../lrbridge/dist/tool-contracts.js')
const { default: Ajv } = await import('ajv')

const ajv = new Ajv({ strict: false, allowUnionTypes: true, validateFormats: false })
const validators = new Map(
  TOOL_CONTRACTS.map(contract => [contract.name, ajv.compile(contract.inputSchema)]),
)

/** 广告真实契约——和真桥接广告的是同一份。 */
const TOOLS = TOOL_CONTRACTS.map(contract => ({
  name: contract.name,
  description: contract.description,
  inputSchema: contract.inputSchema,
}))

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

  // 参数必须符合该工具**真实**的 JSON Schema。不符合就是我们的代码写错了形状，
  // 直接以 isError 返回——LR 工具包装会把它抛出来，测试不会静默通过。
  const validate = validators.get(name)
  if (validate !== undefined) {
    if (!validate(args)) {
      const detail = (validate.errors ?? [])
        .map(e => `${e.instancePath || '/'} ${e.message}`)
        .join('; ')
      return {
        content: [{
          type: 'text',
          text: `${name} 的参数不符合真实契约：${detail}（收到 ${JSON.stringify(args)}）`,
        }],
        isError: true,
      }
    }
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

  if (name === 'import_photos') {
    // 真实 handler 的返回形状：{success, imported, message}。
    // 导入了多少张由 Lightroom 自己数（这里就数源目录里的 RAW），
    // 这正是我们要记进账本的那个数字——不能用「目标目录里有几个文件」代替。
    const { readdirSync } = await import('node:fs')
    const source = String(args.source_path ?? '')
    let count = 0
    try {
      count = readdirSync(source).filter(f => /\.(arw|cr2|cr3|nef|dng|raf|orf|rw2|jpg|jpeg)$/iu.test(f)).length
    } catch {
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: false, error: `源目录不存在：${source}` }) }],
        structuredContent: { success: false },
      }
    }
    // SHEJING_FAKE_LR_IMPORT_FAIL=1：模拟「导入失败但 HTTP 层没事」——
    // 真实 handler 失败时就是这样，不设 isError。
    if (process.env.SHEJING_FAKE_LR_IMPORT_FAIL === '1') {
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'catalog is read-only' }) }],
        structuredContent: { success: false, error: 'catalog is read-only' },
      }
    }
    return {
      content: [{ type: 'text', text: JSON.stringify({ success: true, imported: count, message: `Imported ${count} photos` }) }],
      structuredContent: { success: true, imported: count },
    }
  }

  if (name === 'create_collection_set' || name === 'create_collection') {
    return {
      content: [{ type: 'text', text: JSON.stringify({ success: true, name: args.name }) }],
      structuredContent: { success: true, name: args.name },
    }
  }

  if (name === 'add_to_collection') {
    // SHEJING_FAKE_LR_COLLECTION_PARTIAL=1：模拟「只加进去一部分」。
    const ids = Array.isArray(args.photo_ids) ? args.photo_ids : []
    const added = process.env.SHEJING_FAKE_LR_COLLECTION_PARTIAL === '1' ? Math.max(0, ids.length - 1) : ids.length
    const missing = ids.length - added
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ success: true, added, missing: ids.slice(added), message: `Added ${added} photos to collection (${missing} ids not found)` }),
      }],
      structuredContent: { success: true, added, missing },
    }
  }

  if (name === 'export_photos') {
    // 真的写出文件：归档工具会核对「目标目录里的实际文件数」。
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const path = await import('node:path')
    const destination = String(args.destination ?? '')
    const ids = Array.isArray(args.photo_ids) ? args.photo_ids : []
    mkdirSync(destination, { recursive: true })
    // 只写出前 n 个文件，模拟「Lightroom 少导了」（桥接报成功、但目标目录里
    // 并没有那么多）。测试拿它验证调用方**真的**去数了文件，而不是把计划数量
    // 当成结果。
    //
    // 限制从**文件**读，不是从环境变量读：桥接复用一条长连接，子进程的环境在
    // 第一次调用时就定死了，测试中途再设 process.env 根本传不进去（我第一版就是
    // 这么写的，结果限制没生效）。另外必须区分「没设」与「设成 0」——
    // `Number('')` 等于 0，直接拿来用会让正常导出一个文件都不写。
    let limit = null
    const limitFile = process.env.SHEJING_FAKE_LR_EXPORT_LIMIT_FILE
    if (limitFile !== undefined && limitFile !== '') {
      try {
        const { readFileSync } = await import('node:fs')
        const raw = readFileSync(limitFile, 'utf8').trim()
        if (raw !== '') {
          const parsed = Number(raw)
          if (Number.isFinite(parsed) && parsed >= 0) limit = parsed
        }
      } catch { /* 文件不在就是不限制 */ }
    }
    const toWrite = limit === null ? ids : ids.slice(0, limit)
    for (const id of toWrite) {
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
