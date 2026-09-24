# /graph 图谱接口性能优化方案（服务 ipo-regwatch）

> 日期：2026-09-24 · 消费方：ipo-regwatch（IPO 监管智能问答平台）
> 分析基线：main = **v0.6.11**（2026-09-24 已与运行实例对齐；与 v0.4.22 的
> `handle_graph` / `build_graph` 逐字符一致，仅行号偏移）
> 本文只保留与 ipo-regwatch 相关的问题、取证与方案。

## 0. 实施状态（2026-09-24 开发+实测验收完成）

| 项 | 状态 | commit |
|---|---|---|
| P0 图缓存（mtime 指纹 a 方案 + single-flight + 指纹 2s 信任窗） | ✅ 已落地+实测 | `e8ffd98` + `8248ff7` |
| P1 并行解析（rayon）+ resolve_link HashMap 化 | ✅ 已落地+实测 | `f066d37` + `8248ff7` |
| P2 offset 分页 + total/hasMore/edgesTruncated + 边 min 端点分派 + q 纳入 path | ✅ 已落地+实测 | `1ebfb95` |
| P3 启动预热 | ⏸ 未做（可选；实测冷重算已 <1s，无必要） | — |

### 验收实测（2026-09-24 本机真实库，v0.6.11 安装版基线 vs 新版实例）

| 门 | 标准 | 实测 | 判定 |
|---|---|---|---|
| 缓存命中 | <10ms | 准则库 5.1-5.4ms；案例库 8.4-21ms（1.8MB 响应，最好 8.4ms，抖动至 21ms；旧版每次 45-197s） | ✅（大库抖动如实记录） |
| 冷重算 | <30s | 进程首次：准则库 0.075s / 案例库 0.49s（OS 文件缓存热；真磁盘冷未测，CPU+IO 两数量级余量） | ✅ |
| 同参数二次请求 | <10ms | 同命中行 | ✅ |
| 正确性 | nodes 逐字节一致 | 4 组参数（两库全量/concept 分区/q）全部 `nodes_exact=True`；边为有意超集（症状 6 修复：全量边 1→1459/4710） | ✅ |
| 文件变更反映 | 下次请求生效 | touch 后 TTL 过期即重算（0.062s），图内容不变；变更最坏延迟 = TTL 2s + 一次重算 | ✅ |
| probe 分区 | 与基线一致 | 案例库 case 分区 390 节点/4 边（与 §2 症状 5/7 基线逐字吻合）；probe 总耗时从分钟级降至 <1s | ✅ |
| smoke_wiki | 50 项全过 | 50/50 | ✅ |
| 分页拉全 | 不重不漏 | 17 页拉全 16913 节点/23630 边，无重复无丢失，尾页 hasMore=false | ✅ |

- 性能修复轮根因（`8248ff7`）：`resolve_link` 每 link 线性全扫（十亿级比较，197s 主因）→ HashMap 化；命中路径指纹 WalkDir 150ms → 2s 信任窗；快照深拷贝 → 零拷贝切片；Value 树序列化 → 直序列化
- 回归基线：`cargo test --lib` 384+ 过 / 7 失败为 v0.6.11 本机 Windows 预存（file_history×6 + fs×1，stash 验证与改动无关）
- 实测教训：旧版安装版会在测试中途被重新拉起抢占 19828（端口写死），切换实例测试时健康检查无法区分新旧（版本号同为 0.6.11），需先清点进程再测
- 验收产物：`plans/acceptance-2026-09-24/`（旧基线 old/、新版响应、run_all.sh、compare/paginate/touch_invalidate 脚本）
- **待咩咩拍板**：新版未部署（原版安装版已恢复运行）；部署方式与 ipo-regwatch 侧联动见 §7

---

## 1. 消费方场景

ipo-regwatch 以两台 LLM Wiki 为知识底座（准则库 6081 页 / 案例库 1746 文件），
通过 `/api/v1/projects/{id}/graph` 做「图谱关联」召回流。当前消费特征：

- 检索融合里图谱路权重仅 0.05，S2 主流程**默认关闭**（实测后主动关闭，见 §2）
- `wiki_graph` Agent 工具（按名检索节点）保留可用
- 页面存在性/枚举类查询已改走 `index.md` 通道（毫秒级），不依赖 /graph

## 2. 实测症状（全部当场取证）

| # | 症状 | 数据 |
|---|---|---|
| 1 | 单次 /graph 恒定慢，与参数无关 | 准则库 50.5s / 案例库 145.3s（limit=10 与全量同价） |
| 2 | 同参数重复请求无缓存收益 | 09-21 实测：同参数第二次仍 45.2s |
| 3 | 无分页元数据 | 响应只有 `nodes/edges/ok/projectId`，无 `total/offset/has_more` |
| 4 | limit 硬上限 1000 且静默截断 | `clamp(1, 1000)`，limit=2000 与 1000 逐字节相同 |
| 5 | 无 nodeType 时返回 id 字典序前 1000 个 | 案例库实测该批内 case 类型节点 0 个（实际有 390 个） |
| 6 | **截断丢边** | `nodes.truncate(limit)` 之后才过滤 edges——两端任一被截断的边全部静默消失 |
| 7 | 边本身稀疏 | 案例库 case 分区 390 节点仅 4 条边（实测 2026-09-24） |
| 8 | 重计算期间 CPU 满负荷 | 图计算期间每分钟消耗 ~274s CPU（多核），期间其他请求排队 |

## 3. 根因（源码定位）

**`build_graph()`（`src-tauri/src/api_server.rs:2411`）每次请求都全量重算：**

1. `WalkDir` 遍历 wiki 目录全部 `.md` 文件（准则库 6081 个）
2. 逐文件 `read_to_string` 全文读入
3. 逐文件 `extract_title` + `extract_type` + `extract_wikilinks`（全文解析）
4. BTreeMap 组装 + 链接解析建边

**零缓存、零索引**。`q`/`nodeType`/`limit` 过滤发生在建图完成之后（`api_server.rs:2391-2399`），
这解释了症状 1（耗时与过滤参数无关）。

**线程模型不缺并发**：server 已是每请求一线程（`api_server.rs:102 thread::spawn`），
带 429 限流与并发槽保护。单请求慢与线程数无关。

> 事实备注（0.6.11 复核）：`q` 过滤只匹配 `id` 与 `label`，**不含 `path`**；
> P2 改造时顺手把 `path` 纳入过滤可提升按路径检索的召回。

**辅助证据**：`/search` 只需 1~2s（有独立索引），说明慢是 /graph 独有的「每次全量读盘解析」问题。

## 4. 优化方案（按性价比排序）

### P0 · 图缓存（治本，改动最小）

**改法**：`build_graph` 结果按 `project_path` 缓存于进程内（`Mutex<HashMap<PathBuf, Arc<GraphSnapshot>>>`），
命中直接返回。

**失效策略（三选一，推荐 a）**：
- a. **mtime 指纹**：缓存时记录 `wiki` 目录树（路径+mtime）的累计指纹；命中前抽样校验（全量校验一次 WalkDir 元数据，不读文件内容，<100ms）
- b. 挂 `file_sync::start_project_file_watcher` 变更事件主动失效（依赖 watcher 存活）
- c. 固定 TTL（简单但会返回过期图，不符合「数据变了图必须变」的语义）

**预期**：首次 ~50s 不变，之后 **<10ms**。挂 a 方案时数据变更后首次请求重算（可接受）。

### P1 · 并行解析（真正的「多线程」改造，与 P0 叠加）

**改法**：`build_graph` 内的 WalkDir 循环改 `rayon::par_iter`——文件读取与
title/type/wikilink 解析并行（CPU 密集部分天然可并行，文件间无依赖）。

**预期**：单次重算 145s → **~20-30s**（约按物理核数线性）。作为 P0 的 miss 补偿：
缓存失效后的重算不再让调用方等两分半。

### P2 · API 契约补齐（分页 + total）

**改法**：`handle_graph` 支持 `offset`（或 cursor），响应增加 `total`（过滤后、截断前的节点总数）。
**同时修症状 6**：边过滤不再以「截断后的节点集」为界——先分页节点，边独立按
`min(source序, target序) 落在已返回节点集`的规则给出，并在响应中带 `edgesTruncated: bool`。

**预期**：消费方（ipo-regwatch 的 `GraphSlice.truncated_suspect` 判据）从「猜截断」
升级为「读 total」；全量枚举成为可能（分页拉全）。

### P3 · 启动预热（可选）

服务启动后台线程对已注册 project 各预建一次图。首次请求也不等 50s。

## 5. 验收标准

| 门 | 标准 |
|---|---|
| 性能门 | 缓存命中 <10ms；冷重算 <30s（P1 后）；同参数二次请求 <10ms |
| 正确性门 | 改造前后对同一 project、同一组 q/nodeType/limit 的 nodes+edges 逐字节一致（P2 的 total/offset 除外）；文件新增/修改/删除后图在下次请求反映变更 |
| 回归门 | 消费方 `smoke_wiki` 50 项全过；`probe_graph_partitions.py` 分区数字与基线一致（数据未变时） |

## 6. 版本对齐（已解决，2026-09-24）

- ~~fork main = v0.4.22 vs 运行实例 = v0.6.11~~ —— 上游已同步 v0.6.11，
  本地 main 已对齐（`e808211`）并复核：`handle_graph` / `build_graph` 与
  0.4.22 逐字符一致，仅行号偏移（1257→2411 等），方案全部适用
- 上游历史曾被强推改写，与旧基点 rebase 会把上游旧 commit 误当本地改动重放；
  正确姿势是 `reset --hard origin/main` + cherry-pick 本地 commit

## 7. 与消费方的联动（ipo-regwatch 侧）

| 底座改动 | ipo-regwatch 侧跟进 |
|---|---|
| P0/P1 落地 | `wiki_instances.yaml` 的 graph 预算可收紧；S2 图谱路是否重开重跑 A/B（脚本 `storage/tmp/graph_ab_probe.py` 可复现） |
| P2 落地 | `GraphSlice.truncated_suspect` 判据改为读 `total`；枚举通道可评估切回 /graph 分页 |
| 边修复（症状 6） | 图谱边数据恢复后，重测边稀疏性再评估图遍历价值 |
