#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""摄鲸 · 剔除（把源文件夹拆成 可导入/ 与 非导入/）

**默认 dry-run**，加 --confirm 才真的移动。这是门禁：门禁过了才执行。

用移动（同盘瞬时、不占额外空间、可逆）。非导入/ **永久保留**，本脚本永不删除任何东西。

用法：
  20_split.py <源文件夹> [--reject a.ARW b.ARW ...]
                        [--reject-from cull.json]
                        [--confirm]
"""
import argparse
import json
import os
import shutil
import sys
import unicodedata
from datetime import datetime

KEEP_DIR = "可导入"
REJECT_DIR = "非导入"
RAW_EXT = {".arw", ".cr2", ".cr3", ".nef", ".dng", ".raf", ".orf", ".rw2",
           ".jpg", ".jpeg", ".tif", ".tiff", ".png"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("source")
    # action="extend"：`--reject a --reject b` 与 `--reject a b` 都能累积。
    # 只有 nargs="*" 时，重复出现的 flag **只保留最后一次**——那会让
    # 「传了 28 个名字、只剔掉 1 张」这种错误静默发生（端到端回归抓到过）。
    ap.add_argument("--reject", nargs="*", action="extend", default=[])
    ap.add_argument("--reject-from", default=None, help="JSON 文件，内容是待剔文件名数组")
    ap.add_argument("--manifest", default=None, help="批次 manifest.json，用于记账")
    ap.add_argument("--confirm", action="store_true", help="真的执行移动（默认只预演）")
    args = ap.parse_args()

    src = os.path.abspath(args.source)
    if not os.path.isdir(src):
        print("源文件夹不存在：%s" % src)
        return 1

    reject = list(args.reject)
    if args.reject_from:
        if not os.path.exists(args.reject_from):
            print("找不到剔除清单：%s" % args.reject_from)
            return 1
        with open(args.reject_from, encoding="utf-8") as fh:
            loaded = json.load(fh)
        # 清单必须是字符串数组。传进来一个字符串会被逐字符拆开，里面那个 "."
        # 会让 os.path.exists(src/".") 为真，然后试图把源目录改名到自己身上。
        if not isinstance(loaded, list) or not all(isinstance(x, str) for x in loaded):
            print("剔除清单必须是一个字符串数组：%s" % args.reject_from)
            return 1
        reject += loaded

    photos = sorted(f for f in os.listdir(src)
                    if os.path.splitext(f)[1].lower() in RAW_EXT
                    and os.path.isfile(os.path.join(src, f)))
    photo_set = set(photos)

    # 剔单项必须是**源目录里的一个普通文件名**。
    #
    # 不校验的话有两条真实的破坏路径：
    #   · `--reject 可导入` → 整个可导入目录被改名塞进 非导入/，照片全跟着被埋
    #   · `--reject ../x.ARW` → 源目录**外面**的文件被 rename 进源目录，下一次
    #     拆分就会把它当成本批照片移进 可导入/，然后 Lightroom 会导入它
    # 只认 basename == 自己、且在 photos 列表里的名字。
    # 大小写 / Unicode 归一化不一致会让同一个文件在两份名单里同时出现：
    # os.path.exists 是**文件系统归一化后**的比较（APFS 默认大小写与归一化都不敏感），
    # 而 `f not in set(to_move)` 是**逐字符**比较。于是 `--reject dsc0001.ARW` 配上
    # 磁盘上的 `DSC0001.ARW`：它既被移进 非导入/，又留在 keep 里；随后 keep 的改名
    # 因为源文件已不在而失败 → 用户明确**没有**剔的那张照片躺进了 非导入/。
    #
    # 注意顺序：归一化匹配必须**在** os.path.exists 之前。反过来的话，在不敏感的文件
    # 系统上 `os.path.exists('dsc0001.ARW')` 为真，大小写变体会被误判成「同名的非照片
    # 文件」而直接忽略——归一化匹配就永远轮不到执行了。（这个顺序错误被测试抓到过。）
    def canonical(name):
        return unicodedata.normalize("NFC", name).casefold()

    by_canonical = {}
    for name in photos:
        by_canonical.setdefault(canonical(name), name)

    invalid = []
    cleaned = []
    for name in reject:
        if os.path.basename(name) != name or name in ("", ".", ".."):
            invalid.append((name, "不是纯粹的文件名（含路径分隔符或为 . / ..）"))
            continue
        if name in photo_set:
            cleaned.append(name)
            continue
        mapped = by_canonical.get(canonical(name))
        if mapped is not None:
            cleaned.append(mapped)          # 大小写/归一化不同，但确实是同一张
            continue
        # 走到这里才说明它真的不是本批的一张照片。若磁盘上确有此名（最典型的是
        # 有人把目录名当文件名传进来，`--reject 可导入`），必须当成非法条目报出来，
        # 而不是轻描淡写成「找不到、可能拼错」。
        if os.path.exists(os.path.join(src, name)):
            invalid.append((name, "源目录里确实有这个名字，但它不是一张待处理的照片（是目录或非 RAW 文件）"))
            continue
        cleaned.append(name)                # 交给下面的 missing 报告

    resolved = []
    for name in cleaned:
        actual = name if name in photo_set else by_canonical.get(canonical(name))
        resolved.append(actual if actual is not None else name)

    missing = sorted({r for r in resolved if r not in photo_set})
    to_move = sorted({r for r in resolved if r in photo_set})
    keep = [f for f in photos if f not in set(to_move)]

    print("剔除 · %s" % src)
    print("  当前根目录照片 : %d 张" % len(photos))
    print("  待移入 %s/ : %d 张" % (REJECT_DIR, len(to_move)))
    print("  留在   %s/ : %d 张" % (KEEP_DIR, len(keep)))
    if invalid:
        print("  ❌ 清单里有 %d 个条目不是本次要处理的照片，已忽略（不会去动源目录之外的东西）：" % len(invalid))
        for name, why in invalid[:10]:
            print("       %s —— %s" % (name, why))
    if missing:
        print("  ⚠️ 清单里有 %d 个文件名在源目录找不到（可能已移动或拼错）：" % len(missing))
        for m in missing[:10]:
            print("       %s" % m)

    if not args.confirm:
        print("\n[dry-run] 未改动任何文件。确认后加 --confirm 执行。")
        print("将要执行：")
        print("  mkdir %s/ %s/" % (KEEP_DIR, REJECT_DIR))
        print("  mv <待剔的 %d 张> %s/" % (len(to_move), REJECT_DIR))
        print("  mv <其余 %d 张> %s/" % (len(keep), KEEP_DIR))
        return 0

    # 只有「两个都为空」才是真的没事可做。
    #
    # 不能写成 `if not to_move:`——那会在**零剔除**时直接返回，于是「其余全部移进
    # 可导入/」这条语义被跳过：用户体检后说「全留」，结果什么都没发生，stages.cull
    # 不记账，后面的导入只能回退到源目录，照片永远没进 可导入/。
    # 真机流水线正是这样抓到的（预演说「mv 其余 3 张」，真跑却说「什么都不做」）。
    if not to_move and not keep:
        print("\n源目录里没有可整理的照片，什么都不做。")
        return 0

    keep_dir = os.path.join(src, KEEP_DIR)
    rej_dir = os.path.join(src, REJECT_DIR)
    os.makedirs(keep_dir, exist_ok=True)
    os.makedirs(rej_dir, exist_ok=True)

    moved_rej, moved_keep, errors, skipped = 0, 0, [], []

    def move_one(name, dest_dir, label):
        """把一张照片移进目标目录。**目标已存在就跳过，绝不覆盖。**

        POSIX 的 os.rename 会静默替换已存在的目标。没有这道检查时，
        「第二张卡上有个同名文件」这种再普通不过的情况会直接吃掉先前那张：
        非导入/DSC0001.ARW 被新卡的同名文件替换，旧的那张无声无息没了。
        本脚本的 docstring 承诺「永不删除任何东西」，之前并不成立。
        """
        source_path = os.path.join(src, name)
        target_path = os.path.join(dest_dir, name)
        if os.path.exists(target_path):
            skipped.append((name, "%s/ 里已有同名文件" % label))
            return False
        if not os.path.exists(source_path):
            errors.append((name, "源文件已不在（可能在计划之后被移动或删除）"))
            return False
        try:
            os.rename(source_path, target_path)
            return True
        except OSError as e:
            errors.append((name, str(e)))
            return False

    for f in to_move:
        if move_one(f, rej_dir, REJECT_DIR):
            moved_rej += 1
    for f in keep:
        if move_one(f, keep_dir, KEEP_DIR):
            moved_keep += 1

    print("\n完成：移入 %s/ %d 张，移入 %s/ %d 张" % (REJECT_DIR, moved_rej,
                                                KEEP_DIR, moved_keep))
    if skipped:
        print("跳过 %d 个（目标目录里已有同名文件，**没有覆盖**）：" % len(skipped))
        for name, why in skipped[:10]:
            print("   %s：%s" % (name, why))
    if errors:
        print("失败 %d 个：" % len(errors))
        for f, e in errors[:10]:
            print("   %s: %s" % (f, e))
        # 不再在这里 return 1：账本必须写下去。半途失败却不记账的话，后面的
        # 导出/验收会回退去用源目录当「可导入」，把没拆完的根目录当成结果。
        exit_code = 1
    else:
        exit_code = 0

    if args.manifest and os.path.exists(args.manifest):
        m = json.load(open(args.manifest))
        m.setdefault("stages", {})["cull"] = dict(
            status="done", at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            keep_dir=keep_dir, reject_dir=rej_dir,
            kept=moved_keep, rejected=moved_rej,
            rejected_files=sorted(to_move))
        json.dump(m, open(args.manifest, "w"), ensure_ascii=False, indent=1)
        print("manifest 已记账：%s" % args.manifest)

    print("\n下一步：整理（只重命名 %s/，再导入 Lightroom）。" % KEEP_DIR)
    print("%s/ 永久保留，我不会自动清理。" % REJECT_DIR)
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
