/**
 * 摄鲸的七个阶段工具。
 *
 * 分工（这是设计里反复确认过的一条）：
 *   · **Python 脚本**负责算账——数张数、连拍分组、曝光跨度、感知哈希、contact sheet、
 *     拆分文件夹。这些是纯计算，不需要模型智能，而且已经在真实批次上验证过。
 *   · **本层**负责编排——把参数翻译成 CLI、把结果组织成三段式、把动作接到门禁上。
 *   · **Lightroom 动作**一律走 mcp__lightroom__*，Python 不再直连桥接。
 *
 * 目前只实现了 v1 范围内的阶段；其余阶段工具逐个补齐。
 */

import { readdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { batchDirFor, ensureDir, readManifest, writeManifest } from '../batches.mjs'
import { fingerprintParams } from '../gate/index.mjs'
import { LightroomBridge } from '../lr/bridge.mjs'
import { runScript } from '../python.mjs'
import { appendRule, RULES_FILE } from '../rules.mjs'
import { resolveGrade } from '../styles.mjs'

const PHOTO_EXT = new Set(['.arw', '.cr2', '.cr3', '.nef', '.dng', '.raf', '.orf', '.rw2',
  '.jpg', '.jpeg', '.tif', '.tiff', '.png'])
const RENDERED_EXT = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff'])

const text = (value) => ({
  schema: { type: 'string' },
  render: (_args, v) => [{ type: 'text', text: typeof v === 'string' ? v : String(v) }],
})

/** 把 stdout/stderr 揉成给模型看的输出。 */
function combine(result) {
  const parts = []
  if (result.stdout.trim() !== '') parts.push(result.stdout.trimEnd())
  if (result.stderr.trim() !== '') parts.push(`--- stderr ---\n${result.stderr.trimEnd()}`)
  if (!result.ok) parts.push(`（退出码 ${result.code}）`)
  return parts.join('\n\n')
}

/** 从 batch_id 或 source 定位批次目录，并从账本里取回源文件夹。 */
async function resolveBatch(args) {
  const batchDir = args.batch_id !== undefined && args.batch_id !== ''
    ? batchDirFor('', args.batch_id)
    : batchDirFor(args.source ?? '')
  const manifest = await readManifest(batchDir)
  const source = manifest?.source_path
    ?? (args.source !== undefined && args.source !== '' ? path.resolve(args.source) : null)
  return { batchDir, manifest, source }
}

function listPhotos(dir, { anyExtension = false } = {}) {
  if (dir === null || dir === undefined) return []
  try {
    return readdirSync(dir)
      .filter(name => {
        const ext = path.extname(name).toLowerCase()
        return anyExtension ? RENDERED_EXT.has(ext) : PHOTO_EXT.has(ext)
      })
      .sort()
  } catch {
    return []
  }
}

function countPhotos(dir) {
  return listPhotos(dir).length
}

async function readJsonFile(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

/** 建收藏夹集 / 收藏夹并把可导入目录的照片放进去。失败不抛，只记进 failures。 */
async function setUpCollections(bridge, { keepDir, set, collection, lines, failures }) {
  const added = []
  try {
    if (set !== undefined && set !== '') {
      const created = await bridge.call('create_collection_set', { name: set })
      lines.push('', '--- 收藏夹集 ---', LightroomBridge.toText(created))
    }
    if (collection !== undefined && collection !== '') {
      const created = await bridge.call('create_collection', {
        name: collection,
        ...(set === undefined || set === '' ? {} : { parent: set }),
      })
      lines.push('', '--- 收藏夹 ---', LightroomBridge.toText(created))
      const paths = listPhotos(keepDir).map(name => path.join(keepDir, name))
      if (paths.length > 0) {
        const result = await bridge.call('add_to_collection', {
          collection_name: collection,
          photo_ids: paths,
        })
        lines.push(LightroomBridge.toText(result))
        added.push(`${paths.length} 张 → ${collection}`)
      }
    }
  } catch (error) {
    failures.push(`收藏夹：${error?.message ?? error}`)
  }
  return added.length === 0 ? '（未建）' : added.join('；')
}

export function registerStageTools(ctx, { bridge, log, config, ledger }) {
  const registered = ['shejing_checkup', 'shejing_cull', 'shejing_organize', 'shejing_grade',
    'shejing_verify', 'shejing_archive', 'shejing_retro', 'shejing_batch_status']

  ctx.effect(() => ctx.tools.register({
    name: 'shejing_checkup',
    description:
      '摄鲸·体检（只读，不碰 Lightroom）：扫描源文件夹，做连拍分组、组内清晰度、组内曝光跨度、'
      + '类型判定（连拍/包围曝光/疑似焦点堆栈/全景）、高光与黑场溢出统计，并生成 contact sheet。'
      + '结果写入批次账本。输出的 ①证据/②建议/③等你 三段式必须原样呈报给用户，'
      + '不要自行替他做剔除决定。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['source'],
      properties: {
        source: { type: 'string', description: '源照片文件夹的绝对路径。' },
        batch_id: { type: 'string', description: '批次目录名，默认 <日期>_<文件夹名>。' },
        window: { type: 'number', description: '连拍时间窗口（秒），默认 60。' },
        hash_max: { type: 'integer', description: 'dHash 汉明距离阈值，默认 14。' },
        bracket_ev: { type: 'number', description: '≥ 此曝光跨度判为包围曝光，默认 0.8。' },
        grid: { type: 'integer', description: '焦点堆栈判定的分块数，默认 6。' },
        no_sheet: { type: 'boolean', description: '为 true 时不生成 contact sheet。' },
      },
    },
    timeoutMs: 1_800_000,
    output: text(),
    async execute(args, exec) {
      if (exec?.signal?.aborted) throw new Error('调用已取消')
      const source = path.resolve(args.source)
      const batchDir = batchDirFor(source, args.batch_id)
      await ensureDir(batchDir)

      const cli = [source, '--out', batchDir]
      if (args.window !== undefined) cli.push('--window', String(args.window))
      if (args.hash_max !== undefined) cli.push('--hash-max', String(args.hash_max))
      if (args.bracket_ev !== undefined) cli.push('--bracket-ev', String(args.bracket_ev))
      if (args.grid !== undefined) cli.push('--grid', String(args.grid))
      if (args.no_sheet === true) cli.push('--no-sheet')

      log(`[shejing] 体检 ${source} → ${batchDir}`)
      const result = await runScript('10_checkup.py', cli, {
        timeoutMs: 1_500_000,
        signal: exec?.signal,
      })

      const manifest = await readManifest(batchDir)
      if (manifest !== null) {
        manifest.batch = { id: path.basename(batchDir), source, ...(manifest.batch ?? {}) }
        await writeManifest(batchDir, manifest)
      }

      const sheet = path.join(batchDir, 'contact_sheet.jpg')
      const footer = [
        '',
        `批次目录：${batchDir}`,
        `contact sheet：${sheet}（请用 read_image 打开它，并连同下面的证据一起给用户看）`,
        result.ok ? '' : '⚠️ 脚本非零退出，上面的证据可能不完整。',
      ].filter(line => line !== '').join('\n')

      return `${combine(result)}\n${footer}`
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'shejing_batch_status',
    description: '读取某个批次的账本（manifest.json），返回各阶段的进行状态与已记录的决定。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        source: { type: 'string', description: '源照片文件夹路径（与 batch_id 二选一）。' },
        batch_id: { type: 'string', description: '批次目录名。' },
      },
    },
    output: text(),
    async execute(args) {
      const batchDir = args.batch_id !== undefined
        ? batchDirFor('', args.batch_id)
        : batchDirFor(args.source ?? '')
      const manifest = await readManifest(batchDir)
      if (manifest === null) return `没有找到批次账本：${batchDir}`
      return `批次目录：${batchDir}\n\n${JSON.stringify(manifest, null, 1)}`
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'shejing_cull',
    description:
      '摄鲸·剔除：把源文件夹里的照片**移动**到 `可导入/` 与 `非导入/`（同盘 rename，瞬时且可逆，'
      + '原件永不删除）。默认只预演，必须带 confirm:true 才真移动——而带 confirm 的调用会被'
      + '门禁拦下来问用户一次。\n'
      + '调用前必须先把体检报告逐组呈报给用户（①证据/②建议/③等你），拿到他的判断再调本工具。'
      + '包围曝光与疑似焦点堆栈**一律不要放进 reject**。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        batch_id: { type: 'string', description: '批次目录名。' },
        source: { type: 'string', description: '源照片文件夹（与 batch_id 二选一）。' },
        reject: {
          type: 'array',
          items: { type: 'string' },
          description: '要剔除的文件名（不含路径）。其余全部进 可导入/。',
        },
        confirm: { type: 'boolean', description: 'true 才真的移动；默认 false 只预演。' },
      },
    },
    timeoutMs: 300_000,
    output: text(),
    async execute(args, exec) {
      if (exec?.signal?.aborted) throw new Error('调用已取消')
      const { batchDir, source } = await resolveBatch(args)
      if (source === null) return `无法确定源文件夹：${batchDir}`

      const cli = [source, '--manifest', path.join(batchDir, 'manifest.json')]
      for (const name of args.reject ?? []) cli.push('--reject', name)
      if (args.confirm === true) cli.push('--confirm')

      log(`[shejing] 剔除 ${source}（${(args.reject ?? []).length} 张，confirm=${args.confirm === true}）`)
      const result = await runScript('20_split.py', cli, { timeoutMs: 240_000, signal: exec?.signal })
      return combine(result)
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'shejing_grade',
    description:
      '摄鲸·调色：按内置风格或显式参数给照片调色，并**逐张**建快照 → 写滑杆与曲线 → 渲染预览。\n'
      + '铁律：任何新参数组合必须先只传 1 张，把渲染图给用户看过并获得认可，才能批量。'
      + '批量调用会被门禁拦下来问用户一次（不可用参数绕过），用户同意后这一套参数进白名单，'
      + '以后同样的参数不再拦。\n'
      + '内置风格：A=暖调电影感（城市/建筑）· B=清透日系（云彩天空/正午）· C=浓郁黄昏（落日/剪影）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['photo_ids'],
      properties: {
        photo_ids: {
          type: 'array', items: { type: 'string' },
          description: '照片标识：数字目录 id、文件名或绝对路径均可。只传 1 个即「单张先行」。',
        },
        style: { type: 'string', enum: ['A', 'B', 'C'], description: '内置风格。' },
        settings: {
          type: 'object',
          description: '显式滑杆参数，覆盖风格同名项（Lightroom 原生单位；不要写 ProcessVersion）。',
        },
        curves: {
          type: 'object',
          description: '每通道点曲线，如 {"main":[[40,33],[128,132]]}。首点会被安全归零（gotcha #24）。',
        },
        snapshot: { type: 'string', description: '快照名，默认「摄鲸·<风格>」。' },
        preview_size: { type: 'string', enum: ['small', 'medium', 'large'], description: '预览尺寸，默认 large。' },
      },
    },
    timeoutMs: 900_000,
    output: text(),
    async execute(args, exec) {
      if (exec?.signal?.aborted) throw new Error('调用已取消')
      const resolved = resolveGrade(args)
      const ids = args.photo_ids
      const single = ids.length === 1
      const fingerprint = fingerprintParams('shejing_grade', resolved.params)
      const snapshotName = args.snapshot ?? `摄鲸·${resolved.label}`
      const size = args.preview_size ?? 'large'

      const lines = ['① 证据']
      lines.push(`  照片 ${ids.length} 张${single ? '（单张先行，不受门禁约束）' : ''}`)
      lines.push(`  参数：${resolved.summary}`)
      lines.push(`  参数指纹：${fingerprint}${await ledger.isApproved(fingerprint) ? '（已在白名单）' : ''}`)
      if (resolved.notes.length > 0) {
        lines.push('  参数修正：')
        for (const note of resolved.notes) lines.push(`    · ${note}`)
      }

      const previews = []
      const failures = []
      for (const id of ids) {
        if (exec?.signal?.aborted) throw new Error('调用已取消')
        try {
          // 每个动作前先建检查点：不满意可以回到起点，而不是靠记忆重调。
          await bridge.call('create_snapshot', { photo_id: id, name: snapshotName })
          if (Object.keys(resolved.settings).length > 0) {
            await bridge.call('set_develop_settings', { photo_id: id, settings: resolved.settings })
          }
          for (const [channel, points] of Object.entries(resolved.curves)) {
            await bridge.call('set_tone_curve', { photo_id: id, channel, points })
          }
          const preview = await bridge.call('get_photo_preview', { photo_id: id, size })
          previews.push({ id, path: preview?.structuredContent?.file_path ?? null, raw: LightroomBridge.toText(preview) })
        } catch (error) {
          failures.push(`${id}：${error?.message ?? error}`)
        }
      }

      lines.push(`  已写入并渲染 ${previews.length} 张${failures.length === 0 ? '' : `，失败 ${failures.length} 张`}`)

      if (single && previews.length === 1 && previews[0].path !== null) {
        // 记下「这一套参数已经单张渲染过」——门禁的理由里要能说出这件事。
        await ledger.markRendered(fingerprint, {
          photoId: ids[0], previewPath: previews[0].path, size, label: resolved.label,
        })
      }

      lines.push('', '② 建议')
      if (single) {
        lines.push('  这是单张先行。请把渲染图交给用户看，他认可后再对这批照片批量调用本工具。')
      } else {
        lines.push('  批量已执行。若某几张不满意，用 create_snapshot 的名字回滚，或对该张重新调参。')
      }

      lines.push('', '③ 预览图（请用 read_image 打开并给用户看）')
      for (const p of previews) {
        lines.push(`  ${p.id} → ${p.path ?? '（未返回 file_path）'}`)
      }
      if (failures.length > 0) {
        lines.push('', '⚠️ 失败：')
        for (const f of failures) lines.push(`  ${f}`)
      }
      return lines.join('\n')
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'shejing_organize',
    description:
      '摄鲸·整理：把 `可导入/` 里的照片统一重命名（不可逆，默认只预演）、**原地**导入 Lightroom'
      + '（只传 source_path，不复制原片）、并按需建收藏夹集与收藏夹。\n'
      + '重命名带 rename_confirm:true 的调用会被门禁拦下问用户一次。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        batch_id: { type: 'string' },
        source: { type: 'string' },
        rename: { type: 'boolean', description: 'true = 处理重命名；默认 false 完全不碰文件名。' },
        rename_confirm: { type: 'boolean', description: 'true 才真的改名；不带则只预演。' },
        template: { type: 'string', description: '命名模板，默认 {date}_{name}。' },
        import: { type: 'boolean', description: 'true = 原地导入 Lightroom。' },
        collection_set: { type: 'string', description: '收藏夹集名称。' },
        collection: { type: 'string', description: '收藏夹名称。' },
      },
    },
    timeoutMs: 900_000,
    output: text(),
    async execute(args, exec) {
      if (exec?.signal?.aborted) throw new Error('调用已取消')
      const { batchDir, manifest, source } = await resolveBatch(args)
      const keepDir = manifest?.stages?.cull?.keep_dir ?? source
      if (keepDir === null) return `无法确定可导入目录：${batchDir}`

      const lines = ['① 证据', `  可导入目录：${keepDir}`]
      const failures = []

      if (args.rename === true) {
        const cli = [keepDir, '--template', args.template ?? '{date}_{name}']
        if (args.rename_confirm === true) cli.push('--confirm')
        log(`[shejing] 重命名 ${keepDir}（confirm=${args.rename_confirm === true}）`)
        const result = await runScript('25_rename.py', cli, { timeoutMs: 300_000, signal: exec?.signal })
        lines.push('', '--- 重命名 ---', combine(result))
        if (!result.ok) failures.push('重命名非零退出')
      } else {
        lines.push('  （未处理重命名）')
      }

      let imported = 0
      if (args.import === true) {
        // 只传 source_path：bridge 的 import_photos 不传 copy_to 才是原地引用。
        // （顺带记一笔：上游的 copy_to 参数在 HandlerImport.lua 里根本没实现。）
        const result = await bridge.call('import_photos', {
          source_path: keepDir,
          ...(args.collection === undefined ? {} : { collection_name: args.collection }),
        })
        lines.push('', '--- 导入 ---', LightroomBridge.toText(result))
        imported = countPhotos(keepDir)
      } else {
        lines.push('  （未导入）')
      }

      if (args.collection_set !== undefined || args.collection !== undefined) {
        const added = await setUpCollections(bridge, {
          keepDir, set: args.collection_set, collection: args.collection, lines, failures,
        })
        lines.push(`  收藏夹：${added}`)
      }

      const manifestFile = path.join(batchDir, 'manifest.json')
      const next = manifest ?? {}
      const stages = { ...(next.stages ?? {}) }
      stages.ingest = {
        status: 'done',
        at: new Date().toISOString().replace('T', ' ').slice(0, 19),
        keep_dir: keepDir,
        renamed: args.rename === true && args.rename_confirm === true,
        imported: args.import === true,
        photo_count: imported,
        collection_set: args.collection_set ?? null,
        collection: args.collection ?? null,
      }
      await writeManifest(batchDir, { ...next, stages, updated: stages.ingest.at })
      lines.push('', `  账本：${manifestFile}`)

      lines.push('', '② 建议')
      lines.push(args.import === true
        ? '  导入完成后先跑 shejing_verify 交叉核对，再进入调色。'
        : '  确认重命名结果后，用 import:true 做原地导入。')

      if (failures.length > 0) {
        lines.push('', '⚠️ 失败：')
        for (const f of failures) lines.push(`  ${f}`)
      }
      return lines.join('\n')
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'shejing_verify',
    description:
      '摄鲸·验收：抽样渲染 ≤10 张（带当前编辑的 JPEG）+ 目录数据库交叉核对（星级/色标/'
      + '关键词/收藏夹归属）。用来戳穿「工具返回 ok 但其实没生效」——你文档里明确写着'
      + '`ok`/`success` 可能是假的，关键改动一律要独立复核。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        batch_id: { type: 'string' },
        source: { type: 'string' },
        sample: { type: 'integer', description: '抽样张数，默认 5，上限 10。' },
        check_develop: { type: 'boolean', description: '是否对抽样照片读回调色参数，默认 true。' },
      },
    },
    timeoutMs: 900_000,
    output: text(),
    async execute(args, exec) {
      if (exec?.signal?.aborted) throw new Error('调用已取消')
      const { batchDir, manifest, source } = await resolveBatch(args)
      const keepDir = manifest?.stages?.cull?.keep_dir ?? source
      if (keepDir === null) return `无法确定可导入目录：${batchDir}`

      const result = await runScript('35_verify.py', [batchDir], { timeoutMs: 300_000, signal: exec?.signal })
      const lines = ['① 证据（目录数据库交叉核对）', combine(result)]

      const files = listPhotos(keepDir)
      const want = Math.min(Math.max(args.sample ?? 5, 1), 10)
      const step = Math.max(1, Math.floor(files.length / want))
      const sample = files.filter((_, index) => index % step === 0).slice(0, want)

      lines.push('', `  抽样渲染 ${sample.length} 张（共 ${files.length} 张）`)
      const previews = []
      const develops = []
      for (const name of sample) {
        if (exec?.signal?.aborted) throw new Error('调用已取消')
        const full = path.join(keepDir, name)
        try {
          const preview = await bridge.call('get_photo_preview', { photo_id: full, size: 'medium' })
          previews.push({ name, path: preview?.structuredContent?.file_path ?? null })
          if (args.check_develop !== false) {
            const settings = await bridge.call('get_develop_settings', { photo_id: full, fields: 'basic' })
            develops.push({ name, text: LightroomBridge.toText(settings).slice(0, 400) })
          }
        } catch (error) {
          previews.push({ name, path: null, error: String(error?.message ?? error) })
        }
      }

      const stages = { ...(manifest?.stages ?? {}) }
      stages.review = {
        status: 'done',
        at: new Date().toISOString().replace('T', ' ').slice(0, 19),
        sampled: sample,
        previews: previews.map(p => p.path).filter(Boolean),
      }
      await writeManifest(batchDir, { ...(manifest ?? {}), stages, updated: stages.review.at })

      lines.push('', '② 调色读回（Lightroom API，权威）')
      if (develops.length === 0) {
        lines.push('  （未读回）')
      } else {
        for (const d of develops) lines.push(`  · ${d.name}：${d.text.replace(/\s+/g, ' ').slice(0, 200)}`)
      }

      lines.push('', '③ 预览图（请用 read_image 打开并抽查）')
      for (const p of previews) {
        lines.push(p.error === undefined
          ? `  ${p.name} → ${p.path ?? '（未返回 file_path）'}`
          : `  ${p.name} → 失败：${p.error}`)
      }
      return lines.join('\n')
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'shejing_archive',
    description:
      '摄鲸·归档：先出精选计划（星级 ≥ 阈值），把清单交给用户增删；带 confirm:true（会被门禁'
      + '拦下问你一次）才真的通过 mcp__lightroom__export_photos 导出，并生成批次总结 SUMMARY.md。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        batch_id: { type: 'string' },
        source: { type: 'string' },
        threshold: { type: 'number', description: '星级阈值，默认 4。' },
        picks: { type: 'array', items: { type: 'string' }, description: '用户增删后的最终名单（覆盖星级筛选）。' },
        exclude: { type: 'array', items: { type: 'string' }, description: '要从候选里去掉的文件名。' },
        confirm: { type: 'boolean', description: 'true 才真的导出。' },
      },
    },
    timeoutMs: 1_800_000,
    output: text(),
    async execute(args, exec) {
      if (exec?.signal?.aborted) throw new Error('调用已取消')
      const { batchDir, manifest } = await resolveBatch(args)

      const cli = [batchDir]
      if (args.threshold !== undefined) cli.push('--threshold', String(args.threshold))
      if (Array.isArray(args.picks) && args.picks.length > 0) cli.push('--photos', ...args.picks)

      let excludeFrom
      if (Array.isArray(args.exclude) && args.exclude.length > 0) {
        excludeFrom = path.join(batchDir, 'archive-exclude.json')
        await ensureDir(batchDir)
        await writeFile(excludeFrom, JSON.stringify(args.exclude), 'utf8')
        cli.push('--exclude-from', excludeFrom)
      }

      const planned = await runScript('30_export.py', cli, { timeoutMs: 300_000, signal: exec?.signal })
      const lines = ['① 证据', combine(planned)]

      const plan = await readJsonFile(path.join(batchDir, 'export-plan.json'))
      if (plan === null || !Array.isArray(plan.picked) || plan.picked.length === 0) {
        lines.push('', '没有候选可导出——先确认星级，或用 picks 点名。')
        return lines.join('\n')
      }

      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 13)
      const dest = path.join(batchDir, `精选_${stamp}`)
      lines.push('', '② 建议', `  导出 ${plan.picked.length} 张 → ${dest}`)

      if (args.confirm !== true) {
        lines.push('', '③ 等你', '  把上面的清单交给用户增删；他确认后带 confirm:true 重调本工具。')
        return lines.join('\n')
      }

      await ensureDir(dest)
      const exported = await bridge.call('export_photos', {
        photo_ids: plan.absolute_paths,
        destination: dest,
        format: plan.export?.format ?? 'jpeg',
        quality: plan.export?.quality ?? 100,
        on_existing: plan.export?.on_existing ?? 'overwrite',
      }, {})
      lines.push('', '--- 导出 ---', LightroomBridge.toText(exported))

      const actual = listPhotos(dest, { anyExtension: true }).length
      const at = new Date().toISOString().replace('T', ' ').slice(0, 19)
      const stages = { ...(manifest?.stages ?? {}) }
      stages.archive = {
        status: 'done', at,
        export_dir: dest, export_count: actual,
        threshold: plan.threshold, selected: plan.picked,
      }
      await writeManifest(batchDir, { ...(manifest ?? {}), stages, updated: at })

      const summary = await runScript('40_summary.py', [batchDir], { timeoutMs: 120_000, signal: exec?.signal })
      lines.push('', '--- 批次总结 ---', combine(summary))
      lines.push('', `  目标目录实际文件数：${actual}（与计划数 ${plan.picked.length} ${actual === plan.picked.length ? '一致' : '**不一致，请复核**'}）`)
      return lines.join('\n')
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'shejing_retro',
    description:
      '摄鲸·复盘：把本批的教训追加进拍摄前规则。**经用户确认才写入**（confirm:true 会被门禁'
      + '拦下问你一次）。规则文件只追加、永不删除——被否掉的规则也留着，防止同一个错犯第二次。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'body'],
      properties: {
        title: { type: 'string', description: '规则标题，一句话。' },
        body: { type: 'string', description: '规则正文：下次具体该怎么做。' },
        evidence: { type: 'string', description: '依据：这次是哪张照片、哪个现象让你得出这条。' },
        batch_id: { type: 'string' },
        source: { type: 'string' },
        confirm: { type: 'boolean', description: 'true 才真的写入规则文件。' },
      },
    },
    timeoutMs: 60_000,
    output: text(),
    async execute(args) {
      const { batchDir, manifest } = await resolveBatch(args)
      const lines = [
        '① 证据',
        `  拟追加规则：${args.title}`,
        `  正文：${args.body}`,
        args.evidence === undefined ? '' : `  依据：${args.evidence}`,
        `  目标文件：${RULES_FILE}`,
      ].filter(Boolean)

      if (args.confirm !== true) {
        lines.push('', '② 建议', '  这条规则会永久写进拍摄前规则（只追加，不删除）。')
        lines.push('', '③ 等你', '  用户确认后带 confirm:true 重调本工具。')
        return lines.join('\n')
      }

      const written = await appendRule({
        title: args.title, body: args.body, evidence: args.evidence, batchId: path.basename(batchDir),
      })

      const next = { ...(manifest ?? {}) }
      const lessons = Array.isArray(next.shooting_lessons) ? [...next.shooting_lessons] : []
      lessons.push({ title: args.title, body: args.body, evidence: args.evidence ?? null, at: written.state?.seededAt ?? null })
      const decisions = Array.isArray(next.decisions) ? [...next.decisions] : []
      decisions.push(`复盘：追加规则「${args.title}」`)

      const stages = { ...(next.stages ?? {}) }
      stages.retro = { status: 'done', at: new Date().toISOString().replace('T', ' ').slice(0, 19), rules: written.bytes }
      await writeManifest(batchDir, { ...next, shooting_lessons: lessons, decisions, stages, updated: stages.retro.at })

      lines.push('', '② 已写入', `  ${written.file}（规则文件现在 ${written.bytes} 字符）`)
      if (written.state?.status === 'diverged') lines.push(`  ⚠️ ${written.state.note}`)

      const summary = await runScript('40_summary.py', [batchDir], { timeoutMs: 60_000 })
      lines.push('', '  批次总结已刷新：' + (summary.ok ? '成功' : '失败'))
      return lines.join('\n')
    },
  }))

  // 七个阶段（体检/剔除/整理/调色/验收/归档/复盘）已全部就位。
  return registered
}
