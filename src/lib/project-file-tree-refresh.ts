import { listDirectory } from "@/commands/fs"
import { useWikiStore } from "@/stores/wiki-store"
import { normalizePath } from "@/lib/path-utils"
import { filterRawSourceTree } from "@/lib/source-filter"
import type { FileNode } from "@/types/wiki"

export interface RefreshProjectFileTreeOptions {
  projectId?: string
  clearDisplayTreeFirst?: boolean
  bumpDataVersion?: boolean
  refreshDisplayTree?: boolean
  refreshPathIndex?: boolean
  /**
   * Hot write paths (batch imports refresh once per written document) set
   * this to skip the resolver-index rebuild here and re-arm a trailing
   * idle rebuild instead. The index rebuild scans the whole project
   * (~300k FileNodes including every media image), ships them through
   * IPC, and re-indexes them in JS — per write it ratchets the
   * renderer's committed memory until partition-alloc aborts. Callers
   * that need the index current right after a single user action should
   * leave this unset.
   */
  deferPathIndex?: boolean
}

async function listDirectoryWithRetry(
  path: string,
  options: Parameters<typeof listDirectory>[1],
  attempts = 3,
): Promise<Awaited<ReturnType<typeof listDirectory>>> {
  let lastError: unknown
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await listDirectory(path, options)
    } catch (err) {
      lastError = err
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }
  }
  throw lastError
}

function isStillCurrentProject(projectId: string | undefined, projectPath: string): boolean {
  const current = useWikiStore.getState().project
  if (!current) return false
  if (projectId && current.id !== projectId) return false
  return normalizePath(current.path) === projectPath
}

function mergeLoadedDisplayTree(existing: FileNode[], refreshed: FileNode[]): FileNode[] {
  const existingByPath = new Map(existing.map((node) => [node.path, node]))

  return refreshed.map((node) => {
    const prior = existingByPath.get(node.path)
    if (!prior?.children) return node
    if (!node.children) return { ...node, children: prior.children }
    return { ...node, children: mergeLoadedDisplayTree(prior.children, node.children) }
  })
}

async function rebuildProjectPathIndex(
  currentProjectId: string | undefined,
  normalizedProjectPath: string,
): Promise<void> {
  if (!isStillCurrentProject(currentProjectId, normalizedProjectPath)) return
  // The full project scan hides dot-prefixed entries (`.git`,
  // `.llm-wiki`, …), which is correct for most of the tree. But
  // `raw/sources` may hold user-added dotfolders (`.claude`,
  // `.codex`) whose files back real `sources:` references. Scan
  // that subtree with `includeHidden` and merge it in so those
  // sources resolve instead of rendering as "not found". The
  // raw/sources scan is best-effort — a project without sources
  // must still get a full index.
  try {
    const [fullTree, rawSourcesTree] = await Promise.all([
      listDirectoryWithRetry(normalizedProjectPath, undefined, 3),
      listDirectoryWithRetry(
        `${normalizedProjectPath}/raw/sources`,
        { includeHidden: true },
        3,
      ).catch(() => [] as FileNode[]),
    ])
    if (!isStillCurrentProject(currentProjectId, normalizedProjectPath)) return
    useWikiStore
      .getState()
      .setProjectPathIndexFromTree([...fullTree, ...filterRawSourceTree(rawSourcesTree)])
  } catch (err) {
    console.error("Failed to refresh project path index:", err)
  }
}

const PATH_INDEX_IDLE_DELAY_MS = 30_000

let pathIndexIdleTimer: ReturnType<typeof setTimeout> | null = null
let pathIndexIdleTarget: { projectId: string | undefined; projectPath: string } | null = null
// Serialize deferred rebuilds so an idle-triggered run and an explicit
// flush never double-scan the project concurrently.
let pathIndexRebuildChain: Promise<void> = Promise.resolve()

function runDeferredPathIndexRebuild(
  projectId: string | undefined,
  projectPath: string,
): Promise<void> {
  pathIndexRebuildChain = pathIndexRebuildChain.then(() =>
    rebuildProjectPathIndex(projectId, projectPath),
  )
  return pathIndexRebuildChain
}

function armPathIndexIdleRebuild(
  projectId: string | undefined,
  normalizedProjectPath: string,
): void {
  if (pathIndexIdleTimer !== null) clearTimeout(pathIndexIdleTimer)
  pathIndexIdleTarget = { projectId, projectPath: normalizedProjectPath }
  pathIndexIdleTimer = setTimeout(() => {
    pathIndexIdleTimer = null
    void flushDeferredPathIndexRebuild()
  }, PATH_INDEX_IDLE_DELAY_MS)
}

/**
 * Fire a pending deferred resolver-index rebuild immediately (queue
 * drained, window refocused). No-op when nothing is deferred. This is
 * the "import finished, bring the index current" entry point.
 */
export async function flushDeferredPathIndexRebuild(): Promise<void> {
  if (pathIndexIdleTimer !== null) {
    clearTimeout(pathIndexIdleTimer)
    pathIndexIdleTimer = null
  }
  const target = pathIndexIdleTarget
  pathIndexIdleTarget = null
  if (!target) return
  await runDeferredPathIndexRebuild(target.projectId, target.projectPath)
}

export async function refreshProjectFileTree(
  projectPath: string,
  options: RefreshProjectFileTreeOptions = {},
): Promise<void> {
  const normalizedProjectPath = normalizePath(projectPath)
  const currentProjectId = options.projectId ?? useWikiStore.getState().project?.id
  const refreshDisplayTree = options.refreshDisplayTree ?? true
  const refreshPathIndex = options.refreshPathIndex ?? true

  if (options.clearDisplayTreeFirst && isStillCurrentProject(currentProjectId, normalizedProjectPath)) {
    useWikiStore.getState().setFileTree([], { syncPathIndex: false })
  }

  if (refreshDisplayTree) {
    try {
      const shallowTree = await listDirectoryWithRetry(normalizedProjectPath, { maxDepth: 2 }, 3)
      if (isStillCurrentProject(currentProjectId, normalizedProjectPath)) {
        const currentTree = useWikiStore.getState().fileTree
        const displayTree = options.clearDisplayTreeFirst
          ? shallowTree
          : mergeLoadedDisplayTree(currentTree, shallowTree)
        useWikiStore.getState().setFileTree(displayTree, { syncPathIndex: false })
      }
    } catch (err) {
      console.error("Failed to refresh project file tree:", err)
    }
  }

  if (options.deferPathIndex) {
    armPathIndexIdleRebuild(currentProjectId, normalizedProjectPath)
  } else if (refreshPathIndex) {
    void rebuildProjectPathIndex(currentProjectId, normalizedProjectPath)
  }

  if (options.bumpDataVersion && isStillCurrentProject(currentProjectId, normalizedProjectPath)) {
    useWikiStore.getState().bumpDataVersion()
  }
}
