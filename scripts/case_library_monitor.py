# -*- coding: utf-8 -*-
"""案例库重导进度监控（模块05 施工纪律：每轮先打印进度再睡）。

每 60s 打一行：队列长度（按 status 分组）+ wiki/questions 页数 + warnings 尾行。
队列清空（或全部终态）即退出。

用法：
  python case_library_monitor.py [--interval 60]
"""
import argparse
import json
import sys
import time
import urllib.request
from collections import Counter
from pathlib import Path

WIKI = Path("C:/library/wiki")
QUEUE = WIKI / ".llm-wiki" / "ingest-queue.json"
WARN = WIKI / ".llm-wiki" / "ingest-warnings.log"
HEALTH = "http://127.0.0.1:19828/api/v1/health"


def alive() -> bool:
    try:
        with urllib.request.urlopen(HEALTH, timeout=5) as r:
            return r.status == 200
    except Exception:
        return False


def snapshot():
    try:
        q = json.loads(QUEUE.read_text(encoding="utf-8-sig")) if QUEUE.exists() else []
    except Exception as e:
        return {"queue_err": str(e)}
    c = Counter(t.get("status", "?") for t in q)
    qdir = WIKI / "wiki" / "questions"
    cdir = WIKI / "wiki" / "cases"
    return {
        "pending": c.get("pending", 0),
        "processing": c.get("processing", 0),
        "done": c.get("done", 0),
        "other": sum(v for k, v in c.items() if k not in ("pending", "processing", "done")),
        "total": len(q),
        "questions": len(list(qdir.glob("*.md"))) if qdir.exists() else 0,
        "cases": len(list(cdir.glob("*.md"))) if cdir.exists() else 0,
    }


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--interval", type=int, default=60)
    args = ap.parse_args()

    t0 = time.time()
    s0 = snapshot()
    initial = s0.get("total", 0)
    while True:
        s = snapshot()
        if "queue_err" in s:
            print(f"[{time.strftime('%H:%M:%S')}] queue_err={s['queue_err']}")
        else:
            finished = max(initial - s["total"], 0)
            rate = finished / max((time.time() - t0) / 60, 0.1) if finished else 0.0
            eta = (s["pending"] + s["processing"]) / rate if rate > 0 else -1
            ok = alive()
            print(f"[{time.strftime('%H:%M:%S')}] 待{s['pending']} 处理中{s['processing']} "
                  f"完{finished} 其他{s['other']} / 总{initial} | questions={s['questions']} "
                  f"cases={s['cases']} | 速率{rate:.1f}/min ETA{'∞' if eta < 0 else f'{eta:.0f}min'}"
                  f" | health={'OK' if ok else '!!实例死亡需重启!!'}",
                  flush=True)
            if not ok:
                print(f"[{time.strftime('%H:%M:%S')}] ⚠️ 底座 19828 无响应（静默退出前科）——"
                      f"需 Start-Process 安装版 exe 重启，队列文件在实例重启后自动续跑", flush=True)
            if s["total"] > 0 and s["pending"] + s["processing"] == 0:
                print(f"[{time.strftime('%H:%M:%S')}] 队列全部终态，监控退出")
                if WARN.exists():
                    tail = WARN.read_text(encoding="utf-8", errors="replace").strip().splitlines()[-3:]
                    for line in tail:
                        print(f"  warn| {line[:160]}")
                return
            if s["total"] == 0:
                print(f"[{time.strftime('%H:%M:%S')}] 队列为空（尚未注入或已消化），退出")
                return
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
