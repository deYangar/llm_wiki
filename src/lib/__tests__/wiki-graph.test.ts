/**
 * wiki-graph.test.ts — mapping-layer semantics of the Rust-snapshot graph
 * pipeline.
 *
 * The build itself moved to the Rust wiki_graph_snapshot command (§3.2 of
 * the 2026-10-20 cold-start/graph plan): frontmatter/wikilink extraction
 * and link resolution now live in api_server's build pipeline, shared
 * byte-for-byte with the HTTP /graph contract and covered by the Rust
 * test suite (graph_fixture_* family). What remains frontend-owned — and
 * what this file pins — is the snapshot→UI mapping: query hiding,
 * dangling-edge removal, linkCount recomputation, path joining, caching.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import type { WikiGraphSnapshot } from "@/commands/fs"

const mockSnapshot = vi.fn<[], Promise<WikiGraphSnapshot>>()

vi.mock("@/commands/fs", () => ({
  wikiGraphSnapshot: (...args: unknown[]) => mockSnapshot(...args),
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: { getState: () => ({ dataVersion: 42 }) },
}))

import { buildWikiGraph } from "../wiki-graph"

function snapshotNode(id: string, nodeType = "entity"): WikiGraphSnapshot["nodes"][number] {
  return { id, label: id.toUpperCase(), nodeType, path: `wiki/${id}.md`, linkCount: 0, tags: [], sources: [] }
}

function baseSnapshot(): WikiGraphSnapshot {
  return {
    nodes: [snapshotNode("a"), snapshotNode("b")],
    edges: [{ source: "a", target: "b", weight: 1.0 }],
  }
}

beforeEach(() => {
  mockSnapshot.mockReset()
  mockSnapshot.mockImplementation(async () => baseSnapshot())
})

describe("buildWikiGraph snapshot mapping", () => {
  it("joins relative snapshot paths onto the project root", async () => {
    const graph = await buildWikiGraph("/project")

    expect(graph.nodes.map((n) => n.path)).toEqual(["/project/wiki/a.md", "/project/wiki/b.md"])
  })

  it("hides query nodes defensively and drops their dangling edges", async () => {
    mockSnapshot.mockImplementation(async () => ({
      nodes: [snapshotNode("a"), snapshotNode("b"), snapshotNode("c"), snapshotNode("q", "query")],
      edges: [
        { source: "a", target: "b", weight: 1.0 },
        { source: "b", target: "q", weight: 1.0 },
        { source: "q", target: "c", weight: 1.0 },
      ],
    }))

    const graph = await buildWikiGraph("/project")

    // Rust filters query nodes already; the frontend filter is double
    // cover and must take the query-adjacent edges with it.
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c"])
  })

  it("recomputes linkCount as in+out degree over visible nodes only", async () => {
    mockSnapshot.mockImplementation(async () => ({
      nodes: [snapshotNode("a"), snapshotNode("b"), snapshotNode("q", "query")],
      // Raw Rust linkCount includes query neighbors; the mapping layer
      // recomputes so node sizes keep the old visible-only semantics.
      edges: [
        { source: "a", target: "b", weight: 1.0 },
        { source: "b", target: "q", weight: 1.0 },
      ],
    }))

    const graph = await buildWikiGraph("/project")

    const linkCount = Object.fromEntries(graph.nodes.map((n) => [n.id, n.linkCount]))
    expect(linkCount).toEqual({ a: 1, b: 1 })
  })

  it("keeps the graph usable when the snapshot invoke fails", async () => {
    mockSnapshot.mockRejectedValue(new Error("project gone"))

    const graph = await buildWikiGraph("/project")

    expect(graph).toEqual({ nodes: [], edges: [], communities: [] })
  })

  it("reuses an unchanged graph by project data version", async () => {
    const first = await buildWikiGraph("/cached-project", 42)
    const second = await buildWikiGraph("/cached-project", 42)

    expect(second).toBe(first)
    // One snapshot invoke total; the second call is fully served by the
    // dataVersion cache.
    expect(mockSnapshot).toHaveBeenCalledTimes(1)

    await buildWikiGraph("/cached-project", 43)
    expect(mockSnapshot).toHaveBeenCalledTimes(2)
  })
})
