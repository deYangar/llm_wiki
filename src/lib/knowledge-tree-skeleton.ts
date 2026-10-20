import type { WikiPageTypeCountRow } from "@/commands/fs"

/**
 * Two-stage display groups for the knowledge tree sidebar. Stage one
 * renders group headers (type + count) from the small type-count payload
 * while the full 50k-row page list is still in flight; stage two replaces
 * the skeleton with the real groups once `listWikiPageMeta` resolves.
 *
 * A skeleton group carries ONE placeholder page so an expanded group shows
 * a loading row; the header count comes from the overrides map, not from
 * the (placeholder) items length. Group ordering mirrors the real groups'
 * comparator so nothing jumps when the real rows land.
 */

export interface SkeletonPage {
  path: string
  title: string
  type: string
  tags: string[]
  sources: string[]
  placeholder: true
}

export type KnowledgeGroup<TPage> = [string, TPage[]]

export interface TwoStageGroups<TPage> {
  groups: KnowledgeGroup<TPage | SkeletonPage>[]
  /** Header counts for skeleton groups; empty in the rows-loaded stage. */
  countOverrides: Map<string, number>
  skeleton: boolean
}

export function twoStageGroups<TPage extends { path: string }>(options: {
  rowsLoaded: boolean
  sortedGroups: KnowledgeGroup<TPage>[]
  typeCounts: WikiPageTypeCountRow[] | null
  orderOf: (type: string) => number
  labelOf: (type: string) => string
  loadingTitle: string
}): TwoStageGroups<TPage> {
  const { rowsLoaded, sortedGroups, typeCounts } = options
  if (rowsLoaded || !typeCounts || typeCounts.length === 0) {
    return { groups: sortedGroups, countOverrides: new Map(), skeleton: false }
  }
  const countOverrides = new Map<string, number>()
  const groups = typeCounts
    .filter(({ count }) => count > 0)
    .map(({ wikiType, count }): KnowledgeGroup<SkeletonPage> => {
      countOverrides.set(wikiType, count)
      const placeholder: SkeletonPage = {
        path: `__skeleton__:${wikiType}`,
        title: options.loadingTitle,
        type: wikiType,
        tags: [],
        sources: [],
        placeholder: true,
      }
      return [wikiType, [placeholder]]
    })
    .sort((a, b) => {
      const orderA = options.orderOf(a[0])
      const orderB = options.orderOf(b[0])
      if (orderA === orderB) return options.labelOf(a[0]).localeCompare(options.labelOf(b[0]))
      return orderA - orderB
    })
  return { groups, countOverrides, skeleton: true }
}
