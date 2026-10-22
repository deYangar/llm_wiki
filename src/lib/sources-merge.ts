/**
 * Frontmatter array-field merging during ingest.
 *
 * Originally written for the `sources:` field alone — re-ingesting a
 * page from a second source would clobber `sources: [...]` to a
 * single entry, and the source-delete flow would later treat the page
 * as single-sourced and delete it (silent data loss). The fix unions
 * old and new sources before writing.
 *
 * Generalized to handle any frontmatter array field (`sources`,
 * `tags`, `related`, …): the same loss-on-clobber pattern applied to
 * `tags` and `related` too — old contributing tags / wikilinks
 * disappeared every time a different source brought new ones. The
 * generic API merges any subset of fields the caller names.
 *
 * Two callers today:
 *   - sources-view.tsx — uses `parseSources` / `writeSources` for
 *     the source-delete flow (operates on the single sources field)
 *   - ingest.ts — uses `mergeArrayFieldsIntoContent` to union
 *     sources + tags + related when writing a content page that
 *     already exists on disk
 */

// ─── Generic helpers (the implementation core) ────────────────────

/**
 * Scan an inline flow array starting at `openIndex` (which must point at
 * the opening `[`) and return the index of the matching closing `]`, or -1
 * if unclosed. Quote-aware: a `]` inside a quoted string does not close the
 * array.
 *
 * Why a scanner and not `\[([^\]]*)\]`: wikilink values such as
 * `"[[锦天城]]"` contain `]`, and the character-class regex stopped at the
 * first one — `related: ["[[a]]", "[[b]]"]` parsed as the single half-broken
 * item `"[[a`, and the rewrite left the trailing `]]", "[[b]]"]` bytes
 * behind as garbage. The scanner treats bracket depth and string quoting
 * the way YAML does.
 */
function findInlineArrayEnd(text: string, openIndex: number): number {
  let quote: "\"" | "'" | null = null
  let escaped = false
  let depth = 0
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (quote === "\"" && ch === "\\") {
      escaped = true
      continue
    }
    if (quote === null && (ch === "\"" || ch === "'")) {
      quote = ch
      continue
    }
    if (quote !== null) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === "[") depth++
    else if (ch === "]") {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * Extract a frontmatter array field by name. Handles both:
 *   inline form:    `name: ["a", "b"]` or `name: [a, b]`
 *   block form:     `name:\n  - a\n  - b`
 * Strips quotes (single or double) from items. Returns `[]` for
 * missing field, malformed parse, or content with no frontmatter.
 *
 * The field name is matched as a whole word at line start, so
 * `parseFrontmatterArray(c, "rel")` won't match `related: [...]`.
 */
export function parseFrontmatterArray(content: string, fieldName: string): string[] {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fmMatch) return []
  const fm = fmMatch[1]
  // Anchor to start of line + exact field name + colon. The negative
  // lookahead-style check is done by requiring `:` immediately after.
  const escapedName = fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const blockRe = new RegExp(
    `^${escapedName}:\\s*\\r?\\n((?:[ \\t]+-\\s+.+(?:\\r?\\n|$))+)`,
    "m",
  )
  const block = fm.match(blockRe)
  if (block) {
    const out: string[] = []
    for (const line of block[1].split(/\r?\n/)) {
      const m = line.match(/^\s+-\s+["']?(.+?)["']?\s*$/)
      if (m && m[1]) out.push(m[1].trim())
    }
    return out
  }

  const open = fm.match(new RegExp(`^${escapedName}:\\s*\\[`, "m"))
  if (!open || open.index === undefined) return []
  const bracketIndex = open.index + open[0].length - 1
  const endIndex = findInlineArrayEnd(fm, bracketIndex)
  if (endIndex < 0) return [] // unclosed — treat as absent, don't half-parse
  const body = fm.slice(bracketIndex + 1, endIndex).trim()
  if (body === "") return []
  return splitInlineArray(body)
}

function splitInlineArray(body: string): string[] {
  const out: string[] = []
  let current = ""
  let quote: "\"" | "'" | null = null
  let escaped = false

  for (const ch of body) {
    if (escaped) {
      current += ch
      escaped = false
      continue
    }
    if (quote === "\"" && ch === "\\") {
      escaped = true
      continue
    }
    if ((ch === "\"" || ch === "'") && quote === null) {
      quote = ch
      continue
    }
    if (quote === ch) {
      quote = null
      continue
    }
    if (ch === "," && quote === null) {
      const value = current.trim()
      if (value) out.push(value)
      current = ""
      continue
    }
    current += ch
  }

  const value = current.trim()
  if (value) out.push(value)
  return out
}

/**
 * Rewrite (or insert) a frontmatter array field. Preserves all other
 * frontmatter lines and order. Returns content unchanged if the
 * input has no frontmatter at all (don't manufacture frontmatter for
 * unconventional pages — almost certainly malformed emission worth
 * surfacing rather than silently fixing).
 *
 * Always emits the inline form `name: ["a", "b"]` so downstream
 * parsers see a consistent shape regardless of the original input
 * shape.
 */
export function writeFrontmatterArray(
  content: string,
  fieldName: string,
  values: string[],
): string {
  const fmMatch = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/)
  if (!fmMatch) return content

  const [, openDelim, fmBody, closeDelim] = fmMatch
  const newline = openDelim.endsWith("\r\n") ? "\r\n" : "\n"
  const escapedName = fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const serialized = values.map(quoteInlineArrayValue).join(", ")
  const newLine = `${fieldName}: [${serialized}]`

  // Replace inline form in place — preserves field ordering. The extent of
  // the old line is located with the quote-aware scanner (findInlineArrayEnd)
  // so values containing `]` (wikilinks) are replaced whole instead of
  // leaving trailing bytes behind.
  const open = fmBody.match(new RegExp(`^${escapedName}:\\s*\\[`, "m"))
  if (open && open.index !== undefined) {
    const bracketIndex = open.index + open[0].length - 1
    const endIndex = findInlineArrayEnd(fmBody, bracketIndex)
    if (endIndex >= 0) {
      const rewritten =
        fmBody.slice(0, open.index) + newLine + fmBody.slice(endIndex + 1)
      return `${openDelim}${rewritten}${closeDelim}${content.slice(fmMatch[0].length)}`
    }
    // Unclosed inline array (truncated emission): replace the whole broken
    // line rather than appending and leaving the fragment in place.
    const brokenLineRe = new RegExp(`^${escapedName}:\\s*\\[.*$`, "m")
    if (brokenLineRe.test(fmBody)) {
      const rewritten = fmBody.replace(brokenLineRe, newLine)
      return `${openDelim}${rewritten}${closeDelim}${content.slice(fmMatch[0].length)}`
    }
  }

  // Replace block form in place, normalized to inline form.
  const blockRe = new RegExp(
    `^${escapedName}:\\s*\\r?\\n((?:[ \\t]+-\\s+.+(?:\\r?\\n|$))+)`,
    "m",
  )
  if (blockRe.test(fmBody)) {
    const rewritten = fmBody.replace(blockRe, (matched) =>
      `${newLine}${/\r?\n$/.test(matched) ? newline : ""}`,
    )
    return `${openDelim}${rewritten}${closeDelim}${content.slice(fmMatch[0].length)}`
  }

  // Field absent — append at end of frontmatter.
  const rewritten = `${fmBody}${newline}${newLine}`
  return `${openDelim}${rewritten}${closeDelim}${content.slice(fmMatch[0].length)}`
}

function quoteInlineArrayValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

/**
 * Union-merge two array values. Case-insensitive dedup. First-seen
 * casing wins (matches sources-merge's historical contract — keeps
 * users' original filename casing stable across re-ingests).
 */
function mergeLists(
  existing: readonly string[],
  incoming: readonly string[],
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of [...existing, ...incoming]) {
    const key = s.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
  }
  return out
}

/**
 * Per-field merge policies. `related` holds wikilinks whose canonical form
 * is `[[title]]` (schema.md), but three shapes exist on disk and in LLM
 * output: `[[title]]`, bare `title`, and the half-broken `[[title` left
 * behind by the pre-scanner parser. Merging keyed on the raw string kept
 * broken and whole duplicates side by side forever (锦天城/金杜 pages,
 * 2026-10-22 audit). Normalizing to the bare title before dedup and
 * re-wrapping on write collapses all three shapes into one `[[title]]`.
 */
function stripWikilinkWrapper(value: string): string {
  let v = value.trim()
  if (v.startsWith("[[")) v = v.slice(2)
  if (v.endsWith("]]")) v = v.slice(0, -2)
  return v.trim()
}

function rewrapWikilink(bare: string): string {
  return `[[${bare}]]`
}

const WIKILINK_FIELDS = new Set(["related"])

/**
 * Multi-field merge entry point. For each requested field, union the
 * existing-on-disk value with the LLM-emitted new value, and rewrite
 * the new content's frontmatter with the merged values.
 *
 * Fast-paths:
 *   - existingContent null/empty → return newContent verbatim
 *   - existing has no frontmatter at all → return newContent verbatim
 *   - no field actually changes → return newContent verbatim (stable
 *     reference, callers can rely on this for cache-key invariance)
 */
export function mergeArrayFieldsIntoContent(
  newContent: string,
  existingContent: string | null,
  fields: readonly string[],
): string {
  if (!existingContent) return newContent
  if (!/^---\r?\n/.test(existingContent)) return newContent

  let result = newContent
  let changed = false
  for (const field of fields) {
    const isWikilink = WIKILINK_FIELDS.has(field)
    const normalize = isWikilink ? stripWikilinkWrapper : (v: string) => v.trim()
    const serialize = isWikilink ? rewrapWikilink : (v: string) => v
    const oldValues = parseFrontmatterArray(existingContent, field)
    if (oldValues.length === 0) continue // field absent in existing → nothing to preserve
    const newValues = parseFrontmatterArray(result, field)
    const merged = mergeLists(
      oldValues.map(normalize),
      newValues.map(normalize),
    ).map(serialize)
    // no-op ⇔ the incoming page already carries exactly the merged series
    // verbatim. Comparing against the raw (un-serialized) newValues keeps the
    // rewrite alive when the incoming shape differs from the canonical one
    // (e.g. existing `[[a` + incoming bare `a` still normalizes to `[[a]]`).
    if (
      merged.length === newValues.length &&
      merged.every((s, i) => s === newValues[i])
    ) {
      continue // no-op for this field
    }
    result = writeFrontmatterArray(result, field, merged)
    changed = true
  }
  return changed ? result : newContent
}

// ─── Backward-compatible single-field exports ─────────────────────

/**
 * Extract `sources: [...]` from a wiki page's frontmatter.
 * Handles inline and block forms; strips quotes; returns [] when
 * absent. Thin wrapper around the generic parser, kept stable for
 * sources-view.tsx (source-delete flow).
 */
export function parseSources(content: string): string[] {
  return parseFrontmatterArray(content, "sources")
}

/**
 * Rewrite the `sources:` field. Thin wrapper around the generic
 * writer, kept stable for sources-view.tsx (writes the post-delete
 * sources list back).
 */
export function writeSources(content: string, sources: string[]): string {
  return writeFrontmatterArray(content, "sources", sources)
}

/**
 * Merge two source lists into one (case-insensitive dedup, first-
 * seen casing wins). Exported for tests and sources-view consumers
 * that prefer to call the merge directly without going through the
 * content-rewrite path.
 */
export function mergeSourcesLists(
  existing: readonly string[],
  incoming: readonly string[],
): string[] {
  return mergeLists(existing, incoming)
}

/**
 * Sources-only convenience wrapper — equivalent to
 * `mergeArrayFieldsIntoContent(newContent, existingContent, ["sources"])`.
 * Kept for ingest-flow callers that pre-date the multi-field
 * generalization; new code should prefer the generic version which
 * also unions tags / related.
 */
export function mergeSourcesIntoContent(
  newContent: string,
  existingContent: string | null,
): string {
  return mergeArrayFieldsIntoContent(newContent, existingContent, ["sources"])
}
