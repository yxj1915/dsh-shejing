/**
 * 填上 GitHub 用户名，让发布变成一条命令。
 *
 * 用法：
 *   node scripts/setup-github.mjs <用户名>            # 写入并检查
 *   node scripts/setup-github.mjs <用户名> --check     # 只检查，不改文件
 *
 * 做三件事：
 *   1. 把 package.json 里的 REPLACE_ME 占位符换掉（homepage / repository）
 *   2. 检查 npm 上这个包名是否已被占用（不占用的好名字越早确认越好）
 *   3. 报告还差什么才能发布
 */

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const checkOnly = process.argv.includes('--check')
const user = process.argv[2]

if (user === undefined || user === '' || user.startsWith('--')) {
  console.error('用法：node scripts/setup-github.mjs <GitHub 用户名> [--check]')
  process.exit(2)
}
if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(user)) {
  console.error(`「${user}」不像合法的 GitHub 用户名（字母/数字/连字符，不能以连字符开头）。`)
  process.exit(2)
}

const pkgFile = path.join(ROOT, 'package.json')
const pkg = JSON.parse(await readFile(pkgFile, 'utf8'))
const repoUrl = `git+https://github.com/${user}/${pkg.name}.git`
const homeUrl = `https://github.com/${user}/${pkg.name}#readme`

console.log(`包名：${pkg.name}   版本：${pkg.version}`)
console.log(`仓库：https://github.com/${user}/${pkg.name}\n`)

/* ---------------------------------------------------------------- 1. 包名是否被占 */

console.log('—— npm 包名检查 ——')
let nameFree = null
try {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}`, {
    signal: AbortSignal.timeout(15_000),
  })
  if (response.status === 404) {
    nameFree = true
    console.log(`  ✅ ${pkg.name} 在 npm 上还没被占用`)
  } else if (response.ok) {
    const data = await response.json()
    nameFree = false
    console.log(`  ⚠️ ${pkg.name} 已被占用（latest: ${data['dist-tags']?.latest ?? '?'}，`
      + `维护者：${(data.maintainers ?? []).map(m => m.name).join(', ') || '?'}）`)
    console.log('     要么换名字，要么确认那是你自己的包。')
  } else {
    console.log(`  ？ 无法判断（HTTP ${response.status}）`)
  }
} catch (error) {
  console.log(`  ？ 无法判断（${error?.message ?? error}）——离线也能继续，发布前再确认一次。`)
}

/* ---------------------------------------------------------------- 2. 写入配置 */

const needsUpdate = pkg.homepage !== homeUrl
  || pkg.repository?.url !== repoUrl
  || pkg.private === true

console.log('\n—— package.json ——')
if (!needsUpdate) {
  console.log('  ✅ 已经填好了')
} else if (checkOnly) {
  console.log('  （--check：不修改。需要写：homepage / repository，并去掉 private:true）')
} else {
  pkg.homepage = homeUrl
  pkg.repository = { type: 'git', url: repoUrl }
  // npm 拒绝发布 private 包；发布前必须去掉。
  delete pkg.private
  await writeFile(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
  console.log('  ✅ 已写入 homepage / repository，并去掉了 private:true')
}

/* ---------------------------------------------------------------- 3. 还差什么 */

console.log('\n—— 发布前还剩 ——')
const pkgNow = JSON.parse(await readFile(pkgFile, 'utf8'))
const remaining = []
if (pkgNow.private === true) remaining.push('package.json 里还有 private:true（npm 会拒绝发布）')
if (String(pkgNow.homepage ?? '').includes('REPLACE_ME')) remaining.push('homepage 还是占位符')
if (String(pkgNow.repository?.url ?? '').includes('REPLACE_ME')) remaining.push('repository 还是占位符')
if (nameFree === false) remaining.push('npm 包名已被占用，需要改名或确认归属')

if (remaining.length === 0) {
  console.log('  代码侧没有阻塞项了。剩下的是账号动作：')
  console.log('    1. npm login                     # 必须开 2FA')
  console.log(`    2. npm publish --tag next        # 发 ${pkg.version}-rc.1 这类预发布，不占 latest`)
  console.log('    3. 桌面客户端 → 插件管理器 → Add → 填包名 → 重启客户端')
  console.log('    4. 验收通过后再 npm publish（占 latest）并转公开仓库')
} else {
  for (const item of remaining) console.log(`  · ${item}`)
}

console.log('\n完整流程见 docs/PUBLISHING.md。')
