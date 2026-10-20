import { describe, expect, it } from "vitest"
import { twoStageGroups, type KnowledgeGroup, type SkeletonPage } from "./knowledge-tree-skeleton"
import type { WikiPageTypeCountRow } from "@/commands/fs"

interface Row {
  path: string
  title: string
}

const row = (path: string, title = path): Row => ({ path, title })

const orderOf = (type: string) => ({ overview: 0, entity: 1, concept: 2 }[type] ?? 99)
const labelOf = (type: string) => type

const counts: WikiPageTypeCountRow[] = [
  { wikiType: "concept", count: 2 },
  { wikiType: "entity", count: 3 },
  { wikiType: "overview", count: 1 },
  { wikiType: "other", count: 0 },
]

const realGroups = [
  ["entity", [row("p1"), row("p2"), row("p3")]],
  ["concept", [row("p4"), row("p5")]],
  ["overview", [row("p6")]],
] as const

describe("twoStageGroups", () => {
  it("renders skeleton groups with header counts when counts arrive first", () => {
    const { groups, countOverrides, skeleton } = twoStageGroups<Row>({
      rowsLoaded: false,
      sortedGroups: [],
      typeCounts: counts,
      orderOf,
      labelOf,
      loadingTitle: "加载中…",
    })

    expect(skeleton).toBe(true)
    // Zero-count buckets are not shown; ordering follows orderOf, not the
    // payload order.
    expect(groups.map(([type]) => type)).toEqual(["overview", "entity", "concept"])
    expect(countOverrides.get("entity")).toBe(3)
    expect(countOverrides.get("concept")).toBe(2)
    expect(countOverrides.get("overview")).toBe(1)

    // One placeholder per group (a loading row when expanded); the header
    // count comes from countOverrides, not items.length.
    const entity = groups.find(([type]) => type === "entity")!
    expect(entity[1]).toHaveLength(1)
    const placeholder = entity[1][0] as SkeletonPage
    expect(placeholder.placeholder).toBe(true)
    expect(placeholder.title).toBe("加载中…")
    expect(placeholder.type).toBe("entity")
  })

  it("switches to the real groups once rows are loaded", () => {
    const sorted: KnowledgeGroup<Row>[] = realGroups.map(([type, items]) => [type, [...items]])
    const { groups, countOverrides, skeleton } = twoStageGroups<Row>({
      rowsLoaded: true,
      sortedGroups: sorted,
      typeCounts: counts,
      orderOf,
      labelOf,
      loadingTitle: "加载中…",
    })
    expect(skeleton).toBe(false)
    expect(countOverrides.size).toBe(0)
    expect(groups.map(([type]) => type)).toEqual(["entity", "concept", "overview"])
    expect(groups[0][1]).toHaveLength(3)
  })

  it("stays on the real groups when counts are missing or empty", () => {
    const sorted: KnowledgeGroup<Row>[] = realGroups.map(([type, items]) => [type, [...items]])
    for (const typeCounts of [null, []]) {
      const { groups, skeleton } = twoStageGroups<Row>({
        rowsLoaded: false,
        sortedGroups: sorted,
        typeCounts: typeCounts as WikiPageTypeCountRow[] | null,
        orderOf,
        labelOf,
        loadingTitle: "加载中…",
      })
      expect(skeleton).toBe(false)
      expect(groups).toBe(sorted)
    }
  })
})
