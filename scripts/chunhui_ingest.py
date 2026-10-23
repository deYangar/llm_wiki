# -*- coding: utf-8 -*-
"""春晖抓取产物 → regulation 页入库管道（R3 §九，2026-10-24）。

输入：chunhui_scraper.py 产物（manifest.jsonl + pages/*.json）
输出：wiki/regulation/<标题>.md（frontmatter 按 schema R3 扩展字段：
      category/source/source_url/issuer/publish_date/status + 库内既有
      docNumber/promulgator 惯例键）

用法：
  python chunhui_ingest.py build [--limit N] [--out DIR]   # 生成 md（默认全量到 out 目录）
  python chunhui_ingest.py dedup-check [--wiki DIR]        # 与现有库 title 对账

放量纪律（咩咩 10-12 铁律）：先 --limit 10 出样本 → 应用侧/frontmatter
解析验证通过 → 等放量指令再进真库。默认 out 是样本目录，真库入库必须
显式 --out 指向 <project>/wiki。
"""
import argparse
import io
import json
import os
import re
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

RAW_DIR = r"C:/library/.data/chunhui-20261024"
DEFAULT_OUT = os.path.join(RAW_DIR, "sample-regulation")

# 文号前缀 → 发布机构（ issuer/promulgator 零 LLM 推导）
ISSUER_BY_PREFIX = [
    ("财会", "财政部"), ("财金", "财政部"), ("财税", "财政部 国家税务总局"),
    ("财综", "财政部"), ("国税", "国家税务总局"), ("国家税务总局", "国家税务总局"),
    ("证监", "中国证监会"), ("会监", "中国证监会"),
    ("上证发", "上海证券交易所"), ("深证", "深圳证券交易所"), ("北证", "北京证券交易所"),
    ("股转", "全国中小企业股份转让系统"),
    ("银保监", "国家金融监督管理总局"), ("金规", "国家金融监督管理总局"),
    ("人民银行", "中国人民银行"), ("发改", "国家发展改革委"), ("国资", "国务院国资委"),
    ("工信部", "工业和信息化部"),
]
REG_NATURE = {
    "财政部": "部门规章", "财政部 国家税务总局": "部门规章",
    "国家税务总局": "部门规章", "中国证监会": "部门规章",
    "国家金融监督管理总局": "部门规章", "中国人民银行": "部门规章",
    "国家发展改革委": "部门规章", "国务院国资委": "部门规章",
    "工业和信息化部": "部门规章",
    "上海证券交易所": "交易所业务规则", "深圳证券交易所": "交易所业务规则",
    "北京证券交易所": "交易所业务规则", "全国中小企业股份转让系统": "交易所业务规则",
}


def yaml_scalar(value: str) -> str:
    value = value.strip()
    if not value or re.search(r"[:#\[\]{},\"']", value):
        return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return value


def derive_issuer(doc_number: str, body_lines: list[str]) -> str:
    for prefix, issuer in ISSUER_BY_PREFIX:
        if doc_number.startswith(prefix):
            return issuer
    # 正文落款（机构名独立行，常见于通知类）——取前 30 行里最后一个机构名行
    known = {issuer for _, issuer in ISSUER_BY_PREFIX} | {
        "最高人民法院", "最高人民检察院", "国务院", "中国证券登记结算有限责任公司",
    }
    for line in body_lines[:30]:
        line_s = line.replace(" ", "")
        if line_s in {k.replace(" ", "") for k in known}:
            return line_s
    return "其他"


def derive_publish_date(doc_number: str, body_lines: list[str]) -> str:
    # 文号年份兜底 + 正文「YYYY年M月D日」行（落款日期）
    for line in body_lines[:40]:
        m = re.search(r"(20\d{2})年(\d{1,2})月(\d{1,2})日", line)
        if m:
            return f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
    m = re.search(r"[〔\[]?(20\d{2})[〕\]]?", doc_number)
    return f"{m.group(1)}" if m else ""


def build_page(manifest_entry: dict, page: dict) -> str:
    issuer = derive_issuer(page.get("doc_number", ""), page.get("body_lines", []))
    publish_date = derive_publish_date(page.get("doc_number", ""), page.get("body_lines", []))
    reg_nature = REG_NATURE.get(issuer, "部门规章")
    fm = [
        "type: regulation",
        f"title: {yaml_scalar(page['title'])}",
        "tags:",
        f'  - "reg-nature:{reg_nature}"',
        f'  - "problem-type:法规原文"',
        f"category: {manifest_entry['category']}",
        "source: chunhui",
        f"source_url: {yaml_scalar(page['url'])}",
        f"issuer: {yaml_scalar(issuer)}",
        f"promulgator: {yaml_scalar(issuer)}",
        f"status: {manifest_entry['status']}",
    ]
    if page.get("doc_number"):
        fm.append(f"docNumber: {yaml_scalar(page['doc_number'])}")
    if publish_date:
        fm.append(f"publish_date: {publish_date}")
    fm += ["related: []", "sources: []"]
    body = [f"# {page['title']}"]
    if page.get("doc_number"):
        body.append("")
        body.append(page["doc_number"])
    body.append("")
    body.extend(page.get("body_lines", []))
    return "---\n" + "\n".join(fm) + "\n---\n\n" + "\n".join(body).rstrip() + "\n"


def safe_filename(title: str) -> str:
    name = re.sub(r'[\\/:*?"<>|]', "―", title).strip()
    return name[:80] or "untitled"


def cmd_build(limit, out):
    manifest = [json.loads(l) for l in io.open(os.path.join(RAW_DIR, "manifest.jsonl"), encoding="utf-8")]
    by_url = {e["url"]: e for e in manifest}
    pages_dir = os.path.join(RAW_DIR, "pages")
    os.makedirs(out, exist_ok=True)
    written = []
    dup_in_batch = 0
    seen_titles = set()
    for fname in sorted(os.listdir(pages_dir)):
        if limit is not None and len(written) >= limit:
            break
        if not fname.endswith(".json"):
            continue
        page = json.load(io.open(os.path.join(pages_dir, fname), encoding="utf-8"))
        entry = by_url.get(page["url"])
        if not entry or entry["status"] != "现行有效":
            continue
        title = page["title"]
        if title in seen_titles:
            dup_in_batch += 1
            continue
        seen_titles.add(title)
        md = build_page(entry, page)
        dest = os.path.join(out, safe_filename(title) + ".md")
        io.open(dest, "w", encoding="utf-8", newline="\n").write(md)
        written.append(dest)
    print(f"built {len(written)} pages (batch-internal dup skipped: {dup_in_batch}) -> {out}")


def cmd_dedup_check(wiki_dir):
    manifest = [json.loads(l) for l in io.open(os.path.join(RAW_DIR, "manifest.jsonl"), encoding="utf-8")]
    existing = {}
    reg_dir = os.path.join(wiki_dir, "regulation")
    for f in os.listdir(reg_dir) if os.path.isdir(reg_dir) else []:
        if not f.endswith(".md"):
            continue
        head = io.open(os.path.join(reg_dir, f), encoding="utf-8").read(4000)
        m = re.search(r"^title:\s*(.+)$", head, re.M)
        if m:
            title = m.group(1).strip().strip('"')
            existing[title] = f
    valid = [e for e in manifest if e["status"] == "现行有效"]
    overlap = [e for e in valid if e["title"] in existing]
    print(f"chunhui valid={len(valid)} existing regulation pages={len(existing)} overlap={len(overlap)}")
    for e in overlap[:10]:
        print("  overlap:", e["title"][:50])


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["build", "dedup-check"])
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--wiki", default=r"C:/library/知识库/wiki")
    args = ap.parse_args()
    if args.cmd == "build":
        cmd_build(args.limit, args.out)
    else:
        cmd_dedup_check(args.wiki)
