# 上游 v0.6.12 合并记录(2026-10-04)

## 0. 结论

- merge commit:`a9f3ac1`(本地 main,基于 1ca0dcc × 上游 48fd970)
- 单测:cargo test --lib 412 过 / 7 失败 = 本机预存基线(file_history 6 + fs 1),零新增
- 真实例验收:§4(数据待验收运行回填)

## 1. 上游 v0.6.12 概况(nashsu/**llm_wiki**,注意小写+下划线)

31 commit,106 文件,+5900/-732。主题:图谱 API 扩展(ff08988/b726bd1)、MCP verified
write(4ffe414)、ingest 中断恢复与图片源、research 落地、Claude CLI 错误诊断、前端加权图谱。

## 2. 关键决策

### 2.1 graph 区域整体保留本地实现

上游 ff08988 与 2026-09-24 本地优化同题异构,但:

| 维度 | 本地(9/24 实测) | 上游 0.6.12 |
|---|---|---|
| 缓存失效 | 全树指纹(顺序无关)+2s 信任窗 | TTL 5s 内盲返回旧快照 |
| 并发 | single-flight | 无(并发 miss 重复建图) |
| 解析 | rayon 并行 | 单线程 |
| 分页 | 零拷贝 slice | 每页 clone |
| 边分派 | min 端点跨页拉全 + edgesTruncated | edgeScope=page(页内边)/filtered |
| q 匹配 | id/label/path(9/24 有意增强,plan §81-82) | id/label |

性能上本地严格更强,且 ipoanswer 消费方绑定本地契约(total/edgesTruncated +
min 端点分页语义),故 graph 区取 ours。

### 2.2 吸收 b726bd1:related frontmatter 进图边

build_graph 链接提取 `extract_wikilinks` → `commands::search::extract_graph_links`
(正文 wikilinks + frontmatter related 内联数组/YAML 列表)。**图结构变化**:related
指向的页面成为图边,案例库关联面(1407 关联)首次进图。边数涨幅见 §4。

### 2.3 契约超集:totalCount 别名

上游内嵌 MCP 客户端(mcp-server/api-client.ts)读 `json.totalCount`,fallback 是
当前页节点数(不准确)。治本:GraphApiResponse 增 `total_count` 字段(serde
camelCase → `totalCount`),与 `total` 同值。ipoanswer(`total`)与上游 MCP
(`totalCount`)两侧生态都不改。上游 `edgeScope` 参数未实现(传了被忽略,行为 =
更全的 min 端点语义),如实披露。

### 2.4 agent/tools.rs 融合(两边功能并存)

- 本地 `ensure_frontmatter_opening` 封口(frontmatter 缺开头 --- 防线)
- 上游 `WIKI_WRITE_LOCK` 写锁、`atomic_replace_file`(原子替换,Windows backup
  策略)、写后回读校验 + 失败回滚、`write_wiki_page_verified`(MCP verified write)
- 顺序:拿锁 → 封口 → 校验大小/路径 → 原子替换 → 回读比对

### 2.5 未跟上游(如实披露)

- 上游 graph 实现本体(§2.1)
- `edgeScope` 参数(§2.3)
- GraphAliases stem/title 别名解析面:改变链接解析语义(边数会变),未实测,不做
  无验收的语义变更;需要时单独立项实测。

### 2.6 移植的非 graph 上游改动

- `POST /api/v1/projects/{id}/pages/write` 端点(4ffe414,MAX_PAGE_WRITE_BODY_BYTES
  = 6×2MiB+16KiB、token 门禁、body limit 分支)
- prepare_chat `allow_empty_retrieval = false` 防线(ba39c7c)
- handle_rescan 适配 rescan_project_files 新签名 +None(c80e802)
- handle_embed_page 删除 Conflict 分支(697ed61,上游删了该错误类型)

## 3. 冲突解决方式

merge-tree 预测冲突 3 文件(README.md / agent/tools.rs / api_server.rs),实测一致。
api_server.rs 逐 hunk 冲突全在 graph 区(6 块),但**自动合并**把上游 GRAPH_CACHE/
GraphAliases/上游测试静默留在文件里,逐 hunk 策略产出混合怪物 → 改用整文件取 ours
+ 手工移植 §2.6 清单。教训:**大区域同题异构时,别信 auto-merge 的静默部分**。

## 4. 真实例验收(19828)

### 4.1 合并前基线(10/2 dev exe,1ca0dcc,2026-10-04 采样)

| 库 | 节点 total | 全量边(翻页) | edgesTruncated |
|---|---|---|---|
| wiki(案例库 C:/library/wiki) | 16913 | 24693(17 页) | false |
| 知识库(C:/library/知识库) | 5530 | 9291(6 页) | false |

### 4.2 合并后(新 exe,2026-10-04 实测回填)

| 项 | 结果 |
|---|---|
| cargo test --lib | 412 过 / 7 失败 = 本机预存基线(file_history 6 + fs 1),零新增 |
| /health | ok |
| 节点对账 | wiki 16913 == 基线;知识库 5530 == 基线(related 只加边不加节点) |
| 边对账 | wiki 24693→34564(+9871);知识库 9291→13618(+4327) |
| totalCount 别名 | 与 total 同值,两库验证 |
| related 端到端 | 案例页「三瑞智能(深创业板IPO·2025)」57 条邻边,related 实体(好盈科技/低空经济/国泰海通/立信等)全部命中 |
| probe_wiki.py | health/search/graph 全 200;recursive 413 = 预期;chat 401 = 基线 token 门禁 |
| smoke_wiki.py | 47/50;3 失败(D4b/D5/D5b 向量链路)= 豆包 ark 订阅过期(见 §4.3) |
| probe_media.py | media 200+PNG magic / 越权 403 / graph 200 |

### 4.3 遗留:豆包 embedding 订阅过期(非本次引入)

服务端 stderr 实锤:`Embedding API HTTP 400 {"code":"InvalidSubscription",
"message":"Your account (2122458258) does not have a valid CodingPlan
subscription, or your subscription has expired"}`。query embedding 生成失败 →
向量分支静默降级为纯关键词(vectorHits=0,score 退化为词频量级)。smoke 的
D4b/D5/D5b 三个失败全部由该根因解释。**处置需咩咩续订火山引擎 CodingPlan 或
更换 embedding 端点**(凭据资产,代码侧不动)。

另观察一条基线既有行为(非本次引入):search 关键词扫描在 10000 个 md 文件处
截断(`[Search] stopped scanning wiki after 10000 markdown files`),案例库
16913 节点意味着关键词检索覆盖不全;/graph 不受影响。

### 4.4 验收过程中的坑(记录)

1. **安装版抢端口复发**:dev exe 起来后 3 分钟,安装版
   (`C:\Users\Yang\AppData\Local\LLM Wiki\llm-wiki.exe`)被外部拉起抢占 19828,
   导致第一轮对账拿到的是旧代码响应(totalCount=None、边数=基线)。识别信号:
   响应字段缺失 + 进程 ExecutablePath 核对。**验收前和验收中都要核对
   19828 归属进程的 exe 路径**。
2. tauri build 会写 `src-tauri/target/release/llm-wiki.exe`——正在运行的旧实例
   锁定该文件,构建前必须先停实例。

## 5. 部署状态

- 验收实例:src-tauri/target/release/llm-wiki.exe(即 10/2 起的现役 dev 实例位置,
  构建前已停旧进程释放文件锁,验收通过后新版原位顶上)
- 安装版覆盖(C:\Users\Yang\AppData\Local\LLM Wiki\)与推 fork:等咩咩拍板
