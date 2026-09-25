#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""目录数据库查询的回归测试。

**为什么这个测试存在**：先说清一个容易搞混的地方——

    AgLibraryFile    basename  vs  baseName      → **不是问题**，SQLite 的标识符
                                                    大小写不敏感，两者是同一列
    AgLibraryFolder  path      vs  pathFromRoot  → **真的会炸**，这是两个不同的名字

真实 Lightroom 用的是 `baseName` 与 `pathFromRoot`。曾经有一版查询写了 `fo.path`，
于是目录核对在真实目录上直接抛 `no such column: fo.path`。
而单元测试没抓到，因为合成库是**按写查询时的假设**建的——用错误的假设去造测试
数据，等于给自己盖章。所以这个文件的合成库一律使用**从真实 Lightroom 目录数据库
里 PRAGMA 出来的列名**：

    AgLibraryFolder     id_local, id_global, parentId, pathFromRoot, rootFolder, visibility
    AgLibraryRootFolder id_local, id_global, absolutePath, name, relativePathFromCatalog
    AgLibraryFile       id_local, id_global, baseName, …, extension, folder, …

同时也验证旧命名仍能用（不同 Lightroom 版本列名不一样），因为查询是按 PRAGMA
自适应的。

用 DSH 自带运行时跑：
  <runtime-python> tests/test_catalog.py
"""
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
PYDIR = os.path.join(HERE, "..", "python")

FAILURES = []


def case(label, condition, detail=""):
    print(("  ✅ " if condition else "  ❌ ") + label
          + (f"  {detail}" if detail and not condition else ""))
    if not condition:
        FAILURES.append(label)


def build_catalog(path, *, modern=True):
    """建一个合成目录数据库。

    modern=True  用**真实** Lightroom 的列名（baseName / pathFromRoot）
    modern=False 用我们最初误以为的列名（basename / path），验证自适应仍然有效
    """
    con = sqlite3.connect(path)
    base_col = "baseName" if modern else "basename"
    path_col = "pathFromRoot" if modern else "path"
    con.executescript(f"""
    CREATE TABLE AgLibraryRootFolder (id_local INTEGER PRIMARY KEY, id_global TEXT, absolutePath TEXT, name TEXT, relativePathFromCatalog TEXT);
    CREATE TABLE AgLibraryFolder (id_local INTEGER PRIMARY KEY, id_global TEXT, parentId INTEGER, {path_col} TEXT, rootFolder INTEGER, visibility TEXT);
    CREATE TABLE AgLibraryFile (id_local INTEGER PRIMARY KEY, id_global TEXT, {base_col} TEXT, extension TEXT, folder INTEGER);
    CREATE TABLE Adobe_images (id_local INTEGER PRIMARY KEY, rootFile INTEGER, rating INTEGER, colorLabels TEXT, pick INTEGER);
    CREATE TABLE AgLibraryKeyword (id_local INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE AgLibraryKeywordImage (image INTEGER, tag INTEGER);
    CREATE TABLE AgLibraryCollection (id_local INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE AgLibraryCollectionImage (image INTEGER, collection INTEGER);
    """)
    return con


def seed(con, root_path, folder_rel, basename, ext, rating, file_id, folder_id, root_id):
    con.execute("INSERT OR IGNORE INTO AgLibraryRootFolder VALUES (?, '', ?, '', '')",
                (root_id, root_path))
    con.execute("INSERT OR IGNORE INTO AgLibraryFolder VALUES (?, '', 0, ?, ?, '')",
                (folder_id, folder_rel, root_id))
    con.execute("INSERT OR IGNORE INTO AgLibraryFile VALUES (?, '', ?, ?, ?)",
                (file_id, basename, ext, folder_id))
    con.execute("INSERT OR IGNORE INTO Adobe_images VALUES (?, ?, ?, '', 0)",
                (file_id * 10, file_id, rating))


def run(script, *args):
    proc = subprocess.run([sys.executable, os.path.join(PYDIR, script), *args],
                          capture_output=True, text=True, check=False)
    return proc.returncode, proc.stdout, proc.stderr


def scenario(modern):
    """一套完整的「同名文件在别处 + 虚拟副本」场景，返回 (exit, verify JSON)。"""
    root = tempfile.mkdtemp(prefix="shejing-cat-test-")
    catalog = os.path.join(root, "cat.lrcat")
    con = build_catalog(catalog, modern=modern)
    # 别处有一个同名文件（5 星）——旧实现会把我们这批没导入的那张判成「已导入」
    seed(con, os.path.join(root, "elsewhere"), "", "DSC0001", "ARW", 5, 100, 10, 1)
    # 我们这批：DSC0002 导入了（主文件 4 星 + 一个虚拟副本行 0 星）
    seed(con, os.path.join(root, "batch"), "", "DSC0002", "ARW", 4, 200, 20, 2)
    con.execute("INSERT INTO Adobe_images VALUES (2001, 200, 0, '', 0)")
    con.commit()
    con.close()

    batch = os.path.join(root, "batchdir")
    keep = os.path.join(root, "batch")
    os.makedirs(batch, exist_ok=True)
    os.makedirs(keep, exist_ok=True)
    for name in ("DSC0001.ARW", "DSC0002.ARW"):
        with open(os.path.join(keep, name), "wb") as fh:
            fh.write(b"x")
    with open(os.path.join(batch, "manifest.json"), "w") as fh:
        json.dump({"batch_id": "t", "source_path": keep, "photo_count": 2,
                   "stages": {"cull": {"keep_dir": keep}}}, fh)

    code, out, err = run("35_verify.py", batch, "--catalog", catalog, "--json")
    return root, code, out, err


print("目录数据库查询回归测试\n")

for modern in (True, False):
    label = "真实 Lightroom 列名（baseName / pathFromRoot）" if modern \
        else "旧命名（basename / path）——自适应仍应有效"
    print(f"—— {label} ——")
    root, code, out, err = scenario(modern)
    try:
        case("脚本不因列名而抛错", code == 0, (err or out)[-260:])
        if code != 0:
            continue
        data = json.loads(out)
        # 这是整个修复的核心：同名文件在别的文件夹里，**不能**判成已导入
        case("同名文件在别处时判为**未导入**（按完整路径比对）",
             data.get("missing") == ["DSC0001.ARW"], str(data.get("missing")))
        case("真的导入了的那张判为已导入",
             data.get("in_folder") == 2 and data.get("imported") == 1,
             f"in_folder={data.get('in_folder')} imported={data.get('imported')}")
        case("虚拟副本的 0 星不覆盖主文件的 4 星",
             (data.get("ratings") or {}).get("DSC0002.ARW") == 4,
             str(data.get("ratings")))
    finally:
        shutil.rmtree(root, ignore_errors=True)
    print()

# 导出计划也要能用同一套列名
print("—— 导出计划（30_export.py）——")
root = tempfile.mkdtemp(prefix="shejing-cat-export-")
try:
    catalog = os.path.join(root, "cat.lrcat")
    con = build_catalog(catalog, modern=True)
    seed(con, os.path.join(root, "batch"), "", "DSC0002", "ARW", 5, 200, 20, 2)
    con.commit()
    con.close()
    batch = os.path.join(root, "batchdir")
    keep = os.path.join(root, "batch")
    os.makedirs(batch, exist_ok=True)
    os.makedirs(keep, exist_ok=True)
    with open(os.path.join(keep, "DSC0002.ARW"), "wb") as fh:
        fh.write(b"x")
    with open(os.path.join(batch, "manifest.json"), "w") as fh:
        json.dump({"batch_id": "t", "source_path": keep, "photo_count": 1,
                   "stages": {"cull": {"keep_dir": keep}}}, fh)
    plan_path = os.path.join(root, "plan.json")
    code, out, err = run("30_export.py", batch, "--catalog", catalog, "--json", plan_path)
    case("导出计划不因列名而抛错", code == 0, (err or out)[-260:])
    if code == 0 and os.path.exists(plan_path):
        with open(plan_path) as fh:
            plan = json.load(fh)
        case("5 星照片被选进导出候选",
             plan.get("picked") == ["DSC0002.ARW"], str(plan.get("picked")))
        case("星级确实读到了（不是一片 0）",
             (plan.get("distribution") or {}).get("5") == 1, str(plan.get("distribution")))
finally:
    shutil.rmtree(root, ignore_errors=True)

print()
if FAILURES:
    for name in FAILURES:
        print("❌ " + name)
    sys.exit(1)
print("✅ 全部目录数据库测试通过")
