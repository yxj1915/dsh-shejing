#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""摄鲸 · 依赖自检

体检要算拉普拉斯方差、直方图、感知哈希，Pillow + numpy 是刚需。
系统 python3 通常没有它们——缺了就明确报错，绝不静默降级成"看起来跑了"。
"""
import glob
import importlib
import os
import shutil
import subprocess
import sys

REQUIRED = [("PIL", "Pillow"), ("numpy", "numpy")]
TOOLS = ["sips", "mdls"]


def runtimes():
    """DSH 自带的 Python 运行时位置。跟随 DSH_HOME，便于隔离实例。"""
    home = os.environ.get("DSH_HOME") or os.path.expanduser("~/.dsh")
    pats = [
        os.path.join(home, "dsh-runtimes/*/dependencies/python/bin/python3"),
        os.path.join(home, "dsh-runtimes/*/dependencies/python/bin/python3.[0-9]"),
        os.path.expanduser("~/.dsh/dsh-runtimes/*/dependencies/python/bin/python3"),
        os.path.expanduser("~/.dsh/dsh-runtimes/*/dependencies/python/bin/python3.[0-9]"),
    ]
    found = []
    for p in pats:
        # 排除 python3.12-config 之类不是解释器的可执行文件
        found += [f for f in glob.glob(p) if "-config" not in os.path.basename(f)]
    return sorted(set(found))


# 本机实测：Lightroom 装在 /Applications/Adobe Lightroom Classic，
# **没有 .app 后缀**（`open -a "Adobe Lightroom Classic"` 仍然可用）。
LR_CANDIDATES = [
    "/Applications/Adobe Lightroom Classic.app",
    "/Applications/Adobe Lightroom Classic",
]


def find_lightroom():
    for p in LR_CANDIDATES:
        if os.path.exists(p):
            return p
    return None


def main():
    print("摄鲸 · 依赖自检")
    print("  当前解释器 : %s" % sys.executable)
    print("  Python     : %s" % sys.version.split()[0])
    print()

    missing = []
    for mod, pkg in REQUIRED:
        try:
            m = importlib.import_module(mod)
            ver = getattr(m, "__version__", "?")
            print("  ✅ %-8s %s" % (pkg, ver))
        except ImportError:
            print("  ❌ %-8s 缺失" % pkg)
            missing.append(pkg)

    for t in TOOLS:
        path = shutil.which(t)
        print("  %s %-8s %s" % ("✅" if path else "❌", t, path or "缺失"))
        if not path:
            missing.append(t)

    lr = find_lightroom()
    print("  %s %-8s %s" % ("✅" if lr else "⚠️", "Lightroom",
                            lr or "未找到（导入/调色阶段需要）"))

    if missing:
        print("\n[失败] 缺少：%s" % "、".join(missing))
        rt = runtimes()
        if rt:
            print("\n请改用 DSH 自带的 Python 运行时（已含 Pillow/numpy）：")
            for r in rt:
                print("   %s" % r)
            print("\n例：\n   %s %s <源文件夹>" % (rt[0], os.path.basename(sys.argv[0])))
        else:
            print("\n未找到 DSH 自带运行时，请手动安装：pip install Pillow numpy")
        return 1

    print("\n[通过] 依赖齐备 ✅")
    return 0


if __name__ == "__main__":
    sys.exit(main())
