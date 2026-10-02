# llm-wiki 媒体端点方案（GET /media，2026-09-30）

> 配套方案：`projects/ipoanswer/docs/方案-原文图片与生产栈切换-20260930.md`（消费方侧）。
> 本仓改动 = 本方案；部署目标为 guaji 机安装版实例（127.0.0.1:19828）。

## 0. 背景与问题（实测证据）

ipoanswer `/source` 原文页图片全破。全库统计（cases 库）：

- **1557 个页面、75378 处图片引用**，全部为 `![VLM描述](../media/<文档目录>/img-N.png)` 形态
  （png 21133 / jpg 54245，无 svg、无外链、无 HTML `<img>`）；
- 磁盘目标文件 **零缺失**（`wiki/media/<文档目录>/img-N.png` 全部存在，与页面 `wiki/sources/<文档目录>.md` 一一对应）；
- 图片不是丢了，是**没有任何服务通道**：
  - `GET /files/content?path=wiki/media/…/img-1.png` → **415** `Only text-like project files can be read via this endpoint`（`is_text_content_rel` 白名单只放行 md/txt/json 等文本扩展，`api_server.rs:1043`）；
  - 库根 `media/…` → **403** `Path is not exposed by the local API`（`is_public_project_rel`，`api_server.rs:1028`）；
  - 底座 HTTP API 无任何二进制/媒体端点。

正文引用 `wiki/media/**` 却读不出其字节，是 API 服务的能力缺口 —— 本方案在协议层补齐。

## 1. 目标与非目标

**目标**：新增 `GET /api/v1/projects/{id}/media?path=<rel>`，受控返回图片二进制。

**非目标**：

- 不做写、不做删除（媒体是导入产物，只读）；
- 不做 Range 请求（浏览器 `<img>` 整图加载，无此需求）；
- 不做缩略图/转码（字节原样透传）；
- 不暴露 `raw/assets/`（与现有公开面 `wiki/` + `raw/sources/` 一致，不扩边界）。

## 2. 端点设计

### 路由与参数

```
GET /api/v1/projects/{projectId}/media?path=wiki/media/<文档目录>/img-N.png
→ 200 image/png <bytes>
```

### 校验链（顺序即代码顺序，全部复用现有构件）

| # | 校验 | 复用/新增 | 失败形态 |
|---|---|---|---|
| 1 | project 解析 | `resolve_project` | 404（与现有一致） |
| 2 | path 必填 | `parse_query` | 400 `Missing path query parameter` |
| 3 | 公开路径白名单 | 复用 `is_public_project_rel`（`wiki/` 前缀已放行） | 403 `Path is not exposed by the local API` |
| 4 | **媒体路径收紧**：归一后必须以 `wiki/media/` 开头 | 新增 `is_media_rel(rel)` | 403 同上（不暴露新错误语义） |
| 5 | **图片扩展白名单**：`png / jpg / jpeg / gif / webp` | 新增 `MEDIA_EXT` 常量 | 415 `Only image files can be served via this endpoint` |
| 6 | 防逃逸 | 复用 `safe_join` | 400（与现有一致） |
| 7 | 存在性 | `fs::metadata` | 404 `File not found` |
| 8 | 大小上限 | 新增 `MAX_MEDIA_BYTES = 32MB`（实测库内最大单图 <5MB，32MB 是 8 倍余量） | 413 `File is too large to serve via API` |
| 9 | 读字节 | `fs::read`（二进制；与 `/files/content` 的 `read_to_string` 区分） | 500 |

### 响应头

- `Content-Type`：按扩展映射（`image/png`、`image/jpeg`、`image/gif`、`image/webp`）；
- `Content-Length`：字节数；
- `Cache-Control: public, max-age=86400`——底座只给一天的共享缓存；
  长缓存由消费方平台层自己加（平台有登录态与内容寻址策略，底座不越权定长缓存）。

### 不做的事（安全边界）

- `svg` **不放行**（可内嵌脚本，当前库 0 张，无需求不开口子）；
- 目录列表不提供（`/files` 的 root 也不加 `media`，枚举面不扩大）。

## 3. 测试计划

`src-tauri/src/api_server.rs` 的 `api_server::tests::` 增补用例（跑 `cargo test --lib api_server::tests::`）：

1. `media_serves_png`——fixture 小 png（1×1 像素），200 + `image/png` + 字节一致；
2. `media_serves_jpg`——同上 jpg；
3. `media_rejects_escape`——`wiki/media/../../secrets.md` → 400/403（按 `safe_join`/白名单实际行为断言）；
4. `media_rejects_non_media_prefix`——`wiki/sources/x.md` → 403；
5. `media_rejects_text_ext`——`wiki/media/x.txt`（构造）→ 415；
6. `media_missing_404`——合法形态但文件不存在 → 404；
7. `is_media_rel` / `MEDIA_EXT` 纯函数单测。

**既有基线**：`commands::file_history` 6 个测试 + `commands::fs::tests::allow_absolute_write_paths` 在本机 Windows 预存失败（v0.6.11 基线即如此，非本次引入，不背锅、不修）。

## 4. 构建与部署（guaji 机）

### 4.1 环境补齐（guaji 机为临时机器：全部便携化，零系统残留）

> 原则（咩咩 2026-09-30 拍板）：像 Python venv 一样**全部住进本仓 `tools/`**，
> 不跑安装器、不注册系统服务、不写永久环境变量；离场删 `tools/` 即净。
> **本方案自包含**：由独立工作区的 agent 执行，不依赖 ipoanswer 工作区的任何文件；
> 全部路径以本仓（llm-wiki repo）为根。

| 组件 | 便携方式 | 位置（均在 `<llm-wiki repo>/tools/` 下） |
|---|---|---|
| MSVC + WinSDK | **PortableBuildTools**（basil00/PortableBuildTools，免 VS 安装器、免注册表，下载 MSVC v143 + WinSDK 到指定目录） | `tools/msvc/` |
| Rust | rustup 装 `stable-x86_64-pc-windows-msvc`，**`CARGO_HOME`/`RUSTUP_HOME` 重定向**（不落 `~/.cargo`） | `tools/cargo/`、`tools/rustup/` |
| cargo 镜像 | `tools/cargo/config.toml` 清华 sparse（随 `CARGO_HOME` 生效） | 同上 |
| protoc | 便携 zip（不设永久 `PROTOC` 环境变量，构建脚本会话注入） | `tools/protoc/` |
| Node 20.20.2 | 本机已有（用户级，此前所装，不在本次清理范围） | — |

构建所需环境变量（`PATH`/`INCLUDE`/`LIB`/`PROTOC`/`CARGO_HOME`/`RUSTUP_HOME`）
全部经 **`tools/build-env.ps1` 会话级注入**（本仓根目录）——只在构建终端内生效，机器全局零改动。

**编译位置拍板（2026-09-30）**：guaji 机便携编译——本方案完整执行到底；
回 Yang 机开发时，本仓 commit 拉过去用 Yang 现成环境再编一次、部署 Yang 侧底座
（两台底座都需要含媒体端点的版本，验收口径同 §4.4）。

### 4.2 构建（与 Yang 机备忘同一流程，环境经便携脚本注入）

```powershell
# 一次性：在构建终端会话内注入便携工具链（PATH/INCLUDE/LIB/PROTOC/CARGO_HOME/RUSTUP_HOME）
. .\tools\build-env.ps1     # 本仓根目录下（§4.1 生成）

# llm-wiki repo 根目录：
npm install
npm run build          # vite 产出 dist（cargo 编 lib 的前置）
npx tauri build --no-bundle   # ~12 分钟；裸 cargo build --release 的 exe 会连 devUrl，不可用
```

### 4.3 部署安装版

1. 备份：`C:\Users\guaji\AppData\Local\LLM Wiki\llm-wiki.exe` → 同目录 `.bak-20260930`；
2. 停旧实例（当前 PID 35972）→ 覆盖 exe → 启动；
3. **清点进程防双实例**：安装版会抢 19828（端口写死、版本号不区分，历史坑）——
   部署后 `netstat` + 进程枚举确认只有一个监听者。

### 4.4 验收（底座层）

- `curl` 三例：png（200 + 字节 SHA256 == 磁盘文件 hash）、jpg（200）、不存在路径（404）；
- 既有端点回归：`/health`、`/files/content`（文本页）、`/graph` 各打一发确认无回归。

### 4.5 回滚

还原 `.bak-20260930` → 重启 → 4.4 回归。本仓 commit 单独成笔，`git revert` 可退源码。

## 5. 风险与边界

- 覆盖已部署安装版 —— 咩咩已在本方案审批中拍板（回滚路径如上）；
- fork 与上游差异 +1 处（此前已有 `/graph` 性能优化四处 commit）；未来跟上游合并时本端点需要手动携带；
- 底座无鉴权（`authConfigured=false`）——媒体经 ipoanswer 平台代理对外，平台层持有登录门；
  底座 19828 仅监听本机（`allowLanAccess=false` 维持现状）。
