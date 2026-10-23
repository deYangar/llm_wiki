//! Maintenance bin: rewrite v1 bare-stem page_ids in wiki_chunks_v2 to
//! their v2 qualified form. Only stems owned by exactly one wiki page are
//! migrated; ambiguous/orphan stems are quarantined (reported, untouched).
//! Vectors are carried over verbatim — no re-embedding. Idempotent.
//!
//! Usage (from src-tauri/, with the app stopped so nothing else holds the
//! v2 write lock):
//!   cargo run --bin lance-stem-migrate -- C:/library/wiki [--dry-run] [--quarantine-out file.jsonl]

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut project_path: Option<String> = None;
    let mut dry_run = false;
    let mut quarantine_out: Option<String> = None;
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--dry-run" => dry_run = true,
            "--quarantine-out" => {
                i += 1;
                quarantine_out = args.get(i).cloned();
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
        eprintln!("usage: lance-stem-migrate <project_path> [--dry-run] [--quarantine-out file.jsonl]");
        std::process::exit(2);
    };

    let started = std::time::Instant::now();
    match llm_wiki_lib::commands::vectorstore::migrate_stem_ids_inner(&project_path, dry_run).await
    {
        Ok(report) => {
            if let Some(out) = &quarantine_out {
                let mut lines = String::new();
                for entry in &report.quarantine {
                    lines.push_str(
                        &serde_json::to_string(entry).unwrap_or_else(|_| "{}".to_string()),
                    );
                    lines.push('\n');
                }
                if let Err(e) = std::fs::write(out, lines) {
                    eprintln!("warning: failed to write quarantine file {out}: {e}");
                }
            }
            println!("dry_run                : {}", report.dry_run);
            println!("stem_pages             : {}", report.stem_pages);
            println!("stem_rows              : {}", report.stem_rows);
            println!("migrated_pages         : {}", report.migrated_pages);
            println!("migrated_rows          : {}", report.migrated_rows);
            println!("quarantined_pages      : {}", report.quarantined_pages);
            println!("quarantined_rows       : {}", report.quarantined_rows);
            for entry in report.quarantine.iter().take(50) {
                println!(
                    "  quarantine: {} ({} rows, {})",
                    entry.stem, entry.rows, entry.reason
                );
            }
            if report.quarantine.len() > 50 {
                println!(
                    "  ... and {} more (use --quarantine-out for the full list)",
                    report.quarantine.len() - 50
                );
            }
            println!(
                "-- migrate {} in {:.1}s",
                if dry_run { "(dry-run)" } else { "done" },
                started.elapsed().as_secs_f64()
            );
        }
        Err(e) => {
            eprintln!("error: {e}");
            std::process::exit(1);
        }
    }
}
