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
            cols = resolve_columns(con)
            rows = con.execute(
                "SELECT rf.absolutePath, fo.%s, fl.%s, fl.extension, i.rating"
                " FROM Adobe_images i JOIN AgLibraryFile fl ON fl.id_local=i.rootFile"
                " LEFT JOIN AgLibraryFolder fo ON fo.id_local = fl.folder"
                " LEFT JOIN AgLibraryRootFolder rf ON rf.id_local = fo.rootFolder"
                % (cols["folder_path"], cols["basename"])).fetchall()
        finally:
            con.close()
        # 按**完整路径**取。按文件名的话，同名文件在别的文件夹里会让一张
        # 从没导入、没评过星的照片顶替掉真的那张。
        out = {}
        for root, folder, base, ext, rating in rows:
            full = full_path(root, folder, base, ext)
            if full is None:
                continue
            key = _norm_path(full)
            value = rating or 0
            if key not in out or value > out[key]:
                out[key] = value
        return out
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

    def stars_of(name):
        """按**完整路径**取星级——map 的键是规范化绝对路径，不是文件名。"""
        if stars is None:
            return 0
        return stars.get(_norm_path(os.path.join(keep_dir, name)), 0)
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
                  if f not in exclude and stars_of(f) >= args.threshold]
        why = "星级 ≥ %g" % args.threshold
        distribution = {int(v): sum(1 for x in cand_files if stars_of(x) == v)
                        for v in sorted({stars_of(f) for f in cand_files})}

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
