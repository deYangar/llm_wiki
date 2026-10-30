# -*- coding: utf-8 -*-
"""99 方案批次 3.1 · financing_type 题页补字段（2026-10-30，零 LLM）。

10-28 重导用的安装版底座不含 deriveFinancingType（2026-10-24 才进 repo），
题页 frontmatter financing_type 全库 0 页。本脚本对既有题页幂等补字段，
规则与 src/lib/qa-split.ts 逐字对齐（管线侧已同步加题干兜底，下次重导不再断）：

  L1 题页自身推导（两层）：
     a) 文件名关键词 —— deriveFinancingType 同款：
        IPO→首发；再融资：优先股/配股/可转债(定向|公开)/公司债/向不特定/向特定
     b) 题干「本次」锚定 —— deriveFinancingTypeFromBody 同款：
        每个「本次」锚点句内 40 字窗（句号/换行截断），取全局最早位置命中；
        排除「隆利科技 2020 年向不特定对象发行可转债」类他司/前次历史引用
  L2 案例回填：(company, deal, year) 组内 L1 值投票（众数），L1 为空的页回填；
     组内多值记 conflict（与 case 页聚合 financing_type_mixed 口径一致）

写入形态与管线一致：值插在 status: 行后（round_no 前）；无值不写键（null 不落盘）。
幂等：已有 financing_type 键的页跳过。

用法：
  python scripts/financing_type_backfill.py --questions-dir "C:/library/问询2025/wiki/questions"           # dry-run
  python scripts/financing_type_backfill.py --questions-dir "C:/library/问询2025/wiki/questions" --apply   # 写入

分批写盘（默认 500 页/批）+ 每批探活底座（2026-10-27 高负载静默退出前科），
探活失败即退出留态（已写页保留，重跑跳过）。
报告落 plans/2026-10-30-batch3-financing/reports/<实例名>-{dryrun|apply}.json
"""
import argparse
import json
import re
import sys
import time
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
REPORT_DIR = REPO_ROOT / "plans" / "2026-10-30-batch3-financing" / "reports"
HEALTH_URL = "http://127.0.0.1:19828/api/v1/health"

# ---- L1a 文件名规则（qa-split.ts deriveFinancingType 逐字移植）----------------


def derive_from_filename(deal, source_identity):
    if not deal:
        return None
    if deal == "IPO":
        return "首发"
    if deal != "再融资":
        return None
    fname = source_identity.rsplit("/", 1)[-1] if source_identity else ""
    if "优先股" in fname:
        return "再融资-优先股"
    if "配股" in fname:
        return "再融资-配股"
    if re.search(r"可转换公司债券|可转债", fname):
        return "再融资-定向可转债" if "向特定对象" in fname else "再融资-公开发行可转债"
    if "公司债" in fname:
        return "公开发行公司债"
    if "向不特定对象发行" in fname:
        return "再融资-向不特定对象发行"
    if "向特定对象发行" in fname:
        return "再融资-定增"
    return None


# ---- L1b 题干「本次」锚定（qa-split.ts deriveFinancingTypeFromBody 移植）-----
KEYWORDS = ["优先股", "配股", "可转换公司债券", "可转债", "公司债", "向不特定对象发行", "向特定对象发行"]
BUCKET_OF = {"优先股": "优先股", "配股": "配股", "可转换公司债券": "可转债", "可转债": "可转债",
             "公司债": "公司债", "向不特定对象发行": "向不特定", "向特定对象发行": "定增"}


def derive_from_body(deal, body):
    """页内品种频次取众（平频取最早位置）——与 qa-split.ts deriveFinancingTypeFromBody 对齐。
    上能实测：题干混入旧可转债文书原文的「本次向不特定对象发行可转换公司债券（2022年）」，
    最早位置规则被历史引用抢跑，频次取众吸收噪声。"""
    if deal != "再融资":
        return None
    hits = {}  # bucket -> [count, first_pos, window]
    for m in re.finditer("本次", body):
        rest = body[m.end():]
        stop = re.search(r"[。\n]", rest)
        window = rest[:stop.start()] if (stop and stop.start() <= 40) else rest[:40]
        for kw in KEYWORDS:
            p = window.find(kw)
            if p < 0:
                continue
            pos = m.end() + p
            h = hits.setdefault(BUCKET_OF[kw], [0, pos, window])
            h[0] += 1
            if pos < h[1]:
                h[1], h[2] = pos, window
    if not hits:
        return None
    bucket, (cnt, _pos, win) = sorted(hits.items(), key=lambda kv: (-kv[1][0], kv[1][1]))[0]
    if bucket == "优先股":
        return "再融资-优先股"
    if bucket == "配股":
        return "再融资-配股"
    if bucket == "可转债":
        return "再融资-定向可转债" if "向特定对象" in win else "再融资-公开发行可转债"
    if bucket == "公司债":
        return "公开发行公司债"
    if bucket == "向不特定":
        return "再融资-公开发行可转债" if re.search(r"可转换公司债券|可转债", win) else "再融资-向不特定对象发行"
    return "再融资-定向可转债" if re.search(r"可转换公司债券|可转债", win) else "再融资-定增"


# ---- 页面解析/写入 -----------------------------------------------------------


def parse_page(text):
    """返回 (deal, company, year, first_source, question_body, has_key)。"""
    m = re.match(r"^---\n(.*?)\n---\n(.*)$", text, re.S)
    if not m:
        return None
    fm, body = m.group(1), m.group(2)

    def key(k):
        mm = re.search(rf"^{k}: (.+)$", fm, re.M)
        return mm.group(1).strip().strip('"') if mm else ""

    src = ""
    sm = re.search(r'^sources:\n((?:  - .+\n)+)', fm, re.M)
    if sm:
        s2 = re.search(r'- "([^"]+)"', sm.group(1))
        if s2:
            src = s2.group(1)
    # 题干=「## 回复」前的正文（回复文本里的「本次」句式不算题干表述）
    qbody = body.split("## 回复", 1)[0]
    return key("deal"), key("company"), key("year"), src, qbody, bool(re.search(r"^financing_type: ", fm, re.M))


def insert_key(text, value):
    """status: 行后插 financing_type: <value>（管线键序）。"""
    out, done = re.subn(r"(?m)^(status: .+)$", rf"\1\nfinancing_type: {value}", text, count=1)
    if done == 0:  # 无 status 键的页退到 round_no 前 / frontmatter 尾
        out, done = re.subn(r"(?m)^(round_no: .+)$", rf"financing_type: {value}\n\1", text, count=1)
        if done == 0:
            out = text.replace("\n---\n", f"\nfinancing_type: {value}\n---\n", 1)
    return out


def alive():
    try:
        with urllib.request.urlopen(HEALTH_URL, timeout=5):
            return True
    except Exception:
        return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--questions-dir", required=True)
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--reconcile", action="store_true",
                    help="案例对账：同案例少数值页（含已写键）改为案例众数——一笔再融资申报只一种品种，"
                         "题干历史文书引用（旧可转债原文自带「本次」）产生的少数误判归一")
    ap.add_argument("--batch", type=int, default=500)
    args = ap.parse_args()
    qdir = Path(args.questions_dir)
    instance = qdir.parents[1].name  # <库根>/wiki/questions → 库名
    files = sorted(f for f in qdir.iterdir() if f.suffix == ".md")
    print(f"[{instance}] 题页 {len(files)} 页 | mode={'apply' if args.apply else 'dry-run'}", flush=True)

    pages = {}
    for i, f in enumerate(files):
        text = f.read_text(encoding="utf-8")
        parsed = parse_page(text)
        if parsed is None:
            pages[f.name] = None
            continue
        deal, comp, yr, src, qbody, has_key = parsed
        existing = ""
        if has_key:
            mm = re.search(r"^financing_type: (.+)$", text, re.M)
            existing = mm.group(1).strip().strip('"') if mm else ""
        v = None if has_key else derive_from_filename(deal, src)
        pages[f.name] = {"deal": deal, "company": comp, "year": yr, "v1": v, "has_key": has_key,
                         "existing": existing, "qbody": qbody}
        if (i + 1) % 2000 == 0:
            print(f"  解析 {i+1}/{len(files)}", flush=True)

    # L1b：文件名未命中的再融资页做题干兜底
    for name, p in pages.items():
        if p and not p["has_key"] and p["v1"] is None and p["deal"] == "再融资":
            p["v1"] = derive_from_body(p["deal"], p["qbody"])

    # L2：案例众数回填（投票池= L1 值 + 已有键值）
    case_votes = defaultdict(Counter)
    for name, p in pages.items():
        if p:
            if p["v1"]:
                case_votes[(p["company"], p["deal"], p["year"])][p["v1"]] += 1
            elif p["existing"]:
                case_votes[(p["company"], p["deal"], p["year"])][p["existing"]] += 1
    conflicts, stat, plan, fixes = [], Counter(), {}, {}
    for name, p in pages.items():
        if not p:
            stat["非题页/无frontmatter"] += 1
            continue
        ck = (p["company"], p["deal"], p["year"])
        if p["has_key"]:
            if args.reconcile and p["existing"] and len(case_votes.get(ck, {})) > 1:
                val, _ = case_votes[ck].most_common(1)[0]
                if val != p["existing"]:
                    fixes[name] = (p["existing"], val)
                    stat["reconcile更正"] += 1
                    conflicts.append({"page": name, "company": p["company"], "year": p["year"],
                                      "votes": dict(case_votes[ck]), "from": p["existing"], "to": val})
            else:
                stat["已有键跳过"] += 1
            continue
        if p["v1"]:
            if args.reconcile and len(case_votes.get(ck, {})) > 1:
                val, _ = case_votes[ck].most_common(1)[0]
                if val != p["v1"]:
                    conflicts.append({"page": name, "company": p["company"], "year": p["year"],
                                      "votes": dict(case_votes[ck]), "from": p["v1"], "to": val})
                    p["v1"] = val
            plan[name] = p["v1"]
            stat[f"L1:{p['v1']}"] += 1
            continue
        votes = case_votes.get(ck)
        if votes:
            val, cnt = votes.most_common(1)[0]
            plan[name] = val
            stat[f"L2案例回填:{val}"] += 1
        else:
            stat["无值(不写键)"] += 1

    covered = len(plan)
    refi = sum(1 for p in pages.values() if p and p["deal"] == "再融资")
    refi_hit = sum(1 for name in plan if "再融资" in plan[name] or plan[name] == "公开发行公司债")
    print(f"  归因: {dict(stat)}", flush=True)
    print(f"  本次写入计划: {covered} 页 | 本次再融资细分命中 {refi_hit}/{refi}", flush=True)

    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    report = {"instance": instance, "mode": "apply" if args.apply else "dry-run",
              "total_pages": len(files), "plan_writes": len(plan), "attribution": dict(stat),
              "refi_coverage": f"{refi_hit}/{refi}", "conflicts": conflicts[:200], "ts": time.strftime("%F %T")}
    (REPORT_DIR / f"{instance}-{'apply' if args.apply else 'dryrun'}.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")

    if not args.apply:
        print(f"  dry-run 报告: {REPORT_DIR}/{instance}-dryrun.json", flush=True)
        return

    written = fixed = 0
    names = sorted(plan)
    total = len(names) + len(fixes)
    for i, name in enumerate(names):
        f = qdir / name
        text = f.read_text(encoding="utf-8")
        if re.search(r"^financing_type: ", text, re.M):
            continue
        f.write_text(insert_key(text, plan[name]), encoding="utf-8", newline="")
        written += 1
        if written % args.batch == 0:
            if not alive():
                print(f"  ⛔ 底座探活失败（已写 {written}），退出留态", flush=True)
                sys.exit(2)
            print(f"  写入 {written}/{total} | 底座存活", flush=True)
    for name, (old, new) in sorted(fixes.items()):
        f = qdir / name
        text = f.read_text(encoding="utf-8")
        out, n = re.subn(r"(?m)^financing_type: .+$", f"financing_type: {new}", text, count=1)
        if n:
            f.write_text(out, encoding="utf-8", newline="")
            fixed += 1
    if (written + fixed) % args.batch != 0 and (written + fixed) > 0 and not alive():
        print("  ⚠️ 收尾批后底座探活失败（写入已完成）", flush=True)
    print(f"  ✅ 写入完成 新增{written}页 更正{fixed}页 | 报告: {REPORT_DIR}/{instance}-apply.json", flush=True)


if __name__ == "__main__":
    main()
