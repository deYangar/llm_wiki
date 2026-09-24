"""分页拉全验证：
1. 以 limit=1000 逐页拉完全部节点（offset 步进到 total）
2. 节点拼接必须无重无漏（总条数 == total，id 序连续无重复）
3. 边并集必须无重复
4. 最后一页 hasMore=False；首页边 == 单页 limit=1000 请求的边（自洽）
"""
import json, sys, time, urllib.request

pid = sys.argv[1]
BASE = f"http://127.0.0.1:19828/api/v1/projects/{pid}"

def get(qs):
    with urllib.request.urlopen(f"{BASE}/graph?{qs}", timeout=120) as r:
        return json.loads(r.read())

full = get("limit=1000")
total = full['total']

got_ids, got_edges, offset, pages, last_has_more = [], [], 0, 0, None
while True:
    r = get(f"limit=1000&offset={offset}")
    assert r['offset'] == offset
    got_ids.extend(n['id'] for n in r['nodes'])
    got_edges.extend((e['source'], e['target']) for e in r['edges'])
    last_has_more = r['hasMore']
    offset += len(r['nodes'])
    pages += 1
    if not r['hasMore'] or not r['nodes']:
        break

ok_count = len(got_ids) == total == offset
ok_dup_nodes = len(set(got_ids)) == len(got_ids)
ok_dup_edges = len(set(got_edges)) == len(got_edges)
ok_last = last_has_more is False
full_edge_set = {(e['source'], e['target']) for e in full['edges']}
# 第一页（offset=0）的边应与单页 full 请求一致
r0 = get("limit=1000&offset=0")
first_page_edges = {(e['source'], e['target']) for e in r0['edges']}
ok_first = first_page_edges == full_edge_set

ok = all([ok_count, ok_dup_nodes, ok_dup_edges, ok_last, ok_first])
print(f"PAGINATE pages={pages} total={total} ids_ok={ok_count} "
      f"nodes_no_dup={ok_dup_nodes} edges_no_dup={ok_dup_edges} "
      f"last_hasMore_false={ok_last} first_page_selfconsistent={ok_first} "
      f"edges_total={len(got_edges)}")
print('PAGINATE', 'PASS' if ok else 'FAIL')
