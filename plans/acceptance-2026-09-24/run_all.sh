#!/bin/bash
# /graph 性能优化验收全套（性能门+正确性门+回归门）
set -u
export PROTOC="/c/Users/Yang/AppData/Local/Programs/protoc/bin/protoc.exe"
export PATH="/c/Users/Yang/.cargo/bin:$PATH"
cd /c/Users/Yang/.zcode/workspace/default/projects/llm-wiki/plans/acceptance-2026-09-24

BASE=http://127.0.0.1:19828/api/v1/projects
REG=7550634d-508e-475c-86cd-52f30c828101
CASE=283b69c0-157e-47a8-b1e3-f476d0735a7c

echo "=== [1/6] 停实例 + 重编 release + 重启 ==="
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='llm-wiki.exe'\" | Invoke-CimMethod -MethodName Terminate | Out-Null; Start-Sleep 2"
cd ../../src-tauri && cargo build --release 2>&1 | tail -1 && cd ../plans/acceptance-2026-09-24
powershell -NoProfile -Command "Start-Process -FilePath 'C:\Users\Yang\.zcode\workspace\default\projects\llm-wiki\src-tauri\target\release\llm-wiki.exe'"
for i in $(seq 1 30); do
  sleep 3
  v=$(curl -s -m 3 http://127.0.0.1:19828/api/v1/health 2>/dev/null)
  if [ -n "$v" ]; then echo "instance UP"; break; fi
done

echo "=== [2/6] 性能门：两库冷重算 + 5 次命中 ==="
for spec in "reg|$REG" "case|$CASE"; do
  name=$(echo $spec|cut -d'|' -f1); pid=$(echo $spec|cut -d'|' -f2)
  t=$(curl -s -o "final_${name}_cold.json" -w '%{time_total}' -m 300 "$BASE/$pid/graph?limit=1000")
  echo "PERF $name cold(process-first) ${t}s"
  hits=""
  for j in 1 2 3 4 5; do
    t2=$(curl -s -o /dev/null -w '%{time_total}' -m 60 "$BASE/$pid/graph?limit=1000")
    hits="$hits ${t2}"
  done
  echo "PERF $name hits:$hits"
done

echo "=== [3/6] 正确性门：同参数抓取 + 对比旧基线 ==="
curl -s -o final_reg_full.json -m 300 "$BASE/$REG/graph?limit=1000"
curl -s -o final_reg_concept.json -m 300 "$BASE/$REG/graph?nodeType=concept&limit=1000"
curl -s -o final_reg_q.json -m 300 "$BASE/$REG/graph?q=attention&limit=100"
curl -s -o final_case_full.json -m 300 "$BASE/$CASE/graph?limit=1000"
python compare.py

echo "=== [4/6] 分页拉全 = 全量（案例库，limit=137 切环） ==="
python paginate.py "$CASE"

echo "=== [5/6] 指纹失效：touch 后 TTL 过期应重算且图不变 ==="
python touch_invalidate.py "$REG"

echo "=== [6/6] 回归门：probe_graph_partitions + smoke_wiki ==="
cd /c/Users/Yang/.zcode/workspace/default/projects/ipoanswer
python scripts/probe_graph_partitions.py 2>&1 | tail -40
python scripts/smoke_wiki.py 2>&1 | tail -4

echo "=== ALL DONE ==="
