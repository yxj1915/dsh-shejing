#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""摄鲸 · 重命名（整理阶段的第一小步）

把 `可导入/` 里的照片改成统一命名。**默认只预演**，加 `--confirm` 才真改名。
这是不可逆动作：文件名改了，Lightroom 之外的引用就会断，所以必须过门禁。

命名模板变量：
  {date}  拍摄日期 YYYY-MM-DD（来自 EXIF DateTimeOriginal，读不到则用文件 mtime）
  {time}  拍摄时间 HHMMSS
  {name}  原文件名（不含扩展名）
  {seq}   三位序号，按拍摄时间排序

已经符合模板的文件会被跳过；目标名已存在时报冲突而不是覆盖。

用法：
  25_rename.py <目录> [--template "{date}_{name}"] [--ext .ARW] [--confirm]
"""
import argparse
import os
import re
import sys
from datetime import datetime

import exif

RAW_EXT = {".arw", ".cr2", ".cr3", ".nef", ".dng", ".raf", ".orf", ".rw2",
           ".jpg", ".jpeg", ".tif", ".tiff", ".png"}


def shoot_time(path):
    """拍摄时间。EXIF 优先，读不到退回文件 mtime——绝不猜成「现在」。"""
    md = exif.read_exif(path)
    raw = md.get("datetime")
    if raw:
        try:
            return datetime.strptime(raw, "%Y:%m:%d %H:%M:%S"), "exif"
        except ValueError:
            pass
    try:
        return datetime.fromtimestamp(os.path.getmtime(path)), "mtime"
    except OSError:
        return None, "unknown"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("directory")
    ap.add_argument("--template", default="{date}_{name}")
    ap.add_argument("--ext", default=None, help="只处理该扩展名（如 .ARW），默认全部照片")
    ap.add_argument("--confirm", action="store_true")
    args = ap.parse_args()

    src = os.path.abspath(args.directory)
    if not os.path.isdir(src):
        print("目录不存在：%s" % src)
        return 1

    want = args.ext.lower() if args.ext else None
    files = sorted(
        f for f in os.listdir(src)
        if os.path.isfile(os.path.join(src, f))
        and os.path.splitext(f)[1].lower() in RAW_EXT
        and (want is None or os.path.splitext(f)[1].lower() == want)
    )
    if not files:
        print("目录里没有可重命名的照片：%s" % src)
        return 0

    stamped = []
    for f in files:
        path = os.path.join(src, f)
        when, source = shoot_time(path)
        stamped.append(dict(name=f, path=path, when=when, source=source))
    stamped.sort(key=lambda x: (x["when"] is None, x["when"] or datetime.min))

    plans, skipped, conflicts = [], [], []
    for seq, item in enumerate(stamped, 1):
        base, ext = os.path.splitext(item["name"])
        # 剥掉可能已经存在的日期前缀——否则 {date}_{name} 会把日期写两遍。
        # 9.25 那批的文件名本来就是 `2026-09-25_DSC07339.ARW` 这种形状。
        core = re.sub(r"^\d{4}-\d{2}-\d{2}_", "", base)
        when = item["when"]
        target = args.template.format(
            date=when.strftime("%Y-%m-%d") if when else "未知日期",
            time=when.strftime("%H%M%S") if when else "000000",
            name=core,
            seq="%03d" % seq,
        ) + ext
        if target == item["name"]:
            skipped.append(item["name"])
            continue
        if os.path.exists(os.path.join(src, target)):
            conflicts.append((item["name"], target))
            continue
        plans.append((item["name"], target, item["source"]))

    print("① 证据")
    print("  目录：%s" % src)
    print("  模板：%s" % args.template)
    print("  共 %d 张，需要改名 %d 张，已符合 %d 张，命名冲突 %d 张"
          % (len(files), len(plans), len(skipped), len(conflicts)))
    for old, new, source in plans:
        print("     %s  →  %s   （时间源：%s）" % (old, new, source))
    if conflicts:
        print("  ⚠️ 冲突（目标名已存在，不会覆盖）：")
        for old, new in conflicts:
            print("     %s  →  %s" % (old, new))

    if not plans:
        print("\n无需改名。")
        return 0

    print("\n② 建议")
    print("  按上面的对照表改名。这是**不可逆**动作——名字一改，Lightroom 之外的引用就断了。")

    if not args.confirm:
        print("\n③ [dry-run] 未改名。确认后加 --confirm。")
        return 0

    done = 0
    for old, new, _ in plans:
        try:
            os.rename(os.path.join(src, old), os.path.join(src, new))
            done += 1
        except OSError as exc:
            print("  改名失败 %s → %s：%s" % (old, new, exc))
    print("\n已改名 %d 张。" % done)
    return 0 if done == len(plans) else 1


if __name__ == "__main__":
    sys.exit(main())
