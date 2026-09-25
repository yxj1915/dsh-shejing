#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""分组算法的回归测试。

**为什么这个测试存在**：端到端回归曾经抓到「传了 28 个待剔名字，只剔掉 27 张」。
根因不是文件操作，而是分组算法：内层循环把一帧加进组时没检查它是否已被前一组
占用，于是同一帧落进两个组，待剔名单出现重复项。

这个 bug 的可怕之处在于它**不报错、不崩溃**——只是少剔一张。所以必须有测试守住
「分组是划分」这个不变量。

用 DSH 自带运行时跑：
  <runtime-python> tests/test_grouping.py
"""
import importlib.util
import os
import sys
from datetime import datetime, timedelta

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
PYDIR = os.path.join(HERE, "..", "python")
CHECKUP = os.path.join(PYDIR, "10_checkup.py")

# 10_checkup.py 会 import exif（同目录），所以要把 python/ 放进 sys.path。
sys.path.insert(0, PYDIR)

spec = importlib.util.spec_from_file_location("checkup", CHECKUP)
checkup = importlib.util.module_from_spec(spec)
sys.modules["checkup"] = checkup
spec.loader.exec_module(checkup)

# 8 位哈希。A/B 差 1 位；C 与 A 全反（差 8 位）；D 全 0。
A = [1, 0, 1, 0, 1, 0, 1, 0]
B = [1, 0, 1, 0, 1, 0, 1, 1]
C = [0, 1, 0, 1, 0, 1, 0, 1]
D = [0, 0, 0, 0, 0, 0, 0, 0]

FAILURES = []


def frame(name, seconds, bits):
    return dict(
        name=name,
        time=datetime(2026, 9, 25, 12, 0, 0) + timedelta(seconds=seconds),
        hash=np.array(bits, dtype=np.uint8),
        small=None, big=None, sharp=1.0, peak=0, ev=-10.0,
    )


def group(frames, window=60.0, hash_max=4):
    return checkup.group_bursts([dict(f) for f in frames], window, hash_max)


def names(groups):
    return [[f["name"] for f in g] for g in groups]


def assert_partition(label, groups):
    """不变量：一帧最多属于一组。"""
    seen = {}
    for gi, g in enumerate(groups):
        for f in g:
            if f["name"] in seen:
                FAILURES.append(f"{label}: {f['name']} 同时在组 {seen[f['name']]} 和 {gi}")
            seen[f["name"]] = gi
    return seen


def case(label, frames, expected, window=60.0, hash_max=4):
    groups = group(frames, window, hash_max)
    assert_partition(label, groups)
    got = names(groups)
    ok = sorted(got) == sorted(expected)
    print(("  ✅ " if ok else "  ❌ ") + label)
    if not ok:
        print(f"       期望 {expected}")
        print(f"       实际 {got}")
        FAILURES.append(f"{label}: 期望 {expected}，实际 {got}")


print("分组算法回归测试\n")

case("三帧相近 → 一组", [frame("f0", 0, A), frame("f1", 1, B), frame("f2", 2, B)],
     [["f0", "f1", "f2"]])

case("中间隔一个不像的 → 不像的不进组",
     [frame("f0", 0, A), frame("f1", 1, C), frame("f2", 2, B), frame("f3", 3, B)],
     [["f0", "f2", "f3"]])

case("超出时间窗口 → 不成组", [frame("f0", 0, A), frame("f1", 120, B)], [], window=60.0)

case("单帧不成组", [frame("f0", 0, A), frame("f1", 90, D)], [])

# 这正是旧算法会产生重叠的构造：种子 f0 吃下 f2；未占用的 f1（不像 f0）
# 会开新组，并把已属于前一组的 f2/f3 再抓一次。
case("旧算法会重叠的构造 → 现在必须是划分",
     [frame("f0", 0, A), frame("f1", 1, C), frame("f2", 2, B), frame("f3", 3, B)],
     [["f0", "f2", "f3"]])

# 随机压力测试：任意输入下都不许重叠。
rng = np.random.default_rng(20260925)
for trial in range(200):
    n = int(rng.integers(2, 24))
    frames = []
    for i in range(n):
        bits = rng.integers(0, 2, size=8)
        # 制造大量近重复：一半帧是从某个基底翻 0–2 位
        if i > 0 and rng.random() < 0.6:
            bits = frames[int(rng.integers(0, len(frames)))]["hash"].copy()
            for _ in range(int(rng.integers(0, 3))):
                bits[int(rng.integers(0, 8))] ^= 1
        frames.append(frame(f"t{trial}_{i}", float(rng.integers(0, 180)), list(bits)))
    groups = group(frames, window=60.0, hash_max=3)
    assert_partition(f"随机 {trial}", groups)

print("  ✅ 随机压力 200 轮：无重叠")

print()
if FAILURES:
    for failure in FAILURES:
        print("❌ " + failure)
    sys.exit(1)
print("✅ 全部分组测试通过")
