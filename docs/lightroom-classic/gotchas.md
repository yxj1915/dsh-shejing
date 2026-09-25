# 踩坑清单（每条都在 macOS Lightroom Classic 15.5 上实测过）

## A. 环境与网络

1. **GitHub DNS 被封**：`github.com` 超时、`raw.githubusercontent.com` 解析失败。
   可用：`api.github.com`（HTTP 200）、`registry.npmjs.org`、`pypi.org`、`gitee.com`、`ghproxy.net`。
   → 取 GitHub 内容走 `api.github.com`；装包走 npm / PyPI。
2. **npm 缓存目录 `~/.npm` 有 root 拥有文件**，`npm install` 报 EPERM。
   **不要用 sudo**，改用工作区内缓存：
   `npm install --cache "<工作区>/.npmcache"`
3. **`pip install` 想写 `~/.local`**，被沙箱拦。用 `--target <工作区>/_pylibs` + `PYTHONPATH`。
4. **`timeout` 命令在 macOS 上没有**（除非装了 coreutils）。用 Python 自己控超时。
5. **`ps` 被沙箱禁用**，但 `pgrep -x "Adobe Lightroom Classic"` 可用。

## B. 插件与连接

6. **Lightroom 启动后约需 1.5 分钟才加载插件**。重启后立刻查日志会误判"插件没加载"。
   → 用 `lrclient.py wait`，别靠猜。
7. **"一次调用起一个进程、连完就断"的高频调用会把插件的 socket 重绑循环打坏**：
   日志停在 `RESPONSE socket closed (gen=N)` 且不再 rebind，两个端口全关。
   → 用 `repl` 长驻模式，或在一个 Python 进程里连续调用多次。
   恢复：Plug-in Manager → Start Server；不行 Reload Plug-in；再不行重启 Lightroom。
8. **server 把锁文件写到 `os.homedir()/.config/lightroom-mcp/`**，无环境变量可覆盖，
   于是默认会撞沙箱。→ 把子进程 `HOME` 重设到会话可写目录，并同步 token（`lrclient.py` 已处理）。
9. **首批请求必失败**：server 与插件 socket 惰性建连，第一次 `tools/call` 会返回
   `plugin not connected`。→ 对这条错误退避重试（已内建）。
10. **payload 里的 `success:false` 不设 `isError`**：只看 MCP 的 `isError` 会把真实失败
    当成功（`set_color_label` 就踩了这个）。→ 必须同时认载荷的 `success`。

## C. develop 与调色

11. **`apply_auto`（官方 Auto Tone）在本机不生效**：走 `LrDevelopController.setAutoTone`，
    需要 Develop 模块有活动照片；而 `select_photos` 又要求照片在当前视图源里 → 死结。
    实测返回成功但滑杆全 0，报告 `"Auto made no slider changes"`。
    → 用 `set_develop_settings` 显式设定，或让用户在 UI 里按 `Ctrl+U`。
12. **绝不写 `ProcessVersion`**（这些照片是 `15.4`，写死会降级）。
13. **`ColorGrade*` / `SplitToning*` 不在 allowlist** → 冷暖分离用每通道点曲线。
14. **预览尺寸不等于请求尺寸**：Lightroom 只给"最接近的现成渲染件"。
    实测请求 `large`(1024) 返回 1470×827。这是插件已文档化的行为，不是 bug。
15. **相机 16:9 画幅会被 Lightroom 如实呈现**：本次 ARW 的
    `CropTop=0.078 / CropBottom=0.922` 把 4000 裁成 3376 → 16:9。
    所以预览是 1470×827 而非 3:2。**这不是裁切错误**。
    → 用 `sips` 解出的图是未裁切全画幅，两者不可直接比较。验收一律以
      `get_photo_preview` 的 Lightroom 渲染为准。
16. **`import_photos` 只传 `source_path`、不传 `copy_to` 才是原地引用**（不动原片）。

## D. 色标（本次最深的坑）

17. **色标集名称是本地化的**，且用户可自建。中文界面「Lightroom 默认设置」的实际名称是
    `红色/黄色/绿色/蓝色/紫色`（不是 `Red`/`Yellow`/…）。
    Bridge 默认设置：`选择/第二/已批准/审阅/待办事宜`；
    审阅状态：`可删除/需要校正颜色/可以使用/需要修饰/可打印`。
18. **`setRawMetadata('label', X)` 会原样存储任意字符串**，不校验它是否属于当前色标集。
    存错名称 → 界面看不到色标、工具却"成功"。
    → **只写唯一确定名称，绝不要"多试几个候选"**（试错会把色标越写越错）。
19. **`getRawMetadata('colorNameForLabel')` 读回在本机是坏的**：即使用户**亲手用 UI**
    设好色标，读回仍返回 `gray`。
    → 读回只能当参考，**不能用它判定成败**。权威校验手段：
    - 直接查目录数据库 `Adobe_images.colorLabels`
      （拷 `.lrcat` + `-wal` 到工作区后 `sqlite3` 只读查询，**绝不写**）
    - 或让用户看界面

20. **`list_keywords` 的 `photo_count` 恒为 0**（关键词其实挂上了）。
    → 用 `get_photo_metadata` 或数据库核对。

## E. 数据库核对（权威验证手段）

只读副本做法（Lightroom 开着也能查最新状态）：

```bash
cp ~/Pictures/Lightroom/"Lightroom Catalog.lrcat"      <工作区>/snap/cat.lrcat
cp ~/Pictures/Lightroom/"Lightroom Catalog.lrcat-wal"  <工作区>/snap/cat.lrcat-wal   # 必须一起拷
sqlite3 <工作区>/snap/cat.lrcat "SELECT id_local, rating, colorLabels FROM Adobe_images;"
```

常用表：
- `Adobe_images`：`rating`、`colorLabels`、`pick`
- `AgLibraryKeyword` + `AgLibraryKeywordImage`：关键词挂载（`ki.tag = k.id_local`）
- `AgLibraryCollection` / `AgLibraryCollectionImage`：收藏夹
- `Adobe_imageDevelopSettings`：有调色记录的照片
- `Adobe_libraryImageDevelopSnapshot`：快照

⚠️ **永远不要写 `.lrcat`**。Lightroom 开着时直写必然损坏；一律经插件/SDK 改。

**补充：导入之前怎么拿 EXIF。** 照片还没进目录时查不到 `AgHarvestedExifMetadata`，
但 Spotlight 直接给得到，`mdls` 会穿透符号链接：

```bash
mdls -name kMDItemFNumber -name kMDItemExposureTimeSeconds \
     -name kMDItemISOSpeed -name kMDItemFocalLength \
     -name kMDItemAcquisitionModel -name kMDItemContentCreationDate <arw>
```

## F. 2026-09-25 实拍批次新增（75 张 ARW 全流程）

21. **`create_collection` 的 `parent` 参数被丢弃**：schema 声明了 `parent`，但 Lua 实现是
    `catalog:createCollection(collectionName)`——没有第二个参数，所以**收藏夹永远建不进
    收藏夹集**（`create_smart_collection` 同样把 set 写死为 `nil`）。
    SDK 真实签名是 `createCollection(name, parent, canReturnPrior)`，`parent` 是 `LrCollectionSet`。
    → 已打补丁（备份 `HandlerCollections.lua.orig-dsh`；还原用
      `scripts/patch_createcollection.py --restore`）。**改完必须重启 Lightroom**（见 22）。

22. **`Reload Plug-in` 不会替换正在跑的服务器实例**：旧实例仍持有端口租约并每 3 秒续约，
    新实例只能 `standing down`。
    症状极具误导性：Lua 改了、Reload 点了、日志有 `PluginInfoProvider loaded`，
    但**请求仍由旧代码处理**（为此白排查了一轮）。
    → 必须 **Cmd+Q 完全退出 Lightroom 再打开**，之后端口约需 1.5 分钟（见 6）。

23. **`reset_develop` 是静默空操作**：返回 `success:true`、`applied.all:true`，还带 `changed`
    字段，但**滑杆与曲线一个都没变**（读回仍旧值，渲染的 sha256 也完全相同）。
    → 要回到中性状态就**显式写中性值**：`set_develop_settings` 全滑杆写 0，
      `set_tone_curve` 每通道传 `[[128,128]]`（工具补完端点后即恒等曲线）。

24. **点曲线端点陷阱（曾导致整批紫红偏色）**：`normalizeCurvePoints` 在首点不等于 `(0,0)` 时
    会**前插 `(0,0)`**。若首点是 `[0, y]` 且 `y≠0`（参考文档的 B 风格正是如此），
    就会写出**重复的 x=0 点**。
    更糟的是"把首点挪到 x=1"来绕开它：`(0,0)→(1,y)` 近乎垂直，Lightroom 的样条会让
    **红/蓝通道相对绿通道严重发散**——实测一次把 25 张整批染成紫红（天空发紫、云发黄）。
    → 首点**离 x=0 远一点**（用真实锚点，如 `[64,70]`），或干脆接受自动补的 `(0,0)`。
    **任何曲线改动都必须先单张渲染验证再批量。**

25. **`add_ai_mask` 的 `success` 不可信**：实测返回 `success:false` +
    `error: "createNewMask failed: nil"`，但 `list_masks` 里**蒙版确实建出来了**（`天空 1`）；
    同一段代码再调又可能返回 `success:true`。
    → **一律以 `list_masks` 为准**。稳妥做法是分两步：先只建蒙版，再
      `set_mask_adjustments` 套参数。

26. **带 AI 蒙版的照片会让预览渲染退化**：无蒙版时渲染稳定（请求 `medium`(735) 与
    `large`(1470) 的亮度统计几乎一致）；一旦有蒙版，渲染变成**全分辨率 7008×4672、约 19 秒**，
    且 **`large` 直接超时**（90 秒），`size_usable` 返回 `false`（远大于请求尺寸被判 `too_large`）。
    → 这**不是编辑失败**，是渲染路径变了。验证蒙版效果用 `medium`/`small`，
      并接受 `size_usable=false`。

27. **`set_flags` 依赖 UI 选中 + 当前视图源**：它走 `LrSelection` 菜单命令，只对**当前视图源里
    可见**的照片生效；不在源里的会报 `missing: [<id>...]`。
    → 让用户切到「所有照片 / All Photographs」再重试；或改用色标标记
      （色标走 `setRawMetadata`，不受视图源限制）。

28. **`Adobe_imageDevelopSettings.hasDevelopAdjustments` 不维护**：实测 75 张全部调过色之后
    该列仍恒为 `null`。
    → **不能用它判断"有没有调过色"**。判断调色状态要读回 develop 设置。
      （注意 `Adobe_imageDevelopSettings` 有行 ≠ 有调色——导入就会建行。）

29. **本机 Lightroom 的 app 路径没有 `.app` 后缀**：实际是
    `/Applications/Adobe Lightroom Classic`。硬编码 `.app` 会误判"未安装"
    （`open -a "Adobe Lightroom Classic"` 两种写法都能用）。→ 两个路径都试。

---

## G. 2026-09-25 真机验证新发现

30. **`remove_from_catalog` 在当前 Lightroom SDK 上无法实现。** 上游假设
    `catalog:removePhoto(photo)` 存在，实测报
    `attempt to call method 'removePhoto' (a nil value)`。
    查过官方 API 文档：**`LrCatalog` 没有 `removePhoto`**，`LrPhoto` 也只有
    `deleteSmartPreview` 与 `removeKeyword`，**没有任何办法把照片从目录里移除**。
    → 现在这个 handler 明确报错并说明原因（保留 confirm 检查，让调用方先看到
    「这是破坏性操作」而不是「功能不存在」）。
    **要移除只能在 Lightroom 界面里手动做**：图库 → 选中 → Delete → 选「移除」
    （不是「从磁盘删除」）。直写 `.lrcat` 绝对禁止。

31. **桥接把工具结果放在文本块里，不是 `structuredContent`。**
    `search_photos` 之类返回的 `structuredContent` 是空的，JSON 全在一个 text 块里
    （只有 `get_photo_preview` 例外，它另带 `file_path`）。
    → 解析结果要读文本块并 `JSON.parse`，不要指望 `structuredContent`。
      `LightroomBridge.toText()` 已经处理了两种形态。

32. **`20_split.py` 在零剔除时曾经什么都不做。** 提前退出的条件写成了
    `if not to_move:`，于是「其余全部移进 `可导入/`」这条语义被整段跳过：
    用户体检后说「全留」，结果目录没建、`stages.cull` 不记账，后面的导入只能
    回退到源目录。危险之处在于**有剔除项时永远走不到那个分支**（75 张那批有 27 个
    待剔），只有最省心的用法才会踩到。已修，并加了 `tests/test_split.py` 守住
    「预演说的计划必须与真跑结果一致」。

33. **裸 TCP 探测端口会把桥接搞得很难受。** 用 `connect` 之后立刻 `close` 去探
    「Lightroom 在不在」，实测一次就把后续探测打失败（日志里能看到
    `REQUEST socket connected` → `socket closed (client disconnected)`）。
    → 判断链路一律**直接走一次真正的 MCP 握手**，不要裸连。
      `scripts/live-check.mjs` 已按这条重写。

34. **`export_photos` 要求目标目录已经存在。** 传一个不存在的目录会报
    `<AgErrorText>缺少此操作的目标文件夹`（不是「创建失败」，是「缺少」）。
    → `shejing_archive` 里调用前有 `ensureDir(dest)`，所以产品代码不受影响；
      但自己直接调 `export_photos` 时别忘了先建目录。
    实测：建好目录后同一个调用返回
    `{"message": "Exported 1 photos to …"}`，且目标目录里真的出现了 JPEG。

35. **调色写回在真机上确实验证通过（2026-09-25）。** 走了一遍完整链路：
    `create_snapshot` → `set_develop_settings` → `set_tone_curve` →
    `get_develop_settings` 读回核对 → `get_photo_preview` → `export_photos`。
    读回结果与写入一致（`Contrast2012=14`、`Vibrance=18`），`ProcessVersion`
    始终没被碰过（仍是 15.4），写中性值后也确实回到 0。
    脚本：`scripts/live-grade.mjs`（只动克隆副本，结束会还原）。

