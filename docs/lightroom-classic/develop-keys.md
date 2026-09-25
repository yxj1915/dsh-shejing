# Lightroom develop 键名与调色方法

## 1. `set_develop_settings` 的 allowlist（实测 82 键）

从 `schema set_develop_settings` 直接导出。**不在这个表里的键写不进去。**

```
# 白平衡
WhiteBalance  Temperature  Tint
# 基础（2012 版控件）
Exposure2012  Contrast2012  Highlights2012  Shadows2012  Whites2012  Blacks2012
Texture  Clarity2012  Dehaze  Vibrance  Saturation
# HSL
SaturationAdjustment{Red,Orange,Yellow,Green,Aqua,Blue,Purple,Magenta}
HueAdjustment{Red,Orange,Yellow,Green,Aqua,Blue,Purple,Magenta}
LuminanceAdjustment{Red,Orange,Yellow,Green,Aqua,Blue,Purple,Magenta}
# 参数曲线
ParametricShadows  ParametricDarks  ParametricLights  ParametricHighlights
ParametricShadowSplit  ParametricMidtoneSplit  ParametricHighlightSplit
# 点曲线
ToneCurvePV2012  ToneCurvePV2012Red  ToneCurvePV2012Green  ToneCurvePV2012Blue
ToneCurveName2012
# 黑白与锐化 / 降噪
ConvertToGrayscale  Sharpness  SharpenRadius  SharpenDetail  SharpenEdgeMasking
LuminanceSmoothing  LuminanceNoiseReductionDetail  LuminanceNoiseReductionContrast
ColorNoiseReduction  ColorNoiseReductionDetail  ColorNoiseReductionSmoothness
# 镜头与透视
LensProfileEnable  LensManualDistortionAmount
PerspectiveVertical  PerspectiveHorizontal  PerspectiveRotate  PerspectiveScale
PerspectiveAspect  PerspectiveUpright
# 效果
PostCropVignetteAmount  PostCropVignetteMidpoint  PostCropVignetteRoundness
PostCropVignetteFeather  PostCropVignetteStyle
GrainAmount  GrainSize  GrainFrequency
# 裁剪
CropTop  CropLeft  CropBottom  CropRight  CropAngle
```

### 不存在的键（重要）

| 想做的事 | 状况 |
|---|---|
| 分离色调 / 颜色分级 | **`ColorGrade*` 和 `SplitToning*` 都不在 allowlist** → 只能用每通道点曲线代替 |
| 写 `ProcessVersion` | 技术上可写，但**千万别写**：这些照片是 `15.4`，写死会降级 |

冷暖分离的替代实现（这也是本次采用的做法）：

```json
// 暖高光 + 冷暗部：蓝通道提暗部、压高光；红通道反向微调
{"channel":"blue","points":[[64,74],[192,184]]}
{"channel":"red", "points":[[64,60],[192,196]]}
```

点曲线语义：y > x 提亮，y < x 压暗。工具会自动补 `(0,0)` 和 `(255,255)`，
x 必须严格递增，值域 0–255。

```bash
python3 scripts/lrclient.py call set_tone_curve \
  '{"photo_id":181417,"channel":"main","points":[[40,33],[128,132],[202,210]]}'
python3 scripts/lrclient.py call get_tone_curve '{"photo_id":181417}'
```

## 2. 调色的正确顺序

1. `create_snapshot` 建检查点（只能建、不能列表/回滚，回滚靠用户点 Snapshots 面板）
2. `get_develop_settings {"fields":"all"}` 读基线，**确认 `ProcessVersion`**
3. `set_develop_settings` 写滑杆 → `set_tone_curve` 写曲线（两者分开调用）
4. `get_photo_preview {"size":"large"}` 渲染，**看图验收**
5. 满意后再推广到其他照片（`copy_develop_settings` 或逐张 set）

## 3. 三种风格参数（Lightroom 原生单位，实测可用）

`Exposure2012` 单位是 EV；其余是 Lightroom 的 −100..100 刻度。

| 键 | A 暖调电影感 | B 清透日系 | C 浓郁黄昏 |
|---|---|---|---|
| Contrast2012 | 14 | −6 | 26 |
| Highlights2012 | −42 | −32 | −48 |
| Shadows2012 | 26 | 38 | 18 |
| Whites2012 | 5 | 12 | 4 |
| Blacks2012 | −12 | 8 | −16 |
| Texture | 8 | −4 | 10 |
| Clarity2012 | 12 | −4 | 18 |
| Dehaze | 8 | −6 | 10 |
| Vibrance | 18 | 8 | 22 |
| Saturation | −3 | −2 | 4 |
| 主曲线 | `[[40,33],[128,132],[202,210]]` | `[[0,8],[64,70],[192,196]]` | `[[32,26],[128,132],[208,216]]` |
| 红通道 | `[[64,60],[192,196]]` | `[[0,2],[128,129]]` | `[[128,134]]` |
| 蓝通道 | `[[64,74],[192,184]]` | `[[0,4],[128,126]]` | `[[64,6],[128,120]]` |
| 暗角 | −12 / feather 65 / mid 45 | 0 | −22 / feather 60 / mid 40 |

**按题材选**：城市/建筑→A；云彩天空/正午→B；落日/篝火/剪影→C。

## 4. 按测量结果微调（可选）

想更精细时，可先用 `sips` 低分辨率解码测亮度分布（不用于出图，只用于定参数）：

- `p95 > 0.96` 或高光溢出 > 2% → `Highlights2012` 再 −12，`Exposure2012` −0.10
- `mean_luma < 0.28` → `Shadows2012` +12，`Exposure2012` +0.18
- `mean_luma > 0.58` 且 `std < 0.20` → `Contrast2012` +8，`Blacks2012` −6
- `mean_sat < 0.13` → `Vibrance` +10
- `std < 0.16` 且 `p05 > 0.10`（雾霾感）→ `Dehaze` +8

```bash
sips -s format jpeg --resampleWidth 1000 in.ARW --out /tmp/m.jpg
```
