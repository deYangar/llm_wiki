# -*- coding: utf-8 -*-
"""春晖抓取产物 → regulation 页入库管道（R3 §九，2026-10-24）。

输入：chunhui_scraper.py 产物（manifest.jsonl + pages/*.json）
输出：wiki/regulation/<标题>.md（frontmatter 按 schema R3 扩展字段：
      category/source/source_url/issuer/publish_date/status + 库内既有
      docNumber/promulgator 惯例键）

用法：
  python chunhui_ingest.py build [--limit N] [--out DIR]   # 生成 md（默认全量到 out 目录）
  python chunhui_ingest.py dedup-check [--wiki DIR]        # 与现有库 title 对账

放量纪律（咩咩 10-12 铁律）：先 --limit 10 出样本 → 应用侧/frontmatter
解析验证通过 → 等放量指令再进真库。默认 out 是样本目录，真库入库必须
显式 --out 指向 <project>/wiki。
"""
import argparse
import io
import json
import os
import re
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

RAW_DIR = r"C:/library/.data/chunhui-20261024"
DEFAULT_OUT = os.path.join(RAW_DIR, "sample-regulation")

# 文号前缀 → 发布机构（ issuer/promulgator 零 LLM 推导）
ISSUER_BY_PREFIX = [
    ("财会", "财政部"), ("财金", "财政部"), ("财税", "财政部 国家税务总局"),
    ("财综", "财政部"), ("国税", "国家税务总局"), ("国家税务总局", "国家税务总局"),
    ("证监", "中国证监会"), ("会监", "中国证监会"),
    ("上证发", "上海证券交易所"), ("深证", "深圳证券交易所"), ("北证", "北京证券交易所"),
    ("股转", "全国中小企业股份转让系统"),
    ("银保监", "国家金融监督管理总局"), ("金规", "国家金融监督管理总局"),
    ("人民银行", "中国人民银行"), ("发改", "国家发展改革委"), ("国资", "国务院国资委"),
    ("工信部", "工业和信息化部"),
]
REG_NATURE = {
    "财政部": "部门规章", "财政部 国家税务总局": "部门规章",
    "国家税务总局": "部门规章", "中国证监会": "部门规章",
    "国家金融监督管理总局": "部门规章", "中国人民银行": "部门规章",
    "国家发展改革委": "部门规章", "国务院国资委": "部门规章",
    "工业和信息化部": "部门规章",
    "上海证券交易所": "交易所业务规则", "深圳证券交易所": "交易所业务规则",
    "北京证券交易所": "交易所业务规则", "全国中小企业股份转让系统": "交易所业务规则",
}


def yaml_scalar(value: str) -> str:
    value = value.strip()
    if not value or re.search(r"[:#\[\]{},\"']", value):
        return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return value


def derive_issuer(doc_number: str, body_lines: list[str], title: str = "") -> str:
    for prefix, issuer in ISSUER_BY_PREFIX:
        if doc_number.startswith(prefix):
            return issuer
    # 标题形态识别法律/行政法规（咩咩 10-24 拍板：法律→全国人大常委会、
    # 行政法规→国务院，不再笼统兜底「其他」）。落款「总理×」「国务院令第×号」
    # 是行政法规铁证，直接认定。
    head5 = "".join(body_lines[:5])
    if re.search(r"中华人民共和国.+法$", title):
        return "全国人大常委会"
    if (
        re.search(r"条例$|规定$|办法$", title)
        and re.search(r"总理|国务院令|中华人民共和国国务院", head5)
    ):
        return "国务院"
    # 正文落款（机构名独立行，常见于通知类）——取前 30 行里最后一个机构名行
    known = {issuer for _, issuer in ISSUER_BY_PREFIX} | {
        "最高人民法院", "最高人民检察院", "国务院", "中国证券登记结算有限责任公司",
        "全国人大常委会", "全国人民代表大会常务委员会",
    }
    for line in body_lines[:30]:
        line_s = line.replace(" ", "")
        if line_s in {k.replace(" ", "") for k in known}:
            return "全国人大常委会" if "人大常委会" in line_s else line_s
    return "其他"


def derive_publish_date(doc_number: str, body_lines: list[str]) -> str:
    # 文号年份兜底 + 正文「YYYY年M月D日」行（落款日期）
    for line in body_lines[:40]:
        m = re.search(r"(20\d{2})年(\d{1,2})月(\d{1,2})日", line)
        if m:
            return f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
    m = re.search(r"[〔\[]?(20\d{2})[〕\]]?", doc_number)
    return f"{m.group(1)}" if m else ""


def build_page(manifest_entry: dict, page: dict) -> str:
    issuer = derive_issuer(page.get("doc_number", ""), page.get("body_lines", []), page.get("title", ""))
    publish_date = derive_publish_date(page.get("doc_number", ""), page.get("body_lines", []))
    reg_nature = REG_NATURE.get(issuer, "部门规章")
    # 修订版消歧：旧版 status 已被替代 + related 指向现行版；现行版 related
    # 反向挂旧版（schema status 枚举：现行有效|已被替代|已废止|部分失效）
    status = manifest_entry["status"]
    related = []
    if page.get("superseded_by"):
        status = "已被替代"
        related.append(f"[[{page['superseded_by']}]]")
    if page.get("supersedes"):
        related.extend(f"[[{t}]]" for t in page["supersedes"])
    # 分片页（E-1 超大汇编）：part_no/total_parts 簿记 + 相邻片互链
    if page.get("total_parts"):
        related.extend(f"[[{p}]]" for p in page.pop("_sibling_links", []))
    # 去重保序：同组同年份的版本标题会重复（公司法 1993 两条都生成
    # 「（1993年版）」，2026-10-24 实测 related 出现重复 wikilink）
    seen = set()
    related = [r for r in related if not (r in seen or seen.add(r))]
    fm = [
        "type: regulation",
        f"title: {yaml_scalar(page['title'])}",
        "tags:",
        f'  - "reg-nature:{reg_nature}"',
        f'  - "problem-type:法规原文"',
        f"category: {manifest_entry['category']}",
        "source: chunhui",
        f"source_url: {yaml_scalar(page['url'])}",
        f"issuer: {yaml_scalar(issuer)}",
        f"promulgator: {yaml_scalar(issuer)}",
        f"status: {status}",
    ]
    if page.get("doc_number"):
        fm.append(f"docNumber: {yaml_scalar(page['doc_number'])}")
    if publish_date:
        fm.append(f"publish_date: {publish_date}")
    if page.get("part_no"):
        fm.append(f"part_no: \"{page['part_no']}\"")
    if page.get("total_parts"):
        fm.append(f"total_parts: \"{page['total_parts']}\"")
    if related:
        fm.append("related:")
        fm.extend(f'  - "{r}"' for r in related)
    else:
        fm.append("related: []")
    fm.append("sources: []")
    body = [f"# {page['title']}"]
    if page.get("doc_number"):
        body.append("")
        body.append(page["doc_number"])
    body.append("")
    body.extend(page.get("body_lines", []))
    return "---\n" + "\n".join(fm) + "\n---\n\n" + "\n".join(body).rstrip() + "\n"


# E-1 超大页分片三重上限（方案 2026-10-26 模块E：字节数给 pages/write 上限
# 留余量、字符数保 embed <512 chunk、行数兜底）
# PART_MAX_CHARS 实测修正（2026-10-27）：语义切块按行/句边界断，PDF 转文本
# 行均 ~24 字符时实际 ~788 字符/chunk（非 1000 字符假设），40 万字符/片实测
# 528-530 chunks 超 512 上限（E-1 首推 12 片 embed 全 400）。降到 36 万：
# ~476 chunks，留 7% 余量。
PART_MAX_BYTES = 10 * 1024 * 1024
PART_MAX_CHARS = 360_000
PART_MAX_LINES = 20_000
CN_NUM = "一二三四五六七八九十百千万零"

SECTION_ANCHOR = re.compile(
    r"^(?:#{1,2}\s+\S|第[" + CN_NUM + r"0-9]{1,6}[章节部分编]|[" + CN_NUM + r"]{1,4}、\s*\S)"
)


def _part_measured(lines: list[str]) -> tuple[int, int]:
    total = 0
    for l in lines:
        total += len(l.encode("utf-8")) + 1
    return total, sum(len(l) for l in lines)


def split_oversized(page: dict, anchor_pat=SECTION_ANCHOR) -> list[dict]:
    """超大页分片（模块 E-1）：优先 H1/H2/「第X章」节锚切段，贪心装片到
    三重上限内；无锚可切时退固定行数窗口。返回多片 page dict（title 加
    （第N部分）、part_no/total_parts/相邻互链），调用方逐片出 md。"""
    lines = page.get("body_lines", [])
    data, chars = _part_measured(lines)
    if data <= PART_MAX_BYTES and chars <= PART_MAX_CHARS and len(lines) <= PART_MAX_LINES:
        return [page]
    # 1. 按节锚切段（锚行起段）
    segments: list[list[str]] = []
    cur: list[str] = []
    for line in lines:
        if cur and anchor_pat.match(line.strip()):
            segments.append(cur)
            cur = []
        cur.append(line)
    if cur:
        segments.append(cur)
    # 2. 贪心装片（锚段不可拆；单片超限的锚段退固定行数窗口再切）
    parts: list[list[str]] = []
    buf: list[str] = []
    buf_bytes = buf_chars = 0
    def flush():
        nonlocal buf, buf_bytes, buf_chars
        if buf:
            parts.append(buf)
            buf, buf_bytes, buf_chars = [], 0, 0
    for seg in segments:
        seg_b, seg_c = _part_measured(seg)
        if (seg_b > PART_MAX_BYTES or seg_c > PART_MAX_CHARS or len(seg) > PART_MAX_LINES):
            flush()
            # 固定行数窗口硬切
            for i in range(0, len(seg), PART_MAX_LINES):
                chunk = seg[i:i + PART_MAX_LINES]
                parts.append(chunk)
            continue
        if buf_bytes + seg_b > PART_MAX_BYTES or buf_chars + seg_c > PART_MAX_CHARS or len(buf) + len(seg) > PART_MAX_LINES:
            flush()
        buf.extend(seg)
        buf_bytes += seg_b
        buf_chars += seg_c
    flush()
    # 3. 构造分片 page（title 后缀 + 相邻互链）
    total = len(parts)
    out = []
    base_title = page["title"]
    for n, part in enumerate(parts, 1):
        p = dict(page)
        p["title"] = f"{base_title}（第{'一二三四五六七八九十'[min(n,10)-1]}部分）" if n <= 10 else f"{base_title}（第{n}部分）"
        p["part_no"] = str(n)
        p["total_parts"] = str(total)
        siblings = []
        if n > 1:
            siblings.append(f"{base_title}（第{'一二三四五六七八九十'[min(n-1,10)-1]}部分）" if n-1 <= 10 else f"{base_title}（第{n-1}部分）")
        if n < total:
            siblings.append(f"{base_title}（第{'一二三四五六七八九十'[min(n+1,10)-1]}部分）" if n+1 <= 10 else f"{base_title}（第{n+1}部分）")
        p["_sibling_links"] = siblings
        p["body_lines"] = part
        out.append(p)
    return out


def safe_filename(title: str) -> str:
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "―", title).strip()
    return name[:80] or "untitled"


def looks_garbled(title: str) -> bool:
    """GBK 解码坏页的标题混大量控制符/生僻乱字——可打印常用字符占比过低
    即判定乱码，跳过入库（如实进 skipped 清单，不硬造）。
    字符域必须含 safe_filename 的替换符 ―，否则乱码标题经替换后反而
    「达标」漏网（2026-10-24 实测 11 个乱码文件名混进样本目录的教训）。"""
    if not title:
        return True
    clean = re.sub(r"[\x00-\x1f\x7f]", "", title)
    if len(clean) < max(4, len(title) * 0.7):
        return True
    # 常用域：中日文/字母/数字/常用标点/文件名替换符
    common = re.findall(r"[\u4e00-\u9fffA-Za-z0-9（）〔〕【】《》〈〉——、，。；：！？·\-\s―%／]", clean)
    return len(common) < len(clean) * 0.85


def doc_year(page: dict) -> int:
    """版本新旧排序键。优先级：正文「YYYY年修订/修正」 > 文号年份 >
    落款日期年份 > url 年份。修订年必须优先，否则原版与修订版同取
    文号年导致消歧撞车（2026-10-24 实测环境保护法 1989 原版 vs
    2014 修订版都取 1989 互相覆盖的教训）。"""
    head = "\n".join(page.get("body_lines", [])[:3])
    m = re.search(r"(20\d{2}|19\d{2})\s*年\s*\d{0,2}\s*月?\s*\d{0,2}\s*日?\s*第?.*?修[订正]", head)
    if m:
        return int(m.group(1))
    m = re.search(r"[〔\[]?(20\d{2}|19\d{2})[〕\]]?", page.get("doc_number", ""))
    if m:
        return int(m.group(1))
    body = "\n".join(page.get("body_lines", [])[:40])
    m = re.search(r"(20\d{2}|19\d{2})年\d{1,2}月\d{1,2}日", body)
    if m:
        return int(m.group(1))
    m = re.search(r"/fagui/(\d{4})/", page.get("url", ""))
    return int(m.group(1)) if m else 0


def cmd_build(limit, out):
    manifest = [json.loads(l) for l in io.open(os.path.join(RAW_DIR, "manifest.jsonl"), encoding="utf-8")]
    by_url = {e["url"]: e for e in manifest}
    pages_dir = os.path.join(RAW_DIR, "pages")
    os.makedirs(out, exist_ok=True)
    # 第一遍：全量载入+清洗+按标题分组（同名修订版消歧的前置）
    candidates = []
    garbled = []
    for fname in sorted(os.listdir(pages_dir)):
        if not fname.endswith(".json"):
            continue
        page = json.load(io.open(os.path.join(pages_dir, fname), encoding="utf-8"))
        entry = by_url.get(page["url"])
        if not entry or entry["status"] != "现行有效":
            continue
        title = page["title"]
        # 标题一律以 manifest 列表页为准（人工目录标题，最可靠）：详情页
        # 封面形态太杂（落款机构/日期/正文首句都可能占标题位），2026-10-24
        # 实测前 12 页 7 页详情页标题与目录不符。详情页只提供文号与正文。
        # 仅当 manifest 标题本身乱码时才考虑详情页标题，双双乱码才丢弃。
        fallback = re.sub(r"&nbsp;|&#160;", " ", entry["title"])
        fallback = re.sub(r"\s+", " ", fallback).strip()
        if not looks_garbled(fallback):
            if fallback != title:
                page = dict(page, title=fallback)
                title = fallback
        elif looks_garbled(title) and looks_garbled(
            " ".join(page.get("body_lines", [])[:3])
        ):
            garbled.append(fname)
            continue
        page = dict(
            page,
            body_lines=[
                re.sub(r"&nbsp;|&#160;", " ", l) for l in page.get("body_lines", [])
            ],
        )
        candidates.append((entry, page))
    # 同名分组：同 title 多条 = 修订版家族，按文号年份排序，最新版拿主
    # 文件名+现行有效，旧版加（YYYY年版）后缀+已被替代+互链（咩咩 10-24
    # 口径：修订版全入库，审计追溯需要历史版本）。同组同年仍撞时按正文
    # 行数再分（长版主版、短版加（节选）），仍撞再加 url slug 后缀。
    by_title = {}
    for entry, page in candidates:
        by_title.setdefault(page["title"], []).append((entry, page))
    written = []
    versioned = 0
    for title, group in by_title.items():
        group.sort(key=lambda ep: (doc_year(ep[1]), len(ep[1].get("body_lines", []))))
        n = len(group)
        used_names = set()
        for idx, (entry, page) in enumerate(group):
            is_latest = idx == n - 1
            new_title = title
            if n > 1:
                year = doc_year(page)
                if not is_latest:
                    new_title = f"{title}（{year}年版）" if year else f"{title}（第{idx + 1}版）"
                # 同年撞车兜底：新名与已用名冲突时，短版加（节选），再撞加 slug
                if new_title in used_names or (is_latest and new_title in used_names):
                    slug = entry["url"].rsplit("/", 1)[-1].replace(".htm", "")
                    new_title = f"{new_title}（{slug}）"
                versioned += 1
            used_names.add(new_title)
            page = dict(page, title=new_title)
            if n > 1 and not is_latest:
                page["superseded_by"] = title
            elif n > 1 and is_latest:
                page["supersedes"] = [
                    (f"{title}（{doc_year(p)}年版）" if doc_year(p) else f"{title}（第{i + 1}版）")
                    for i, (_, p) in enumerate(group[:-1])
                ]
            # E-1 超大页分片：超三重上限才切（正常页原样返回），每片独立
            # 成页（title（第N部分）+ part_no/total_parts + 相邻互链）
            for part_page in split_oversized(page):
                md = build_page(entry, part_page)
                dest = os.path.join(out, safe_filename(part_page["title"]) + ".md")
                io.open(dest, "w", encoding="utf-8", newline="\n").write(md)
                written.append(dest)
            if limit is not None and len(written) >= limit:
                break
        if limit is not None and len(written) >= limit:
            break
    print(f"built {len(written)} pages (revision families versioned: {versioned}, garbled skipped: {len(garbled)}) -> {out}")
    for g in garbled[:10]:
        print("  garbled:", g)


def cmd_dedup_check(wiki_dir):
    manifest = [json.loads(l) for l in io.open(os.path.join(RAW_DIR, "manifest.jsonl"), encoding="utf-8")]
    existing = {}
    reg_dir = os.path.join(wiki_dir, "regulation")
    for f in os.listdir(reg_dir) if os.path.isdir(reg_dir) else []:
        if not f.endswith(".md"):
            continue
        head = io.open(os.path.join(reg_dir, f), encoding="utf-8").read(4000)
        m = re.search(r"^title:\s*(.+)$", head, re.M)
        if m:
            title = m.group(1).strip().strip('"')
            existing[title] = f
    valid = [e for e in manifest if e["status"] == "现行有效"]
    overlap = [e for e in valid if e["title"] in existing]
    print(f"chunhui valid={len(valid)} existing regulation pages={len(existing)} overlap={len(overlap)}")
    for e in overlap[:10]:
        print("  overlap:", e["title"][:50])


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["build", "dedup-check"])
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--wiki", default=r"C:/library/知识库/wiki")
    args = ap.parse_args()
    if args.cmd == "build":
        cmd_build(args.limit, args.out)
    else:
        cmd_dedup_check(args.wiki)
