# -*- coding: utf-8 -*-
"""案例库全量重导：源文件批量入队（模块05 §二.2，2026-10-27）。

扫 raw/sources/scheduled-import/问答/2025/ 全部 PDF → 注入 .llm-wiki/ingest-queue.json。
队列条目形态与 ingest 通道既有消费端一致（reembed_three_cases.py 同款字段）。

用法：
  python case_library_enqueue.py            # dry-run（数数+抽样）
  python case_library_enqueue.py --apply    # 实注入（备份旧队列后覆盖写）
  python case_library_enqueue.py --apply --limit 20   # 小批试点
"""
import argparse
import json
import shutil
import sys
import time
from pathlib import Path

WIKI = Path("C:/library/wiki")
RAW_ROOT = WIKI / "raw" / "sources"
SCAN_ROOT = "scheduled-import/问答/2025"
QUEUE = WIKI / ".llm-wiki" / "ingest-queue.json"
PROJECT_ID = "283b69c0-157e-47a8-b1e3-f476d0735a7c"
BACKUPS = WIKI / ".llm-wiki" / "finish-backups"


def load(p, default):
    return json.loads(p.read_text(encoding="utf-8-sig")) if p.exists() else default


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--limit", type=int, default=0, help="只入队前 N 份（试点）")
    args = ap.parse_args()

    pdfs = sorted((RAW_ROOT / SCAN_ROOT).rglob("*.pdf"))
    if args.limit:
        pdfs = pdfs[: args.limit]
    rels = [str(p.relative_to(RAW_ROOT)).replace("\\", "/") for p in pdfs]

    queue = load(QUEUE, [])
    print(f"[扫描] {SCAN_ROOT} 下 PDF {len(rels)} 份；现有队列 {len(queue)} 条")
    for r in rels[:3]:
        print(f"  样例 {r[-70:]}")

    tasks = [{
        "id": f"reimport-{int(time.time()*1000)}-{i}",
        "projectId": PROJECT_ID,
        "sourcePath": f"raw/sources/{rel}",
        "folderContext": "",
        "status": "pending",
        "addedAt": int(time.time() * 1000) + i,
        "error": None,
        "retryCount": 0,
    } for i, rel in enumerate(rels)]

    if not args.apply:
        print(f"[dry-run] 未落盘（将注入 {len(tasks)} 条）")
        return

    BACKUPS.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    if QUEUE.exists():
        shutil.copy2(QUEUE, BACKUPS / f"ingest-queue.pre-reimport.{stamp}.json")
    QUEUE.write_text(json.dumps(tasks, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"[done] 注入 {len(tasks)} 条 → {QUEUE}（旧队列备份 finish-backups/ingest-queue.pre-reimport.{stamp}.json）")
    print("[next] 起实例后自动消化；进度看 case_library_monitor.py")


if __name__ == "__main__":
    main()
