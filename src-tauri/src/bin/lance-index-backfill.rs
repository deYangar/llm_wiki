//! One-off maintenance bin: build the IvfFlat vector index on an existing
//! wiki_chunks_v2 table written by pre-index deployments. Idempotent —
//! re-running on an already-indexed table is a no-op ("exists").
//!
//! Usage (from src-tauri/, with the app stopped so nothing else holds the
//! v2 write lock):
//!   cargo run --bin lance-index-backfill -- C:/library/wiki
#[tokio::main(flavor = "current_thread")]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 2 {
        eprintln!("usage: lance-index-backfill <project_path>");
        std::process::exit(2);
    }
    let started = std::time::Instant::now();
    match llm_wiki_lib::commands::vectorstore::ensure_vector_index_inner(&args[1]).await {
        Ok(status) => println!(
            "vector index: {status} ({}s)",
            started.elapsed().as_secs_f64()
        ),
        Err(e) => {
            eprintln!("error: {e}");
            std::process::exit(1);
        }
    }
}
