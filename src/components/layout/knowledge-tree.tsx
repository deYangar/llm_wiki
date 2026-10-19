import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import {
  FileText, Users, Lightbulb, BookOpen, HelpCircle, GitMerge, BarChart3, TrendingUp, Target, ChevronRight, ChevronDown, Layout, Globe, Trash2,
} from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { useWikiStore } from "@/stores/wiki-store"
import { listDirectory, listWikiPageMeta } from "@/commands/fs"
import type { FileNode } from "@/types/wiki"
import { normalizePath } from "@/lib/path-utils"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"
import { cascadeDeleteWikiPagesWithRefs } from "@/lib/wiki-page-delete"
import { inferWikiTypeFromPath, wikiTypeLabel } from "@/lib/wiki-page-types"
import { filterRawSourceTree } from "@/lib/source-filter"
import { useTranslation } from "react-i18next"
import { useAppDialog } from "@/stores/app-dialog-store"
import { filterPagesBySource, listPageSourceIdentities } from "@/lib/knowledge-source-filter"
import { flattenFilesNaturally } from "@/lib/file-tree-order"

interface WikiPageInfo {
  path: string
  title: string
  type: string
  tags: string[]
  origin?: string
  sources: string[]
}

const TYPE_CONFIG: Record<string, { icon: typeof FileText; label: string; color: string; order: number }> = {
  overview:    { icon: Layout,      label: "Overview",     color: "text-yellow-500", order: 0 },
  entity:      { icon: Users,       label: "Entities",     color: "text-blue-500",   order: 1 },
  concept:     { icon: Lightbulb,   label: "Concepts",     color: "text-purple-500", order: 2 },
  source:      { icon: BookOpen,    label: "Sources",      color: "text-orange-500", order: 3 },
  synthesis:   { icon: GitMerge,    label: "Synthesis",    color: "text-red-500",    order: 4 },
  finding:     { icon: TrendingUp,  label: "Findings",     color: "text-purple-500", order: 5 },
  thesis:      { icon: Target,      label: "Theses",       color: "text-rose-500",   order: 6 },
  methodology: { icon: BookOpen,    label: "Methodologies",color: "text-teal-500",   order: 7 },
  comparison:  { icon: BarChart3,   label: "Comparisons",  color: "text-emerald-500",order: 8 },
  query:       { icon: HelpCircle,  label: "Queries",      color: "text-green-500",  order: 9 },
}

function typeConfig(type: string): { icon: typeof FileText; label: string; color: string; order: number } {
  return TYPE_CONFIG[type] ?? { icon: FileText, label: wikiTypeLabel(type), color: "text-muted-foreground", order: 99 }
}

export function KnowledgeTree() {
  const { t } = useTranslation()
  const appDialog = useAppDialog()
  const project = useWikiStore((s) => s.project)
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const openPathInPreview = useWikiStore((s) => s.openPathInPreview)
  const dataVersion = useWikiStore((s) => s.dataVersion)
  const [pages, setPages] = useState<WikiPageInfo[]>([])
  const [selectedSource, setSelectedSource] = useState<string | null>(null)
  const [expandedTypes, setExpandedTypes] = useState<Set<string>>(new Set(["overview", "entity", "concept", "source"]))
  // Two-stage delete: first click arms the row, second click executes.
  // Only one row armed at a time (clicking another row replaces).
  const [armedPath, setArmedPath] = useState<string | null>(null)
  const [deletingPath, setDeletingPath] = useState<string | null>(null)

  const loadGeneration = useRef(0)

  // One invoke served from the Rust-side PageMetaIndex cache. The old
  // loader pulled the whole recursive wiki tree (media images included)
  // and then read every page's full content in JS on each data-version
  // bump — overlapping full-library re-reads during batch imports OOM'd
  // the renderer (partition-alloc abort 0xE0000008).
  const loadPages = useCallback(async () => {
    if (!project) return
    const generation = ++loadGeneration.current
    try {
      const rows = await listWikiPageMeta(normalizePath(project.path))
      if (generation !== loadGeneration.current) return
      setPages(
        rows.map((row): WikiPageInfo => {
          const fileName = row.path.slice(row.path.lastIndexOf("/") + 1)
          const type =
            row.type === "other"
              ? (inferWikiTypeFromPath(row.path, fileName) ?? "other")
              : row.type
          return {
            path: row.path,
            title: row.title,
            type,
            tags: row.tags,
            origin: row.origin ?? undefined,
            sources: row.sources,
          }
        }),
      )
    } catch {
      if (generation === loadGeneration.current) setPages([])
    }
  }, [project])

  // Reload when the project changes. Do not key this off the visible
  // sidebar file tree: lazy directory expansion mutates that tree and
  // should not force a wiki metadata re-parse.
  useEffect(() => {
    void loadPages()
  }, [loadPages])

  // dataVersion churn is debounced: batch imports bump it per write and
  // the sidebar does not need per-write freshness. The trailing reload
  // lands after the burst; the generation counter drops stale runs, so
  // loads never overlap.
  useEffect(() => {
    const timer = setTimeout(() => void loadPages(), 3000)
    return () => clearTimeout(timer)
  }, [loadPages, dataVersion])

  useEffect(() => {
    setSelectedSource(null)
  }, [project?.id])

  const sourceOptions = useMemo(() => listPageSourceIdentities(pages), [pages])
  const visiblePages = useMemo(
    () => filterPagesBySource(pages, selectedSource),
    [pages, selectedSource],
  )

  useEffect(() => {
    if (selectedSource && !sourceOptions.includes(selectedSource)) setSelectedSource(null)
  }, [selectedSource, sourceOptions])

  const handleDeleteClick = useCallback(
    async (pagePath: string) => {
      if (!project) return
      // First click: arm. Second click on the same row: execute.
      if (armedPath !== pagePath) {
        setArmedPath(pagePath)
        return
      }
      setArmedPath(null)
      setDeletingPath(pagePath)
      try {
        const pp = normalizePath(project.path)
        await cascadeDeleteWikiPagesWithRefs(pp, [pagePath])
        // Refresh: page list, file tree, any data-version subscribers.
        await loadPages()
        try {
          await refreshProjectFileTree(pp, {
            projectId: project.id,
            bumpDataVersion: true,
          })
        } catch {
          // non-critical
        }
        if (selectedFile === pagePath) setSelectedFile(null)
      } catch (err) {
        console.error("[KnowledgeTree] delete failed:", err)
        await appDialog.alert({ message: `Failed to delete: ${err}` })
      } finally {
        setDeletingPath(null)
      }
    },
    [appDialog, project, armedPath, loadPages, selectedFile, setSelectedFile],
  )

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
        No project open
      </div>
    )
  }

  // Group pages by type
  const grouped = new Map<string, WikiPageInfo[]>()
  for (const page of visiblePages) {
    const list = grouped.get(page.type) ?? []
    list.push(page)
    grouped.set(page.type, list)
  }

  // Sort groups by configured order
  const sortedGroups = [...grouped.entries()].sort((a, b) => {
    const orderA = typeConfig(a[0]).order
    const orderB = typeConfig(b[0]).order
    if (orderA === orderB) return wikiTypeLabel(a[0]).localeCompare(wikiTypeLabel(b[0]))
    return orderA - orderB
  })

  function toggleType(type: string) {
    setExpandedTypes((prev) => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }

  return (
    <ScrollArea className="h-full">
      <div className="p-2">
        <div className="mb-2 px-2 text-xs font-semibold uppercase text-muted-foreground">
          {project.name}
        </div>

        {sourceOptions.length > 1 && (
          <div className="mb-2 px-2">
            <label className="sr-only" htmlFor="knowledge-source-filter">
              {t("sidebar.filterBySource")}
            </label>
            <select
              id="knowledge-source-filter"
              value={selectedSource ?? ""}
              onChange={(event) => setSelectedSource(event.target.value || null)}
              className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">{t("sidebar.allSources")}</option>
              {sourceOptions.map((source) => (
                <option key={source} value={source}>{source}</option>
              ))}
            </select>
          </div>
        )}

        {sortedGroups.length === 0 && (
          <div className="px-2 py-4 text-center text-xs text-muted-foreground">
            {t("sidebar.noWikiPages")}
          </div>
        )}

        {sortedGroups.map(([type, items]) => {
          const config = typeConfig(type)
          const Icon = config.icon
          const isExpanded = expandedTypes.has(type)

          return (
            <div key={type} className="mb-1">
              <button
                onClick={() => toggleType(type)}
                className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-sm hover:bg-accent/50"
              >
                {isExpanded ? (
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                )}
                <Icon className={`h-3.5 w-3.5 shrink-0 ${config.color}`} />
                <span className="flex-1 text-left font-medium">
                  {t(`sidebar.typeLabels.${type}`, { defaultValue: config.label })}
                </span>
                <span className="text-xs text-muted-foreground">{items.length}</span>
              </button>

              {isExpanded && (
                <div className="ml-3">
                  {items.map((page) => {
                    const isSelected = selectedFile === page.path
                    const isArmed = armedPath === page.path
                    const isDeleting = deletingPath === page.path
                    return (
                      <div
                        key={page.path}
                        className={`group flex items-center gap-1 rounded-md ${
                          isSelected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
                        }`}
                      >
                        <button
                          onClick={() => openPathInPreview(page.path)}
                          className={`flex flex-1 items-center gap-1.5 px-2 py-1 text-left text-sm min-w-0 ${
                            isSelected
                              ? "text-accent-foreground"
                              : "text-muted-foreground group-hover:text-accent-foreground"
                          }`}
                          title={page.path}
                        >
                          {page.origin === "web-clip" && <Globe className="h-3 w-3 shrink-0 text-blue-400" />}
                          <span className="truncate">{page.title}</span>
                        </button>
                        <DeleteButton
                          armed={isArmed}
                          deleting={isDeleting}
                          // Visible on hover, when this row is armed,
                          // or while deleting. Other rows fade out so
                          // accidental clicks on a sibling don't pile up.
                          className={`mr-1 transition-opacity ${
                            isArmed || isDeleting
                              ? "opacity-100"
                              : "opacity-0 group-hover:opacity-100"
                          }`}
                          onClick={() => void handleDeleteClick(page.path)}
                          name={page.title}
                        />
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}

        {/* Raw sources quick access */}
        <RawSourcesSection />
      </div>
    </ScrollArea>
  )
}

function RawSourcesSection() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const openPathInPreview = useWikiStore((s) => s.openPathInPreview)
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const [expanded, setExpanded] = useState(false)
  const [sources, setSources] = useState<FileNode[]>([])

  useEffect(() => {
    setSources([])
    if (!project) return
    let cancelled = false
    const pp = normalizePath(project.path)
    listDirectory(`${pp}/raw/sources`, true).then(filterRawSourceTree)
      .then((tree) => {
        if (!cancelled) setSources(flattenFilesNaturally(tree))
      })
      .catch(() => {
        if (!cancelled) setSources([])
      })
    return () => {
      cancelled = true
    }
  }, [project])

  if (sources.length === 0) return null

  return (
    <div className="mt-2 border-t pt-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-sm hover:bg-accent/50"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <BookOpen className="h-3.5 w-3.5 shrink-0 text-amber-600" />
        <span className="flex-1 text-left font-medium text-muted-foreground">{t("sidebar.rawSources")}</span>
        <span className="text-xs text-muted-foreground">{sources.length}</span>
      </button>
      {expanded && (
        <div className="ml-3">
          {sources.map((file) => {
            const isSelected = selectedFile === file.path
            return (
              <button
                key={file.path}
                onClick={() => openPathInPreview(file.path)}
                className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm ${
                  isSelected
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground"
                }`}
              >
                <span className="truncate">{file.name}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * Two-stage delete affordance for a single page row. Default state =
 * subtle ghost trash icon. Armed state = solid red Confirm pill so a
 * second click can't be accidental. Same visual contract as the
 * sources-view DeleteButton — kept inline here rather than shared
 * because the parent owns the armed/deleting/visibility state and
 * extracting would mean lifting four props to a shared module for one
 * extra caller.
 */
function DeleteButton({
  armed,
  deleting,
  onClick,
  name,
  className = "",
}: {
  armed: boolean
  deleting: boolean
  onClick: () => void
  name: string
  className?: string
}) {
  if (deleting) {
    return (
      <Button
        variant="ghost"
        size="icon"
        className={`h-6 w-6 shrink-0 cursor-default ${className}`}
        disabled
        title={`Deleting ${name}…`}
      >
        <Trash2 className="h-3 w-3 animate-pulse text-destructive" />
      </Button>
    )
  }
  if (armed) {
    return (
      <Button
        variant="destructive"
        size="sm"
        className={`h-6 shrink-0 px-1.5 text-[10px] font-semibold animate-pulse ${className}`}
        onClick={(e) => {
          e.stopPropagation()
          onClick()
        }}
        title={`Click again to delete ${name} and clean up references`}
      >
        <Trash2 className="mr-0.5 h-3 w-3" />
        Confirm
      </Button>
    )
  }
  return (
    <Button
      variant="ghost"
      size="icon"
      className={`h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive ${className}`}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      title={`Delete ${name} (and clean up references)`}
    >
      <Trash2 className="h-3 w-3" />
    </Button>
  )
}
