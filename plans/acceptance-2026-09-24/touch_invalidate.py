"""指纹失效实测：
1. 预热（进程内缓存）
2. sleep 过 TTL 后请求：应做指纹重校验（耗时 ≈ WalkDir 元数据，几十 ms）且命中
3. touch 一个 md（只改 mtime 不改内容）
4. sleep 过 TTL 后请求：指纹不一致 → 全量重算（耗时显著高于命中）且图内容不变
"""
import json, os, sys, time, urllib.request

reg_pid = sys.argv[1]
BASE = f"http://127.0.0.1:19828/api/v1/projects/{reg_pid}"

def get():
    t0 = time.monotonic()
    with urllib.request.urlopen(f"{BASE}/graph?limit=1000", timeout=300) as r:
        d = json.loads(r.read())
    return d, time.monotonic() - t0

before, t_warm = get()                       # build + cache
time.sleep(3)
mid, t_recheck = get()                       # TTL 过期 → 指纹校验命中（几十 ms 级）
assert mid['total'] == before['total']

target = r"C:\library\知识库\wiki\index.md"
os.utime(target)                             # 只改 mtime
time.sleep(3)                                # 等 TTL 过期，下一请求必须重校验
after_touch, t_rebuild = get()               # 指纹不一致 → 重算
time.sleep(3)
post, t_post = get()                         # 又回到命中态

same = (after_touch['total'] == before['total']
        and [(n['id'], n['label']) for n in after_touch['nodes']] == [(n['id'], n['label']) for n in before['nodes']]
        and {(e['source'], e['target']) for e in after_touch['edges']} == {(e['source'], e['target']) for e in before['edges']})
ok = same and t_rebuild > 3 * t_post and t_recheck > t_post
print(f"INVALIDATE warm={t_warm:.3f}s ttl-expired-fingerprint-recheck={t_recheck:.3f}s "
      f"after-touch-rebuild={t_rebuild:.3f}s post-hit={t_post:.3f}s graph_unchanged={same}")
print('INVALIDATE', 'PASS' if ok else 'FAIL')
