//! Probe bin: measure KNN cost/behavior on the real wiki_chunks_v2 table
//! for the three lanes the app uses — pushed-down IN-list (with/without
//! index bypass) and whole-library indexed KNN. Decides whether the
//! pushdown lane can use the index without starving narrow filters.
//! Usage: lance-knn-probe <project_path>
use std::time::Instant;

use arrow_array::{Float32Array, StringArray};
use futures::TryStreamExt;
use lancedb::query::{ExecutableQuery, QueryBase};

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 2 {
        eprintln!("usage: lance-knn-probe <project_path>");
        std::process::exit(2);
    }
    let project = &args[1];
    let db_path = format!("{}/.llm-wiki/lancedb", project.replace('\\', "/"));

    let db = lancedb::connect(&db_path).execute().await.unwrap();
    let table = db.open_table("wiki_chunks_v2").execute().await.unwrap();

    // Grab a sample of real page_ids to build a narrow IN-list, and one
    // real query vector to make distances meaningful.
    let batches: Vec<arrow_array::RecordBatch> = table
        .query()
        .limit(2000)
        .execute()
        .await
        .unwrap()
        .try_collect()
        .await
        .unwrap();
    let batch = batches.into_iter().next().unwrap();
    let page_ids = batch
        .column_by_name("page_id")
        .and_then(|c| c.as_any().downcast_ref::<StringArray>())
        .unwrap();
    let mut ids: Vec<String> = Vec::new();
    for i in 0..batch.num_rows() {
        let id = page_ids.value(i).to_string();
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    ids.truncate(422);
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
    println!(
        "probe: {} candidate ids, dim {}",
        ids.len(),
        query_embedding.len()
    );

    let predicate = format!(
        "page_id IN ({})",
        ids.iter()
            .map(|id| format!("'{}'", id.replace('\'', "''")))
            .collect::<Vec<_>>()
            .join(",")
    );

    for (label, use_only_if, bypass) in [
        ("pushdown+bypass(现行)", true, true),
        ("pushdown+index(候选)", true, false),
        ("wide+index(现行)", false, false),
    ] {
        // warm run then timed run
        for round in 0..2 {
            let t0 = Instant::now();
            let mut query = table
                .vector_search(query_embedding.clone())
                .unwrap()
                .limit(10);
            if use_only_if {
                query = query.only_if(predicate.clone());
            }
            if bypass {
                query = query.bypass_vector_index();
            }
            let rows: Vec<arrow_array::RecordBatch> = query
                .execute()
                .await
                .unwrap()
                .try_collect()
                .await
                .unwrap();
            let n: usize = rows.iter().map(|b| b.num_rows()).sum();
            let dists: Vec<f32> = rows
                .iter()
                .flat_map(|b| {
                    b.column_by_name("_distance")
                        .and_then(|c| c.as_any().downcast_ref::<Float32Array>())
                        .map(|a| a.values().to_vec())
                        .unwrap_or_default()
                })
                .collect();
            if round == 1 {
                println!(
                    "{label}: {n} rows in {}ms; dist[:3]={:?}",
                    t0.elapsed().as_millis(),
                    &dists[..dists.len().min(3)]
                );
            }
        }
    }
}
