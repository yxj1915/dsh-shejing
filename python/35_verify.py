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




def column_names(con, table):
    """某张表真实有哪些列。不同 Lightroom 版本列名会不一样。"""
    try:
        return {row[1] for row in con.execute("PRAGMA table_info(%s)" % table)}
    except sqlite3.Error:
        return set()


def resolve_columns(con):
    """把列名解析成**这个目录数据库真实用的**名字。

    踩过的坑：我们最初假设 AgLibraryFile 有 `basename`、AgLibraryFolder 有 `path`，
    而真实 Lightroom 用的是 **`baseName`** 与 **`pathFromRoot`**。后果是
    「目录数据库交叉核对」在真实目录上直接抛 `no such column`，
    也就是 shejing_verify 的**最后一道防线从来没真正跑起来过**——
    单元测试用的合成库恰好按我们的假设建表，所以一路全绿。
    这里按 PRAGMA 的结果自适应，两种命名都能用。
    """
    file_cols = column_names(con, "AgLibraryFile")
    folder_cols = column_names(con, "AgLibraryFolder")
    return dict(
        basename="baseName" if "baseName" in file_cols else "basename",
        folder_path="pathFromRoot" if "pathFromRoot" in folder_cols else "path",
        has_root="absolutePath" in column_names(con, "AgLibraryRootFolder"),
    )


def resolve_columns_of(catalog):
    """打开一份只读副本，解析这个目录数据库**真实**用的列名。"""
    tmp = tempfile.mkdtemp(prefix="shejing-cat-cols-")
    try:
        for suffix in ("", "-wal", "-shm"):
            src = catalog + suffix
            if os.path.exists(src):
                shutil.copyfile(src, os.path.join(tmp, "cat.lrcat" + suffix))
        con = sqlite3.connect(os.path.join(tmp, "cat.lrcat"))
        try:
            return resolve_columns(con)
        finally:
            con.close()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

def _norm_path(p):
    """把路径规范化成可比较的键：绝对 + 归一 + 大小写折叠（macOS 默认不敏感）。"""
    return os.path.normpath(os.path.abspath(p)).casefold()


# 目录数据库里，「一张照片」的完整路径要跨三张表拼出来：
#   AgLibraryRootFolder.absolutePath  +  AgLibraryFolder.path  +  AgLibraryFile.basename.ext
#
# 原先只 SELECT fl.basename 然后按文件名建字典——这在两种很常见的情况下会给出
# **错误的答案**：
#   · 同名文件在别的文件夹里 → 一张从没导入过的照片被判成「已在目录里」，
#     而这正是 shejing_verify 存在的唯一理由（识破「返回 ok 但实际没生效」）。
#   · 虚拟副本 / 同一文件的多行 → 字典按行序任选一个，可能把主文件的 5 星覆盖成
#     副本的 0 星，于是那张照片**从导出清单里消失**。
FULL_PATH_SQL = (
    "SELECT rf.absolutePath, fo.path, fl.basename, fl.extension"
)
FULL_PATH_JOINS = (
    " LEFT JOIN AgLibraryFolder fo ON fo.id_local = fl.folder"
    " LEFT JOIN AgLibraryRootFolder rf ON rf.id_local = fo.rootFolder"
)


def full_path(root, folder, basename, extension):
    """拼出完整路径；缺根目录信息时返回 None（宁可漏报，也不要错配到别的文件）。"""
    if not basename or root is None:
        return None
    name = basename + (("." + extension) if extension else "")
    return os.path.join(root, folder or "", name)

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

    # 按**完整路径**取，不按文件名。同名文件在别的文件夹里时，按文件名会把
    # 「从没导入过」判成「已导入」——而识破这种假成功正是本脚本存在的理由。
    cols = resolve_columns_of(catalog)
    rows = query(
        catalog,
        "SELECT rf.absolutePath, fo.%s, fl.%s, fl.extension, i.rating, i.colorLabels, i.pick"
        " FROM Adobe_images i JOIN AgLibraryFile fl ON fl.id_local = i.rootFile"
        " LEFT JOIN AgLibraryFolder fo ON fo.id_local = fl.folder"
        " LEFT JOIN AgLibraryRootFolder rf ON rf.id_local = fo.rootFolder"
        % (cols["folder_path"], cols["basename"]),
    )
    by_path = {}
    for root, folder, base, ext, rating, labels, pick in rows:
        full = full_path(root, folder, base, ext)
        if full is None:
            continue
        key = _norm_path(full)
        entry = dict(rating=rating or 0, labels=labels or "", pick=pick or "")
        # 同一路径可能有多行（虚拟副本、堆栈）。取**星级最高**的那一行：
        # 行序是不确定的，用一个确定的规则，而且宁可多留一张 5 星，
        # 也不要把用户评过 5 星的照片静默丢掉。
        if key not in by_path or entry["rating"] > by_path[key]["rating"]:
            by_path[key] = entry

    def path_of(name):
        return _norm_path(os.path.join(keep_dir, name))

    kw_rows = query(
        catalog,
        "SELECT rf.absolutePath, fo.%s, fl.%s, fl.extension, k.name" % (cols["folder_path"], cols["basename"]) +
        " FROM AgLibraryKeywordImage ki"
        " JOIN AgLibraryKeyword k ON k.id_local = ki.tag"
        " JOIN Adobe_images i ON i.id_local = ki.image"
        " JOIN AgLibraryFile fl ON fl.id_local = i.rootFile"
        + FULL_PATH_JOINS,
    )
    keywords = {}
    for root, folder, base, ext, k in kw_rows:
        full = full_path(root, folder, base, ext)
        if full is not None:
            keywords.setdefault(_norm_path(full), []).append(k)

    coll_rows = query(
        catalog,
        "SELECT rf.absolutePath, fo.%s, fl.%s, fl.extension, c.name" % (cols["folder_path"], cols["basename"]) +
        " FROM AgLibraryCollectionImage ci"
        " JOIN AgLibraryCollection c ON c.id_local = ci.collection"
        " JOIN Adobe_images i ON i.id_local = ci.image"
        " JOIN AgLibraryFile fl ON fl.id_local = i.rootFile"
        + FULL_PATH_JOINS,
    )
    collections = {}
    for root, folder, base, ext, c in coll_rows:
        full = full_path(root, folder, base, ext)
        if full is not None:
            collections.setdefault(_norm_path(full), []).append(c)

    imported = [n for n in sorted(names) if path_of(n) in by_path]
    missing = [n for n in sorted(names) if path_of(n) not in by_path]
    rated = {n: by_path[path_of(n)]["rating"] for n in imported if by_path[path_of(n)]["rating"]}
    labeled = {n: by_path[path_of(n)]["labels"] for n in imported if by_path[path_of(n)]["labels"]}

    report = dict(
        batch=batch,
        catalog=catalog,
        keep_dir=keep_dir,
        in_folder=len(names),
        imported=len(imported),
        missing=missing,
        ratings={str(k): v for k, v in sorted(rated.items(), key=lambda x: -x[1])},
        color_labels=labeled,
        # 这两张表也是按**完整路径**作键的（与上面同一套逻辑），
        # 用文件名去查会永远查不到——我改键时差点把这里漏掉。
        keywords={n: keywords[path_of(n)] for n in imported if path_of(n) in keywords},
        collections={n: collections[path_of(n)] for n in imported if path_of(n) in collections},
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
