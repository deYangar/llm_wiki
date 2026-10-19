//! Scratch bench: replicate the token-lane per-file work over the real
//! question pages to find where the wide-candidate 1.1s actually goes.
//! Usage: scan-bench <wiki_root> [reps]
use rayon::prelude::*;
use std::fs;
use std::path::PathBuf;
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let root = &args[1];
    let reps: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(3);

    let files: Vec<PathBuf> = walk(root);
    println!("pages: {}, rayon threads: {}", files.len(), rayon::current_num_threads());
    let needles: Vec<String> = ["收入确认", "收入", "入确", "确认", "收", "入", "确", "认"]
        .iter().map(|s| s.to_string()).collect();

    // 1. read only
    for r in 0..reps {
        let t0 = Instant::now();
        let mut bytes = 0usize;
        let contents: Vec<String> = files.par_iter().map(|p| fs::read_to_string(p).unwrap()).collect();
        bytes = contents.iter().map(|c| c.len()).sum();
        println!("[{r}] read_to_string: {}ms, {}MB", t0.elapsed().as_millis(), bytes / 1_000_000);
    }

    // 2. read + needle presence (the scanning core)
    for r in 0..reps {
        let t0 = Instant::now();
        let hits: usize = files.par_iter().map(|p| {
            let c = fs::read_to_string(p).unwrap();
            needles.iter().filter(|n| c.contains(n.as_str())).count()
        }).sum();
        println!("[{r}] read + 8-needle presence: {}ms, sum-present {}", t0.elapsed().as_millis(), hits);
    }

    // 3. read + lowercase + count_occurrences-style full machinery
    for r in 0..reps {
        let t0 = Instant::now();
        let hits: usize = files.par_iter().map(|p| {
            let c = fs::read_to_string(p).unwrap();
            let lower = c.to_lowercase();
            let phrase = "收入确认";
            let occ = if lower.contains(phrase) { lower.match_indices(phrase).count() } else { 0 };
            let tok = needles.iter().filter(|n| lower.contains(n.as_str())).count();
            occ + tok
        }).sum();
        println!("[{r}] read + lowercase + counts: {}ms, score {}", t0.elapsed().as_millis(), hits);
    }
}

fn walk(root: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let q = PathBuf::from(root).join("questions");
    for entry in fs::read_dir(&q).unwrap() {
        let p = entry.unwrap().path();
        if p.extension().and_then(|s| s.to_str()) == Some("md") {
            out.push(p);
        }
    }
    out.sort();
    out
}
