# -*- coding: utf-8 -*-
"""llm-wiki 便携版一键全量导入（qa-split 全库 1,746 份放量重放）。

用法（在便携包解压后的目录里）:
  python bin/run-full-import.py             # 全链路 dry-run（默认：只预览，不落盘不启动）
  python bin/run-full-import.py --apply     # 实跑：部署设置 → 注入全量任务 → 启动 → 等 health → 对账
  python bin/run-full-import.py status      # 查看队列/页面进度（应用运行中随时可跑）
  python bin/run-full-import.py restore     # 还原本机原有 app-state.json（撤掉便携版设置）

前置要求: Python 3.8+；目标机需已退出旧版 LLM Wiki（19828 端口）。

流程依据（2026-10-12 放量方案）:
  - 任务注入必须在应用未启动时做（应用内存态会覆盖手改的队列文件）；
  - 队列任务带相对路径，注入后应用启动即自动开跑；
  - 有 .cache/<pdf>.txt 的文档走 MinerU 缓存短路（秒级），无 .cache 的走云端 MinerU；
  - 项目 ID 固定 283b69c0-157e-47a8-b1e3-f476d0735a7c（随 app-state.json 带过来）。
"""
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent          # 便携包根（llm-wiki.exe 所在）
EXE = ROOT / "llm-wiki.exe"
DATA_APPSTATE = ROOT / "data" / "app-state.json"
WIKI = ROOT / "data" / "wiki"
ZHISHIKU = ROOT / "data" / "知识库"
QUEUE = WIKI / ".llm-wiki" / "ingest-queue.json"
RAW_BASE = WIKI / "raw" / "sources" / "scheduled-import" / "问答" / "2025"

APPSTATE_DST = Path(os.environ.get("APPDATA", "")) / "com.llmwiki.app" / "app-state.json"
BACKUP_DIR = ROOT / "bin" / "app-state-backups"

PROJECT_ID = "283b69c0-157e-47a8-b1e3-f476d0735a7c"
PORT = 19828
BASE_URL = f"http://127.0.0.1:{PORT}/api/v1"

OLD_WIKI = "C:/library/wiki"
OLD_ZK = "C:/library/知识库"


def die(msg):
    print(f"[ABORT] {msg}")
    sys.exit(1)


def posix(p: Path) -> str:
    return p.as_posix()


def preflight(hard=True):
    missing = [p for p in (EXE, DATA_APPSTATE, WIKI / "schema.md") if not p.exists()]
    if missing:
        die(f"便携包不完整，缺: {[str(m) for m in missing]}")
    # 旧版实例在跑？（dry-run 只警告，apply 硬阻断）
    try:
        with socket.create_connection(("127.0.0.1", PORT), timeout=1):
            msg = f"端口 {PORT} 已被占用——目标机上有 LLM Wiki（大概率旧安装版）正在运行，请先退出它。"
            die(msg) if hard else print(f"[警告] {msg}")
    except OSError:
        pass
    out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq llm-wiki.exe"],
                         capture_output=True, text=True,
                         encoding="gb18030", errors="replace").stdout
    if "llm-wiki.exe" in out:
        msg = "检测到 llm-wiki.exe 进程在运行（含旧版安装版与便携版自身），apply 前请先退出。"
        die(msg) if hard else print(f"[警告] {msg}")


def deep_replace(obj, pairs):
    """递归替换 JSON 里所有键名与字符串值中的旧路径。"""
    if isinstance(obj, dict):
        return {deep_replace(k, pairs) if isinstance(k, str) else k: deep_replace(v, pairs)
                for k, v in obj.items()}
    if isinstance(obj, list):
        return [deep_replace(v, pairs) for v in obj]
    if isinstance(obj, str):
        for a, b in pairs:
            obj = obj.replace(a, b)
        return obj
    return obj


def deploy_appstate(apply):
    pairs = [(OLD_WIKI, posix(WIKI)), (OLD_ZK, posix(ZHISHIKU))]
    tpl = json.loads(DATA_APPSTATE.read_text(encoding="utf-8-sig"))
    new = deep_replace(tpl, pairs)
    print(f"[1/4] 部署设置 → {APPSTATE_DST}")
    print(f"      路径改写: {OLD_WIKI} → {posix(WIKI)}")
    print(f"                {OLD_ZK} → {posix(ZHISHIKU)}")
    if APPSTATE_DST.exists():
        bak = BACKUP_DIR / f"app-state.pre-portable.{time.strftime('%Y%m%d-%H%M%S')}.json"
        print(f"      目标已存在，将备份 → {bak}")
    else:
        print("      目标不存在，直接写入")
    if not apply:
        print("      [dry-run] 未落盘")
        return
    APPSTATE_DST.parent.mkdir(parents=True, exist_ok=True)
    if APPSTATE_DST.exists():
        BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        bak = BACKUP_DIR / f"app-state.pre-portable.{time.strftime('%Y%m%d-%H%M%S')}.json"
        new_text = APPSTATE_DST.read_text(encoding="utf-8-sig")
        bak.write_text(new_text, encoding="utf-8")
    APPSTATE_DST.write_text(json.dumps(new, ensure_ascii=False, indent=2), encoding="utf-8")
    print("      完成")


def inject_tasks(apply):
    print(f"[2/4] 注入全量重放任务（应用未启动状态）")
    queue = json.loads(QUEUE.read_text(encoding="utf-8-sig")) if QUEUE.exists() else []
    failed = [t for t in queue if t.get("status") == "failed"]
    other = [t for t in queue if t.get("status") != "failed"]
    failed_paths = {t["sourcePath"] for t in failed}

    pdfs = [p for p in RAW_BASE.rglob("*.pdf") if ".cache" not in p.parts]
    with_cache, no_cache = [], 0
    for p in pdfs:
        if (p.parent / ".cache" / (p.name + ".txt")).exists():
            with_cache.append(p)
        else:
            no_cache += 1
    injectable = [p for p in with_cache if p.relative_to(WIKI).as_posix() not in failed_paths]

    ts = int(time.time() * 1000)
    new_tasks = [{
        "id": f"qa-full-{ts}-{i}",
        "projectId": PROJECT_ID,
        "sourcePath": p.relative_to(WIKI).as_posix(),
        "folderContext": "",
        "status": "pending",
        "addedAt": ts + i,
        "error": None,
        "retryCount": 0,
    } for i, p in enumerate(injectable)]
    revived = [{**t, "status": "pending", "retryCount": 0, "error": None} for t in failed]

    print(f"      PDF 总数 {len(pdfs)}（缓存短路 {len(with_cache)}，无缓存走云端 {no_cache}）")
    print(f"      新注入 pending {len(new_tasks)}；failed 复位 {len(revived)}；既有任务保留 {len(other)}")
    print(f"      注入后队列总长 {len(other) + len(revived) + len(new_tasks)}")
    if not apply:
        print("      [dry-run] 未落盘")
        return
    qbak_dir = WIKI / ".llm-wiki" / "queue-backups"
    qbak_dir.mkdir(parents=True, exist_ok=True)
    qbak = qbak_dir / f"ingest-queue.pre-full.{time.strftime('%Y%m%d-%H%M%S')}.json"
    qbak.write_text(json.dumps(queue, ensure_ascii=False, indent=2), encoding="utf-8")
    QUEUE.write_text(json.dumps(other + revived + new_tasks, ensure_ascii=False, indent=2),
                     encoding="utf-8")
    print(f"      完成；原队列备份 → {qbak}")


def launch_and_wait(apply):
    print("[3/4] 启动便携版 llm-wiki.exe")
    if not apply:
        print("      [dry-run] 未启动")
        return
    subprocess.Popen([str(EXE)], cwd=str(ROOT),
                     creationflags=0x00000008 | 0x00000200, close_fds=True)
    print("      已启动，等待 API health…")
    deadline = time.time() + 180
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"{BASE_URL}/health", timeout=3) as r:
                body = json.load(r)
            if body.get("status") == "running":
                print(f"      health = running（{time.strftime('%H:%M:%S')}）")
                return True
        except Exception:
            pass
        time.sleep(3)
    die("180s 内 health 未就绪。请手动启动 llm-wiki.exe 查看界面报错；常见原因：WebView2 缺失、库目录只读。")


def report_baseline():
    print("[4/4] 起跑对账（graph 基线）")
    for label, q in [("全库节点", f"{BASE_URL}/projects/{PROJECT_ID}/graph?limit=1&offset=1000000"),
                     ("question 页", f"{BASE_URL}/projects/{PROJECT_ID}/graph?nodeType=question&limit=1&offset=1000000"),
                     ("section 页", f"{BASE_URL}/projects/{PROJECT_ID}/graph?nodeType=section&limit=1&offset=1000000")]:
        try:
            with urllib.request.urlopen(q, timeout=60) as r:
                print(f"      {label}: {json.load(r).get('total')}")
        except Exception as e:
            print(f"      {label}: 查询失败 {e}")


def cmd_status():
    print(f"== 队列（{QUEUE}）==")
    if QUEUE.exists():
        q = json.loads(QUEUE.read_text(encoding="utf-8-sig"))
        c = Counter(t.get("status") for t in q)
        print(f"      任务 {len(q)} 个: " + ", ".join(f"{k}={v}" for k, v in c.most_common()))
    else:
        print("      队列文件不存在")
    prog = WIKI / ".llm-wiki" / "ingest-progress"
    if prog.exists():
        print(f"      ingest-progress 完成文档数: {len(list(prog.glob('*.json')))}")
    rep = WIKI / ".llm-wiki" / "qa-split-report.jsonl"
    if rep.exists():
        print(f"      qa-split 报告行数: {sum(1 for _ in rep.open(encoding='utf-8'))}")
    try:
        with urllib.request.urlopen(f"{BASE_URL}/health", timeout=3) as r:
            print(f"      API health: {json.load(r).get('status')}")
        for label, q in [("全库节点", f"{BASE_URL}/projects/{PROJECT_ID}/graph?limit=1&offset=1000000"),
                         ("question 页", f"{BASE_URL}/projects/{PROJECT_ID}/graph?nodeType=question&limit=1&offset=1000000"),
                         ("section 页", f"{BASE_URL}/projects/{PROJECT_ID}/graph?nodeType=section&limit=1&offset=1000000")]:
            with urllib.request.urlopen(q, timeout=60) as r:
                print(f"      {label}: {json.load(r).get('total')}")
    except Exception:
        print("      API 未运行（health 不可达）")


def cmd_restore():
    if not BACKUP_DIR.exists() or not list(BACKUP_DIR.glob("*.json")):
        die(f"没有可还原的备份（{BACKUP_DIR} 为空）")
    latest = sorted(BACKUP_DIR.glob("app-state.pre-portable.*.json"))[-1]
    APPSTATE_DST.parent.mkdir(parents=True, exist_ok=True)
    APPSTATE_DST.write_text(latest.read_text(encoding="utf-8-sig"), encoding="utf-8")
    print(f"已还原 {latest.name} → {APPSTATE_DST}")
    print("（若便携版正在运行请先退出，避免退出时把便携设置再写回去）")


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
    if "restore" in args:
        cmd_restore()
        return
    apply = "--apply" in args
    print(f"llm-wiki 便携版全量导入  mode={'APPLY(实跑)' if apply else 'DRY-RUN(预览)'}")
    print(f"便携包根: {ROOT}\n")
    preflight(hard=apply)
    deploy_appstate(apply)
    inject_tasks(apply)
    launch_and_wait(apply)
    if apply:
        report_baseline()
        print("\n全量导入已开始。进度查看: python bin/run-full-import.py status")
        print("跑完后整库在 data/wiki，拷回开发机替换 C:/library/wiki 前先打 tar 快照。")
    else:
        print("\n[dry-run] 以上为预览。确认无误后: python bin/run-full-import.py --apply")


if __name__ == "__main__":
    main()
