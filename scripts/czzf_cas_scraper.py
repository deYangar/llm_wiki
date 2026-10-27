# -*- coding: utf-8 -*-
"""czzf_cas_scraper.py —— 模块 F：CAS 1-42 主准则财政部官网补抓（R3 决议条 4）。

源形态（2026-10-27 盘点实勘）：
  1. kjs.mof.gov.cn 政策发布栏目 37 页列表 -> 17 个单项修订/新增页（htm 正文
     或 PDF 附件）+ 2006 版 38 项合集 RAR（一个附件打包 1-38 号 PDF，已下载
     解包进 RAW/pdfs/）；
  2. 第 25 号 2020 修订版不在 kjs 栏目 -> gov.cn 政策文件库 PDF；
  3. 基本准则（财政部令第 76 号）官网未探到直链 -> 如实缺口，不硬造。

解析纪律（方案 §2）：PDF 一律走本机 MinerU V1 :8000 standard 档（不走 pdfium
降级——issue806 教训）；htm 正文直抽（TRS_Editor 容器，UTF-8）。

产物对齐春晖 pages/*.json 格态（title/doc_number/body_lines/url/fetched/kind），
build 直接出 regulation md（frontmatter: category=会计 source=mof issuer=财政部
status=现行有效）。

用法:
  python scripts/czzf_cas_scraper.py status            # 进度
  python scripts/czzf_cas_scraper.py fetch             # 抓取+解析 -> pages/*.json（断点续跑）
  python scripts/czzf_cas_scraper.py build [--out DIR] # pages -> regulation md
"""
import argparse
import hashlib
import html as htmllib
import io
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", line_buffering=True)

RAW = r"C:/library/.data/czzf-cas-20261027"
PAGES = os.path.join(RAW, "pages")
PDFS = os.path.join(RAW, "pdfs")
MANIFEST = os.path.join(RAW, "manifest.jsonl")
MINERU = "http://127.0.0.1:8000/v1"
DELAY = 0.3

# ---- 源清单（2026-10-27 kjs 列表页实勘）----
# 单项页：cas_no -> (kjs URL, 标准名)。title 取通知《》内名（与库内现行页名对齐，
# 同名覆盖治本替换空壳/旧版）。
SINGLE_PAGES = {
    2: ("https://kjs.mof.gov.cn/zhengcefabu/201403/t20140319_1057127.htm", "企业会计准则第2号——长期股权投资"),
    7: ("https://kjs.mof.gov.cn/zhengcefabu/201905/t20190516_3598937.htm", "企业会计准则第7号——非货币性资产交换"),
    9: ("https://kjs.mof.gov.cn/zhengcefabu/201401/t20140129_1040561.htm", "企业会计准则第9号——职工薪酬"),
    12: ("https://kjs.mof.gov.cn/zhengcefabu/201905/t20190529_3599229.htm", "企业会计准则第12号——债务重组"),
    14: ("https://kjs.mof.gov.cn/zhengcefabu/201707/t20170719_2653110.htm", "企业会计准则第14号——收入"),
    16: ("https://kjs.mof.gov.cn/zhengcefabu/201705/t20170525_2608690.htm", "企业会计准则第16号——政府补助"),
    21: ("https://kjs.mof.gov.cn/zhengcefabu/201812/t20181213_3116731.htm", "企业会计准则第21号——租赁"),
    22: ("https://kjs.mof.gov.cn/zhengcefabu/201704/t20170406_2575699.htm", "企业会计准则第22号——金融工具确认和计量"),
    23: ("https://kjs.mof.gov.cn/zhengcefabu/201704/t20170406_2575702.htm", "企业会计准则第23号——金融资产转移"),
    24: ("https://kjs.mof.gov.cn/zhengcefabu/201704/t20170406_2575705.htm", "企业会计准则第24号——套期会计"),
    25: ("https://www.gov.cn/zhengce/zhengceku/2020-12/25/content_5573188.htm", "企业会计准则第25号——保险合同"),
    30: ("https://kjs.mof.gov.cn/zhengcefabu/202608/t20260805_3994927.htm", "企业会计准则第30号——财务报表列报"),
    33: ("https://kjs.mof.gov.cn/zhengcefabu/201402/t20140220_1045206.htm", "企业会计准则第33号——合并财务报表"),
    37: ("https://kjs.mof.gov.cn/zhengcefabu/201705/t20170515_2600144.htm", "企业会计准则第37号——金融工具列报"),
    39: ("https://kjs.mof.gov.cn/zhengcefabu/201401/t20140128_1040392.htm", "企业会计准则第39号——公允价值计量"),
    40: ("https://kjs.mof.gov.cn/zhengcefabu/201402/t20140220_1045209.htm", "企业会计准则第40号——合营安排"),
    41: ("https://kjs.mof.gov.cn/zhengcefabu/201403/t20140327_1060353.htm", "企业会计准则第41号——在其他主体中权益的披露"),
    42: ("https://kjs.mof.gov.cn/zhengcefabu/201705/t20170516_2601445.htm", "企业会计准则第42号——持有待售的非流动资产、处置组和终止经营"),
}
# RAR 里的 2006 版（未再单独修订的号；38 号「首次执行」库内缺失属新增）
RAR_2006_NUMBERS = [1, 3, 4, 5, 6, 8, 10, 11, 13, 15, 17, 18, 19, 20, 26, 27, 28, 29, 31, 32, 34, 35, 36, 38]
# 已解析过的 PDF sha -> pages 条目（断点），1 号试点已验证
KNOWN_SHA = {}

DOC_NO = re.compile(
    r"[（〔\[]?(?:财会|财政部令|证监发)[〔\[]?(?:第?\d{4}|第\d+号)?[〕\]]?第?\d+号?[）)\]]?"
)


def http_get(url: str, timeout=60) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (research; llm-wiki R3)"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def mineru_markdown(pdf_bytes: bytes, name: str) -> str:
    sha = hashlib.sha256(pdf_bytes).hexdigest()
    if sha in KNOWN_SHA:
        return KNOWN_SHA[sha]
    # MinerU 按会话文件名去重（同名未过期会话 409），文件名带 sha 后缀保唯一
    uniq = f"{os.path.splitext(name)[0]}-{sha[:8]}.pdf"
    body = json.dumps({"filename": uniq, "bytes": len(pdf_bytes),
                       "mime_type": "application/pdf", "sha256sum": sha}).encode()
    req = urllib.request.Request(MINERU + "/uploads", data=body,
                                 headers={"Content-Type": "application/json"}, method="POST")
    up = json.load(urllib.request.urlopen(req, timeout=30))
    uid = up["id"]
    req = urllib.request.Request(f"{MINERU}/uploads/{uid}/content", data=pdf_bytes,
                                 headers={"Content-Type": "application/pdf"}, method="PUT")
    urllib.request.urlopen(req, timeout=300)
    req = urllib.request.Request(f"{MINERU}/uploads/{uid}/complete",
                                 data=json.dumps({"sha256sum": sha}).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    comp = json.load(urllib.request.urlopen(req, timeout=30))
    fid = comp["file"]["id"]
    body = json.dumps({"files": [{"source": {"type": "file_id", "file_id": fid}}],
                       "tier": "standard", "output_formats": ["markdown"]}).encode()
    req = urllib.request.Request(MINERU + "/parse/jobs", data=body,
                                 headers={"Content-Type": "application/json"}, method="POST")
    job = json.load(urllib.request.urlopen(req, timeout=30))
    jid = job["job_id"]
    t0 = time.time()
    while True:
        time.sleep(8)
        st = json.load(urllib.request.urlopen(f"{MINERU}/parse/jobs/{jid}", timeout=30))
        s = st.get("status")
        if s in ("completed", "failed"):
            break
        if time.time() - t0 > 1800:
            raise RuntimeError(f"MinerU job {jid} timeout")
        print(f"    mineru {int(time.time()-t0)}s {s}", flush=True)
    if s != "completed":
        raise RuntimeError(f"MinerU job failed: {str(st)[:200]}")
    f = st["files"][0]
    if f.get("status") != "completed":
        raise RuntimeError(f"file parse failed: {str(f.get('error'))[:150]}")
    md_file = (f.get("output_files") or {}).get("markdown", {}).get("file_id")
    md = urllib.request.urlopen(f"{MINERU}/files/{md_file}/content", timeout=60).read().decode("utf-8")
    KNOWN_SHA[sha] = md
    return md


def md_to_lines(md: str) -> list[str]:
    lines = []
    for l in md.splitlines():
        l = l.strip()
        if not l or l.startswith("```"):
            continue
        lines.append(l)
    return lines


def extract_htm(raw: bytes, base_url: str) -> tuple[str, list[str]]:
    """mof/gov 正文页抽取：TRS_Editor（mof）或 pages_content（gov.cn）容器优先。"""
    s = raw.decode("utf-8", errors="replace")
    m = (re.search(r'<div[^>]*id="TRS_Editor"[^>]*>([\s\S]*?)<!--/TRS_Editor-->', s)
         or re.search(r'<div[^>]*class="pages_content[^"]*"[^>]*>([\s\S]*?)</div>\s*<div', s)
         or re.search(r'<div[^>]*class="TRS_Editor[^"]*"[^>]*>([\s\S]*?)</div>\s*</div>', s))
    frag = m.group(1) if m else s
    frag = re.sub(r"<script[\s\S]*?</script>|<style[\s\S]*?</style>", "", frag)
    t = re.sub(r"<br\s*/?>", "\n", frag, flags=re.I)
    t = re.sub(r"</(p|div|tr|li|h[1-6]|td)>", "\n", t, flags=re.I)
    t = re.sub(r"<[^>]+>", "", t)
    t = htmllib.unescape(t)
    lines = [re.sub(r"[ \t\u3000]+", " ", l).strip() for l in t.split("\n")]
    return [l for l in lines if l]


def page_slug(url: str, fallback: str) -> str:
    m = re.search(r"/t(\d{8}_\d+)\.htm", url)
    return m.group(1) if m else re.sub(r"\W", "", fallback)[:30]


def load_manifest() -> dict:
    """cas_no -> 状态条目"""
    st = {}
    if os.path.exists(MANIFEST):
        for l in io.open(MANIFEST, encoding="utf-8"):
            d = json.loads(l)
            st[d["cas_no"]] = d
    return st


def save_manifest(st: dict):
    with io.open(MANIFEST, "w", encoding="utf-8", newline="\n") as f:
        for no in sorted(st):
            f.write(json.dumps(st[no], ensure_ascii=False) + "\n")


def find_rar_pdf(no: int) -> str | None:
    for f in os.listdir(PDFS):
        if f.startswith(f"企业会计准则第{no}号"):
            return os.path.join(PDFS, f)
    return None


def looks_garbled(title: str) -> bool:
    if not title:
        return True
    common = re.findall(r"[\u4e00-\u9fffA-Za-z0-9（）《》—、，。；：！？·\-\s]", title)
    return len(common) < len(title) * 0.85


def fetch_one(no: int, st: dict) -> None:
    e = {"cas_no": no, "status": "pending"}
    if no in SINGLE_PAGES:
        url, title = SINGLE_PAGES[no]
        e.update({"url": url, "title": title, "kind": "single"})
        raw = http_get(url)
        # htm 正文 or PDF 附件
        atts = re.findall(r'href="(\./[^"]+\.pdf)"', raw.decode("utf-8", errors="replace"), re.I)
        if len(re.sub(r"<[^>]+>", "", raw.decode("utf-8", errors="replace")).strip()) > 400 and not atts:
            lines = extract_htm(raw, url)
            doc_number = next((l for l in lines[:8] if DOC_NO.match(l)), "")
            body = lines
            e.update({"status": "fetched", "doc_number": doc_number, "body_lines": body})
        else:
            pdf_url = urllib.parse.urljoin(url, atts[0]) if atts else None
            if not pdf_url:
                # gov.cn 形态：files/ 绝对路径
                m = re.search(r'href="(https?://[^"]+/files/[^"]+\.pdf)"',
                              raw.decode("utf-8", errors="replace"), re.I)
                pdf_url = m.group(1) if m else None
            if not pdf_url:
                e.update({"status": "no-pdf", "err": "no attachment & thin body"})
                return
            pdf = http_get(pdf_url, timeout=300)
            e["pdf_url"] = pdf_url
            print(f"  [{no}] PDF {len(pdf)//1024}KB -> MinerU")
            md = mineru_markdown(pdf, f"cas{no}.pdf")
            lines = md_to_lines(md)
            doc_number = next((l for l in lines[:8] if DOC_NO.match(l)), "")
            e.update({"status": "fetched", "doc_number": doc_number, "body_lines": lines})
    else:
        path = find_rar_pdf(no)
        if not path:
            e.update({"status": "missing-pdf", "title": f"CAS{no} RAR 未找到"})
            st[no] = e
            return
        pdf = open(path, "rb").read()
        e.update({"url": "https://kjs.mof.gov.cn/zhengcefabu/200805/t20080522_33653.htm",
                  "title": os.path.splitext(os.path.basename(path))[0], "kind": "rar2006",
                  "pdf_url": "https://kjs.mof.gov.cn/zhengcefabu/200805/P020180807403307493109.rar"})
        md = mineru_markdown(pdf, f"cas{no}.pdf")
        lines = md_to_lines(md)
        doc_number = next((l for l in lines[:8] if DOC_NO.match(l)), "")
        e.update({"status": "fetched", "doc_number": doc_number, "body_lines": lines})
    # 质量门：乱码/超短正文如实进 quarantine
    if e["status"] == "fetched":
        body_chars = sum(len(l) for l in e["body_lines"])
        if looks_garbled(e["title"]) or body_chars < 400:
            e["status"] = "quarantine"
            e["body_chars"] = body_chars
            e["err"] = "garbled or empty body"
    st[no] = e
    if e["status"] == "fetched":
        body_chars = sum(len(l) for l in e["body_lines"])
        pages_out = {"title": e["title"], "doc_number": e.get("doc_number", ""),
                     "body_lines": e["body_lines"], "url": e["url"],
                     "fetched": time.strftime("%Y-%m-%d %H:%M:%S"),
                     "kind": "cas_mof", "cas_no": no}
        slug = page_slug(e["url"], e["title"])
        io.open(os.path.join(PAGES, f"cas{no:02d}__{slug}.json"), "w", encoding="utf-8", newline="\n").write(
            json.dumps(pages_out, ensure_ascii=False, indent=1))
        print(f"  [{no}] OK {e['title'][:30]} lines={len(e['body_lines'])} chars={body_chars}")


def cmd_fetch(limit=None):
    os.makedirs(PAGES, exist_ok=True)
    st = load_manifest()
    todo = [no for no in range(1, 43)
            if no in SINGLE_PAGES or no in RAR_2006_NUMBERS]
    todo = [no for no in todo if st.get(no, {}).get("status") not in ("fetched",)]
    if limit:
        todo = todo[:limit]
    print(f"[F fetch] 计划 {len([n for n in range(1,43) if n in SINGLE_PAGES or n in RAR_2006_NUMBERS])}"
          f" 已完成 {sum(1 for v in st.values() if v['status']=='fetched')} 本轮 todo={len(todo)}")
    for i, no in enumerate(todo, 1):
        print(f"[{i}/{len(todo)}] CAS{no} ...", flush=True)
        try:
            fetch_one(no, st)
        except Exception as ex:
            st[no] = {"cas_no": no, "status": "error", "err": str(ex)[:200]}
            print(f"  [{no}] ERROR {str(ex)[:120]}")
        save_manifest(st)
        time.sleep(DELAY)
    ok = sum(1 for v in st.values() if v["status"] == "fetched")
    bad = {k: v["status"] for k, v in st.items() if v["status"] not in ("fetched",)}
    print(f"[收口] fetched={ok}/{42} 其余={json.dumps(bad, ensure_ascii=False)}")


def safe_filename(title: str) -> str:
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "―", title).strip()
    return name[:80] or "untitled"


def cmd_build(out_dir=None):
    out = out_dir or os.path.join(RAW, "build-regulation")
    os.makedirs(out, exist_ok=True)
    written = 0
    for f in sorted(os.listdir(PAGES)):
        if not f.endswith(".json"):
            continue
        d = json.load(io.open(os.path.join(PAGES, f), encoding="utf-8"))
        fm = [
            "---",
            "type: regulation",
            f'title: {d["title"]}',
            "tags:",
            '  - "reg-nature:部门规章"',
            '  - "problem-type:法规原文"',
            f'  - "domain:企业会计准则"',
            "category: 会计",
            "source: mof",
            f'source_url: "{d["url"]}"',
            "issuer: 财政部",
            "promulgator: 财政部",
            "status: 现行有效",
            f'docNumber: "{d.get("doc_number", "")}"' if d.get("doc_number") else 'docNumber: ""',
            "related: []",
            "sources: []",
            "authority: supreme",
        ]
        body = [f"# {d['title']}"]
        if d.get("doc_number"):
            body += ["", d["doc_number"]]
        body += [""] + d["body_lines"]
        md = "---\n" + "\n".join(fm) + "\n---\n\n" + "\n".join(body).rstrip() + "\n"
        dest = os.path.join(out, safe_filename(d["title"]) + ".md")
        io.open(dest, "w", encoding="utf-8", newline="\n").write(md)
        written += 1
    print(f"built {written} pages -> {out}")


def cmd_status():
    st = load_manifest()
    fetched = sorted(k for k, v in st.items() if v["status"] == "fetched")
    print(f"fetched {len(fetched)}/42: {fetched}")
    for k, v in sorted(st.items()):
        if v["status"] != "fetched":
            print(f"  [{k}] {v['status']} {str(v.get('err',''))[:80]}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["status", "fetch", "build"])
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()
    {"status": cmd_status, "fetch": lambda: cmd_fetch(args.limit),
     "build": lambda: cmd_build(args.out)}[args.cmd]()
