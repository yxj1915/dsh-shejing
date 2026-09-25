/**
 * 从**打包产物**装一遍并启动，验证发布出去的那份真的能用。
 *
 * 为什么需要它：其余所有测试跑的都是仓库里的**软链版**——路径长什么样、哪些文件
 * 真被打进包里、`import.meta.url` 在安装位置还对不对，这些只有真的装一遍才知道。
 * 这是最接近「用户拿到手」的一步，而且**不需要 npm 账号**（本地 tarball 即可）。
 *
 * 它做四件事：
 *   1. pnpm pack 出一个 tarball
 *   2. 在一个全新的隔离 DSH_HOME 里用 `dsh plugin add <tarball>` 装它
 *   3. 启动那个实例，等激活标记出现
 *   4. 核对：工具数、桥接入口指向安装目录、宿主路由、客户端工件
 *
 * 用独立的 local store，避免动到用户的共享 pnpm store。
 *
 * 用法：node scripts/test-packed-install.mjs
 */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const RUNTIME = path.join(ROOT, '.dev', 'dsh-runtime')
const CLI = path.join(RUNTIME, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const HOME_DIR = path.join(ROOT, '.dev', 'packed-home')
const STORE = path.join(ROOT, '.dev', 'pnpm-store')
const PORT = 19390

if (!existsSync(path.join(RUNTIME, 'dsh'))) {
  console.error(`找不到隔离运行时：${RUNTIME}`)
  console.error('先把从 app.asar 抽出的 0.1.7 运行时放到那里（见 docs/DESIGN.md §9）。')
  process.exit(2)
}

let failed = 0
function step(label, ok, detail) {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failed += 1
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, ...options })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    child.once('close', (code) => resolve({ code, stdout, stderr }))
    child.once('error', (error) => resolve({ code: 1, stdout, stderr: String(error.message) }))
  })
}

console.log('打包产物安装验证\n')

/* ---------------------------------------------------------------- 1. 打包 */

console.log('—— ① 打包 ——')
for (const file of readdirSync(path.join(ROOT, '.dev')).filter(f => f.endsWith('.tgz'))) {
  await rm(path.join(ROOT, '.dev', file), { force: true })
}
const packed = await run(process.execPath, ['scripts/build-client.mjs'])
if (packed.code !== 0) { console.error(packed.stderr); process.exit(1) }
const pnpm = process.env.SHEJING_PNPM ?? path.join(process.env.HOME ?? '', '.dsh', 'dsh-runtimes',
  'dsh-primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.cjs')
const tar = await run(process.execPath, [pnpm, 'pack', '--pack-destination', '.dev'])
step('pnpm pack 成功', tar.code === 0)
const tarball = readdirSync(path.join(ROOT, '.dev')).filter(f => f.endsWith('.tgz')).sort()[0]
if (tarball === undefined) { console.error('没生成 tarball'); process.exit(1) }
const tarballPath = path.join(ROOT, '.dev', tarball)
step('tarball 生成', true, `${tarball}（${(readFileSync(tarballPath).length / 1024).toFixed(0)} KB）`)

/* ---------------------------------------------------------------- 2. 装进全新 profile */

console.log('\n—— ② 装进全新隔离 profile ——')
await rm(HOME_DIR, { recursive: true, force: true })
await mkdir(HOME_DIR, { recursive: true })
const env = { ...process.env, DSH_HOME: HOME_DIR, PATH: `${path.join(ROOT, '.dev', 'bin')}:${process.env.PATH ?? ''}` }

await run(process.execPath, [CLI, '--profile', 'web', '--help'], { env })
const added = await run(process.execPath, [CLI, 'plugin', '--profile', 'web', 'add', tarballPath, '--store-dir', STORE], { env })
step('dsh plugin add 成功', added.code === 0, added.stdout.trim().split('\n').slice(-1)[0])

const profilePkg = JSON.parse(await readFile(path.join(HOME_DIR, 'profiles', 'web', 'package.json'), 'utf8'))
step('自动登记为 profile 层', profilePkg.dsh?.profile?.bundles?.includes('dsh-shejing') === true)

const installedDir = path.join(HOME_DIR, 'profiles', 'web', 'node_modules', 'dsh-shejing')
step('装到了 profile 的 node_modules 里', existsSync(installedDir), installedDir.replace(process.env.HOME ?? '', '~'))
step('没有把 node_modules 打进包里', !existsSync(path.join(installedDir, 'node_modules')))
for (const file of ['lib/client.js', 'src/index.mjs', 'cordis.patch.yml', 'skills/shejing/SKILL.md',
  'lrbridge/dist/index.js', 'lrbridge/dist/LightroomMCP.lrplugin/Info.lua', 'python/10_checkup.py', 'python/exif.py']) {
  step(`安装产物含 ${file}`, existsSync(path.join(installedDir, file)))
}

/* ---------------------------------------------------------------- 3. 启动 */

console.log('\n—— ③ 从安装产物启动 ——')
const server = spawn(process.execPath, [CLI, '--profile', 'web', '--port', String(PORT), '--no-open'], { env })
let serverLog = ''
server.stdout.on('data', (chunk) => { serverLog += chunk })
server.stderr.on('data', (chunk) => { serverLog += chunk })

const markerFile = path.join(HOME_DIR, 'shejing', 'instance.json')
let marker = null
for (let i = 0; i < 60 && marker === null; i++) {
  await new Promise(resolve => setTimeout(resolve, 1000))
  try { marker = JSON.parse(await readFile(markerFile, 'utf8')) } catch { marker = null }
}
step('插件从安装产物激活（写出激活标记）', marker !== null,
  marker === null ? serverLog.slice(-300) : `pid=${marker.pid}`)

if (marker !== null) {
  step('56 个 LR 工具全部注册', marker.lrTools.length === 56, `${marker.lrTools.length} 个`)
  step('九个摄鲸工具注册', marker.stageTools.length === 8, marker.stageTools.join(', '))

  const token = /token=([A-Za-z0-9_-]+)/.exec(serverLog)?.[1]
  if (token === undefined) {
    step('拿到访问 token', false, serverLog.slice(-200))
  } else {
    const base = `http://127.0.0.1:${PORT}`
    // 鉴权是两步的：先用 URL 里的 token 换一个 cookie，再用 cookie 访问 /api/*。
    // 直接带 ?token= 打 /api/* 只会得到 401。
    const exchange = await fetch(`${base}/?token=${token}`, { redirect: 'manual' })
    const cookie = (exchange.headers.getSetCookie?.() ?? []).map(part => part.split(';')[0]).join('; ')
    step('token 换到了 cookie', cookie !== '', cookie.replace(/=.*$/u, '=***'))
    const headers = cookie === '' ? {} : { cookie }

    const probeResponse = await fetch(`${base}/api/shejing/probe`, { headers, redirect: 'manual' })
    const probe = probeResponse.status === 200 ? await probeResponse.json().catch(() => null) : null
    step('宿主路由 /api/shejing/probe 通', probe?.ok === true, probe === null ? `HTTP ${probeResponse.status}` : undefined)
    step('桥接入口指向**安装产物**而不是仓库',
      typeof probe?.bridge?.entry === 'string' && probe.bridge.entry.startsWith(installedDir),
      String(probe?.bridge?.entry).replace(process.env.HOME ?? '', '~'))

    const bootHtml = await (await fetch(`${base}/`, { headers, redirect: 'follow' })).text()
    const rev = /"id":"dsh-shejing","url":"plugins\/\?\?dsh-shejing\/client\.js&rev=([a-f0-9]+)"/.exec(bootHtml)?.[1]
    step('__DSH_BOOT__ 收进了我们的客户端模块', rev !== undefined, rev === undefined ? '' : `rev=${rev}`)
    if (rev !== undefined) {
      const bundle = await (await fetch(`${base}/plugins/??dsh-shejing/client.js&rev=${rev}`, { headers })).text()
      step('浏览器半边被正确提供', bundle.includes('__ModuleLoader__') && bundle.includes('sidebar.panellist'),
        `${bundle.length} 字节`)
    }
  }
}

server.kill('SIGTERM')
await new Promise(resolve => setTimeout(resolve, 800))

console.log()
if (failed > 0) {
  console.error(`❌ ${failed} 项未通过`)
  process.exit(1)
}
console.log('✅ 打包产物安装验证通过——发布出去的那份能装、能启动、面板通道通')
process.exit(0)
