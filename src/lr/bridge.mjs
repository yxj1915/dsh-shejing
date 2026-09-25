/**
 * 自托管的 Lightroom 桥接客户端。
 *
 * 为什么不用 @deepseek-ai/dsh-mcp-client 的声明式 row：
 *   mcp-client 是纯配置驱动的插件（一行一个 server，没有运行时注册 API），
 *   它的 `command` 是直接交给 child_process.spawn 的字符串。发布到 npm 的包
 *   无法知道用户机器上 pnpm 把包装进了哪个 profile 的 node_modules，因此
 *   声明式 row 里写不出 bridge 的绝对路径；`command: 'node'` 也不可靠，
 *   因为 GUI 应用的 PATH 极简。
 *   所以这里用 import.meta.url 自己定位 bridge，用官方 MCP SDK 的 client
 *   端说协议，再把工具注册给 DSH。附带好处：工具边界在我们手里，
 *   门禁（见 gate.mjs）可以在这里统一收口。
 *
 * 生命周期：惰性连接，一次会话内复用；失败即断开，下次调用重连。
 * 刻意不做自动重试——bridge 有单桥接实例锁，且部分工具（导出/导入）非幂等，
 * 超时后静默重试可能造成重复劳动。
 */

import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

/**
 * 我们自带的 bridge 入口（相对本文件定位，不依赖任何环境变量）。
 *
 * 可用 `SHEJING_BRIDGE_ENTRY` 覆盖——两个用途：
 *   1. 测试时指向一个假的 MCP 服务器，好把客户端这套握手/超时/降级逻辑测起来；
 *   2. 用户想改用别的桥接实现（比如上游的 `@pired/lightroom-mcp`）时不必改包。
 */
export const BRIDGE_ENTRY = process.env.SHEJING_BRIDGE_ENTRY !== undefined
  && process.env.SHEJING_BRIDGE_ENTRY !== ''
  ? process.env.SHEJING_BRIDGE_ENTRY
  : fileURLToPath(new URL('../../lrbridge/dist/index.js', import.meta.url))

/**
 * 每次调用的客户端超时。必须**大于** bridge 自己的 ACTION_TIMEOUTS，
 * 否则我们会在 bridge 还能自救的时候先把连接掐掉，错误信息也更差。
 * bridge 内部：默认 30s；导出/导入/降噪 300s；预览 90s；其余慢工具 120s。
 */
const CLIENT_TIMEOUT_MS = {
  export_photos: 330_000,
  import_photos: 330_000,
  ai_denoise: 330_000,
  get_photo_preview: 120_000,
  add_ai_mask: 150_000,
  add_range_mask: 150_000,
  add_local_adjustment: 150_000,
  remove_mask: 150_000,
  apply_auto: 150_000,
  reset_develop: 150_000,
  set_process_version: 150_000,
  batch_metadata: 150_000,
  set_flags: 150_000,
}
const DEFAULT_TIMEOUT_MS = 60_000

/** 桥接不可用时抛出的错误，供工具层转成可读的三段式提示。 */
export class LightroomUnavailable extends Error {
  constructor(message, cause) {
    super(message)
    this.name = 'LightroomUnavailable'
    this.cause = cause
  }
}

/**
 * 显式转发给 bridge 子进程的环境变量。
 *
 * MCP SDK 的 StdioClientTransport 只继承一份「安全」清单
 * （POSIX 上是 HOME/LOGNAME/PATH/SHELL/TERM/USER），其余一律不传。
 * 那意味着用户在 DSH 环境里设的 `LIGHTROOM_MCP_REQUEST_PORT` 之类**会被静默丢掉**
 * ——「明明设了端口却不起作用」是最难查的一类怪事。
 *
 * 所以这里显式转发 bridge 自己的配置项（LIGHTROOM_MCP_*）与我们自己的
 * 覆盖项（SHEJING_*）。HOME 由 SDK 的默认清单提供，token 路径不受影响。
 */
function childEnv() {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (key.startsWith('LIGHTROOM_MCP_') || key.startsWith('SHEJING_')) env[key] = value
  }
  return env
}

export class LightroomBridge {
  #client = null
  #connecting = null
  #log

  constructor({ log = () => {} } = {}) {
    this.#log = log
  }

  /** 当前是否已建立连接（不代表 Lightroom 本体在跑）。 */
  get connected() {
    return this.#client !== null
  }

  /** 主动断开，供插件卸载时清理子进程。 */
  async close() {
    const client = this.#client
    this.#client = null
    if (client === null) return
    try {
      await client.close()
    } catch (error) {
      this.#log(`[shejing] 关闭 bridge 时出错：${error?.message ?? error}`)
    }
  }

  /** 断线：清掉缓存的 client，让下一次调用重新连接。 */
  #drop(reason) {
    if (this.#client !== null) this.#log(`[shejing] bridge 断开：${reason}`)
    this.#client = null
  }

  async #connect() {
    if (this.#client !== null) return this.#client
    if (this.#connecting !== null) return this.#connecting

    this.#connecting = (async () => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [BRIDGE_ENTRY],
        env: childEnv(),
        stderr: 'pipe',
      })
      const client = new Client({ name: 'dsh-shejing', version: '0.1.0' })
      try {
        await client.connect(transport)
      } catch (error) {
        try {
          await client.close()
        } catch {
          // 连接失败的清理失败没有信息量
        }
        throw new LightroomUnavailable(
          `Lightroom 桥接无法启动（${BRIDGE_ENTRY}）。请先确认 Lightroom Classic 已打开、`
            + '插件已加载（文件 ▸ 增效工具管理器 ▸ Lightroom MCP ▸ Start Server）。',
          error,
        )
      }
      this.#log('[shejing] Lightroom bridge 已连接')
      this.#client = client
      return client
    })()

    try {
      return await this.#connecting
    } finally {
      this.#connecting = null
    }
  }

  /**
   * 调用一个 bridge 工具。返回 MCP 的 CallToolResult（含 content 块）。
   * 失败时断开连接并抛出——**不重试**，因为无法判断副作用是否已经发生。
   */
  async call(name, args = {}) {
    let client
    const wasConnected = this.#client !== null
    try {
      client = await this.#connect()
    } catch (error) {
      this.#drop(`连接失败：${error?.message ?? error}`)
      throw error
    }

    const timeout = CLIENT_TIMEOUT_MS[name] ?? DEFAULT_TIMEOUT_MS
    try {
      return await client.callTool({ name, arguments: args }, undefined, { timeout })
    } catch (error) {
      this.#drop(`${name} 调用失败：${error?.message ?? error}`)
      throw new LightroomUnavailable(
        `调用 ${name} 失败${wasConnected ? '（连接已断开，下次调用会重连）' : ''}：`
          + `${error?.message ?? error}`,
        error,
      )
    }
  }

  /** 把 MCP 的 content 块摊平成文本，图片则给出磁盘路径供 read_image 使用。 */
  static toText(result) {
    const blocks = Array.isArray(result?.content) ? result.content : []
    const parts = []
    for (const block of blocks) {
      if (block === null || typeof block !== 'object') continue
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text)
      } else if (block.type === 'image') {
        // bridge 会把预览写成 JPEG 再读回来；结构化字段里带 file_path。
        const path = result?.structuredContent?.file_path
        parts.push(
          path === undefined
            ? `[图片 ${block.mimeType ?? 'image'}：内容已附着，但未找到 file_path]`
            : `[图片已渲染：${path} —— 用 read_image 查看]`,
        )
      }
    }
    if (parts.length === 0 && result?.structuredContent !== undefined) {
      parts.push(JSON.stringify(result.structuredContent))
    }
    if (parts.length === 0) parts.push('(无输出)')
    return parts.join('\n')
  }
}
