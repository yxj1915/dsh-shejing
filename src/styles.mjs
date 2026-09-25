/**
 * 三种内置风格 —— 从「文档里的表格」变成「可被工具引用、可校验的结构化数据」。
 *
 * 为什么要这么做：风格以前是 markdown 表格，靠模型照着抄滑杆值和曲线点。抄错
 * 就是又一次事故，而且没人能查。现在它是数据，指纹可以直接算在它上面，门禁
 * 也因此拦得住。
 *
 * 参数来源：`docs/lightroom-classic/develop-keys.md` 第 3 节（Lightroom 原生单位）。
 * `Exposure2012` 单位是 EV，其余是 Lightroom 的 −100..100 刻度。
 */

/**
 * ⚠️ 点曲线端点陷阱（gotcha #24，曾把 25 张照片整批染成紫红）。
 *
 * `normalizeCurvePoints` 在首点不等于 `(0,0)` 时会**前插** `(0,0)`。若首点是
 * `[0, y]` 且 `y !== 0`，就会写出**重复的 x=0 点**，Lightroom 的样条随红/蓝通道
 * 严重发散。绕开它的错误做法是把首点挪到 `x=1`——`(0,0)→(1,y)` 近乎垂直，结果更糟。
 *
 * 正确做法：让首点落在 `(0,0)`。这与「丢掉首点让工具自己补」等价，但保留锚点数量，
 * 更接近原意。下方 `sanitizeCurve` 自动做这件事，并把改动记进 notes 供你核对。
 */
function sanitizeCurve(points, channel, notes) {
  const sorted = [...points].sort((a, b) => a[0] - b[0])
  const first = sorted[0]
  if (first !== undefined && first[0] === 0 && first[1] !== 0) {
    sorted[0] = [0, 0]
    notes.push(`曲线 ${channel}：首点由 (0,${first[1]}) 归零到 (0,0)——否则 normalizeCurvePoints 会前插 (0,0) 造成重复端点（gotcha #24）`)
  }
  return sorted
}

/** 原始风格表。曲线写成 [x, y] 点阵列。 */
const RAW_STYLES = {
  A: {
    label: '暖调电影感',
    useFor: '城市 / 建筑',
    settings: {
      Contrast2012: 14,
      Highlights2012: -42,
      Shadows2012: 26,
      Whites2012: 5,
      Blacks2012: -12,
      Texture: 8,
      Clarity2012: 12,
      Dehaze: 8,
      Vibrance: 18,
      Saturation: -3,
    },
    curves: { main: [[40, 33], [128, 132], [202, 210]], red: [[64, 60], [192, 196]], blue: [[64, 74], [192, 184]] },
    vignette: { PostCropVignetteAmount: -12, PostCropVignetteFeather: 65, PostCropVignetteMidpoint: 45 },
  },
  B: {
    label: '清透日系',
    useFor: '云彩天空 / 正午',
    settings: {
      Contrast2012: -6,
      Highlights2012: -32,
      Shadows2012: 38,
      Whites2012: 12,
      Blacks2012: 8,
      Texture: -4,
      Clarity2012: -4,
      Dehaze: -6,
      Vibrance: 8,
      Saturation: -2,
    },
    // 原表的 main 首点是 [0,8]、red 是 [0,2]、blue 是 [0,4] —— 三个都要归零。
    curves: { main: [[0, 8], [64, 70], [192, 196]], red: [[0, 2], [128, 129]], blue: [[0, 4], [128, 126]] },
    vignette: {},
  },
  C: {
    label: '浓郁黄昏',
    useFor: '落日 / 篝火 / 剪影',
    settings: {
      Contrast2012: 26,
      Highlights2012: -48,
      Shadows2012: 18,
      Whites2012: 4,
      Blacks2012: -16,
      Texture: 10,
      Clarity2012: 18,
      Dehaze: 10,
      Vibrance: 22,
      Saturation: 4,
    },
    curves: { main: [[32, 26], [128, 132], [208, 216]], red: [[128, 134]], blue: [[64, 6], [128, 120]] },
    vignette: { PostCropVignetteAmount: -22, PostCropVignetteFeather: 60, PostCropVignetteMidpoint: 40 },
  },
}

export const STYLE_IDS = Object.keys(RAW_STYLES)

/**
 * 展开一个风格为可直接下发的参数。
 * @param id 'A' | 'B' | 'C'（大小写不敏感）
 * @returns {{id, label, useFor, settings, curves, notes}}
 */
export function expandStyle(id) {
  const key = String(id).trim().toUpperCase()
  const raw = RAW_STYLES[key]
  if (raw === undefined) {
    throw new Error(`未知风格 ${JSON.stringify(id)}；可选：${STYLE_IDS.join(' / ')}`)
  }
  const notes = []
  const curves = {}
  for (const [channel, points] of Object.entries(raw.curves)) {
    curves[channel] = sanitizeCurve(points, channel, notes)
  }
  return {
    id: key,
    label: raw.label,
    useFor: raw.useFor,
    settings: { ...raw.settings, ...raw.vignette },
    curves,
    notes,
  }
}

/** 供 systemPrompt / 面板展示的风格清单一句话。 */
export function styleSummary() {
  return STYLE_IDS.map((id) => {
    const s = RAW_STYLES[id]
    return `${id}=${s.label}（${s.useFor}）`
  }).join(' · ')
}

/**
 * 解析 `shejing_grade` 的参数为最终可下发形态。
 *
 * 门禁钩子与工具本身**必须**用同一个函数算指纹，否则白名单与拦截会各算一套、
 * 互不认账——那是最难查的一类 bug。所以解析逻辑只放在这里一份。
 *
 * @param args {style?, settings?, curves?}
 * @returns {{label, settings, curves, notes, summary, params}}
 */
export function resolveGrade(args = {}) {
  const notes = []
  let settings = {}
  let curves = {}
  let label = '显式参数'

  if (args.style !== undefined && args.style !== null) {
    const expanded = expandStyle(args.style)
    settings = { ...expanded.settings }
    curves = { ...expanded.curves }
    label = `${expanded.id} ${expanded.label}`
    notes.push(...expanded.notes)
  }

  if (args.settings !== null && typeof args.settings === 'object') {
    settings = { ...settings, ...args.settings }
    if (args.style !== undefined) label += ' + 覆盖'
  }

  if (args.curves !== null && typeof args.curves === 'object') {
    for (const [channel, points] of Object.entries(args.curves)) {
      if (!Array.isArray(points)) continue
      const before = notes.length
      curves[channel] = sanitizeCurve(points, channel, notes)
      if (notes.length === before && args.style === undefined) {
        notes.push(`曲线 ${channel}：按你给的点原样下发`)
      }
    }
  }

  const sliderBits = Object.entries(settings)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${v === null ? 'null' : JSON.stringify(v)}`)
  const curveBits = Object.keys(curves).sort().join('/')
  const summary = `${label}：${sliderBits.join(', ') || '无滑杆'}${curveBits === '' ? '' : `；曲线 ${curveBits}`}`

  return { label, settings, curves, notes, summary, params: { settings, curves } }
}
