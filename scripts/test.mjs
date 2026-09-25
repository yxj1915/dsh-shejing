/**
 * 统一测试入口：JS 侧 + Python 侧。
 *
 *   node scripts/test.mjs            跑全部
 *   node scripts/test.mjs smoke      只跑插件注册面与门禁
 *   node scripts/test.mjs client     只跑浏览器半边的构建与渲染检查
 *   node scripts/test.mjs bridge     只跑 LR 通道（用假桥接）
 *   node scripts/test.mjs tools      只跑阶段工具（调色 / 归档 / 协议层失败）
 *   node scripts/test.mjs python     只跑 Python 侧（分组算法等）
 *   node scripts/test.mjs packed     只跑打包产物安装验证（约 60 秒，需要联网装依赖）
 *
 * 需要 DSH_HOME 的两套（tools 与 regression）会写入该目录，别指向真实的 ~/.dsh。
 *
 * 端到端回归（scripts/regression.mjs）不在这里跑——它要十几分钟并且需要一份
 * 真实批次，属于手工触发的验收。
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { resolvePython } from '../src/python.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const only = process.argv[2]

function run(command, args, label) {
  return new Promise((resolve) => {
    console.log(`\n\x1b[1m━━━ ${label}\x1b[0m`)
    const child = spawn(command, args, { cwd: ROOT, stdio: 'inherit' })
    child.once('close', (code) => resolve({ label, code: code ?? 1 }))
    child.once('error', (error) => {
      console.error(`${label}: 无法启动 → ${error.message}`)
      resolve({ label, code: 1 })
    })
  })
}

const results = []

if (only === undefined || only === 'smoke') {
  results.push(await run(process.execPath, [path.join(ROOT, 'scripts', 'smoke.mjs')], 'JS · 插件注册面与门禁'))
  // 桌面 composition 里某些服务可能不存在；插件必须照常激活，只是少注册路由。
  results.push(await run(process.execPath,
    [path.join(ROOT, 'scripts', 'smoke.mjs'), '--no-connection'], 'JS · 缺 connection 服务时的降级'))
}

if (only === undefined || only === 'client') {
  // 先确保工件是最新的，否则检查的是旧产物。
  const built = await run(process.execPath, [path.join(ROOT, 'scripts', 'build-client.mjs')], 'JS · 构建浏览器半边')
  if (built.code === 0) {
    results.push(await run(process.execPath, [path.join(ROOT, 'scripts', 'check-client.mjs')], 'JS · 浏览器半边渲染'))
  } else {
    results.push({ label: 'JS · 浏览器半边渲染', code: 1 })
  }
}

if (only === undefined || only === 'bridge') {
  results.push(await run(process.execPath,
    [path.join(ROOT, 'scripts', 'test-bridge.mjs')], 'JS · LR 通道（假桥接）'))
}

if (only === undefined || only === 'tools') {
  if (process.env.DSH_HOME === undefined) {
    console.error('JS · 调色阶段：跳过（未设置 DSH_HOME）')
    results.push({ label: 'JS · 阶段工具（假桥接）', code: 1 })
  } else {
    results.push(await run(process.execPath,
      [path.join(ROOT, 'scripts', 'test-tools-lr.mjs')], 'JS · 阶段工具（假桥接）'))
  }
}

if (only === 'packed') {
  // 发布前的最后一道闸：把包真的装一遍再启动。默认不跑（耗时且要联网），
  // 但发版前必须跑——其余测试用的都是仓库里的软链版。
  results.push(await run(process.execPath,
    [path.join(ROOT, 'scripts', 'test-packed-install.mjs')], 'JS · 打包产物安装'))
}

if (only === undefined || only === 'python') {
  const python = await resolvePython()
  if (python === null) {
    console.error('JS · 找不到 Python 运行时，跳过 Python 侧测试')
    results.push({ label: 'Python · 全部', code: 1 })
  } else {
    const suites = [
      ['test_grouping.py', 'Python · 分组算法'],
      ['test_split.py', 'Python · 剔除脚本'],
      ['test_rename.py', 'Python · 重命名脚本'],
      ['test_catalog.py', 'Python · 目录数据库'],
    ]
    for (const [file, label] of suites) {
      results.push(await run(python.command, [path.join(ROOT, 'tests', file)], label))
    }
  }
}

console.log('\n\x1b[1m━━━ 汇总\x1b[0m')
let failed = 0
for (const result of results) {
  const mark = result.code === 0 ? '\x1b[32m✅\x1b[0m' : '\x1b[31m❌\x1b[0m'
  console.log(`  ${mark} ${result.label}`)
  if (result.code !== 0) failed += 1
}
process.exit(failed === 0 ? 0 : 1)
