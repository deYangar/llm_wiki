//! Maintenance bin: verify the health of a wiki_chunks_v2 table.
//! Checks row counts by id form (v1 bare-stem vs v2 qualified), vector
//! dimension, degenerate/zero vectors, page_id resolvability against the
//! wiki tree, duplicate-vector suspects (sampled), and index presence.
//! Bad pages are printed grouped by page_id — they feed the per-page
//! delete+re-embed repair lane. Verification never mutates anything.
//!
//! Usage (from src-tauri/, with the app stopped so nothing else holds the
//! v2 write lock):
//!   cargo run --bin lance-index-verify -- C:/library/wiki [--sample 512] [--json]

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut project_path: Option<String> = None;
    let mut sample = 512usize;
    let mut json = false;
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--sample" => {
                i += 1;
                sample = args
                    .get(i)
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(512);
            }
            "--json" => json = true,
            other if !other.starts_with("--") => project_path = Some(other.to_string()),
            other => {
                eprintln!("unknown flag: {other}");
                std::process::exit(2);
            }
        }
        i += 1;
    }
    let Some(project_path) = project_path else {
        eprintln!("usage: lance-index-verify <project_path> [--sample N] [--json]");
        std::process::exit(2);
    };

    let started = std::time::Instant::now();
    match llm_wiki_lib::commands::vectorstore::verify_vector_table_inner(&project_path, sample)
        .await
    {
        Ok(report) => {
            if json {
                println!("{}", serde_json::to_string_pretty(&report).unwrap());
            } else {
                println!("table_exists           : {}", report.table_exists);
                println!("total_rows             : {}", report.total_rows);
                println!("distinct_pages         : {}", report.distinct_pages);
                println!("stem_rows (v1 id)      : {}", report.stem_rows);
                println!("qualified_rows (v2 id) : {}", report.qualified_rows);
                println!("vector_dim             : {}", report.vector_dim);
                println!("degenerate_vectors     : {}", report.degenerate_vectors);
                println!(
                    "sampled_dup_vectors    : {}",
                    report.sampled_duplicate_vectors
                );
                println!("vector_index           : {}", report.vector_index);
                println!("page_id_index          : {}", report.page_id_index);
                println!("pages_missing_file     : {}", report.pages_missing_file);
                println!("stem_ambiguous_pages   : {}", report.stem_ambiguous_pages);
                println!("stem_orphan_pages      : {}", report.stem_orphan_pages);
                println!("bad_pages              : {}", report.bad_pages.len());
                for bad in report.bad_pages.iter().take(50) {
                    println!(
                        "  {} ({} rows): {}",
                        bad.page_id,
                        bad.rows,
                        bad.reasons.join(", ")
                    );
                }
                if report.bad_pages.len() > 50 {
                    println!("  ... and {} more (use --json for the full list)", report.bad_pages.len() - 50);
                }
            }
            println!("-- verify done in {:.1}s", started.elapsed().as_secs_f64());
        }
        Err(e) => {
            eprintln!("error: {e}");
            std::process::exit(1);
        }
    }
}
