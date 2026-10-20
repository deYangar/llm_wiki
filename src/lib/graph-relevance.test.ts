import { beforeEach, describe, expect, it } from "vitest"
import {
  buildRetrievalGraphFromSnapshot,
  calculateRelevance,
  clearGraphCache,
  type GraphSnapshotNodeInput,
} from "./graph-relevance"

function node(overrides: Partial<GraphSnapshotNodeInput> & { id: string }): GraphSnapshotNodeInput {
  return {
    title: overrides.id,
    type: "concept",
    path: `/project/wiki/${overrides.id}.md`,
    sources: [],
    ...overrides,
  }
}

function edge(source: string, target: string): { source: string; target: string } {
  return { source, target }
}

beforeEach(() => {
  clearGraphCache()
})

describe("buildRetrievalGraphFromSnapshot", () => {
  it("builds bidirectional links from snapshot edges", () => {
    const graph = buildRetrievalGraphFromSnapshot(
      "/project",
      1,
      [node({ id: "a" }), node({ id: "b" }), node({ id: "c" })],
      [edge("a", "b"), edge("c", "b")],
    )

    expect(graph.nodes.get("a")?.outLinks).toEqual(new Set(["b"]))
    expect(graph.nodes.get("a")?.inLinks.size).toBe(0)
    expect(graph.nodes.get("b")?.inLinks).toEqual(new Set(["a", "c"]))
    expect(graph.nodes.get("b")?.outLinks.size).toBe(0)
  })

  it("carries title, type, path and frozen sources from the snapshot", () => {
    const graph = buildRetrievalGraphFromSnapshot(
      "/project",
      1,
      [node({ id: "a", title: "页面 A", type: "entity", sources: ["sources/x.pdf"] })],
      [],
    )

    const a = graph.nodes.get("a")
    expect(a?.title).toBe("页面 A")
    expect(a?.type).toBe("entity")
    expect(a?.path).toBe("/project/wiki/a.md")
    expect(a?.sources).toEqual(["sources/x.pdf"])
    expect(Object.isFrozen(a?.sources)).toBe(true)
    expect(Object.isFrozen(a?.outLinks)).toBe(true)
  })

  it("ignores edges whose endpoints left the node set", () => {
    // Query-adjacent leftovers from the Rust build are dropped upstream;
    // a stale edge must not resurrect a missing node's link sets.
    const graph = buildRetrievalGraphFromSnapshot(
      "/project",
      1,
      [node({ id: "a" })],
      [edge("a", "ghost"), edge("ghost", "a")],
    )

    expect(graph.nodes.get("a")?.outLinks.size).toBe(0)
    expect(graph.nodes.get("a")?.inLinks.size).toBe(0)
    expect(graph.nodes.has("ghost")).toBe(false)
  })

  it("reuses the same-version cache entry within one project", () => {
    const nodes = [node({ id: "a" })]
    const first = buildRetrievalGraphFromSnapshot("/project", 1, nodes, [])
    const second = buildRetrievalGraphFromSnapshot("/project", 1, nodes, [])

    expect(second).toBe(first)
  })

  it("does not reuse a same-version cache entry across projects", () => {
    const first = buildRetrievalGraphFromSnapshot("/project-a", 7, [node({ id: "a", title: "A" })], [])
    const second = buildRetrievalGraphFromSnapshot("/project-b", 7, [node({ id: "a", title: "B" })], [])

    expect(second).not.toBe(first)
    expect(second.nodes.get("a")?.title).toBe("B")
  })

  it("rebuilds when the dataVersion moves", () => {
    const nodes = [node({ id: "a" })]
    const stale = buildRetrievalGraphFromSnapshot("/project", 1, nodes, [])
    const fresh = buildRetrievalGraphFromSnapshot("/project", 2, nodes, [])

    expect(fresh).not.toBe(stale)
    expect(fresh.dataVersion).toBe(2)
  })

  it("clearGraphCache drops the cached entry", () => {
    const nodes = [node({ id: "a" })]
    const first = buildRetrievalGraphFromSnapshot("/project", 1, nodes, [])
    clearGraphCache()
    const second = buildRetrievalGraphFromSnapshot("/project", 1, nodes, [])

    expect(second).not.toBe(first)
  })
})

describe("calculateRelevance over snapshot-built graphs", () => {
  it("scores direct links and source overlap", () => {
    const graph = buildRetrievalGraphFromSnapshot(
      "/project",
      1,
      [
        node({ id: "a", type: "entity", sources: ["s1.pdf", "s2.pdf"] }),
        node({ id: "b", type: "concept", sources: ["s1.pdf"] }),
        node({ id: "c", type: "concept", sources: ["s9.pdf"] }),
      ],
      [edge("a", "b")],
    )
    const a = graph.nodes.get("a")!
    const b = graph.nodes.get("b")!
    const c = graph.nodes.get("c")!

    const linked = calculateRelevance(a, b, graph)
    const unlinked = calculateRelevance(a, c, graph)

    // Direct link (3.0) + one shared source (4.0) + type affinity + common
    // neighbors >= the same pair without the link or the shared source.
    expect(linked).toBeGreaterThan(unlinked)
    expect(linked).toBeGreaterThan(0)
    // Symmetric over the undirected edge set.
    expect(calculateRelevance(b, a, graph)).toBe(linked)
  })
})
