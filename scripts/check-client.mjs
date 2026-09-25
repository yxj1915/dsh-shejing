/**
 * 浏览器半边的渲染检查。
 *
 * 为什么需要它：`node --check` 只查语法，类型也不存在。像
 * `styles.map is not a function`（把样式对象当成数组用）这种错误
 * 语法完全合法、加载工厂时也不报——只有**真的渲染一次**才会暴露。
 *
 * 做法：用假 React（createElement 返回普通对象；useState/useEffect 用最小实现）
 * 直接调用组件函数，再用一个迷你渲染器展开函数组件树，任何一步抛错都算失败。
 *
 * 不需要 react-dom：我们不比对 DOM，只要求「渲染不炸」。
 *
 * 用法：node scripts/check-client.mjs
 */

import assert from 'node:assert/strict'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BUNDLE = path.join(ROOT, 'lib', 'client.js')

/* ---------------------------------------------------------------- 假 React */

function makeReact() {
  let stateIndex = 0
  const React = {
    createElement(type, props, ...children) {
      return { __el: true, type, props: props ?? {}, children }
    },
    useState(initial) {
      // 每次渲染都从初值开始即可——renderToString 语义，没有更新。
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useEffect() {},
    useCallback(fn) { return fn },
    useMemo(fn) { return fn() },
    useRef(value) { return { current: value } },
    Fragment: Symbol('Fragment'),
  }
  void stateIndex
  return React
}

/** 展开函数组件直到只剩宿主元素（字符串）或 null。 */
function render(node, fakeReact, depth = 0) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(child => render(child, fakeReact, depth + 1))
  if (typeof node === 'function') {
    if (depth > 60) throw new Error('渲染递归过深——可能有组件在无限自渲染')
    return render(node({}), fakeReact, depth + 1)
  }
  if (node.__el !== true) return String(node)
  if (typeof node.type === 'function') {
    if (depth > 60) throw new Error('渲染递归过深——可能有组件在无限自渲染')
    const props = { ...node.props }
    if (node.children.length > 0) props.children = node.children.length === 1 ? node.children[0] : node.children
    return render(node.type(props), fakeReact, depth + 1)
  }
  // 宿主元素：把 children 也渲染一遍，确保子树真的被求值。
  return {
    host: String(node.type),
    props: node.props,
    children: render(node.children, fakeReact, depth + 1),
  }
}

/* ---------------------------------------------------------------- 装载工件 */

const registered = []
const fakeRequire = (name) => {
  if (name === 'react') return fakeReact
  throw new Error(`客户端工件 require 了非基线模块：${name}`)
}
const fakeReact = makeReact()

globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      const moduleExports = spec.factory(fakeRequire)
      const ctx = {
        slots: {
          inject(_key, callback) { callback() },
          register(options) { registered.push(options) },
        },
      }
      moduleExports.apply(ctx)
      globalThis.__shejingClient = moduleExports
    },
  },
}

await import(`file://${BUNDLE}`)
const client = globalThis.__shejingClient

console.log(`工件：${client.name}（inject: ${client.inject.join(', ')}）`)
assert.deepEqual(registered.map(r => `${r.name}/${r.key ?? r.id ?? ''}`),
  ['main/shejing', 'sidebar.panellist/shejing'])

const T = client.__test
assert.ok(T, '客户端模块应当导出 __test 以便渲染检查')

/* ---------------------------------------------------------------- 样本数据 */

const emptyBatch = {
  batchId: 'x', source: '/tmp/x', photoCount: null, camera: [], updated: null,
  stages: [], cacheDir: null, contactSheet: null, groups: [],
  highlightClipped: [], sharpnessOutliers: [], cull: null, archive: null,
  grade: null, decisions: [], shootingLessons: [],
}

const fullBatch = {
  ...emptyBatch,
  batchId: '2026-09-25_regression',
  source: '/tmp/regression/9.25',
  photoCount: 75,
  camera: ['ILCE-7M5'],
  updated: '2026-09-25 22:20:00',
  stages: ['checkup', 'cull', 'review'],
  contactSheet: '/tmp/sheet.jpg',
  groups: [{
    count: 3, kind: '连拍', reliable: true, spanSeconds: 2, evSpread: 0.32, keep: 'a.ARW',
    frames: [
      { name: 'a.ARW', time: '12:00:00', sharp: 100, ev: -12, small: '/tmp/a.jpg' },
      { name: 'b.ARW', time: '12:00:01', sharp: 90, ev: -12, small: null },
      { name: 'c.ARW', time: '12:00:02', sharp: 80, ev: -12, small: '/tmp/c.jpg' },
    ],
  }],
  highlightClipped: ['b.ARW'],
  cull: { kept: 2, rejected: 1, keep_dir: '/tmp/regression/9.25/可导入', reject_dir: '/tmp/regression/9.25/非导入' },
  archive: { export_count: 2, threshold: 4, export_dir: '/tmp/regression/9.25/精选_2026-09-25_2230', selected: ['a.ARW', 'b.ARW'] },
  grade: {
    at: '2026-09-25 22:25:00', label: 'A 暖调电影感', fingerprint: 'abc123', style: 'A', single: false,
    notes: ['曲线 main：首点由 (0,8) 归零到 (0,0)'],
    renders: [{ id: 'a.ARW', preview: '/tmp/after.jpg', before: '/tmp/before.jpg', at: '2026-09-25 22:25:00' }],
  },
  shootingLessons: [{ title: '逆光保护高光', body: '先包围曝光再合成。' }],
}


/*
 * render() 对宿主元素产出的是 `{ host, props, children }`（不是 React 元素的
 * `{type, props}` 形状）。下面两个辅助函数按**渲染后的形状**走树。
 */

/** 把渲染树里所有文本收集起来——用来断言「屏幕上真的有这些东西」。 */
function collectText(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) collectText(child, out); return out }
  if (typeof node.host !== 'string') return out
  collectText(node.children, out)
  return out
}

/** 找出第一个满足条件的宿主元素，用来直接触发它的 onClick。 */
function findHost(node, predicate) {
  if (node === null || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findHost(child, predicate)
      if (found !== null) return found
    }
    return null
  }
  if (typeof node.host !== 'string') return null
  if (predicate(node)) return node
  return findHost(node.children, predicate)
}

/* ---------------------------------------------------------------- 逐个渲染 */

const cases = [
  // 最后一项是「屏幕上必须出现这段字」——组件返回 null 或渲染成空都会失败。
  ['WhaleIcon (未选中)', T.WhaleIcon, { size: 20, active: false }, undefined],
  ['WhaleIcon (选中)', T.WhaleIcon, { size: 20, active: true }, undefined],
  ['App', T.App, {}, '批次'],
  ['BatchesTab (空)', T.BatchesTab, { list: [], batch: null, onSelect: () => {}, nonce: 1 }, '还没有批次'],
  ['BatchesTab (有批次)', T.BatchesTab, { list: [{ id: '2026-09-25_regression' }], batch: fullBatch, onSelect: () => {}, nonce: 1 }, '源文件夹'],
  ['CullTab (空)', T.CullTab, { batch: null, marks: {}, onToggle: () => {}, nonce: 1 }, '先在「批次」里选一个'],
  ['CullTab (有组)', T.CullTab, { batch: fullBatch, marks: { 'b.ARW': false }, onToggle: () => {}, nonce: 1 }, 'a.ARW'],
  ['PicksTab (无归档)', T.PicksTab, { batch: emptyBatch }, undefined],
  ['PicksTab (有归档)', T.PicksTab, { batch: fullBatch }, 'a.ARW'],
  ['GradeTab (无调色)', T.GradeTab, { batch: emptyBatch }, undefined],
  ['GradeTab (有调色)', T.GradeTab, { batch: fullBatch }, 'A 暖调电影感'],
]

let failed = 0
for (const [label, component, props, mustContain] of cases) {
  try {
    const tree = render(component(props), fakeReact)
    // 原来的断言是 `tree !== undefined`——而 render() 只可能返回 null / 字符串 /
    // 数组 / 对象，**永远不会是 undefined**，所以那条断言恒真：一个组件直接
    // `return null`（整个标签页渲染成空）照样通过。审计员用变异证明了这一点。
    // 现在改为断言「屏幕上真的有这些字」，并且必须有宿主元素。
    assert.notEqual(tree, null, '组件返回了 null（屏幕上什么都没有）')
    const hosts = findHost(tree, () => true)
    const text = collectText(tree).join(' ')
    if (mustContain !== undefined) {
      assert.ok(hosts !== null, '没有任何宿主元素')
      assert.ok(text.includes(mustContain), `屏幕上没有「${mustContain}」，实际：${text.slice(0, 120)}`)
    }
    console.log(`  ✅ ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  ❌ ${label} → ${error && error.message ? error.message : error}`)
  }
}

/*
 * 「留/剔」点击必须真的翻转。
 *
 * 这条是补一个真实发生过的 bug：组件里算出的 `!rejected` 恰好等于当前存储的
 * keep，于是每次点击都存回同一个值——切换是**永久空操作**，而整个剔除审阅
 * 面板看起来还是活的（上面那张「你标了 N 张要剔」的卡片列的是工具的默认建议，
 * 不是用户的决定）。没有这条断言时，把 onToggle 接错线不会有任何测试失败。
 */
try {
  const calls = []
  const props = { batch: fullBatch, marks: {}, onToggle: (name, v) => calls.push([name, v]), nonce: 1 }
  const tree = render(T.CullTab(props), fakeReact)
  const frameA = findHost(tree, node => node.props?.title === '点击切换留/剔'
    && collectText(node.children).some(t => t.startsWith('a.ARW')))
  assert.ok(frameA !== null, '找不到 a.ARW 那一帧的可点击元素')
  frameA.props.onClick()
  // 语义：onToggle(name, X) = 「把 keep 设成 X」（App 的 setMarks 就是这么存的）。
  // 默认建议保留的一帧，第一次点击必须传 **false**（keep=false，即改为剔）。
  // 曾经传的是 !rejected，而它恰好等于当前的 keep —— 于是每次点击都存回原值，
  // 切换是永久空操作。这里断言「传进去的值与当前 keep 相反」，正是那条防线。
  assert.deepEqual(calls, [['a.ARW', false]],
    '默认保留的一帧点一下应当把 keep 改成 false（改为剔）')

  const calls2 = []
  const props2 = { batch: fullBatch, marks: { 'a.ARW': false }, onToggle: (n, v) => calls2.push([n, v]), nonce: 1 }
  const tree2 = render(T.CullTab(props2), fakeReact)
  const frameA2 = findHost(tree2, node => node.props?.title === '点击切换留/剔'
    && collectText(node.children).some(t => t.startsWith('a.ARW')))
  frameA2.props.onClick()
  assert.deepEqual(calls2, [['a.ARW', true]],
    '已标为剔的一帧再点一下应当把 keep 改回 true（改为留）')
  console.log('  ✅ CullTab 点击真的翻转留/剔')
} catch (error) {
  failed += 1
  console.error(`  ❌ CullTab 点击翻转 → ${error && error.message ? error.message : error}`)
}

console.log()
if (failed > 0) {
  console.error(`❌ ${failed} 个渲染用例失败`)
  process.exit(1)
}
console.log('✅ 客户端渲染检查通过')
