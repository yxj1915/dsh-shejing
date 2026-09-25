#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""20_split.py（剔除）的回归测试。

**为什么这个测试存在**：真机流水线抓到过一个「预演与真跑不一致」的 bug——
零剔除时，预演说「mv 其余 3 张 → 可导入/」，真跑却说「没有待剔文件，什么都不做」。

危险之处在于它**不影响有剔除项的正常路径**：75 张那批有 27 个待剔，所以
`to_move` 非空，永远走不到那个提前退出的分支。只有「体检后决定全留」这种最省心的
用法才会踩到，而那时用户会以为照片已经整理好了。

核心不变量：**预演说的计划，必须与真跑的结果一致。**

用 DSH 自带运行时跑：
  <runtime-python> tests/test_split.py
"""
import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
PYDIR = os.path.join(HERE, "..", "python")
SPLIT = os.path.join(PYDIR, "20_split.py")

FAILURES = []


def case(label, condition, detail=""):
    print(("  ✅ " if condition else "  ❌ ") + label + (f"  {detail}" if detail and not condition else ""))
    if not condition:
        FAILURES.append(label)


def make_dir(count):
    root = tempfile.mkdtemp(prefix="shejing-split-test-")
    for i in range(count):
        with open(os.path.join(root, f"DSC{i:04d}.ARW"), "wb") as fh:
            fh.write(b"not-a-real-raw")
    return root


def run(root, *extra):
    proc = subprocess.run(
        [sys.executable, SPLIT, root, *extra],
        capture_output=True, text=True, check=False,
    )
    return proc.returncode, proc.stdout, proc.stderr


def listing(root, name):
    target = os.path.join(root, name)
    if not os.path.isdir(target):
        return None
    return sorted(f for f in os.listdir(target) if f.upper().endswith(".ARW"))


def in_root(root):
    return sorted(f for f in os.listdir(root)
                  if f.upper().endswith(".ARW") and os.path.isfile(os.path.join(root, f)))


print("剔除脚本（20_split.py）回归测试\n")

# ---- 1. 预演什么都不动
root = make_dir(5)
try:
    code, out, _ = run(root)
    case("预演退出码为 0", code == 0)
    case("预演不建目录", listing(root, "可导入") is None and listing(root, "非导入") is None)
    case("预演不动文件", len(in_root(root)) == 5, f"根目录还有 {len(in_root(root))} 张")
    case("预演报告了计划", "mv <其余 5 张>" in out and "mv <待剔的 0 张>" in out)
finally:
    shutil.rmtree(root, ignore_errors=True)

# ---- 2. 零剔除：**全部**应当进 可导入/（就是那个 bug）
root = make_dir(5)
try:
    code, out, _ = run(root, "--confirm")
    case("零剔除时真跑退出码为 0", code == 0)
    case("零剔除时建起了 可导入/", listing(root, "可导入") is not None)
    case("零剔除时建起了 非导入/", listing(root, "非导入") is not None)
    case("零剔除时 5 张全部进 可导入/",
         len(listing(root, "可导入") or []) == 5, f"实际 {len(listing(root, '可导入') or [])} 张")
    case("零剔除时 非导入/ 为空", len(listing(root, "非导入") or []) == 0)
    case("零剔除时根目录不再有照片", len(in_root(root)) == 0)
    case("零剔除时不再输出「什么都不做」", "什么都不做" not in out)
finally:
    shutil.rmtree(root, ignore_errors=True)

# ---- 3. 部分剔除
root = make_dir(5)
try:
    code, out, _ = run(root, "--reject", "DSC0001.ARW", "DSC0002.ARW", "--confirm")
    case("部分剔除退出码为 0", code == 0)
    case("被剔的 2 张进了 非导入/", len(listing(root, "非导入") or []) == 2)
    case("其余 3 张进了 可导入/", len(listing(root, "可导入") or []) == 3)
    case("总数守恒", (len(listing(root, "可导入") or []) + len(listing(root, "非导入") or [])) == 5)
    case("清单里的文件确实是被剔的那两个",
         listing(root, "非导入") == ["DSC0001.ARW", "DSC0002.ARW"])
finally:
    shutil.rmtree(root, ignore_errors=True)

# ---- 4. 清单里有不存在的文件名：要警告但不因此什么都不做
root = make_dir(3)
try:
    code, out, _ = run(root, "--reject", "不存在.ARW", "--confirm")
    case("清单含无效名时仍退出 0", code == 0)
    case("清单含无效名时给出警告", "找不到" in out)
    case("清单含无效名时其余照片仍进 可导入/", len(listing(root, "可导入") or []) == 3,
         f"实际 {len(listing(root, '可导入') or [])} 张")
finally:
    shutil.rmtree(root, ignore_errors=True)

# ---- 5. 空目录
root = make_dir(0)
try:
    code, out, _ = run(root, "--confirm")
    case("空目录时退出 0 且说明无需整理", code == 0 and "没有可整理的照片" in out)
finally:
    shutil.rmtree(root, ignore_errors=True)

# ---- 6. 重复 flag 与单 flag 等价（回归：nargs='*' 只保留最后一次）
root_a = make_dir(4)
root_b = make_dir(4)
try:
    run(root_a, "--reject", "DSC0001.ARW", "--reject", "DSC0002.ARW", "--confirm")
    run(root_b, "--reject", "DSC0001.ARW", "DSC0002.ARW", "--confirm")
    case("重复 --reject 与单个 --reject 结果一致",
         listing(root_a, "非导入") == listing(root_b, "非导入") == ["DSC0001.ARW", "DSC0002.ARW"])
finally:
    shutil.rmtree(root_a, ignore_errors=True)
    shutil.rmtree(root_b, ignore_errors=True)

# ---- 7. 目标已存在时**不覆盖**（第二张卡同名文件那种情况）
root = make_dir(1)
try:
    os.makedirs(os.path.join(root, "非导入"))
    with open(os.path.join(root, "非导入", "DSC0000.ARW"), "wb") as fh:
        fh.write(b"OLD-PHOTO-FROM-CARD-1")
    # make_dir 造的是 DSC0000.ARW
    code, out, _ = run(root, "--reject", "DSC0000.ARW", "--confirm")
    with open(os.path.join(root, "非导入", "DSC0000.ARW"), "rb") as fh:
        kept = fh.read()
    case("目标已存在时不覆盖旧文件", kept == b"OLD-PHOTO-FROM-CARD-1", kept[:30])
    case("目标已存在时源文件留在原地", os.path.exists(os.path.join(root, "DSC0000.ARW")))
    case("跳过时说清了原因", "没有覆盖" in out or "已有同名文件" in out)
finally:
    shutil.rmtree(root, ignore_errors=True)

root = make_dir(1)
try:
    os.makedirs(os.path.join(root, "可导入"))
    with open(os.path.join(root, "可导入", "DSC0000.ARW"), "wb") as fh:
        fh.write(b"EARLIER-KEEP")
    code, out, _ = run(root, "--confirm")
    with open(os.path.join(root, "可导入", "DSC0000.ARW"), "rb") as fh:
        kept = fh.read()
    case("可导入/ 里已存在同名文件时也不覆盖", kept == b"EARLIER-KEEP", kept[:30])
finally:
    shutil.rmtree(root, ignore_errors=True)

# ---- 8. 剔单项必须是纯粹的文件名，不能是路径
# 注意：每条命令都用**独立的**源目录——前一条会真的把照片搬走。
root = make_dir(2)
try:
    os.makedirs(os.path.join(root, "可导入"))
    code, out, _ = run(root, "--reject", "可导入", "--confirm")
    case("目录名被识别为非法条目", "不是本次要处理的照片" in out)
    case("目录没被搬走", os.path.isdir(os.path.join(root, "可导入")))
finally:
    shutil.rmtree(root, ignore_errors=True)

root = make_dir(2)
try:
    # 在源目录**外面**放一个同名文件：`../outside.ARW` 这条路径曾经会被 rename
    # 进源目录，下一次拆分就当成本批照片送进 Lightroom。
    outside = os.path.join(os.path.dirname(root), "outside.ARW")
    with open(outside, "wb") as fh:
        fh.write(b"MUST-NOT-BE-DRAGGED-IN")
    code, out, _ = run(root, "--reject", "../outside.ARW", "--confirm")
    case("../ 路径被识别为非法条目", "不是纯粹的文件名" in out)
    case("源目录外的文件没有被拖进来", not os.path.exists(os.path.join(root, "outside.ARW")))
    case("源目录外的文件原地未动", os.path.exists(outside))
    # 零个有效剔单项 → 两张都该进 可导入/（这正是「全留」的语义）
    case("零有效剔单项时两张都进 可导入/", len(listing(root, "可导入") or []) == 2,
         str(listing(root, "可导入")))
    case("照片总数守恒", (len(listing(root, "可导入") or []) + len(listing(root, "非导入") or [])) == 2)
    os.remove(outside)
finally:
    shutil.rmtree(root, ignore_errors=True)

# ---- 9. 大小写不一致时，剔除的必须是磁盘上那一张，其余照常进 可导入/
if os.path.exists("/System/Library/CoreServices") or sys.platform == "darwin":
    root = make_dir(2)
    try:
        code, out, _ = run(root, "--reject", "dsc0001.ARW", "--confirm")
        case("大小写不同也认得是同一张", listing(root, "非导入") == ["DSC0001.ARW"],
             str(listing(root, "非导入")))
        case("没被剔的那张进了 可导入/", listing(root, "可导入") == ["DSC0000.ARW"],
             str(listing(root, "可导入")))
        case("根目录清空", len(in_root(root)) == 0)
    finally:
        shutil.rmtree(root, ignore_errors=True)

print()
if FAILURES:
    for name in FAILURES:
        print("❌ " + name)
    sys.exit(1)
print("✅ 全部剔除测试通过")
