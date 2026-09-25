#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""25_rename.py（重命名）的回归测试。

**为什么这个测试存在**：重命名是整条流程里唯一真正**不可逆**的动作，而它在很长
一段时间里一个测试都没有——一个会**静默吃掉照片**的 bug 就住在那里：

    存在性检查全在 rename **之前**跑，所以两个文件算出同一个目标名时，两次检查
    都通过、都进了执行计划，第二次 os.rename 就把第一张覆盖了。POSIX 的 rename
    是**替换**语义：不报错、没备份、照片就没了。默认模板 `{date}_{name}` 就能触发
    （`2024-05-01_X.ARW` 与 `X.ARW` 同一天拍摄时都算成 `2024-06-01_X.ARW`）。

所以下面最重要的不是「改名对不对」，而是**内容守恒**：跑完之后，每张照片的内容
都必须还在某处，一个字都不能少。

用 DSH 自带运行时跑：
  <runtime-python> tests/test_rename.py
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
RENAME = os.path.join(HERE, "..", "python", "25_rename.py")

FAILURES = []


def case(label, condition, detail=""):
    print(("  ✅ " if condition else "  ❌ ") + label
          + (f"  {detail}" if detail and not condition else ""))
    if not condition:
        FAILURES.append(label)


def make_dir(files):
    """files: {文件名: 内容}。mtime 统一设成同一天，好让 {date} 可预期。"""
    root = tempfile.mkdtemp(prefix="shejing-rename-test-")
    for name, body in files.items():
        with open(os.path.join(root, name), "wb") as fh:
            fh.write(body)
        os.utime(os.path.join(root, name), (1750000000, 1750000000))  # 2025-06-15
    return root


def run(root, *extra):
    proc = subprocess.run([sys.executable, RENAME, root, *extra],
                          capture_output=True, text=True, check=False)
    return proc.returncode, proc.stdout, proc.stderr


def names(root):
    return sorted(os.listdir(root))


def contents(root):
    """目录里所有文件的内容（按文件名排序）——用来做守恒判定。"""
    out = {}
    for name in sorted(os.listdir(root)):
        full = os.path.join(root, name)
        if os.path.isfile(full):
            with open(full, "rb") as fh:
                out[name] = fh.read()
    return out


def all_bytes(root):
    return sorted(contents(root).values())


print("重命名脚本（25_rename.py）回归测试\n")

# ---- 1. 预演不动任何东西
root = make_dir({"AAA.ARW": b"photo-A", "BBB.ARW": b"photo-B"})
try:
    code, out, _ = run(root)
    case("预演退出码 0", code == 0)
    case("预演不改名", names(root) == ["AAA.ARW", "BBB.ARW"], str(names(root)))
    case("预演报告了计划", "→" in out)
finally:
    shutil.rmtree(root, ignore_errors=True)

# ---- 2. 正常改名：内容守恒
root = make_dir({"AAA.ARW": b"photo-A", "BBB.ARW": b"photo-B"})
try:
    code, out, _ = run(root, "--confirm")
    case("改名退出码 0", code == 0)
    case("两张都带上了日期前缀", names(root) == ["2025-06-15_AAA.ARW", "2025-06-15_BBB.ARW"],
         str(names(root)))
    case("内容守恒（一个字节都没变）",
         all_bytes(root) == sorted([b"photo-A", b"photo-B"]), str(contents(root)))
finally:
    shutil.rmtree(root, ignore_errors=True)

# ---- 3. **核心**：目标名冲突时，绝不能吃掉照片
root = make_dir({"2024-05-01_X.ARW": b"PHOTO-A-UNREPEATABLE", "X.ARW": b"PHOTO-B"})
try:
    code, out, _ = run(root, "--confirm")
    case("冲突时报告了原因", "冲突" in out, out[-200:])
    case("冲突时点明了撞在哪", "同一个目标名" in out or "目标名已存在" in out)
    case("★ 两张照片的内容都还在（一张都没被覆盖）",
         all_bytes(root) == sorted([b"PHOTO-A-UNREPEATABLE", b"PHOTO-B"]),
         str(contents(root)))
    case("★ 文件数没有减少", len(contents(root)) == 2, str(names(root)))
finally:
    shutil.rmtree(root, ignore_errors=True)

# ---- 4. 目标名已被**别的文件**占用时，不覆盖
root = make_dir({"AAA.ARW": b"NEW", "2025-06-15_AAA.ARW": b"OLD-PRECIOUS"})
try:
    code, out, _ = run(root, "--confirm")
    case("目标已存在时报告冲突", "目标名已存在" in out, out[-200:])
    case("★ 已存在的那个文件内容没被覆盖",
         b"OLD-PRECIOUS" in all_bytes(root), str(contents(root)))
    case("★ 文件数没有减少", len(contents(root)) == 2)
finally:
    shutil.rmtree(root, ignore_errors=True)

# ---- 5. 用 {seq} 模板可以避开冲突
root = make_dir({"2024-05-01_X.ARW": b"PHOTO-A", "X.ARW": b"PHOTO-B"})
try:
    code, out, _ = run(root, "--template", "{date}_{seq}_{name}", "--confirm")
    # 注意别把统计行里的「命名冲突 0 张」当成有冲突——断言要盯住那个 0。
    case("带 {seq} 的模板不冲突", "命名冲突 0 张" in out, out[-200:])
    case("两张都改成了唯一的名字", len(contents(root)) == 2
         and len({n for n in names(root)}) == 2, str(names(root)))
    case("内容守恒", all_bytes(root) == sorted([b"PHOTO-A", b"PHOTO-B"]))
finally:
    shutil.rmtree(root, ignore_errors=True)

# ---- 6. 已经符合模板的文件不动（幂等）
root = make_dir({"2025-06-15_AAA.ARW": b"photo-A"})
try:
    code, out, _ = run(root, "--confirm")
    case("已符合模板时无需改名", "无需改名" in out or "需要改名 0 张" in out, out[-160:])
    case("文件原样不动", names(root) == ["2025-06-15_AAA.ARW"])
finally:
    shutil.rmtree(root, ignore_errors=True)

# ---- 7. 空目录
root = make_dir({})
try:
    code, out, _ = run(root, "--confirm")
    case("空目录退出 0 且说明没有可重命名的照片",
         code == 0 and "没有可重命名的照片" in out, out[-160:])
finally:
    shutil.rmtree(root, ignore_errors=True)

# ---- 8. 不止一种扩展名时也不会互相覆盖
root = make_dir({"AAA.ARW": b"raw-A", "AAA.JPG": b"jpg-A"})
try:
    code, out, _ = run(root, "--confirm")
    case("同名不同扩展名各自独立", len(contents(root)) == 2, str(names(root)))
    case("内容守恒", all_bytes(root) == sorted([b"raw-A", b"jpg-A"]))
finally:
    shutil.rmtree(root, ignore_errors=True)

print()
if FAILURES:
    for name in FAILURES:
        print("❌ " + name)
    sys.exit(1)
print("✅ 全部重命名测试通过")
