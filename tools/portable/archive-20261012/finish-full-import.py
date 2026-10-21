# -*- coding: utf-8 -*-
"""llm-wiki 便携版放量收尾（2026-10-14）。

全量重放跑完后收尾两类残留（对应主方案 §10.1 收尾清单 ①②）：
  A. 打包带来的 ingest-cache 短路条目（mode=qa-split 且早于打包时刻）——
     这些文档在 guaji 秒 done 未重拆，页面保持本地旧格式（样例实测
     question 27 / section 88 页）。清条目重注入 → 用已有 MinerU 级
     .cache 秒级重拆成放量版（54c39c9d）新格式页。
  B. pdfium 降级档（放量期间 warnings log 记录「built-in PDF text
     extraction」的文档，样例实测 5 份）——清条目重注入 → 三级降级链
     云端→本地 MinerU 重解析升级（MinerU 已重开，不应再降 pdfium）。

用法（在便携包根目录，与 run-full-import.py 同一套约定）:
  python bin/finish-full-import.py            # dry-run：盘点 + 预览
  python bin/finish-full-import.py --apply    # 实跑：备份→清条目→注入→启动
  python bin/finish-full-import.py status     # 收尾任务进度

前置（apply 硬校验）: llm-wiki.exe 未运行；全量队列已跑完（无 pending/processing/failed）。
任务注入必须在应用未启动时做（应用内存态会覆盖手改的队列文件）。
"""
import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXE = ROOT / "llm-wiki.exe"
WIKI = ROOT / "data" / "wiki"
QUEUE = WIKI / ".llm-wiki" / "ingest-queue.json"
CACHE = WIKI / ".llm-wiki" / "ingest-cache.json"
WARNINGS = WIKI / ".llm-wiki" / "ingest-warnings.log"
BACKUPS = WIKI / ".llm-wiki" / "finish-backups"

PROJECT_ID = "283b69c0-157e-47a8-b1e3-f476d0735a7c"
PORT = 19828

# 打包完成时刻（2026-10-12 20:05 本地 = 12:05Z，留 25 分钟裕量取 12:30Z）。
# 早于它的 qa-split 条目 = 打包带来的短路条目；晚于它的 warnings 降级行 = guaji 放量期降级。
PACK_TS_MS = 1791808200000          # 2026-10-12T12:30:00Z = 本地 20:30
PACK_ISO = "2026-10-12T12:30"
DEGRADE_MARK = "built-in PDF text extraction"


def die(msg):
    print(f"[ABORT] {msg}")
    sys.exit(1)


def load_json(p: Path, default):
    if not p.exists():
        return default
    return json.loads(p.read_text(encoding="utf-8-sig"))


def preflight(hard):
    if not EXE.exists():
        die("便携包不完整：llm-wiki.exe 不在脚本上级目录")
    out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq llm-wiki.exe"],
                         capture_output=True, text=True,
                         encoding="gb18030", errors="replace").stdout
    if "llm-wiki.exe" in out:
        msg = "llm-wiki.exe 正在运行——收尾注入必须在应用退出状态做，请先完全退出它。"
        die(msg) if hard else print(f"[警告] {msg}（dry-run 仅预览）")
    queue = load_json(QUEUE, [])
    unfinished = [t for t in queue if t.get("status") in ("pending", "processing", "failed")]
    if unfinished:
        detail = {s: sum(1 for t in unfinished if t.get("status") == s) for s in ("pending", "processing", "failed")}
        msg = f"全量重放还没跑完（{detail}）——收尾要等放量结束再做。"
        die(msg) if hard else print(f"[警告] {msg}")


def collect_targets():
    """返回 (A短路条目清单, B降级档清单)。"""
    cache = load_json(CACHE, {}).get("entries", {})
    tier_a = sorted(k for k, v in cache.items()
                    if v.get("mode") == "qa-split" and v.get("timestamp", 0) < PACK_TS_MS)
    tier_b = set()
    if WARNINGS.exists():
        current = None
        for line in WARNINGS.read_text(encoding="utf-8", errors="replace").splitlines():
            if line.startswith("## ") and " | " in line:
                ts, _, identity = line[3:].partition(" | ")
                current = (ts, identity.strip())
                continue
            if DEGRADE_MARK in line and current and current[0] > PACK_ISO:
                tier_b.add(current[1])
    return tier_a, sorted(tier_b)


def inject(targets, apply):
    cache = load_json(CACHE, {})
    entries = cache.get("entries", {})
    queue = load_json(QUEUE, [])
    ts = int(time.time() * 1000)
    new_tasks = [{
        "id": f"qa-finish-{ts}-{i}",
        "projectId": PROJECT_ID,
        "sourcePath": f"raw/sources/{identity}",
        "folderContext": "",
        "status": "pending",
        "addedAt": ts + i,
        "error": None,
        "retryCount": 0,
    } for i, identity in enumerate(targets)]
    print(f"[注入] 清 ingest-cache 条目 {len(targets)} 个 + 新 pending 任务 {len(new_tasks)} 个")
    for identity in targets:
        print(f"      - {identity}")
    if not apply:
        print("      [dry-run] 未落盘")
        return
    BACKUPS.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    (BACKUPS / f"ingest-cache.pre-finish.{stamp}.json").write_text(
        json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")
    for identity in targets:
        entries.pop(identity, None)
    CACHE.write_text(json.dumps({"entries": entries, **{k: v for k, v in cache.items() if k != "entries"}},
                                ensure_ascii=False, indent=2), encoding="utf-8")
    (BACKUPS / f"ingest-queue.pre-finish.{stamp}.json").write_text(
        json.dumps(queue, ensure_ascii=False, indent=2), encoding="utf-8")
    QUEUE.write_text(json.dumps(queue + new_tasks, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"      完成；备份 → {BACKUPS}\\*.{stamp}.json")


def launch_and_wait(apply):
    print("[启动] llm-wiki.exe")
    if not apply:
        print("      [dry-run] 未启动")
        return
    subprocess.Popen([str(EXE)], cwd=str(ROOT),
                     creationflags=0x00000008 | 0x00000200, close_fds=True)
    import socket, urllib.request
    print("      等待 API health…")
    deadline = time.time() + 180
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/v1/health", timeout=3) as r:
                if json.load(r).get("status") == "running":
                    print(f"      health = running（{time.strftime('%H:%M:%S')}），收尾任务开跑")
                    return
        except Exception:
            pass
        time.sleep(3)
    die("180s 内 health 未就绪，请手动启动 llm-wiki.exe 查看界面报错。")


def cmd_status():
    queue = load_json(QUEUE, [])
    finish = [t for t in queue if str(t.get("id", "")).startswith("qa-finish-")]
    if not finish:
        print("没有收尾任务（qa-finish-*）。全量是否已收尾？")
        return
    from collections import Counter
    print(f"收尾任务 {len(finish)} 个: " + ", ".join(f"{k}={v}" for k, v in Counter(t.get("status") for t in finish).most_common()))
    for t in finish:
        if t.get("status") != "done":
            print(f"      - {t.get('status')}: {t.get('sourcePath', '')[-70:]} :: {str(t.get('error'))[:60]}")
    print("全部 done 后：用「导出样例.bat」再导一次拷回开发机复验（verify_samples.py + final_verify_upgrade.py）")


def main():
    if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except Exception:
            pass
    args = sys.argv[1:]
    if "status" in args:
        cmd_status()
        return
    apply = "--apply" in args
    print(f"llm-wiki 便携版放量收尾  mode={'APPLY(实跑)' if apply else 'DRY-RUN(预览)'}")
    print(f"便携包根: {ROOT}\n")
    preflight(hard=apply)

    tier_a, tier_b = collect_targets()
    print(f"[盘点] A 打包短路条目（mode=qa-split 且早于打包时刻）: {len(tier_a)} 份 → 清缓存重拆（秒级/份）")
    for k in tier_a:
        print(f"      A {k[-78:]}")
    print(f"[盘点] B pdfium 降级档（打包后 warnings 记录）: {len(tier_b)} 份 → 清缓存重注入走 MinerU 升级")
    for k in tier_b:
        print(f"      B {k[-78:]}")

    targets = sorted(set(tier_a) | set(tier_b))
    if not targets:
        print("\n两类残留均为 0——无需收尾，放量已干净。")
        return
    print(f"\n合计收尾 {len(targets)} 份。")
    inject(targets, apply)
    launch_and_wait(apply)
    if apply:
        print("\n收尾任务已开跑。进度: python bin/finish-full-import.py status")
        print("全部 done 后再跑一次「导出样例.bat」拷回开发机复验，然后才是终局拷回。")


if __name__ == "__main__":
    main()
