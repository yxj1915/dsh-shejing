/**
 * 门禁引擎。
 *
 * 这是整个插件的核心，不是附加功能。它存在的理由是一次真实事故：25 张照片
 * 被套上了一个没做过单张验证的曲线参数，整批染成紫红色，诊断回滚花了十几轮。
 *
 * 规则（源自用户拍的板）：
 *   · **单张先行**：任何新参数组合，先应用到 1 张、渲染、用户看过，才允许批量。
 *   · **不可越权**：没有 force 旁路。已经验证过的参数组合进白名单，第二套同样的
 *     参数不再拦——所以正常效率不受影响。
 *   · **面板不能是后门**：客户端面板触发的动作也走这里，不允许绕过。
 *
 * 为什么落在 `tools/pre-execute` 上：
 *   返回 `{kind:'ask'}` 会被 DSH **原生路由给用户**，用户拒绝时注册表自己 deny。
 *   模型无法伪造这个答复，所以它比「让模型去调 ask_user_question 再回来」硬得多。
 *
 * 判定粒度刻意如此：
 *   · 只拦**批量**（照片数 ≥ 2）。单张调用正是「先行」那一步本身，不该被拦。
 *   · 只拦会写**调色参数**的工具。评分/色标/旗标这类可逆标记不属于参数门禁，
 *     它们由标记/移动门禁管，规则不同。
 *   · 指纹只算**参数**，不含照片 id——所以「同一套参数第二次不再拦」成立。
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { SHEJING_HOME } from '../lr/install.mjs'
import { LIGHTROOM_TOOL_PREFIX } from '../lr/tools.mjs'
import { resolveGrade } from '../styles.mjs'

/** 会写入调色参数、且应当受「新参数门禁」管辖的 bridge 工具。 */
const PARAM_GATED_TOOLS = new Set([
  'set_develop_settings',
  'set_tone_curve',
  'set_white_balance',
  'apply_develop_preset',
  'copy_develop_settings',
  'apply_auto',
  'set_noise_reduction',
  'ai_denoise',
  // 这两个是**一次调用就批量**写调色参数的，漏掉它们等于留了一条一次成型的旁路：
  // add_ai_mask {photo_ids:[25 张], adjustments:{...}} 一次就给 25 张加上遮罩与参数。
  'add_ai_mask',
  'add_range_mask',
])

/** 这些工具写的是可逆标记，不属于参数门禁。留着明示边界。 */
export const MARKING_TOOLS = new Set([
  'set_rating',
  'set_color_label',
  'set_flags',
  'set_keywords',
  'batch_metadata',
  'create_collection',
  'add_to_collection',
])

/** 目录数据库级别的不可逆操作，永远需要显式确认。 */
export const IRREVERSIBLE_TOOLS = new Set(['remove_from_catalog'])

export function approvedParamsFile() {
  return path.join(SHEJING_HOME, 'gates', 'approved-params.json')
}

/**
 * 照片身份字段。
 *
 * 指纹要**剥掉**它们，门禁跟踪要**用**它们。两份名单必须一致——只剥
 * `photo_id`/`photo_ids` 是不够的：`copy_develop_settings` 用的是
 * `source_id`/`target_ids`，漏掉它们会让同一套参数因目标集合不同而得到不同指纹，
 * 白名单永远命中不了。
 */
const PHOTO_ID_FIELDS = ['photo_id', 'photo_ids', 'source_id', 'target_ids']

/** 稳定序列化：键排序，保证同一套参数永远得到同一个指纹。 */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
}

/** 参数指纹：只取参数，不含照片身份，也不含工具名以外的上下文。 */
export function fingerprintParams(rawTool, args) {
  const params = { ...(args ?? {}) }
  for (const field of PHOTO_ID_FIELDS) delete params[field]
  return createHash('sha256').update(`${rawTool}\u0000${canonical(params)}`).digest('hex').slice(0, 16)
}

/**
 * 从参数里取出被作用的照片身份（去重后的字符串数组）。
 *
 * **这里原来是错的，而且是这个插件最严重的一个漏洞。** 原先按「这一次调用带了几张」
 * 计数（`affectedPhotoCount`），遇到 `photo_id`（单数）一律算 1 张，于是
 * `set_develop_settings` 与 `set_tone_curve`——两个真正写调色参数的工具——**永远
 * 绕开门禁**：模型只要逐张调用，就能把一套没做过单张验证的参数刷满整批。那正是
 * 紫色事故的形态（25 张染紫），而门禁本该防的就是它。
 *
 * 漏掉的不止它们：`copy_develop_settings` 的照片在 `target_ids` 里，原实现连数
 * 都数不出来（返回 0）。八个受管工具里只有五个真的拦得住。
 *
 * 更糟的是**测试没抓到**：冒烟测试给 `set_develop_settings` 传的是
 * `photo_ids: ['a','b','c']`，而它的真实 schema 是单数 `photo_id` 且
 * `additionalProperties: false`——真实工具会在 schema 层就拒掉那个参数。
 * 那条断言测的是一个不可能发生的输入。
 */
export function photoKeys(args) {
  const out = []
  const push = (value) => {
    if (typeof value === 'string' && value !== '') out.push(value)
    else if (typeof value === 'number') out.push(String(value))
  }
  const a = args ?? {}
  for (const field of ['photo_ids', 'target_ids']) {
    if (Array.isArray(a[field])) a[field].forEach(push)
    else push(a[field])
  }
  push(a.photo_id)
  push(a.source_id)
  return [...new Set(out)]
}

/**
 * 「同一套参数累计碰过几张**不同**照片」的会话内记录。
 *
 * 为什么必须累计而不是只看单次调用：门禁要防的是「一套没验证过的参数铺满一批」，
 * 而铺满一批有两种形态——一次调用带 N 张，或者 **N 次调用各带一张**。后者才是更
 * 自然的做法，因为 `set_develop_settings` 的 schema 就是单数 `photo_id`。
 *
 * 语义正好落在需要的地方：第一张放行（那正是「单张先行」本身），第二张起拦截
 * （那已经是批量了）。用户同意后指纹进白名单，后续不再拦。
 *
 * 只存内存：会话重启后计数归零，最坏情况是「多放行一张」，第二张仍会被拦，
 * 保护不失效。落盘会让每次调用都写一次文件，代价与损坏风险都不值。
 */
export class PhotoTracker {
  #touched = new Map()

  /** 记下这批照片，返回该指纹累计碰过的不同照片数。 */
  add(fingerprint, keys) {
    let set = this.#touched.get(fingerprint)
    if (set === undefined) {
      set = new Set()
      this.#touched.set(fingerprint, set)
    }
    for (const key of keys) set.add(key)
    return set.size
  }

  sizeOf(fingerprint) {
    return this.#touched.get(fingerprint)?.size ?? 0
  }
}

export function rawToolName(toolName) {
  return toolName.startsWith(LIGHTROOM_TOOL_PREFIX) ? toolName.slice(LIGHTROOM_TOOL_PREFIX.length) : toolName
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

export class GateLedger {
  #cache = null

  async load() {
    if (this.#cache === null) {
      const data = await readJson(approvedParamsFile(), { version: 1, approved: {}, rendered: {} })
      this.#cache = data !== null && typeof data === 'object' && data.approved !== undefined
        ? { version: 1, rendered: {}, ...data }
        : { version: 1, approved: {}, rendered: {} }
    }
    return this.#cache
  }

  async isApproved(fingerprint) {
    return (await this.load()).approved[fingerprint] !== undefined
  }

  async approve(fingerprint, entry) {
    const data = await this.load()
    data.approved[fingerprint] = { approvedAt: new Date().toISOString(), ...entry }
    await this.#save()
  }

  /** 记录「这一套参数已经在单张上渲染过」——门禁的理由里要说得出这件事。 */
  async markRendered(fingerprint, entry) {
    const data = await this.load()
    data.rendered[fingerprint] = { renderedAt: new Date().toISOString(), ...entry }
    await this.#save()
  }

  async renderedInfo(fingerprint) {
    return (await this.load()).rendered[fingerprint] ?? null
  }

  async #save() {
    await mkdir(path.dirname(approvedParamsFile()), { recursive: true })
    await writeFile(approvedParamsFile(), `${JSON.stringify(this.#cache, null, 2)}\n`, 'utf8')
  }

  /** 白名单摘要，给 doctor 与面板用。 */
  async summary() {
    const data = await this.load()
    return Object.entries(data.approved).map(([fingerprint, entry]) => ({ fingerprint, ...entry }))
  }
}

/**
 * 判定一次调用是否撞上「新参数门禁」。
 *
 * 判定依据是**同一套参数累计碰过的不同照片数**，不是这一次调用带了几张——
 * 详见 `photoKeys` 与 `PhotoTracker` 的注释（那正是原先的漏洞所在）。
 *
 * @returns {null | {fingerprint:string, rawTool:string, photos:number, summary:string}}
 */
export async function checkParamGate(ledger, tracker, toolName, args) {
  const rawTool = rawToolName(toolName)
  if (!PARAM_GATED_TOOLS.has(rawTool)) return null

  const fingerprint = fingerprintParams(rawTool, args)
  if (await ledger.isApproved(fingerprint)) return null

  const keys = photoKeys(args)
  // 认不出照片身份时**保守拦截**（宁可多问一次）。受管工具都有身份字段，
  // 正常走不到这条分支；留着是为了「一条认不出的路径绝不静默放行」。
  const photos = keys.length === 0 ? Number.POSITIVE_INFINITY : tracker.add(fingerprint, keys)
  if (photos < 2) return null // 第一张正是「单张先行」那一步本身

  return {
    fingerprint,
    rawTool,
    photos,
    summary: summarizeParams(rawTool, args),
  }
}

/** 给用户看的一行参数摘要（门禁理由里要有具体数字/取值）。 */
export function summarizeParams(rawTool, args) {
  const { photo_id: _p, photo_ids: _ps, ...params } = args ?? {}
  const entries = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? canonical(v) : String(v)}`)
  return `${rawTool}(${entries.join(', ') || '无参数'})`
}

/** 把门禁挂到 tools 钩子上。 */
export function registerGate(ctx, { log = () => {} } = {}) {
  const ledger = new GateLedger()
  const tracker = new PhotoTracker()
  const seen = new Map() // exec → 本次调用的门禁描述，供 post-execute 记账

  ctx.effect(() => ctx.on('tools/pre-execute', async (exec, next) => {
    const args = exec.arguments ?? {}

    // ---- 标记/移动门禁：真在动硬盘上的文件，必须让用户看到完整名单再点头。
    // 预演（不带 confirm）不拦——那一趟本来就是给他看的。
    if (exec.name === 'shejing_cull' && args.confirm === true) {
      const names = Array.isArray(args.reject) ? args.reject : []
      return {
        kind: 'ask',
        reason:
          `摄鲸·标记/移动门禁：将把 ${names.length} 张照片移进 \`非导入/\`，`
          + '其余全部移进 `可导入/`。这是同盘 rename，可逆，原件不会删除。\n'
          + `名单：${names.join('、') || '（空——请确认是否真的要执行）'}`,
      }
    }

    // ---- 不可逆门禁：改文件名之后，Lightroom 之外的引用就断了。
    if (exec.name === 'shejing_organize' && args.rename_confirm === true) {
      return {
        kind: 'ask',
        reason:
          '摄鲸·不可逆门禁：将按模板重命名 `可导入/` 里的照片。'
          + '**文件名一改，Lightroom 之外的引用就会断**，而目录数据库里的记录要重新关联。\n'
          + `模板：${args.template ?? '{date}_{name}'}。确认前请先看过预演输出的对照表。`,
      }
    }

    // ---- 导出前确认：清单要经用户增删才导。
    if (exec.name === 'shejing_archive' && args.confirm === true) {
      const picks = Array.isArray(args.picks) ? args.picks.length : 0
      const excluded = Array.isArray(args.exclude) ? args.exclude.length : 0
      return {
        kind: 'ask',
        reason:
          '摄鲸·归档导出：将把精选导出为原尺寸 JPEG（质量 100），'
          + `${picks > 0 ? `你点名的 ${picks} 张` : `按星级阈值 ${args.threshold ?? 4} 筛出的候选`}`
          + `${excluded > 0 ? `，已排除 ${excluded} 张` : ''}。\n`
          + '请确认你已经看过清单并增删完毕。',
      }
    }

    // ---- 复盘写入：规则只追加、永不删除，是长期资产。
    if (exec.name === 'shejing_retro' && args.confirm === true) {
      return {
        kind: 'ask',
        reason:
          `摄鲸·复盘写入：将把规则「${args.title}」永久追加进拍摄前规则（只追加，不删除）。\n`
          + `正文：${String(args.body ?? '').slice(0, 200)}`,
      }
    }

    // 调色门禁：shejing_grade 内部直接调桥接（不走 DSH 工具），所以钩子必须
    // 专门认它——否则它就是 Q29 要堵的那条旁路。
    //
    // 这里也走**累计跟踪**，不能只看 `photo_ids.length >= 2`：那样逐张调用
    // （每次只带一张）同样绕得过去——和 bridge 工具那边是同一个洞，只是换了个入口。
    if (exec.name === 'shejing_grade') {
      const ids = Array.isArray(args.photo_ids) ? args.photo_ids.map(v => String(v)) : []
      const resolved = resolveGrade(args) // 未知风格在这里就抛，不会写了一半才炸
      // 指纹只算**参数**（settings + curves），不含照片 id，也不含 label/notes。
      // 工具那边记录时用的是同一个 params，两边必须一致。
      const fingerprint = fingerprintParams('shejing_grade', resolved.params)
      if (!(await ledger.isApproved(fingerprint))) {
        const photos = ids.length === 0 ? Number.POSITIVE_INFINITY : tracker.add(fingerprint, ids)
        if (photos >= 2) {
          const rendered = await ledger.renderedInfo(fingerprint)
          const evidence = rendered === null
            ? '⚠️ 账本里**没有**这一套参数的单张渲染记录。'
            : `这一套参数的单张渲染记录：${rendered.previewPath}（${rendered.renderedAt}）。`
          seen.set(exec, { fingerprint, rawTool: 'shejing_grade', summary: resolved.summary, photos })
          return {
            kind: 'ask',
            reason:
              `摄鲸·新参数门禁：${resolved.summary} 将应用到 ${photos} 张照片。\n`
              + `${evidence}\n`
              + '请确认你**看过**单张上的渲染结果再同意；同意后这一套参数进白名单，'
              + '以后同样的参数不再拦。',
          }
        }
      }
    }

    const gate = await checkParamGate(ledger, tracker, exec.name, exec.arguments)
    if (gate === null) return next()

    // 已经通过钩子放行会在 post-execute 里记账；这里再次放行说明白名单命中了
    // （checkParamGate 已返回 null），所以走到这里就是新参数。
    seen.set(exec, gate)
    const howMany = Number.isFinite(gate.photos)
      ? `${gate.photos} 张照片`
      : '数量不明的照片（认不出参数里的照片身份，按保守处理）'
    log(`[shejing] 门禁拦截 ${gate.rawTool} × ${gate.photos}，指纹 ${gate.fingerprint}`)
    return {
      kind: 'ask',
      reason:
        `摄鲸·新参数门禁：${gate.summary} 将应用到 ${howMany}，`
        + `但这一套参数（指纹 ${gate.fingerprint}）还没有做过单张验证。\n`
        + '请确认你**看过**它在单张上的渲染结果再同意；同意后这一套参数会进白名单，'
        + '以后同样的参数不再拦。',
    }
  }))

  ctx.effect(() => ctx.on('tools/post-execute', async (exec, result, next) => {
    const gate = seen.get(exec)
    if (gate !== undefined) {
      seen.delete(exec)
      // **只在真的执行成功之后才入白名单。**
      //
      // DSH 在「用户拒绝」这条路径上也**会**跑 post-execute：deny 会被转成
      // post-result，再走 finalizeScheduledExecution → postExecute
      // （见 dsh-tools/src/index.ts 的 prepareExecution / serviceAsk）。
      // 原先无条件记账，于是：
      //   用户点了拒绝 → 这套参数进白名单 → 第二次同样的调用**不再问**就直接执行。
      // 最坏的情况在没有审批通道的环境里（headless、子代理、approval unavailable）：
      // serviceAsk 会**自动拒绝**第一次受管调用——那次拒绝就把参数放行了，重试即
      // 无门禁。这等于凭空造出一条 force 旁路，正是这套门禁宣称不存在的东西。
      if (result?.isError === true || result?.error !== undefined) {
        log(`[shejing] 调用未成功（被拒或出错），指纹不入白名单：${gate.fingerprint}`)
        return next()
      }
      await ledger.approve(gate.fingerprint, {
        tool: gate.rawTool,
        summary: gate.summary,
        // Infinity 序列化成 null 会污染账本，这里落成 null 之外的明确值
        photos: Number.isFinite(gate.photos) ? gate.photos : null,
      })
      log(`[shejing] 参数已入白名单：${gate.fingerprint}`)
    }
    return next()
  }))

  return ledger
}
