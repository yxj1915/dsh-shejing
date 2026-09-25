#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
修复 @pired/lightroom-mcp 插件 set_color_label 在非英文目录下失效的问题。

问题(实测于 macOS Lightroom Classic 15.5 + 中文界面)
---------------------------------------------------
1. 色标名随界面语言变化, 且用户可自建色标集。插件原版硬编码英文名
   (Red/Yellow/Green/Blue/Purple), 而 setRawMetadata('label', ...) 会
   **原样存储**给定字符串, 并不校验它是否属于当前色标集。于是中文目录里
   存进去的 "Green" 不被 Lightroom 认作任何色标 —— 界面上看不到色标,
   而工具却报告写入了。
2. 该环境里读回接口 getRawMetadata('colorNameForLabel') 即使对**用户亲手
   用 UI 设好的色标**也返回 gray, 因此"读回校验"永远失败, 不能用来判定
   成败(实测: UI 设为黄色后, 库里是 黄色, 读回仍是 none)。

修法
----
把色标名收进文件顶部的 COLOR_LABEL_NAMES 表, 只写这一个确定名称, 不再
"逐个候选试写"(那会把色标越写越错)。读回仅作为参考信息随结果返回, 并在
无法确认时给出说明, 而不是谎报失败。
换语言/换色标集时只需改这张表。

用法
----
  python3 patch_colorlabel.py <HandlerOrganization.lua>
  python3 patch_colorlabel.py <HandlerOrganization.lua> --check-only
  python3 patch_colorlabel.py <HandlerOrganization.lua> --restore   # 还原
"""
import os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
# 默认直接指向 Lightroom 里已安装的插件，通常无需再传路径
DEFAULT_TARGET = os.path.join(
    os.path.expanduser("~"), "Library", "Application Support", "Adobe",
    "Lightroom", "Modules", "LightroomMCP.lrplugin", "HandlerOrganization.lua")

# 本目录当前色标集(中文界面「Lightroom 默认设置」)的实际名称。
# 英文界面请改为 Red/Yellow/Green/Blue/Purple。
NAMES = {
    "red": "红色",
    "yellow": "黄色",
    "green": "绿色",
    "blue": "蓝色",
    "purple": "紫色",
}


def lua_str(s):
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def names_lua():
    lines = ["-- 当前色标集的实际名称。换界面语言或换色标集时改这里即可;",
             "-- 英文界面用 Red / Yellow / Green / Blue / Purple。",
             "local COLOR_LABEL_NAMES = {"]
    for slot in ("red", "yellow", "green", "blue", "purple"):
        lines.append(f"    {slot} = {lua_str(NAMES[slot])},")
    lines.append("}")
    return "\n".join(lines)


# ---------------- 原始代码锚点 ----------------
OLD_LABELS = '''local COLOR_LABELS = {
    red = "Red",
    yellow = "Yellow",
    green = "Green",
    blue = "Blue",
    purple = "Purple",
}'''

OLD_BODY = '''    local labelValue = nil
    if label ~= "none" then
        labelValue = COLOR_LABELS[label]
        if not labelValue then
            error("label must be one of: red, yellow, green, blue, purple, none")
        end
    end

    local catalog = LrApplication.activeCatalog()

    catalog:withWriteAccessDo("Set Color Label", function()
        local resolved = PhotoLookup.resolveMany(catalog, args.photo_ids)
        for _, entry in ipairs(resolved) do
            if entry.photo then
                -- nil clears the label, exactly like the rating handler.
                entry.photo:setRawMetadata('label', labelValue)
            end
        end
    end)

    -- Verify per photo by reading back: 'none' expects an empty label, the
    -- colors compare case-insensitively to tolerate label-set variations.
    local updatedCount = 0
    local mismatchIds = {}
    local mismatchCount = 0

    catalog:withReadAccessDo(function()
        local resolved = PhotoLookup.resolveMany(catalog, args.photo_ids)
        for _, entry in ipairs(resolved) do
            local photo = entry.photo
            if photo then
                -- PhotoFields handles both traps: the write key ('label')
                -- cannot be read back, and an unlabelled photo reads as
                -- "gray", not nil. Comparing against nil here reported every
                -- successful CLEAR as a mismatch.
                local current = PhotoFields.colorLabel(photo)
                local matches
                if label == "none" then
                    matches = current == PhotoFields.NO_LABEL
                else
                    matches = current:lower() == labelValue:lower()
                end
                if matches then
                    updatedCount = updatedCount + 1
                else
                    mismatchCount = mismatchCount + 1
                    table.insert(mismatchIds, tostring(photo.localIdentifier))
                end
            end
        end
    end)'''

NEW_LABELS = names_lua()

NEW_BODY = '''    local labelValue = nil
    if label ~= "none" then
        labelValue = COLOR_LABEL_NAMES[label]
        if not labelValue then
            error("label must be one of: red, yellow, green, blue, purple, none")
        end
    end

    local catalog = LrApplication.activeCatalog()

    -- 只写这一个确定名称。setRawMetadata('label', ...) 会原样存储字符串,
    -- 不校验它是否属于当前色标集, 所以写错名称既不会报错、界面上也看不到
    -- 色标 —— 绝不能靠"多试几个名字"来兜底, 那只会越写越错。
    catalog:withWriteAccessDo("Set Color Label", function()
        local resolved = PhotoLookup.resolveMany(catalog, args.photo_ids)
        for _, entry in ipairs(resolved) do
            if entry.photo then
                -- nil clears the label, exactly like the rating handler.
                entry.photo:setRawMetadata('label', labelValue)
            end
        end
        writtenCount = #resolved
    end)

    -- 读回仅作参考。本环境实测: 即使色标是用户用 UI 设好的, 读回仍返回
    -- "gray"/none, 所以读回不一致不能判定写入失败 —— 只如实报告, 由调用方
    -- 用界面或目录确认。
    local updatedCount = 0
    local mismatchIds = {}
    local mismatchCount = 0

    catalog:withReadAccessDo(function()
        local resolved = PhotoLookup.resolveMany(catalog, args.photo_ids)
        for _, entry in ipairs(resolved) do
            local photo = entry.photo
            if photo then
                -- PhotoFields handles both traps: the write key ('label')
                -- cannot be read back, and an unlabelled photo reads as
                -- "gray", not nil. Comparing against nil here reported every
                -- successful CLEAR as a mismatch.
                local current = PhotoFields.colorLabel(photo)
                local matches
                if label == "none" then
                    matches = current == PhotoFields.NO_LABEL
                else
                    matches = current:lower() == labelValue:lower()
                end
                if matches then
                    updatedCount = updatedCount + 1
                else
                    mismatchCount = mismatchCount + 1
                    table.insert(mismatchIds, tostring(photo.localIdentifier))
                end
            end
        end
    end)'''

OLD_RESULT_REF = '''    local result = {
        success = mismatchCount == 0,
        label = label,
        updated = updatedCount,
        mismatching = mismatchIds,
        message = string.format("Set color label '%s' on %d photos (%d mismatched after write)",
            label, updatedCount, mismatchCount),
    }'''

NEW_RESULT_REF = '''    local result = {
        success = true,
        label = label,
        applied_value = labelValue,
        written = writtenCount,
        read_back_confirmed = (mismatchCount == 0),
        mismatching = mismatchIds,
        message = string.format("Wrote color label '%s' (%s) to %d photo(s); read-back confirmed %d",
            tostring(labelValue), label, writtenCount, updatedCount),
    }
    if label ~= "none" and mismatchCount > 0 then
        result.note = "Lightroom's colorNameForLabel read-back did not confirm this label. "
            .. "On this build it also fails to confirm labels set through Lightroom's own UI, "
            .. "so treat it as advisory: verify in Lightroom, and make sure COLOR_LABEL_NAMES "
            .. "matches the active color label set."
        result.message = result.message
            .. string.format(" (%d not confirmed by read-back)", mismatchCount)
    end'''


def read_lua(path):
    raw = open(path, "rb").read()
    text = raw.decode("utf-8")
    newline = "\r\n" if b"\r\n" in raw else "\n"
    return text.replace("\r\n", "\n"), newline


def write_lua(path, text_lf, newline):
    out = text_lf.replace("\n", newline) if newline != "\n" else text_lf
    with open(path, "wb") as fh:
        fh.write(out.encode("utf-8"))


def apply_patch(text):
    for name, old, new in (("COLOR_LABELS 表", OLD_LABELS, NEW_LABELS),
                           ("setColorLabel 主体", OLD_BODY, NEW_BODY),
                           ("结果表", OLD_RESULT_REF, NEW_RESULT_REF)):
        n = text.count(old)
        if n != 1:
            raise SystemExit(f"[失败] 锚点 '{name}' 出现 {n} 次 (期望 1), 中止以免误改")
        text = text.replace(old, new, 1)
    # 主体里引用了 writtenCount, 需在函数开头声明
    anchor = '''    local label = args.label
    if label == nil then
        error("label is required")
    end
'''
    if text.count(anchor) != 1:
        raise SystemExit("[失败] 找不到 label 校验锚点")
    text = text.replace(anchor, anchor + '''
    local writtenCount = 0
''', 1)
    return text


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    check_only = "--check-only" in sys.argv
    restore = "--restore" in sys.argv
    target = args[0] if args else DEFAULT_TARGET
    backup = target + ".orig-dsh"

    if restore:
        if not os.path.exists(backup):
            raise SystemExit(f"没有备份可还原: {backup}")
        src, nl = read_lua(backup)
        write_lua(target, src, nl)
        print(f"[已还原] {target}  <- {backup}")
        return 0

    if not os.path.exists(target):
        raise SystemExit(f"找不到目标文件: {target}")

    src, newline = read_lua(target)

    # 若装的是上一版"候选试写"补丁, 先从备份还原再打新补丁
    if "COLOR_LABEL_CANDIDATES" in src:
        if not os.path.exists(backup):
            raise SystemExit("[失败] 检测到旧的候选试写补丁但没有备份, 请手动恢复")
        src, _ = read_lua(backup)
        print("[清理] 已从备份取得原版, 以新方案重打")

    if "COLOR_LABEL_NAMES" in src:
        print(f"[跳过] 已是当前版本: {target}")
        return 0

    patched = apply_patch(src)
    print(f"[行尾] {'CRLF' if newline == chr(13) + chr(10) else 'LF'}")

    if not check_only:
        if not os.path.exists(backup):
            write_lua(backup, src, newline)
            print(f"[备份] {backup}")
        write_lua(target, patched, newline)
        print(f"[已写入] {target}")
    else:
        write_lua(target + ".patched", patched, newline)
        print(f"[仅检查] 输出 {target}.patched")

    try:
        from luaparser import ast
        ast.parse(patched)
        print("[语法] luaparser 解析通过 ✅")
    except ImportError:
        print("[语法] 未安装 luaparser, 跳过")
    except Exception as e:
        print(f"[语法] ❌ 解析失败: {e}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
