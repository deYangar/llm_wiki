//! Frontmatter subset parser shared by the API server retrieval paths
//! (search filter, graph tags, pages/query) and the field-level PATCH
//! write endpoint.
//!
//! The wiki schema (`schema.md` in each project) constrains frontmatter
//! values to exactly two shapes — `key: value` scalars and string lists
//! (`key: [a, b]` inline or `key:` followed by `  - a` block items).
//! This module parses that subset only; it deliberately does NOT pull in
//! a YAML crate. Unknown shapes (nested objects, bare text lines, whole-
//! line comments) are recorded in `skipped` and otherwise ignored:
//!
//! * read/filter semantics — an unparsed key simply "does not match",
//!   never errors;
//! * write-back semantics — the PATCH endpoint refuses (422) any page
//!   whose frontmatter contains skipped lines, because re-serializing
//!   would silently drop them.

use std::collections::BTreeMap;
use std::fs::File;
use std::io::Read;
use std::path::Path;

use serde::Deserialize;

/// Default head-read budget: 16KB comfortably covers every frontmatter
/// block seen in the 3,700+ page production libraries while avoiding a
/// full read of multi-megabyte regulation pages.
pub const DEFAULT_HEAD_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Frontmatter {
    /// Ordered key table. The boolean marks entries written as scalars in
    /// the source (`key: value`); lists render back as block items and
    /// project as JSON arrays. Preserving order keeps PATCH rewrites
    /// byte-stable across idempotent reruns.
    fields: Vec<(String, Vec<String>, bool)>,
    /// Keys/lines the parser could not represent within the schema value
    /// domain. `render()` drops them, so callers writing pages back must
    /// check this list first.
    skipped: Vec<String>,
}

impl Frontmatter {
    pub fn parse(block: &str) -> Frontmatter {
        let mut fm = Frontmatter::default();
        let lines: Vec<&str> = block.lines().collect();
        let mut i = 0usize;
        while i < lines.len() {
            let raw = lines[i];
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                i += 1;
                continue;
            }
            if trimmed.starts_with('#') {
                // Whole-line comment: dropped by render(), so surface it.
                fm.skipped.push(trimmed.to_string());
                i += 1;
                continue;
            }
            let Some((key, value)) = split_key_line(trimmed) else {
                fm.skipped.push(truncate_line(trimmed));
                i += 1;
                continue;
            };
            let inline = strip_inline_comment(value).trim();
            if inline.starts_with('[') && inline.ends_with(']') && inline.len() >= 2 {
                let items = split_inline_list(&inline[1..inline.len() - 1]);
                fm.fields.push((key, items, false));
                i += 1;
                continue;
            }
            if !inline.is_empty() {
                let scalar = unquote(inline);
                if scalar.is_empty() {
                    // A value that is only quotes/comment noise still marks
                    // the key present; treat as empty scalar for honesty.
                    fm.fields.push((key, Vec::new(), true));
                } else {
                    fm.fields.push((key, vec![scalar], true));
                }
                i += 1;
                continue;
            }
            // `key:` with no inline value: either a block list, a nested
            // object (unsupported → skip the whole key), or an empty value.
            let key_indent = indent_of(raw);
            let mut items: Vec<String> = Vec::new();
            let mut j = i + 1;
            let mut nested = false;
            while j < lines.len() {
                let next = lines[j];
                let next_trimmed = next.trim();
                if next_trimmed.is_empty() {
                    j += 1;
                    continue;
                }
                if let Some(item) = next_trimmed.strip_prefix('-') {
                    // Deeper indentation than the key (or any `-` line when
                    // the key sits at column 0) belongs to this list.
                    if indent_of(next) > key_indent || key_indent == 0 {
                        let item = unquote(strip_inline_comment(item).trim());
                        if !item.is_empty() {
                            items.push(item);
                        }
                        j += 1;
                        continue;
                    }
                    break;
                }
                if split_key_line(next_trimmed).is_some() {
                    // A deeper-indented `subkey:` line means the key owns a
                    // nested object — outside the schema value domain.
                    nested = indent_of(next) > key_indent;
                }
                break;
            }
            if nested {
                fm.skipped.push(key);
            } else {
                fm.fields.push((key, items, false));
            }
            i = if nested { j } else { j.max(i + 1) };
        }
        fm
    }

    pub fn get(&self, key: &str) -> Option<&[String]> {
        self.fields
            .iter()
            .find(|(k, _, _)| k == key)
            .map(|(_, values, _)| values.as_slice())
    }

    /// Plan-W1 interface member; exercised by tests until retrieval
    /// consumers start iterating keys directly.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.fields.iter().map(|(k, _, _)| k.as_str())
    }

    /// Lines the parser refused to represent. Read paths ignore them; the
    /// PATCH endpoint must reject the page when this is non-empty.
    pub fn skipped_lines(&self) -> &[String] {
        &self.skipped
    }

    /// Serialize back to line-oriented text WITHOUT the surrounding `---`
    /// delimiters. Scalars keep `key: value`; lists render as block items
    /// (`key:\n  - "item"`), matching the libraries' prevailing style.
    /// List items and scalars containing YAML-special characters are
    /// double-quoted per the schema's quoting rule.
    pub fn render(&self) -> String {
        let mut out = String::new();
        for (key, values, is_scalar) in &self.fields {
            if *is_scalar && values.len() <= 1 {
                match values.first() {
                    Some(value) => out.push_str(&format!("{key}: {}\n", quote_scalar(value))),
                    None => out.push_str(&format!("{key}:\n")),
                }
                continue;
            }
            out.push_str(&format!("{key}:\n"));
            for value in values {
                out.push_str(&format!("  - {}\n", quote_list_item(value)));
            }
        }
        out
    }

    /// Replace or insert a scalar key, preserving the original position of
    /// existing keys (new keys append).
    pub fn set_scalar(&mut self, key: &str, value: &str) {
        if let Some(entry) = self.fields.iter_mut().find(|(k, _, _)| k == key) {
            entry.1 = vec![value.to_string()];
            entry.2 = true;
        } else {
            self.fields
                .push((key.to_string(), vec![value.to_string()], true));
        }
    }

    /// Union-merge list items into a key, preserving existing order and
    /// appending only unseen items (idempotent by construction).
    pub fn merge_list(&mut self, key: &str, additions: &[String]) {
        if let Some(entry) = self.fields.iter_mut().find(|(k, _, _)| k == key) {
            for item in additions {
                if !entry.1.contains(item) {
                    entry.1.push(item.clone());
                }
            }
            if !entry.1.is_empty() {
                entry.2 = false;
            }
            return;
        }
        self.fields
            .push((key.to_string(), additions.to_vec(), false));
    }

    pub fn remove_key(&mut self, key: &str) {
        self.fields.retain(|(k, _, _)| k != key);
    }

    /// Frontmatter fields projected as ordered (key, values, is_scalar)
    /// tuples — the shape the pages/query endpoint serializes.
    pub fn iter_fields(&self) -> impl Iterator<Item = (&str, &[String], bool)> {
        self.fields
            .iter()
            .map(|(k, v, s)| (k.as_str(), v.as_slice(), *s))
    }

    /// Ordered (key, values) pairs ignoring the scalar-vs-list rendering
    /// distinction — `tags: [a, b]` and block-form `tags:\n  - "a"` are the
    /// same page content. PATCH idempotency compares against this, so a
    /// pure re-serialization (inline → block) never counts as a change.
    pub fn semantic_pairs(&self) -> Vec<(&str, &[String])> {
        self.fields
            .iter()
            .map(|(k, v, _)| (k.as_str(), v.as_slice()))
            .collect()
    }
}

fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start().len()
}

fn split_key_line(trimmed: &str) -> Option<(String, &str)> {
    let (key, value) = trimmed.split_once(':')?;
    let key = key.trim();
    if key.is_empty()
        || key.starts_with('-')
        || key
            .chars()
            .any(|c| c.is_whitespace() || "[]{},#\"'".contains(c))
    {
        return None;
    }
    Some((key.to_string(), value))
}

/// Drop a trailing ` # comment` from an unquoted value (YAML requires
/// whitespace before `#`). A `#` inside a quoted segment is content,
/// not a comment start, so quoted values come through untouched —
/// `title: "a # b"` keeps its `#`.
fn strip_inline_comment(value: &str) -> &str {
    let mut quote: Option<char> = None;
    let mut prev_space = false;
    for (idx, ch) in value.char_indices() {
        match quote {
            Some(q) if ch == q => quote = None,
            Some(_) => {}
            None => match ch {
                '"' | '\'' => {
                    quote = Some(ch);
                    prev_space = false;
                }
                '#' if prev_space => return &value[..idx],
                _ => prev_space = ch == ' ' || ch == '\t',
            },
        }
    }
    value
}

fn split_inline_list(inner: &str) -> Vec<String> {
    inner
        .split(',')
        .map(|item| unquote(strip_inline_comment(item).trim()))
        .filter(|item| !item.is_empty())
        .collect()
}

fn unquote(value: &str) -> String {
    let trimmed = value.trim();
    if let Some(inner) = trimmed.strip_prefix('"').and_then(|rest| rest.strip_suffix('"')) {
        return unescape_double_quoted(inner);
    }
    if let Some(inner) = trimmed.strip_prefix('\'').and_then(|rest| rest.strip_suffix('\'')) {
        return inner.replace("''", "'");
    }
    trimmed.to_string()
}

/// Reverse the escapes the TS writers emit inside double-quoted YAML
/// scalars (`\"` → `"`, `\\` → `\`) so this parser and js-yaml see the
/// same value. An unknown escape keeps the backslash verbatim — the
/// writer side only ever emits those two sequences.
fn unescape_double_quoted(inner: &str) -> String {
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        match chars.next() {
            Some(next @ ('"' | '\\')) => out.push(next),
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}

fn needs_quoting(value: &str) -> bool {
    value.contains(':')
        || value.contains('#')
        || value.contains('[')
        || value.contains(']')
        || value.contains(',')
        || value.contains('{')
        || value.contains('}')
        || value.contains('"')
        || value.contains('\'')
        || value.trim() != value
        || value.is_empty()
}

fn quote_scalar(value: &str) -> String {
    if needs_quoting(value) {
        format!("\"{}\"", escape_double_quoted(value))
    } else {
        value.to_string()
    }
}

fn quote_list_item(value: &str) -> String {
    // Schema rule: every list item is double-quoted.
    format!("\"{}\"", escape_double_quoted(value))
}

/// Escape for double-quoted YAML scalars — mirrors the TS `yamlEscape`
/// (backslash first, then quotes, so the escapes introduced by the
/// quote pass are not doubled again).
fn escape_double_quoted(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn truncate_line(line: &str) -> String {
    line.chars().take(40).collect()
}

/// Slice out the frontmatter block. Returns `(body_start_byte_offset,
/// block_text)` where the block excludes both `---` delimiter lines. The
/// first line MUST be `---`; a missing closing `---` returns None so the
/// whole page is treated as frontmatter-free (honest degradation).
pub fn split_frontmatter(content: &str) -> Option<(usize, &str)> {
    let bytes = content.as_bytes();
    let first_line_end = bytes.iter().position(|&b| b == b'\n')?;
    if content[..first_line_end].trim_end_matches('\r') != "---" {
        return None;
    }
    let mut line_start = first_line_end + 1;
    let block_start = line_start;
    while line_start <= bytes.len() {
        if line_start == bytes.len() {
            return None;
        }
        let line_end = bytes[line_start..]
            .iter()
            .position(|&b| b == b'\n')
            .map(|pos| line_start + pos)
            .unwrap_or(bytes.len());
        let line = content[line_start..line_end].trim_end_matches('\r');
        if line.trim() == "---" {
            let body_start = (line_end + 1).min(bytes.len());
            return Some((body_start, &content[block_start..line_start]));
        }
        if line_end >= bytes.len() {
            return None;
        }
        line_start = line_end + 1;
    }
    None
}

/// Read at most `max_head_bytes` from the head of a file, cutting back to
/// the longest valid UTF-8 prefix so multibyte characters straddling the
/// budget are not corrupted. Large regulation pages never get fully read
/// just to inspect frontmatter.
pub fn read_head(path: &Path, max_head_bytes: usize) -> std::io::Result<String> {
    let mut file = File::open(path)?;
    let mut buf = vec![0u8; max_head_bytes];
    let mut read_total = 0usize;
    while read_total < buf.len() {
        let n = file.read(&mut buf[read_total..])?;
        if n == 0 {
            break;
        }
        read_total += n;
    }
    buf.truncate(read_total);
    match std::str::from_utf8(&buf) {
        Ok(text) => Ok(text.to_string()),
        Err(err) => {
            // Fall back to the valid prefix; a head cut mid-character only
            // loses tail bytes the frontmatter cannot span.
            let cut = err.valid_up_to();
            Ok(String::from_utf8_lossy(&buf[..cut]).into_owned())
        }
    }
}

/// Convenience wrapper: read the file head and parse its frontmatter.
/// Returns Ok(None) for files without a well-formed block.
pub fn load_head(path: &Path) -> std::io::Result<Option<Frontmatter>> {
    let head = read_head(path, DEFAULT_HEAD_BYTES)?;
    Ok(split_frontmatter(&head).map(|(_, block)| Frontmatter::parse(block)))
}

/// Structured filter for search / pages-query. All conditions are ANDed;
/// absent or empty members don't filter. Field names intentionally match
/// the plan's wire contract verbatim (snake_case keys in JSON).
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
pub struct SearchFilter {
    pub r#type: Option<String>,
    pub path_prefix: Option<String>,
    pub tags_all: Option<Vec<String>>,
    pub tags_any: Option<Vec<String>>,
    pub field_eq: Option<BTreeMap<String, String>>,
    pub field_in: Option<BTreeMap<String, Vec<String>>>,
}

impl SearchFilter {
    pub fn is_empty(&self) -> bool {
        self.r#type.is_none()
            && self.path_prefix.is_none()
            && self.tags_all.as_ref().is_none_or(Vec::is_empty)
            && self.tags_any.as_ref().is_none_or(Vec::is_empty)
            && self.field_eq.as_ref().is_none_or(BTreeMap::is_empty)
            && self.field_in.as_ref().is_none_or(BTreeMap::is_empty)
    }

    /// Element-level tag match: exact equality, or prefix match when the
    /// pattern ends with `*`. Public so the graph endpoint's tag filter
    /// shares the exact search-filter semantics.
    pub fn tag_pattern_matches(pattern: &str, tags: &[String]) -> bool {
        match pattern.strip_suffix('*') {
            Some(prefix) => tags.iter().any(|tag| tag.starts_with(prefix)),
            None => tags.iter().any(|tag| tag == pattern),
        }
    }

    fn values_match(fm: &Frontmatter, key: &str, expected: &str) -> bool {
        fm.get(key).is_some_and(|values| {
            values.iter().any(|value| value == expected)
        })
    }

    /// Does this page (frontmatter + project-relative path) pass the
    /// filter? An empty filter matches everything.
    pub fn matches(&self, fm: &Frontmatter, rel_path: &str) -> bool {
        if let Some(want_type) = &self.r#type {
            if !Self::values_match(fm, "type", want_type) {
                return false;
            }
        }
        if let Some(prefix) = &self.path_prefix {
            let normalized_prefix = prefix.replace('\\', "/");
            let normalized_prefix = normalized_prefix
                .strip_prefix("./")
                .unwrap_or(&normalized_prefix);
            let normalized_path = rel_path.replace('\\', "/");
            if !normalized_path
                .to_ascii_lowercase()
                .starts_with(&normalized_prefix.to_ascii_lowercase())
            {
                return false;
            }
        }
        let empty_tags: Vec<String> = Vec::new();
        let tags = fm.get("tags").unwrap_or(&empty_tags);
        if let Some(patterns) = &self.tags_all {
            if !patterns.is_empty()
                && !patterns
                    .iter()
                    .all(|pattern| Self::tag_pattern_matches(pattern, tags))
            {
                return false;
            }
        }
        if let Some(patterns) = &self.tags_any {
            if !patterns.is_empty()
                && !patterns
                    .iter()
                    .any(|pattern| Self::tag_pattern_matches(pattern, tags))
            {
                return false;
            }
        }
        if let Some(eqs) = &self.field_eq {
            for (key, expected) in eqs {
                if !Self::values_match(fm, key, expected) {
                    return false;
                }
            }
        }
        if let Some(ins) = &self.field_in {
            for (key, candidates) in ins {
                let hit = fm.get(key).is_some_and(|values| {
                    values
                        .iter()
                        .any(|value| candidates.contains(value))
                });
                if !hit {
                    return false;
                }
            }
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_scalar_and_inline_list() {
        let fm = Frontmatter::parse(
            "type: case\nyear: 2025\ntags: [\"exchange:深交所\", \"topic:收入确认\"]\n",
        );
        assert_eq!(fm.get("type"), Some(&["case".to_string()][..]));
        assert_eq!(fm.get("year"), Some(&["2025".to_string()][..]));
        assert_eq!(
            fm.get("tags"),
            Some(
                &["exchange:深交所".to_string(), "topic:收入确认".to_string()][..]
            )
        );
        let keys: Vec<&str> = fm.keys().collect();
        assert_eq!(keys, vec!["type", "year", "tags"]);
    }

    #[test]
    fn parse_block_list() {
        let fm = Frontmatter::parse(
            "tags:\n  - \"exchange:深交所\"\n  - \"board:主板\"\nrelated:\n    - \"[[收入确认]]\"\ntitle: 标题\n",
        );
        assert_eq!(
            fm.get("tags"),
            Some(&["exchange:深交所".to_string(), "board:主板".to_string()][..])
        );
        // Deeper-indented block items still belong to the list.
        assert_eq!(
            fm.get("related"),
            Some(&["[[收入确认]]".to_string()][..])
        );
        assert_eq!(fm.get("title"), Some(&["标题".to_string()][..]));
    }

    #[test]
    fn parse_trims_quotes() {
        let fm = Frontmatter::parse(
            "title: '单引号'\ntags: [\"a\", 'b']\nsource:\n  - \"c\"\n",
        );
        assert_eq!(fm.get("title"), Some(&["单引号".to_string()][..]));
        assert_eq!(
            fm.get("tags"),
            Some(&["a".to_string(), "b".to_string()][..])
        );
        assert_eq!(fm.get("source"), Some(&["c".to_string()][..]));
    }

    #[test]
    fn ignores_unknown_nested_shape() {
        let fm = Frontmatter::parse("nested:\n  sub: value\ntitle: 正常\n");
        assert_eq!(fm.get("nested"), None);
        assert_eq!(fm.get("title"), Some(&["正常".to_string()][..]));
        assert_eq!(fm.skipped_lines(), &["nested".to_string()]);
        // A bare non-key line is equally outside the value domain.
        let fm2 = Frontmatter::parse("title: 正常\n裸文本行\n");
        assert_eq!(fm2.get("title"), Some(&["正常".to_string()][..]));
        assert_eq!(fm2.skipped_lines().len(), 1);
    }

    #[test]
    fn render_preserves_key_order() {
        let fm = Frontmatter::parse("type: case\ntitle: 页面\nyear: 2025\ntags: [\"a\", \"b\"]\n");
        // Inline lists normalize to the block style on render (the
        // libraries' prevailing form); scalars stay inline.
        assert_eq!(
            fm.render(),
            "type: case\ntitle: 页面\nyear: 2025\ntags:\n  - \"a\"\n  - \"b\"\n"
        );
        // set on an existing key keeps its position; new keys append.
        let mut fm = fm;
        fm.set_scalar("year", "2026");
        fm.merge_list("tags", &["b".to_string(), "c".to_string()]);
        fm.set_scalar("updated", "2026-10-10");
        let rendered = fm.render();
        let expected = "type: case\ntitle: 页面\nyear: 2026\ntags:\n  - \"a\"\n  - \"b\"\n  - \"c\"\nupdated: 2026-10-10\n";
        assert_eq!(rendered, expected);
        let keys: Vec<String> = {
            let binding = Frontmatter::parse(&rendered);
            binding.keys().map(str::to_string).collect()
        };
        assert_eq!(
            keys,
            vec!["type", "title", "year", "tags", "updated"]
        );
    }

    #[test]
    fn split_detects_missing_close() {
        assert_eq!(split_frontmatter("---\ntitle: a\n---\n正文"), Some((17, "title: a\n")));
        assert_eq!(split_frontmatter("title: a\n---\n"), None);
        assert_eq!(split_frontmatter("---\ntitle: a\n"), None);
        // CRLF content: offsets still land on body start.
        let (offset, block) = split_frontmatter("---\r\ntitle: a\r\n---\r\nbody").unwrap();
        assert_eq!(&"---\r\ntitle: a\r\n---\r\nbody"[offset..], "body");
        assert_eq!(block, "title: a\r\n");
    }

    #[test]
    fn read_head_truncates_large_file() {
        let dir = std::env::temp_dir().join(format!(
            "llm-wiki-fm-head-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("big.md");
        // 32KB of multibyte content; a 16KB head cut must not split a char.
        let content = "中".repeat(16 * 1024);
        std::fs::write(&path, &content).unwrap();
        let head = read_head(&path, DEFAULT_HEAD_BYTES).unwrap();
        assert!(head.len() < content.len());
        assert!(head.chars().all(|c| c == '中'));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn filter_type_path_and_fields() {
        let fm = Frontmatter::parse(
            "type: case\nexchange: 深交所\nboard: 创业板\ntags: [\"topic:收入确认\", \"role:财务\"]\n",
        );
        let mut filter = SearchFilter {
            r#type: Some("case".to_string()),
            ..Default::default()
        };
        assert!(filter.matches(&fm, "wiki/cases/A.md"));
        filter.r#type = Some("issue".to_string());
        assert!(!filter.matches(&fm, "wiki/cases/A.md"));

        let filter = SearchFilter {
            path_prefix: Some("wiki/cases/".to_string()),
            ..Default::default()
        };
        assert!(filter.matches(&fm, "wiki/cases/A.md"));
        assert!(!filter.matches(&fm, "wiki/issues/A.md"));
        // Case-insensitive on Windows-style path input.
        assert!(SearchFilter {
            path_prefix: Some("Wiki/Cases/".to_string()),
            ..Default::default()
        }
        .matches(&fm, "wiki/cases/A.md"));

        let filter = SearchFilter {
            field_eq: Some(BTreeMap::from([
                ("exchange".to_string(), "深交所".to_string()),
                ("year".to_string(), "2025".to_string()),
            ])),
            ..Default::default()
        };
        // year missing → no match (honest "not hit", not an error).
        assert!(!filter.matches(&fm, "wiki/cases/A.md"));

        assert!(SearchFilter {
            field_in: Some(BTreeMap::from([(
                "board".to_string(),
                vec!["创业板".to_string(), "科创板".to_string()]
            )])),
            ..Default::default()
        }
        .matches(&fm, "wiki/cases/A.md"));
    }

    #[test]
    fn filter_tags_exact_and_prefix() {
        let fm = Frontmatter::parse("tags: [\"topic:收入确认\", \"exchange:深交所\"]\n");
        assert!(SearchFilter {
            tags_all: Some(vec!["topic:收入确认".to_string()]),
            ..Default::default()
        }
        .matches(&fm, "x.md"));
        // Exact match must not hit a longer tag (element-level equality).
        assert!(!SearchFilter {
            tags_all: Some(vec!["topic:收入".to_string()]),
            ..Default::default()
        }
        .matches(&fm, "x.md"));
        assert!(SearchFilter {
            tags_all: Some(vec!["topic:收入确认*".to_string()]),
            ..Default::default()
        }
        .matches(&fm, "x.md"));
        assert!(SearchFilter {
            tags_any: Some(vec![
                "exchange:上交所".to_string(),
                "exchange:深交所".to_string(),
            ]),
            ..Default::default()
        }
        .matches(&fm, "x.md"));
        // AND semantics: both patterns must hit.
        assert!(!SearchFilter {
            tags_all: Some(vec![
                "exchange:深交所".to_string(),
                "topic:毛利率*".to_string(),
            ]),
            ..Default::default()
        }
        .matches(&fm, "x.md"));
        // Empty filter matches a page with no frontmatter at all.
        assert!(SearchFilter::default().matches(&Frontmatter::default(), "x.md"));
        assert!(SearchFilter::default().is_empty());
    }

    #[test]
    fn inline_comment_stripped_from_values() {
        let fm = Frontmatter::parse("board: 主板            # 主板 / 创业板\ntags:\n  - \"a:1\"  # 注释\n");
        assert_eq!(fm.get("board"), Some(&["主板".to_string()][..]));
        assert_eq!(fm.get("tags"), Some(&["a:1".to_string()][..]));
    }

    #[test]
    fn hash_inside_quotes_is_content() {
        // F4: a `#` inside a quoted value is not a comment start; a
        // ` # ` after the closing bracket is. (A `# comment` inside an
        // unquoted flow-list item would swallow the `]` — that input is
        // not valid YAML to begin with, so it is not asserted here.)
        let fm = Frontmatter::parse("title: \"a # b\"\ntags: [\"x # y\", \"z\"] # real comment\n");
        assert_eq!(fm.get("title"), Some(&["a # b".to_string()][..]));
        assert_eq!(fm.get("tags"), Some(&["x # y".to_string(), "z".to_string()][..]));
    }

    #[test]
    fn quoted_escapes_round_trip_both_sides() {
        // G3: the TS writer escapes `\` and `"` inside double-quoted
        // scalars; this parser must decode them back so Rust and js-yaml
        // agree on the value.
        let fm = Frontmatter::parse(
            "title: \"关于\\\\增速\\\\的说明\"\ntags:\n  - \"a\\\\b\"\n  - \"c\\\"d\"\n",
        );
        assert_eq!(fm.get("title"), Some(&["关于\\增速\\的说明".to_string()][..]));
        assert_eq!(
            fm.get("tags"),
            Some(&["a\\b".to_string(), "c\"d".to_string()][..])
        );
        // render() re-escapes symmetrically — parse(render(x)) == x.
        let rendered = fm.render();
        let reparsed = Frontmatter::parse(&rendered);
        assert_eq!(reparsed.get("title"), fm.get("title"));
        assert_eq!(reparsed.get("tags"), fm.get("tags"));
    }

    #[test]
    fn single_quoted_doubled_quote_unescapes() {
        let fm = Frontmatter::parse("title: 'it''s fine'\n");
        assert_eq!(fm.get("title"), Some(&["it's fine".to_string()][..]));
    }
}
