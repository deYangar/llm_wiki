//! Maintenance bin: backfill page-level embedding revision fingerprints
//! (module A Step 9, 2026-10-27 R3 decisions).
//!
//! The revision fingerprint mechanism (`vector_page_revision_match`) enables
//! the incremental short-circuit "single page edit re-embeds only that page",
//! but only ~4% of pages carry a fingerprint — the rest always re-embed.
//! This bin backfills fingerprints for pages whose existing vector rows were
//! verified against the on-disk content, at zero embedding cost.
//!
//! Per page (walking wiki/**/*.md, skipping index/log/overview like the embed
//! endpoint):
//!   revision    = sha256 of the whole file bytes (same as embed endpoint)
//!   fingerprint = embedding_fingerprint(revision, config)
//!   - no vector rows       -> unembedded-pages.jsonl (historical silent
//!                             embed failures; repair lane is embed force)
//!   - rows match content   -> save_revision (backfill)
//!   - rows don't match     -> mismatch-pages.jsonl (content changed after
//!                             embedding; repair lane is embed force)
//!
//! Match is the two-layer reconciliation from the plan: L1 — every chunk_text
//! (whitespace-normalized) is a substring of the full file content; L2 — else
//! of the content with the frontmatter block stripped (pages whose frontmatter
//! was PATCHed after embedding: vectors carry the old frontmatter, body is
//! unchanged). Both TS and Rust embedding channels chunk the file content
//! sequentially, so L1/L2 hold across channels.
//!
//! Config defaults to the app-state.json `embeddingConfig` (same source as the
//! live embed endpoint) and can be overridden by flags for tests. A wrong
//! config only causes future false misses (re-embed), never silent loss.
//!
//! Usage (app stopped or read-tolerant; the bin only takes the v2 read lock
//! briefly and writes revision files, never LanceDB rows):
//!   cargo run --bin lance-fingerprint-backfill -- C:/library/wiki [--apply]
//!   cargo run --bin lance-fingerprint-backfill -- <dir> --endpoint E --model M --apply

use std::path::{Path, PathBuf};

use llm_wiki_lib::commands::search::SearchEmbeddingConfig;

#[derive(Debug, Default, serde::Serialize)]
struct Report {
    scanned: usize,
    skipped_aggregate: usize,
    backfilled: usize,
    already_current: usize,
    unembedded: usize,
    mismatch: usize,
    vector_pages_total: usize,
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut project_path: Option<String> = None;
    let mut apply = false;
    let mut endpoint: Option<String> = None;
    let mut model: Option<String> = None;
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--apply" => apply = true,
            "--endpoint" => {
                i += 1;
                endpoint = args.get(i).cloned();
            }
            "--model" => {
                i += 1;
                model = args.get(i).cloned();
            }
            other if !other.starts_with("--") => project_path = Some(other.to_string()),
            other => {
                eprintln!("unknown flag: {other}");
                std::process::exit(2);
            }
        }
        i += 1;
    }
    let Some(project_path) = project_path else {
        eprintln!(
            "usage: lance-fingerprint-backfill <project_path> [--apply] [--endpoint E --model M]"
        );
        std::process::exit(2);
    };

    let mut config = load_config_from_app_state().unwrap_or_else(|| {
        eprintln!("[warn] app-state.json embeddingConfig unreadable — using empty config");
        SearchEmbeddingConfig {
            enabled: false,
            endpoint: String::new(),
            api_key: String::new(),
            model: String::new(),
            output_dimensionality: None,
            extra_headers: None,
            max_chunk_chars: None,
            overlap_chunk_chars: None,
        }
    });
    if let Some(e) = endpoint {
        config.endpoint = e;
    }
    if let Some(m) = model {
        config.model = m;
    }
    println!(
        "config: endpoint={} model={} dim={:?} maxChunkChars={:?}",
        config.endpoint,
        config.model,
        config.output_dimensionality,
        config.max_chunk_chars
    );

    match run(&project_path, &config, apply).await {
        Ok(report) => {
            println!("{}", serde_json::to_string_pretty(&report).unwrap());
            if !apply {
                println!("[dry-run] no revision files written; rerun with --apply");
            }
        }
        Err(e) => {
            eprintln!("[error] {e}");
            std::process::exit(1);
        }
    }
}

fn load_config_from_app_state() -> Option<SearchEmbeddingConfig> {
    let path = app_state_path()?;
    let parsed: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    let value = parsed.get("embeddingConfig")?.clone();
    serde_json::from_value(value).ok()
}

/// Same file the running app reads (`app_data_dir()/app-state.json`); the
/// identifier is com.llmwiki.app so the dir lives under Roaming.
fn app_state_path() -> Option<PathBuf> {
    let roaming = std::env::var("APPDATA").ok()?;
    Some(PathBuf::from(roaming).join("com.llmwiki.app").join("app-state.json"))
}

async fn run(project_path: &str, config: &SearchEmbeddingConfig, apply: bool) -> Result<Report, String> {
    let chunks_by_page =
        llm_wiki_lib::commands::vectorstore::read_page_chunk_texts(project_path).await?;
    let mut report = Report {
        vector_pages_total: chunks_by_page.len(),
        ..Report::default()
    };
    let out_dir = Path::new(project_path).join(".llm-wiki");
    let mut unembedded: Vec<serde_json::Value> = Vec::new();
    let mut mismatch: Vec<serde_json::Value> = Vec::new();

    let wiki = Path::new(project_path).join("wiki");
    let mut files: Vec<PathBuf> = Vec::new();
    collect_md_files(&wiki, &mut files);
    files.sort();

    for file in files {
        let rel = file.strip_prefix(&wiki).unwrap_or(&file).to_string_lossy().replace('\\', "/");
        let page_id = rel.strip_suffix(".md").unwrap_or(&rel).trim_matches('/').to_string();
        let stem = page_id.rsplit('/').next().unwrap_or(&page_id).to_ascii_lowercase();
        if matches!(stem.as_str(), "index" | "log" | "overview") {
            report.skipped_aggregate += 1;
            continue;
        }
        report.scanned += 1;
        let Ok(content) = std::fs::read(&file) else {
            mismatch.push(serde_json::json!({"pageId": page_id, "reason": "unreadable file"}));
            report.mismatch += 1;
            continue;
        };
        let Some(rows) = chunks_by_page.get(&page_id) else {
            // v1 bare-stem rows: page dirs make ids qualified; bare-stem
            // leftovers for this file stem also count as its rows.
            let bare = page_id.rsplit('/').next().unwrap_or(&page_id).to_string();
            if chunks_by_page.get(&bare).is_some() {
                // legacy stem rows exist; not our backfill target (stem
                // migration lane owns them), record as mismatch-by-legacy.
                mismatch.push(serde_json::json!({"pageId": page_id, "reason": "legacy stem rows", "stem": bare}));
                report.mismatch += 1;
                continue;
            }
            unembedded.push(serde_json::json!({"pageId": page_id, "path": rel}));
            report.unembedded += 1;
            continue;
        };
        let content_str = String::from_utf8_lossy(&content).to_string();
        let normalized = normalize_ws(&content_str);
        let body_only = strip_frontmatter(&content_str);
        let body_normalized = normalize_ws(&body_only);
        let matched = rows.iter().all(|chunk| {
            let c = normalize_ws(chunk);
            normalized.contains(&c) || body_normalized.contains(&c)
        });
        if !matched {
            mismatch.push(serde_json::json!({
                "pageId": page_id,
                "path": rel,
                "chunks": rows.len(),
                "firstChunkHead": rows.first().map(|s| s.chars().take(40).collect::<String>()).unwrap_or_default(),
            }));
            report.mismatch += 1;
            continue;
        }
        let revision = format!("sha256:{}", sha256_hex(&content));
        let fingerprint = llm_wiki_lib::commands::page_embedding::fingerprint_for_backfill(
            &revision, config,
        );
        let existing = llm_wiki_lib::commands::page_embedding::load_revision(project_path, &page_id);
        if existing.as_deref() == Some(fingerprint.as_str()) {
            report.already_current += 1;
            continue;
        }
        if apply {
            llm_wiki_lib::commands::page_embedding::save_revision(project_path, &page_id, &fingerprint)?;
        }
        report.backfilled += 1;
    }

    if apply || !unembedded.is_empty() || !mismatch.is_empty() {
        let ue = out_dir.join("unembedded-pages.jsonl");
        let mm = out_dir.join("mismatch-pages.jsonl");
        // Always (re)write the lists when running for real; dry-run lists go
        // next to stdout only — write them regardless so the plan's "dry-run
        // produces the lists" step works without --apply.
        write_jsonl(&ue, &unembedded)?;
        write_jsonl(&mm, &mismatch)?;
    }
    Ok(report)
}

fn write_jsonl(path: &Path, rows: &[serde_json::Value]) -> Result<(), String> {
    use std::io::Write;
    let mut f = std::fs::File::create(path).map_err(|e| format!("write {}: {e}", path.display()))?;
    for row in rows {
        serde_json::to_writer(&mut f, row).map_err(|e| e.to_string())?;
        writeln!(f).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn collect_md_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_md_files(&path, out);
        } else if path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("md"))
        {
            out.push(path);
        }
    }
}

fn normalize_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn strip_frontmatter(content: &str) -> String {
    if !content.starts_with("---") {
        return content.to_string();
    }
    let rest = &content[3..];
    let Some(end) = rest.find("\n---") else {
        return content.to_string();
    };
    rest[end + 4..].to_string()
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for b in digest {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> SearchEmbeddingConfig {
        SearchEmbeddingConfig {
            enabled: true,
            endpoint: "https://example.test".into(),
            api_key: "k".into(),
            model: "m".into(),
            output_dimensionality: None,
            extra_headers: None,
            max_chunk_chars: None,
            overlap_chunk_chars: None,
        }
    }

    fn tmp_project(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "fp-backfill-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(p.join("wiki/questions")).unwrap();
        p
    }

    fn make_chunks(texts: &[&str]) -> Vec<llm_wiki_lib::commands::vectorstore::ChunkUpsertInput> {
        texts
            .iter()
            .enumerate()
            .map(|(i, t)| llm_wiki_lib::commands::vectorstore::ChunkUpsertInput {
                chunk_index: i as u32,
                chunk_text: (*t).to_string(),
                heading_path: format!("## H{i}"),
                embedding: (0..16)
                    .map(|k| ((i as u32).wrapping_mul(2654435761) ^ (k as u32)) as f32 / u32::MAX as f32)
                    .collect(),
            })
            .collect()
    }

    /// ① 页无向量行 → unembedded；② frontmatter 变过 → L2 命中回填；
    /// ③ 正文变过 → mismatch；④ index/log/overview 跳过；⑤ dry-run 零写盘。
    #[tokio::test]
    async fn backfill_classifies_pages_correctly() {
        let root = tmp_project("classify");
        let pp = root.to_string_lossy().to_string();

        // A: 无向量行 → unembedded
        std::fs::write(root.join("wiki/questions/a.md"), "---\ntype: question\ntitle: A\n---\n\nA 页正文内容。\n").unwrap();
        // B: 向量 = 正文两块（frontmatter 后被 PATCH 改过：向量含旧 frontmatter）
        std::fs::write(root.join("wiki/questions/b.md"), "---\ntype: question\ntitle: B2\n---\n\nB 页第一块。\n\nB 页第二块。\n").unwrap();
        llm_wiki_lib::commands::vectorstore::vector_upsert_chunks(
            pp.clone(),
            "questions/b".into(),
            make_chunks(&["B 页第一块。", "B 页第二块。"]),
        )
        .await
        .unwrap();
        // C: 向量 = 旧正文（正文真改过）→ mismatch
        std::fs::write(root.join("wiki/questions/c.md"), "---\ntype: question\ntitle: C\n---\n\nC 页全新正文。\n").unwrap();
        llm_wiki_lib::commands::vectorstore::vector_upsert_chunks(
            pp.clone(),
            "questions/c".into(),
            make_chunks(&["C 页旧正文第一段。", "C 页旧正文第二段。"]),
        )
        .await
        .unwrap();
        // D: index 聚合页（无向量也跳过）
        std::fs::write(root.join("wiki/questions/index.md"), "# Index\n").unwrap();

        // dry-run：分类正确 + 零写盘
        let report = run(&pp, &config(), false).await.unwrap();
        assert_eq!(report.scanned, 3, "index skipped, a/b/c scanned");
        assert_eq!(report.skipped_aggregate, 1);
        assert_eq!(report.unembedded, 1);
        assert_eq!(report.backfilled, 1, "b matches via L2");
        assert_eq!(report.mismatch, 1, "c content changed");
        assert!(llm_wiki_lib::commands::page_embedding::load_revision(&pp, "questions/b").is_none());

        // apply：b 回填 revision；幂等重跑 already_current
        let report = run(&pp, &config(), true).await.unwrap();
        assert_eq!(report.backfilled, 1);
        assert!(llm_wiki_lib::commands::page_embedding::load_revision(&pp, "questions/b").is_some());
        let report = run(&pp, &config(), true).await.unwrap();
        assert_eq!(report.already_current, 1, "idempotent second run");
        let _ = std::fs::remove_dir_all(&root);
    }
}
