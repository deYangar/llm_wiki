/**
 * Pure row-flattening and windowing math for the virtualized knowledge
 * tree sidebar. The full page list is ~50k rows; rendering every row kept
 * a multi-GB DOM alive in the renderer and re-allocated it on every
 * data-version refresh. These helpers flatten the grouped list into a
 * position-addressable row array so the tree only mounts the rows inside
 * (and slightly beyond) the scroll viewport.
 */

export const TYPE_HEADER_ROW_HEIGHT = 36
export const PAGE_ROW_HEIGHT = 28

export type TreeListRow<TPage> =
  | { kind: "header"; key: string; type: string; count: number }
  | { kind: "page"; key: string; page: TPage }

export function treeRowHeight(kind: "header" | "page"): number {
  return kind === "header" ? TYPE_HEADER_ROW_HEIGHT : PAGE_ROW_HEIGHT
}

/**
 * Flatten ordered groups into a single row list. Collapsed groups
 * contribute only their header row. Keys are unique per group/page so
 * React can reuse row elements across refreshes.
 */
export function buildTreeListRows<TPage>(
  groups: ReadonlyArray<readonly [string, readonly TPage[]]>,
  expandedTypes: ReadonlySet<string>,
): TreeListRow<TPage>[] {
  const rows: TreeListRow<TPage>[] = []
  for (const [type, items] of groups) {
    rows.push({ kind: "header", key: `type:${type}`, type, count: items.length })
    if (!expandedTypes.has(type)) continue
    for (const page of items) {
      rows.push({ kind: "page", key: (page as { path?: string }).path ?? String(page), page })
    }
  }
  return rows
}

/**
 * Cumulative top offsets: `offsets[i]` is the top of row `i` within the
 * list, `offsets[rows.length]` is the total list height.
 */
export function buildRowOffsets<TPage>(rows: readonly TreeListRow<TPage>[]): {
  offsets: Float64Array
  totalHeight: number
} {
  const offsets = new Float64Array(rows.length + 1)
  for (let i = 0; i < rows.length; i += 1) {
    offsets[i + 1] = offsets[i] + treeRowHeight(rows[i].kind)
  }
  return { offsets, totalHeight: offsets[rows.length] }
}

/**
 * Row index range `[from, to)` visible in a viewport that spans
 * `[viewportTop, viewportBottom)` relative to the list top. Either bound
 * may be negative (scrolled above the list) or beyond the list end; the
 * result is clamped and padded with `overscan` rows on both sides.
 */
export function findVisibleRowRange(
  offsets: Float64Array,
  viewportTop: number,
  viewportBottom: number,
  overscan: number,
): [number, number] {
  const rowCount = offsets.length - 1
  if (rowCount === 0 || viewportBottom <= 0) return [0, 0]

  // First row whose bottom edge reaches viewportTop (rows fully above
  // the viewport are skipped). Binary search — offsets is ascending.
  let lo = 0
  let hi = rowCount
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (offsets[mid + 1] < viewportTop) lo = mid + 1
    else hi = mid
  }
  if (lo >= rowCount) {
    // Everything is scrolled past (e.g. content below the list is in
    // view). Keep only the overscan tail mounted.
    return [Math.max(0, rowCount - overscan), rowCount]
  }
  const start = lo

  // Exclusive end: first row whose top is at or past the viewport bottom.
  let end = start
  while (end < rowCount && offsets[end] < viewportBottom) {
    end += 1
  }

  return [Math.max(0, start - overscan), Math.min(rowCount, end + overscan)]
}
