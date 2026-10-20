import { wikiGraphSnapshot, type WikiGraphSnapshotNode } from "@/commands/fs"
import { buildRetrievalGraphFromSnapshot, calculateRelevance } from "./graph-relevance"
import { normalizePath } from "@/lib/path-utils"
import { detectCommunities } from "./wiki-graph-analysis"

export interface GraphNode {
  id: string
  label: string
  type: string
  path: string
  linkCount: number // inbound + outbound
  community: number // community id from Louvain detection
}

export interface GraphEdge {
  source: string
  target: string
  weight: number // relevance score between source and target
}

export interface CommunityInfo {
  id: number
  nodeCount: number
  cohesion: number // intra-community edge density
  meanIntraDegree: number // average internal links per page; scale-independent
  topNodes: string[] // top nodes by linkCount (labels)
}

export interface WikiGraphResult {
  nodes: GraphNode[]
  edges: GraphEdge[]
  communities: CommunityInfo[]
}

const COMMUNITY_WORKER_THRESHOLD = 500
const MAX_CACHED_PROJECT_GRAPHS = 2
const graphCache = new Map<string, { dataVersion: number; result: WikiGraphResult }>()
const graphBuilds = new Map<string, Promise<WikiGraphResult>>()

async function analyzeCommunities(
  nodes: { id: string; label: string; linkCount: number }[],
  edges: GraphEdge[],
): Promise<{ assignments: Map<string, number>; communities: CommunityInfo[] }> {
  if (nodes.length < COMMUNITY_WORKER_THRESHOLD || typeof Worker === "undefined") {
    return detectCommunities(nodes, edges)
  }

  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./wiki-graph-analysis.worker.ts", import.meta.url),
      { type: "module" },
    )
    worker.onmessage = (event: MessageEvent<{
      assignments: [string, number][]
      communities: CommunityInfo[]
    }>) => {
      worker.terminate()
      resolve({
        assignments: new Map(event.data.assignments),
        communities: event.data.communities,
      })
    }
    worker.onerror = (event) => {
      worker.terminate()
      reject(new Error(event.message || "Knowledge graph analysis worker failed"))
    }
    worker.postMessage({ nodes, edges })
  })
}

export async function buildWikiGraph(
  projectPath: string,
  dataVersion?: number,
): Promise<WikiGraphResult> {
  const normalizedProjectPath = normalizePath(projectPath)
  if (dataVersion !== undefined) {
    const cached = graphCache.get(normalizedProjectPath)
    if (cached?.dataVersion === dataVersion) return cached.result
  }

  const buildKey = `${normalizedProjectPath}\u0000${dataVersion ?? "uncached"}`
  const pending = graphBuilds.get(buildKey)
  if (pending) return pending
  const build = buildWikiGraphUncached(normalizedProjectPath)
  graphBuilds.set(buildKey, build)
  let result: WikiGraphResult
  try {
    result = await build
  } finally {
    graphBuilds.delete(buildKey)
  }
  if (dataVersion !== undefined) {
    const cached = graphCache.get(normalizedProjectPath)
    // An older build may finish after a newer dataVersion. Never let it
    // replace the newer cached graph.
    if (!cached || cached.dataVersion <= dataVersion) {
      if (!cached && graphCache.size >= MAX_CACHED_PROJECT_GRAPHS) {
        const oldestProject = graphCache.keys().next().value
        if (oldestProject) graphCache.delete(oldestProject)
      }
      graphCache.set(normalizedProjectPath, { dataVersion, result })
    }
  }
  return result
}

// Query nodes (research results, saved chat answers) are intermediate
// artifacts, not knowledge structure — the Rust build filters them from
// nodes already; this is defensive double-cover on the mapping side.
const HIDDEN_TYPES = new Set(["query"])

function mapSnapshotNode(
  node: WikiGraphSnapshotNode,
  projectRoot: string,
  linkCount: number,
): GraphNode {
  return {
    id: node.id,
    label: node.label,
    type: node.nodeType.toLowerCase(),
    path: `${projectRoot}/${node.path}`,
    linkCount,
    community: 0,
  }
}

async function buildWikiGraphUncached(projectPath: string): Promise<WikiGraphResult> {
  const projectRoot = normalizePath(projectPath).replace(/\/+$/, "")

  let snapshot
  try {
    snapshot = await wikiGraphSnapshot(projectRoot)
  } catch {
    return { nodes: [], edges: [], communities: [] }
  }

  const visibleNodes = snapshot.nodes.filter((n) => !HIDDEN_TYPES.has(n.nodeType.toLowerCase()))
  const nodeIds = new Set(visibleNodes.map((n) => n.id))

  // The Rust build filters query nodes from `nodes` but keeps their
  // adjacency in `edges` (the HTTP join layer drops those on the way out;
  // the raw snapshot does not). Drop every edge whose endpoints are not
  // both visible, then recompute linkCount so node sizes keep the old
  // pipeline's in+out degree over visible nodes only.
  const visibleEdges = snapshot.edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target))
  const linkCounts = new Map<string, number>()
  for (const id of nodeIds) linkCounts.set(id, 0)
  for (const edge of visibleEdges) {
    linkCounts.set(edge.source, (linkCounts.get(edge.source) ?? 0) + 1)
    linkCounts.set(edge.target, (linkCounts.get(edge.target) ?? 0) + 1)
  }

  const nodes: GraphNode[] = visibleNodes.map((n) =>
    mapSnapshotNode(n, projectRoot, linkCounts.get(n.id) ?? 0),
  )

  // Calculate relevance weights using the retrieval graph
  let retrievalGraph: Awaited<ReturnType<typeof buildRetrievalGraphFromSnapshot>> | null = null
  try {
    const { useWikiStore } = await import("@/stores/wiki-store")
    const dv = useWikiStore.getState().dataVersion
    retrievalGraph = buildRetrievalGraphFromSnapshot(
      projectRoot,
      dv,
      visibleNodes.map((n) => ({
        id: n.id,
        title: n.label,
        type: n.nodeType.toLowerCase(),
        path: `${projectRoot}/${n.path}`,
        sources: n.sources,
      })),
      visibleEdges,
    )
  } catch {
    // Keep the graph available with neutral weights if relevance enrichment fails.
  }

  const edges: GraphEdge[] = visibleEdges.map((e) => {
    let weight = 1
    if (retrievalGraph) {
      const nodeA = retrievalGraph.nodes.get(e.source)
      const nodeB = retrievalGraph.nodes.get(e.target)
      if (nodeA && nodeB) {
        weight = calculateRelevance(nodeA, nodeB, retrievalGraph)
      }
    }
    return { source: e.source, target: e.target, weight }
  })

  // Build preliminary nodes for community detection
  const prelimNodes = nodes.map((n) => ({
    id: n.id,
    label: n.label,
    linkCount: n.linkCount,
  }))

  const { assignments, communities } = await analyzeCommunities(prelimNodes, edges).catch(
    () => detectCommunities(prelimNodes, edges),
  )

  for (const node of nodes) {
    node.community = assignments.get(node.id) ?? 0
  }

  return { nodes, edges, communities }
}
