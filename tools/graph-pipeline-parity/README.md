# graph-pipeline-parity（§3.2 一次性对账工具）

前端建图从「全库逐文件读 ×2」换成「`wiki_graph_snapshot` 单次 invoke」后的
对账基建。**方案验收线：节点/边集合差异 ≤ 已知清单且逐条归因；归因不了的
差异不合并。**

## 组成

- `legacy/wiki-graph-legacy.ts`、`legacy/graph-relevance-legacy.ts`：
  退役前旧管线的逐字节存档（唯一改动是 import 指向 legacy 版
  graph-relevance）。新管线任何时刻需要重新对账，靠这两个文件跑。
- `parity.test.ts`：vitest 对账 runner。默认 skip（CI 永不跑），需要
  `LLM_WIKI_PARITY_LIB` 环境变量。
- `graph-snapshot-dump.json`：Rust 侧快照 dump（由下面的 ignored 测试
  产出，gitignore）。
- `parity-report.json`：对账报告产物（gitignore）。

## 跑法（库必须静止，无并发写入会话）

```bash
# 1. Rust 侧 dump 全图快照（同 invoke wiki_graph_snapshot 的字节内容）
export PROTOC="/c/Users/Yang/AppData/Local/Programs/protoc/bin/protoc.exe"
cd src-tauri
LLM_WIKI_PARITY_DUMP="C:/library/wiki" \
LLM_WIKI_PARITY_OUT="../tools/graph-pipeline-parity/graph-snapshot-dump.json" \
  cargo test --lib dump_graph_snapshot_for_parity -- --ignored
cd ..

# 2. Node 侧双管线对账
LLM_WIKI_PARITY_LIB="C:/library/wiki" npx vitest run tools/graph-pipeline-parity
```

产物 `parity-report.json`：双管线耗时、节点/边数量、仅旧有/仅新有的节点
与边清单、共享节点逐字段漂移计数。每个差异条目必须落进下面的已知漂移
桶，否则迁移被阻断。

## 已知漂移桶（归因清单）

1. **title 提取实现差异**：Rust `extract_title`（frontmatter → 首个
   `#` 标题 → 文件名去 `-` 换空格）vs 旧 TS `extractTitle`
   （parseFrontmatter → 正则标题 → 文件名）。fallback 触发页 label 可能
   不同。
2. **wikilink/related 提取差异**：Rust `extract_graph_links` 的手写扫描
   与 related frontmatter 归一化（`-` 代空格 + 小写已归一）vs TS 正则 +
   `targetAliases`。围栏内 `[[...]]`、畸形链接的收录范围可能不同。
3. **别名冲突 first-match 顺序语义**：Rust resolve_link 是 BTree 升序
   最小 id；旧 TS 是目录遍历序首个。同名/大小写混用冲突页归属可能不同
   ——**这条必须逐条人工归因**。
4. **sources 解析升级**：RetrievalGraph.sources 现在来自 Rust frontmatter
   完整解析（旧 TS 是正则简化版，只认块状/单行数组），sourceOverlap 权重
   允许有微小变化——已知改进差异，不回修。

另有结构性已知差异（不计入漂移）：新管线边集已剔除 query 邻接边、
linkCount 按「可见节点重算的入+出度」，与旧 TS 管线对可见节点的语义
一致、与 Rust 原始 linkCount 不一致（快照字段注释已注明）。

## 状态

- [ ] 对账报告已生成并逐条归因（**挂账**：等真库写入任务结束后跑）
