# 发布流程

从「代码就绪」到「别人能用」，一共四步。前两步在本机，后两步需要账号。

## 0. 你需要先有的东西

| | 地址 | 拿什么 |
|---|---|---|
| GitHub 账号 | github.com/signup | 用户名 |
| npm 账号 | npmjs.com/signup | 用户名 + **2FA 或带 bypass-2FA 的 granular token** |

> npm 现在**发布必须有 2FA**，或者一个带 bypass-2FA 的 granular access token
> （[npm 文档](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification)）。
> 推荐直接开 2FA——CLI 会提示你按 Touch ID 或输一次性密码。

## 1. 本地预检（不需要账号）

```bash
# 用 DSH 自带的 node
NODE=~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node

# 全绿才算过：插件注册面 + 门禁 + 浏览器半边渲染 + Python 分组算法
$NODE scripts/test.mjs

# 真实批次的端到端回归（约 7 分钟，需要一份克隆出来的批次）
DSH_HOME=$PWD/.dev/dsh-home $NODE scripts/regression.mjs <批次目录>

# 打包检查：内容齐全、没有 node_modules 泄漏
$NODE ~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.cjs pack --pack-destination .dev
tar -tzf .dev/dsh-shejing-*.tgz | head -20
```

**桌面客户端的加载验证只能在发布之后做**——GUI 插件管理器只接受注册表上的包名，
会拒绝本地路径。所以顺序是：先发一个预发布版本，装进桌面端，确认面板能加载，再发正式版。

## 1.5 真机检查（需要 Lightroom，但**不需要账号**）

上面所有自动化测试都用**假桥接**，测的是「我们自己的 MCP 客户端」。而
「我们的客户端 ↔ 真 bridge ↔ Lightroom 里的 Lua 插件」这条链只有真机能验。

先打开 Adobe Lightroom Classic（等它加载完增效工具，约 1.5 分钟），然后在
文件 ▸ 增效工具管理器 ▸ Lightroom MCP 里点 Start Server。之后：

```bash
DSH_HOME=$PWD/.dev/dsh-home $NODE scripts/live-check.mjs
```

**全程只读**：只做搜索、读参数、取预览，不导入、不调色、不改目录数据库。
它会逐项报告环境与链路，任何一步不通都给出可执行的恢复顺序。

## 2. 发预发布版本到 npm

先把 `package.json` 里两处占位符换成真实地址：

```json
"homepage": "https://github.com/<用户名>/dsh-shejing#readme",
"repository": { "type": "git", "url": "git+https://github.com/<用户名>/dsh-shejing.git" }
```

`private: true` 必须去掉（npm 拒绝发布 private 包）。

```bash
npm login                  # 或 npm adduser
npm publish --tag next     # 预发布：不会占用 latest
```

## 3. 桌面客户端验证

1. 打开 DSH 桌面客户端 → 插件管理器 → Add → 填 `dsh-shejing@0.1.0-rc.1`
2. **重启客户端**（客户端模块的元数据缓存到重启为止，刷新页面不够）
3. 侧边栏应出现鲸鱼图标 +「摄鲸」；点进去有四个标签页
4. 让模型调 `shejing_doctor`，确认 Lightroom 链路

若启动失败，回滚：

```bash
dsh plugin --profile desktop remove dsh-shejing
```

（`desktop` profile 由 Electron 应用独占管理，CLI 会拒绝直接安装——所以桌面端**只能**
走 GUI 的 Add 表单。真要手改，见 `~/.dsh/profiles/desktop/package.json`。）

## 4. GitHub 仓库与正式版

```bash
git remote add origin git@github.com:<用户名>/dsh-shejing.git
git push -u origin main
```

仓库先建**私有**。桌面端验收通过后再转公开，然后发正式版：

```bash
npm publish                # 去掉 --tag next，占 latest
```

## 发布内容是什么

`npm pack` 会包含（见 `package.json` 的 `files`）：

```
src/                 宿主半边（Cordis 插件：工具、门禁、路由、技能注册、LR 桥接客户端）
lib/client.js        浏览器半边（构建产物，由 scripts/build-client.mjs 从 src/client/ 生成）
lrbridge/            Lightroom 通道：Node MCP 桥接 + 27 个 Lua 文件（已打补丁）
python/              七个阶段的 Python 脚本 + exif.py
skills/shejing/      SKILL.md 与 references（插件启动时注册给 DSH）
docs/                设计说明 + lightroom-classic 的 gotcha / 参数表
cordis.patch.yml     profile 层：把插件挂上去
```

`node_modules/` 从不进包（npm 默认排除）；运行时依赖由 `dependencies` 声明
（`@modelcontextprotocol/sdk`、`ajv`）。

## 版本号怎么走

- 插件改了 `python/` 或 `lrbridge/` → patch
- 加了工具/面板/门禁 → minor
- 改了门禁语义或账本格式 → major（用户的账本与白名单会受影响）
