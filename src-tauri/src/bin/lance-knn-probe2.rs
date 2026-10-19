//! Probe v2: pushed-down KNN cost at realistic candidate scales
//! (422 / 2,000 / 8,254 page ids) against the indexed real table.
//! Usage: lance-knn-probe2 <project_path> <questions_dir>
use std::time::Instant;

use arrow_array::{Float32Array, StringArray};
use futures::TryStreamExt;
use lancedb::query::{ExecutableQuery, QueryBase};

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        eprintln!("usage: lance-knn-probe2 <project_path> <questions_dir>");
        std::process::exit(2);
    }
    let project = &args[1];
    let db_path = format!("{}/.llm-wiki/lancedb", project.replace('\\', "/"));

    let db = lancedb::connect(&db_path).execute().await.unwrap();
    let table = db.open_table("wiki_chunks_v2").execute().await.unwrap();

    // one real query vector from the table
    let batches: Vec<arrow_array::RecordBatch> = table
        .query()
        .limit(10)
        .execute()
        .await
        .unwrap()
        .try_collect()
        .await
        .unwrap();
    let batch = batches.into_iter().next().unwrap();
    let vec_col = batch
        .column_by_name("vector")
        .and_then(|c| c.as_any().downcast_ref::<arrow_array::FixedSizeListArray>())
        .unwrap();
    let first = vec_col.value(0);
    let floats = first
        .as_any()
        .downcast_ref::<Float32Array>()
        .unwrap();
    let query_embedding: Vec<f32> = floats.values().to_vec();

    // candidate ids from the questions dir (matches the app's page_id shape)
    let mut ids: Vec<String> = std::fs::read_dir(&args[2])
        .unwrap()
        .filter_map(|e| {
            let p = e.unwrap().path();
            let stem = p.file_stem()?.to_str()?.to_string();
            (p.extension()?.to_str() == Some("md")).then(|| format!("questions/{stem}"))
        })
        .collect();
    ids.sort();
    println!("total candidate ids: {}", ids.len());

    for n in [422usize, 2_000, 8_254] {
        let subset: Vec<String> = ids.iter().take(n).cloned().collect();
        let predicate = format!(
            "page_id IN ({})",
            subset
                .iter()
                .map(|id| format!("'{}'", id.replace('\'', "''")))
                .collect::<Vec<_>>()
                .join(",")
        );
        for round in 0..2 {
            let t0 = Instant::now();
            let rows: Vec<arrow_array::RecordBatch> = table
                .vector_search(query_embedding.clone())
                .unwrap()
                .limit(10)
                .only_if(predicate.clone())
                .execute()
                .await
                .unwrap()
                .try_collect()
                .await
                .unwrap();
            let count: usize = rows.iter().map(|b| b.num_rows()).sum();
            let top: Vec<String> = rows
                .iter()
                .flat_map(|b| {
                    match b.column_by_name("page_id")
                        .and_then(|c| c.as_any().downcast_ref::<StringArray>())
                    {
                        Some(a) => (0..b.num_rows()).map(|i| a.value(i).to_string()).collect::<Vec<_>>(),
                        None => Vec::new(),
                    }
                })
                .take(2)
                .collect::<Vec<_>>();
            if round == 1 {
                println!(
                    "pushdown {n} ids: {count} rows in {}ms; top2={:?}",
                    t0.elapsed().as_millis(),
                    top
                );
            }
        }
    }
}
