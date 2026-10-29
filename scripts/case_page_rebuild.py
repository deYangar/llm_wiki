# -*- coding: utf-8 -*-
"""A3 · 案例库 case 页补建收尾批（重导后置）—— plans/2026-10-29-a3-case-page-rebuild/方案.md 照抄施工。

为 qa-split 重导后的 question 题页按 (company, deal, year) 聚合补建 case 页：
  python scripts/case_page_rebuild.py                    # dry-run：只读，出报告
  python scripts/case_page_rebuild.py --apply            # 写库（写入前先跑全部前置断言）
  python scripts/case_page_rebuild.py --verify           # 不写库：§8 全量匹配 + 幂等 diff
同脚本复用于 2024 实例（§13）：
  python scripts/case_page_rebuild.py --project 7752fa57-5e21-4ec7-bc00-a820ce0b3f7f \
         --cases-dir "C:/library/问询2024/wiki/cases"

不变量（违反=立即退出非零，不写任何文件）：
  I1 同 (company, deal, year) 全库只允许一个 case 页文件；
  I2 status 与一切非键属性只进 frontmatter，绝不进文件名；
  I3 白名单外 deal/board/exchange/status → 停手报告，不猜测映射。

实测适配（2026-10-29 全量摸底，方案未建模的真实形态）：
  ① 8878 题页中 100 页无 round_no（96 落实函 + 4 注册反馈，round_kind/question_no 齐全，
  question_no 为生成值）。处理：页面照常入组（贡献 sources/topics/相关页面/§8 覆盖），
  轮次聚合只吃有编号页（组内必有 ≥1 编号轮，实测零「整组无编号」）；正文问询轮次段
  对无编号类别追加「{kind} · 无轮次编号 · 问题 min~max」行如实呈现；相关页面别名
  无轮次时用「{round_kind}·问题{n}」。不发明轮次编号，不丢页。
  ② 归纳通道既有页 fm.company=全称。互含不成立时（世华科技/乐鑫科技/南芯科技/应流股份）
  §8 直接 0 命中；互含成立的全称也过宽（光电股份 ⊂ 深圳清溢光电股份 → §8 误命中 16 题）。
  → 并入页 company 一律改写为题页短名（§5 契约本义），原全称挪入 §5 预留的 company_full；
  正文不动。
  ③ A3 标准体页（正文含「项目概况」+「相关页面」两节）重入并入门类时不再追加聚合段。
  ④ 2024 实例 5147 页中 3056 页（全部为 exchange=北交所）缺 board——北交所无板块之分，
  board 恒=北交所（既有 24 页归纳通道同款约定，§4 映射表同此）。仅此一处做确定性推导，
  非猜测；沪深页缺 board 仍按 I3 停手。2025 全量 8878 页 board 无缺，本推导不触发。
  ⑤ 2024 既有页中 2 页文件名 deal 段写「重大资产重组」（普源精电/赛力斯），§4 正典为
  「重组」→ 归一化改名后并入（apply 先备份再改名），否则同实体双页破 I1、§8 ≥2 命中。

退出码：0 成功｜2 I1/I2/§8 断言失败｜3 底座 API 网络态｜4 白名单外值(I3)｜5 同名不同主体撞组
"""
import argparse
import collections
import datetime
import json
import os
import re
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

API_BASE = "http://127.0.0.1:19828"
DEFAULT_PROJECT = "283b69c0-157e-47a8-b1e3-f476d0735a7c"      # 2025 wiki 实例
DEFAULT_CASES_DIR = "C:/library/wiki/wiki/cases"
REPO_ROOT = Path(__file__).resolve().parents[1]
REPORT_DIR = REPO_ROOT / "plans" / "2026-10-29-a3-case-page-rebuild" / "reports"
PAGE_SIZE = 500
TIMEOUT = 30          # §2 超时 30s/页
RETRIES = 2           # §2 失败重试 2 次
RETRY_WAIT = 3        # §2 重试间隔 3s
TODAY = datetime.date.today().isoformat()

FIELDS = ["company", "exchange", "board", "deal", "year", "status", "financing_type",
          "round_no", "round_kind", "issuer", "question_no", "tags", "sources"]

SAFE_DEALS = {"IPO", "再融资", "重大资产重组"}
SAFE_BOARDS = {"主板", "科创板", "创业板", "北交所"}
SAFE_EXCHANGES = {"北交所", "上交所", "深交所"}
SAFE_STATUS = {"注册", "注册生效", "终止", "终止(撤回)", "不予注册"}
SAFE_MAP = {"deal": SAFE_DEALS, "board": SAFE_BOARDS,
            "exchange": SAFE_EXCHANGES, "status": SAFE_STATUS}

# §4 文件名前段映射（表外组合 = I3 违反 → fatal(4)）
NAME_PREFIX = {
    ("北交所", "北交所"): "北交所",
    ("深交所", "主板"): "深主板",
    ("深交所", "创业板"): "深创业板",
    ("上交所", "主板"): "沪主板",
    ("上交所", "科创板"): "沪科创板",
}
DEAL_SEG = {"重大资产重组": "重组"}     # §4 deal 段规则：重大资产重组→"重组"，其余原样
ILLEGAL = {"/": "／", "\\": "＼", ":": "：", "*": "＊", "?": "？",
           '"': "＂", "<": "＜", ">": "＞", "|": "｜"}   # §4 Windows 保留字符 → 全角
MERGE_KEY_ORDER = ["company", "exchange", "board", "deal", "year", "status",
                   "financing_type", "rounds", "created"]   # §7 补缺失键的键序（sources/updated 恒更新）
A3_MARK = "\n---\n\n## 问询轮次（A3 聚合）"


def die(code, msg):
    print(f"[fatal:{code}] {msg}")
    sys.exit(code)


# ---------------------------------------------------------------- 底座 API（§2/§2b）

def api_json(url, payload=None, notfound_ok=False):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    last = None
    for attempt in range(1 + RETRIES):
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if notfound_ok and e.code == 404:
                return None
            last = e
        except Exception as e:
            last = e
        if attempt < RETRIES:
            print(f"[retry] 第{attempt + 1}次失败 {last}，{RETRY_WAIT}s 后重试")
            time.sleep(RETRY_WAIT)
    die(3, f"底座 API 不通（重试{RETRIES}次后）：{url} → {last}")


def fetch_questions(pid):
    """§2 W5 全量拉取：字段值在 item['fields']，路径在 item['path']。"""
    items, offset, total = [], 0, None
    while True:
        d = api_json(f"{API_BASE}/api/v1/projects/{pid}/pages/query",
                     {"filter": {"type": "question"}, "fields": FIELDS,
                      "limit": PAGE_SIZE, "offset": offset})
        total = d.get("total", total)
        batch = d.get("items") or []
        items.extend(batch)
        print(f"[W5] offset={offset} 本页={len(batch)} 累计={len(items)}/{total}")
        if not batch or (total is not None and offset + len(batch) >= total) \
                or not d.get("hasMore", False):
            break
        offset += PAGE_SIZE
    if total is not None and len(items) != total:
        die(2, f"W5 拉取不完整：累计 {len(items)} != total {total}")
    return items


def fetch_existing_pages(pid):
    """§2b 既有 case 页清单 + 逐页 {content, frontmatter}；404 剔除。"""
    paths, offset = [], 0
    while True:
        d = api_json(f"{API_BASE}/api/v1/projects/{pid}/pages/query",
                     {"filter": {"path_prefix": "wiki/cases/"}, "fields": ["path"],
                      "limit": PAGE_SIZE, "offset": offset})
        batch = d.get("items") or []
        paths.extend(it["path"] for it in batch)
        total = d.get("total")
        if not batch or (total is not None and offset + len(batch) >= total) \
                or not d.get("hasMore", False):
            break
        offset += PAGE_SIZE
    pages = []
    for p in sorted(paths):
        d = api_json(f"{API_BASE}/api/v1/projects/{pid}/files/content?path="
                     + urllib.parse.quote(p, safe=""), notfound_ok=True)
        if d is None:
            print(f"[warn] 既有页 404（从冲突清单剔除）：{p}")
            continue
        pages.append({"path": p,
                      "filename": p.rsplit("/", 1)[-1],
                      "fm": d.get("frontmatter") or {},
                      "content": d.get("content") or ""})
    return pages


# ---------------------------------------------------------------- frontmatter 最小解析（既有页读写用）

def unquote(v):
    v = v.strip()
    if len(v) >= 2 and v[0] == '"' and v[-1] == '"':
        body = v[1:-1]
        # YAML 双引号转义还原（\" \\ 等）——既有行经 parse→重编码须字节一致，否则幂等 diff 假红
        out, i = [], 0
        esc = {'"': '"', "\\": "\\", "/": "/", "n": "\n", "t": "\t", "r": "\r", "0": "\0"}
        while i < len(body):
            ch = body[i]
            if ch == "\\" and i + 1 < len(body) and body[i + 1] in esc:
                out.append(esc[body[i + 1]])
                i += 2
                continue
            out.append(ch)
            i += 1
        return "".join(out)
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        return v[1:-1]
    return v


def split_inline_list(v):
    inner = v.strip()[1:-1]
    out, cur, inq = [], "", False
    for ch in inner:
        if ch == '"':
            inq = not inq
            cur += ch
        elif ch == "," and not inq:
            out.append(cur)
            cur = ""
        else:
            cur += ch
    if cur.strip():
        out.append(cur)
    return [unquote(x) for x in out if unquote(x) != ""]


def parse_fm(fm_text):
    fm, cur = {}, None
    for ln in fm_text.split("\n"):
        if not ln.strip():
            continue
        mli = re.match(r"^\s+-\s?(.*)$", ln)
        if mli and cur is not None:
            if not isinstance(fm.get(cur), list):
                fm[cur] = []
            item = mli.group(1).strip()
            if item:
                fm[cur].append(unquote(item))
            continue
        mk = re.match(r"^([A-Za-z_][A-Za-z0-9_-]*):(.*)$", ln)
        if mk:
            key, val = mk.group(1), mk.group(2).strip()
            cur = key
            if val == "":
                fm[key] = []
            elif val.startswith("[") and val.endswith("]"):
                fm[key] = split_inline_list(val)
            else:
                fm[key] = unquote(val)
                cur = None
    return fm


def split_page(raw):
    """返回 (fm文本, 正文)；无 frontmatter 返回 (None, 原文)。"""
    m = re.match(r"\A---[ \t]*\r?\n(.*?)\r?\n---[ \t]*\r?\n?", raw, re.S)
    if not m:
        return None, raw
    return m.group(1), raw[m.end():]


def to_list(v):
    if v is None:
        return []
    if isinstance(v, list):
        return [str(x) for x in v]
    return [str(v)]


# ---------------------------------------------------------------- 聚合（§3）

def normalize_source(s):
    """与 B7 sourceReferenceIdentity 同语义：取文件名、去空白、小写。"""
    name = s.rsplit("/", 1)[-1]
    return re.sub(r"\s+", "", name).lower()


def src_company_segment(s):
    """anti_collision 公司段：路径倒数第二段（…/<状态>/<公司段>/<文件>.pdf）。"""
    if "/" not in s:
        return s
    return s.rsplit("/", 2)[-2]


class Group:
    def __init__(self, company, deal, year):
        self.company, self.deal, self.year = company, deal, year
        self.pages = []
        self.exchanges, self.boards, self.statuses = set(), set(), set()
        self.financing_types = collections.Counter()
        self.rounds = set()                       # (int(round_no), kind, issuer)
        self.round_qrange = collections.defaultdict(set)   # (int(round_no), kind) -> {int(母题)}
        self.unnumbered = collections.defaultdict(set)     # 无 round_no 页：kind -> {int(母题)}
        self.unnumbered_count = collections.Counter()      # 无 round_no 页：kind -> 页数
        self.topics = collections.Counter()
        self.raw_sources = []
        self.status_counts = collections.Counter()


def group_pages(items):
    groups, violations = {}, []
    for it in items:
        f = it.get("fields") or {}
        bad = False
        fvals = {}
        for key in ("deal", "board", "exchange", "status"):
            val = str(f.get(key) or "").strip()
            if key == "board" and not val and str(f.get("exchange") or "").strip() == "北交所":
                val = "北交所"    # 实测适配④：北交所无板块之分，确定性推导（沪深缺仍 I3 停手）
            fvals[key] = val
            if val not in SAFE_MAP[key]:
                violations.append({"path": it.get("path"), "key": key, "value": f.get(key)})
                bad = True
        for key in ("company", "year"):
            if not str(f.get(key) or "").strip():
                violations.append({"path": it.get("path"), "key": key, "value": f.get(key)})
                bad = True
        try:
            major = int(str(f["question_no"]).split(".")[0])
        except (KeyError, TypeError, ValueError):
            violations.append({"path": it.get("path"), "key": "question_no",
                               "value": f.get("question_no")})
            bad = True
        rno_s = str(f.get("round_no") or "").strip()
        if rno_s and not rno_s.isdigit():
            violations.append({"path": it.get("path"), "key": "round_no", "value": f.get("round_no")})
            bad = True
        if bad:
            continue
        k = (f["company"], fvals["deal"], f["year"])
        g = groups.setdefault(k, Group(*k))
        g.pages.append(it)
        g.exchanges.add(fvals["exchange"])
        g.boards.add(fvals["board"])
        g.statuses.add(fvals["status"])
        g.status_counts[fvals["status"]] += 1
        ft = str(f.get("financing_type") or "").strip()
        if ft:
            g.financing_types[ft] += 1
        kind = str(f.get("round_kind") or "").strip()
        issuer = str(f.get("issuer") or "").strip()
        if rno_s:
            g.rounds.add((int(rno_s), kind, issuer))
            g.round_qrange[(int(rno_s), kind)].add(major)
        else:
            g.unnumbered[kind].add(major)
            g.unnumbered_count[kind] += 1
        for t in f.get("tags") or []:
            if isinstance(t, str) and t.startswith("topic:"):
                g.topics[t[6:]] += 1
        for s in f.get("sources") or []:
            if isinstance(s, str) and s.strip():
                g.raw_sources.append(s.strip())
    return groups, violations


def finalize_group(g, warnings, prefix_violations):
    """聚合 → 单一取值（含一致性校验）。exchange/board 组内必须唯一（§3 assert → 退出码2）。"""
    if len(g.exchanges) != 1 or len(g.boards) != 1:
        die(2, f"组内 exchange/board 不一致: {g.company} exchange={sorted(g.exchanges)} board={sorted(g.boards)}")
    exchange, board = next(iter(g.exchanges)), next(iter(g.boards))
    if (exchange, board) not in NAME_PREFIX:
        prefix_violations.append({"company": g.company, "exchange": exchange, "board": board})
        return None
    # status 众数；非众数项落 warning 清单（不中断）
    status, _cnt = g.status_counts.most_common(1)[0]
    if len(g.status_counts) > 1:
        warnings.append({"type": "status_minority", "company": g.company,
                         "detail": {"counts": dict(g.status_counts), "chosen": status,
                                    "minority_pages": [it["path"] for it in g.pages
                                                       if it["fields"]["status"] != status]}})
    financing_type = ""
    if g.financing_types:
        financing_type = g.financing_types.most_common(1)[0][0]
        if len(g.financing_types) > 1:
            warnings.append({"type": "financing_type_mixed", "company": g.company,
                             "detail": {"counts": dict(g.financing_types), "chosen": financing_type}})
    rounds_sorted = sorted(g.rounds)
    round_keys, issuer_ctr = [], collections.defaultdict(collections.Counter)
    for no, kind, issuer in rounds_sorted:
        if (no, kind) not in round_keys:
            round_keys.append((no, kind))
        issuer_ctr[(no, kind)][issuer] += 1
    issuer_by_round, issuer_warn = {}, []
    for rk, ctr in issuer_ctr.items():
        issuer_by_round[rk] = ctr.most_common(1)[0][0]
        if len(ctr) > 1:
            issuer_warn.append({f"{rk[0]}·{rk[1]}": dict(ctr)})
    if issuer_warn:
        warnings.append({"type": "issuer_mixed", "company": g.company, "detail": {"rounds": issuer_warn}})
    qrange = {rk: (min(v), max(v)) for rk, v in g.round_qrange.items()}
    unnumbered_lines = [{"kind": kind, "min": min(g.unnumbered[kind]), "max": max(g.unnumbered[kind]),
                         "count": g.unnumbered_count[kind]} for kind in sorted(g.unnumbered)]
    topics10 = [t for t, _ in g.topics.most_common(10)]
    # sources：归一键去重（保留首个原文），按原始路径序
    seen, sources = set(), []
    for s in g.raw_sources:
        nk = normalize_source(s)
        if nk in seen:
            continue
        seen.add(nk)
        sources.append(s)
    sources.sort()
    prefix = NAME_PREFIX[(exchange, board)]
    dseg = DEAL_SEG.get(g.deal, g.deal)
    illegal_hit = [ch for ch in g.company if ch in ILLEGAL]
    safe_company = "".join(ILLEGAL.get(ch, ch) for ch in g.company)
    if illegal_hit:
        warnings.append({"type": "illegal_filename_chars", "company": g.company,
                         "detail": {"chars": illegal_hit, "file_company": safe_company}})
    if safe_company != safe_company.rstrip(" ."):
        warnings.append({"type": "illegal_filename_chars", "company": g.company,
                         "detail": {"chars": ["尾部.或空格"], "file_company": safe_company}})
        safe_company = safe_company.rstrip(" .")
    fname = f"{safe_company}（{prefix}{dseg}·{g.year}）.md"
    title = f"{safe_company}（{prefix}{dseg}·{g.year}）"
    return {
        "company": g.company, "exchange": exchange, "board": board,
        "deal": g.deal, "year": g.year, "status": status,
        "financing_type": financing_type,
        "rounds_fm": [f"{no}·{kind}·{issuer}" for no, kind, issuer in rounds_sorted],
        "round_keys": round_keys, "issuer_by_round": issuer_by_round, "qrange": qrange,
        "unnumbered_lines": unnumbered_lines,
        "topics10": topics10, "sources": sources, "raw_sources": g.raw_sources,
        "pages": g.pages, "fname": fname, "title": title,
    }


def anti_collision(gd):
    """§3 同名不同主体防线：sources 路径公司段必须一致。返回冲突段列表或 None。"""
    segs = {src_company_segment(s) for s in gd["raw_sources"]}
    if len(segs) > 1:
        return sorted(segs)
    return None


# ---------------------------------------------------------------- 页面文本生成（§5/§6/§6b）

def qforce(s):
    return '"' + str(s).replace("\\", "\\\\").replace('"', '\\"') + '"'


def ysc(v):
    """YAML 平键标量：含特殊字符才加引号（对齐 §5 示例，中文/全角不动）。"""
    v = str(v)
    if v == "" or re.search(r"[:#{}\[\],&*?|>!%@'\"\n]", v) \
            or v[:1] in ("-", "?", ":") or v != v.strip():
        return qforce(v)
    return v


def qsort_key(it):
    f = it.get("fields") or {}
    qno = str(f.get("question_no") or "")
    try:
        rk = tuple(int(x) for x in qno.split("."))
    except ValueError:
        rk = (10 ** 9,)
    try:
        rno = int(str(f.get("round_no")))
    except (TypeError, ValueError):
        rno = 10 ** 9
    return (rno, rk, it.get("path") or "")


def page_link(it):
    f = it.get("fields") or {}
    slug = it.get("path") or ""
    if slug.startswith("wiki/"):
        slug = slug[len("wiki/"):]
    if slug.endswith(".md"):
        slug = slug[: -len(".md")]
    rno = str(f.get("round_no") or "").strip()
    if rno:
        alias = f"第{rno}轮·问题{f.get('question_no')}"
    else:
        kind = str(f.get("round_kind") or "").strip()
        alias = f"{kind}·问题{f.get('question_no')}" if kind else f"问题{f.get('question_no')}"
    return f"[[{slug}|{alias}]]"


def related_lines(gd):
    """§6 相关页面：≤200 题逐题列；>200 按轮汇总行+首末各一链（无编号类别自成一行）。"""
    pages = sorted(gd["pages"], key=qsort_key)
    if len(pages) <= 200:
        return [page_link(it) for it in pages]
    lines, buckets = [], collections.OrderedDict()
    for it in pages:
        f = it["fields"]
        rno = str(f.get("round_no") or "").strip()
        key = f"r:{rno}" if rno else f"u:{str(f.get('round_kind') or '').strip()}"
        buckets.setdefault(key, []).append(it)
    for key, its in buckets.items():
        label = f"第{key[2:]}轮" if key.startswith("r:") else f"{key[2:]}（无轮次编号）"
        lines.append(f"- {label} 共{len(its)}题 {page_link(its[0])} ~ {page_link(its[-1])}")
    return lines


def rounds_body_lines(gd):
    out = []
    for rk in gd["round_keys"]:
        no, kind = rk
        lo, hi = gd["qrange"][rk]
        out.append(f"- 第{no}轮 · {kind} · {gd['issuer_by_round'][rk]} · 问题 {lo}~{hi}")
    for u in gd["unnumbered_lines"]:
        kind = u["kind"] or "无轮次类别"
        out.append(f"- {kind} · 无轮次编号 · 问题 {u['min']}~{u['max']}")
    return out


def topics_line(gd):
    return " · ".join(gd["topics10"]) if gd["topics10"] else "—"


def build_fm_text(gd):
    """§5 frontmatter（新页）：year 恒引号保持字符串；financing_type 空则整行省略。"""
    L = ["type: case",
         f"company: {ysc(gd['company'])}",
         f"exchange: {ysc(gd['exchange'])}",
         f"board: {ysc(gd['board'])}",
         f"deal: {ysc(gd['deal'])}",
         f"year: {qforce(gd['year'])}",
         f"status: {ysc(gd['status'])}"]
    if gd["financing_type"]:
        L.append(f"financing_type: {ysc(gd['financing_type'])}")
    L.append("rounds:")
    for s in gd["rounds_fm"]:
        L.append(f"  - {qforce(s)}")
    L.append(f"created: {TODAY}")
    L.append(f"updated: {TODAY}")
    if gd["sources"]:
        L.append("sources:")
        for s in gd["sources"]:
            L.append(f"  - {ysc(s)}")
    else:
        L.append("sources: []")
    return "\n".join(L)


def build_new_text(gd):
    """§6 正文模板（§6b 为权威样例：括注为规约说明，不落入产物）。"""
    L = [f"# {gd['title']}", "",
         "## 项目概况", "",
         "| 键 | 值 |", "|---|---|",
         f"| 交易所 | {gd['exchange']} |",
         f"| 板块 | {gd['board']} |",
         f"| 交易类型 | {gd['deal']} |",
         f"| 年份 | {gd['year']} |",
         f"| 当前状态 | {gd['status']} |",
         f"| 融资类型 | {gd['financing_type'] or '—'} |",
         f"| 源文件数 | {len(gd['sources'])} |",
         "", "## 问询轮次", ""]
    L += rounds_body_lines(gd)
    L += ["", "## 监管关注主题", "", topics_line(gd)]
    L += ["", "## 相关页面", ""]
    L += related_lines(gd)
    return "---\n" + build_fm_text(gd) + "\n---\n" + "\n".join(L) + "\n"


def merge_case_page(raw, gd):
    """§7 并入既有页：已有键一律不动；sources=并集（既有原文形态优先）；updated=施工日；
    正文原样保留，末尾剥旧 A3 段（幂等）后追加分隔线与 A3 标准段。
    实测适配①：归纳通道页 fm.company=全称且与题页短名互含不成立（世华科技/乐鑫科技/南芯科技/
    应流股份四家，§8 生产匹配器会 0 命中）→ company 改写为题页短名（§5 本就规定 company=短名），
    原全称挪入 §5 预留的 company_full 键；正文概览中的全称原样保留。
    实测适配②：A3 标准体页（正文已含「项目概况」+「相关页面」两节）不再追加（A3 聚合）段，
    防 verify 幂等重处理时重复堆段。"""
    fm_text, body = split_page(raw)
    if fm_text is None:
        die(2, f"既有页缺 frontmatter：{gd['fname']}")
    have = parse_fm(fm_text)
    have_company = str(have.get("company") or "").strip()
    # 实测适配②（收紧版）：§5 契约 company=题页短名。归纳通道全称哪怕互含成立也过宽
    # （光电股份 ⊂ 清溢光电股份 → §8 生产匹配器误命中 16 题）→ 并入页 company 一律改写
    # 为题页短名，原值挪 company_full；正文概览中的全称原样保留。
    company_rewrite = bool(have_company) and have_company != gd["company"]
    lines, skip = [], False
    for ln in fm_text.split("\n"):
        if skip:
            if re.match(r"^\s+-", ln):
                continue
            skip = False
        mk = re.match(r"^([A-Za-z_][A-Za-z0-9_-]*):(.*)$", ln)
        if mk and mk.group(1) in ("sources", "updated"):
            if mk.group(2).strip() == "":
                skip = True
            continue
        if mk and mk.group(1) == "company" and company_rewrite:
            lines.append(f"company: {ysc(gd['company'])}")
            continue
        lines.append(ln)
    for key in MERGE_KEY_ORDER:
        if key in have:
            continue
        if key == "rounds":
            lines.append("rounds:")
            lines += [f"  - {qforce(s)}" for s in gd["rounds_fm"]]
        elif key == "financing_type":
            if gd["financing_type"]:
                lines.append(f"financing_type: {ysc(gd['financing_type'])}")
        else:
            val = {"company": gd["company"], "exchange": gd["exchange"], "board": gd["board"],
                   "deal": gd["deal"], "year": gd["year"], "status": gd["status"],
                   "created": TODAY}[key]
            lines.append(f"{key}: {qforce(val) if key == 'year' else ysc(val)}")
    if company_rewrite and "company_full" not in have:
        lines.append(f"company_full: {ysc(have_company)}")
    existing_srcs = to_list(have.get("sources"))
    norm_exist = {normalize_source(s) for s in existing_srcs}
    merged = list(existing_srcs)
    added = 0
    for s in gd["sources"]:
        if normalize_source(s) not in norm_exist:
            merged.append(s)
            added += 1
    lines.append(f"updated: {TODAY}")
    if merged:
        lines.append("sources:")
        lines += [f"  - {ysc(s)}" for s in merged]
    else:
        lines.append("sources: []")
    idx = body.find(A3_MARK)
    if idx != -1:
        body = body[:idx]                     # 幂等：剥旧 A3 段再追加
    body_core = body.rstrip("\r\n")
    if "## 项目概况" in body_core and "## 相关页面" in body_core:
        # A3 标准体页：正文已完整，仅做 fm 手术（sources 并集/company 改写/updated），不加段
        return "---\n" + "\n".join(lines) + "\n---\n" + body_core + "\n"
    app = ["---", "", "## 问询轮次（A3 聚合）", ""]
    app += rounds_body_lines(gd)
    app += ["", "## 监管关注主题（A3 聚合）", "", topics_line(gd)]
    app += ["", "## 相关页面（A3 聚合）", ""]
    app += related_lines(gd)
    return "---\n" + "\n".join(lines) + "\n---\n" + body_core + "\n" + "\n".join(app) + "\n"


# ---------------------------------------------------------------- B7 匹配验证（§8）

def b7_match(question_fields, case_fms):
    """翻译自 ingest.ts syncCaseSourcesFromQaSplit：type=case 前置 + company 互含 + deal/year 一致。"""
    company = str(question_fields.get("company") or "").strip()
    hits = []
    for fm in case_fms:
        if fm.get("type") != "case":
            continue
        cc = str(fm.get("company") or "").strip()
        if not cc:
            continue
        if not (cc == company or cc in company or company in cc):
            continue
        deal_q = str(question_fields.get("deal") or "").strip()
        deal_c = str(fm.get("deal") or "").strip()
        if deal_q and deal_c and deal_c != deal_q:
            continue
        year_q = str(question_fields.get("year") or "").strip()
        year_c = fm.get("year")
        if year_q and year_c is not None and str(year_c).strip() != year_q:
            continue
        hits.append(fm)
    return hits


# ---------------------------------------------------------------- 管线（断言全过才许写）

def build_context(args):
    items = fetch_questions(args.project)
    groups, violations = group_pages(items)
    if violations:
        for v in violations:
            print(f"[I3] {v['path']}")
            print(f"     {v['key']}={v['value']!r}")
        die(4, f"白名单外值 {len(violations)} 处，停手报告（未写任何文件）")
    warnings, gds, prefix_viol = [], [], []
    for k in sorted(groups):
        gd = finalize_group(groups[k], warnings, prefix_viol)
        if gd is not None:
            gds.append(gd)
    if prefix_viol:
        for v in prefix_viol:
            print(f"[I3] 表外 (exchange,board) 组合：{v['company']} exchange={v['exchange']} board={v['board']}")
        die(4, f"文件名映射表外组合 {len(prefix_viol)} 组，停手报告（未写任何文件）")
    # I1：生成文件名唯一
    dups = [n for n, c in collections.Counter(gd["fname"] for gd in gds).items() if c > 1]
    if dups:
        die(2, f"I1 破防：生成文件名重复 {dups}")
    # 同名不同主体防线（§3 anti_collision）
    collides = [(gd, anti_collision(gd)) for gd in gds]
    collides = [(gd, segs) for gd, segs in collides if segs]
    if collides:
        for gd, segs in collides:
            print(f"[撞组] {gd['fname']} 公司段不一致：{segs}")
        die(5, f"疑似同名不同主体 {len(collides)} 组，需人工拆组裁决（未写任何文件）")
    # 既有页分类
    existing = fetch_existing_pages(args.project)
    cases_dir = Path(args.cases_dir)
    by_name = {gd["fname"]: gd for gd in gds}
    merge_list, unmatched, pending_renames = [], [], []
    for ep in existing:
        gd = by_name.get(ep["filename"])
        raw_path = cases_dir / ep["filename"]
        if not raw_path.exists():
            print(f"[warn] 既有页磁盘缺失（从冲突清单剔除）：{raw_path}")
            unmatched.append(ep["filename"])
            continue
        if gd is None:
            # 实测适配⑤：归纳通道既有页文件名 deal 段写「重大资产重组」，§4 正典为「重组」
            # → 归一化改名后并入（apply 先备份再改名）；正典名已被占用则按 I1 停手
            canon = ep["filename"].replace("重大资产重组", "重组")
            gd2 = by_name.get(canon) if canon != ep["filename"] else None
            if gd2 is not None and not (cases_dir / canon).exists():
                pending_renames.append({"from": ep["filename"], "to": canon})
                raw = raw_path.read_bytes().decode("utf-8").lstrip("\ufeff")
                merge_list.append({"ep": {**ep, "filename": canon}, "gd": gd2, "raw": raw})
                continue
            unmatched.append(ep["filename"])
            warnings.append({"type": "unmatched_existing", "company": ep["filename"],
                             "detail": {"note": "磁盘存在但不属本次生成的 (company,deal,year) 组"}})
            continue
        raw = raw_path.read_bytes().decode("utf-8").lstrip("\ufeff")
        merge_list.append({"ep": ep, "gd": gd, "raw": raw})
    covered = {m["gd"]["fname"] for m in merge_list}
    new_list = [gd for gd in gds if gd["fname"] not in covered]
    if pending_renames:
        warnings.append({"type": "rename_deal_segment", "company": ";".join(r["from"] for r in pending_renames),
                         "detail": {"renames": pending_renames}})
    return {"items": items, "gds": gds, "new": new_list, "merge": merge_list,
            "warnings": warnings, "unmatched": unmatched, "cases_dir": cases_dir,
            "pending_renames": pending_renames}


# ---------------------------------------------------------------- 三种模式（§9）

def report_path(kind, args):
    suffix = ".json" if args.project == DEFAULT_PROJECT else f"-{args.project[:8]}.json"
    return REPORT_DIR / (kind + suffix)


def write_report(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def merge_stats(m):
    have = parse_fm(split_page(m["raw"])[0])
    missing = [k for k in MERGE_KEY_ORDER if k not in have]
    norm_exist = {normalize_source(s) for s in to_list(have.get("sources"))}
    added = sum(1 for s in m["gd"]["sources"] if normalize_source(s) not in norm_exist)
    return {"file": m["gd"]["fname"], "missing_keys": missing, "sources_added": added}


def cmd_dryrun(ctx, args):
    new_pages = [{"file": gd["fname"], "company": gd["company"], "deal": gd["deal"],
                  "year": gd["year"], "status": gd["status"],
                  "rounds": len(gd["rounds_fm"]), "questions": len(gd["pages"]),
                  "sources": len(gd["sources"]),
                  "topics_top3": gd["topics10"][:3]} for gd in ctx["new"]]
    report = {"generated_at": datetime.datetime.now().isoformat(timespec="seconds"),
              "mode": "dry-run", "project": args.project, "cases_dir": args.cases_dir,
              "questions_total": len(ctx["items"]), "groups_total": len(ctx["gds"]),
              "new_count": len(ctx["new"]), "merge_count": len(ctx["merge"]),
              "new_pages": new_pages,
              "merge_pages": [merge_stats(m) for m in ctx["merge"]],
              "warnings": ctx["warnings"],
              "unmatched_existing": ctx["unmatched"],
              "pending_renames": ctx["pending_renames"]}
    path = report_path("dryrun", args)
    write_report(path, report)
    print(f"[dry-run] 组 {report['groups_total']}（新建 {report['new_count']} / 并入 {report['merge_count']}）"
          f"；警告 {len(ctx['warnings'])} 条；未匹配既有页 {len(ctx['unmatched'])} 页")
    for np in new_pages[:5]:
        print(f"  新建样例 {np['file']}（{np['rounds']}轮/{np['questions']}题/源{np['sources']}）")
    for mp in report["merge_pages"][:5]:
        print(f"  并入样例 {mp['file']} 补键{mp['missing_keys']} 源+{mp['sources_added']}")
    for w in ctx["warnings"][:10]:
        print(f"  警告 {w['type']}: {w['company']} {json.dumps(w['detail'], ensure_ascii=False)[:120]}")
    print(f"[报告] {path}")


def cmd_apply(ctx, args):
    cases_dir = ctx["cases_dir"]
    cases_dir.mkdir(parents=True, exist_ok=True)
    project_root = cases_dir.parent.parent
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_dir = project_root / ".llm-wiki" / "a3-backups" / stamp
    if ctx["merge"] or ctx["pending_renames"]:
        backup_dir.mkdir(parents=True, exist_ok=True)
        for m in ctx["merge"]:
            src = cases_dir / m["gd"]["fname"]
            if src.exists():
                shutil.copy2(src, backup_dir / m["gd"]["fname"])
        print(f"[备份] 并入页原文件 → {backup_dir}")
    for r in ctx["pending_renames"]:
        shutil.copy2(cases_dir / r["from"], backup_dir / (r["from"].replace("重大资产重组", "重组") + ".rename-from.bak"))
        os.rename(cases_dir / r["from"], cases_dir / r["to"])
        print(f"[改名] {r['from']} → {r['to']}")
    for gd in ctx["new"]:
        (cases_dir / gd["fname"]).write_bytes(build_new_text(gd).encode("utf-8"))
    for m in ctx["merge"]:
        (cases_dir / m["gd"]["fname"]).write_bytes(merge_case_page(m["raw"], m["gd"]).encode("utf-8"))
    print(f"[done] 新建 {len(ctx['new'])} / 并入 {len(ctx['merge'])} / 断言全过")
    print("[next] 重启底座刷新 frontmatter 索引，然后跑 --verify")


def cmd_verify(ctx, args):
    # §8 全量匹配：case 页 frontmatter 直接读盘（直写与底座索引兼容，盘为事实源）
    disk_raws, disk_fms = {}, []
    for p in sorted(ctx["cases_dir"].glob("*.md")):
        raw = p.read_bytes().decode("utf-8").lstrip("\ufeff")
        disk_raws[p.name] = raw
        fm_text, _ = split_page(raw)
        fm = parse_fm(fm_text) if fm_text is not None else {}
        fm["__file"] = p.name
        disk_fms.append(fm)
    zero_hits, multi_hits = [], []
    for it in ctx["items"]:
        f = it.get("fields") or {}
        hits = b7_match(f, disk_fms)
        if len(hits) == 1:
            continue
        entry = {"path": it.get("path"), "company": f.get("company"),
                 "deal": f.get("deal"), "year": f.get("year"),
                 "hit_files": [h.get("__file") for h in hits]}
        (zero_hits if not hits else multi_hits).append(entry)
    # 幂等 diff：重算产物与磁盘逐字节比对
    diffs = []
    covered = {m["gd"]["fname"] for m in ctx["merge"]}
    for m in ctx["merge"]:
        if merge_case_page(m["raw"], m["gd"]) != m["raw"]:
            diffs.append(m["gd"]["fname"])
    for gd in ctx["new"]:
        actual = disk_raws.get(gd["fname"])
        if actual is None or build_new_text(gd) != actual:
            diffs.append(gd["fname"])
    report = {"generated_at": datetime.datetime.now().isoformat(timespec="seconds"),
              "mode": "verify", "project": args.project, "cases_dir": args.cases_dir,
              "questions_total": len(ctx["items"]),
              "hit_exactly_one": len(ctx["items"]) - len(zero_hits) - len(multi_hits),
              "zero_hits": zero_hits, "multi_hits": multi_hits,
              "case_files_on_disk": len(disk_raws),
              "groups_total": len(ctx["gds"]),
              "new_count": len(ctx["new"]), "merge_count": len(ctx["merge"]),
              "diff_files": sorted(set(diffs)),
              "unmatched_disk_files": sorted(n for n in disk_raws
                                             if n not in covered
                                             and n not in {gd["fname"] for gd in ctx["new"]})}
    path = report_path("verify", args)
    write_report(path, report)
    ok_b7 = not zero_hits and not multi_hits
    ok_diff = not report["diff_files"]
    print(f"[verify] §8 匹配 {report['hit_exactly_one']}/{report['questions_total']} 命中恰1"
          f"（0命中 {len(zero_hits)}，≥2命中 {len(multi_hits)}）")
    print(f"[verify] 幂等 diff {len(report['diff_files'])} 个；盘上 case 页 {report['case_files_on_disk']} 个"
          f"（未匹配 {len(report['unmatched_disk_files'])}）")
    for e in (zero_hits + multi_hits)[:10]:
        print(f"  §8异常 {e['company']!r} hits={len(e['hit_files'])} {e['hit_files'][:3]}")
    for n in report["diff_files"][:10]:
        print(f"  diff {n}")
    print(f"[报告] {path}")
    if not ok_b7:
        die(2, f"§8 断言失败：0命中 {len(zero_hits)} / ≥2命中 {len(multi_hits)}")
    if not ok_diff:
        die(2, f"幂等 diff 非零：{report['diff_files']}")
    print("[verify] 全过")


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description="A3 案例库 case 页补建收尾批（方案 plans/2026-10-29-a3-case-page-rebuild）")
    ap.add_argument("--apply", action="store_true", help="写库（写入前先跑全部前置断言）")
    ap.add_argument("--verify", action="store_true", help="不写库：§8 全量匹配 + 幂等 diff")
    ap.add_argument("--project", default=DEFAULT_PROJECT, help="底座项目 uuid（默认 2025 wiki 实例）")
    ap.add_argument("--cases-dir", default=DEFAULT_CASES_DIR, help="case 页落盘目录")
    args = ap.parse_args()
    if args.apply and args.verify:
        die(2, "--apply 与 --verify 互斥")
    ctx = build_context(args)
    if args.verify:
        cmd_verify(ctx, args)
    elif args.apply:
        cmd_apply(ctx, args)
    else:
        cmd_dryrun(ctx, args)


if __name__ == "__main__":
    main()
