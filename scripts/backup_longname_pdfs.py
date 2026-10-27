# -*- coding: utf-8 -*-
"""补拷 MSYS tar 读不了的超长路径 PDF 到独立备份目录。"""
import shutil
import tarfile
from pathlib import Path, PureWindowsPath

TAR = Path("D:/backup/wiki-pre-reimport-20261027.tar")
ROOT = Path("C:/library/wiki/raw/sources")
DST = Path("D:/backup/wiki-pre-reimport-longnames")

tf = tarfile.open(TAR)
in_tar = {m.name.replace("wiki/raw/sources/", "") for m in tf
          if m.isfile() and "/raw/sources/" in m.name and m.name.endswith(".pdf")}

n = 0
for p in ROOT.rglob("*.pdf"):
    rel = str(p.relative_to(ROOT)).replace("\\", "/")
    if rel in in_tar:
        continue
    dst = DST / rel
    dst.parent.mkdir(parents=True, exist_ok=True)
    # 长路径源用 \\?\ 前缀；目标是短路径（D:\backup\... 前缀短）无需前缀
    src_long = "\\\\?\\" + str(p)
    shutil.copy2(src_long, str(dst))
    n += 1
    print("补", rel[-60:])
print("共补", n)
