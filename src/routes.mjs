/**
 * 宿主⇄面板的数据通道。
 *
 * 为什么用 `ctx.connection.fetch.register` 而不是 `ctx.webServer.register`：
 *   - `connection.fetch` 是**传输无关**的，网页端与桌面端（Electron）都通；
 *   - `webServer` 是网页端专属，桌面 composition 里根本不存在，用它注册的路由
 *     在桌面客户端里是死代码。
 * 路径必须是 `/api/<段>`，且每段只允许 `[A-Za-z0-9_$.-]`；精确匹配，无通配。
 *
 * 面板与工具共享同一份账本与同一个桥接实例，所以面板看到的状态就是工具看到的。
 */

import path from 'node:path'
import process from 'node:process'

import { batchesRoot, listBatches, readManifest } from './batches.mjs'
import { BRIDGE_ENTRY } from './lr/bridge.mjs'
import { installedLrpluginDir, SHEJING_HOME } from './lr/install.mjs'

/** 插件版本。读包自己的 package.json，避免和发布版本漂移。 */
function pluginVersion() {
  try {
    return process.env.npm_package_version ?? '0.1.0'
  } catch {
    return '0.1.0'
  }
}

export const PROBE_PATH = '/api/shejing/probe'
export const BATCHES_PATH = '/api/shejing/batches'
export const BATCH_PATH = '/api/shejing/batch'

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

/**
 * 把一个批次的账本整理成面板要的形状。
 * 面板不该自己解析 manifest 的各种版本差异，所以这一步放在宿主半边。
 */
function batchSummary(manifest) {
  const stages = manifest?.stages ?? {}
  const checkup = stages.checkup ?? {}
  const groups = Array.isArray(checkup.groups) ? checkup.groups : []
  const frames = checkup.frames ?? {}
  const cacheDir = typeof checkup.cache_dir === 'string' ? checkup.cache_dir : null

  return {
    batchId: manifest?.batch_id ?? null,
    source: manifest?.source_path ?? null,
    photoCount: manifest?.photo_count ?? null,
    camera: manifest?.camera ?? [],
    updated: manifest?.updated ?? null,
    stages: Object.keys(stages),
    cacheDir,
    contactSheet: typeof checkup.contact_sheet === 'string' ? checkup.contact_sheet : null,
    groups: groups.map(group => ({
      count: group.count,
      kind: group.kind,
      reliable: group.reliable !== false,
      spanSeconds: group.span_s ?? null,
      evSpread: group.ev_spread ?? null,
      keep: group.keep ?? null,
      frames: (group.frames ?? []).map(frame => {
        const meta = frames[frame.name] ?? {}
        return {
          name: frame.name,
          time: frame.time ?? meta.time ?? null,
          sharp: frame.sharp ?? meta.sharp ?? null,
          ev: frame.ev ?? meta.ev ?? null,
          small: typeof meta.small === 'string' ? meta.small : null,
        }
      }),
    })),
    highlightClipped: Array.isArray(checkup.highlight_clipped) ? checkup.highlight_clipped : [],
    sharpnessOutliers: Array.isArray(checkup.sharpness_outliers) ? checkup.sharpness_outliers : [],
    cull: stages.cull ?? null,
    archive: stages.archive ?? null,
    decisions: Array.isArray(manifest?.decisions) ? manifest.decisions : [],
    shootingLessons: Array.isArray(manifest?.shooting_lessons) ? manifest.shooting_lessons : [],
  }
}

/** 组装探针面板要的全部状态。任何一步失败都不该让整页挂掉。 */
async function probePayload({ bridge, lrToolCount }) {
  let batches = []
  try {
    const listed = await listBatches()
    batches = await Promise.all(listed.slice(0, 30).map(async (entry) => {
      const manifest = await readManifest(entry.dir)
      return {
        id: entry.id,
        photoCount: manifest?.photo_count ?? null,
        updated: manifest?.updated ?? null,
        contactSheet: Boolean(manifest?.stages?.checkup?.contact_sheet),
        stages: Object.keys(manifest?.stages ?? {}),
      }
    }))
  } catch {
    batches = []
  }

  return {
    ok: true,
    now: new Date().toISOString(),
    plugin: { name: 'dsh-shejing', version: pluginVersion() },
    dshHome: process.env.DSH_HOME ?? null,
    shejingHome: SHEJING_HOME,
    lrplugin: installedLrpluginDir(),
    bridge: { entry: BRIDGE_ENTRY, connected: bridge.connected },
    lrToolCount,
    batches,
  }
}

/**
 * 注册 /api/shejing/* 路由。调用方须已确认 `ctx.connection` 可用。
 * @returns 已注册的路径列表
 */
export function registerRoutes(ctx, { bridge, lrToolCount, log = () => {} }) {
  const paths = []

  ctx.effect(() => ctx.connection.fetch.register({
    path: PROBE_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch() {
      try {
        return json(await probePayload({ bridge, lrToolCount }))
      } catch (error) {
        log(`[shejing] 探针路由出错：${error?.message ?? error}`)
        return json({ ok: false, error: String(error?.message ?? error) }, 500)
      }
    },
  }))
  paths.push(PROBE_PATH)

  // 批次清单：面板左侧列表。
  ctx.effect(() => ctx.connection.fetch.register({
    path: BATCHES_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch() {
      const listed = await listBatches()
      const batches = await Promise.all(listed.map(async (entry) => {
        const manifest = await readManifest(entry.dir)
        const stages = manifest?.stages ?? {}
        return {
          id: entry.id,
          dir: entry.dir,
          source: manifest?.source_path ?? null,
          photoCount: manifest?.photo_count ?? null,
          updated: manifest?.updated ?? null,
          stages: Object.keys(stages),
          kept: stages.cull?.kept ?? null,
          exported: stages.archive?.export_count ?? null,
        }
      }))
      return json({ ok: true, root: batchesRoot(), batches })
    },
  }))
  paths.push(BATCHES_PATH)

  // 单个批次详情：剔除审阅与精选清单都吃这一份。
  ctx.effect(() => ctx.connection.fetch.register({
    path: BATCH_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch(request) {
      const id = new URL(request.url).searchParams.get('id')
      if (id === null || id === '') return json({ ok: false, error: '缺少 id 参数' }, 400)
      // 只接受批次根目录下的目录名，不接受任意路径。
      if (id.includes('/') || id.includes('\\') || id.startsWith('.')) {
        return json({ ok: false, error: '非法批次 id' }, 400)
      }
      const manifest = await readManifest(path.join(batchesRoot(), id))
      if (manifest === null) return json({ ok: false, error: `找不到批次 ${id}` }, 404)
      return json({ ok: true, batch: batchSummary(manifest) })
    },
  }))
  paths.push(BATCH_PATH)

  return paths
}
