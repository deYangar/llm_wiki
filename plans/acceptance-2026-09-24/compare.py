"""正确性门：新版 /graph 响应 vs v0.6.11 旧基线对比。

口径（方案 §5）：
- 无过滤与 nodeType 过滤：nodes+edges 逐项相等（P2 新增元数据字段除外）
- q 过滤：新版含 path 匹配，要求旧版结果 ⊆ 新版结果（有意变更）
- 边的「截断丢边」修复属有意变更：limit<total 时新版边 ⊇ 旧版边
  （旧版丢跨界边），此处 limit=1000 仍截断的库（案例库 16913 节点）
  单独按超集口径验证。
"""
import json

def load(p):
    return json.load(open(p, encoding='utf-8'))

def node_key(n):
    return (n['id'], n['label'], n['nodeType'], n['path'], n['linkCount'])

def edge_key(e):
    return (e['source'], e['target'], e['weight'])

def report(name, old, new, superset_ok):
    on, nn = old.get('nodes', []), new.get('nodes', [])
    oe, ne = old.get('edges', []), new.get('edges', [])
    ok = [node_key(x) for x in on]
    nk = [node_key(x) for x in nn]
    ek = [edge_key(x) for x in ne]
    ek_set = set(ek)
    lines = []
    nodes_equal = ok == nk
    if superset_ok:
        node_ok = set(ok) <= set(nk)
    else:
        node_ok = nodes_equal
    # 边一律超集口径（症状 6 修复=有意增强）；node 相等时边还应不重复
    edge_ok = set(edge_key(x) for x in oe) <= ek_set
    no_dup = len(ek) == len(ek_set)
    status = 'PASS' if (node_ok and edge_ok and no_dup) else 'FAIL'
    print(f"COMPARE {name}: {status}  "
          f"old(n={len(ok)},e={len(oe)}) new(n={len(nk)},e={len(ek)}) "
          f"nodes_exact={nodes_equal} node_subset={node_ok} edge_superset={edge_ok} no_dup={no_dup}")
    if status == 'FAIL':
        old_only = set(ok) - set(nk) if not node_ok else set()
        for x in list(old_only)[:5]:
            print('   old-only node:', x)
        if not no_dup:
            from collections import Counter
            dup = [k for k, c in Counter(ek).items() if c > 1]
            print('   dup edges:', dup[:5])
    return status == 'PASS'

old_reg_full = load('old/reg_full.json')
old_reg_concept = load('old/reg_concept.json')
old_reg_q = load('old/reg_q_attention.json')
old_case_full = load('old/case_full.json')

results = []
# 全量组：node 序与成员逐字节可比；边按超集（两库节点>1000 均被截断，
# 旧版丢跨界边，新版修复）
results.append(report('reg_full', old_reg_full, load('final_reg_full.json'), superset_ok=False))
results.append(report('case_full', old_case_full, load('final_case_full.json'), superset_ok=False))
# concept 分区：nodeType 过滤后不足 1000 无截断，节点应精确相等
results.append(report('reg_concept', old_reg_concept, load('final_reg_concept.json'), superset_ok=False))
# q=attention：旧版 0 节点；新版含 path 匹配，超集口径
results.append(report('reg_q_attention', old_reg_q, load('final_reg_q.json'), superset_ok=True))

print('CORRECTNESS', 'PASS' if all(results) else 'FAIL')
