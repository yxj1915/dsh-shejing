#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""摄鲸 · 精选计划（只读、只算、不导出）

精选 = 星级 ≥ 阈值（默认 4）。本脚本**只产出计划**：候选清单 + 星级分布 +
目标目录，写成 `<批次目录>/export-plan.json`。

真正的导出由**插件的归档阶段**拿到这份计划后，通过
`mcp__lightroom__export_photos` 执行——Python 不碰 Lightroom，也不碰桥接。
这样划分的原因：目录数据库读取是纯本地计算（这里），而写目录/渲染导出是
Lightroom 的事（那里），两边都不越界。

⚠️ 桥接的 export_photos 只暴露 格式/质量/尺寸/目标/同名策略，**没有色彩空间和
   元数据开关**。色彩空间取 Lightroom 导出默认（JPEG 通常为 sRGB），EXIF 默认保留。
   需要严格指定时要改 Lightroom 的导出默认设置，或在 Lightroom 里用导出预设。

用法：
  30_export.py <批次目录> [--threshold 4]
                          [--photos a.ARW b.ARW ...]
                          [--exclude-from skip.json]
                          [--catalog <Lightroom Catalog.lrcat>]
                          [--json <输出路径>]
"""
import argparse
import json
import os
import shutil
import sqlite3
import sys
import tempfile

# 目录数据库的常见位置（按优先级）。
CATALOG_CANDIDATES = [
    "~/Pictures/Lightroom/Lightroom Catalog.lrcat",
    "~/Pictures/Lightroom/Lightroom Catalog-v13.lrcat",
    "~/Pictures/Lightroom Catalog.lrcat",
]


def find_catalog(explicit=None):
    """定位 Lightroom 目录数据库。只读，绝不写入。"""
    if explicit:
        return os.path.expanduser(explicit) if os.path.exists(os.path.expanduser(explicit)) else None
    for cand in CATALOG_CANDIDATES:
        path = os.path.expanduser(cand)
        if os.path.exists(path):
            return path
    # 兜底：扫 ~/Pictures 下任意 *.lrcat（含一级子目录）
    root = os.path.expanduser("~/Pictures")
    if os.path.isdir(root):
        for dirpath, dirnames, filenames in os.walk(root):
            if dirpath.count(os.sep) - root.count(os.sep) > 2:
                dirnames[:] = []
                continue
            for name in filenames:
                if name.lower().endswith(".lrcat"):
                    return os.path.join(dirpath, name)
    return None


def ratings_for(paths, catalog):
    """从目录数据库的**只读副本**查星级。

    必须连 -wal/-shm 一起复制，否则读到旧状态。全程不打开原始 .lrcat，
    更不写入——Lightroom 开着时直写必然损坏目录。
    """
    if catalog is None:
        return None
    tmp = tempfile.mkdtemp(prefix="shejing-cat-")
    try:
        for suffix in ("", "-wal", "-shm"):
            s = catalog + suffix
            if os.path.exists(s):
                shutil.copyfile(s, os.path.join(tmp, "cat.lrcat" + suffix))
        con = sqlite3.connect(os.path.join(tmp, "cat.lrcat"))
        try:
            rows = con.execute(
                "SELECT fl.basename, i.rating FROM Adobe_images i "
                "JOIN AgLibraryFile fl ON fl.id_local=i.rootFile").fetchall()
        finally:
            con.close()
        return {b: (r or 0) for b, r in rows}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("batch_dir")
    ap.add_argument("--threshold", type=float, default=4.0)
    ap.add_argument("--photos", nargs="*", default=[],
                    help="显式点名要导出的照片（覆盖星级筛选）")
    ap.add_argument("--exclude-from", default=None, help="JSON：要排除的文件名数组")
    ap.add_argument("--catalog", default=None, help="目录数据库路径（默认自动定位）")
    ap.add_argument("--json", default=None, help="计划输出路径，默认 <批次>/export-plan.json")
    args = ap.parse_args()

    batch = os.path.abspath(args.batch_dir)
    mpath = os.path.join(batch, "manifest.json")
    if not os.path.exists(mpath):
        print("找不到 manifest：%s" % mpath)
        return 1
    with open(mpath) as fh:
        m = json.load(fh)
    src = m.get("source_path") or m.get("batch", {}).get("source") or ""
    keep_dir = m.get("stages", {}).get("cull", {}).get("keep_dir") or src
    if not os.path.isdir(keep_dir):
        print("可导入目录不存在：%s" % keep_dir)
        return 1

    cand_files = sorted(f for f in os.listdir(keep_dir)
                        if os.path.isfile(os.path.join(keep_dir, f)))
    exclude = set()
    if args.exclude_from:
        with open(args.exclude_from) as fh:
            exclude = set(json.load(fh))

    catalog = find_catalog(args.catalog)
    stars = None if args.photos else ratings_for(cand_files, catalog)
    distribution = None

    if args.photos:
        picked = [p for p in args.photos if p not in exclude]
        why = "你点名的"
    elif stars is None:
        print("找不到 Lightroom 目录数据库，无法按星级筛选。")
        print("  用 --catalog 指定，或用 --photos 点名。")
        return 1
    else:
        picked = [f for f in cand_files
                  if f not in exclude and stars.get(f, 0) >= args.threshold]
        why = "星级 ≥ %g" % args.threshold
        distribution = {int(v): sum(1 for x in cand_files if stars.get(x, 0) == v)
                        for v in sorted({stars.get(f, 0) for f in cand_files})}

    print("① 证据")
    print("  候选来源：%s" % why)
    print("  可导入目录共 %d 张，候选 %d 张" % (len(cand_files), len(picked)))
    if distribution is not None:
        print("  星级分布：%s" % distribution)
    if catalog is None:
        print("  目录数据库：未找到（本次按点名筛选）")
    for f in picked:
        print("     %s" % f)

    if not picked:
        print("\n候选为空——把阈值调低，或用 --photos 点名。")
        return 0

    print("\n② 建议")
    print("  导出 %d 张 · JPEG 质量 100 · 原始尺寸（不缩放）· 保留 EXIF" % len(picked))
    print("  实际导出由 mcp__lightroom__export_photos 执行")

    plan = dict(
        batch_dir=batch,
        keep_dir=keep_dir,
        catalog=catalog,
        threshold=args.threshold,
        why=why,
        candidates_total=len(cand_files),
        picked=picked,
        absolute_paths=[os.path.join(keep_dir, f) for f in picked],
        distribution=distribution,
        export=dict(format="jpeg", quality=100, on_existing="overwrite"),
    )
    out = args.json or os.path.join(batch, "export-plan.json")
    with open(out, "w") as fh:
        json.dump(plan, fh, ensure_ascii=False, indent=1)
    print("  计划 → %s" % out)

    print("\n③ 等你")
    print("  把清单和缩略图给用户看过、他增删之后再执行导出。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
