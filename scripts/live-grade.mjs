/**
 * 真机调色验证（写 → 读回 → 导出 → 还原）。
 *
 * 这是最后一条没被真机验证过的核心路径：所有测试都用假桥接，而调色的三个动作
 * （create_snapshot / set_develop_settings / set_tone_curve）从没在真 Lightroom 上
 * 跑过。
 *
 * **只动已经在目录里、且指向克隆副本的那几张照片**——不新导入任何东西，所以不会
 * 在目录里留下新记录。（`remove_from_catalog` 在当前 SDK 上无法实现，见 gotchas
 * 第 30 条，所以「不留新记录」比「留了再清」重要得多。）
 *
 * 结束时把参数写回中性值，让照片回到原样。
 *
 * 用法：DSH_HOME=<repo>/.dev/dsh-home node scripts/live-grade.mjs
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { LightroomBridge } from '../src/lr/bridge.mjs'

const SELECTOR = 'DSC07243'          // 克隆副本里的一张
const CLONE_MARKER = 'live-pipeline' // 只认这个目录下的记录，绝不碰原片
const EXPORT_DIR_SUFFIX = 'live-grade-export'

let failed = 0
function step(label, ok, detail) {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failed += 1
}

const bridge = new LightroomBridge({ log: (m) => console.log(`     [bridge] ${m}`) })

function parseJsonResult(result) {
  const text = LightroomBridge.toText(result)
  try { return JSON.parse(text) } catch { return null }
}

console.log('真机调色验证（写 → 读回 → 导出 → 还原）\n')

/* ---------------------------------------------------------------- 找目标 */

console.log('—— ① 找一张克隆副本 ——')
const search = await bridge.call('search_photos', { filename: SELECTOR, limit: 10 })
const found = parseJsonResult(search)
const target = (found?.photos ?? []).find(p => String(p.path).includes(CLONE_MARKER))
step('找到克隆副本里的那张（而不是你的原片）', target !== undefined,
  target === undefined ? '没找到' : target.path)
if (target === undefined) {
  await bridge.close()
  process.exit(2)
}
const photoId = target.id
const photoPath = target.path

/* ---------------------------------------------------------------- 读基线 */

console.log('\n—— ② 读基线 ——')
const beforeText = LightroomBridge.toText(await bridge.call('get_develop_settings', { photo_id: photoId, fields: 'all' }))
const before = (() => { try { return JSON.parse(beforeText) } catch { return null } })()
const beforeContrast = Number(before?.settings?.Contrast2012 ?? before?.Contrast2012 ?? NaN)
step('读得到调色参数', Number.isFinite(beforeContrast), `Contrast2012 = ${beforeContrast}`)
const processVersion = before?.settings?.ProcessVersion ?? before?.ProcessVersion
step('确认了 ProcessVersion（后续绝不写它）', processVersion !== undefined, String(processVersion))

/* ---------------------------------------------------------------- 写 */

console.log('\n—— ③ 写入风格 A（单张）——')
const snapshotName = '摄鲸·真机验证'
const snap = await bridge.call('create_snapshot', { photo_id: photoId, name: snapshotName })
step('建了快照（可回滚的检查点）', LightroomBridge.toText(snap).length > 0, snapshotName)

const styleSettings = {
  Contrast2012: 14, Highlights2012: -42, Shadows2012: 26, Whites2012: 5, Blacks2012: -12,
  Texture: 8, Clarity2012: 12, Dehaze: 8, Vibrance: 18, Saturation: -3,
  PostCropVignetteAmount: -12, PostCropVignetteFeather: 65, PostCropVignetteMidpoint: 45,
}
const wrote = await bridge.call('set_develop_settings', { photo_id: photoId, settings: styleSettings })
step('set_develop_settings 有回应', LightroomBridge.toText(wrote).length > 0,
  LightroomBridge.toText(wrote).replace(/\s+/g, ' ').slice(0, 80))

// 曲线首点必须是 (0,0)——gotcha #24 的防御要真的下发到真机
const curve = await bridge.call('set_tone_curve', {
  photo_id: photoId, channel: 'main', points: [[0, 0], [64, 70], [192, 196]],
})
step('set_tone_curve 有回应', LightroomBridge.toText(curve).length > 0)

/* ---------------------------------------------------------------- 读回复核 */

console.log('\n—— ④ 独立复核（不信返回值，读回为准）——')
const afterText = LightroomBridge.toText(await bridge.call('get_develop_settings', { photo_id: photoId, fields: 'all' }))
const after = (() => { try { return JSON.parse(afterText) } catch { return null } })()
const afterContrast = Number(after?.settings?.Contrast2012 ?? after?.Contrast2012 ?? NaN)
step('读回 Contrast2012 = 14', afterContrast === 14, `读回 ${afterContrast}`)
const afterVibrance = Number(after?.settings?.Vibrance ?? after?.Vibrance ?? NaN)
step('读回 Vibrance = 18', afterVibrance === 18, `读回 ${afterVibrance}`)
step('ProcessVersion 没被改动',
  (after?.settings?.ProcessVersion ?? after?.ProcessVersion) === processVersion,
  `仍是 ${after?.settings?.ProcessVersion ?? after?.ProcessVersion}`)

const preview = await bridge.call('get_photo_preview', { photo_id: photoId, size: 'medium' })
const previewPath = preview?.structuredContent?.file_path
step('渲染出预览并落到磁盘', typeof previewPath === 'string' && existsSync(previewPath), String(previewPath))

/* ---------------------------------------------------------------- 导出 */

console.log('\n—— ⑤ 真的导出这张 ——')
const exportDir = path.join(path.dirname(photoPath), EXPORT_DIR_SUFFIX)
// 真实 Lightroom 要求导出目标目录**已经存在**，否则报
//   <AgErrorText>缺少此操作的目标文件夹
// shejing_archive 里有 ensureDir(dest)，所以产品代码不受影响；这里补上是为了
// 让这个脚本自己能跑通。
const { mkdirSync } = await import('node:fs')
mkdirSync(exportDir, { recursive: true })
const exported = await bridge.call('export_photos', {
  photo_ids: [photoId], destination: exportDir, format: 'jpeg', quality: 100, on_existing: 'overwrite',
})
step('export_photos 有回应', LightroomBridge.toText(exported).length > 0,
  LightroomBridge.toText(exported).replace(/\s+/g, ' ').slice(0, 90))
const { readdirSync } = await import('node:fs')
const exportedFiles = existsSync(exportDir) ? readdirSync(exportDir) : []
step('目标目录里真的有文件', exportedFiles.length > 0, exportedFiles.join(', '))

/* ---------------------------------------------------------------- 还原 */

console.log('\n—— ⑥ 还原为中性（不留改动）——')
const neutral = {
  Contrast2012: 0, Highlights2012: 0, Shadows2012: 0, Whites2012: 0, Blacks2012: 0,
  Texture: 0, Clarity2012: 0, Dehaze: 0, Vibrance: 0, Saturation: 0,
  PostCropVignetteAmount: 0, PostCropVignetteFeather: 50, PostCropVignetteMidpoint: 50,
}
await bridge.call('set_develop_settings', { photo_id: photoId, settings: neutral })
// 你自己的 gotcha #23：reset_develop 是静默 no-op，所以显式写中性曲线。
await bridge.call('set_tone_curve', { photo_id: photoId, channel: 'main', points: [[128, 128]] })

const restoredText = LightroomBridge.toText(await bridge.call('get_develop_settings', { photo_id: photoId, fields: 'all' }))
const restored = (() => { try { return JSON.parse(restoredText) } catch { return null } })()
const restoredContrast = Number(restored?.settings?.Contrast2012 ?? restored?.Contrast2012 ?? NaN)
step('Contrast2012 已回到 0', restoredContrast === 0, `读回 ${restoredContrast}`)
step('ProcessVersion 仍未被改动',
  (restored?.settings?.ProcessVersion ?? restored?.ProcessVersion) === processVersion)

await bridge.close()

console.log()
console.log('说明：没有新导入任何照片，所以目录里没有新增记录；')
console.log('      那张克隆副本的参数已写回中性。快照「%s」留着，可作检查点。', snapshotName)
console.log(`      导出的测试文件在：${exportDir}（可整目录删掉）`)
console.log()
if (failed > 0) {
  console.error(`❌ ${failed} 项未通过`)
  process.exit(1)
}
console.log('✅ 真机调色验证通过')
process.exit(0)
