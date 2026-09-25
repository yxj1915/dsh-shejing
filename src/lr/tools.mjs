/**
 * 把 Lightroom 桥接暴露的 56 个工具注册成 DSH 工具。
 *
 * 工具契约（名称、描述、inputSchema、读写分类）直接从 bridge 的 dist 里
 * **静态导入**，所以开机即可注册，不需要 bridge 已经起来——真正调用时才惰性连接。
 * 这样即使 Lightroom 没开，模型也能看到工具有哪些、并得到一条清楚的错误。
 *
 * 命名保持 `mcp__lightroom__<name>`：这条路虽然是我们自托管的 MCP 客户端，
 * 但对模型来说它就是一组 MCP 风格的外部工具。
 */

import { TOOL_CONTRACTS, READ_ONLY_TOOL_NAMES, DESTRUCTIVE_TOOL_NAMES } from '../../lrbridge/dist/tool-contracts.js'
import { LightroomBridge } from './bridge.mjs'

const READ_ONLY = new Set(READ_ONLY_TOOL_NAMES)
const DESTRUCTIVE = new Set(DESTRUCTIVE_TOOL_NAMES)

/** 与 bridge 内部 ACTION_TIMEOUTS_MS 对齐（略放宽），供 DSH 的超时策略使用。 */
const TIMEOUT_MS = {
  export_photos: 600_000,
  import_photos: 600_000,
  ai_denoise: 600_000,
  get_photo_preview: 180_000,
  add_ai_mask: 240_000,
  add_range_mask: 240_000,
  add_local_adjustment: 240_000,
  remove_mask: 240_000,
  apply_auto: 240_000,
  reset_develop: 240_000,
  set_process_version: 240_000,
  batch_metadata: 240_000,
  set_flags: 240_000,
}

export const LIGHTROOM_TOOL_PREFIX = 'mcp__lightroom__'

/**
 * 注册全部 LR 工具。
 * @param ctx Cordis 上下文（已注入 tools）
 * @param bridge LightroomBridge 实例
 * @returns 已注册模型的列表
 */
export function registerLightroomTools(ctx, bridge) {
  const registered = []
  for (const contract of TOOL_CONTRACTS) {
    const rawName = contract.name
    const toolName = `${LIGHTROOM_TOOL_PREFIX}${rawName}`
    const kind = READ_ONLY.has(rawName) ? 'read' : DESTRUCTIVE.has(rawName) ? 'destructive' : 'write'
    const suffix = kind === 'read' ? '' : kind === 'destructive' ? '（破坏性操作）' : '（会修改目录）'

    ctx.effect(() => ctx.tools.register({
      name: toolName,
      description: `${contract.description}${suffix}`,
      parameters: contract.inputSchema,
      ...(TIMEOUT_MS[rawName] === undefined ? {} : { timeoutMs: TIMEOUT_MS[rawName] }),
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : String(value) }],
      },
      async execute(args, exec) {
        if (exec?.signal?.aborted) throw new Error('调用已取消')
        const result = await bridge.call(rawName, args ?? {})
        const text = LightroomBridge.toText(result)

        // 协议层的失败（isError）必须显式抛出去，让 DSH 把它标成失败调用。
        // 否则它只是一段普通文本，模型很可能当成正常结果读过去。
        //
        // 注意区分：载荷里的 `success: false` **不抛**——你自己的 gotcha 里写着
        // 有些 handler 会返回 success:false 但事情其实做成了（add_ai_mask 就是），
        // 那种情况要用独立手段复核，而不是在这里一刀切成失败。
        if (result?.isError === true) {
          throw new Error(`${rawName} 失败：${text}`)
        }
        return text
      },
    }))
    registered.push({ tool: toolName, raw: rawName, kind })
  }
  return registered
}
