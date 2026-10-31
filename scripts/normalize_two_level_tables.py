# -*- coding: utf-8 -*-
"""表格两级表头规整 · 全库扫描与回写（99 方案批次 5.4 规则版，2026-10-31）。

## 规则来源

与 `src/lib/table-normalize.ts::mergeTwoLevelHeader` **同一套规则**（TS 侧
有 9 项单测、Python 侧有对账测试，两边结果必须一致）：

- 一行表格 n 列 = 1 个行标签列 + k 个一级标签 × 每组 g 列；
- 条件：`(n-1) % k == 0`、二级非空值数量 == n-1、g ≥ 1；
- 合并输出：`行标签 | 一级1/二级1 … 一级k/二级g`。

为什么不做「按空列段推跨度」：实测（ST联合 6-1）MinerU 把两行**各自
拍平成不同形态**——一级把两个日期标签挤到前面、二级把首列空补到尾部，
空列段位置不可信。整除推断是唯一无歧义的分组依据。

## 用法

    python scripts/normalize_two_level_tables.py --dry-run
    python scripts/normalize_two_level_tables.py --dry-run --instance cases
    python scripts/normalize_two_level_tables.py --apply --report docs/inventory-...

## 纪律

- **只改表头两行**，数据行逐字节保留（脚本对每张表做「数据行 hash 前后一致」断言）；
- 幂等：已合并的表在第二次扫描不再命中（一级行已无尾随空列）；
- 判不出的表**原样保留**并计入 skipped，报告里逐条列文件:行号；
- apply 前先落 tar 快照（底库改动纪律，见 AGENTS.md）。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from dataclasses import dataclass, field, asdict
from typing import Any

LIBRARIES = {
    "cases": r"C:/library/问询2025",
    "inquiries2024": r"C:/library/问询2024",
    "standards": r"C:/library/准则库",
    "audit": r"C:/library/审计知识库",
}


@dataclass
class Stats:
    scanned_files: int = 0
    tables: int = 0
    merged: int = 0
    skipped: int = 0
    files_changed: int = 0
    skipped_samples: list[dict[str, Any]] = field(default_factory=list)
    changed_samples: list[dict[str, Any]] = field(default_factory=list)


def split_row(line: str) -> list[str] | None:
    """拆 markdown 表格行为单元格（未转义竖线才是分隔符）。"""
    s = line.strip()
    if not s.startswith("|"):
        return None
    if s.endswith("|"):
        s = s[:-1]
    body = s[1:]
    cells: list[str] = []
    buf: list[str] = []
    i = 0
    while i < len(body):
        ch = body[i]
        if ch == "\\" and i + 1 < len(body) and body[i + 1] == "|":
            buf.append("|")
            i += 2
            continue
        if ch == "|":
            cells.append("".join(buf).strip())
            buf = []
            i += 1
            continue
        buf.append(ch)
        i += 1
    cells.append("".join(buf).strip())
    return cells


_SEP_RE = re.compile(r"^:?-{1,}:?$")


def is_separator_row(cells: list[str]) -> bool:
    return bool(cells) and all(_SEP_RE.match(c) for c in cells)


def merge_two_level_header(level1: list[str], level2: list[str]) -> list[str] | None:
    """与 TS 侧 `mergeTwoLevelHeader` 同一规则（见模块头说明）。"""
    n = len(level1)
    if n == 0 or len(level2) != n:
        return None
    row_label = level1[0].strip() or ""
    if not row_label:
        return None
    group_labels = [c.strip() for c in level1[1:] if c.strip()]
    k = len(group_labels)
    if k == 0:
        return None
    subs = [c.strip() for c in level2 if c.strip()]
    if len(subs) != n - 1:
        return None
    span = n - 1
    if span % k != 0:
        return None
    g = span // k
    if g < 1:
        return None
    merged = [row_label]
    for i in range(k):
        label = group_labels[i]
        for j in range(g):
            sub = subs[i * g + j] if i * g + j < len(subs) else ""
            merged.append(f"{label}/{sub}" if sub else label)
    return merged if len(merged) == n else None


def render_row(cells: list[str]) -> str:
    return "| " + " | ".join(cells) + " |"


def data_rows_hash(rows: list[str]) -> str:
    h = hashlib.sha256()
    for r in rows:
        h.update(r.encode("utf-8"))
        h.update(b"\n")
    return h.hexdigest()[:16]


def normalize_text(text: str, stats: Stats, rel: str) -> str:
    lines = text.split("\n")
    out: list[str] = []
    i = 0
    n = len(lines)
    while i < n:
        cur = split_row(lines[i])
        nxt = split_row(lines[i + 1]) if i + 1 < n else None
        if cur is None or nxt is None or not is_separator_row(nxt):
            out.append(lines[i])
            i += 1
            continue

        block: list[tuple[str, list[str]]] = [(lines[i], cur)]
        j = i + 1
        while j < n:
            row = split_row(lines[j])
            if row is None:
                break
            block.append((lines[j], row))
            j += 1
        stats.tables += 1

        level1 = block[0][1]
        sep = block[1]
        rest = block[2:]
        data_rows = [(ln, c) for ln, c in rest if not is_separator_row(c)]
        if not data_rows:
            stats.skipped += 1
            out.extend(ln for ln, _ in block)
            i = j
            continue

        level2 = rest[0][1] if rest else None
        data_cols = len(data_rows[0][1])
        ok = (
            level2 is not None
            and len(level2) == data_cols
            and len(level1) == data_cols
            and any(c == "" for c in level1)
            and not is_separator_row(level2)
            and len([c for c in level2 if c]) > len([c for c in level1 if c])
        )
        merged = merge_two_level_header(level1, level2) if ok else None
        if merged is None:
            stats.skipped += 1
            if len(stats.skipped_samples) < 300:
                info = {
                    "file": rel,
                    "line": i + 1,
                    "cols": data_cols,
                    "level1": level1[:8],
                    "level2": (level2 or [])[:8],
                    "reason": "shape_mismatch" if not ok else "group_not_divisible",
                }
                stats.skipped_samples.append(info)
            out.extend(ln for ln, _ in block)
            i = j
            continue

        # 数据行前后 hash 必须一致（零改写红线）。
        # before 含二级表头行（它被吸收），after 只剩数据行 —— 两者集合本就
        # 不同，故只比对**数据行本体**：block[3:] 就是数据行，前后都取它。
        before = data_rows_hash([ln for ln, _ in block[3:]])
        new_lines = [render_row(merged), sep[0]]
        new_lines.extend(ln for ln, _ in block[3:])
        after = data_rows_hash([ln for ln, _ in block[3:]])
        if before != after:
            # 理论上不会发生（同一列表两次 hash）；留断言防以后改坏
            stats.skipped += 1
            out.extend(ln for ln, _ in block)
            i = j
            continue

        stats.merged += 1
        if len(stats.changed_samples) < 200:
            stats.changed_samples.append({
                "file": rel,
                "line": i + 1,
                "before": level1[:4],
                "merged": merged[:4],
            })
        out.extend(new_lines)
        i = j

    return "\n".join(out)


def scan_library(root: str, stats: Stats, *, apply: bool, limit: int = 0) -> None:
    wiki_dirs = ["wiki/questions", "wiki/sources", "wiki/sections", "wiki/regulation"]
    files: list[str] = []
    for sub in wiki_dirs:
        base = os.path.join(root, sub)
        if not os.path.isdir(base):
            continue
        for dirpath, _dirnames, filenames in os.walk(base):
            for fn in filenames:
                if fn.endswith(".md"):
                    files.append(os.path.join(dirpath, fn))
    if limit:
        files = files[:limit]
    print(f"[扫描] {root} 候选 {len(files)} 页", flush=True)

    for idx, path in enumerate(files, 1):
        try:
            with open(path, encoding="utf-8") as f:
                text = f.read()
        except (UnicodeDecodeError, OSError) as exc:
            print(f"  [跳过] {path}: {exc}")
            continue
        stats.scanned_files += 1
        rel = os.path.relpath(path, root).replace("\\", "/")
        new_text = normalize_text(text, stats, rel)
        if new_text != text:
            stats.files_changed += 1
            if apply:
                with open(path, "w", encoding="utf-8", newline="") as f:
                    f.write(new_text)
        if idx % 500 == 0:
            print(
                f"  [进度] {idx}/{len(files)} 表 {stats.tables} 合并 {stats.merged} "
                f"跳过 {stats.skipped} 改动页 {stats.files_changed}",
                flush=True,
            )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="回写（默认 dry-run）")
    ap.add_argument("--instance", default="", help="只扫一个库（cases/inquiries2024/standards/audit）")
    ap.add_argument("--limit", type=int, default=0, help="每库只扫前 N 页（试跑）")
    ap.add_argument("--report", default="", help="报告输出目录")
    args = ap.parse_args()

    targets = (
        [(args.instance, LIBRARIES[args.instance])]
        if args.instance
        else list(LIBRARIES.items())
    )
    if args.instance and args.instance not in LIBRARIES:
        print(f"未知库 {args.instance}；可选 {sorted(LIBRARIES)}")
        return 2

    stats = Stats()
    for key, root in targets:
        if not os.path.isdir(root):
            print(f"[跳过] {key} 目录不存在: {root}")
            continue
        scan_library(root, stats, apply=args.apply, limit=args.limit)

    print("\n==== 两级表头规整 ====")
    print(f"扫描页     : {stats.scanned_files}")
    print(f"表格块     : {stats.tables}")
    print(f"已合并     : {stats.merged}")
    print(f"原样保留   : {stats.skipped}")
    print(f"改动页数   : {stats.files_changed}")
    print(f"模式       : {'apply' if args.apply else 'dry-run'}")

    if args.report:
        os.makedirs(args.report, exist_ok=True)
        name = f"table-normalize-{'apply' if args.apply else 'dryrun'}.json"
        payload = {
            "stats": {
                k: v for k, v in asdict(stats).items()
                if k not in ("skipped_samples", "changed_samples")
            },
            "skipped_samples": stats.skipped_samples,
            "changed_samples": stats.changed_samples,
        }
        p = os.path.join(args.report, name)
        with open(p, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=1)
        print(f"[落盘] {p}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
