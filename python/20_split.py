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
from datetime import datetime

KEEP_DIR = "可导入"
REJECT_DIR = "非导入"
RAW_EXT = {".arw", ".cr2", ".cr3", ".nef", ".dng", ".raf", ".orf", ".rw2",
           ".jpg", ".jpeg", ".tif", ".tiff", ".png"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("source")
    ap.add_argument("--reject", nargs="*", default=[])
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
        reject += json.load(open(args.reject_from))
    reject = sorted(set(reject))

    photos = sorted(f for f in os.listdir(src)
                    if os.path.splitext(f)[1].lower() in RAW_EXT
                    and os.path.isfile(os.path.join(src, f)))
    # 已经拆过的，只处理还在根目录的
    missing = [r for r in reject if not os.path.exists(os.path.join(src, r))]
    to_move = [r for r in reject if os.path.exists(os.path.join(src, r))]
    keep = [f for f in photos if f not in set(to_move)]

    print("剔除 · %s" % src)
    print("  当前根目录照片 : %d 张" % len(photos))
    print("  待移入 %s/ : %d 张" % (REJECT_DIR, len(to_move)))
    print("  留在   %s/ : %d 张" % (KEEP_DIR, len(keep)))
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

    if not to_move:
        print("\n没有待剔文件，什么都不做。")
        return 0

    keep_dir = os.path.join(src, KEEP_DIR)
    rej_dir = os.path.join(src, REJECT_DIR)
    os.makedirs(keep_dir, exist_ok=True)
    os.makedirs(rej_dir, exist_ok=True)

    moved_rej, moved_keep, errors = 0, 0, []
    for f in to_move:
        try:
            os.rename(os.path.join(src, f), os.path.join(rej_dir, f))
            moved_rej += 1
        except OSError as e:
            errors.append((f, str(e)))
    for f in keep:
        try:
            os.rename(os.path.join(src, f), os.path.join(keep_dir, f))
            moved_keep += 1
        except OSError as e:
            errors.append((f, str(e)))

    print("\n完成：移入 %s/ %d 张，移入 %s/ %d 张" % (REJECT_DIR, moved_rej,
                                                KEEP_DIR, moved_keep))
    if errors:
        print("失败 %d 个：" % len(errors))
        for f, e in errors[:10]:
            print("   %s: %s" % (f, e))
        return 1

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
    return 0


if __name__ == "__main__":
    sys.exit(main())
