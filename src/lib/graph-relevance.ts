import { normalizePath } from "@/lib/path-utils"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RetrievalNode {
  readonly id: string
  readonly title: string
  readonly type: string
  readonly path: string
  readonly sources: readonly string[]
  readonly outLinks: ReadonlySet<string>
  readonly inLinks: ReadonlySet<string>
}

export interface RetrievalGraph {
  readonly nodes: ReadonlyMap<string, RetrievalNode>
  readonly dataVersion: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_CACHED_RETRIEVAL_GRAPHS = 2

const WEIGHTS = {
  directLink: 3.0,
  sourceOverlap: 4.0,
  commonNeighbor: 1.5,
  typeAffinity: 1.0,
} as const

const TYPE_AFFINITY: Record<string, Record<string, number>> = {
  entity: { concept: 1.2, entity: 0.8, source: 1.0, synthesis: 1.0, query: 0.8 },
  concept: { entity: 1.2, concept: 0.8, source: 1.0, synthesis: 1.2, query: 1.0 },
  source: { entity: 1.0, concept: 1.0, source: 0.5, query: 0.8, synthesis: 1.0 },
  query: { concept: 1.0, entity: 0.8, synthesis: 1.0, source: 0.8, query: 0.5 },
  synthesis: { concept: 1.2, entity: 1.0, source: 1.0, query: 1.0, synthesis: 0.8 },
}

// ---------------------------------------------------------------------------
// Module-level cache
// ---------------------------------------------------------------------------

const cachedGraphs = new Map<string, RetrievalGraph>()

// ---------------------------------------------------------------------------
// Helpers (pure)
// ---------------------------------------------------------------------------

function getNeighbors(node: RetrievalNode): ReadonlySet<string> {
  const neighbors = new Set<string>()
  for (const id of node.outLinks) neighbors.add(id)
  for (const id of node.inLinks) neighbors.add(id)
  return neighbors
}

function getNodeDegree(node: RetrievalNode): number {
  return node.outLinks.size + node.inLinks.size
}

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

/** Minimal node view of the Rust graph snapshot this builder consumes. */
export interface GraphSnapshotNodeInput {
  id: string
  title: string
  type: string
  path: string
  sources: readonly string[]
}

/**
 * Build the retrieval graph from a `wiki_graph_snapshot` payload instead
 * of reading every file in the library (the old buildRetrievalGraph did a
 * second full-library pass after wiki-graph.ts's own). `nodes` must
 * already be query-filtered and `edges` must reference node ids in
 * `nodes` — the wiki-graph mapping layer owns that filtering. Sources
 * come from Rust frontmatter parsing, which is stricter than the old
 * regex extraction; relevance weights may shift slightly (known,
 * accepted: the snapshot parsing is the more accurate one).
 */
export function buildRetrievalGraphFromSnapshot(
  projectPath: string,
  dataVersion: number,
  nodes: readonly GraphSnapshotNodeInput[],
  edges: ReadonlyArray<{ source: string; target: string }>,
): RetrievalGraph {
  const normalizedProjectPath = normalizePath(projectPath)
  const cachedGraph = cachedGraphs.get(normalizedProjectPath)
  if (cachedGraph?.dataVersion === dataVersion) {
    return cachedGraph
  }

  const outLinksMap = new Map<string, Set<string>>()
  const inLinksMap = new Map<string, Set<string>>()
  for (const node of nodes) {
    outLinksMap.set(node.id, new Set())
    inLinksMap.set(node.id, new Set())
  }
  for (const edge of edges) {
    // Stale edges whose endpoints left the node set are ignored, matching
    // the wiki-graph mapping layer's visibility filter.
    if (!outLinksMap.has(edge.source) || !outLinksMap.has(edge.target)) continue
    outLinksMap.get(edge.source)!.add(edge.target)
    inLinksMap.get(edge.target)!.add(edge.source)
  }

  const nodesMap = new Map<string, RetrievalNode>()
  for (const node of nodes) {
    nodesMap.set(node.id, {
      id: node.id,
      title: node.title,
      type: node.type,
      path: node.path,
      sources: Object.freeze([...node.sources]),
      outLinks: Object.freeze(outLinksMap.get(node.id) ?? new Set<string>()),
      inLinks: Object.freeze(inLinksMap.get(node.id) ?? new Set<string>()),
    })
  }

  const graph: RetrievalGraph = { nodes: nodesMap, dataVersion }
  cacheRetrievalGraph(normalizedProjectPath, graph)
  return graph
}

function cacheRetrievalGraph(projectPath: string, graph: RetrievalGraph): void {
  cachedGraphs.delete(projectPath)
  if (cachedGraphs.size >= MAX_CACHED_RETRIEVAL_GRAPHS) {
    const oldest = cachedGraphs.keys().next().value
    if (oldest) cachedGraphs.delete(oldest)
  }
  cachedGraphs.set(projectPath, graph)
}

export function calculateRelevance(
  nodeA: RetrievalNode,
  nodeB: RetrievalNode,
  graph: RetrievalGraph,
): number {
  if (nodeA.id === nodeB.id) return 0

  // Signal 1: Direct links (weight 3.0)
  const forwardLinks = nodeA.outLinks.has(nodeB.id) ? 1 : 0
  const backwardLinks = nodeB.outLinks.has(nodeA.id) ? 1 : 0
  const directLinkScore = (forwardLinks + backwardLinks) * WEIGHTS.directLink

  // Signal 2: Source overlap (weight 4.0)
  const sourcesA = new Set(nodeA.sources)
  let sharedSourceCount = 0
  for (const src of nodeB.sources) {
    if (sourcesA.has(src)) sharedSourceCount += 1
  }
  const sourceOverlapScore = sharedSourceCount * WEIGHTS.sourceOverlap

  // Signal 3: Common neighbors - Adamic-Adar (weight 1.5)
  const neighborsA = getNeighbors(nodeA)
  const neighborsB = getNeighbors(nodeB)
  let adamicAdar = 0
  for (const neighborId of neighborsA) {
    if (neighborsB.has(neighborId)) {
      const neighbor = graph.nodes.get(neighborId)
      if (neighbor) {
        const degree = getNodeDegree(neighbor)
        adamicAdar += 1 / Math.log(Math.max(degree, 2))
      }
    }
  }
  const commonNeighborScore = adamicAdar * WEIGHTS.commonNeighbor

  // Signal 4: Type affinity (weight 1.0)
  const affinityMap = TYPE_AFFINITY[nodeA.type]
  const typeAffinityScore = (affinityMap?.[nodeB.type] ?? 0.5) * WEIGHTS.typeAffinity

  return directLinkScore + sourceOverlapScore + commonNeighborScore + typeAffinityScore
}

export function getRelatedNodes(
  nodeId: string,
  graph: RetrievalGraph,
  limit: number = 5,
): ReadonlyArray<{ node: RetrievalNode; relevance: number }> {
  const sourceNode = graph.nodes.get(nodeId)
  if (!sourceNode) return []

  const scored: Array<{ node: RetrievalNode; relevance: number }> = []
  for (const [id, node] of graph.nodes) {
    if (id === nodeId) continue
    const relevance = calculateRelevance(sourceNode, node, graph)
    if (relevance > 0) {
      scored.push({ node, relevance })
    }
  }

  scored.sort((a, b) => b.relevance - a.relevance)
  return scored.slice(0, limit)
}

export function clearGraphCache(): void {
  cachedGraphs.clear()
}
