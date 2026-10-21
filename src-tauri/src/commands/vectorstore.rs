use arrow_array::{
    ArrayRef, FixedSizeListArray, Float32Array, RecordBatch, RecordBatchIterator, StringArray,
    UInt32Array,
};
use arrow_schema::{DataType, Field, Schema};
use chrono::Duration;
use lancedb::connect;
use lancedb::index::scalar::BTreeIndexBuilder;
use lancedb::index::vector::IvfFlatIndexBuilder;
use lancedb::index::Index;
use lancedb::query::{ExecutableQuery, QueryBase};
use lancedb::table::{CompactionOptions, OptimizeAction};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use crate::panic_guard::run_guarded_async;

/// v1 per-page result (legacy — kept so pre-0.3.11 projects still load).
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VectorSearchResult {
    pub page_id: String,
    pub score: f32,
}

/// v2 per-chunk result. Surfaces the matching chunk's text + heading path
/// so the chat UI can show "matched in this section" and aggregators on
/// the TS side can group by page_id.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChunkSearchResult {
    pub chunk_id: String,
    pub page_id: String,
    pub chunk_index: u32,
    pub chunk_text: String,
    pub heading_path: String,
    pub score: f32,
}

/// Input row for `vector_upsert_chunks`. TypeScript side owns the
/// chunk_index / chunk_text / heading_path; the Rust side is purely
/// storage. `chunk_id` is always derived as `${page_id}#${chunk_index}`
/// so we don't trust a client-supplied id.
#[derive(Debug, Deserialize)]
pub struct ChunkUpsertInput {
    pub chunk_index: u32,
    pub chunk_text: String,
    pub heading_path: String,
    pub embedding: Vec<f32>,
}

fn db_path(project_path: &str) -> String {
    format!("{}/.llm-wiki/lancedb", project_path.replace('\\', "/"))
}

fn vectorstore_v2_lock(project_path: &str) -> Arc<tokio::sync::RwLock<()>> {
    let key = db_path(project_path);
    let locks = VECTORSTORE_V2_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut locks = locks.lock().expect("vectorstore lock map poisoned");
    locks
        .entry(key)
        .or_insert_with(|| Arc::new(tokio::sync::RwLock::new(())))
        .clone()
}

/// v1 (legacy) table name. One row per page.
const TABLE_V1: &str = "wiki_vectors";
/// v2 (current) table name. One row per CHUNK — a page is typically
/// represented by multiple rows sharing the same `page_id`.
const TABLE_V2: &str = "wiki_chunks_v2";

/// Predicates matching at most this many rows take the in-memory exact
/// KNN path (see `vector_search_chunks_predicate_inner`); above it the
/// indexed KNN keeps the fast lane. 2,048 rows ≈ 16MB of 2048-dim f32
/// vectors — the fetch rides the page_id BTree scalar index (measured
/// ~7ms at 422 ids, ~409ms at 8,254) and the distance pass is
/// single-digit milliseconds.
const FILTERED_EXACT_MAX_ROWS: usize = 2_048;
const MAX_PAGE_ID_CHARS: usize = 256;
static VECTORSTORE_V2_LOCKS: OnceLock<Mutex<HashMap<String, Arc<tokio::sync::RwLock<()>>>>> =
    OnceLock::new();

/// Validate page_id to prevent filter/path injection without rejecting
/// legitimate Unicode wiki filenames. Page ids are wiki-relative paths without
/// `.md`; CJK letters, spaces, forward slashes, and punctuation such as `·` /
/// `：` / `（` are valid. Quotes and backslashes remain unsafe because we
/// interpolate page_id into LanceDB filters (`page_id = '...'`).
/// Format/invisible characters are rejected so visually identical ids cannot
/// differ only by soft hyphen, zero-width, bidi, tag, or separator characters.
fn validate_page_id_common(page_id: &str) -> Result<(), String> {
    if page_id.is_empty() {
        return Err("Invalid page_id: empty or too long".to_string());
    }

    let mut char_count = 0usize;
    for c in page_id.chars() {
        char_count += 1;
        if char_count > MAX_PAGE_ID_CHARS {
            return Err("Invalid page_id: empty or too long".to_string());
        }
        if is_disallowed_page_id_char(c) {
            return Err(format!(
                "Invalid page_id: contains disallowed character {:?}: {}",
                c, page_id
            ));
        }
    }
    Ok(())
}

fn is_disallowed_page_id_char(c: char) -> bool {
    c.is_control()
        || matches!(
            c,
            '\\' | '\''
                | '"'
                | '\u{00AD}'
                | '\u{061C}'
                | '\u{200B}'..='\u{200F}'
                | '\u{2028}'..='\u{202E}'
                | '\u{2060}'..='\u{206F}'
                | '\u{FEFF}'
                | '\u{FFF9}'..='\u{FFFB}'
                | '\u{E0000}'..='\u{E007F}'
        )
}

/// Keep the v1 call site explicit while sharing the same page id contract.
fn validate_page_id(page_id: &str) -> Result<(), String> {
    validate_page_id_common(page_id)
}

fn make_schema(dim: i32) -> Arc<Schema> {
    Arc::new(Schema::new(vec![
        Field::new("page_id", DataType::Utf8, false),
        Field::new(
            "vector",
            DataType::FixedSizeList(Arc::new(Field::new("item", DataType::Float32, true)), dim),
            false,
        ),
    ]))
}

fn make_batch(
    schema: Arc<Schema>,
    page_id: &str,
    embedding: Vec<f32>,
    dim: i32,
) -> Result<RecordBatch, String> {
    let ids: ArrayRef = Arc::new(StringArray::from(vec![page_id]));
    let values = Float32Array::from(embedding);
    let vector: ArrayRef = Arc::new(FixedSizeListArray::new(
        Arc::new(Field::new("item", DataType::Float32, true)),
        dim,
        Arc::new(values),
        None,
    ));
    RecordBatch::try_new(schema, vec![ids, vector]).map_err(|e| format!("Batch error: {e}"))
}

/// Upsert a page embedding into LanceDB
#[tauri::command]
pub async fn vector_upsert(
    project_path: String,
    page_id: String,
    embedding: Vec<f32>,
) -> Result<(), String> {
    run_guarded_async("vector_upsert", async move {
        validate_page_id(&page_id)?;

        let db = connect(&db_path(&project_path))
            .execute()
            .await
            .map_err(|e| format!("DB connect error: {e}"))?;

        let dim = embedding.len() as i32;
        let schema = make_schema(dim);
        let batch = make_batch(schema.clone(), &page_id, embedding, dim)?;
        let data = vec![batch];

        let tables = db
            .table_names()
            .execute()
            .await
            .map_err(|e| format!("List tables error: {e}"))?;

        if tables.contains(&TABLE_V1.to_string()) {
            let table = db
                .open_table(TABLE_V1)
                .execute()
                .await
                .map_err(|e| format!("Open table error: {e}"))?;

            // Delete existing entry then add new one
            if let Err(e) = table.delete(&format!("page_id = '{}'", page_id)).await {
                eprintln!(
                    "[vectorstore] Warning: delete before upsert failed for '{}': {}",
                    page_id, e
                );
            }

            table
                .add(data)
                .execute()
                .await
                .map_err(|e| format!("Add error: {e}"))?;
        } else {
            db.create_table(TABLE_V1, data)
                .execute()
                .await
                .map_err(|e| format!("Create table error: {e}"))?;
        }

        Ok(())
    })
    .await
}

/// Search for similar pages by embedding vector
#[tauri::command]
pub async fn vector_search(
    project_path: String,
    query_embedding: Vec<f32>,
    top_k: usize,
) -> Result<Vec<VectorSearchResult>, String> {
    run_guarded_async("vector_search", async move {
        let db = connect(&db_path(&project_path))
            .execute()
            .await
            .map_err(|e| format!("DB connect error: {e}"))?;

        let tables = db
            .table_names()
            .execute()
            .await
            .map_err(|e| format!("List tables error: {e}"))?;

        if !tables.contains(&TABLE_V1.to_string()) {
            return Ok(vec![]);
        }

        let table = db
            .open_table(TABLE_V1)
            .execute()
            .await
            .map_err(|e| format!("Open table error: {e}"))?;

        let results_stream = table
            .vector_search(query_embedding)
            .map_err(|e| format!("Search error: {e}"))?
            .limit(top_k)
            .execute()
            .await
            .map_err(|e| format!("Execute search error: {e}"))?;

        let mut search_results = Vec::new();

        use futures::TryStreamExt;
        let batches: Vec<RecordBatch> = results_stream
            .try_collect()
            .await
            .map_err(|e| format!("Collect error: {e}"))?;

        for batch in &batches {
            let ids = batch
                .column_by_name("page_id")
                .and_then(|c| c.as_any().downcast_ref::<StringArray>())
                .ok_or("Missing page_id column")?;

            let distances = batch
                .column_by_name("_distance")
                .and_then(|c| c.as_any().downcast_ref::<Float32Array>())
                .ok_or("Missing _distance column")?;

            for i in 0..batch.num_rows() {
                let page_id = ids.value(i).to_string();
                let distance = distances.value(i);
                let score = 1.0 / (1.0 + distance);
                search_results.push(VectorSearchResult { page_id, score });
            }
        }

        Ok(search_results)
    })
    .await
}

/// Delete a page from the vector index
#[tauri::command]
pub async fn vector_delete(project_path: String, page_id: String) -> Result<(), String> {
    run_guarded_async("vector_delete", async move {
        validate_page_id(&page_id)?;

        let db = connect(&db_path(&project_path))
            .execute()
            .await
            .map_err(|e| format!("DB connect error: {e}"))?;

        let tables = db
            .table_names()
            .execute()
            .await
            .map_err(|e| format!("List tables error: {e}"))?;

        if !tables.contains(&TABLE_V1.to_string()) {
            return Ok(());
        }

        let table = db
            .open_table(TABLE_V1)
            .execute()
            .await
            .map_err(|e| format!("Open table error: {e}"))?;

        table
            .delete(&format!("page_id = '{}'", page_id))
            .await
            .map_err(|e| format!("Delete error: {e}"))?;

        Ok(())
    })
    .await
}

/// Get count of indexed vectors
#[tauri::command]
pub async fn vector_count(project_path: String) -> Result<usize, String> {
    run_guarded_async("vector_count", async move {
        let db = connect(&db_path(&project_path))
            .execute()
            .await
            .map_err(|e| format!("DB connect error: {e}"))?;

        let tables = db
            .table_names()
            .execute()
            .await
            .map_err(|e| format!("List tables error: {e}"))?;

        if !tables.contains(&TABLE_V1.to_string()) {
            return Ok(0);
        }

        let table = db
            .open_table(TABLE_V1)
            .execute()
            .await
            .map_err(|e| format!("Open table error: {e}"))?;

        let count = table
            .count_rows(None)
            .await
            .map_err(|e| format!("Count error: {e}"))?;

        Ok(count)
    })
    .await
}

// ──────────────────────────────────────────────────────────────────────────
// v2 chunk-level vector store
//
// Each row is one CHUNK of a wiki page. Multiple rows per page are the
// common case. The v2 schema:
//
//   chunk_id      Utf8       "${page_id}#${chunk_index}"   (debug-only; we
//                                                          never filter on
//                                                          this — all
//                                                          mutations scope
//                                                          by page_id)
//   page_id       Utf8       which page this chunk belongs to
//   chunk_index   UInt32     0-based position within the page
//   chunk_text    Utf8       raw chunk content (for UI re-ranking + showing
//                            "matched in this section")
//   heading_path  Utf8       breadcrumb ("## A > ### B") — empty string when
//                            the chunk lives above any heading
//   vector        FixedSizeList<Float32, dim>
//
// Upsert semantics: we DELETE every row with the target page_id and then
// ADD all the new chunks in one batch. Chunk indexes may shift when a
// page is re-ingested (content shrinks / grows / re-splits), so we never
// try to match-and-update by chunk_id — the clean-slate replace is both
// simpler and always correct.
//
// Search returns top-K CHUNKS. The TS layer aggregates to per-page scores
// (max + weighted tail) for the existing page-oriented retrieval API,
// plus exposes the chunk metadata for a future "matched in X section" UI.
// ──────────────────────────────────────────────────────────────────────────

pub(crate) fn validate_page_id_for_v2(page_id: &str) -> Result<(), String> {
    validate_page_id_common(page_id)
}

fn make_schema_v2(dim: i32) -> Arc<Schema> {
    Arc::new(Schema::new(vec![
        Field::new("chunk_id", DataType::Utf8, false),
        Field::new("page_id", DataType::Utf8, false),
        Field::new("chunk_index", DataType::UInt32, false),
        Field::new("chunk_text", DataType::Utf8, false),
        Field::new("heading_path", DataType::Utf8, false),
        Field::new(
            "vector",
            DataType::FixedSizeList(Arc::new(Field::new("item", DataType::Float32, true)), dim),
            false,
        ),
    ]))
}

fn make_batch_v2(
    schema: Arc<Schema>,
    page_id: &str,
    chunks: &[ChunkUpsertInput],
    dim: i32,
) -> Result<RecordBatch, String> {
    let mut chunk_ids: Vec<String> = Vec::with_capacity(chunks.len());
    let mut page_ids: Vec<String> = Vec::with_capacity(chunks.len());
    let mut indexes: Vec<u32> = Vec::with_capacity(chunks.len());
    let mut texts: Vec<String> = Vec::with_capacity(chunks.len());
    let mut heading_paths: Vec<String> = Vec::with_capacity(chunks.len());
    let mut flat_vectors: Vec<f32> = Vec::with_capacity(chunks.len() * dim as usize);

    for c in chunks {
        if c.embedding.len() as i32 != dim {
            return Err(format!(
                "Chunk #{} has embedding dim {} but batch dim is {}",
                c.chunk_index,
                c.embedding.len(),
                dim
            ));
        }
        chunk_ids.push(format!("{}#{}", page_id, c.chunk_index));
        page_ids.push(page_id.to_string());
        indexes.push(c.chunk_index);
        texts.push(c.chunk_text.clone());
        heading_paths.push(c.heading_path.clone());
        flat_vectors.extend_from_slice(&c.embedding);
    }

    let chunk_ids_arr: ArrayRef = Arc::new(StringArray::from(chunk_ids));
    let page_ids_arr: ArrayRef = Arc::new(StringArray::from(page_ids));
    let indexes_arr: ArrayRef = Arc::new(UInt32Array::from(indexes));
    let texts_arr: ArrayRef = Arc::new(StringArray::from(texts));
    let heading_paths_arr: ArrayRef = Arc::new(StringArray::from(heading_paths));

    let values = Float32Array::from(flat_vectors);
    let vector_arr: ArrayRef = Arc::new(FixedSizeListArray::new(
        Arc::new(Field::new("item", DataType::Float32, true)),
        dim,
        Arc::new(values),
        None,
    ));

    RecordBatch::try_new(
        schema,
        vec![
            chunk_ids_arr,
            page_ids_arr,
            indexes_arr,
            texts_arr,
            heading_paths_arr,
            vector_arr,
        ],
    )
    .map_err(|e| format!("Batch error: {e}"))
}

/// Upsert a batch of chunks for a single page. Existing chunks for this
/// page are deleted first so the on-disk state reflects the latest split.
/// An empty `chunks` argument is a no-op — it does NOT clear the page's
/// existing index (for that, call `vector_delete_page` explicitly), so
/// transient ingest failures don't nuke previously-good embeddings.
#[tauri::command]
pub async fn vector_upsert_chunks(
    project_path: String,
    page_id: String,
    chunks: Vec<ChunkUpsertInput>,
) -> Result<(), String> {
    run_guarded_async("vector_upsert_chunks", async move {
        vector_upsert_chunks_inner(&project_path, &page_id, chunks, None).await
    })
    .await
}

pub(crate) async fn vector_upsert_chunks_with_revision(
    project_path: &str,
    page_id: &str,
    chunks: Vec<ChunkUpsertInput>,
    fingerprint: &str,
) -> Result<(), String> {
    vector_upsert_chunks_inner(project_path, page_id, chunks, Some(fingerprint)).await
}

async fn vector_upsert_chunks_inner(
    project_path: &str,
    page_id: &str,
    chunks: Vec<ChunkUpsertInput>,
    revision: Option<&str>,
) -> Result<(), String> {
    validate_page_id_for_v2(&page_id)?;
    let lock = vectorstore_v2_lock(project_path);
    let _guard = lock.write().await;

    if chunks.is_empty() {
        return Ok(());
    }

    let dim = chunks[0].embedding.len() as i32;
    if dim == 0 {
        return Err("Chunk #0 has empty embedding".to_string());
    }

    let db = connect(&db_path(project_path))
        .execute()
        .await
        .map_err(|e| format!("DB connect error: {e}"))?;

    let schema = make_schema_v2(dim);
    let batch = make_batch_v2(schema.clone(), &page_id, &chunks, dim)?;
    let tables = db
        .table_names()
        .execute()
        .await
        .map_err(|e| format!("List tables error: {e}"))?;

    if tables.contains(&TABLE_V2.to_string()) {
        let table = db
            .open_table(TABLE_V2)
            .execute()
            .await
            .map_err(|e| format!("Open table error: {e}"))?;

        let data = RecordBatchIterator::new(vec![Ok(batch)], schema);
        let mut merge = table.merge_insert(&["chunk_id"]);
        merge
            .when_matched_update_all(None)
            .when_not_matched_insert_all()
            .when_not_matched_by_source_delete(Some(format!("page_id = '{}'", page_id)));
        merge
            .execute(Box::new(data))
            .await
            .map_err(|e| format!("Atomic page upsert failed: {e}"))?;
    } else {
        db.create_table(TABLE_V2, vec![batch])
            .execute()
            .await
            .map_err(|e| format!("Create table error: {e}"))?;
    }

    if let Some(fingerprint) = revision {
        if let Err(err) = super::page_embedding::save_revision(project_path, page_id, fingerprint) {
            let _ = super::page_embedding::invalidate_page_revision(project_path, page_id);
            eprintln!("[page-embedding] failed to save revision metadata: {err}");
        }
    } else {
        let _ = super::page_embedding::invalidate_page_revision(project_path, page_id);
    }

    Ok(())
}

pub(crate) async fn vector_page_revision_match(
    project_path: &str,
    page_id: &str,
    fingerprint: &str,
) -> Result<Option<usize>, String> {
    validate_page_id_for_v2(page_id)?;
    let lock = vectorstore_v2_lock(project_path);
    let _guard = lock.read().await;
    if super::page_embedding::load_revision(project_path, page_id).as_deref() != Some(fingerprint) {
        return Ok(None);
    }

    let db = connect(&db_path(project_path))
        .execute()
        .await
        .map_err(|e| format!("DB connect error: {e}"))?;
    let tables = db
        .table_names()
        .execute()
        .await
        .map_err(|e| format!("List tables error: {e}"))?;
    if !tables.contains(&TABLE_V2.to_string()) {
        return Ok(None);
    }
    let count = db
        .open_table(TABLE_V2)
        .execute()
        .await
        .map_err(|e| format!("Open table error: {e}"))?
        .count_rows(Some(format!("page_id = '{}'", page_id)))
        .await
        .map_err(|e| format!("Count page chunks error: {e}"))?;
    Ok((count > 0).then_some(count))
}

/// `page_id IN (...)` predicate for the pushed-down vector KNN filter.
/// page_id values are validated upstream (no quotes/newlines/backslashes —
/// see `validate_page_id_for_v2`), so the escaping here is belt-and-braces
/// only, not the injection defense.
pub(crate) fn page_id_in_predicate(page_ids: &[String]) -> String {
    let quoted: Vec<String> = page_ids
        .iter()
        .map(|id| format!("'{}'", id.replace('\'', "''")))
        .collect();
    format!("page_id IN ({})", quoted.join(", "))
}

/// Top-K chunk search. Returns every matching chunk's metadata + score
/// (1 / (1 + distance), matching v1's convention for drop-in replacement
/// at the TS layer). TS is responsible for grouping by page_id.
///
/// `page_ids` (W2 vector-lane fix, 2026-10-15): when Some, the KNN runs
/// INSIDE that page set via a pushed-down `page_id IN (...)` predicate —
/// "filter before scoring" for the vector lane too. Without it the lane
/// takes a whole-library top-k first and maps hits back onto the filtered
/// candidate set afterwards, so whenever the constraint covers a small
/// slice of the library (e.g. one exact tag ≈ 1.5% of pages) the global
/// top-k contains none of the target pages and the lane silently returns
/// zero hits. An empty list is treated like None (no restriction).
#[tauri::command]
pub async fn vector_search_chunks(
    project_path: String,
    query_embedding: Vec<f32>,
    top_k: usize,
    page_ids: Option<Vec<String>>,
) -> Result<Vec<ChunkSearchResult>, String> {
    run_guarded_async("vector_search_chunks", async move {
        let predicate = page_ids.as_deref().and_then(|ids| {
            (!ids.is_empty()).then(|| page_id_in_predicate(ids))
        });
        vector_search_chunks_predicate_inner(&project_path, query_embedding, top_k, predicate)
            .await
    })
    .await
}

/// Predicate-form entry for the Rust search pipeline: the caller supplies
/// a ready `page_id` SQL predicate (IN-list and/or directory range terms,
/// see `build_page_id_predicate` in commands::search). Semantics are the
/// same constrained KNN as `page_ids` — the predicate form exists because
/// whole-directory candidate sets (type=section ≈ 24k ids) make a literal
/// IN-list megabytes long while an equivalent range term is ~40 chars.
pub async fn vector_search_chunks_predicate(
    project_path: String,
    query_embedding: Vec<f32>,
    top_k: usize,
    predicate: String,
) -> Result<Vec<ChunkSearchResult>, String> {
    run_guarded_async("vector_search_chunks_predicate", async move {
        vector_search_chunks_predicate_inner(&project_path, query_embedding, top_k, Some(predicate))
            .await
    })
    .await
}

async fn vector_search_chunks_predicate_inner(
    project_path: &str,
    query_embedding: Vec<f32>,
    top_k: usize,
    predicate: Option<String>,
) -> Result<Vec<ChunkSearchResult>, String> {
    let lock = vectorstore_v2_lock(project_path);
    let _guard = lock.read().await;

    let db = connect(&db_path(project_path))
        .execute()
        .await
        .map_err(|e| format!("DB connect error: {e}"))?;

    let tables = db
        .table_names()
        .execute()
        .await
        .map_err(|e| format!("List tables error: {e}"))?;

    if !tables.contains(&TABLE_V2.to_string()) {
        return Ok(vec![]);
    }

    let table = db
        .open_table(TABLE_V2)
        .execute()
        .await
        .map_err(|e| format!("Open table error: {e}"))?;

    if let Some(predicate) = predicate.as_deref() {
        if !predicate.is_empty() {
            // Narrow-predicate exact path (2026-10-21): the IVF index only
            // probes a subset of partitions, so when the predicate matches
            // very few rows those rows sit outside the probed set and the
            // KNN returns empty — measured on the production library, a
            // single-page predicate with exactly 1 matching row returned 0
            // rows through the index and the same row through an
            // index-bypassed scan. Fetch the surviving rows via the
            // page_id scalar index and score them in memory instead:
            // exact by construction, and the cost scales with the hit
            // count, not the table. Predicates with more hits than
            // FILTERED_EXACT_MAX_ROWS keep the indexed KNN below — their
            // hits spread over many partitions, so the probed subset
            // covers them with near certainty (2026-10-20 probe: identical
            // top-10/distances vs a bypassed scan at 8,254 ids).
            let fetched = table
                .query()
                .only_if(predicate.to_string())
                .limit(FILTERED_EXACT_MAX_ROWS + 1)
                .execute()
                .await
                .map_err(|e| format!("Execute filtered row fetch error: {e}"))?;
            use futures::TryStreamExt;
            let fetched_batches: Vec<RecordBatch> = fetched
                .try_collect()
                .await
                .map_err(|e| format!("Collect filtered rows error: {e}"))?;
            let hit_rows: usize = fetched_batches.iter().map(|b| b.num_rows()).sum();
            if hit_rows <= FILTERED_EXACT_MAX_ROWS {
                return exact_knn_over_rows(&query_embedding, top_k, &fetched_batches);
            }
        }
    }

    let mut query = table
        .vector_search(query_embedding)
        .map_err(|e| format!("Search error: {e}"))?;
    if let Some(predicate) = predicate.as_deref() {
        if !predicate.is_empty() {
            // Filtered KNN keeps "filter before scoring" semantics:
                // LanceDB prefilters by default (the filter is applied
                // before the vector search; the starving post-filter path
                // only exists behind an explicit .postfilter() we never
                // call). Measured on the full library (2026-10-20 probe):
                // index+prefilter returns the identical top-10/distances
                // of an exact bypassed scan at 477ms vs 2,023ms, and the
                // whole-library indexed KNN runs in ~11ms where the
                // pre-index flat scan cost seconds.
                query = query.only_if(predicate.to_string());
            }
        }
        let results_stream = query
            .limit(top_k)
            .execute()
            .await
            .map_err(|e| format!("Execute search error: {e}"))?;

        use futures::TryStreamExt;
        let batches: Vec<RecordBatch> = results_stream
            .try_collect()
            .await
            .map_err(|e| format!("Collect error: {e}"))?;

        let mut out: Vec<ChunkSearchResult> = Vec::new();
        for batch in &batches {
            let chunk_ids = batch
                .column_by_name("chunk_id")
                .and_then(|c| c.as_any().downcast_ref::<StringArray>())
                .ok_or("Missing chunk_id column")?;
            let page_id_col = batch
                .column_by_name("page_id")
                .and_then(|c| c.as_any().downcast_ref::<StringArray>())
                .ok_or("Missing page_id column")?;
            let chunk_indexes = batch
                .column_by_name("chunk_index")
                .and_then(|c| c.as_any().downcast_ref::<UInt32Array>())
                .ok_or("Missing chunk_index column")?;
            let chunk_texts = batch
                .column_by_name("chunk_text")
                .and_then(|c| c.as_any().downcast_ref::<StringArray>())
                .ok_or("Missing chunk_text column")?;
            let heading_paths = batch
                .column_by_name("heading_path")
                .and_then(|c| c.as_any().downcast_ref::<StringArray>())
                .ok_or("Missing heading_path column")?;
            let distances = batch
                .column_by_name("_distance")
                .and_then(|c| c.as_any().downcast_ref::<Float32Array>())
                .ok_or("Missing _distance column")?;

            for i in 0..batch.num_rows() {
                let distance = distances.value(i);
                out.push(ChunkSearchResult {
                    chunk_id: chunk_ids.value(i).to_string(),
                    page_id: page_id_col.value(i).to_string(),
                    chunk_index: chunk_indexes.value(i),
                    chunk_text: chunk_texts.value(i).to_string(),
                    heading_path: heading_paths.value(i).to_string(),
                    score: 1.0 / (1.0 + distance),
                });
            }
        }

        Ok(out)
}

/// Score the predicate-surviving rows fetched via the scalar index
/// against the query embedding in memory and keep the top_k. Distance is
/// plain L2 and the score conversion 1/(1+distance) — identical
/// conventions to the indexed KNN path, so RRF fusion sees one scale.
/// Rows fetched through a plain `query()` carry no `_distance` column,
/// hence the manual pass. Ties break on chunk_id for determinism.
fn exact_knn_over_rows(
    query_embedding: &[f32],
    top_k: usize,
    batches: &[RecordBatch],
) -> Result<Vec<ChunkSearchResult>, String> {
    let mut scored: Vec<(f32, ChunkSearchResult)> = Vec::new();
    for batch in batches {
        let chunk_ids = batch
            .column_by_name("chunk_id")
            .and_then(|c| c.as_any().downcast_ref::<StringArray>())
            .ok_or("Missing chunk_id column")?;
        let page_id_col = batch
            .column_by_name("page_id")
            .and_then(|c| c.as_any().downcast_ref::<StringArray>())
            .ok_or("Missing page_id column")?;
        let chunk_indexes = batch
            .column_by_name("chunk_index")
            .and_then(|c| c.as_any().downcast_ref::<UInt32Array>())
            .ok_or("Missing chunk_index column")?;
        let chunk_texts = batch
            .column_by_name("chunk_text")
            .and_then(|c| c.as_any().downcast_ref::<StringArray>())
            .ok_or("Missing chunk_text column")?;
        let heading_paths = batch
            .column_by_name("heading_path")
            .and_then(|c| c.as_any().downcast_ref::<StringArray>())
            .ok_or("Missing heading_path column")?;
        let vectors = batch
            .column_by_name("vector")
            .and_then(|c| c.as_any().downcast_ref::<FixedSizeListArray>())
            .ok_or("Missing vector column")?;

        for i in 0..batch.num_rows() {
            let value_ref = vectors.value(i);
            let values = value_ref
                .as_any()
                .downcast_ref::<Float32Array>()
                .ok_or("vector column is not f32")?;
            let mut distance = 0f32;
            for (j, q) in query_embedding.iter().enumerate().take(values.len()) {
                let d = q - values.value(j);
                distance += d * d;
            }
            scored.push((
                distance,
                ChunkSearchResult {
                    chunk_id: chunk_ids.value(i).to_string(),
                    page_id: page_id_col.value(i).to_string(),
                    chunk_index: chunk_indexes.value(i),
                    chunk_text: chunk_texts.value(i).to_string(),
                    heading_path: heading_paths.value(i).to_string(),
                    score: 0.0,
                },
            ));
        }
    }
    scored.sort_by(|a, b| {
        a.0.partial_cmp(&b.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.1.chunk_id.cmp(&b.1.chunk_id))
    });
    scored.truncate(top_k);
    Ok(scored
        .into_iter()
        .map(|(distance, mut hit)| {
            hit.score = 1.0 / (1.0 + distance);
            hit
        })
        .collect())
}

/// Delete every chunk belonging to a page. Used when a source document
/// is removed, or before a full re-embed of a page whose content shrank.
#[tauri::command]
pub async fn vector_delete_page(project_path: String, page_id: String) -> Result<(), String> {
    run_guarded_async("vector_delete_page", async move {
        validate_page_id_for_v2(&page_id)?;
        let lock = vectorstore_v2_lock(&project_path);
        let _guard = lock.write().await;

        let db = connect(&db_path(&project_path))
            .execute()
            .await
            .map_err(|e| format!("DB connect error: {e}"))?;

        let tables = db
            .table_names()
            .execute()
            .await
            .map_err(|e| format!("List tables error: {e}"))?;

        if !tables.contains(&TABLE_V2.to_string()) {
            return Ok(());
        }

        let table = db
            .open_table(TABLE_V2)
            .execute()
            .await
            .map_err(|e| format!("Open table error: {e}"))?;

        table
            .delete(&format!("page_id = '{}'", page_id))
            .await
            .map_err(|e| format!("Delete error: {e}"))?;

        Ok(())
    })
    .await
}

/// Total chunk count in the v2 table (not pages — chunks). Useful for
/// "vector index has N chunks" status text.
#[tauri::command]
pub async fn vector_count_chunks(project_path: String) -> Result<usize, String> {
    run_guarded_async("vector_count_chunks", async move {
        let lock = vectorstore_v2_lock(&project_path);
        let _guard = lock.read().await;

        let db = connect(&db_path(&project_path))
            .execute()
            .await
            .map_err(|e| format!("DB connect error: {e}"))?;

        let tables = db
            .table_names()
            .execute()
            .await
            .map_err(|e| format!("List tables error: {e}"))?;

        if !tables.contains(&TABLE_V2.to_string()) {
            return Ok(0);
        }

        let table = db
            .open_table(TABLE_V2)
            .execute()
            .await
            .map_err(|e| format!("Open table error: {e}"))?;

        let count = table
            .count_rows(None)
            .await
            .map_err(|e| format!("Count error: {e}"))?;

        Ok(count)
    })
    .await
}

/// Drop the v2 chunk table entirely. Used by Settings → Embedding
/// "Re-index all pages" so a rebuild reflects the current wiki tree
/// exactly and removes chunks for deleted/renamed pages.
#[tauri::command]
pub async fn vector_clear_chunks(project_path: String) -> Result<(), String> {
    run_guarded_async("vector_clear_chunks", async move {
        let lock = vectorstore_v2_lock(&project_path);
        let _guard = lock.write().await;

        let db = connect(&db_path(&project_path))
            .execute()
            .await
            .map_err(|e| format!("DB connect error: {e}"))?;

        let tables = db
            .table_names()
            .execute()
            .await
            .map_err(|e| format!("List tables error: {e}"))?;

        if !tables.contains(&TABLE_V2.to_string()) {
            return Ok(());
        }

        db.drop_table(TABLE_V2, &[])
            .await
            .map_err(|e| format!("Drop chunk table error: {e}"))?;

        Ok(())
    })
    .await
}

/// Ensure the v2 chunk table has the indices search depends on:
/// - IvfFlat on `vector`: without it every KNN is a flat brute-force scan
///   over the whole table — on a full-size library that alone costs
///   seconds per query. IvfFlat is chosen over IvfPq deliberately:
///   distances stay exact (no PQ quantization loss); only the partition
///   pruning is approximate.
/// - BTree on `page_id`: the pushed-down `page_id IN (...)` prefilter
///   otherwise evaluates per row over every chunk (measured 2026-10-20:
///   422 ids = 776ms, 2,000 = 4.3s, 8,254 = 25s — linear in list size).
///   With the scalar index the predicate resolves via index lookup.
/// Rows appended after the indices were built are still searched (LanceDB
/// falls back to flat scans over unindexed fragments), so correctness
/// never depends on re-running this. Returns "no-table" or a
/// comma-joined status per index ("exists,created").
pub async fn ensure_vector_index_inner(project_path: &str) -> Result<String, String> {
    let lock = vectorstore_v2_lock(project_path);
    let _guard = lock.write().await;

    let db = connect(&db_path(project_path))
        .execute()
        .await
        .map_err(|e| format!("DB connect error: {e}"))?;

    let tables = db
        .table_names()
        .execute()
        .await
        .map_err(|e| format!("List tables error: {e}"))?;

    if !tables.contains(&TABLE_V2.to_string()) {
        return Ok("no-table".to_string());
    }

    let table = db
        .open_table(TABLE_V2)
        .execute()
        .await
        .map_err(|e| format!("Open table error: {e}"))?;

    let indices = table
        .list_indices()
        .await
        .map_err(|e| format!("List indices error: {e}"))?;
    let indexed_columns = |column: &str| {
        indices
            .iter()
            .any(|cfg| cfg.columns.iter().any(|c| c == column))
    };

    let mut statuses: Vec<String> = Vec::new();
    if !indexed_columns("vector") {
        table
            .create_index(&["vector"], Index::IvfFlat(IvfFlatIndexBuilder::default()))
            .execute()
            .await
            .map_err(|e| format!("Create vector index error: {e}"))?;
        statuses.push("created(vector)".to_string());
    } else {
        statuses.push("exists(vector)".to_string());
    }
    if !indexed_columns("page_id") {
        table
            .create_index(&["page_id"], Index::BTree(BTreeIndexBuilder::default()))
            .execute()
            .await
            .map_err(|e| format!("Create page_id scalar index error: {e}"))?;
        statuses.push("created(page_id-btree)".to_string());
    } else {
        statuses.push("exists(page_id-btree)".to_string());
    }
    Ok(statuses.join(","))
}

/// Explicit idempotent trigger for building the vector index (backfill for
/// tables written before indexing existed, or after a bulk re-index).
#[tauri::command]
pub async fn vector_ensure_index(project_path: String) -> Result<String, String> {
    run_guarded_async("vector_ensure_index", async move {
        ensure_vector_index_inner(&project_path).await
    })
    .await
}

/// Compact the v2 chunk table and prune old LanceDB versions after bulk
/// embedding writes, then make sure the vector index exists (so a rebuild
/// ends indexed, not flat-scan slow). This is intentionally a separate
/// best-effort command so an already-successful rebuild is not reported as
/// failed if maintenance hits a platform-specific LanceDB error.
#[tauri::command]
pub async fn vector_optimize_chunks(project_path: String) -> Result<(), String> {
    run_guarded_async("vector_optimize_chunks", async move {
        let lock = vectorstore_v2_lock(&project_path);
        let _guard = lock.write().await;

        let db = connect(&db_path(&project_path))
            .execute()
            .await
            .map_err(|e| format!("DB connect error: {e}"))?;

        let tables = db
            .table_names()
            .execute()
            .await
            .map_err(|e| format!("List tables error: {e}"))?;

        if !tables.contains(&TABLE_V2.to_string()) {
            return Ok(());
        }

        let table = db
            .open_table(TABLE_V2)
            .execute()
            .await
            .map_err(|e| format!("Open table error: {e}"))?;

        table
            .optimize(OptimizeAction::Compact {
                options: CompactionOptions::default(),
                remap_options: None,
            })
            .await
            .map_err(|e| format!("Compact chunks error: {e}"))?;

        table
            .optimize(OptimizeAction::Prune {
                // Keep only versions older than the current table snapshot.
                // We deliberately leave `delete_unverified` disabled because
                // users may run multiple app instances against the same
                // project, and LanceDB documents forced unverified deletion as
                // unsafe under concurrent cross-process access.
                older_than: Some(Duration::try_seconds(0).expect("valid duration")),
                delete_unverified: Some(false),
                error_if_tagged_old_versions: Some(false),
            })
            .await
            .map_err(|e| format!("Prune old chunk versions error: {e}"))?;

        // Index maintenance rides along so bulk writes (settings re-index,
        // ingest batches) always leave the table searchable without a flat
        // full scan. A failure here surfaces instead of silently leaving
        // the table unindexed — search would stay correct but slow.
        // The write guard is released first: ensure takes the same lock.
        drop(_guard);
        let index_status = ensure_vector_index_inner(&project_path).await?;
        eprintln!("[VectorStore] vector index after optimize: {index_status}");

        Ok(())
    })
    .await
}

/// Report whether the legacy per-page v1 table exists with any rows —
/// the TS layer uses this to show a one-time "re-index to v2" prompt in
/// Settings → Embedding after upgrading. Returns 0 when v1 is absent or
/// empty; otherwise returns the row count.
#[tauri::command]
pub async fn vector_legacy_row_count(project_path: String) -> Result<usize, String> {
    run_guarded_async("vector_legacy_row_count", async move {
        let db = connect(&db_path(&project_path))
            .execute()
            .await
            .map_err(|e| format!("DB connect error: {e}"))?;

        let tables = db
            .table_names()
            .execute()
            .await
            .map_err(|e| format!("List tables error: {e}"))?;

        if !tables.contains(&TABLE_V1.to_string()) {
            return Ok(0);
        }

        let table = db
            .open_table(TABLE_V1)
            .execute()
            .await
            .map_err(|e| format!("Open table error: {e}"))?;

        let count = table
            .count_rows(None)
            .await
            .map_err(|e| format!("Count error: {e}"))?;

        Ok(count)
    })
    .await
}

/// Drop the legacy v1 table entirely. Called from Settings → Embedding
/// after the user has re-indexed into v2 so the orphaned v1 table stops
/// taking disk space. No-op if v1 isn't present.
#[tauri::command]
pub async fn vector_drop_legacy(project_path: String) -> Result<(), String> {
    run_guarded_async("vector_drop_legacy", async move {
        let db = connect(&db_path(&project_path))
            .execute()
            .await
            .map_err(|e| format!("DB connect error: {e}"))?;

        let tables = db
            .table_names()
            .execute()
            .await
            .map_err(|e| format!("List tables error: {e}"))?;

        if !tables.contains(&TABLE_V1.to_string()) {
            return Ok(());
        }

        // LanceDB 0.27's drop_table takes (name, namespace) — we keep
        // the default namespace by passing an empty slice.
        db.drop_table(TABLE_V1, &[])
            .await
            .map_err(|e| format!("Drop table error: {e}"))?;

        Ok(())
    })
    .await
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
//
// These exercise the pure data-shape and upsert/search/delete contracts
// of the v2 chunk store against a throwaway LanceDB instance per test.
// The goal is to catch schema drift and misbehaving batch construction
// early — they are NOT end-to-end tests of the embedding pipeline
// (that lives on the TS side).
// ──────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests_v2 {
    use super::*;
    use std::path::PathBuf;

    /// Unique temp project dir per test. `tokio::test` runs tests in
    /// parallel threads so wall-clock nanoseconds aren't sufficient — a
    /// process-wide atomic counter guarantees uniqueness even when two
    /// tests call this at the same tick. Not cleaned up on purpose:
    /// LanceDB's internal file handles can linger briefly after `drop`
    /// and aggressive removal introduces flaky failures on CI.
    fn tmp_project() -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let id = COUNTER.fetch_add(1, Ordering::SeqCst);
        let p = std::env::temp_dir().join(format!("llm-wiki-vtest-{}-{}", ts, id));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    /// Deterministic toy embedding of fixed dim. Different seeds produce
    /// different vectors so nearest-neighbour ordering is stable but
    /// non-trivial.
    fn fake_embedding(seed: u32, dim: usize) -> Vec<f32> {
        (0..dim)
            .map(|i| {
                let x = ((seed.wrapping_mul(2654435761)) ^ (i as u32)) as f32;
                (x / u32::MAX as f32).sin()
            })
            .collect()
    }

    fn make_chunks(page_id: &str, n: u32, dim: usize) -> Vec<ChunkUpsertInput> {
        (0..n)
            .map(|i| ChunkUpsertInput {
                chunk_index: i,
                chunk_text: format!("{} chunk {}", page_id, i),
                heading_path: format!("## Heading {}", i),
                embedding: fake_embedding(i, dim),
            })
            .collect()
    }

    fn chunk_table_version_count(project_path: &PathBuf) -> usize {
        let versions_dir = project_path
            .join(".llm-wiki")
            .join("lancedb")
            .join(format!("{TABLE_V2}.lance"))
            .join("_versions");
        std::fs::read_dir(versions_dir)
            .map(|entries| entries.filter_map(Result::ok).count())
            .unwrap_or(0)
    }

    #[test]
    fn page_id_validation_allows_unicode_wiki_stems() {
        let page_id = "concepts/反硝化除磷·A2O：DPAO + 50% & x（测试），v1.2";
        assert!(validate_page_id(page_id).is_ok());
        assert!(validate_page_id_for_v2(page_id).is_ok());
    }

    #[test]
    fn page_id_validation_rejects_filter_and_path_footguns() {
        for page_id in [
            "bad'quote",
            "bad\"quote",
            "bad\\slash",
            "bad\nnewline",
            "bad\ttab",
            "bad\0nul",
            "soft\u{00AD}hyphen",
            "arabic\u{061C}mark",
            "zero\u{200B}width",
            "line\u{2028}sep",
            "para\u{2029}sep",
            "bidi\u{202E}override",
            "\u{FEFF}bom",
            "annotation\u{FFF9}mark",
            "tag\u{E0041}char",
        ] {
            assert!(
                validate_page_id(page_id).is_err(),
                "{page_id:?} should be rejected"
            );
            assert!(
                validate_page_id_for_v2(page_id).is_err(),
                "{page_id:?} should be rejected"
            );
        }
    }

    #[test]
    fn page_id_validation_rejects_empty_and_overlong_ids() {
        assert!(validate_page_id("").is_err());
        assert!(validate_page_id_for_v2("").is_err());

        let ascii_boundary = "a".repeat(MAX_PAGE_ID_CHARS);
        assert!(validate_page_id(&ascii_boundary).is_ok());
        assert!(validate_page_id_for_v2(&ascii_boundary).is_ok());

        let cjk_boundary = "测".repeat(MAX_PAGE_ID_CHARS);
        assert!(validate_page_id(&cjk_boundary).is_ok());
        assert!(validate_page_id_for_v2(&cjk_boundary).is_ok());

        let too_long = "测".repeat(MAX_PAGE_ID_CHARS + 1);
        assert!(validate_page_id(&too_long).is_err());
        assert!(validate_page_id_for_v2(&too_long).is_err());
    }

    #[test]
    fn page_id_validation_allows_hash_in_debug_chunk_ids() {
        let page_id = "source#section";
        assert!(validate_page_id(page_id).is_ok());
        assert!(validate_page_id_for_v2(page_id).is_ok());
    }

    #[tokio::test]
    async fn v2_upsert_then_count() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        let chunks = make_chunks("my-page", 3, 16);
        vector_upsert_chunks(pp.clone(), "my-page".into(), chunks)
            .await
            .unwrap();

        let count = vector_count_chunks(pp.clone()).await.unwrap();
        assert_eq!(count, 3);
    }

    #[tokio::test]
    async fn v2_upsert_replaces_existing_chunks_for_page() {
        // First insert 5 chunks, then re-upsert 2 — the final count
        // should be 2, not 7 (old rows deleted before insert).
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        vector_upsert_chunks(pp.clone(), "page-a".into(), make_chunks("page-a", 5, 16))
            .await
            .unwrap();
        assert_eq!(vector_count_chunks(pp.clone()).await.unwrap(), 5);

        vector_upsert_chunks(pp.clone(), "page-a".into(), make_chunks("page-a", 2, 16))
            .await
            .unwrap();
        assert_eq!(vector_count_chunks(pp.clone()).await.unwrap(), 2);
    }

    #[tokio::test]
    async fn v2_different_pages_coexist() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        vector_upsert_chunks(pp.clone(), "page-a".into(), make_chunks("page-a", 3, 16))
            .await
            .unwrap();
        vector_upsert_chunks(pp.clone(), "page-b".into(), make_chunks("page-b", 4, 16))
            .await
            .unwrap();

        assert_eq!(vector_count_chunks(pp.clone()).await.unwrap(), 7);
    }

    #[tokio::test]
    async fn v2_delete_page_removes_only_its_chunks() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        vector_upsert_chunks(pp.clone(), "page-a".into(), make_chunks("page-a", 3, 16))
            .await
            .unwrap();
        vector_upsert_chunks(pp.clone(), "page-b".into(), make_chunks("page-b", 2, 16))
            .await
            .unwrap();
        assert_eq!(vector_count_chunks(pp.clone()).await.unwrap(), 5);

        vector_delete_page(pp.clone(), "page-a".into())
            .await
            .unwrap();
        assert_eq!(vector_count_chunks(pp.clone()).await.unwrap(), 2);
    }

    #[tokio::test]
    async fn v2_search_returns_chunks_with_metadata() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        vector_upsert_chunks(pp.clone(), "page-a".into(), make_chunks("page-a", 3, 16))
            .await
            .unwrap();

        let query = fake_embedding(1, 16);
        let results = vector_search_chunks(pp.clone(), query, 10, None)
            .await
            .unwrap();
        assert!(!results.is_empty());
        // Every result should carry page_id, chunk_id, chunk_text, heading_path.
        for r in &results {
            assert_eq!(r.page_id, "page-a");
            assert!(r.chunk_id.starts_with("page-a#"));
            assert!(r.chunk_text.contains("chunk"));
            assert!(r.heading_path.starts_with("## Heading"));
        }
    }

    #[tokio::test]
    async fn v2_search_pushed_down_page_ids_restricts_knn() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        vector_upsert_chunks(pp.clone(), "page-a".into(), make_chunks("page-a", 3, 16))
            .await
            .unwrap();
        vector_upsert_chunks(pp.clone(), "page-b".into(), make_chunks("page-b", 3, 16))
            .await
            .unwrap();

        let query = fake_embedding(1, 16);
        // Unfiltered: both pages appear.
        let all = vector_search_chunks(pp.clone(), query.clone(), 10, None)
            .await
            .unwrap();
        let distinct: std::collections::BTreeSet<_> =
            all.iter().map(|r| r.page_id.as_str()).collect();
        assert_eq!(distinct.len(), 2);

        // Pushed down to page-b only: every hit belongs to page-b even
        // though page-a chunks rank higher for this query vector.
        let only_b = vector_search_chunks(pp.clone(), query, 10, Some(vec!["page-b".into()]))
            .await
            .unwrap();
        assert!(!only_b.is_empty());
        for r in &only_b {
            assert_eq!(r.page_id, "page-b");
        }

        // Empty list behaves like None (no restriction).
        let empty = vector_search_chunks(pp.clone(), fake_embedding(2, 16), 10, Some(vec![]))
            .await
            .unwrap();
        assert!(!empty.is_empty());
    }

    #[test]
    fn page_id_predicate_quotes_values() {
        let pred = page_id_in_predicate(&["questions/a".into(), "it's".into()]);
        assert_eq!(pred, "page_id IN ('questions/a', 'it''s')");
    }

    #[tokio::test]
    async fn narrow_predicate_exact_path_returns_target_rows() {
        // 单页 path_prefix 的生产形态（2026-10-21 实测：窄谓词经 IVF 返回
        // 空）。exact 路径走 scalar-index 取行 + 内存打分，不经过 IVF
        // partition 选择，结构上无假阴性：必须返回谓词命中的全部行。
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        vector_upsert_chunks(
            pp.clone(),
            "sources/narrow-target".into(),
            make_chunks("t", 2, 16),
        )
        .await
        .unwrap();
        vector_upsert_chunks(
            pp.clone(),
            "concepts/near-decoy".into(),
            make_chunks("d", 5, 16),
        )
        .await
        .unwrap();

        let query = fake_embedding(3, 16);
        let hits = vector_search_chunks_predicate(
            pp.clone(),
            query.clone(),
            10,
            "page_id IN ('sources/narrow-target')".into(),
        )
        .await
        .unwrap();
        assert_eq!(
            hits.len(),
            2,
            "exact path must return every matching row: {hits:?}"
        );
        for r in &hits {
            assert_eq!(r.page_id, "sources/narrow-target");
            // score keeps the 1/(1+L2) convention of the indexed path.
            assert!(r.score.is_finite() && (0.0..1.0).contains(&r.score));
        }

        // A predicate matching zero rows returns empty honestly — it no
        // longer falls back to an unconstrained whole-library KNN whose
        // results the post-map would then drop.
        let none = vector_search_chunks_predicate(
            pp,
            query,
            10,
            "page_id IN ('sources/absent')".into(),
        )
        .await
        .unwrap();
        assert!(none.is_empty());
    }

    // 诊断 v2（2026-10-15）：本地合成 1156 规律短 id 全过，但生产实例
    // type=question（1156 真实 id）挂——直读生产库拿真实报错，区分
    // 数量 / id 长度 / 索引形态。只读查询，不动库。
    // 跑法：cargo test --lib diag_prod_predicate -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "需要本机便携版生产库在场（C:/Users/Yang/llm-wiki-portable）"]
    async fn diag_prod_predicate_real_ids() {
        let project = "C:/Users/Yang/llm-wiki-portable/data/wiki";
        let mut ids: Vec<String> = Vec::new();
        let dir = std::path::Path::new(project).join("wiki/questions");
        for entry in walkdir::WalkDir::new(&dir)
            .into_iter()
            .filter_map(Result::ok)
        {
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let rel = p.strip_prefix(std::path::Path::new(project).join("wiki"))
                .unwrap();
            let id = rel.to_string_lossy().replace('\\', "/");
            ids.push(id.trim_end_matches(".md").to_string());
        }
        ids.sort();
        let total = ids.len();
        let longest = ids.iter().max_by_key(|i| i.len()).unwrap();
        println!("real question ids: {total}; longest ({} chars): {}", longest.len(), longest);
        let dim = 2048usize;
        for n in [total, total / 2, 300] {
            let n = n.min(total);
            let sub: Vec<String> = ids[..n].to_vec();
            let vec: Vec<f32> = (0..dim).map(|i| ((i % 97) as f32) / 97.0).collect();
            match vector_search_chunks(project.to_string(), vec, 10, Some(sub)).await {
                Ok(v) => println!("prefix n={n} => Ok({} hits)", v.len()),
                Err(e) => println!("prefix n={n} => Err: {}", &e[..e.len().min(400)]),
            }
        }
        // 全量但每 id 截短到 10 字符——区分「数量」与「id 内容/长度」。
        // 截短 id 库里不存在（必然 0 命中），只看查询是否报错。
        let short: Vec<String> = ids.iter().map(|i| i.chars().take(10).collect()).collect();
        let vec: Vec<f32> = (0..dim).map(|i| ((i % 89) as f32) / 89.0).collect();
        match vector_search_chunks(project.to_string(), vec, 10, Some(short)).await {
            Ok(v) => println!("shortened-all n={total} => Ok({} hits)", v.len()),
            Err(e) => println!("shortened-all => Err: {}", &e[..e.len().min(400)]),
        }
    }

    #[tokio::test]
    async fn v2_empty_upsert_is_a_noop_not_an_error() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        // Upserting [] should succeed and NOT wipe existing rows — this
        // is the "transient ingest failure shouldn't nuke index" contract.
        vector_upsert_chunks(pp.clone(), "page-a".into(), make_chunks("page-a", 3, 16))
            .await
            .unwrap();
        vector_upsert_chunks(pp.clone(), "page-a".into(), vec![])
            .await
            .unwrap();

        assert_eq!(vector_count_chunks(pp.clone()).await.unwrap(), 3);
    }

    #[tokio::test]
    async fn v2_search_on_missing_table_returns_empty() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        let query = fake_embedding(1, 16);
        let results = vector_search_chunks(pp, query, 10, None).await.unwrap();
        assert!(results.is_empty());
    }

    #[tokio::test]
    async fn v2_count_on_missing_table_returns_zero() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        assert_eq!(vector_count_chunks(pp).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn v2_delete_page_is_idempotent() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        // Delete on missing table: ok.
        vector_delete_page(pp.clone(), "never-existed".into())
            .await
            .unwrap();

        // Insert + delete + delete again: ok.
        vector_upsert_chunks(pp.clone(), "page-a".into(), make_chunks("page-a", 2, 16))
            .await
            .unwrap();
        vector_delete_page(pp.clone(), "page-a".into())
            .await
            .unwrap();
        vector_delete_page(pp.clone(), "page-a".into())
            .await
            .unwrap();

        assert_eq!(vector_count_chunks(pp).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn v2_clear_chunks_drops_entire_chunk_table_and_is_idempotent() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        vector_upsert_chunks(pp.clone(), "page-a".into(), make_chunks("page-a", 3, 16))
            .await
            .unwrap();
        vector_upsert_chunks(pp.clone(), "page-b".into(), make_chunks("page-b", 4, 16))
            .await
            .unwrap();
        assert_eq!(vector_count_chunks(pp.clone()).await.unwrap(), 7);

        vector_clear_chunks(pp.clone()).await.unwrap();
        assert_eq!(vector_count_chunks(pp.clone()).await.unwrap(), 0);

        vector_clear_chunks(pp.clone()).await.unwrap();
        assert_eq!(vector_count_chunks(pp.clone()).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn v2_optimize_chunks_prunes_versions_and_preserves_rows() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        vector_optimize_chunks(pp.clone()).await.unwrap();

        for i in 0..6 {
            let page_id = format!("page-{i}");
            vector_upsert_chunks(pp.clone(), page_id.clone(), make_chunks(&page_id, 2, 16))
                .await
                .unwrap();
        }
        assert_eq!(vector_count_chunks(pp.clone()).await.unwrap(), 12);
        let versions_before = chunk_table_version_count(&p);
        assert!(
            versions_before > 1,
            "expected multiple LanceDB versions before optimize"
        );

        vector_optimize_chunks(pp.clone()).await.unwrap();
        let versions_after = chunk_table_version_count(&p);
        assert!(
            versions_after < versions_before,
            "expected optimize to prune old versions ({versions_before} -> {versions_after})"
        );
        assert_eq!(vector_count_chunks(pp.clone()).await.unwrap(), 12);
    }

    #[tokio::test]
    async fn v2_rejects_mismatched_embedding_dimensions() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        // First chunk sets dim=16; second chunk has dim=8 → should error.
        let bad = vec![
            ChunkUpsertInput {
                chunk_index: 0,
                chunk_text: "ok".into(),
                heading_path: "".into(),
                embedding: fake_embedding(0, 16),
            },
            ChunkUpsertInput {
                chunk_index: 1,
                chunk_text: "bad".into(),
                heading_path: "".into(),
                embedding: fake_embedding(1, 8),
            },
        ];
        let result = vector_upsert_chunks(pp, "page-a".into(), bad).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().to_lowercase().contains("dim"));
    }

    #[tokio::test]
    async fn v2_rejects_invalid_page_id() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        // Quote would be a SQL-injection footgun for the delete filter.
        let result = vector_upsert_chunks(pp, "bad'; DROP".into(), make_chunks("x", 1, 16)).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn legacy_row_count_returns_zero_when_absent() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        // v1 table doesn't exist in a fresh temp project.
        assert_eq!(vector_legacy_row_count(pp).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn legacy_row_count_sees_v1_rows() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        // Populate v1 via the legacy vector_upsert.
        vector_upsert(pp.clone(), "old-page".into(), fake_embedding(0, 16))
            .await
            .unwrap();

        let count = vector_legacy_row_count(pp.clone()).await.unwrap();
        assert_eq!(count, 1);

        // v2 count is untouched.
        assert_eq!(vector_count_chunks(pp).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn drop_legacy_removes_v1_but_leaves_v2() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        vector_upsert(pp.clone(), "old-page".into(), fake_embedding(0, 16))
            .await
            .unwrap();
        vector_upsert_chunks(
            pp.clone(),
            "new-page".into(),
            make_chunks("new-page", 2, 16),
        )
        .await
        .unwrap();

        assert_eq!(vector_legacy_row_count(pp.clone()).await.unwrap(), 1);
        assert_eq!(vector_count_chunks(pp.clone()).await.unwrap(), 2);

        vector_drop_legacy(pp.clone()).await.unwrap();

        assert_eq!(vector_legacy_row_count(pp.clone()).await.unwrap(), 0);
        assert_eq!(vector_count_chunks(pp.clone()).await.unwrap(), 2);
    }

    #[tokio::test]
    async fn drop_legacy_is_noop_when_v1_missing() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        // Should just return Ok(()), not error.
        vector_drop_legacy(pp).await.unwrap();
    }
}
