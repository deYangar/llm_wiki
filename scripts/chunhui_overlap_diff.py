# -*- coding: utf-8 -*-
"""春晖批次与现库同名 32 条对比清单生成（R3 §九，2026-10-24）。

口径（咩咩未拍板前的默认）：overlap 跳过不入库，但出 diff 摘要供事后逐条
拍板。对比维度：frontmatter 关键字段 + 正文行数 + 正文头 30 行。

用法：
  python chunhui_overlap_diff.py [--build DIR] [--wiki DIR] [--out DIR]
"""
import argparse
import io
import json
import os
import re
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

RAW_DIR = r"C:/library/.data/chunhui-20261024"
DEFAULT_BUILD = os.path.join(RAW_DIR, "build-regulation")
DEFAULT_WIKI = r"C:/library/知识库/wiki"
DEFAULT_OUT = os.path.join(RAW_DIR, "overlap-32-diff")


def read_frontmatter(path: str) -> dict:
    """极简 frontmatter 抽取：只拿 title/status/issuer/publish_date/docNumber。"""
    try:
        head = io.open(path, encoding="utf-8").read(3000)
    except OSError:
        return {}
    m = re.search(r"^---\n(.*?)\n---", head, re.S)
    if not m:
        return {}
    block = m.group(1)
    out = {}
    for key in ("title", "status", "issuer", "promulgator", "publish_date", "docNumber", "category", "regulationType"):
        km = re.search(rf"^{key}:\s*(.+)$", block, re.M)
        if km:
            out[key] = km.group(1).strip().strip('"')
    return out


def body_lines(path: str) -> list[str]:
    try:
        text = io.open(path, encoding="utf-8").read()
    except OSError:
        return []
    m = re.search(r"^---\n.*?\n---\n(.*)$", text, re.S)
    body = m.group(1) if m else text
    return [l for l in body.split("\n") if l.strip()]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--build", default=DEFAULT_BUILD)
    ap.add_argument("--wiki", default=DEFAULT_WIKI)
    ap.add_argument("--out", default=DEFAULT_OUT)
    args = ap.parse_args()

    reg_dir = os.path.join(args.wiki, "regulation")
    existing = {}
    for f in os.listdir(reg_dir):
        if f.endswith(".md"):
            fm = read_frontmatter(os.path.join(reg_dir, f))
            if fm.get("title"):
                existing[fm["title"]] = f

    build_files = [f for f in os.listdir(args.build) if f.endswith(".md")]
    overlaps = []
    for bf in sorted(build_files):
        bpath = os.path.join(args.build, bf)
        bfm = read_frontmatter(bpath)
        btitle = bfm.get("title", "")
        if btitle in existing:
            efile = existing[btitle]
            epath = os.path.join(reg_dir, efile)
            efm = read_frontmatter(epath)
            ebody = body_lines(epath)
            bbody = body_lines(bpath)
            overlaps.append({
                "title": btitle,
                "existing_file": efile,
                "build_file": bf,
                "existing_fm": efm,
                "build_fm": bfm,
                "existing_body_lines": len(ebody),
                "build_body_lines": len(bbody),
                "existing_head": ebody[:30],
                "build_head": bbody[:30],
            })

    os.makedirs(args.out, exist_ok=True)
    manifest_path = os.path.join(args.out, "overlap-manifest.json")
    with io.open(manifest_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(overlaps, f, ensure_ascii=False, indent=2)

    # 人读摘要
    summary = os.path.join(args.out, "README.md")
    with io.open(summary, "w", encoding="utf-8", newline="\n") as f:
        f.write("# 春晖批次 × 现库同名 overlap 对比清单（{} 条）\n\n".format(len(overlaps)))
        f.write("口径：放量时这些页**跳过**（pages/write 撞 409），现库页一字不动。\n")
        f.write("处置待咩咩逐条拍板：看 diff 后定「保留现库 / 用春晖覆盖 / 合并」。\n\n")
        for i, o in enumerate(overlaps, 1):
            f.write(f"## {i}. {o['title']}\n\n")
            f.write(f"- 现库文件：`wiki/regulation/{o['existing_file']}`\n")
            f.write(f"- 春晖构建：`{o['build_file']}`\n")
            f.write(f"- 现库：status={o['existing_fm'].get('status','?')} issuer={o['existing_fm'].get('issuer','?')} "
                    f"publish_date={o['existing_fm'].get('publish_date','?')} docNumber={o['existing_fm'].get('docNumber','?')} "
                    f"正文 {o['existing_body_lines']} 行\n")
            f.write(f"- 春晖：status={o['build_fm'].get('status','?')} issuer={o['build_fm'].get('issuer','?')} "
                    f"publish_date={o['build_fm'].get('publish_date','?')} docNumber={o['build_fm'].get('docNumber','?')} "
                    f"正文 {o['build_body_lines']} 行\n")
            f.write(f"- source_url：{o['build_fm'].get('source_url','')}\n\n")
            f.write("**现库正文头**：\n```\n" + "\n".join(o["existing_head"][:8]) + "\n```\n\n")
            f.write("**春晖正文头**：\n```\n" + "\n".join(o["build_head"][:8]) + "\n```\n\n")
            f.write("---\n\n")

    print(f"overlap={len(overlaps)} -> {summary}")


if __name__ == "__main__":
    main()
