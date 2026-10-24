# -*- coding: utf-8 -*-
"""春晖附件（pdf/doc/docx）抓取+解析通道（R3 §九 补漏，2026-10-24）。

背景：scraper 只抓 htm 详情页，pdf 199 + doc 150 条附件此前只入清单不抓
正文。本通道补齐：下载附件 → antiword/python-docx/pymupdf 解析出正文行 →
落成与 htm 相同的 pages/<year>__<slug>.json，复用 chunhui_ingest.py 入库。

解析器：
- .doc（OLE2 复合文档，D0CF11E0 头）→ antiword（Git 自带 ucrt64）
- .docx → python-docx
- .pdf → pymupdf

用法：
  python chunhui_attachment_fetch.py            # 全量附件抓取+解析（断点续跑）
  python chunhui_attachment_fetch.py --limit 5  # 样本
限速 0.3s/请求；已解析条目跳过（断点续跑）。
"""
import io
import json
import os
import re
import subprocess
import sys
import time
import urllib.request

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

RAW_DIR = r"C:/library/.data/chunhui-20261024"
PAGES_DIR = os.path.join(RAW_DIR, "pages")
MANIFEST = os.path.join(RAW_DIR, "manifest.jsonl")
TMP = os.path.join(RAW_DIR, "attachment-tmp")
DELAY = 0.3
ANTIWORD = r"C:/Program Files/Git/ucrt64/bin/antiword.exe"

import pymupdf  # noqa: E402
import docx  # noqa: E402


def http_get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (research; llm-wiki R3)"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read()


def parse_doc(path: str) -> list[str]:
    out = subprocess.run([ANTIWORD, path], capture_output=True, timeout=120)
    text = out.stdout.decode("utf-8", errors="replace")
    return [re.sub(r"\s+", " ", l).strip() for l in text.split("\n") if l.strip()]


def parse_docx(path: str) -> list[str]:
    d = docx.Document(path)
    return [re.sub(r"\s+", " ", p.text).strip() for p in d.paragraphs if p.text.strip()]


def parse_pdf(path: str) -> list[str]:
    doc = pymupdf.open(path)
    lines = []
    for page in doc:
        for l in page.get_text().split("\n"):
            l = re.sub(r"\s+", " ", l).strip()
            if l:
                lines.append(l)
    doc.close()
    return lines


def fetch_attachment(entry: dict) -> dict:
    url = entry["url"]
    lower = url.lower()
    raw = http_get(url)
    os.makedirs(TMP, exist_ok=True)
    ext = "." + lower.rsplit(".", 1)[-1].split("%")[0].split("?")[0]
    tmp = os.path.join(TMP, "cur" + ext)
    with open(tmp, "wb") as f:
        f.write(raw)
    if lower.endswith(".doc"):
        body = parse_doc(tmp)
    elif lower.endswith(".docx"):
        body = parse_docx(tmp)
    elif lower.endswith(".pdf"):
        body = parse_pdf(tmp)
    else:
        raise ValueError(f"unsupported attachment: {ext}")
    # 标题以 manifest 列表页为准（与 htm 通道同口径）；文号从正文首行识别
    doc_number = ""
    DOC_NO = re.compile(
        r"^(?:发文文号[:：\s]*|文号[:：\s]*)?"
        r"[（〔\[]?(?:财会|证监|上证发|深证上|深证|北证|股转公告|股转|公告|财金|国资|国税|财税|会监|银保监|金规|工信部|人民银行|国家税务总局|财综|发改|上交所|深交所|北交所)"
        r"[〔\[]?\d{4}[〕\]]?第?\d+号?[）)\]]?"
    )
    if body and DOC_NO.match(body[0]):
        doc_number = body[0]
        body = body[1:]
    return {
        "title": entry["title"],
        "doc_number": doc_number,
        "body_lines": body,
        "url": url,
        "fetched": time.strftime("%Y-%m-%d %H:%M:%S"),
    }


def out_path(entry: dict) -> str:
    slug = (
        entry["url"].rsplit("fagui/", 1)[-1]
        .rsplit(".", 1)[0]
        .replace("/", "__")
    )
    return os.path.join(PAGES_DIR, f"{entry['year']}__{slug}.json")


def main():
    limit = None
    if "--limit" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--limit") + 1])
    manifest = [json.loads(l) for l in io.open(MANIFEST, encoding="utf-8")]
    todo = [
        e for e in manifest
        if e["status"] == "现行有效"
        and e.get("kind") in ("pdf", "doc")
        and not os.path.exists(out_path(e))
    ]
    if limit is not None:
        todo = todo[:limit]
    print(f"附件待抓 {len(todo)}（断点续跑，已有跳过）")
    done = fail = 0
    for i, e in enumerate(todo, 1):
        try:
            page = fetch_attachment(e)
            with io.open(out_path(e), "w", encoding="utf-8", newline="\n") as f:
                json.dump(page, f, ensure_ascii=False)
            done += 1
        except Exception as err:  # noqa: BLE001 — 逐条容错，失败如实记录后继续
            fail += 1
            print(f"FAIL {e['url']}: {err}")
        if i % 20 == 0 or i == len(todo):
            print(f"progress {i}/{len(todo)} done={done} fail={fail}")
        time.sleep(DELAY)
    print(f"done: fetched={done} fail={fail} -> {PAGES_DIR}")


if __name__ == "__main__":
    main()
