# -*- coding: utf-8 -*-
"""春晖投行在线全站法规抓取器（R3 §九，2026-10-24）。

形态实测（2026-10-24）：
- 列表页 http://www.shenchunhui.com/_private/guifangxingwenjian/guifanxingwenjian.htm
  （GBK 编码，约 4,406 条本站详情页链接 fagui/<年>/<slug>.htm + ~100 官方外链）
- 条目文本内联标注效力状态：「…已废止」（634 处）/「已失效」/「停止执行」
- 详情页：标题行 → 文号行 → 正文全文，GBK 编码

用法：
  python chunhui_scraper.py list                 # 只解析列表页出清单（不抓详情）
  python chunhui_scraper.py fetch [--limit N]    # 抓详情（默认全量有效条目；断点续跑）
  python chunhui_scraper.py stats                # 抓取产物统计

产物：C:/library/.data/chunhui-20261024/
  manifest.jsonl   全部条目（title/url/year/status/category/classify_basis）
  pages/<year>__<slug>.json   每条详情 {title, doc_number, body_lines, url, fetched}
限速 0.3s/请求；已抓条目跳过（断点续跑）。
"""
import io
import json
import os
import re
import sys
import time
import urllib.request

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

BASE = "http://www.shenchunhui.com/_private/guifangxingwenjian/"
LIST_URL = BASE + "guifanxingwenjian.htm"
OUT_DIR = r"C:/library/.data/chunhui-20261024"
PAGES_DIR = os.path.join(OUT_DIR, "pages")
MANIFEST = os.path.join(OUT_DIR, "manifest.jsonl")
DELAY = 0.3

# category 六分类轴（schema R3）：按标题关键词规则归类，basis 记规则可溯源。
# 通用法规词（条例/办法/规定/通知）不能兜底证券——法律与行政法规按内容归
# 会计/审计/税务，拿不准的归「证券」仅限证监会/交易所语境（2026-10-24
# 实测「企业财务会计报告条例」被兜底证券的教训）。
CATEGORY_RULES = [
    ("会计", r"会计准则|企业会计|会计制度|财会〔|财务报表|财务会计|会计处理|会计估计|会计政策"),
    ("审计", r"审计准则|注册会计师|审计报告|会计师事务所|审计|审阅"),
    ("评估", r"资产评估|评估准则|评估机构|评估师"),
    ("内控", r"内部控制|内控|风险管理指引|合规管理"),
    ("税务", r"税|发票|纳税|税收"),
    ("证券", r"证券|交易所|上市公司|发行|上市|募集|招股|证监会|北交所|沪|深市|挂牌|股份转让"),
]


def classify(title: str) -> tuple[str, str]:
    for cat, pattern in CATEGORY_RULES:
        if re.search(pattern, title):
            return cat, pattern.split("|")[0]
    return "证券", "兜底（投行法规库主体）"


def http_get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (research; llm-wiki R3)"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read()


def parse_list() -> list[dict]:
    raw = http_get(LIST_URL)
    s = raw.decode("gbk", errors="replace")
    entries = []
    seen = set()
    for m in re.finditer(
        r'<a[^>]+href="(fagui/(\d{4})/([^"]+))"[^>]*>([\s\S]*?)</a>', s
    ):
        href, year, fname, inner = m.group(1), m.group(2), m.group(3), m.group(4)
        if href in seen:
            continue
        seen.add(href)
        # 条目标题=链接文字（含相邻文本节点里的效力标注——春晖把「已废止」
        # 写在链接后的同一表格单元/行文本里）
        title = re.sub(r"<[^>]+>", "", inner)
        title = re.sub(r"\s+", " ", title).strip()
        if not title:
            continue
        # 效力标注在链接后 80 字符的原文里找
        tail = s[m.end():m.end() + 240]
        tail_text = re.sub(r"<[^>]+>", " ", tail)
        status = "现行有效"
        if re.search(r"已?废止|已失效|停止执行", tail_text[:80]):
            status = "已废止"
        cat, basis = classify(title)
        # 非本站 HTML（pdf/doc 附件等）只入清单不抓详情——后续需要再走
        # 对应解析通道，不在本抓取器范围。.doc 二进制若当 GBK 网页抓会
        # 整页乱码（2026-10-24 实测 11 条漏进样本目录的教训）。
        lower = fname.lower()
        kind = "htm"
        if lower.endswith(".pdf"):
            kind = "pdf"
        elif lower.endswith((".doc", ".docx", ".xls", ".xlsx", ".wps")):
            kind = "doc"
        entries.append({
            "title": title,
            "url": BASE + href,
            "year": year,
            "status": status,
            "category": cat,
            "classify_basis": basis,
            "kind": kind,
        })
    return entries


def fetch_page(entry: dict) -> dict:
    raw = http_get(entry["url"])
    s = raw.decode("gbk", errors="replace")
    text = re.sub(r"<script[\s\S]*?</script>|<style[\s\S]*?</style>", "", s)
    text = re.sub(r"<[^>]+>", "\n", text)
    lines = [re.sub(r"\s+", " ", l).strip() for l in text.split("\n")]
    lines = [l for l in lines if l]
    # 去导航头（前几行是站点统一导航）与尾注
    # 形态：['春晖投行在线/规范性文件一览', '春晖投行在线', '/', '规范性文件一览', 标题, 文号?, 正文…]
    try:
        start = next(i for i, l in enumerate(lines) if l == "规范性文件一览") + 1
    except StopIteration:
        start = 4
    body = lines[start:]
    # 尾部站点导航（联系方式/备案号等）剥离
    tail_marks = ("shenchunhui@263.net", "浙ICP", "图书购买", "站长", "版权", "免责")
    end = len(body)
    for i, l in enumerate(body):
        if any(mark in l for mark in tail_marks):
            end = i
            break
    body = body[:end]
    # 文号形态：独立文号行 / 「发文文号 X」 / 「文号：X」（春晖详情页三种
    # 实测形态：财会〔2026〕7号 / 发文文号 上证发〔2026〕65号 / 股转公告〔2026〕214号）
    DOC_NO = re.compile(
        r"^(?:发文文号[:：\s]*|文号[:：\s]*)?"
        r"[（〔\[]?(?:财会|证监|上证发|深证上|深证|北证|股转公告|股转|公告|财金|国资|国税|财税|会监|银保监|金规|工信部|人民银行|国家税务总局|财综|发改|上交所|深交所|北交所)"
        r"[〔\[]?\d{4}[〕\]]?第?\d+号?[）)\]]?"
    )
    title = body[0] if body else entry["title"]
    doc_number = ""
    rest = body[1:]
    if rest and DOC_NO.match(rest[0]):
        doc_number = rest[0].replace("发文文号", "").replace("文号:", "").replace("文号：", "").strip()
        rest = rest[1:]
    # 标题行本身是文号（该页标题被导航剥离吃掉）→ 文号顺便提取，标题用列表页回退
    if DOC_NO.match(title) or len(title) < 8:
        if not doc_number and DOC_NO.match(title):
            doc_number = title.replace("发文文号", "").strip()
        title = entry["title"]
    return {
        "title": title,
        "doc_number": doc_number,
        "body_lines": rest,
        "url": entry["url"],
        "fetched": time.strftime("%Y-%m-%d %H:%M:%S"),
    }


def cmd_list():
    entries = parse_list()
    os.makedirs(OUT_DIR, exist_ok=True)
    with io.open(MANIFEST, "w", encoding="utf-8", newline="\n") as f:
        for e in entries:
            f.write(json.dumps(e, ensure_ascii=False) + "\n")
    valid = [e for e in entries if e["status"] == "现行有效"]
    cats = {}
    for e in valid:
        cats[e["category"]] = cats.get(e["category"], 0) + 1
    print(f"total={len(entries)} valid={len(valid)} repealed={len(entries)-len(valid)}")
    print("valid by category:", json.dumps(cats, ensure_ascii=False))
    print(f"manifest -> {MANIFEST}")


def cmd_fetch(limit=None, workers=8):
    entries = [json.loads(l) for l in io.open(MANIFEST, encoding="utf-8")]
    valid = [
        e for e in entries
        if e["status"] == "现行有效" and e.get("kind", "htm") == "htm"
    ]
    os.makedirs(PAGES_DIR, exist_ok=True)

    def out_path(e):
        # slug 保留 fagui/ 之后的中间子目录（2023/xiehui/1.htm → xiehui__1），
        # 否则 2023 年注册制配套规则 1.htm–30.htm 跨子目录同名互相覆盖
        #（2026-10-24 实测 29 个文件名吞掉 79 条目、净丢 50 条）。
        slug = (
            e["url"].rsplit("fagui/", 1)[-1]
            .replace(".htm", "")
            .replace("/", "__")
        )
        return os.path.join(PAGES_DIR, f"{e['year']}__{slug}.json")

    todo = [e for e in valid if not os.path.exists(out_path(e))]
    if limit is not None:
        todo = todo[:limit]
    total = len(valid) - len(todo)
    print(f"resume: done={total} todo={len(todo)} workers={workers}")

    import threading
    from concurrent.futures import ThreadPoolExecutor

    lock = threading.Lock()
    state = {"done": 0, "fail": 0}

    def worker(e):
        try:
            page = fetch_page(e)
            with io.open(out_path(e), "w", encoding="utf-8", newline="\n") as f:
                json.dump(page, f, ensure_ascii=False)
            ok = True
        except Exception as err:  # noqa: BLE001 — 逐条容错，失败如实记录后继续
            ok = False
            err_msg = str(err)
        with lock:
            if ok:
                state["done"] += 1
            else:
                state["fail"] += 1
                print(f"FAIL {e['url']}: {err_msg}")
            n = state["done"] + state["fail"]
            if n % 100 == 0:
                print(f"progress {n}/{len(todo)} (done={state['done']} fail={state['fail']})")
        time.sleep(DELAY)  # 每 worker 内限速，站端 QPS = workers/DELAY 有上限

    with ThreadPoolExecutor(max_workers=workers) as pool:
        pool.map(worker, todo)
    print(f"done: fetched={state['done']} fail={state['fail']} -> {PAGES_DIR}")


def cmd_stats():
    entries = [json.loads(l) for l in io.open(MANIFEST, encoding="utf-8")]
    valid = [e for e in entries if e["status"] == "现行有效"]
    htm = [e for e in valid if e.get("kind") == "htm"]
    # 兼容旧 manifest：url 是 .doc/.docx 等但 kind 还是 htm 的，如实归 doc
    real_htm = [
        e for e in htm
        if not e["url"].lower().endswith((".doc", ".docx", ".xls", ".xlsx", ".wps"))
    ]
    pages = [f for f in os.listdir(PAGES_DIR)] if os.path.isdir(PAGES_DIR) else []
    empty = 0
    for f in pages:
        doc = json.load(io.open(os.path.join(PAGES_DIR, f), encoding="utf-8"))
        if len(doc.get("body_lines", [])) < 5:
            empty += 1
    print(f"manifest total={len(entries)} valid={len(valid)}")
    print(f"valid htm={len(real_htm)} pdf={sum(1 for e in valid if e.get('kind')=='pdf')} doc={len(valid)-len(real_htm)-sum(1 for e in valid if e.get('kind')=='pdf')}")
    print(f"pages fetched={len(pages)} suspicious_short(<5 lines)={empty}")


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args or args[0] == "list":
        cmd_list()
    elif args[0] == "fetch":
        lim = None
        if "--limit" in args:
            lim = int(args[args.index("--limit") + 1])
        workers = 8
        if "--workers" in args:
            workers = int(args[args.index("--workers") + 1])
        cmd_fetch(lim, workers)
    elif args[0] == "stats":
        cmd_stats()
    else:
        print(__doc__)
