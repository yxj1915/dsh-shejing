---
name: lightroom-classic
description: >-
  用 Lightroom Classic 本体（它自己的渲染引擎与目录数据库）对照片调色和做目录管理：
  导入、develop 调色、关键词、星级、色标、收藏夹、快照、导出。
  通过一个自带的 Node MCP 桥 + Lightroom 内的 Lua 插件驱动，不直接改 .lrcat。
  当用户提到 Lightroom、要调色/修图、要管理照片目录，或提到 .lrcat / ARW / RAW 批处理时使用。
whenToUse: >-
  用户要求用 Lightroom 调色或修图；要求导入照片、按题材打关键词、设星级/色标、建收藏夹；
  要求看某张照片的调色预览或对比；要求批量处理相机 RAW（ARW/CR2/NEF…）；
  或需要查询 Lightroom 目录里有哪些照片、收藏夹、关键词。
---

# Lightroom Classic 调色与目录管理（lightroom-classic）

工具链**已随本 skill 自带**（在 `scripts/` 与 `server/`），Lightroom 内的 Lua 插件已装好。
不需要重新安装，不需要 MCP 客户端，不需要联网。

架构：

```
scripts/lrclient.py ──JSON-RPC over stdio──▶ server/dist/index.js (node)
                                                 │ TCP 127.0.0.1:58763/58764（令牌鉴权）
                                                 ▼
                              Lightroom 内 LightroomMCP.lrplugin ──▶ 照片与目录
```

## 0. 开工前必做

```bash
cd <本 skill 的 scripts 目录>          # 或任意工作区，路径写全即可
python3 lrclient.py doctor             # 体检整条链路
python3 lrclient.py wait 300           # 若端口未监听，等插件连上（最长 300s）
```

`doctor` 会逐项检查插件、端口、token、server、端到端调用。**先跑它，别猜。**
若端口不通，按 doctor 打印的顺序恢复：Start Server → Reload Plug-in → 重启 Lightroom。

## 1. ⚠️ 可靠性铁律（两条，都是实测踩出来的）

**1) 要长连接，不要频繁新建。** 每次 `lrclient.py call` 都会新起一个 node 进程、连上再断开。
高频这样调用会**把插件的 socket 重绑循环打坏**（端口全关、日志不再 rebind）。
→ 优先在**一个 Python 进程里连续调用**：

```python
import sys; sys.path.insert(0, "<skill>/scripts")
from lrclient import MCPClient
c = MCPClient(); c.initialize()
ok, text, st = c.call("search_photos", {"limit": 20})
# ... 继续调用任意多次 ...
c.close()
```

或起一个 `python3 lrclient.py repl` 长驻进程（stdin 每行一个 `{"tool","args"}`）。
单次调试才用一次性 `call`。

**2) 不要只信返回值。** `ok`/`success` 可能是假的（有些 handler 失败时只写
`success:false` 而不设 `isError`）。**关键改动一律用独立手段复核**：
`get_develop_settings` 读回、`get_photo_preview` 看图、或直接查目录数据库副本
（见 `references/gotchas.md` 的 E 节）。

## 2. 常用命令

```bash
python3 lrclient.py tools                    # 56 个工具
python3 lrclient.py schema set_develop_settings
python3 lrclient.py call get_photo_status '{"photo_ids":[181417]}'
python3 lrclient.py call search_photos '{"limit":50}'
python3 lrclient.py batch my_batch.json      # [{"tool":..,"args":{..}}, ...]
```

主要工具：

| 用途 | 工具 |
|---|---|
| 找照片 | `search_photos`（按文件名/关键词/星级/日期）、`get_selected_photos`、`list_folders` |
| 导入 | `import_photos`（**只传 `source_path` 不传 `copy_to` 才是原地引用**） |
| 调色 | `set_develop_settings`、`set_tone_curve`/`get_tone_curve`、`apply_auto` |
| 看图验收 | `get_photo_preview`（渲染带当前编辑的 JPEG，**务必看**） |
| 非破坏 | `create_snapshot`、`create_virtual_copies`、`reset_develop` |
| 管理 | `set_keywords`、`set_rating`、`set_color_label`、`set_flags`、`batch_metadata` |
| 组织 | `create_collection`、`create_collection_set`、`create_smart_collection`、`add_to_collection` |
| 其他 | `export_photos`、`add_ai_mask`、`add_local_adjustment`、`rotate_photo` |

## 3. 标准工作流

### 调色

1. `search_photos` 拿 photo id（`id` 与数据库 `id_local` 一致）
2. `create_snapshot` 建检查点
3. `get_develop_settings {"fields":"all"}` 读基线，**确认 `ProcessVersion`**（后续绝不写它）
4. `set_develop_settings` 写滑杆 → `set_tone_curve` 写曲线（分开调用）
5. `get_photo_preview {"size":"large"}` → **用 read_image 看图**
6. 不满意就改参数重渲染；满意后再推广（`copy_develop_settings`）
7. **先在一张上定稿再批量**（预览闸门），别一上来就套 100 张

三种现成风格的完整参数见 `references/develop-keys.md` 第 3 节。
→ 城市/建筑用 A 暖调电影感；云彩天空/正午用 B 清透日系；落日/篝火/剪影用 C 浓郁黄昏。

### 目录管理

关键词按**题材**分组批量调用（相同题材合成一次，减少往返）：

```python
from lrclient import MCPClient
c = MCPClient(); c.initialize()
for kws, names in {("2024","城市风光","日落黄昏"): ["DSC01424","DSC01428"],
                   ("2024","自然风光","云彩"):     ["DSC01443"]}.items():
    ids = [MAP[n] for n in names]           # MAP: 文件名 -> photo id
    c.call("set_keywords", {"photo_ids": ids, "add_keywords": list(kws)})
c.close()
```

**色标用工作流语义**（绿=已调色、黄=待调色），比随便配色有用。
⚠️ 色标写入前先确认色标集名称，见第 4 节。

### 验证（必做）

`manage.py` 那种"批量改完"的场景，收尾一律查数据库副本核对，不要只看返回值。

## 4. 色标：本环境有已知 bug，已附带补丁

中文界面下 `set_color_label` 原本恒报 `0 photos (N mismatched)`，根因是
插件硬编码英文名（`Green`），而**中文色标集的实际名称是 `绿色`**；且
`setRawMetadata('label', X)` 会**原样存储任意字符串**、不校验。

修复补丁（幂等、含 Lua 语法校验、可还原）：

```bash
python3 scripts/patch_colorlabel.py                     # 打补丁到已安装插件
python3 scripts/patch_colorlabel.py --restore           # 还原
python3 scripts/patch_colorlabel.py <插件路径> --check-only
```

补丁把名称收在文件顶部 `COLOR_LABEL_NAMES`。**换界面语言或色标集时改那张表**：
英文界面用 `Red/Yellow/Green/Blue/Purple`。

改完插件 Lua 需在 Lightroom 里 **Reload Plug-in** 才生效。

另：**该环境的色标读回接口是坏的**（对用户手工用 UI 设的色标也返回 `gray`），
所以校验色标只能查数据库或看界面。

## 5. 详细资料

| 文件 | 内容 |
|---|---|
| `references/gotchas.md` | 20 条实测踩坑（网络、沙箱、插件、连接、调色、色标、数据库核对），**遇到问题先查这里** |
| `references/develop-keys.md` | 82 键 allowlist、缺失的键、三种风格完整参数、按测量微调的方法 |

## 6. 硬性约束

- **永远不要写 `.lrcat`**。Lightroom 开着时直写必然损坏。只读副本可以随便查。
- **绝不写 `ProcessVersion`**（会降级照片；先读基线确认版本）。
- **不复制/移动用户原片**，除非用户明确要求（`import_photos` 不传 `copy_to`）。
- 修改目录内容前先 `create_snapshot` 或确认有目录备份。
- 破坏性操作（`remove_from_catalog`）先问用户。
