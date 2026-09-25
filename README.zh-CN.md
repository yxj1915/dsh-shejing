# 摄鲸（dsh-shejing）

一个 [DeepSeek Harness](https://github.com/deepseek-harness) 插件，用 **Adobe Lightroom Classic
自己的渲染引擎与目录数据库**走完一条完整照片工作流：体检 → 剔除 → 整理 → 调色 → 验收 →
归档 → 复盘。

整个设计只有一个目标：**让每一次失误都变成下一次的规则，而不是变成下一次的返工。**

> English docs: [README.md](README.md)

## 为什么会有这个东西

这套流程是从真实事故里长出来的，不是从白板上。其中两次决定了今天的所有设计：

- **25 张照片被整批染成紫红。** 一套曲线参数没做单张验证就直接上了整批。那条曲线的首点
  落在 `(0, y)` 且 `y ≠ 0`，导致 Lightroom 的样条在红/蓝通道上严重发散。诊断加回滚花了十几轮。
- **先调色后剔除，白调了 28 张连拍重复帧。**

所以这个插件里最硬的一条规则——**任何新参数组合必须先在一张上渲染、由你亲眼看过后才能批量**——
不是提示词里的一句话，而是由钩子强制执行、并由 DSH **原生路由给你**的确认。你可以同意；
模型无法伪造你的同意。

## 七个阶段

| 阶段 | 工具 | 门禁 |
|---|---|---|
| 体检 | `shejing_checkup` | —（只读） |
| 剔除 | `shejing_cull` | 标记/移动门禁 |
| 整理 | `shejing_organize` | 不可逆门禁 |
| 调色 | `shejing_grade` | **新参数门禁** |
| 验收 | `shejing_verify` | —（只读） |
| 归档 | `shejing_archive` | 导出确认 |
| 复盘 | `shejing_retro` | 写入确认 |

另有 `shejing_doctor`（自检）与 `shejing_batch_status`（读账本）。

**体检**做连拍分组、组内清晰度与曝光跨度、类型判定（连拍 / 包围曝光 / 疑似焦点堆栈 /
全景）、高光与黑场溢出统计，并生成 contact sheet。它完全不碰 Lightroom——跑在**导入之前**。

**剔除**在源文件夹里建 `可导入/` 与 `非导入/` 并**移动**文件——同盘 rename，瞬时且可逆。
原件永不删除。

**调色**提供三种内置风格（A 暖调电影感 / B 清透日系 / C 浓郁黄昏）或显式参数，逐张建快照
并渲染预览给你看。

## 环境要求

- **macOS**（Windows 尚未验证）
- **DSH 桌面客户端**（Electron 应用）或 `dsh web`
- **Lightroom Classic 开着**，且已加载本插件自带的增效工具
- Node.js ≥ 18（DSH 自带）。**不需要另装 Python**——DSH 自带运行时里已有 Pillow 与 numpy

## 安装

用 DSH 桌面客户端的插件管理器，或者：

```bash
dsh plugin --profile <profile> add dsh-shejing
```

插件把自己注册为 profile 的一层，并自带技能（skill），所以**不需要软链接、不需要往
`~/.dsh/skills` 里拷任何东西**。

**装完必须重启 DSH。** 客户端模块的元数据会缓存到重启为止，只刷新页面不会加载浏览器半边。

第一次使用让模型调 `shejing_doctor`：它会报告 Lightroom 增效工具是否已同步、授权 token
是否存在、桥接端口是否在监听。

## 安全模型

- **未经你同意不改任何东西。** 体检与验收只读。
- **只标记，不删除。** `非导入/` 永久保留；删原件是你的决定，永远不是工具的决定。
- **永不写 `.lrcat`。** Lightroom 目录数据库只读，而且只读副本。所有改动都走 Lightroom
  自己的 API。
- **永不写 `ProcessVersion`**（那会降级照片）。
- **参数门禁没有越权开关。** 验证过的参数组合会进白名单，所以同一套风格不会问你第二次。

## 兼容性

内置的 Lightroom 桥接是 [`@pired/lightroom-mcp`](https://github.com/pired/lightroom-mcp) 的
fork（MIT，上游 [`Automaat/lightroom-mcp`](https://github.com/Automaat/lightroom-mcp)），
带两处修复：本地化色标名、以及 `create_collection` 真正使用 `parent` 参数。
详见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

## 开发

```bash
node scripts/build-client.mjs   # 构建浏览器半边（不需要任何打包工具链）
node scripts/test.mjs           # 插件注册面 + 全部门禁路径 + Python 侧测试
node scripts/regression.mjs <克隆出来的批次目录>   # 真实批次的端到端回归（75 张约 15 分钟）
```

`scripts/regression.mjs` 驱动的是**真实工具实现**，所以覆盖到参数翻译、路径解析、账本写入，
而不只是 Python 脚本。它要求设置 `DSH_HOME`，以免写进你真实的 `~/.dsh`。

设计取舍与理由见 [docs/DESIGN.md](docs/DESIGN.md)。

## 许可

MIT，见 [LICENSE](LICENSE)。
