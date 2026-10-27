# -*- coding: utf-8 -*-
"""案例库全量重导：清空工具（模块05 §二.1，2026-10-27）。

停实例状态跑。动作：
  1. .llm-wiki 状态文件备份到 .llm-wiki/pre-reimport-backup-<ts>/
     （ingest-cache / ingest-queue / file-change-queue / file-snapshot /
       dedup-queue / lint / image-caption-cache + embedding-revisions/ + ingest-progress/）
  2. wiki/ 内容目录清空（cases/comparisons/concepts/entities/issues/queries/
     questions/sections/sources/synthesis/media + 「log.md append entry」残迹），
     保留骨架 index.md / log.md / overview.md
  3. .llm-wiki/lancedb 整目录删除（重导时自动重建）

不碰：chats/ conversations.json chat-preferences.json（用户数据）、
project.json（项目注册）、finish-backups/（历史备份）、知识库与准则库。

用法：
  python case_library_reset.py           # dry-run（只列动作清单）
  python case_library_reset.py --apply   # 实清
"""
import argparse
import shutil
import sys
import time
from pathlib import Path

WIKI = Path("C:/library/wiki")
LLMW = WIKI / ".llm-wiki"

STATE_FILES = [
    "ingest-cache.json", "ingest-queue.json", "file-change-queue.json",
    "file-snapshot.json", "dedup-queue.json", "lint.json", "image-caption-cache.json",
]
STATE_DIRS = ["embedding-revisions", "ingest-progress"]
CONTENT_DIRS = [
    "cases", "comparisons", "concepts", "entities", "issues",
    "queries", "questions", "sections", "sources", "synthesis", "media",
]
SKELETON = {"index.md", "log.md", "overview.md"}  # wiki/ 根保留
STRAY = WIKI / "wiki" / "log.md append entry"  # 模块06 挂账的异常残迹


def require_stopped():
    out = shutil.which("tasklist") and Path(shutil.which("tasklist"))
    import subprocess
    r = subprocess.run(["tasklist", "/FI", "IMAGENAME eq llm-wiki.exe"],
                       capture_output=True, text=True, encoding="gb18030", errors="replace").stdout
    if "llm-wiki.exe" in r:
        print("[ABORT] llm-wiki.exe 在跑——清库需停实例（写 lancedb 前置）")
        sys.exit(1)


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    require_stopped()

    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = LLMW / f"pre-reimport-backup-{stamp}"

    actions = []
    for f in STATE_FILES:
        if (LLMW / f).exists():
            actions.append(("备份+清空", LLMW / f))
    for d in STATE_DIRS:
        if (LLMW / d).exists():
            actions.append(("备份+清空", LLMW / d))
    for d in CONTENT_DIRS:
        p = WIKI / "wiki" / d
        n = sum(1 for _ in p.rglob("*")) if p.exists() else 0
        actions.append((f"清空({n}项)", p))
    if STRAY.exists():
        actions.append(("删除残迹", STRAY))
    actions.append(("删除整目录", LLMW / "lancedb"))

    print(f"[{'APPLY' if args.apply else 'DRY-RUN'}] 共 {len(actions)} 项：")
    for tag, p in actions:
        print(f"  {tag:14} {p}")

    if not args.apply:
        print("\n[dry-run] 未执行。确认后 --apply。")
        return

    backup.mkdir(parents=True, exist_ok=True)
    for f in STATE_FILES:
        src = LLMW / f
        if src.exists():
            shutil.move(str(src), str(backup / f))
    for d in STATE_DIRS:
        src = LLMW / d
        if src.exists():
            shutil.move(str(src), str(backup / d))
    # 清空后的状态文件给空基线（实例/入队器预期文件存在）
    (LLMW / "ingest-cache.json").write_text('{"entries": {}}', encoding="utf-8")
    (LLMW / "ingest-queue.json").write_text("[]", encoding="utf-8")
    for name in ("file-change-queue.json", "file-snapshot.json", "dedup-queue.json", "lint.json"):
        (LLMW / name).write_text("{}", encoding="utf-8")

    for d in CONTENT_DIRS:
        p = WIKI / "wiki" / d
        if p.exists():
            for child in p.iterdir():
                if child.is_dir():
                    shutil.rmtree(child)
                else:
                    child.unlink()
    if STRAY.exists():
        STRAY.unlink()
    lance = LLMW / "lancedb"
    if lance.exists():
        shutil.rmtree(lance)

    kept = sorted(SKELETON & {x.name for x in (WIKI / "wiki").iterdir()})
    print(f"\n[done] 状态备份 → {backup}")
    print(f"[done] wiki/ 骨架保留: {kept}")
    print("[done] lancedb 已删（重导自动重建）")


if __name__ == "__main__":
    main()
