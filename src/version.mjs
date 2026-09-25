/**
 * 插件版本 —— 只从**包自己的 package.json** 读。
 *
 * 为什么不用 `process.env.npm_package_version`：那个变量只在 npm/pnpm 执行脚本时
 * 存在，而插件是在 DSH 进程里跑的，永远拿不到它——于是版本号会静默回退到硬编码的
 * 字面量，改了版本号也不生效。面板上显示一个错版本，是那种「不影响功能所以没人发现」
 * 的偏差。
 *
 * 相对本文件定位，所以在安装产物里同样正确。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const PACKAGE_JSON = fileURLToPath(new URL('../package.json', import.meta.url))

function load() {
  try {
    const parsed = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'))
    return typeof parsed.version === 'string' && parsed.version !== '' ? parsed.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** 当前插件版本。 */
export const PLUGIN_VERSION = load()
