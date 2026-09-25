/**
 * 摄鲸面板 · 浏览器半边。
 *
 * 这个文件是 **CJS**，不是 ESM：DSH 的客户端模块表用
 * `window.__ModuleLoader__.load({ id, factory: (require) => {...} })` 装载，
 * factory 里拿到 `require`，末尾 `return module.exports`。外层包装见
 * scripts/build-client.mjs（零构建工具，只做一次字符串包装）。
 *
 * 只依赖 `react`（平台基线模块）。图片直接走系统自带的
 * `GET /api/file?path=<绝对路径>`，不另建路由。
 *
 * 三个面板共用 `main` 槽位下的一个 key，内部用标签页切换：
 *   · 批次       —— 账本概览 + contact sheet
 *   · 剔除审阅   —— 连拍组逐帧缩略图 + 建议保留 + 留/剔标记
 *   · 精选清单   —— 星级候选与导出结果
 *   · 调色       —— 内置风格与参数指纹（门禁白名单）
 */

const React = require('react')

const h = React.createElement
const PANEL_KEY = 'shejing'

/* ------------------------------------------------------------------ 图标 */

/** 侧边栏图标。`sidebar.panellist` 的 owner props 就是 {size, active}——注册的组件本身即图标。 */
function WhaleIcon(props) {
  const size = props && props.size ? props.size : 20
  const active = Boolean(props && props.active)
  return h('svg', {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    style: { display: 'block', opacity: active ? 1 : 0.7 },
  },
    h('path', { d: 'M2.6 14.2c2.8.2 4.8-1.1 6.2-3 1.3-1.7 2.8-2.6 4.4-2.6 2.9 0 5.2 2.2 5.2 5 0 1.3-.5 2.5-1.4 3.4' }),
    h('path', { d: 'M4.6 14.2c0 2.8 2.4 4.9 5.6 4.9s5.6-2.1 5.6-4.9' }),
    h('path', { d: 'M17.4 17c1.5.6 3 .4 4.2-.7-.9-.6-1.4-1.4-1.7-2.3' }),
    h('path', { d: 'M11.4 8.6c.3-1.2 1-2 1.9-2.4' }),
    h('circle', { cx: 8.7, cy: 12.4, r: 0.85, fill: 'currentColor', stroke: 'none' }),
  )
}

/* ------------------------------------------------------------------ 基础 */

const styles = {
  page: { padding: '18px 22px', fontFamily: 'system-ui, -apple-system, sans-serif', fontSize: 13.5, lineHeight: 1.7, height: '100%', overflow: 'auto', boxSizing: 'border-box' },
  title: { fontSize: 17, fontWeight: 600, margin: '0 0 2px', display: 'flex', alignItems: 'center', gap: 8 },
  sub: { color: 'var(--dsh-text-2, #8a8a8a)', margin: '0 0 14px' },
  tabs: { display: 'flex', gap: 4, borderBottom: '1px solid var(--dsh-border, #e6e6e6)', marginBottom: 14, flexWrap: 'wrap' },
  tab: { padding: '6px 12px', border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 13.5, color: 'var(--dsh-text-2, #8a8a8a)', borderRadius: '6px 6px 0 0' },
  tabActive: { color: 'var(--dsh-text-1, #222)', fontWeight: 600, boxShadow: 'inset 0 -2px 0 currentColor' },
  card: { border: '1px solid var(--dsh-border, #e6e6e6)', borderRadius: 8, padding: '10px 13px', marginBottom: 10 },
  row: { display: 'flex', gap: 10, alignItems: 'baseline' },
  key: { width: 130, flex: 'none', color: 'var(--dsh-text-2, #8a8a8a)' },
  muted: { color: 'var(--dsh-text-2, #8a8a8a)' },
  badge: { display: 'inline-block', padding: '1px 7px', borderRadius: 10, fontSize: 11.5, marginRight: 5, background: 'var(--dsh-bg-2, #f0f0f0)' },
  badgeOn: { background: '#1f7a4d', color: '#fff' },
  button: { padding: '5px 11px', borderRadius: 6, border: '1px solid var(--dsh-border, #ccc)', background: 'transparent', cursor: 'pointer', fontSize: 12.5 },
  buttonOn: { borderColor: '#1f7a4d', color: '#1f7a4d', fontWeight: 600 },
  code: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11.5, wordBreak: 'break-all' },
  thumb: { borderRadius: 6, objectFit: 'cover', background: 'var(--dsh-bg-2, #f4f4f4)', display: 'block' },
  frame: { border: '2px solid transparent', borderRadius: 8, padding: 4, cursor: 'pointer', width: 132 },
  frameKeep: { borderColor: 'var(--dsh-border, #d8d8d8)', background: 'var(--dsh-bg-2, #fafafa)' },
  frameReject: { borderColor: '#c0392b', background: 'rgba(192,57,43,.07)' },
  frameRow: { display: 'flex', gap: 8, flexWrap: 'wrap' },
  warn: { color: '#b7791f' },
  bad: { color: '#c0392b' },
  ok: { color: '#1f7a4d' },
}

function Row(props) {
  return h('div', { style: styles.row },
    h('span', { style: styles.key }, props.label),
    h('span', { style: { flex: 1, minWidth: 0 } }, props.children))
}

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' } })
  const text = await response.text()
  if (!response.ok) throw new Error(`HTTP ${response.status} — ${text.slice(0, 180)}`)
  return JSON.parse(text)
}

/** 本地图片 → 系统自带的文件路由。加时间戳避免改名后命中缓存。 */
function fileUrl(absolutePath, nonce) {
  if (typeof absolutePath !== 'string' || absolutePath === '') return null
  return `/api/file?path=${encodeURIComponent(absolutePath)}${nonce === undefined ? '' : `&t=${nonce}`}`
}

/* ------------------------------------------------------------------ 各标签页 */

function BatchesTab(props) {
  const batch = props.batch
  const list = props.list
  if (list.length === 0) {
    return h('div', { style: styles.card },
      h('div', null, '还没有批次。'),
      h('div', { style: styles.muted }, '让模型跑一次 shejing_checkup，这里就会出现。'))
  }
  return h('div', null,
    h('div', { style: styles.card },
      h('div', { style: { fontWeight: 600, marginBottom: 6 } }, `批次（${list.length}）`),
      h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } }, list.map(item =>
        h('button', {
          key: item.id,
          style: { ...styles.button, ...(batch && batch.batchId === item.batchId ? styles.buttonOn : {}) },
          onClick: () => props.onSelect(item.id),
        }, item.id)))),
    batch === null
      ? h('div', { style: styles.muted }, '选一个批次看详情。')
      : h('div', null,
        h('div', { style: styles.card },
          h(Row, { label: '源文件夹' }, h('span', { style: styles.code }, String(batch.source ?? '—'))),
          h(Row, { label: '照片数' }, String(batch.photoCount ?? '—')),
          h(Row, { label: '机身' }, (batch.camera || []).join('、') || '—'),
          h(Row, { label: '更新于' }, String(batch.updated ?? '—')),
          h(Row, { label: '已完成阶段' }, (batch.stages || []).length === 0
            ? h('span', { style: styles.muted }, '无')
            : (batch.stages || []).map(name => h('span', { key: name, style: { ...styles.badge, ...styles.badgeOn } }, name)))),
        batch.cull === null ? null : h('div', { style: styles.card },
          h('div', { style: { fontWeight: 600 } }, '剔除'),
          h(Row, { label: '保留' }, `${batch.cull.kept ?? '?'} 张 → ${(batch.cull.keep_dir || '').split('/').pop()}`),
          h(Row, { label: '剔除' }, `${batch.cull.rejected ?? '?'} 张 → ${(batch.cull.reject_dir || '').split('/').pop()}`)),
        batch.archive === null ? null : h('div', { style: styles.card },
          h('div', { style: { fontWeight: 600 } }, '归档'),
          h(Row, { label: '导出张数' }, String(batch.archive.export_count ?? '?')),
          h(Row, { label: '目录' }, h('span', { style: styles.code }, String(batch.archive.export_dir ?? '—')))),
        batch.contactSheet === null ? null : h('div', { style: styles.card },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, 'Contact sheet'),
          h('img', { src: fileUrl(batch.contactSheet, props.nonce), style: { ...styles.thumb, width: '100%', maxWidth: 900 } }))),
  )
}

function CullTab(props) {
  const batch = props.batch
  if (batch === null) return h('div', { style: styles.muted }, '先在「批次」里选一个。')
  if ((batch.groups || []).length === 0) {
    return h('div', { style: styles.muted }, '这个批次没有连拍/近似重复组。')
  }
  return h('div', null,
    h('div', { style: styles.card },
      h('div', null, `连拍/近似重复组 ${batch.groups.length} 个，覆盖 ${batch.groups.reduce((n, g) => n + g.count, 0)} 张。`),
      h('div', { style: styles.muted },
        '点缩略图切换留/剔。包围曝光与疑似堆栈不在剔除建议范围内。你的决定要带回对话里交给 shejing_cull，'),
      h('div', { style: styles.muted }, '面板只负责让你看清楚——最终名单仍走门禁。')),
    batch.groups.map((group, index) => h('div', { key: index, style: styles.card },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
        h('div', null,
          h('strong', null, `${group.count} 张`), ' ',
          h('span', { style: styles.badge }, group.kind),
          group.evSpread === null ? null : h('span', { style: styles.badge }, `曝光跨度 ${group.evSpread} 档`),
          group.reliable ? null : h('span', { ...styles, style: { ...styles.badge, ...styles.warn } }, '判断不可靠，请复核')),
        h('span', { style: { ...styles.muted, fontSize: 12 } },
          `${group.frames[0]?.name ?? ''} → ${group.frames[group.frames.length - 1]?.name ?? ''}`)),
      h('div', { style: { ...styles.frameRow, marginTop: 8 } }, group.frames.map(frame => {
        const isKeep = frame.name === group.keep
        const state = props.marks[frame.name]
        const rejected = state === undefined ? !isKeep : state === false
        return h('div', {
          key: frame.name,
          style: { ...styles.frame, ...(rejected ? styles.frameReject : styles.frameKeep) },
          onClick: () => props.onToggle(frame.name, !rejected),
          title: '点击切换留/剔',
        },
          frame.small === null
            ? h('div', { style: { height: 82, display: 'flex', alignItems: 'center', justifyContent: 'center' }, ...styles.muted }, '无缩略图')
            : h('img', { src: fileUrl(frame.small, props.nonce), style: { ...styles.thumb, width: '100%', height: 82 } }),
          h('div', { style: { fontSize: 11, marginTop: 4, ...styles.code } }, frame.name.replace(/^\d{4}-\d{2}-\d{2}_/, '')),
          h('div', { style: { fontSize: 11 } },
            h('span', { style: styles.muted }, `清晰度 ${frame.sharp ?? '—'}`), ' ',
            rejected ? h('span', { style: styles.bad }, '剔') : h('span', { style: styles.ok }, '留')))
      })))),
  )
}

function PicksTab(props) {
  const batch = props.batch
  if (batch === null) return h('div', { style: styles.muted }, '先在「批次」里选一个。')
  return h('div', { style: styles.card },
    h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '精选'),
    batch.archive === null
      ? h('div', null,
        h('div', null, '还没有导出过。'),
        h('div', { style: styles.muted }, '流程是：调色 → 验收 → 用 shejing_archive 出计划，你把清单增删之后才导。'))
      : h('div', null,
        h(Row, { label: '导出张数' }, String(batch.archive.export_count ?? '?')),
        h(Row, { label: '阈值' }, `星级 ≥ ${batch.archive.threshold ?? '?'}`),
        h(Row, { label: '目录' }, h('span', { style: styles.code }, String(batch.archive.export_dir ?? '—'))),
        h('div', { style: { marginTop: 6 } }, (batch.archive.selected || []).map(name =>
          h('div', { key: name, style: styles.code }, name)))))
}

function GradeTab(props) {
  const batch = props.batch
  const grade = batch === null ? null : batch.grade
  // 注意别把这个数组叫 styles——会遮蔽模块级的样式对象。
  const STYLE_ROWS = [
    ['A', '暖调电影感', '城市 / 建筑'],
    ['B', '清透日系', '云彩天空 / 正午'],
    ['C', '浓郁黄昏', '落日 / 篝火 / 剪影'],
  ]

  return h('div', null,
    h('div', { style: styles.card },
      h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '三种内置风格'),
      STYLE_ROWS.map(([id, name, use]) => h(Row, { key: id, label: `${id} ${name}` }, use)),
      h('div', { style: { ...styles.muted, marginTop: 6 } },
        '风格 B 的三条曲线原表首点是 (0,8)/(0,2)/(0,4)，会触发 gotcha #24 的重复端点陷阱；插件已自动归零为 (0,0)。')),

    grade === null
      ? h('div', { style: styles.card },
        h('div', null, '这个批次还没有调色记录。'),
        h('div', { style: styles.muted },
          '流程是：先对**一张**调 shejing_grade（单张先行），把渲染图给你看过、认可后再批量。批量那次会把每张的渲染结果记进账本，这里就会出现前后对比。'))
      : h('div', { style: styles.card },
        h(Row, { label: '风格' }, String(grade.label ?? '—')),
        h(Row, { label: '参数指纹' }, h('span', { style: styles.code }, String(grade.fingerprint ?? '—'))),
        h(Row, { label: '已渲染' }, `${grade.renders.length} 张${grade.single ? '（单张先行）' : ''}`),
        grade.notes.length === 0 ? null : h('div', { style: { marginTop: 6 } },
          h('div', { style: styles.muted }, '参数修正：'),
          grade.notes.map((note, index) => h('div', { key: index, style: { ...styles.muted, fontSize: 12 } }, `· ${note}`)))),

    grade === null || grade.renders.length === 0
      ? null
      : grade.renders.map(render => h('div', { key: String(render.id), style: styles.card },
        h('div', { style: { fontWeight: 600, marginBottom: 6 } }, String(render.id)),
        h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
          h('div', { style: { flex: '1 1 260px', minWidth: 200 } },
            h('div', { style: styles.muted }, '之前（相机预览，未调色）'),
            render.before === null
              ? h('div', { style: { ...styles.muted, fontSize: 12 } }, '（体检没有留下这张的大图）')
              : h('img', { src: fileUrl(render.before, props.nonce), style: { ...styles.thumb, width: '100%', marginTop: 4 } })),
          h('div', { style: { flex: '1 1 260px', minWidth: 200 } },
            h('div', { style: styles.muted }, '之后（Lightroom 渲染，带当前编辑）'),
            render.preview === null
              ? h('div', { style: { ...styles.muted, fontSize: 12 } }, '（未返回 file_path）')
              : h('img', { src: fileUrl(render.preview, props.nonce), style: { ...styles.thumb, width: '100%', marginTop: 4 } }))))),

    batch === null || batch.shootingLessons.length === 0
      ? null
      : h('div', { style: styles.card },
        h('div', { style: { fontWeight: 600, marginBottom: 6 } }, `复盘沉淀的规则（${batch.shootingLessons.length}）`),
        batch.shootingLessons.map((lesson, index) =>
          h('div', { key: index, style: { marginBottom: 6 } },
            h('strong', null, lesson.title ?? ''), h('div', { style: styles.muted }, lesson.body ?? '')))))
}

/* ------------------------------------------------------------------ 主体 */

const TABS = [
  { id: 'batches', label: '批次' },
  { id: 'cull', label: '剔除审阅' },
  { id: 'picks', label: '精选清单' },
  { id: 'grade', label: '调色' },
]

function App() {
  const [state, setState] = React.useState({ loading: true, error: null, list: [], batch: null, selected: null })
  const [tab, setTab] = React.useState('batches')
  const [marks, setMarks] = React.useState({})
  const [nonce, setNonce] = React.useState(() => Date.now())

  const loadList = React.useCallback(async (selectId) => {
    try {
      const data = await getJson('/api/shejing/batches')
      const list = data.batches || []
      const wanted = selectId ?? (list.length > 0 ? list[0].id : null)
      let batch = null
      if (wanted !== null) {
        const detail = await getJson(`/api/shejing/batch?id=${encodeURIComponent(wanted)}`)
        batch = detail.batch
      }
      setState({ loading: false, error: null, list, batch, selected: wanted })
    } catch (error) {
      setState(previous => ({ ...previous, loading: false, error: String(error && error.message ? error.message : error) }))
    }
  }, [])

  const select = React.useCallback(async (id) => {
    setState(previous => ({ ...previous, loading: true }))
    try {
      const detail = await getJson(`/api/shejing/batch?id=${encodeURIComponent(id)}`)
      setState(previous => ({ ...previous, loading: false, error: null, batch: detail.batch, selected: id }))
      setMarks({})
    } catch (error) {
      setState(previous => ({ ...previous, loading: false, error: String(error && error.message ? error.message : error) }))
    }
  }, [])

  React.useEffect(() => { void loadList(null) }, [loadList])

  const toggle = React.useCallback((name, keep) => {
    setMarks(previous => ({ ...previous, [name]: keep }))
  }, [])

  const rejected = Object.entries(marks).filter(([, keep]) => keep === false).map(([name]) => name)

  return h('div', { style: styles.page },
    h('h1', { style: styles.title },
      h(WhaleIcon, { size: 20, active: true }),
      '摄鲸'),
    h('p', { style: styles.sub }, '从拍摄到整理到后期的完整照片工作流。面板负责让你看清楚，决定仍然走对话里的门禁。'),

    h('div', { style: styles.tabs },
      TABS.map(item => h('button', {
        key: item.id,
        style: { ...styles.tab, ...(tab === item.id ? styles.tabActive : {}) },
        onClick: () => setTab(item.id),
      }, item.label)),
      h('span', { style: { flex: 1 } }),
      h('button', {
        style: styles.button,
        onClick: () => { setNonce(Date.now()); void loadList(state.selected) },
        disabled: state.loading,
      }, state.loading ? '读取中…' : '刷新')),

    state.error === null ? null : h('div', { style: styles.card },
      h('div', { style: styles.bad }, '读取失败'),
      h('div', { style: styles.code }, state.error)),

    tab === 'batches' ? h(BatchesTab, { list: state.list, batch: state.batch, onSelect: select, nonce }) : null,
    tab === 'cull' ? h('div', null,
      rejected.length === 0 ? null : h('div', { style: styles.card },
        h('div', { style: { fontWeight: 600 } }, `你标了 ${rejected.length} 张要剔`),
        h('div', { style: styles.code }, rejected.join('、')),
        h('div', { style: { ...styles.muted, marginTop: 4 } },
          '把这份名单带回对话里交给 shejing_cull（它会先预演，再被门禁拦下问你一次）。')),
      h(CullTab, { batch: state.batch, marks, onToggle: toggle, nonce })) : null,
    tab === 'picks' ? h(PicksTab, { batch: state.batch }) : null,
    tab === 'grade' ? h(GradeTab, { batch: state.batch }) : null,
  )
}

exports.name = 'shejing-panel'
exports.inject = ['slots']

/**
 * 仅供测试：把内部组件暴露出来，好让 scripts/check-client.mjs 用假 React
 * 真正调用它们。`node --check` 只能查语法——`styles.map is not a function`
 * 这种错它完全看不见，只有真的渲染一次才会暴露。
 */
exports.__test = { WhaleIcon, BatchesTab, CullTab, PicksTab, GradeTab, App }

exports.apply = function apply(ctx) {
  ctx.slots.inject('main', () => ctx.slots.register(
    { name: 'main', key: PANEL_KEY },
    App,
  ))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
    { name: 'sidebar.panellist', id: PANEL_KEY, order: 50, label: '摄鲸' },
    WhaleIcon,
  ))
}
