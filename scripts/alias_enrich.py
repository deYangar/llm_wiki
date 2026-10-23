# -*- coding: utf-8 -*-
"""case 页 aliases 灌入通道（R3 §十一，2026-10-24）。

机制：schema V R3 的 `aliases`（字符串列表）+ 检索域含页面全文——别名
写入 frontmatter 即可被关键词检索命中（含向量 chunk 亦然）。别名来源是
人工清单（错写/曾用名/简称词典——正则从正文抽取命中率 3/422 不可行，
2026-10-24 实测），清单文件按行维护：公司名<TAB>别名1,别名2。

用法：
  python alias_enrich.py --project C:/library/wiki --list aliases.tsv [--dry-run]

幂等：已有 aliases 键合并去重，不重复写入；无匹配 case 页如实报告。
"""
import argparse
import io
import os
import re
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")


def parse_list(path: str) -> list[tuple[str, list[str]]]:
    out = []
    for line in io.open(path, encoding="utf-8"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = [p.strip() for p in re.split(r"\t|,", line) if p.strip()]
        if len(parts) >= 2:
            out.append((parts[0], parts[1:]))
    return out


def yaml_list_item(v: str) -> str:
    if re.search(r'[:#\[\]{},"]', v) or v != v.strip():
        return '"' + v.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return v


def apply_aliases(content: str, aliases: list[str]) -> tuple[str, bool]:
    """把 aliases 并入 frontmatter 的 aliases 键（保留既有项，去重）。"""
    fm = re.match(r"^(---\s*\r?\n)([\s\S]*?)(\r?\n---\s*(?:\r?\n|$))", content)
    if not fm:
        return content, False
    payload = fm.group(2)
    existing: list[str] = []
    m = re.search(r"^aliases:\s*\[(.*)\]\s*$", payload, re.M)
    if m:
        existing = [
            v.strip().strip('"').strip("'")
            for v in m.group(1).split(",")
            if v.strip()
        ]
    block = re.search(r"^aliases:\n((?:\s*-\s*.+\n?)+)", payload, re.M)
    if block:
        existing += [
            l.strip().lstrip("-").strip().strip('"').strip("'")
            for l in block.group(1).splitlines()
            if l.strip()
        ]
    merged = []
    for v in existing + aliases:
        if v and v not in merged:
            merged.append(v)
    if merged == existing and existing:
        return content, False
    # 移除旧键（两种形态）后追加规范形态
    payload = re.sub(r"^aliases:\s*\[.*\]\s*$\n?", "", payload, flags=re.M)
    payload = re.sub(r"^aliases:\n(?:\s*-\s*.+\n?)+", "", payload, flags=re.M)
    inline = "aliases: [" + ", ".join(yaml_list_item(v) for v in merged) + "]"
    payload = payload.rstrip() + "\n" + inline
    return fm.group(1) + payload + fm.group(3) + content[fm.end():], True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", required=True)
    ap.add_argument("--list", required=True)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    entries = parse_list(args.list)
    cases_dir = os.path.join(args.project, "wiki", "cases")
    updated, unmatched = [], []
    for company, aliases in entries:
        matched = False
        for f in os.listdir(cases_dir):
            if not f.endswith(".md"):
                continue
            p = os.path.join(cases_dir, f)
            content = io.open(p, encoding="utf-8").read()
            head = content[:2000]
            # 匹配：文件名含公司短名或 frontmatter company 互含
            fm_company = re.search(r"^company:\s*(.+?)\s*$", head, re.M)
            fm_company = fm_company.group(1).strip().strip('"').strip("'") if fm_company else ""
            stem = f[:-3]
            if (
                company not in stem
                and (not fm_company or (company not in fm_company and fm_company not in company))
            ):
                continue
            matched = True
            next_content, changed = apply_aliases(content, aliases)
            if changed:
                if not args.dry_run:
                    io.open(p, "w", encoding="utf-8", newline="").write(next_content)
                updated.append((f, aliases))
            break
        if not matched:
            unmatched.append(company)
    print(f"updated={len(updated)} unmatched={len(unmatched)} dry_run={args.dry_run}")
    for f, aliases in updated:
        print(f"  {f} += {aliases}")
    for c in unmatched:
        print(f"  UNMATCHED: {c}")


if __name__ == "__main__":
    main()
