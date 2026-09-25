/**
 * dsh-shejing — 摄鲸：从拍摄到整理到后期的完整照片工作流，作为 DSH 插件运行。
 *
 * 宿主半边负责四件事：
 *   1. 把 SKILL.md 作为运行时技能注册给 DSH（不写 ~/.dsh/skills）
 *   2. 校验/同步 Lightroom 内的 .lrplugin（内容比对 + 备份，永不静默沿用旧版）
 *   3. 拉起自带的 Lightroom 桥接（MCP over stdio），把 56 个工具注册成
 *      mcp__lightroom__*，并在工具边界上收口门禁
 *   4. 注册摄鲸自己的七个阶段工具，以及给客户端面板用的 /api/shejing/* 路由
 *
 * 设计取舍与理由见 docs/DESIGN.md。
 */

import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { homedir } from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { LightroomBridge, BRIDGE_ENTRY } from './lr/bridge.mjs'
import { registerLightroomTools, LIGHTROOM_TOOL_PREFIX } from './lr/tools.mjs'
import { BUNDLED_LRPLUGIN, SHEJING_HOME, installedLrpluginDir, recordLrpluginSync, syncLrplugin } from './lr/install.mjs'
import { registerSkill } from './skill.mjs'
import { registerStageTools } from './stages/index.mjs'
import { registerGate } from './gate/index.mjs'
import { registerRoutes } from './routes.mjs'

/** Cordis 插件名，同时是 cordis.patch.yml 里那一行引用的包名。 */
export const name = 'shejing'

/** tools 与 skills 必须有；connection / systemPrompt 用可选注入。 */
export const inject = ['tools', 'skills']

const TOKEN_FILE = path.join(homedir(), '.config', 'lightroom-mcp', 'token')
const REQUEST_PORT = 58763

/** 端口是否在监听（Lightroom 里的 Lua 插件在监听这两个端口）。 */
function portListening(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const done = (value) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

export function apply(ctx, config = {}) {
  const log = (message) => ctx.logger?.info?.(message)

  const bridge = new LightroomBridge({ log })

  ctx.effect(() => registerSkill(ctx))

  // 门禁先建：它持有白名单与「单张已渲染」证据，阶段工具要用同一本账。
  const ledger = registerGate(ctx, { log })

  let lrTools = []
  ctx.effect(() => {
    lrTools = registerLightroomTools(ctx, bridge)
    return () => {
      void bridge.close()
    }
  })

  const stageTools = registerStageTools(ctx, { bridge, log, config, ledger })
  log(`[shejing] 已加载：${lrTools.length} 个 Lightroom 工具 + ${stageTools.length} 个阶段工具，技能 shejing 已注册`)

  // 激活标记：DSH 的 logger 不一定落到 stdout，写一份运行记录既给 doctor 用，
  // 也让「插件到底有没有被加载」有一个可验证的物证。
  ctx.effect(() => {
    void (async () => {
      try {
        await mkdir(SHEJING_HOME, { recursive: true })
        await writeFile(
          path.join(SHEJING_HOME, 'instance.json'),
          `${JSON.stringify({
            at: new Date().toISOString(),
            pid: process.pid,
            dshHome: process.env.DSH_HOME ?? null,
            pluginVersion: '0.1.0',
            lrTools: lrTools.map(t => t.tool),
            stageTools,
          }, null, 2)}\n`,
          'utf8',
        )
      } catch (error) {
        log(`[shejing] 写激活标记失败：${error?.message ?? error}`)
      }
    })()
  })

  // .lrplugin 同步：开机做一次内容比对。非阻塞，失败只记录不阻断激活。
  const syncState = { status: 'pending', message: '尚未同步', at: null }
  ctx.effect(() => {
    let cancelled = false
    void (async () => {
      try {
        const report = await syncLrplugin({ log })
        if (cancelled) return
        Object.assign(syncState, report, { at: new Date().toISOString() })
        if (report.status !== 'current') log(`[shejing] ${report.message}`)
        await recordLrpluginSync(report)
      } catch (error) {
        if (cancelled) return
        syncState.status = 'failed'
        syncState.message = `同步 .lrplugin 失败：${error?.message ?? error}`
        log(`[shejing] ${syncState.message}`)
      }
    })()
    return () => {
      cancelled = true
    }
  })

  ctx.effect(() => ctx.tools.register({
    name: 'shejing_doctor',
    description:
      '摄鲸自检：报告插件版本、内置 Lightroom 桥接与 .lrplugin 的状态、token 与端口是否就绪。'
      + '在跑任何摄鲸阶段之前，或遇到「连不上 Lightroom」时先调用它。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    timeoutMs: 30_000,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      const listening = await portListening(REQUEST_PORT)
      const lines = [
        '摄鲸自检',
        '',
        `· 运行环境：node ${process.version}（来自 DSH 自带运行时）`,
        `· 桥接入口：${BRIDGE_ENTRY} ${existsSync(BRIDGE_ENTRY) ? '✓' : '✗ 缺失'}`,
        `· 内置 .lrplugin：${BUNDLED_LRPLUGIN} ${existsSync(path.join(BUNDLED_LRPLUGIN, 'Info.lua')) ? '✓' : '✗ 缺失'}`,
        `· 已安装到：${installedLrpluginDir()}`,
        `· Lua 同步：${syncState.status} — ${syncState.message}`,
        `· 授权 token：${TOKEN_FILE} ${existsSync(TOKEN_FILE) ? '✓' : '✗ 未生成（请在 Lightroom 里 Start Server）'}`,
        `· 端口 ${REQUEST_PORT}：${listening ? '✓ 在监听' : '✗ 未监听（Lightroom 未打开，或插件未 Start Server）'}`,
        `· 桥接连接：${bridge.connected ? '✓ 已连接' : '（尚未连接，首次调用 LR 工具时惰性建立）'}`,
        `· 私有目录：${SHEJING_HOME}`,
        '',
        `LR 工具前缀：${LIGHTROOM_TOOL_PREFIX}（共 56 个）`,
      ]
      return lines.join('\n')
    },
  }))

  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.effect(() => promptCtx.systemPrompt.section({
      name: 'shejing',
      order: 200,
      text:
        '摄鲸（shejing）是一套照片工作流插件：体检 → 剔除 → 整理 → 调色 → 验收 → 归档 → 复盘。'
        + '碰 Lightroom 的动作一律通过 mcp__lightroom__* 工具完成；'
        + '任何新参数组合首次应用前，必须先在一张照片上渲染给你看过再批量。',
    }))
  })

  ctx.inject(['connection'], (connectionCtx) => {
    // 客户端面板的数据通道；面板与工具共享同一份账本与同一个桥接实例。
    const routes = registerRoutes(connectionCtx, { bridge, lrToolCount: lrTools.length, log })
    log(`[shejing] 面板路由已注册：${routes.join('、')}`)
  })
}
