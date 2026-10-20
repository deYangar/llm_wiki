import { describe, expect, it } from "vitest"
import {
  PAGE_ROW_HEIGHT,
  TYPE_HEADER_ROW_HEIGHT,
  buildRowOffsets,
  buildTreeListRows,
  findVisibleRowRange,
  treeRowHeight,
} from "@/lib/virtual-tree-rows"

interface Page {
  path: string
}

const groups: ReadonlyArray<readonly [string, readonly Page[]]> = [
  ["entity", [{ path: "e1" }, { path: "e2" }, { path: "e3" }]],
  ["concept", [{ path: "c1" }]],
  ["source", [{ path: "s1" }, { path: "s2" }]],
]

describe("buildTreeListRows", () => {
  it("flattens expanded groups into header + page rows", () => {
    const rows = buildTreeListRows(groups, new Set(["entity", "source"]))
    expect(rows.map((r) => r.kind)).toEqual(["header", "page", "page", "page", "header", "header", "page", "page"])
    expect(rows[0]).toEqual({ kind: "header", key: "type:entity", type: "entity", count: 3 })
    expect(rows[1]).toEqual({ kind: "page", key: "e1", page: { path: "e1" } })
    expect(rows[4]).toEqual({ kind: "header", key: "type:concept", type: "concept", count: 1 })
  })

  it("collapsed groups contribute only their header row", () => {
    const rows = buildTreeListRows(groups, new Set<string>())
    expect(rows).toHaveLength(3)
    expect(rows.every((r) => r.kind === "header")).toBe(true)
  })

  it("empty input yields no rows", () => {
    expect(buildTreeListRows([], new Set(["entity"]))).toEqual([])
  })

  it("countOverrides show the real header count for skeleton groups", () => {
    // Skeleton group carries one placeholder item; the override supplies
    // the real count.
    const skeleton: ReadonlyArray<readonly [string, readonly Page[]]> = [
      ["entity", [{ path: "__skeleton__:entity" }]],
    ]
    const overrides = new Map([["entity", 8945]])
    const rows = buildTreeListRows(skeleton, new Set(["entity"]), overrides)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({ kind: "header", key: "type:entity", type: "entity", count: 8945 })
    expect(rows[1]).toEqual({
      kind: "page",
      key: "__skeleton__:entity",
      page: { path: "__skeleton__:entity" },
    })
  })
})

describe("buildRowOffsets", () => {
  it("accumulates per-kind heights and reports the total", () => {
    const rows = buildTreeListRows(groups, new Set(["entity", "source"]))
    const { offsets, totalHeight } = buildRowOffsets(rows)
    expect(offsets[0]).toBe(0)
    expect(offsets[1]).toBe(TYPE_HEADER_ROW_HEIGHT)
    expect(offsets[2]).toBe(TYPE_HEADER_ROW_HEIGHT + PAGE_ROW_HEIGHT)
    expect(totalHeight).toBe(
      3 * TYPE_HEADER_ROW_HEIGHT + 5 * PAGE_ROW_HEIGHT,
    )
    expect(offsets[rows.length]).toBe(totalHeight)
  })

  it("empty rows yield zero height", () => {
    const { offsets, totalHeight } = buildRowOffsets([])
    expect(totalHeight).toBe(0)
    expect(offsets.length).toBe(1)
  })
})

describe("findVisibleRowRange", () => {
  const rows = buildTreeListRows(groups, new Set(["entity", "source"]))
  const { offsets } = buildRowOffsets(rows)
  const H = TYPE_HEADER_ROW_HEIGHT
  const P = PAGE_ROW_HEIGHT

  it("returns the rows overlapping the viewport with overscan padding", () => {
    // Viewport covers the second entity page (offsets: header 0-36, e1 36-64, e2 64-92).
    const [from, to] = findVisibleRowRange(offsets, 64, 64 + 100, 1)
    expect(from).toBeGreaterThanOrEqual(0)
    expect(to).toBeLessThanOrEqual(rows.length)
    // e2 is index 2; overscan 1 reaches e1 (1) and past e3 (3), bounded by row 0.
    expect([from, to]).toEqual([0, 7])
  })

  it("clamps when the viewport starts above the list", () => {
    const [from, to] = findVisibleRowRange(offsets, -500, -400, 2)
    expect(from).toBe(0)
    expect(to).toBe(0)
  })

  it("clamps when the viewport is past the list end", () => {
    const total = offsets[offsets.length - 1]
    const [from, to] = findVisibleRowRange(offsets, total + 100, total + 500, 1)
    expect(to).toBe(rows.length)
    expect(from).toBe(rows.length - 1)
  })

  it("covers the whole list for a viewport taller than the list", () => {
    const [from, to] = findVisibleRowRange(offsets, 0, 100_000, 0)
    expect([from, to]).toEqual([0, rows.length])
  })

  it("binary search skips fully-scrolled-past rows", () => {
    // Viewport strictly below the first two rows.
    const top = H + 2 * P + 1
    const [from] = findVisibleRowRange(offsets, top, top + P, 0)
    // Row 3 (entity e3) spans [92, 120); viewport starts at 93.
    expect(from).toBe(3)
  })
})

describe("treeRowHeight", () => {
  it("maps kinds to constants", () => {
    expect(treeRowHeight("header")).toBe(TYPE_HEADER_ROW_HEIGHT)
    expect(treeRowHeight("page")).toBe(PAGE_ROW_HEIGHT)
  })
})
