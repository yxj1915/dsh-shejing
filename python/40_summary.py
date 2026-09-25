#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""摄鲸 · 批次总结（一页概览 + 决定清单）→ SUMMARY.md

只读 manifest.json，写 SUMMARY.md。不碰照片、不碰 Lightroom。

用法：
  40_summary.py <批次目录>
"""
import json
import os
import sys
from datetime import datetime

STAGE_LABEL = {
    "checkup": "体检", "cull": "剔除", "ingest": "整理（重命名+导入+分组）",
    "grade": "调色", "review": "验收", "archive": "归档", "retro": "复盘",
}


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    batch = os.path.abspath(sys.argv[1])
    mpath = os.path.join(batch, "manifest.json")
    if not os.path.exists(mpath):
        print("找不到 manifest：%s" % mpath)
        return 1
    m = json.load(open(mpath))
    st = m.get("stages", {})
    chk = st.get("checkup", {})
    cull = st.get("cull", {})
    arch = st.get("archive", {})

    L = []
    A = L.append
    A("# 摄鲸批次总结 · %s" % m.get("batch_id", os.path.basename(batch)))
    A("")
    A("- 源文件夹：`%s`" % m.get("source_path", "?"))
    A("- 机身：%s" % "、".join(m.get("camera", [])) or "?")
    A("- 照片数：%s" % m.get("photo_count", "?"))
    A("- 生成时间：%s" % datetime.now().strftime("%Y-%m-%d %H:%M"))
    A("")

    A("## 阶段进度")
    A("")
    A("| 阶段 | 状态 | 时间 |")
    A("|---|---|---|")
    for key, label in STAGE_LABEL.items():
        s = st.get(key)
        if s:
            A("| %s | %s | %s |" % (label, s.get("status", "?"), s.get("at", "")))
        else:
            A("| %s | 未做 | |" % label)
    A("")

    if cull:
        A("## 剔除结果")
        A("")
        A("- 保留 **%s** 张 → `%s`" % (cull.get("kept", "?"),
                                      os.path.basename(cull.get("keep_dir", ""))))
        A("- 移出 **%s** 张 → `%s`（永久保留，未删除）"
          % (cull.get("rejected", "?"), os.path.basename(cull.get("reject_dir", ""))))
        A("")

    groups = chk.get("groups", [])
    if groups:
        A("## 剔除依据（逐组）")
        A("")
        A("| 张数 | 范围 | 时间跨度 | 曝光跨度 | 类型 | 我的判断 |")
        A("|---|---|---|---|---|---|")
        for g in groups:
            rel = "可靠" if g.get("reliable") else "**不可靠，请复核**"
            A("| %d | %s → %s | %.0fs | %s | %s | %s |"
              % (g["count"], g["start"], g["end"], g.get("span_s", 0),
                 "-" if g.get("ev_spread") is None else "%.2f 档" % g["ev_spread"],
                 g.get("kind", "?"), rel))
        A("")

    hi = chk.get("highlight_clipped", [])
    if hi:
        A("## 高光溢出（>2%）")
        A("")
        A("共 %d 张：%s" % (len(hi), "、".join(hi[:12]) + ("…" if len(hi) > 12 else "")))
        A("")
        A("> 高光溢出只是**症状**。要判断病因是传感器削顶还是大气雾霾，"
          "看 RAW 能不能靠去朦胧恢复结构：能恢复的是雾霾（光学偏振才对症），"
          "恢复不了才是削顶（只能在拍摄时收曝光）。"
          "拍摄端对策见 `references/shooting-rules.md`。")
        A("")

    out = chk.get("sharpness_outliers", [])
    if out:
        A("## 跨场景锐度异常（仅供参考，未自动处理）")
        A("")
        A("全批中位数 %.1f，以下明显偏低：%s"
          % (chk.get("sharpness_median", 0),
             "、".join("%s(%.1f)" % (o["name"], o["sharp"]) for o in out[:10])))
        A("")
        A("> 该指标与画面内容混淆（低细节画面天然分数低），**不作为剔除依据**。")
        A("")

    if arch:
        A("## 导出")
        A("")
        A("- 目录：`%s`" % arch.get("export_dir", "?"))
        A("- 张数：%s（星级阈值 %s）" % (arch.get("export_count", "?"),
                                        arch.get("threshold", "?")))
        A("")

    dec = m.get("decisions", [])
    if dec:
        A("## 你做过的决定")
        A("")
        for d in dec:
            A("- %s" % d)
        A("")

    lessons = m.get("shooting_lessons", [])
    if lessons:
        A("## 本批得到的拍摄教训")
        A("")
        for x in lessons:
            A("- %s" % x)
        A("")

    A("---")
    A("")
    A("*由摄鲸生成。manifest.json 是机器账本，本文件是它的人读摘要。*")

    out_path = os.path.join(batch, "SUMMARY.md")
    open(out_path, "w").write("\n".join(L) + "\n")
    print("已写入 %s" % out_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
