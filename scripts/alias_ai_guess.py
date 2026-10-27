# -*- coding: utf-8 -*-
"""alias_ai_guess.py —— 模块 C Step 2：AI 候选补全（程序化行业惯例缩写）。

对 candidates-draft.tsv 的每家公司按 A 股证券简称惯例生成「最可能简称」，
与已有候选不同的追加 source=ai_guess 行（evidence 列标注推导依据）。
AI 只出候选不出定论：错写/曾用名由咩咩在审核时补。

用法：
  python scripts/alias_ai_guess.py --draft plans/2026-10-24-alias/candidates-draft.tsv
"""
import argparse
import re
import sys
from pathlib import Path

GEO_PREFIX = ("中国", "北京", "上海", "深圳", "广州", "江苏", "浙江", "山东", "安徽",
              "福建", "广东", "四川", "湖北", "湖南", "河南", "河北", "江西", "天津",
              "重庆", "陕西", "山西", "辽宁", "吉林", "黑龙江", "云南", "贵州", "广西",
              "海南", "甘肃", "青海", "宁夏", "新疆", "内蒙古", "西藏", "苏州", "南京",
              "杭州", "武汉", "成都", "西安", "合肥", "宁波", "无锡", "厦门", "青岛",
              "大连", "宁波", "佛山", "东莞", "常州", "绍兴", "嘉兴", "珠海", "中山")
SUFFIX_CORP = ("集团股份有限公司", "股份有限公司", "有限责任公司", "有限公司",
               "控股集团有限公司", "集团有限公司")
CAT_WORDS = ("科技", "技术", "电子", "信息", "软件", "数据", "智能", "半导体", "芯片",
             "生物", "医药", "医疗", "健康", "新材", "材料", "新能源", "环保", "能源",
             "电力", "装备", "机械", "精密", "自动化", "汽车", "零部件", "化工", "化学",
             "通信", "网络", "证券", "银行", "资本", "传媒", "文化", "教育", "股份")


def guess_short(company: str) -> tuple[str, str] | None:
    """返回 (候选简称, 推导依据) 或 None（推不出可靠简称）。"""
    name = company
    notes = []
    for suf in sorted(SUFFIX_CORP, key=len, reverse=True):
        if name.endswith(suf):
            name = name[: -len(suf)]
            notes.append(f"剥后缀「{suf}」")
            break
    geo = ""
    for g in GEO_PREFIX:
        if name.startswith(g) and len(name) - len(g) >= 3:
            geo = g
            name = name[len(g):]
            # 三字市名「佛山市」剥两字后残留「市」开头——补剥
            if name.startswith("市") and len(name) >= 4:
                name = name[1:]
                geo += "市"
            notes.append(f"剥地域前缀「{geo}」")
            break
    # 已是短核心词（≤4 字）直接可用
    if 2 <= len(name) <= 4:
        return name, "；".join(notes) or "全称核心词"
    # 5-6 字核心词：带类别词的取「前2字+类别词」惯例
    for cat in CAT_WORDS:
        if name.endswith(cat) and len(name) > len(cat):
            head = name[: len(name) - len(cat)]
            if 2 <= len(head) <= 3:
                cand = head + cat if len(head + cat) <= 5 else head + cat[:2]
                return cand, f"核心词「{head}」+类别词「{cat}」（{name}）"
    if 5 <= len(name) <= 6:
        return name[:4], f"长核心词「{name}」取前4字"
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--draft", default="plans/2026-10-24-alias/candidates-draft.tsv")
    args = ap.parse_args()
    p = Path(args.draft)
    lines = p.read_text(encoding="utf-8").splitlines()

    by_company: dict[str, set[str]] = {}
    parsed = []
    for ln in lines:
        parts = ln.split("\t")
        if len(parts) >= 2:
            parsed.append(parts)
            by_company.setdefault(parts[0], set()).add(parts[1])

    added = 0
    out = list(parsed)
    for company, cands in by_company.items():
        g = guess_short(company)
        if not g:
            continue
        cand, why = g
        if cand in cands or cand == company:
            continue
        out.append([company, cand, f"ai_guess|{why}"])
        added += 1

    with p.open("w", encoding="utf-8", newline="") as f:
        for parts in sorted(out):
            f.write("\t".join(parts) + "\n")
    print(f"[ai_guess] 追加 {added} 行（与既有候选不同才加）→ {p}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
