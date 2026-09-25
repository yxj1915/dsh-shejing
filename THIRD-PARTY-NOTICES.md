# 第三方代码声明

本仓库的 `lrbridge/` 目录**不是本项目的原创代码**，而是从 Lightroom MCP 桥接项目
fork 而来的可分发副本，用于让「摄鲸」插件自带 Lightroom 通道。

## Lightroom MCP（`lrbridge/`）

| | |
|---|---|
| 包名 | `@pired/lightroom-mcp` v3.2.0 |
| 上游 | https://github.com/pired/lightroom-mcp |
| 原始项目 | https://github.com/Automaat/lightroom-mcp |
| 作者 | pired（fork 维护者）、Marcin Skalski（原作者） |
| 许可证 | MIT |

`lrbridge/dist/` 与 `lrbridge/scripts/` 原样取自该项目的发行产物。
本仓库对其 Lua 插件做了两处修改（见下），发行版本号为 3.2.0 的**已打补丁分支**。

### 相对上游的两处修改

| 文件 | 修改 | 原因 |
|---|---|---|
| `dist/LightroomMCP.lrplugin/HandlerOrganization.lua` | 色标名从硬编码英文改为查表（`COLOR_LABEL_NAMES`） | 中文界面下色标集名称是「绿色」而非 `Green`，原实现恒报 `0 photos (N mismatched)` |
| `dist/LightroomMCP.lrplugin/HandlerCollections.lua` | 让 `create_collection` 真正使用 `parent` 参数 | 原实现声明了该参数却在写入时丢弃，导致子收藏夹被建成顶级收藏夹 |

修改前的原件可由上游发行版取得；Lightroom 内安装副本的 `.orig-dsh` 备份同样保留原件。

## 运行时依赖

`@modelcontextprotocol/sdk`（MIT）、`ajv`（MIT），以及二者自身的传递依赖。
均通过 `package.json` 的 `dependencies` 声明，不随仓库分发。
