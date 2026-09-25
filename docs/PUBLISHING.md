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

# 打包产物安装验证：把包真的装进一个全新 profile 再启动（约 60 秒，需要联网）
$NODE scripts/test-packed-install.mjs
```

**`test-packed-install.mjs` 是发布前的最后一道闸。** 其余所有测试跑的都是仓库里的
**软链版**——路径长什么样、哪些文件真被打进包里、`import.meta.url` 在安装位置还对不对，
这些只有真的装一遍才知道。它会：
pack → `dsh plugin add` 进全新隔离 profile → 启动 → 核对工具数、桥接入口是否指向
安装目录、`/api/shejing/probe` 是否通、客户端工件是否被正确提供。

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
# 这台机器 PATH 上没有 node，prepublishOnly 需要它 —— 脚本里已经包好了。
# 发布必须有 2FA 验证码（registry 的规则：验证码，或带 bypass-2FA 的 token）。

./scripts/publish.sh <6位验证码>        # 码已经在你手里时用这条
./scripts/publish.sh                    # 在终端里跑，让 pnpm 自己提示验证码
```

验证码 30 秒过期，过期了重跑一次即可（registry 不会因为过期码记一笔）。

发布凭据在这台机器上的位置：`~/Library/Preferences/pnpm/auth.ini`，
键为 `//registry.npmjs.org/:_authToken`。那是 `pnpm login` 的网页登录会话 token，
**不足以发布**——发布仍需现场验证码。

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

## 5. 以后怎么发（CI + OIDC，不带长期密钥）

仓库里已经放了两个 workflow：

| 文件 | 作用 |
|---|---|
| `.github/workflows/ci.yml` | push / PR 时跑六套测试 + 校验打包内容 |
| `.github/workflows/publish.yml` | 手动或随 Release 触发，用 **trusted publishing (OIDC)** 发布 |

**为什么不用 token**：npm 已在 2026 年 8 月限制带 bypass-2FA 的 granular token
做账号与包管理操作，并计划于 2027 年 1 月取消它「直接发布」的能力，改成
「暂存 + 人工 2FA 批准」。官方给的正路就是 OIDC 或 staged publishing。
见 [2026-07-08 公告](https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/)。

**首次使用前要在 npmjs.com 上配置 trusted publisher**：
Package → Settings → Trusted publishing → 添加 GitHub 仓库

```
组织/用户：yxj1915
仓库：dsh-shejing
Workflow 文件名：publish.yml
环境：release
```

（环境名要与 `publish.yml` 里的 `environment: release` 一致；不想用环境就两边一起删。）

之后无论手动 `workflow_dispatch` 还是发一个 GitHub Release，都会走 OIDC 发布，
**仓库里不需要存任何密钥**。

## 6. 打包器对新默认值的适配（npm v12）

npm v12 起，`npm install` 的这几项默认变成「不自动做」：

| 项 | 新默认 | 我们的情况 |
|---|---|---|
| `allowScripts` | 关 | 我们**没有任何安装期脚本**，消费者装包时什么都不会跑 |
| `--allow-git` | none | 没有 git 依赖 |
| `--allow-remote` | none | 没有远程 URL 依赖 |

这是刻意设计的：桥接的启动路径用 `import.meta.url` 相对定位，**不靠 `postinstall`
去写一个写死路径的启动器**。打包产物安装验证（`scripts/test-packed-install.mjs`）
专门断言「桥接入口指向安装目录」，就是在守这条。

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
