# -*- coding: utf-8 -*-
"""alias_candidates.py —— 别名词表候选抽取（模块 C Step 1，决议条 7）。

从 422 个 case 页（wiki/cases/*.md）抽「公司全称 ↔ 候选简称」对，产出
candidates-draft.tsv（company<TAB>candidate<TAB>evidence）供 AI 补全与人工审核。

抽取源（每页依次取，全记）：
  1. frontmatter company（全称，权威）
  2. 正文正则组：证券简称 / 曾用名 / 文件主题简称用法
  3. 文件名 stem（去 board/轮次装饰后的公司名）

用法：
  python scripts/alias_candidates.py --project C:/library/wiki \
      [--out plans/2026-10-24-alias/candidates-draft.tsv]
"""
import argparse
import json
import re
import sys
from pathlib import Path

RE_SHORT = re.compile(r"证券简称[：:]\s*([^\s，。；、]{2,10})")
RE_FORMER = re.compile(r"曾用名[：:]\s*([^\n，。；]{2,60})")
RE_TOPIC = re.compile(r"关于(\S{2,20})(?:首次公开发行|向不特定对象|向特定对象|发行股份|可转换)")
# 文件名 stem 装饰后缀：括号备注（深主板IPO·2025 等）
RE_STEM_DECO = re.compile(r"（[^）]*）$")


def parse_frontmatter(text: str) -> dict:
    fm = {}
    if not text.startswith("---"):
        return fm
    end = text.find("\n---", 3)
    if end < 0:
        return fm
    block = text[3:end]
    for line in block.splitlines():
        m = re.match(r"^([A-Za-z_][\w]*)\s*:\s*(.*)$", line.strip())
        if m:
            fm[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    return fm


def extract(path: Path):
    text = path.read_text(encoding="utf-8", errors="replace")
    fm = parse_frontmatter(text)
    company = fm.get("company", "")
    body = text[text.find("\n---", 3) + 4:] if text.startswith("---") else text
    found = []  # (candidate, evidence)

    for m in RE_SHORT.finditer(body):
        val = m.group(1).strip()
        if val and val not in ("无", "不适用", "-"):
            found.append((val, "证券简称正则"))
    for m in RE_FORMER.finditer(body):
        raw = m.group(1).strip().rstrip("。；，")
        for part in re.split(r"[，,、/]", raw):
            part = part.strip()
            if 2 <= len(part) <= 20 and part not in ("无", "不适用", "-"):
                found.append((part, "曾用名正则"))
    for m in RE_TOPIC.finditer(body[:20000]):
        val = m.group(1).strip()
        if len(val) >= 2:
            found.append((val, "文件主题简称用法"))
    stem = RE_STEM_DECO.sub("", path.stem)
    # 无 company 键的页：stem 去装饰后的名字当公司名（保持页面可匹配）
    company = company or stem
    # 过滤全称变体垃圾：「XX公司申请」等 = 主题正则吃到全称，非真简称
    def is_full_name_variant(cand: str) -> bool:
        c = re.sub(r"(申请|发行|的|之)$", "", cand)
        if not company:
            return False
        return c == company or (len(c) >= 6 and company.startswith(c)) or (len(company) >= 6 and c.startswith(company))
    found = [(c, e) for c, e in found if not is_full_name_variant(c)]
    found.append((stem, "文件名stem"))
    return company, found


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", default="C:/library/wiki")
    ap.add_argument("--out", default="plans/2026-10-24-alias/candidates-draft.tsv")
    args = ap.parse_args()

    cases_dir = Path(args.project) / "wiki" / "cases"
    pages = sorted(cases_dir.glob("*.md"))
    print(f"[scan] {len(pages)} case 页")

    rows = {}  # company -> {candidate: [evidence...]}
    no_company = []
    for p in pages:
        company, found = extract(p)
        if not company:
            no_company.append(p.name)
            continue
        bucket = rows.setdefault(company, {})
        for cand, ev in found:
            ev_full = f"{ev}|{p.name}"
            bucket.setdefault(cand, []).append(ev_full)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8", newline="") as f:
        for company in sorted(rows):
            for cand, evs in sorted(rows[company].items(), key=lambda kv: -len(kv[1])):
                ev_join = "; ".join(evs[:3]) + (f" (+{len(evs)-3})" if len(evs) > 3 else "")
                f.write(f"{company}\t{cand}\t{ev_join}\n")
    print(f"[out] {out} 行数={sum(len(v) for v in rows.values())} 公司数={len(rows)}")
    if no_company:
        print(f"[warn] {len(no_company)} 页无 company 键：{no_company[:5]}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
