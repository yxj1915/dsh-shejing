#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""摄鲸 · 体检（只读）

在**导入 Lightroom 之前**跑。产出：连拍分组、组内清晰度、组内曝光跨度、类型判定、
亮度溢出统计、contact sheet、以及批次 manifest 的 checkup 段。

本脚本不写任何照片、不碰 Lightroom 目录、不做任何剔除——只报告。
剔除是下一步 `20_split.py` 的事，而且要过门禁。

用法：
  10_checkup.py <源文件夹> [--out <批次目录>]
                [--window 60] [--hash-max 14] [--bracket-ev 0.8] [--grid 6]
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone

import numpy as np
from PIL import Image, ImageDraw, ImageOps

import exif

RAW_EXT = {".arw", ".cr2", ".cr3", ".nef", ".dng", ".raf", ".orf", ".rw2",
           ".jpg", ".jpeg", ".tif", ".tiff", ".png"}
CST = timezone(timedelta(hours=8))
SHEET_CELL, SHEET_COLS, SHEET_PAD = 300, 9, 22
# 每张照片只解码到这个宽度一次，小图与清晰度分析都从它派生。
BIG_WIDTH = 1200


# ------------------------------------------------------------------ 基础工具
def sh(cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


def mdls_one(path, attrs):
    """单文件取 Spotlight 属性。逐个调用比批量更好解析，且 75 次也就几秒。"""
    args = ["mdls"]
    for a in attrs:
        args += ["-name", a]
    args.append(path)
    out = sh(args).stdout
    d = {}
    for line in out.splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            d[k.strip()] = v.strip()
    return d


def num(v):
    if v is None or v in ("(null)", ""):
        return None
    try:
        return float(v)
    except ValueError:
        return None


def group_bursts(known, window, hash_max):
    """把按时间排好序的帧分成连拍/近似重复组。

    **保证是划分**：一帧最多属于一组，各组两两不相交。

    这个保证不是可有可无的：分组一旦重叠，同一帧会带着互相矛盾的建议出现两次
    （在某组是「建议保留」、在另一组是「建议剔除」），而待剔名单会出现重复项，
    于是「传了 N 个名字只剔掉 N-1 张」这种错误就静默发生。
    端到端回归正是这样抓到的——28 个名字只有 27 个唯一值。

    贪婪扫描：按时间取一个未占用的种子，向后在时间窗口内找哈希相近的帧；
    种子与成员都必须未占用。
    """
    for it in known:
        # 已经有哈希就不重算——这让分组逻辑可以用合成数据单测（不必真解码图片）。
        # 兜底来源是**大图**而不是缩略图：哈希不该依赖派生出来的图，否则换一个
        # 重采样核就可能让分组漂移。
        if it.get("hash") is None and it.get("big"):
            it["hash"] = dhash(it["big"])

    used, groups = set(), []
    for i, a in enumerate(known):
        if i in used or a["hash"] is None:
            continue
        grp, j = [a], i + 1
        while j < len(known):
            b = known[j]
            if (b["time"] - a["time"]).total_seconds() > window:
                break
            if j not in used and b["hash"] is not None and \
                    int(np.count_nonzero(a["hash"] != b["hash"])) <= hash_max:
                grp.append(b)
                used.add(j)
            j += 1
        if len(grp) > 1:
            used.add(i)
            groups.append(sorted(grp, key=lambda x: x["time"]))
    return groups


def ev_rel(exposure_seconds, fnumber, iso):
    """相对曝光（档）。值越大 = 曝光越多。"""
    if not exposure_seconds or not fnumber:
        return None
    iso = iso or 100.0
    return (np.log2(exposure_seconds)
            - 2 * np.log2(fnumber)
            + np.log2(iso / 100.0))


def _usable(path):
    """缓存文件能不能用：存在、非空、且文件头能被解析。

    只判断 os.path.exists 是不够的：一个 0 字节或被中断留下的半截文件会一直
    留在缓存里，之后**每次**运行都会在解码它时崩掉，而且自己不会恢复。
    """
    try:
        if os.path.getsize(path) == 0:
            return False
        with Image.open(path) as im:
            im.verify()
        return True
    except Exception:
        return False


def cache_key(path, idx):
    """缓存文件名 = 序号 + 源文件身份的短哈希。

    带上身份，源文件一变（换了内容、被替换、顺序变了）就必然落到新的缓存项，
    不会命中别人的图。序号保留只是为了文件名可读、以及让同一批的缓存排在一起。
    """
    try:
        st = os.stat(path)
        ident = "%s|%d|%d" % (os.path.basename(path), st.st_size, st.st_mtime_ns)
    except OSError:
        ident = os.path.basename(path)
    return "%03d_%s" % (idx, hashlib.sha1(ident.encode("utf-8")).hexdigest()[:10])


def decode(src, dst, width):
    if _usable(dst):
        return True
    if os.path.exists(dst):
        try:
            os.remove(dst)      # 坏缓存清掉，否则会一直毒着
        except OSError:
            pass
    r = sh(["sips", "-s", "format", "jpeg", "--resampleWidth", str(width),
            src, "--out", dst])
    return r.returncode == 0 and os.path.exists(dst)


def shrink(src, dst, width):
    """从已解码的大图派生小图。

    sips 解码一张 ARW 约 7 秒，Pillow 缩一张 1200px JPEG 约 0.05 秒——
    所以每张只该调一次 sips，其余尺寸用 Pillow 派生。失败返回 False，
    由调用方回退到 sips。
    """
    if _usable(dst):
        return True
    if os.path.exists(dst):
        try:
            os.remove(dst)
        except OSError:
            pass
    try:
        im = ImageOps.exif_transpose(Image.open(src))
        im.thumbnail((width, width), Image.LANCZOS)
        im.convert("RGB").save(dst, "JPEG", quality=88)
        return os.path.exists(dst)
    except Exception:
        return False


def gray(path):
    return np.asarray(ImageOps.exif_transpose(Image.open(path)).convert("L"),
                      dtype=np.float64)


def lap_var(a):
    if a.shape[0] < 3 or a.shape[1] < 3:
        return 0.0
    lap = (-4 * a[1:-1, 1:-1] + a[:-2, 1:-1] + a[2:, 1:-1]
           + a[1:-1, :-2] + a[1:-1, 2:])
    return float(lap.var())


def tile_peak(a, grid):
    """返回最清晰（拉普拉斯方差最大）的块编号，用于识别堆栈的合焦面移动。"""
    h, w = a.shape
    best, best_v = -1, -1.0
    for r in range(grid):
        for c in range(grid):
            y0, y1 = int(h * r / grid), int(h * (r + 1) / grid)
            x0, x1 = int(w * c / grid), int(w * (c + 1) / grid)
            v = lap_var(a[y0:y1, x0:x1])
            if v > best_v:
                best_v, best = v, r * grid + c
    return best


def dhash(path, size=8):
    im = ImageOps.exif_transpose(Image.open(path)).convert("L").resize(
        (size + 1, size), Image.LANCZOS)
    a = np.asarray(im, dtype=np.int16)
    return (a[:, 1:] > a[:, :-1]).flatten()


def luma_stats(path):
    im = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
    a = np.asarray(im, dtype=np.float32) / 255.0
    luma = 0.2126 * a[:, :, 0] + 0.7152 * a[:, :, 1] + 0.0722 * a[:, :, 2]
    mx, mn = a.max(axis=2), a.min(axis=2)
    sat = np.where(mx > 1e-6, (mx - mn) / np.maximum(mx, 1e-6), 0.0)
    return dict(mean=float(luma.mean()), std=float(luma.std()),
                p95=float(np.percentile(luma, 95)),
                hi_clip=float((luma > 0.98).mean()),
                lo_clip=float((luma < 0.02).mean()),
                sat=float(sat.mean()))


# ------------------------------------------------------------------ 主流程
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("source")
    ap.add_argument("--out", default=None, help="批次目录，默认 <shejing>/batches/<批次>")
    ap.add_argument("--window", type=float, default=60.0, help="连拍时间窗口（秒）")
    ap.add_argument("--hash-max", type=int, default=14, help="dHash 汉明距离阈值")
    ap.add_argument("--bracket-ev", type=float, default=0.8, help="≥ 此跨度判为包围曝光")
    ap.add_argument("--grid", type=int, default=6, help="堆栈判定的分块数")
    ap.add_argument("--no-sheet", action="store_true")
    args = ap.parse_args()

    src = os.path.abspath(args.source)
    if not os.path.isdir(src):
        print("源文件夹不存在：%s" % src)
        return 1

    batch = os.path.basename(src.rstrip("/")) or "batch"
    out = args.out or os.path.join(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__))), "batches",
        "%s_%s" % (datetime.now().strftime("%Y-%m-%d"), batch))
    os.makedirs(out, exist_ok=True)
    cache = os.path.join(out, "_cache")
    os.makedirs(cache, exist_ok=True)
    run_keys = set()   # 本次运行用到的缓存键，收尾时清掉不属于它们的旧文件

    files = sorted(f for f in os.listdir(src)
                   if os.path.splitext(f)[1].lower() in RAW_EXT
                   and os.path.isfile(os.path.join(src, f)))
    if not files:
        print("源文件夹里没有找到照片：%s" % src)
        return 1
    print("体检 · %s（%d 张）\n" % (src, len(files)))

    items = []
    mdls_used = 0
    for i, f in enumerate(files, 1):
        p = os.path.join(src, f)

        # 主路径：直接读文件内嵌 EXIF。不依赖 Spotlight——外置盘、网络盘、
        # 点号目录、刚拷贝进来的文件都能正常工作。
        md = exif.read_exif(p)

        dt = None
        raw_dt = md.get("datetime")
        if raw_dt:
            try:
                dt = datetime.strptime(raw_dt, "%Y:%m:%d %H:%M:%S").replace(tzinfo=CST)
            except ValueError:
                dt = None

        # 只有 EXIF 缺关键字段时才退回 mdls（保留旧行为作为兜底）。
        m = {}
        if md.get("exposure") is None or md.get("fnumber") is None or dt is None:
            mdls_used += 1
            m = mdls_one(p, ["kMDItemContentCreationDate", "kMDItemFNumber",
                             "kMDItemExposureTimeSeconds", "kMDItemISOSpeed",
                             "kMDItemFocalLength", "kMDItemAcquisitionModel"])
            if dt is None:
                raw_fs = m.get("kMDItemContentCreationDate")
                if raw_fs and raw_fs != "(null)":
                    try:
                        dt = datetime.strptime(raw_fs, "%Y-%m-%d %H:%M:%S %z").astimezone(CST)
                    except ValueError:
                        dt = None

        def pick(exif_value, mdls_key):
            if exif_value is not None:
                return float(exif_value)
            return num(m.get(mdls_key))

        # 每张**只调一次 sips**：实测单次 sips 解码 ARW 约 7 秒，而 Pillow 从
        # 1200px 缩到 300px 只要 0.05 秒。原先每张调两次 sips，75 张要 17 分钟、
        # 500 张要两小时；现在砍掉一半。
        # 缓存键必须带上**源文件的身份**（名字 + 大小 + mtime），不能只用序号。
        #
        # 只用 `%03d` 时：删掉一张照片再重跑，后面的文件整体前移一位却命中了
        # 前一张的缓存——B 的清晰度、感知哈希与缩略图全变成 A 的。而 contact
        # sheet 与「清晰度」那一列正是用户拿来决定剔哪张的依据，于是他会**照着
        # 错的证据剔错帧**；感知哈希错了还会连带把分组也分错。
        key = cache_key(p, i)
        run_keys.add(key)
        big = os.path.join(cache, key + "_big.jpg")
        decode(p, big, BIG_WIDTH)
        small = os.path.join(cache, key + "_small.jpg")
        if not shrink(big, small, SHEET_CELL):
            decode(p, small, SHEET_CELL)  # 兜底：Pillow 失败时回退到 sips
        exposure = pick(md.get("exposure"), "kMDItemExposureTimeSeconds")
        fnumber = pick(md.get("fnumber"), "kMDItemFNumber")
        iso = pick(md.get("iso"), "kMDItemISOSpeed")
        model = md.get("model") or (m.get("kMDItemAcquisitionModel") or "").strip('"')
        items.append(dict(
            idx=i, name=f, path=p, time=dt,
            fnumber=fnumber,
            exposure=exposure,
            iso=iso,
            focal=pick(md.get("focal"), "kMDItemFocalLength"),
            model=model,
            small=small if os.path.exists(small) else None,
            big=big if os.path.exists(big) else None,
            # 感知哈希从**大图**算：它决定分组，不该随缩略图的生成方式变化。
            hash=dhash(big) if os.path.exists(big) else None,
            ev=ev_rel(exposure, fnumber, iso),
        ))
        if i % 20 == 0:
            print("  读取 EXIF/解码 %d/%d" % (i, len(files)))

    # ---- 清晰度（全部）与分块合焦面（用于堆栈判定）
    # 清掉不属于本次运行的旧缓存（比如上一版按序号命名的、或已删除照片的）。
    # 不做的话 _cache 会随着每次导入/删除无限增长，而它就在批次目录里。
    for stale in os.listdir(cache):
        stem = stale.rsplit("_", 1)[0]
        if stem not in run_keys:
            try:
                os.remove(os.path.join(cache, stale))
            except OSError:
                pass

    print("  计算清晰度…")
    for it in items:
        it["sharp"] = lap_var(gray(it["big"])) if it["big"] else None
        it["peak"] = tile_peak(gray(it["big"]), args.grid) if it["big"] else None

    # ---- 连拍分组：时间窗口 + 感知哈希
    known = [it for it in items if it["time"]]
    known.sort(key=lambda x: x["time"])
    groups = group_bursts(known, args.window, args.hash_max)

    # ---- 每组：类型判定 + 保留建议
    report_groups = []
    for g in groups:
        evs = [x["ev"] for x in g if x["ev"] is not None]
        spread = (max(evs) - min(evs)) if evs else None
        peaks = [x["peak"] for x in g if x["peak"] is not None]
        peak_moves = len(set(peaks)) > 1 if peaks else False
        shs = [x["sharp"] for x in g if x["sharp"] is not None]

        if spread is not None and spread >= args.bracket_ev:
            kind = "包围曝光"
        elif len(g) >= 3 and spread is not None and spread < 0.1 and peak_moves:
            kind = "疑似堆栈"
        else:
            kind = "连拍"

        keep = max(g, key=lambda x: x["sharp"] or 0) if shs else g[0]
        # 锐度差距是否落在噪声范围内 → 我的判断是否可靠
        reliable = False
        if len(shs) >= 2 and max(shs) > 0:
            reliable = (max(shs) - sorted(shs)[-2]) / max(shs) > 0.05

        report_groups.append(dict(
            count=len(g), start=g[0]["name"], end=g[-1]["name"],
            span_s=(g[-1]["time"] - g[0]["time"]).total_seconds(),
            ev_spread=None if spread is None else round(spread, 2),
            kind=kind, peak_moves=peak_moves,
            reliable=reliable,
            keep=(keep["name"] if kind == "连拍" else None),
            frames=[dict(name=x["name"], time=x["time"].strftime("%H:%M:%S"),
                         sharp=None if x["sharp"] is None else round(x["sharp"], 1),
                         ev=None if x["ev"] is None else round(x["ev"], 2))
                    for x in g]))

    # ---- 全批统计 + 跨场景锐度异常（仅供参考，绝不自动移动）
    print("  计算亮度统计…")
    stat_rows = []
    for it in items:
        if it["small"]:
            s = luma_stats(it["small"])
            s["name"] = it["name"]
            stat_rows.append(s)
    shs = [it["sharp"] for it in items if it["sharp"]]
    med = float(np.median(shs)) if shs else 0.0
    outliers = sorted([it for it in items
                       if it["sharp"] is not None and med > 0
                       and it["sharp"] < med * 0.35],
                      key=lambda x: x["sharp"])
    hi_hot = [s for s in stat_rows if s["hi_clip"] > 0.02]

    # ---- contact sheet
    sheet_path = None
    if not args.no_sheet:
        ch = int(SHEET_CELL * 0.67)
        rows = (len(items) + SHEET_COLS - 1) // SHEET_COLS
        sheet = Image.new("RGB", (SHEET_COLS * (SHEET_CELL + SHEET_PAD) + SHEET_PAD,
                                  rows * (ch + SHEET_PAD) + SHEET_PAD), (32, 32, 32))
        d = ImageDraw.Draw(sheet)
        for k, it in enumerate(items):
            x = SHEET_PAD + (k % SHEET_COLS) * (SHEET_CELL + SHEET_PAD)
            y = SHEET_PAD + (k // SHEET_COLS) * (ch + SHEET_PAD)
            if it["small"]:
                im = ImageOps.exif_transpose(Image.open(it["small"])).convert("RGB")
                im.thumbnail((SHEET_CELL, ch))
                sheet.paste(im, (x + (SHEET_CELL - im.width) // 2,
                                 y + (ch - im.height) // 2))
            d.text((x + 3, y + 3), str(it["idx"]), fill=(255, 235, 0))
        sheet_path = os.path.join(out, "contact_sheet.jpg")
        sheet.save(sheet_path, quality=90)

    # ---- manifest
    mpath = os.path.join(out, "manifest.json")
    manifest = {}
    if os.path.exists(mpath):
        try:
            manifest = json.load(open(mpath))
        except Exception:
            manifest = {}
    manifest.update(dict(
        batch_id="%s_%s" % (datetime.now().strftime("%Y-%m-%d"), batch),
        source_path=src,
        photo_count=len(items),
        camera=sorted({it["model"] for it in items if it["model"]}),
        updated=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    ))
    manifest.setdefault("stages", {})["checkup"] = dict(
        at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"), status="done",
        groups=report_groups,
        highlight_clipped=[s["name"] for s in hi_hot],
        sharpness_median=round(med, 1),
        sharpness_outliers=[dict(name=o["name"], sharp=round(o["sharp"], 1))
                            for o in outliers],
        contact_sheet=sheet_path,
        # 客户端面板要按文件名找到每张的小图：`<cache_dir>/<三位序号>_small.jpg`，
        # 序号就是 order 里的下标（1 起）。没有这份映射，面板只能显示整张 contact sheet。
        cache_dir=cache,
        order=[it["name"] for it in items],
        frames=dict((it["name"], dict(small=it["small"], big=it["big"],
                                      sharp=None if it["sharp"] is None else round(it["sharp"], 1),
                                      ev=None if it["ev"] is None else round(it["ev"], 2),
                                      time=it["time"].strftime("%H:%M:%S") if it["time"] else None))
                    for it in items),
    )
    manifest.setdefault("decisions", [])
    json.dump(manifest, open(mpath, "w"), ensure_ascii=False, indent=1)

    # ---- 报告
    print("\n" + "=" * 66)
    print("① 证据")
    print("=" * 66)
    print("批次 %s · %d 张 · 机身 %s" % (batch, len(items), "、".join(manifest["camera"])))
    print("连拍/近似重复组：%d 组" % len(report_groups))
    for r in report_groups:
        tag = r["kind"]
        if tag == "连拍" and not r["reliable"]:
            tag += "（锐度差距在噪声内，我的判断不可靠）"
        evs = "—" if r["ev_spread"] is None else "%.2f 档" % r["ev_spread"]
        print("\n  %-2d 张  %s → %s  跨 %.0f 秒  曝光跨度 %s  [%s]"
              % (r["count"], r["start"], r["end"], r["span_s"], evs, tag))
        for f in r["frames"]:
            mark = " ← 建议保留" if f["name"] == r["keep"] else ""
            print("       %s  %s  清晰度 %-9s EV %s%s"
                  % (f["time"], f["name"], f["sharp"], f["ev"], mark))
    n_bracket = sum(1 for r in report_groups if r["kind"] == "包围曝光")
    n_stack = sum(1 for r in report_groups if r["kind"] == "疑似堆栈")
    print("\n  包围曝光组 %d（一律全留）· 疑似堆栈组 %d（需单独确认）" % (n_bracket, n_stack))
    print("  高光溢出 >2%% 的照片：%d 张" % len(hi_hot))
    for s in hi_hot[:10]:
        print("       %s  溢出 %.1f%%  p95 %.3f" % (s["name"], s["hi_clip"] * 100, s["p95"]))
    print("       （这些数字来自 sips 解码的相机预览，**不是 Lightroom 的渲染**——"
          "体检发生在导入之前。绝对值会与 Lightroom 里有差异，")
    print("         用来看相对分布和找异常，不要当成调色后的最终数值。）")
    print("  跨场景锐度异常（仅供参考，不会自动移动）：%d 张" % len(outliers))
    for o in outliers[:8]:
        print("       %s  清晰度 %.1f（全批中位数 %.1f）" % (o["name"], o["sharp"], med))
    print("\n  contact sheet → %s" % sheet_path)
    print("  manifest      → %s" % mpath)

    print("\n" + "=" * 66)
    print("② 建议")
    print("=" * 66)
    suggest = sum(r["count"] - 1 for r in report_groups if r["kind"] == "连拍")
    print("  若每组连拍只保留建议的那一张，可剔 %d 张（%d → %d）"
          % (suggest, len(items), len(items) - suggest))
    print("  包围曝光 / 疑似堆栈一律不动。")
    print("  我**不会**按跨场景锐度异常自动剔除——那个指标被画面内容混淆。")
    print("\n③ 等你")
    print("  逐组确认或推翻后，我再跑 20_split.py 建 可导入/ 与 非导入/。")
    print("  （现在什么都没有改动。）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
