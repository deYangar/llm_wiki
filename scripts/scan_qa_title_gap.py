# -*- coding: utf-8 -*-
"""量化 .cache 缺标题行家族规模：全量扫 raw txt，比对 toc 项数 vs 正文题界行数。

判定口径（与 qa-split H3 通道同族）：
- toc 项：TOC 区「问题X......页码」行 + 「其他问题......页码」行
- 正文题界：非 TOC 区的行首「问题一/二/…/十」或「其他问题」独立标题行
- 正文题界数 < toc 项数 → 高危（H3 必缺，触发 H4 对账回退=上能形态）
"""
import re
import sys
from pathlib import Path

RAW = Path("C:/library/wiki/raw/sources/scheduled-import/问答/2025")
TOC_RE = re.compile(r"^(问题[一二三四五六七八九十]+|其他问题)[\s.·…]{3,}\d+\s*$")
HEAD_RE = re.compile(r"^(问题[一二三四五六七八九十]+|其他问题)\s*$")


def scan(txt: Path):
    lines = txt.read_text(encoding="utf-8", errors="replace").splitlines()
    toc, heads = [], []
    for i, ln in enumerate(lines):
        s = ln.strip()
        if TOC_RE.match(s):
            toc.append((i + 1, s.split(".")[0].split("…")[0].strip()))
        elif HEAD_RE.match(s):
            heads.append(i + 1)
    return toc, heads


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    txts = sorted(RAW.rglob("*.txt"))
    print(f"[scan] {len(txts)} txt")
    risky, notoc, ok = [], [], 0
    for t in txts:
        try:
            toc, heads = scan(t)
        except Exception as e:
            print(f"[err] {t.name[:50]} {e}")
            continue
        if not toc:
            notoc.append(t)
        elif len(heads) < len(toc):
            risky.append((t, len(toc), len(heads)))
        else:
            ok += 1
    print(f"\n[结果] 正常(题界≥toc): {ok} | 无toc形态: {len(notoc)} | 高危(题界<toc): {len(risky)}")
    print("\n== 高危清单（重导 H4 回退=上能形态风险）==")
    for t, n_toc, n_head in risky:
        print(f"  toc={n_toc} 题界={n_head}  {t.relative_to(RAW)}")
    print("\n== 无 toc 形态（走其他通道，不属本缺陷域）==")
    for t in notoc[:10]:
        print(f"  {t.relative_to(RAW)}")
    if len(notoc) > 10:
        print(f"  …共 {len(notoc)} 份")


if __name__ == "__main__":
    main()
