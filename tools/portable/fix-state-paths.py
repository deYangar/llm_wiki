# -*- coding: utf-8 -*-
"""部署 wiki 便携运行形态的 app-state.json 到本机 %APPDATA%。

每次启动前由整合包编排器调用（幂等）：从包内模板生成「项目路径指向本包
实际解压位置」的 app-state.json，写入 %APPDATA%\\com.llmwiki.app\\。

  python fix-state-paths.py           # 部署（默认）
  python fix-state-paths.py restore   # 还原目标机原有 app-state.json

备份纪律：目标机已有**非本包**的 app-state.json 时，先备份到包内 backups\\
（带时间戳，还原取最新）；已是本包部署版则直接覆盖，不产生堆积备份。

路径改写：模板里的 C:/library/wiki、C:/library/知识库（开发机原路径）递归
替换为本包实际路径——键名也替换（scheduledImportConfig:<path> 等键带路径），
逻辑与 tools/portable/archive-20261012/run-full-import.py 的 deep_replace 同源。
"""
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent          # wiki 包根（llm-wiki.exe 所在）
TPL = ROOT / "data" / "app-state.json"
WIKI = ROOT / "data" / "wiki"
ZK = ROOT / "data" / "知识库"
APPSTATE_DST = Path(os.environ.get("APPDATA", "")) / "com.llmwiki.app" / "app-state.json"
BACKUP_DIR = ROOT / "backups"

OLD_WIKI = "C:/library/wiki"
OLD_ZK = "C:/library/知识库"


def posix(p: Path) -> str:
    return p.as_posix()


def deep_replace(obj, pairs):
    """递归替换 JSON 里所有键名与字符串值中的旧路径（含 scheduledImportConfig:<path> 键）。"""
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


def is_ours(state_text: str) -> bool:
    """目标机现有 app-state 是否已是本包部署版（项目路径落在本包内）。"""
    try:
        d = json.loads(state_text)
    except Exception:
        return False
    paths = []
    for proj in (d.get("projectRegistry") or {}).values():
        paths.append(str(proj.get("path") or ""))
    return any(p.lower().startswith(posix(ROOT).lower()) for p in paths if p)


def cmd_deploy():
    if not TPL.exists():
        die(f"包不完整：缺少模板 {TPL}")
    pairs = [(OLD_WIKI, posix(WIKI)), (OLD_ZK, posix(ZK))]
    new = deep_replace(json.loads(TPL.read_text(encoding="utf-8-sig")), pairs)

    if APPSTATE_DST.exists():
        current = APPSTATE_DST.read_text(encoding="utf-8-sig")
        if is_ours(current):
            print(f"[deploy] 已是本包部署版，直接覆盖 → {APPSTATE_DST}")
        else:
            BACKUP_DIR.mkdir(parents=True, exist_ok=True)
            bak = BACKUP_DIR / f"app-state.pre-portable.{time.strftime('%Y%m%d-%H%M%S')}.json"
            bak.write_text(current, encoding="utf-8")
            print(f"[deploy] 目标机原有设置已备份 → {bak}")
    else:
        print(f"[deploy] 目标无既有设置，直接写入 → {APPSTATE_DST}")

    APPSTATE_DST.parent.mkdir(parents=True, exist_ok=True)
    APPSTATE_DST.write_text(json.dumps(new, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[deploy] 完成：{posix(WIKI)} / {posix(ZK)}")


def cmd_restore():
    if not BACKUP_DIR.exists():
        die(f"没有可还原的备份（{BACKUP_DIR} 不存在）")
    baks = sorted(BACKUP_DIR.glob("app-state.pre-portable.*.json"))
    if not baks:
        die(f"没有可还原的备份（{BACKUP_DIR} 为空）")
    APPSTATE_DST.parent.mkdir(parents=True, exist_ok=True)
    APPSTATE_DST.write_text(baks[-1].read_text(encoding="utf-8-sig"), encoding="utf-8")
    print(f"[restore] 已还原 {baks[-1].name} → {APPSTATE_DST}")
    print("[restore] 若便携版仍在运行请先退出，避免退出时把便携设置再写回去")


def die(msg):
    print(f"[ABORT] {msg}")
    sys.exit(1)


def main():
    if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except Exception:
            pass
    if len(sys.argv) > 1 and sys.argv[1] == "restore":
        cmd_restore()
    else:
        cmd_deploy()


if __name__ == "__main__":
    main()
