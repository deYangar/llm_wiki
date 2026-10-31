//! §九 ingest 端点（99 方案批次 5.2，2026-10-31）。
//!
//! ## 为什么需要独立模块
//!
//! `api_server.rs` 已 6.8k 行，而 §九 是有独立业务语义的一整块：
//! 「法规源 URL → 抓取 → 组 regulation 页 → 幂等入索引」。
//! 端点契约与页面组装规则都只属于这条链路，塞进 `api_server.rs` 会让
//! 那个巨型 match 继续膨胀。
//!
//! ## 端点
//!
//! `POST /api/v1/projects/{id}/ingest`
//!
//! ```json
//! {
//!   "items": [
//!     { "url": "http://www.shenchunhui.com/_private/.../fagui/2025/x.htm",
//!       "title": "可选，留空则从页面抽" }
//!   ],
//!   "dry_run": false,
//!   "allow_overwrite": false
//! }
//! ```
//!
//! 响应 `{ ok, results: [{ url, status, path?, title?, reason? }] }`
//! `status` 取值：`created` / `updated` / `skipped_exists` / `fetched_only`
//! / `failed` / `dry_run`。
//!
//! ## 幂等口径（咩咩 2026-10-30 拍板 7「每日 LLM 增强自动跑」的前置）
//!
//! 以 `source_url` 为**唯一外部标识**：先读 `wiki/regulation/` 下全部页面的
//! frontmatter `source_url`，命中即 `skipped_exists`（不重抓、不重写）。
//! 这比「按 title 比对」可靠 —— 同一标题在不同年份有多个版本（公司法
//! 1993/2005/2018），title 撞车不该当成同一份文书。
//!
//! ## 为什么组页规则写在这里而不是复用 chunhui_ingest.py
//!
//! `scripts/chunhui_ingest.py` 是**离线批处理**（读本地已抓好的
//! `manifest.jsonl` + `pages/*.json`），依赖 Python 运行时；而这个端点要
//! 在 Tauri 进程内直接可用，不能 shell 出去调 Python。两边的 frontmatter
//! 字段口径对齐（见 `build_regulation_page` 的字段清单注释），但取值来源
//! 不同：批处理读 JSON 产物，端点读 HTML 正文。

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::frontmatter;

/// 单条 ingest 请求
#[derive(Debug, Deserialize)]
pub struct IngestItem {
    pub url: String,
    #[serde(default)]
    pub title: String,
}

/// 端点请求体
#[derive(Debug, Deserialize)]
pub struct IngestRequest {
    pub items: Vec<IngestItem>,
    /// true = 只抓取+组页，不落盘、不入索引
    #[serde(default)]
    pub dry_run: bool,
    /// true = source_url 命中已存在时也重写（默认幂等跳过）
    #[serde(default)]
    pub allow_overwrite: bool,
}

/// 单条结果
#[derive(Debug, Serialize)]
pub struct IngestOutcome {
    pub url: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// 端点响应体
#[derive(Debug, Serialize)]
pub struct IngestResponse {
    pub ok: bool,
    pub results: Vec<IngestOutcome>,
    pub created: usize,
    pub updated: usize,
    pub skipped: usize,
    pub failed: usize,
}

/// 反查：source_url → rel_path（幂等判重用这个）
pub type UrlToPath = HashMap<String, String>;

/// 扫描项目 `wiki/regulation/` 全部页面，建 source_url 双向索引。
///
/// 复用 `frontmatter` 模块的解析（与 PATCH 端点同一套），保证「端点看到
/// 的 frontmatter」与「审查/打标流程看到的一致」。
pub fn build_url_index(project_path: &str) -> UrlToPath {
    let dir = Path::new(project_path).join("wiki").join("regulation");
    if !dir.is_dir() {
        return HashMap::new();
    }
    let mut out = HashMap::new();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        // 与 PATCH 端点同一套解析：`split_frontmatter` 返回 (正文起点, block)
        let Some((_body_start, block)) = frontmatter::split_frontmatter(&content) else {
            continue;
        };
        let fm = frontmatter::Frontmatter::parse(block);
        // source_url 可能是引号包裹或裸值；`Frontmatter::get` 已剥引号
        let Some(vals) = fm.get("source_url") else {
            continue;
        };
        let Some(raw) = vals.first() else {
            continue;
        };
        let url = raw.trim().to_string();
        if url.is_empty() {
            continue;
        }
        if let Ok(rel) = path.strip_prefix(Path::new(project_path)) {
            let rel = rel.to_string_lossy().replace('\\', "/");
            out.insert(url, rel);
        }
    }
    out
}

/// 组一页 regulation markdown（frontmatter + 正文）。
///
/// 字段口径对齐 `scripts/chunhui_ingest.py::build_page`，差异点：这里的
/// `title`/`issuer`/`status` 由调用方从抓取结果传入（端点在进程内做规则
/// 推导，不依赖离线的 category 规则表）。
pub fn build_regulation_page(
    title: &str,
    source_url: &str,
    issuer: &str,
    status: &str,
    body: &str,
) -> String {
    let mut fm: Vec<String> = vec![
        "type: regulation".to_string(),
        format!("title: {}", yaml_scalar(title)),
        "tags:".to_string(),
        "  - \"problem-type:法规原文\"".to_string(),
        "source: chunhui".to_string(),
        format!("source_url: {}", yaml_scalar(source_url)),
        format!("issuer: {}", yaml_scalar(issuer)),
        format!("promulgator: {}", yaml_scalar(issuer)),
        format!("status: {}", yaml_scalar(status)),
        "related: []".to_string(),
        "sources: []".to_string(),
    ];
    // reg-nature 平键留空：分类挂接由 tag_regulations.py / llm_reg_dimensions.py
    // 规则段后置补齐（端点不重复实现一份规则表，避免「两套口径」）。
    fm.push("reg_nature: \"\"".to_string());

    let body = body.trim();
    let mut out = String::from("---\n");
    out.push_str(&fm.join("\n"));
    out.push_str("\n---\n\n");
    out.push_str(&format!("# {title}\n\n{body}\n"));
    out
}

/// YAML 标量安全输出：含特殊字符时双引号包裹并转义。
fn yaml_scalar(value: &str) -> String {
    let needs_quote = value.chars().any(|c| {
        matches!(c, ':' | '#' | '"' | '\'' | '{' | '}' | '[' | ']' | ',' | '&' | '*' | '!' | '|' | '>' | '%')
    }) || value.trim() != value;
    if !needs_quote {
        return value.to_string();
    }
    let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

/// 从法规正文页 HTML 抽标题 / 文号 / 正文行。
///
/// 春晖站点形态（2026-10-24 抓取器实测）：GBK 编码，标题为首个非空行，
/// 其次是文号行（形如「财会〔2026〕12号」），之后是正文段落。
/// 这里做**纯文本抽取**（剥标签 + 解码实体 + 按行切分），不引入 HTML
/// 解析依赖 —— 与 `scripts/chunhui_scraper.py` 的抽取口径一致，便于
/// 两侧产物对账。
pub fn extract_regulation_body(html: &str) -> (String, String) {
    let text = strip_html_tags(&insert_block_breaks(html));
    let mut lines: Vec<&str> = text
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect();
    if lines.is_empty() {
        return (String::new(), String::new());
    }
    let title = lines.first().copied().unwrap_or("").to_string();
    // 文号行判定：含「〔」或「[」且含「号」
    let doc_number = lines
        .iter()
        .skip(1)
        .take(3)
        .find(|l| (l.contains('〔') || l.contains('[')) && l.contains('号'))
        .map(|s| s.to_string())
        .unwrap_or_default();
    // 正文去掉标题行与文号行
    lines.retain(|l| *l != title && *l != doc_number);
    (title, lines.join("\n"))
}

/// 剥 HTML 标签 + 解实体（含数字实体与中文常用实体）。
///
/// 实现要点：script/style 整块（含内容）跳过；块级标签（p/div/br/tr/li）
/// 转成换行，避免整篇正文挤成一行（春晖详情页正文是 `<p>` 段落序列）。
fn strip_html_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    let mut skip_depth: Option<&'static str> = None;
    let mut i = 0;
    let len = html.len();
    while i < len {
        let rest = &html[i..];
        let lower = rest.to_ascii_lowercase();

        // 整块跳过 <script>/<style>（含正文），直到对应闭合标签
        if let Some(close) = skip_depth {
            if lower.starts_with(close) {
                skip_depth = None;
                in_tag = true;
            } else {
                let ch = rest.chars().next().unwrap_or('\0');
                i += ch.len_utf8();
                continue;
            }
        }
        if lower.starts_with("<script") {
            skip_depth = Some("</script");
            in_tag = true;
        } else if lower.starts_with("<style") {
            skip_depth = Some("</style");
            in_tag = true;
        }

        let ch = rest.chars().next().unwrap_or('\0');
        if ch == '<' {
            in_tag = true;
            i += 1;
            continue;
        }
        if ch == '>' && in_tag {
            in_tag = false;
            i += 1;
            continue;
        }
        if !in_tag {
            if ch == BLOCK_BREAK {
                // 块级标签边界（insert_block_breaks 插入）→ 真换行
                out.push('\n');
            } else if ch == '\n' || ch == '\r' || ch == '\u{00a0}' {
                // 原始换行 / nbsp → 单个空格（HTML 空白折叠语义）
                out.push(' ');
            } else {
                out.push(ch);
            }
        }
        i += ch.len_utf8();
    }
    decode_entities(&out)
}

/// 块级边界的哨兵字符（C0 控制符，正文不会出现）。
/// 不能直接插 `\n`：strip 阶段会把原始换行折叠成空格，两者无法区分。
const BLOCK_BREAK: char = '\u{0001}';

/// 块级标签边界预插入哨兵，让 `<p>` 段落序列能按行切分。
///
/// 单独一步而不是在 `strip_html_tags` 里做，是为了让剥标签逻辑保持简单；
/// 只处理法规页最常见的几个块级标签（p / div / br / tr / li / h1-6）。
fn insert_block_breaks(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let mut out = String::with_capacity(html.len() + 16);
    let mut last = 0;
    let mut i = 0;
    let len = lower.len();
    while i < len {
        if lower.as_bytes()[i] == b'<' {
            let name_end = lower[i + 1..]
                .find(|c: char| !c.is_ascii_alphanumeric() && c != '/')
                .map(|p| i + 1 + p)
                .unwrap_or(len);
            let tag_name = lower[i + 1..name_end].trim_start_matches('/').trim();
            if matches!(
                tag_name,
                "p" | "div" | "br" | "tr" | "li" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
            ) {
                if let Some(gt_rel) = lower[i..].find('>') {
                    let gt = i + gt_rel;
                    out.push_str(&html[last..i]);
                    out.push(BLOCK_BREAK);
                    out.push_str(&html[i..=gt]);
                    out.push(BLOCK_BREAK);
                    last = gt + 1;
                    i = gt + 1;
                    continue;
                }
            }
        }
        i += 1;
    }
    out.push_str(&html[last..]);
    out
}

/// 解 HTML 实体（数字实体按十进制与十六进制两种形态）。
fn decode_entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.char_indices().peekable();
    while let Some((idx, ch)) = chars.next() {
        if ch != '&' {
            out.push(ch);
            continue;
        }
        // 尝试匹配 &#123; / &#x1F; / &nbsp; / &amp; …
        let rest = &text[idx + 1..];
        let end = rest.find(';').filter(|e| *e <= 12);
        let Some(end) = end else {
            out.push('&');
            continue;
        };
        let entity = &rest[..end];
        let replacement = if let Some(num) = entity.strip_prefix('#') {
            if let Some(hex) = num.strip_prefix('x').or_else(|| num.strip_prefix('X')) {
                u32::from_str_radix(hex, 16).ok().and_then(char::from_u32)
            } else {
                num.parse::<u32>().ok().and_then(char::from_u32)
            }
        } else {
            match entity {
                "nbsp" => Some(' '),
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "ldquo" => Some('“'),
                "rdquo" => Some('”'),
                "hellip" => Some('…'),
                "mdash" => Some('—'),
                "ndash" => Some('–'),
                _ => None,
            }
        };
        match replacement {
            Some(c) => {
                out.push(c);
                for _ in 0..=end {
                    chars.next();
                }
            }
            None => out.push('&'),
        }
    }
    out
}

/// 页面落盘路径：`wiki/regulation/<安全文件名>.md`
///
/// 文件名清洗规则与 `chunhui_ingest.py` 一致（Windows 非法字符替换、
/// 长度截断），因为两侧产物要落在同一个目录里。
pub fn regulation_rel_path(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '|' | '?' | '*' | '/' | '\\' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches('.');
    let base: String = if trimmed.is_empty() {
        "untitled".to_string()
    } else if trimmed.chars().count() > 120 {
        trimmed.chars().take(120).collect()
    } else {
        trimmed.to_string()
    };
    format!("wiki/regulation/{base}.md")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_body_splits_on_block_tags() {
        let html = "<html><head><style>.x{}</style></head><body>\
            <p>企业会计准则解释第18号</p>\
            <p>财会〔2026〕12号</p>\
            <p>一、关于不属于单项履约义务的保证类质量保证</p>\
            <script>var a = 1;</script></body></html>";
        let (title, body) = extract_regulation_body(html);
        assert_eq!(title, "企业会计准则解释第18号");
        assert!(body.contains("财会〔2026〕12号") == false, "文号应被剥出正文: {body}");
        assert!(body.contains("单项履约义务"), "{body}");
        assert!(!body.contains("var a"), "script 内容必须剔除: {body}");
        assert!(!body.contains(".x{}"), "style 内容必须剔除: {body}");
    }

    #[test]
    fn extract_body_decodes_entities() {
        let html = "<p>关于&lt;上市公司&gt;的&amp;有关规定&#12288;第&#x4E00;条</p>";
        let (title, _body) = extract_regulation_body(html);
        assert!(title.contains("上市公司"), "{title}");
        assert!(!title.contains("&lt;"), "{title}");
    }

    #[test]
    fn url_index_reads_source_url_from_frontmatter() {
        let dir = std::env::temp_dir().join(format!("llmwiki-ingest-test-{}", std::process::id()));
        let reg = dir.join("wiki").join("regulation");
        std::fs::create_dir_all(&reg).unwrap();
        std::fs::write(
            reg.join("a.md"),
            "---\ntype: regulation\ntitle: A\nsource_url: \"https://x.test/a\"\n---\n\n# A\n",
        )
        .unwrap();
        std::fs::write(reg.join("b.md"), "---\ntype: regulation\ntitle: B\n---\n\n# B\n").unwrap();
        let idx = build_url_index(dir.to_str().unwrap());
        assert_eq!(idx.get("https://x.test/a"), Some(&"wiki/regulation/a.md".to_string()));
        assert_eq!(idx.len(), 1, "无 source_url 的页不应入索引");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rel_path_sanitizes_windows_illegal_chars() {
        assert_eq!(
            regulation_rel_path("关于《A/B》的规定: *?|<>"),
            "wiki/regulation/关于《A_B》的规定_ _____.md"
        );
        assert_eq!(regulation_rel_path("   "), "wiki/regulation/untitled.md");
        // 长标题截到 120 字符（不含 .md）
        let long = "长".repeat(200);
        let rel = regulation_rel_path(&long);
        assert!(rel.matches('长').count() <= 120, "{rel}");
    }

    #[test]
    fn page_builds_parseable_frontmatter() {
        let page = build_regulation_page(
            "企业会计准则解释第18号",
            "https://x.test/a",
            "财政部",
            "现行有效",
            "一、正文第一段\n二、正文第二段",
        );
        let (_, block) = crate::frontmatter::split_frontmatter(&page).expect("必须有 frontmatter");
        let fm = crate::frontmatter::Frontmatter::parse(block);
        assert_eq!(fm.get("type").map(|v| v.to_vec()), Some(vec!["regulation".to_string()]));
        assert_eq!(fm.get("source_url").map(|v| v.to_vec()), Some(vec!["https://x.test/a".to_string()]));
        assert_eq!(fm.get("issuer").map(|v| v.to_vec()), Some(vec!["财政部".to_string()]));
        assert_eq!(fm.skipped_lines().len(), 0, "不得产生解析不了的行");
        assert!(page.contains("# 企业会计准则解释第18号"));
        assert!(page.contains("一、正文第一段"));
    }

    #[test]
    fn yaml_scalar_quotes_special_values() {
        assert_eq!(yaml_scalar("正常标题"), "正常标题");
        assert_eq!(yaml_scalar("含: 冒号"), "\"含: 冒号\"");
        assert_eq!(yaml_scalar(" 前导空格"), "\" 前导空格\"");
    }
}
