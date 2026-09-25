#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""摄鲸 · 验收的目录数据库核对（只读）

交叉核对「我以为发生了什么」与「目录数据库里实际记录了什么」。这是防止
「工具返回 ok 但其实没生效」的唯一可靠手段——你自己的 gotcha 里就写着：
`ok`/`success` 可能是假的。

刻意**不**用 `Adobe_imageDevelopSettings.hasDevelopAdjustments` 判断是否调过色：
实测该字段不维护，而且导入就会建行（有行 ≠ 有调色）。调色是否生效一律由
Lightroom 自己的 API（`get_develop_settings`）读回，那是权威。

本脚本只查这些：星级、色标、旗标、关键词、收藏夹归属。

只读：复制 `.lrcat` + `-wal` + `-shm` 到临时目录再查，**绝不打开原始目录库**，
更不写入。

用法：
  35_verify.py <批次目录> [--catalog <路径>] [--json]
"""
import argparse
import json
import os
import shutil
import sqlite3
import sys
import tempfile

CATALOG_CANDIDATES = [
    "~/Pictures/Lightroom/Lightroom Catalog.lrcat",
    "~/Pictures/Lightroom/Lightroom Catalog-v13.lrcat",
    "~/Pictures/Lightroom Catalog.lrcat",
]


def find_catalog(explicit=None):
    if explicit:
        path = os.path.expanduser(explicit)
        return path if os.path.exists(path) else None
    for cand in CATALOG_CANDIDATES:
        path = os.path.expanduser(cand)
        if os.path.exists(path):
            return path
    return None


def query(catalog, sql, params=()):
    tmp = tempfile.mkdtemp(prefix="shejing-verify-")
    try:
        for suffix in ("", "-wal", "-shm"):
            s = catalog + suffix
            if os.path.exists(s):
                shutil.copyfile(s, os.path.join(tmp, "cat.lrcat" + suffix))
        con = sqlite3.connect(os.path.join(tmp, "cat.lrcat"))
        try:
            return con.execute(sql, params).fetchall()
        finally:
            con.close()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("batch_dir")
    ap.add_argument("--catalog", default=None)
    ap.add_argument("--json", action="store_true", help="只输出 JSON，便于工具消费")
    args = ap.parse_args()

    batch = os.path.abspath(args.batch_dir)
    mpath = os.path.join(batch, "manifest.json")
    if not os.path.exists(mpath):
        print("找不到 manifest：%s" % mpath)
        return 1
    with open(mpath) as fh:
        m = json.load(fh)

    keep_dir = m.get("stages", {}).get("cull", {}).get("keep_dir") or m.get("source_path")
    if not os.path.isdir(keep_dir):
        print("可导入目录不存在：%s" % keep_dir)
        return 1
    names = {f for f in os.listdir(keep_dir) if os.path.isfile(os.path.join(keep_dir, f))}

    catalog = find_catalog(args.catalog)
    if catalog is None:
        print("找不到 Lightroom 目录数据库；用 --catalog 指定。")
        return 1

    rows = query(
        catalog,
        "SELECT fl.basename, i.rating, i.colorLabels, i.pick "
        "FROM Adobe_images i JOIN AgLibraryFile fl ON fl.id_local = i.rootFile",
    )
    by_name = {b: dict(rating=r or 0, labels=c or "", pick=p or "") for b, r, c, p in rows}

    kw_rows = query(
        catalog,
        "SELECT fl.basename, k.name FROM AgLibraryKeywordImage ki "
        "JOIN AgLibraryKeyword k ON k.id_local = ki.tag "
        "JOIN Adobe_images i ON i.id_local = ki.image "
        "JOIN AgLibraryFile fl ON fl.id_local = i.rootFile",
    )
    keywords = {}
    for b, k in kw_rows:
        keywords.setdefault(b, []).append(k)

    coll_rows = query(
        catalog,
        "SELECT fl.basename, c.name FROM AgLibraryCollectionImage ci "
        "JOIN AgLibraryCollection c ON c.id_local = ci.collection "
        "JOIN Adobe_images i ON i.id_local = ci.image "
        "JOIN AgLibraryFile fl ON fl.id_local = i.rootFile",
    )
    collections = {}
    for b, c in coll_rows:
        collections.setdefault(b, []).append(c)

    imported = [n for n in sorted(names) if n in by_name]
    missing = [n for n in sorted(names) if n not in by_name]
    rated = {n: by_name[n]["rating"] for n in imported if by_name[n]["rating"]}
    labeled = {n: by_name[n]["labels"] for n in imported if by_name[n]["labels"]}

    report = dict(
        batch=batch,
        catalog=catalog,
        keep_dir=keep_dir,
        in_folder=len(names),
        imported=len(imported),
        missing=missing,
        ratings={str(k): v for k, v in sorted(rated.items(), key=lambda x: -x[1])},
        color_labels=labeled,
        keywords={n: keywords.get(n, []) for n in imported if keywords.get(n)},
        collections={n: collections.get(n, []) for n in imported if collections.get(n)},
    )

    if args.json:
        print(json.dumps(report, ensure_ascii=False))
        return 0

    print("① 证据（目录数据库交叉核对）")
    print("  目录库：%s" % catalog)
    print("  可导入目录 %d 张，其中已在目录数据库里 %d 张" % (len(names), len(imported)))
    if missing:
        print("  ⚠️ 尚未导入 %d 张：" % len(missing))
        for n in missing[:20]:
            print("     %s" % n)
        if len(missing) > 20:
            print("     …另 %d 张" % (len(missing) - 20))
    if rated:
        print("  星级分布：%s" % {v: sum(1 for x in rated.values() if x == v) for v in sorted(set(rated.values()))})
    else:
        print("  星级：全部未评分")
    print("  已上色标：%d 张%s" % (len(labeled), "" if not labeled else " → " + ", ".join(
        sorted({v for v in labeled.values()}))))
    print("  已有关键词：%d 张" % len(report["keywords"]))
    print("  已进收藏夹：%d 张" % len(report["collections"]))

    print("\n② 建议")
    if missing:
        print("  有照片没进目录数据库——导入这一步可能没做完，先补导入再看。")
    else:
        print("  文件与目录数据库一致。调色是否真生效要以 get_develop_settings 读回为准，")
        print("  不能只看 export/preview 的返回值。")

    print("\n③ 等你")
    print("  核对无误就进入归档；有出入就回到对应阶段重做。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
