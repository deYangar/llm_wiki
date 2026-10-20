//! Invoke-side full-graph snapshot for the frontend graph page (§3.1 of
//! the 2026-10-20 cold-start/graph plan). A thin wrapper over the HTTP
//! `/graph` build pipeline: same cache, same single-flight, same delta
//! rebuild — one call replaces the frontend's two full-library
//! read-every-file passes.

use serde::Serialize;

use crate::api_server::{build_graph_cached, ApiGraphEdge, ApiGraphNode};
use crate::commands::fs::require_absolute_path;
use crate::panic_guard::run_guarded;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiGraphSnapshotResult {
    pub nodes: Vec<ApiGraphNode>,
    pub edges: Vec<ApiGraphEdge>,
}

/// Full graph (all nodes, all edges) for one project. Pagination is
/// intentionally absent — the frontend renders the whole graph and maps
/// the snapshot into its own shapes client-side.
#[tauri::command]
pub async fn wiki_graph_snapshot(project_path: String) -> Result<WikiGraphSnapshotResult, String> {
    require_absolute_path("wiki_graph_snapshot", &project_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        run_guarded("wiki_graph_snapshot", || {
            let snapshot = build_graph_cached(&project_path)?;
            Ok(WikiGraphSnapshotResult {
                nodes: snapshot.nodes.clone(),
                edges: snapshot
                    .edges
                    .iter()
                    .map(|owned| owned.edge.clone())
                    .collect(),
            })
        })
    })
    .await
    .map_err(|e| format!("wiki_graph_snapshot blocking task join error: {e}"))?
}
