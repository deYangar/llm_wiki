//! Maintenance bin: delete vector rows whose backing wiki page no longer
//! exists (qualified id with no wiki/<id>.md, orphan bare-stem id). The
//! delete-side lane of the verify → repair flow. Idempotent.
//!
//! Usage (from src-tauri/, with the app stopped so nothing else holds the
//! v2 write lock):
//!   cargo run --bin lance-prune-missing-pages -- C:/library/wiki [--dry-run]

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut project_path: Option<String> = None;
    let mut dry_run = false;
    for arg in args.iter().skip(1) {
        match arg.as_str() {
            "--dry-run" => dry_run = true,
            other if !other.starts_with("--") => project_path = Some(other.to_string()),
            other => {
                eprintln!("unknown flag: {other}");
                std::process::exit(2);
            }
        }
    }
    let Some(project_path) = project_path else {
        eprintln!("usage: lance-prune-missing-pages <project_path> [--dry-run]");
        std::process::exit(2);
    };

    let started = std::time::Instant::now();
    match llm_wiki_lib::commands::vectorstore::prune_missing_vector_pages_inner(&project_path, dry_run)
        .await
    {
        Ok((pages, rows)) => {
            println!(
                "pruned_pages: {pages}  pruned_rows: {rows}  mode: {}  ({:.1}s)",
                if dry_run { "dry-run" } else { "applied" },
                started.elapsed().as_secs_f64()
            );
        }
        Err(e) => {
            eprintln!("error: {e}");
            std::process::exit(1);
        }
    }
}
