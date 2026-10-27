# -*- coding: utf-8 -*-
"""e4_issuer_map.py —— 模块 E-4：issuer「其他」批量回填映射表生成（2026-10-27）。

零 LLM、可解释可溯源：title 关键词规则（监管常识依据在案）+ docNumber 前缀
（复用 chunhui_ingest 的 ISSUER_BY_PREFIX）。**只出映射表不落库**——按方案
E-4 口径映射表先交咩咩过目，审后另跑 apply。

用法：
  python scripts/e4_issuer_map.py            # 扫库出映射表 reports/e4-issuer-map.tsv
"""
import io
import json
import os
import re
import sys

sys.stdout.reconfigure(encoding="utf-8")

REG = r"C:/library/准则库/wiki/regulation"
OUT = r"plans/2026-10-26-r3-decisions/reports/e4-issuer-map.tsv"

# title 关键词 → issuer（依据：发文机关的公开监管常识）
# 规则纪律：只收「题名本身明示发布方」或「该文件族的发布方唯一且知名」的形态；
# 拿不准的不进表（保持「其他」如实兜底——决议口径：回填不是硬编）。
TITLE_RULES = [
    (r"证券期货法律适用意见", "中国证监会", "题名明示「证券期货法律适用意见」族=证监会发布"),
    (r"上交所有关负责人|上海证券交易所|沪市|上海证券交易", "上海证券交易所", "题名明示上交所"),
    (r"深交所有关负责人|深圳证券交易所|深市|深圳证券交易", "深圳证券交易所", "题名明示深交所"),
    (r"北京证券交易所|北交所", "北京证券交易所", "题名明示北交所"),
    (r"全国中小企业股份转让|股转系统|新三板挂牌公司", "全国中小企业股份转让系统", "题名明示股转系统"),
    (r"中国证监会|证监会公告|证监会新闻发言人", "中国证监会", "题名明示证监会"),
    (r"资产评估准则", "财政部", "《资产评估准则》由财政部发布（资产评估法授权）"),
    (r"证监会回购", "中国证监会", "题名明示"),
]
# docNumber 前缀（照抄 chunhui_ingest.ISSUER_BY_PREFIX 的键值）
DOC_PREFIX = [
    ("财会", "财政部"), ("财金", "财政部"), ("财税", "财政部 国家税务总局"),
    ("财综", "财政部"), ("国税", "国家税务总局"), ("国家税务总局", "国家税务总局"),
    ("证监", "中国证监会"), ("会监", "中国证监会"), ("上证发", "上海证券交易所"),
    ("深证", "深圳证券交易所"), ("北证", "北京证券交易所"),
    ("股转", "全国中小企业股份转让系统"), ("银保监", "国家金融监督管理总局"),
    ("金规", "国家金融监督管理总局"), ("人民银行", "中国人民银行"),
    ("发改", "国家发展改革委"), ("国资", "国务院国资委"), ("工信部", "工业和信息化部"),
]


def main():
    rows = []
    for f in sorted(os.listdir(REG)):
        if not f.endswith(".md"):
            continue
        path = os.path.join(REG, f)
        head = io.open(path, encoding="utf-8").read(3000)
        if not re.search(r"^issuer:\s*其他\s*$", head, re.M):
            continue
        title = (re.search(r"^title:\s*(.+)$", head, re.M) or [None, ""])[1].strip().strip('"')
        doc = (re.search(r"^docNumber:\s*(.+)$", head, re.M) or [None, ""])[1].strip().strip('"')
        new, basis = "", ""
        for pat, issuer, why in TITLE_RULES:
            if re.search(pat, title):
                new, basis = issuer, f"title规则[{pat[:12]}]:{why}"
                break
        if not new and doc:
            for prefix, issuer in DOC_PREFIX:
                if doc.startswith(prefix):
                    new, basis = issuer, f"docNumber前缀[{prefix}]"
                    break
        rows.append((f, title, doc, new or "其他", basis or "推不出，保持其他（如实）"))

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with io.open(OUT, "w", encoding="utf-8", newline="") as fh:
        fh.write("file\ttitle\tdocNumber\tnew_issuer\t依据\n")
        for r in rows:
            fh.write("\t".join(r) + "\n")
    n_new = sum(1 for r in rows if r[3] != "其他")
    print(f"total=其他 {len(rows)} 页；可推导 {n_new}（{(n_new*100)//max(len(rows),1)}%）；保持其他 {len(rows)-n_new}")
    print(f"out: {OUT}（审后另跑 apply）")


if __name__ == "__main__":
    main()
