/**
 * §3.2 graph pipeline parity runner (one-shot migration tool).
 *
 * Runs the RETIRED full-read pipeline (legacy/, byte archive of the
 * pre-migration wiki-graph.ts + graph-relevance.ts) and the replacement
 * Rust-snapshot pipeline against the same library, then writes a
 * structured diff report to parity-report.json. Drift must be attributed
 * item-by-item against the known-drift list in README.md; unattributable
 * drift blocks the migration (plan §3.2 acceptance gate).
 *
 * Prerequisites (all default-skip, so CI never runs this):
 *   1. A STATIC library (no concurrent writer session).
 *   2. The Rust-side dump of the same library:
 *        export PROTOC=... && cd src-tauri
 *        LLM_WIKI_PARITY_DUMP=<project> \
 *        LLM_WIKI_PARITY_OUT=../tools/graph-pipeline-parity/graph-snapshot-dump.json \
 *        cargo test --lib dump_graph_snapshot_for_parity -- --ignored
 *   3. Run from the repo root:
 *        LLM_WIKI_PARITY_LIB=<project> npx vitest run tools/graph-pipeline-parity
 */

import fs from "node:fs"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import type { FileNode } from "@/types/wiki"

const env = vi.hoisted(() => ({
  lib: process.env.LLM_WIKI_PARITY_LIB ?? "",
  dump: process.env.LLM_WIKI_PARITY_DUMP_JSON ?? "",
  report: process.env.LLM_WIKI_PARITY_REPORT ?? "",
}))

// Defaults are cwd-relative so the runner works from the repo root as
// documented in README.md.
const DUMP = env.dump || "tools/graph-pipeline-parity/graph-snapshot-dump.json"
const REPORT = env.report || "tools/graph-pipeline-parity/parity-report.json"

// Node-fs stand-in for the Tauri IPC layer. Only the legacy pipeline uses
// listDirectory/readFile; the snapshot pipeline's wiki_graph_snapshot is
// served from the Rust dump, so both sides see the same library state.
vi.mock("@/commands/fs", async () => {
  const nodeFs = await import("node:fs")

  function walkDirectory(dir: string): FileNode[] {
    const out: FileNode[] = []
    for (const entry of nodeFs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        out.push({ name: entry.name, path: full, is_dir: true, children: walkDirectory(full) })
      } else {
        out.push({ name: entry.name, path: full, is_dir: false })
      }
    }
    return out
  }

  return {
    listDirectory: async (dir: string): Promise<FileNode[]> => walkDirectory(dir),
    readFile: (p: string): Promise<string> => Promise.resolve(nodeFs.readFileSync(p, "utf8")),
    wikiGraphSnapshot: async () => JSON.parse(nodeFs.readFileSync(DUMP, "utf8")),
  }
})

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: { getState: () => ({ dataVersion: 0 }) },
}))

interface PipelineNode {
  id: string
  label: string
  type: string
  path: string
  linkCount: number
}

interface PipelineResult {
  nodes: PipelineNode[]
  edges: { source: string; target: string }[]
}

function nodeFieldDrift(a: PipelineNode[], b: PipelineNode[]): Record<string, number> {
  const modernById = new Map(b.map((n) => [n.id, n]))
  const drift: Record<string, number> = { label: 0, type: 0, path: 0, linkCount: 0 }
  for (const node of a) {
    const other = modernById.get(node.id)
    if (!other) continue
    if (node.label !== other.label) drift.label += 1
    if (node.type !== other.type) drift.type += 1
    if (node.path !== other.path) drift.path += 1
    if (node.linkCount !== other.linkCount) drift.linkCount += 1
  }
  return drift
}

function undirectedEdgeKey(e: { source: string; target: string }): string {
  return e.source < e.target ? `${e.source}::${e.target}` : `${e.target}::${e.source}`
}

describe.skipIf(!env.lib)("graph pipeline parity (§3.2)", () => {
  it("legacy full-read pipeline vs Rust snapshot pipeline", async () => {
    expect(fs.existsSync(DUMP), "Rust dump missing — run dump_graph_snapshot_for_parity first").toBe(true)

    const legacy = await import("./legacy/wiki-graph-legacy")
    const modern = await import("@/lib/wiki-graph")

    const tLegacyStart = performance.now()
    const legacyGraph = (await legacy.buildWikiGraph(env.lib)) as PipelineResult
    const legacyMs = performance.now() - tLegacyStart

    const tModernStart = performance.now()
    const modernGraph = (await modern.buildWikiGraph(env.lib, 0)) as PipelineResult
    const modernMs = performance.now() - tModernStart

    const legacyIds = new Set(legacyGraph.nodes.map((n) => n.id))
    const modernIds = new Set(modernGraph.nodes.map((n) => n.id))
    const nodesOnlyInLegacy = [...legacyIds].filter((id) => !modernIds.has(id)).sort()
    const nodesOnlyInModern = [...modernIds].filter((id) => !legacyIds.has(id)).sort()

    const legacyEdgeKeys = new Set(legacyGraph.edges.map(undirectedEdgeKey))
    const modernEdgeKeys = new Set(modernGraph.edges.map(undirectedEdgeKey))
    const edgesOnlyInLegacy = [...legacyEdgeKeys].filter((k) => !modernEdgeKeys.has(k)).sort()
    const edgesOnlyInModern = [...modernEdgeKeys].filter((k) => !legacyEdgeKeys.has(k)).sort()

    const report = {
      lib: env.lib,
      dump: env.dump,
      timingsMs: { legacy: legacyMs, modern: modernMs },
      counts: {
        legacyNodes: legacyGraph.nodes.length,
        modernNodes: modernGraph.nodes.length,
        legacyEdges: legacyGraph.edges.length,
        modernEdges: modernGraph.edges.length,
      },
      nodes: {
        onlyInLegacy: nodesOnlyInLegacy,
        onlyInModern: nodesOnlyInModern,
        fieldDrift: nodeFieldDrift(legacyGraph.nodes, modernGraph.nodes),
      },
      edges: {
        onlyInLegacyCount: edgesOnlyInLegacy.length,
        onlyInModernCount: edgesOnlyInModern.length,
        onlyInLegacySample: edgesOnlyInLegacy.slice(0, 100),
        onlyInModernSample: edgesOnlyInModern.slice(0, 100),
      },
      // Manual-attribution gate: every entry above must land in a
      // README.md known-drift bucket or the migration is blocked.
      acceptance: {
        nodeSetDiff: nodesOnlyInLegacy.length + nodesOnlyInModern.length,
        edgeSetDiff: edgesOnlyInLegacy.length + edgesOnlyInModern.length,
      },
    }
    fs.writeFileSync(REPORT, JSON.stringify(report, null, 2))
    console.log(`parity report written to ${REPORT}`)
    expect(report.acceptance.nodeSetDiff).toBeGreaterThanOrEqual(0)
  }, 900_000)
})
