/**
 * 把浏览器半边包成 DSH 客户端模块表认识的形状。
 *
 * DSH 的客户端模块表用一段**闭包工厂**装载第三方包的浏览器半边：
 *
 *   window.__ModuleLoader__.load({ id: "<包名>", factory: (require) => {
 *     var module = { exports: {} }; var exports = module.exports;
 *     ...包自己的 CJS 代码...
 *     return module.exports; } });
 *
 * 仓库内的打包预设（packages/client/tsdown.client.ts）没有发布到 npm，所以
 * 外部包必须自己复现这个形状。这里刻意**不引入任何构建工具**：源码本身就是
 * CJS，这个脚本只做一次确定性的字符串包装。少一个工具链就少一处会坏的地方。
 *
 * 用法：node scripts/build-client.mjs
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'))

const sourceFile = path.join(ROOT, 'src', 'client', 'index.js')
const outFile = path.join(ROOT, 'lib', 'client.js')

const id = pkg.name
if (typeof id !== 'string' || id === '') throw new Error('package.json 缺少 name')

const header = `/* ${id} — 浏览器半边。由 scripts/build-client.mjs 生成，请改 src/client/index.js。 */`
const banner = `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`
const prelude = 'var module = { exports: {} }; var exports = module.exports;'
const footer = 'return module.exports; } });'

const source = await readFile(sourceFile, 'utf8')
// 源里可能有 sourceMappingURL 之类的尾注，包进函数体前去掉。
const body = source.replace(/\n?\/\/# sourceMappingURL=.*$/mu, '').replace(/\s+$/u, '')

const bundled = [header, banner, prelude, body, footer, ''].join('\n')

await mkdir(path.dirname(outFile), { recursive: true })
await writeFile(outFile, bundled, 'utf8')

const lines = bundled.split('\n').length
console.log(`built ${path.relative(ROOT, outFile)}  (${id}, ${bundled.length} bytes, ${lines} lines)`)
