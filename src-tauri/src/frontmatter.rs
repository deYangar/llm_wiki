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

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

/// Default head-read budget: 16KB comfortably covers every frontmatter
/// block seen in the 3,700+ page production libraries while avoiding a
/// full read of multi-megabyte regulation pages.
pub const DEFAULT_HEAD_BYTES: usize = 16 * 1024;

/// The full field table (order + scalar/list rendering + folded multiline
/// originals + skipped lines) round-trips through the persisted page-meta
/// index, so `Serialize`/`Deserialize` derive on the whole struct — storing
/// only projected keys (title/type/…) would corrupt search's arbitrary
/// frontmatter-key filtering and PATCH's byte-stable rendering.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Frontmatter {
    /// Ordered key table. The boolean marks entries written as scalars in
    /// the source (`key: value`); lists render back as block items and
    /// project as JSON arrays. Preserving order keeps PATCH rewrites
    /// byte-stable across idempotent reruns.
    fields: Vec<(String, Vec<String>, bool)>,
    /// Plain multiline scalars (e.g. long `description:` values continued
    /// on deeper-indented lines) folded into their full value, kept with
    /// the original source lines so `render()` reproduces them
    /// byte-for-byte — PATCH must not reformat keys it wasn't asked to
    /// touch. A `set_scalar` overwrite drops the entry (new value renders
    /// as one line). (key, folded full value, original lines including
    /// the `key: value` first line.)
    folded: Vec<(String, String, Vec<String>)>,
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
                let mut scalar = unquote(inline);
                // Plain multiline continuation: deeper-indented lines that
                // are neither list items nor new keys fold into the scalar
                // (single-space join, YAML plain-scalar folding). Without
                // this the continuation lines land in `skipped` — the value
                // loses its tail AND the PATCH endpoint rejects the whole
                // page (W4 multi-line description fix, 2026-10-15).
                let key_indent = indent_of(raw);
                let mut original_lines = vec![raw.to_string()];
                let mut folded = false;
                let mut j = i + 1;
                while j < lines.len() {
                    let next = lines[j];
                    let next_trimmed = next.trim();
                    if next_trimmed.is_empty()
                        || indent_of(next) <= key_indent
                        || next_trimmed.starts_with('-')
                        || split_key_line(next_trimmed).is_some()
                    {
                        break;
                    }
                    if !scalar.is_empty() {
                        scalar.push(' ');
                    }
                    scalar.push_str(next_trimmed);
                    original_lines.push(next.to_string());
                    folded = true;
                    j += 1;
                }
                if scalar.is_empty() {
                    // A value that is only quotes/comment noise still marks
                    // the key present; treat as empty scalar for honesty.
                    fm.fields.push((key, Vec::new(), true));
                } else {
                    if folded {
                        fm.folded
                            .push((key.clone(), scalar.clone(), original_lines));
                    }
                    fm.fields.push((key, vec![scalar], true));
                }
                i = j;
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
                    Some(value) => {
                        // A folded multiline scalar whose value hasn't been
                        // overwritten re-renders its original lines verbatim;
                        // set_scalar clears the fold entry, so an updated
                        // value falls through to the one-line form.
                        if let Some((_, folded_value, original)) = self
                            .folded
                            .iter()
                            .find(|(k, _, _)| k == key)
                        {
                            if folded_value == value {
                                for line in original {
                                    out.push_str(line);
                                    out.push('\n');
                                }
                                continue;
                            }
                        }
                        out.push_str(&format!("{key}: {}\n", quote_scalar(value)));
                    }
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
    /// existing keys (new keys append). An overwritten folded multiline
    /// scalar drops its fold record and renders as one line.
    pub fn set_scalar(&mut self, key: &str, value: &str) {
        self.folded.retain(|(k, _, _)| k != key);
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
        self.folded.retain(|(k, _, _)| k != key);
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

// ---- per-project page-metadata cache (plan W6.1, 2026-10-14) ----------
//
// The search / pages-query collection phase spent its whole P95 on pure
// metadata (probe, 21,558 pages, OS cache warm: walk 353ms + stat 449ms +
// 16KB head read 770ms ≈ 1570ms); scoring the filtered candidates is
// noise. The cache keeps one metadata walk per project — path plus
// head-parsed frontmatter — with the exact invalidation semantics of the
// graph snapshot cache: an order-independent mtime+size fingerprint, a 2s
// trust window so cache hits do zero I/O, single-flight rebuilds, plus
// proactive invalidation hooks on the wiki write paths.
//
// Red line: a cache hit must reproduce the uncached result
// byte-identically. That is why `PageMeta` carries `head_read_ok` /
// `head_closed`: the uncached consumers differ on those edges (search
// drops a page whose full-text read errors and re-parses an over-16KB
// frontmatter from the full text; pages/query keeps the page with an
// empty frontmatter), so the flags are stored, not resolved here.

/// Scan ceiling shared with the search walk — one definition so the cache
/// and the (uncached) search ceiling can never drift apart.
pub const MAX_META_SCAN_FILES: usize = 50_000;

#[derive(Debug, Clone)]
pub struct PageMeta {
    /// Project-relative path with `/` separators, same shape
    /// `relative_to_project` produces for the consumers.
    pub rel_path: String,
    /// Head-parse result. Empty when the head read errored OR the head
    /// showed no closed frontmatter block — both mean "no frontmatter"
    /// to pages/query; search re-parses the full text for unclosed heads.
    pub frontmatter: Frontmatter,
    /// False when the 16KB head read failed — search drops such pages
    /// (its uncached pipeline surfaces the same failure on the full-text
    /// read and returns None); pages/query keeps them.
    pub head_read_ok: bool,
    /// False when the head had no closing `---` — an over-16KB
    /// frontmatter must not get a page erroneously filter-dropped, so
    /// search re-parses the full text before filtering.
    pub head_closed: bool,
}

pub struct PageMetaIndex {
    entries: Vec<PageMeta>,
}

impl PageMetaIndex {
    pub fn entries(&self) -> &[PageMeta] {
        &self.entries
    }
}

struct PageMetaCacheEntry {
    fingerprint: u64,
    index: std::sync::Arc<PageMetaIndex>,
    fingerprint_at: std::time::Instant,
}

/// How long a verified fingerprint is trusted before the next cached
/// request re-walks the metadata — the same trade-off the graph snapshot
/// cache makes. Writes through this application invalidate proactively;
/// the window only covers out-of-band edits, which are then reflected at
/// worst TTL + one rebuild later. Raised 2s → 30s at the 50k-page library:
/// the metadata walk grew from ~150ms (4k pages, where 2s amortized well)
/// to ~600ms, so a 2s window made every request slower than the window
/// pay the full walk — the amortization inverted. 30s restores it; the
/// only behavior change is that raw-filesystem edits (scripts bypassing
/// the app) become visible up to 30s later.
const META_FINGERPRINT_TTL: std::time::Duration = std::time::Duration::from_secs(30);

static PAGE_META_CACHE: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, PageMetaCacheEntry>>,
> = std::sync::OnceLock::new();
static PAGE_META_BUILD_LOCKS: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, std::sync::Arc<std::sync::Mutex<()>>>>,
> = std::sync::OnceLock::new();

/// Order-independent fingerprint of the wiki tree: the commutative sum of
/// per-file (path, mtime, size) hashes, so WalkDir iteration order never
/// changes it. Same algorithm as the graph snapshot cache, except `.md`
/// matching is case-insensitive to cover every file the scan ceiling
/// admits (search's collection treats `.MD` as markdown too).
pub fn wiki_tree_fingerprint(wiki_root: &Path) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut acc: u64 = 0;
    for entry in walkdir::WalkDir::new(wiki_root).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file()
            || !entry
                .path()
                .extension()
                .and_then(|s| s.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
        {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let mut hasher = DefaultHasher::new();
        entry.path().to_string_lossy().hash(&mut hasher);
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        mtime.hash(&mut hasher);
        meta.len().hash(&mut hasher);
        acc = acc.wrapping_add(hasher.finish());
    }
    acc
}

/// One .md file as seen by the metadata walk: path plus the identity pair
/// the fingerprint and the persisted-index reuse decision are both built
/// from.
struct WalkedMetaFile {
    path: std::path::PathBuf,
    mtime_ns: u128,
    len: u64,
}

/// Single metadata walk over the wiki tree collecting every `*.md` file
/// (case-insensitive extension, same ceiling as the uncached search scan).
/// The same walk feeds the fingerprint and the incremental rebuild, so a
/// rebuild pays exactly one directory traversal instead of two.
fn walk_wiki_meta_files(wiki_root: &Path) -> (Vec<WalkedMetaFile>, bool) {
    let mut files = Vec::new();
    let mut ceiling_hit = false;
    if wiki_root.exists() {
        for entry in walkdir::WalkDir::new(wiki_root).into_iter().filter_map(Result::ok) {
            if !entry.file_type().is_file()
                || !entry
                    .path()
                    .extension()
                    .and_then(|s| s.to_str())
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
            {
                continue;
            }
            if files.len() >= MAX_META_SCAN_FILES {
                ceiling_hit = true;
                break;
            }
            let Ok(meta) = entry.metadata() else { continue };
            let mtime_ns = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            files.push(WalkedMetaFile {
                path: entry.path().to_path_buf(),
                mtime_ns,
                len: meta.len(),
            });
        }
    }
    (files, ceiling_hit)
}

/// Fingerprint of a walked file list. Per-file hash inputs (path, mtime,
/// size) and the commutative wrapping-sum accumulation are byte-identical
/// to the streaming `wiki_tree_fingerprint`, so the collected-walk value
/// and the streaming recheck value agree — asserted by test.
fn fingerprint_of_meta_walk(files: &[WalkedMetaFile]) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut acc: u64 = 0;
    for file in files {
        let mut hasher = DefaultHasher::new();
        file.path.to_string_lossy().hash(&mut hasher);
        file.mtime_ns.hash(&mut hasher);
        file.len.hash(&mut hasher);
        acc = acc.wrapping_add(hasher.finish());
    }
    acc
}

// ---- persisted page-meta index (cold-start plan, 2026-10-20) -----------
//
// The in-memory cache dies with the process, so every app start paid the
// full 50k-file head read before the knowledge tree could render. The
// index file mirrors the last build's PageMeta table under the app's own
// project state directory (`.llm-wiki/`; `.data/` is the user's snapshot
// area and is never touched). A rebuild reuses a persisted entry whenever
// (mtime_ns, size) still match — zero I/O for untouched pages — and only
// re-reads heads for new/changed files. Every field of the frontmatter is
// persisted (full Serialize on `Frontmatter`), keeping search's arbitrary
// key filtering and PATCH's byte-stable rendering exact.

#[derive(Serialize, Deserialize)]
struct PersistedPageMetaIndex {
    version: u32,
    project_path: String,
    entries: Vec<PersistedPageMeta>,
}

#[derive(Serialize, Deserialize)]
struct PersistedPageMeta {
    rel_path: String,
    /// Nanoseconds since the Unix epoch. u64 covers dates until 2262 —
    /// the in-memory walk keeps u128, persisted entries store the u64
    /// truncation consistently on both write and compare.
    mtime_ns: u64,
    size: u64,
    frontmatter: Frontmatter,
    head_read_ok: bool,
    head_closed: bool,
}

fn page_meta_index_path(project_path: &str) -> std::path::PathBuf {
    std::path::Path::new(project_path)
        .join(".llm-wiki")
        .join("page-meta-index.json")
}

/// Load the persisted index as a `rel_path -> (mtime_ns, size, PageMeta)`
/// table. Anything unexpected — missing file, parse error, wrong version,
/// wrong project — degrades to an empty table with a log line; the caller
/// then does one honest full rebuild and overwrites the file.
fn load_persisted_page_meta_index(
    project_path: &str,
) -> std::collections::HashMap<String, (u64, u64, PageMeta)> {
    let path = page_meta_index_path(project_path);
    let Ok(raw) = std::fs::read(&path) else {
        return std::collections::HashMap::new();
    };
    let parsed: PersistedPageMetaIndex = match serde_json::from_slice(&raw) {
        Ok(parsed) => parsed,
        Err(err) => {
            eprintln!(
                "[PageMeta] persisted index {} is unreadable ({err}); rebuilding from scratch",
                path.display()
            );
            return std::collections::HashMap::new();
        }
    };
    if parsed.version != 1 || parsed.project_path != project_path {
        eprintln!(
            "[PageMeta] persisted index {} (version {}, project {}) does not match this project; rebuilding from scratch",
            path.display(),
            parsed.version,
            parsed.project_path
        );
        return std::collections::HashMap::new();
    }
    parsed
        .entries
        .into_iter()
        .map(|entry| {
            let rel = entry.rel_path.clone();
            let meta = PageMeta {
                rel_path: entry.rel_path,
                frontmatter: entry.frontmatter,
                head_read_ok: entry.head_read_ok,
                head_closed: entry.head_closed,
            };
            (rel, (entry.mtime_ns, entry.size, meta))
        })
        .collect()
}

/// Atomic write-back of the index: serialize to a sibling `.tmp` file, then
/// rename over the target. A failure is logged and never blocks the caller —
/// the next rebuild simply writes again. `entries` and `files` are parallel
/// arrays (rayon's collect preserves order).
fn write_persisted_page_meta_index(project_path: &str, files: &[WalkedMetaFile], entries: &[PageMeta]) {
    let doc = PersistedPageMetaIndex {
        version: 1,
        project_path: project_path.to_string(),
        entries: files
            .iter()
            .zip(entries.iter())
            .map(|(file, meta)| PersistedPageMeta {
                rel_path: meta.rel_path.clone(),
                mtime_ns: file.mtime_ns as u64,
                size: file.len,
                frontmatter: meta.frontmatter.clone(),
                head_read_ok: meta.head_read_ok,
                head_closed: meta.head_closed,
            })
            .collect(),
    };
    let dir = std::path::Path::new(project_path).join(".llm-wiki");
    if let Err(err) = std::fs::create_dir_all(&dir) {
        eprintln!(
            "[PageMeta] could not create state dir {}: {err}",
            dir.display()
        );
        return;
    }
    let target = page_meta_index_path(project_path);
    let tmp = dir.join("page-meta-index.json.tmp");
    let write_result = match serde_json::to_vec(&doc) {
        Ok(bytes) => std::fs::write(&tmp, bytes).and_then(|_| std::fs::rename(&tmp, &target)),
        Err(err) => {
            eprintln!("[PageMeta] serializing index failed: {err}");
            return;
        }
    };
    if let Err(err) = write_result {
        eprintln!(
            "[PageMeta] persisting index to {} failed (next rebuild retries): {err}",
            target.display()
        );
        let _ = std::fs::remove_file(&tmp);
    }
}

/// Incremental build from an already-collected walk. Untouched pages reuse
/// their persisted `PageMeta` (zero page I/O); only new/changed files pay
/// the 16KB head read + parse. Returns the index and the fingerprint of the
/// same walk, so the caller caches both without a second traversal. The
/// walk ownership (ceiling log included) moves here from the caller.
fn build_page_meta_index_from_walk(
    project_path: &str,
    files: Vec<WalkedMetaFile>,
    ceiling_hit: bool,
) -> (std::sync::Arc<PageMetaIndex>, u64) {
    if ceiling_hit {
        eprintln!(
            "[PageMeta] stopped scanning wiki after {MAX_META_SCAN_FILES} markdown files in {project_path}"
        );
    }
    let fingerprint = fingerprint_of_meta_walk(&files);
    let (persisted, loaded_from_disk) = {
        let table = load_persisted_page_meta_index(project_path);
        let loaded = !table.is_empty();
        (table, loaded)
    };
    let parsed: Vec<(PageMeta, bool)> = files
        .par_iter()
        .map(|file| {
            let rel_path = relative_to_project(project_path, &file.path);
            if let Some((mtime_ns, size, meta)) = persisted.get(&rel_path) {
                if *mtime_ns == file.mtime_ns as u64 && *size == file.len {
                    return (meta.clone(), true);
                }
            }
            let page = match read_head(&file.path, DEFAULT_HEAD_BYTES) {
                Ok(head) => match split_frontmatter(&head) {
                    Some((_, block)) => PageMeta {
                        rel_path,
                        frontmatter: Frontmatter::parse(block),
                        head_read_ok: true,
                        head_closed: true,
                    },
                    None => PageMeta {
                        rel_path,
                        frontmatter: Frontmatter::default(),
                        head_read_ok: true,
                        head_closed: false,
                    },
                },
                Err(_) => PageMeta {
                    rel_path,
                    frontmatter: Frontmatter::default(),
                    head_read_ok: false,
                    head_closed: false,
                },
            };
            (page, false)
        })
        .collect();
    let reused = parsed.iter().filter(|(_, hit)| *hit).count();
    let entries: Vec<PageMeta> = parsed.into_iter().map(|(meta, _)| meta).collect();
    // An all-reuse rebuild would rewrite the index byte-identically — the
    // file on disk already IS this state, so skip the 50MB churn. Any
    // change (or a missing/garbage/mismatched file, which loads as an
    // empty table) writes the full index back atomically.
    if loaded_from_disk && reused == files.len() {
        return (std::sync::Arc::new(PageMetaIndex { entries }), fingerprint);
    }
    write_persisted_page_meta_index(project_path, &files, &entries);
    (std::sync::Arc::new(PageMetaIndex { entries }), fingerprint)
}

/// Walk + incremental build against the persisted index.
fn build_page_meta_index(project_path: &str) -> (std::sync::Arc<PageMetaIndex>, u64) {
    let wiki_root = std::path::Path::new(project_path).join("wiki");
    let (files, ceiling_hit) = walk_wiki_meta_files(&wiki_root);
    build_page_meta_index_from_walk(project_path, files, ceiling_hit)
}

/// Cached metadata index with graph-snapshot-cache semantics: trust a
/// fingerprint verified within the TTL, re-verify it (one metadata walk)
/// after that, rebuild incrementally on mismatch (persisted-index reuse,
/// only changed files re-read), single-flight concurrent rebuilds.
pub fn page_meta_index_cached(project_path: &str) -> std::sync::Arc<PageMetaIndex> {
    page_meta_index_cached_with_ttl(project_path, META_FINGERPRINT_TTL)
}

fn page_meta_index_cached_with_ttl(
    project_path: &str,
    ttl: std::time::Duration,
) -> std::sync::Arc<PageMetaIndex> {
    // Fast path: a fingerprint verified within the TTL is trusted as-is,
    // skipping the metadata walk entirely.
    let cache = PAGE_META_CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
    if ttl > std::time::Duration::ZERO {
        if let Ok(entries) = cache.lock() {
            if let Some(entry) = entries.get(std::path::Path::new(project_path)) {
                if entry.fingerprint_at.elapsed() < ttl {
                    return entry.index.clone();
                }
            }
        }
    }

    // One metadata walk feeds both the fingerprint recheck and (on a miss)
    // the incremental rebuild — the plan's single-traversal shape. WalkDir
    // order variance cannot change the fingerprint (commutative sum), and
    // on a recheck hit the collected list is simply dropped.
    let (files, ceiling_hit) = walk_wiki_meta_files(&std::path::Path::new(project_path).join("wiki"));
    let fingerprint = fingerprint_of_meta_walk(&files);
    let try_hit = |cache: &std::sync::Mutex<
        std::collections::HashMap<std::path::PathBuf, PageMetaCacheEntry>,
    >| {
        let mut entries = cache.lock().ok()?;
        let entry = entries.get_mut(std::path::Path::new(project_path))?;
        if entry.fingerprint != fingerprint {
            return None;
        }
        entry.fingerprint_at = std::time::Instant::now();
        Some(entry.index.clone())
    };
    if let Some(index) = try_hit(cache) {
        return index;
    }

    // Miss. Per-project build lock: concurrent misses for one project
    // don't each pay the full walk; the follower re-checks after winner.
    let build_locks = PAGE_META_BUILD_LOCKS
        .get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
    let build_lock = {
        let mut locks = build_locks.lock().unwrap_or_else(|e| e.into_inner());
        locks
            .entry(std::path::PathBuf::from(project_path))
            .or_insert_with(|| std::sync::Arc::new(std::sync::Mutex::new(())))
            .clone()
    };
    let _guard = build_lock.lock().unwrap_or_else(|e| e.into_inner());

    if let Some(index) = try_hit(cache) {
        return index;
    }

    // Build (incremental against the persisted on-disk index) and cache the
    // result. The fingerprint stored with the entry comes from the same
    // walk the index was built from, so a follower that raced a write
    // simply sees a mismatch on its next recheck and rebuilds.
    let (index, fingerprint) = build_page_meta_index_from_walk(project_path, files, ceiling_hit);
    if let Ok(mut entries) = cache.lock() {
        entries.insert(
            std::path::PathBuf::from(project_path),
            PageMetaCacheEntry {
                fingerprint,
                index: index.clone(),
                fingerprint_at: std::time::Instant::now(),
            },
        );
    }
    index
}

/// Proactive invalidation for the guarded wiki write paths (agent tools,
/// pages/write, PATCH frontmatter): the very next search / pages-query
/// request rebuilds, no TTL staleness for writes this app made itself.
pub fn invalidate_page_meta_cache(project_path: &str) {
    let Some(cache) = PAGE_META_CACHE.get() else { return };
    if let Ok(mut entries) = cache.lock() {
        entries.remove(std::path::Path::new(project_path));
    }
}

/// Invalidation for the raw fs write commands, which only know an
/// absolute path: drop the cache of every project whose `wiki/` tree the
/// written markdown file lives under. Non-markdown writes return without
/// touching the cache lock (ingest writes plenty of non-wiki files).
pub fn invalidate_page_meta_cache_covering(abs_path: &Path) {
    if abs_path
        .extension()
        .and_then(|s| s.to_str())
        .is_none_or(|ext| !ext.eq_ignore_ascii_case("md"))
    {
        return;
    }
    let Some(cache) = PAGE_META_CACHE.get() else { return };
    let Ok(mut entries) = cache.lock() else { return };
    let projects: Vec<std::path::PathBuf> = entries.keys().cloned().collect();
    for project in projects {
        let wiki_root = project.join("wiki");
        if abs_path.starts_with(&wiki_root) {
            entries.remove(&project);
        }
    }
}

/// Same shape as the private helpers in commands/search.rs and
/// api_server.rs — the cached rel_path must be byte-identical to what
/// those consumers produce on their uncached path.
fn relative_to_project(project_path: &str, path: &Path) -> String {
    let root = Path::new(project_path);
    path.strip_prefix(root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.to_string_lossy().replace('\\', "/"))
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
    fn parse_folds_plain_multiline_scalar() {
        // Real production shape (portable 知识库 regulation page): a long
        // description continued on deeper-indented lines. Before the fix
        // the continuation lines went to `skipped` (value lost its tail,
        // PATCH rejected the page with 422).
        let block = "type: regulation\ndescription: 首行值，\n  续行一内容，\n  续行二内容。\nstatus: 现行有效\n";
        let fm = Frontmatter::parse(block);
        assert!(fm.skipped_lines().is_empty());
        assert_eq!(
            fm.get("description"),
            Some(&["首行值， 续行一内容， 续行二内容。".to_string()][..])
        );
        assert_eq!(fm.get("status"), Some(&["现行有效".to_string()][..]));
    }

    #[test]
    fn render_reproduces_folded_scalar_verbatim() {
        let block = "type: regulation\ndescription: 首行值，\n  续行一内容，\n  续行二内容。\nstatus: 现行有效\n";
        let fm = Frontmatter::parse(block);
        // Untouched keys keep their byte form — PATCH must not reformat
        // the folded description into one line.
        assert_eq!(fm.render(), block);
    }

    #[test]
    fn set_scalar_on_folded_key_renders_one_line() {
        let block = "description: 首行值，\n  续行内容。\nstatus: 现行有效\n";
        let mut fm = Frontmatter::parse(block);
        fm.set_scalar("description", "新值一行");
        assert_eq!(
            fm.render(),
            "description: 新值一行\nstatus: 现行有效\n"
        );
        // Removing the key drops the fold record with it.
        let mut fm2 = Frontmatter::parse(block);
        fm2.remove_key("description");
        assert_eq!(fm2.render(), "status: 现行有效\n");
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

    // ---- page-metadata cache (W6.1) ------------------------------------

    fn meta_cache_fixture(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "llm-wiki-fm-meta-{}-{tag}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let wiki = dir.join("wiki").join("cases");
        std::fs::create_dir_all(&wiki).unwrap();
        std::fs::write(
            wiki.join("normal.md"),
            "---\ntype: case\ntitle: 正常\n---\n# 正文\n",
        )
        .unwrap();
        std::fs::write(wiki.join("bare.md"), "# 没有 frontmatter\n").unwrap();
        // Closed frontmatter well past the 16KB head budget: the head must
        // report head_closed=false so search re-parses the full text.
        let big = format!("---\ntitle: {}\n---\n正文", "长".repeat(10 * 1024));
        std::fs::write(wiki.join("big.md"), big).unwrap();
        dir
    }

    #[test]
    fn meta_cache_build_parses_heads_and_flags_edges() {
        let dir = meta_cache_fixture("build");
        let project = dir.to_string_lossy().to_string();
        let (index, _fingerprint) = build_page_meta_index(&project);
        let find = |suffix: &str| {
            index
                .entries()
                .iter()
                .find(|m| m.rel_path.ends_with(suffix))
                .unwrap_or_else(|| panic!("missing {suffix}"))
        };
        let normal = find("normal.md");
        assert!(normal.head_read_ok && normal.head_closed);
        assert_eq!(normal.frontmatter.get("type"), Some(&["case".to_string()][..]));
        // Bare page: readable head, no frontmatter block, empty fields.
        let bare = find("bare.md");
        assert!(bare.head_read_ok && !bare.head_closed);
        assert_eq!(bare.frontmatter.get("type"), None);
        // Over-16KB frontmatter: head read ok but no closing delimiter in
        // the head window — search must re-parse the full text.
        let big = find("big.md");
        assert!(big.head_read_ok && !big.head_closed);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn meta_cache_ttl_hit_rebuild_and_invalidate_hooks() {
        use std::sync::Arc;
        use std::time::Duration;
        let dir = meta_cache_fixture("ttl");
        let project = dir.to_string_lossy().to_string();
        let cached = || page_meta_index_cached_with_ttl(&project, Duration::from_secs(2));

        // Build, then a TTL-window hit returns the SAME snapshot — zero
        // rebuild, zero metadata I/O.
        let first = cached();
        let second = cached();
        assert!(Arc::ptr_eq(&first, &second));

        // Proactive invalidation drops the entry even inside the TTL
        // window (guarded write paths rely on this).
        invalidate_page_meta_cache(&project);
        let third = cached();
        assert!(!Arc::ptr_eq(&first, &third));

        // Absolute-path invalidation: a markdown write under the
        // project's wiki/ drops the entry …
        let fourth = cached();
        let md_abs = dir.join("wiki").join("cases").join("new.md");
        std::fs::write(&md_abs, "---\ntype: case\n---\n新页").unwrap();
        invalidate_page_meta_cache_covering(&md_abs);
        let fifth = cached();
        assert!(!Arc::ptr_eq(&fourth, &fifth));
        assert!(fifth.entries().iter().any(|m| m.rel_path.ends_with("new.md")));

        // … a non-markdown write must not.
        let raw = dir.join("raw");
        std::fs::create_dir_all(&raw).unwrap();
        let pdf = raw.join("x.pdf");
        std::fs::write(&pdf, b"pdf-bytes").unwrap();
        invalidate_page_meta_cache_covering(&pdf);
        let sixth = cached();
        assert!(Arc::ptr_eq(&fifth, &sixth));

        // Out-of-band edit (no hook): the fingerprint recheck after the
        // TTL — ttl=0 forces it on this call — sees the changed tree and
        // rebuilds, so staleness is bounded by TTL + one rebuild.
        std::fs::write(&md_abs, "---\ntype: case\nyear: 2026\n---\n改写变长").unwrap();
        let seventh = page_meta_index_cached_with_ttl(&project, Duration::ZERO);
        assert!(!Arc::ptr_eq(&sixth, &seventh));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn frontmatter_serde_round_trip_preserves_everything() {
        let block = "type: case\ntitle: 页面\ndescription: 首行值，\n  续行内容。\ntags: [\"a\", \"b\"]\nyear: 2025\nnested:\n  sub: 值\n";
        let fm = Frontmatter::parse(block);
        let bytes = serde_json::to_vec(&fm).unwrap();
        let de: Frontmatter = serde_json::from_slice(&bytes).unwrap();
        // PartialEq covers the full field table, folds and skipped lines.
        assert_eq!(fm, de);
        // The byte-stable PATCH rendering survives the round trip too.
        assert_eq!(de.render(), fm.render());
        let keys: Vec<&str> = de.keys().collect();
        // `sub` lands in fields too: the parser records the nested parent in
        // skipped and keeps scanning from the sub-key line (existing parse
        // semantics — the round trip must preserve it either way).
        assert_eq!(keys, vec!["type", "title", "description", "tags", "year", "sub"]);
        assert_eq!(de.skipped_lines(), &["nested".to_string()]);
        assert_eq!(
            de.get("description"),
            Some(&["首行值， 续行内容。".to_string()][..])
        );
    }

    #[test]
    fn fingerprint_of_meta_walk_matches_streaming_fingerprint() {
        let dir = meta_cache_fixture("fingerprint");
        let wiki_root = dir.join("wiki");
        let (files, ceiling) = walk_wiki_meta_files(&wiki_root);
        assert!(!ceiling);
        assert_eq!(files.len(), 3);
        assert_eq!(
            fingerprint_of_meta_walk(&files),
            wiki_tree_fingerprint(&wiki_root)
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn meta_index_persists_and_rebuilds_incrementally() {
        use std::time::Duration;
        let dir = meta_cache_fixture("persist");
        // Forward-slash form so the persisted `project_path` round-trips
        // through serde_json without backslash escaping.
        let project = dir.to_string_lossy().replace('\\', "/");
        let cached = || page_meta_index_cached_with_ttl(&project, Duration::ZERO);
        fn find<'a>(index: &'a PageMetaIndex, suffix: &str) -> &'a PageMeta {
            index
                .entries()
                .iter()
                .find(|m| m.rel_path.ends_with(suffix))
                .unwrap_or_else(|| panic!("missing {suffix}"))
        }

        // Cold build writes the index file under the app's own state dir.
        let first = cached();
        assert_eq!(first.entries().len(), 3);
        let index_path = page_meta_index_path(&project);
        assert!(index_path.exists());
        let raw = std::fs::read_to_string(&index_path).unwrap();
        assert!(raw.contains("\"version\":1"));
        assert!(raw.contains("normal.md"));

        // No-op rebuild (cache dropped, files untouched): every row must be
        // byte-equal to the first build — the persisted entries are reused,
        // not re-parsed.
        invalidate_page_meta_cache(&project);
        let second = cached();
        assert_eq!(second.entries().len(), 3);
        for entry in first.entries() {
            let reused = find(&second, &entry.rel_path);
            assert_eq!(reused.frontmatter, entry.frontmatter);
            assert_eq!(reused.head_read_ok, entry.head_read_ok);
            assert_eq!(reused.head_closed, entry.head_closed);
        }

        // Modify one file (different size so mtime granularity can't hide
        // it), add one, delete one — the rebuild must pick up exactly those
        // three and leave the rest at their persisted values.
        std::fs::write(
            dir.join("wiki").join("cases").join("normal.md"),
            "---\ntype: case\ntitle: 改过\nyear: 2026\n---\n正文变长了",
        )
        .unwrap();
        std::fs::write(
            dir.join("wiki").join("cases").join("added.md"),
            "---\ntype: concept\n---\n新页",
        )
        .unwrap();
        std::fs::remove_file(dir.join("wiki").join("cases").join("bare.md")).unwrap();
        invalidate_page_meta_cache(&project);
        let third = cached();
        assert_eq!(third.entries().len(), 3);
        let normal = find(&third, "normal.md");
        assert_eq!(normal.frontmatter.get("year"), Some(&["2026".to_string()][..]));
        assert_eq!(normal.frontmatter.get("title"), Some(&["改过".to_string()][..]));
        let added = find(&third, "added.md");
        assert_eq!(added.frontmatter.get("type"), Some(&["concept".to_string()][..]));
        assert!(third.entries().iter().all(|m| !m.rel_path.ends_with("bare.md")));
        // Untouched page kept its exact persisted shape (incl. the over-16KB
        // flag edge, which the incremental path must not lose).
        assert!(find(&third, "big.md").head_read_ok && !find(&third, "big.md").head_closed);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn meta_index_corrupt_persisted_file_falls_back_to_full_rebuild() {
        use std::time::Duration;
        let dir = meta_cache_fixture("corrupt");
        let project = dir.to_string_lossy().replace('\\', "/");
        let index_path = page_meta_index_path(&project);
        page_meta_index_cached_with_ttl(&project, Duration::ZERO);
        assert!(index_path.exists());

        std::fs::write(&index_path, b"\x00garbage not json{").unwrap();
        invalidate_page_meta_cache(&project);
        let rebuilt = page_meta_index_cached_with_ttl(&project, Duration::ZERO);
        assert_eq!(rebuilt.entries().len(), 3);
        assert!(rebuilt
            .entries()
            .iter()
            .any(|m| m.frontmatter.get("type") == Some(&["case".to_string()][..])));
        // The rewrite replaced the garbage with a valid index.
        let raw = std::fs::read_to_string(&index_path).unwrap();
        assert!(raw.contains("\"version\":1"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn meta_index_version_or_project_mismatch_is_ignored() {
        use std::time::Duration;
        let dir = meta_cache_fixture("mismatch");
        // Forward-slash form so the persisted `project_path` round-trips
        // through serde_json without backslash escaping.
        let project = dir.to_string_lossy().replace('\\', "/");
        let index_path = page_meta_index_path(&project);
        page_meta_index_cached_with_ttl(&project, Duration::ZERO);

        // Wrong version.
        let raw = std::fs::read_to_string(&index_path).unwrap();
        let wrong_version = raw.replace("\"version\":1", "\"version\":2");
        std::fs::write(&index_path, wrong_version).unwrap();
        invalidate_page_meta_cache(&project);
        let rebuilt = page_meta_index_cached_with_ttl(&project, Duration::ZERO);
        assert_eq!(rebuilt.entries().len(), 3);

        // Wrong project path (someone copied the file across projects).
        let wrong_project = raw.replace(
            &format!("\"project_path\":\"{project}\""),
            "\"project_path\":\"C:/elsewhere/wiki-lib\"",
        );
        std::fs::write(&index_path, wrong_project).unwrap();
        invalidate_page_meta_cache(&project);
        let rebuilt = page_meta_index_cached_with_ttl(&project, Duration::ZERO);
        assert_eq!(rebuilt.entries().len(), 3);
        let raw = std::fs::read_to_string(&index_path).unwrap();
        assert!(raw.contains(&project));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn meta_index_concurrent_first_builds_share_single_flight() {
        use std::sync::Arc;
        use std::time::Duration;
        let dir = meta_cache_fixture("concurrent");
        let project = dir.to_string_lossy().replace('\\', "/");
        let barrier = Arc::new(std::sync::Barrier::new(4));
        let handles: Vec<_> = (0..4)
            .map(|_| {
                let barrier = barrier.clone();
                let project = project.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    page_meta_index_cached_with_ttl(&project, Duration::ZERO)
                })
            })
            .collect();
        let mut expected: Option<Vec<String>> = None;
        for handle in handles {
            let index = handle.join().unwrap();
            let mut rels: Vec<String> = index
                .entries()
                .iter()
                .map(|m| m.rel_path.clone())
                .collect();
            rels.sort();
            match &expected {
                None => expected = Some(rels),
                Some(prev) => assert_eq!(&rels, prev),
            }
        }
        assert_eq!(expected.unwrap().len(), 3);
        let _ = std::fs::remove_dir_all(dir);
    }

    // ---- live measurement harness (plan 2026-10-20 §2.4) ----------------
    //
    // `cargo test --lib page_meta_bench_live --release -- --ignored --nocapture`
    // with PAGE_META_BENCH_PROJECT pointing at a (large) wiki project.
    // Read-only against the wiki tree; the only file it may create or
    // delete is the app's own `.llm-wiki/page-meta-index.json`.
    // PAGE_META_BENCH_FRESH=1 deletes the persisted index first, turning
    // the run into a from-scratch full rebuild (cold-start shape).

    #[test]
    #[ignore]
    fn page_meta_bench_live() {
        let project = std::env::var("PAGE_META_BENCH_PROJECT")
            .expect("PAGE_META_BENCH_PROJECT must point at a wiki project");
        let fresh = std::env::var("PAGE_META_BENCH_FRESH").ok().as_deref() == Some("1");
        let label = std::env::var("PAGE_META_BENCH_LABEL").unwrap_or_default();
        let index_path = std::path::Path::new(&project)
            .join(".llm-wiki")
            .join("page-meta-index.json");
        if fresh {
            match std::fs::remove_file(&index_path) {
                Ok(()) => println!("[bench] deleted persisted index (cold full rebuild)"),
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                Err(err) => panic!("could not delete index: {err}"),
            }
        } else {
            println!(
                "[bench] persisted index present: {}",
                index_path.exists()
            );
        }

        // Walk-only cost (the fingerprint recheck every TTL-expired request
        // pays even on an all-reuse rebuild).
        let t_walk = std::time::Instant::now();
        let fp = wiki_tree_fingerprint(&std::path::Path::new(&project).join("wiki"));
        println!("[bench] label={label} fingerprint_walk={:?} fp={fp}", t_walk.elapsed());

        // Cold process → in-memory cache is empty → the first call is the
        // full build path (persisted-index reuse when the file exists).
        let t_build = std::time::Instant::now();
        let index = page_meta_index_cached(&project);
        let build = t_build.elapsed();

        // Second call inside the TTL window: pure memory hit.
        let t_hit = std::time::Instant::now();
        let again = page_meta_index_cached(&project);
        let hit = t_hit.elapsed();

        println!(
            "[bench] label={label} entries={} build={build:?} memory_hit={hit:?} fresh={fresh}",
            index.entries().len()
        );
        // Optional: print one entry's parsed frontmatter so a scripted
        // out-of-band edit between runs can prove it landed in the index.
        if let Ok(probe) = std::env::var("PAGE_META_BENCH_PROBE_REL") {
            match index.entries().iter().find(|m| m.rel_path == probe) {
                Some(meta) => {
                    let value =
                        |key: &str| {
                            meta.frontmatter
                                .get(key)
                                .and_then(|v| v.first())
                                .cloned()
                                .unwrap_or_default()
                        };
                    println!(
                        "[bench] probe rel={probe} type={:?} title={:?} head_read_ok={} head_closed={}",
                        value("type"),
                        value("title"),
                        meta.head_read_ok,
                        meta.head_closed
                    );
                }
                None => println!("[bench] probe rel={probe} NOT FOUND"),
            }
        }
        assert!(std::sync::Arc::ptr_eq(&index, &again));
    }
}
