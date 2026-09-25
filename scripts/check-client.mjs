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

/* ---------------------------------------------------------------- 逐个渲染 */

const cases = [
  ['WhaleIcon (未选中)', T.WhaleIcon, { size: 20, active: false }],
  ['WhaleIcon (选中)', T.WhaleIcon, { size: 20, active: true }],
  ['App', T.App, {}],
  ['BatchesTab (空)', T.BatchesTab, { list: [], batch: null, onSelect: () => {}, nonce: 1 }],
  ['BatchesTab (有批次)', T.BatchesTab, { list: [{ id: '2026-09-25_regression', batchId: '2026-09-25_regression' }], batch: fullBatch, onSelect: () => {}, nonce: 1 }],
  ['CullTab (空)', T.CullTab, { batch: null, marks: {}, onToggle: () => {}, nonce: 1 }],
  ['CullTab (有组)', T.CullTab, { batch: fullBatch, marks: { 'b.ARW': false }, onToggle: () => {}, nonce: 1 }],
  ['PicksTab (无归档)', T.PicksTab, { batch: emptyBatch }],
  ['PicksTab (有归档)', T.PicksTab, { batch: fullBatch }],
  ['GradeTab (无调色)', T.GradeTab, { batch: emptyBatch }],
  ['GradeTab (有调色)', T.GradeTab, { batch: fullBatch }],
]

let failed = 0
for (const [label, component, props] of cases) {
  try {
    const tree = render(component(props), fakeReact)
    assert.ok(tree !== undefined, '渲染返回了 undefined')
    console.log(`  ✅ ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  ❌ ${label} → ${error && error.message ? error.message : error}`)
  }
}

console.log()
if (failed > 0) {
  console.error(`❌ ${failed} 个渲染用例失败`)
  process.exit(1)
}
console.log('✅ 客户端渲染检查通过')
