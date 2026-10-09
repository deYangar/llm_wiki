import JSZip from "jszip"
import type { MineruConfig } from "@/stores/wiki-store"
import { createDirectory, getFileSize, getPdfPageCount, readFileAsBase64, writeFileBase64 } from "@/commands/fs"
import { getHttpFetch } from "@/lib/tauri-fetch"
import { getFileName, normalizePath } from "@/lib/path-utils"
import type { SavedImage } from "@/lib/extract-source-images"

const API_BASE = "https://mineru.net/api/v4"
export const DEFAULT_LOCAL_MINERU_ENDPOINT = "http://127.0.0.1:8000"
const POLL_INTERVAL_MS = 3_000
const POLL_TIMEOUT_MS = 300_000 // 5 minutes
const LOCAL_POLL_TIMEOUT_MS = 3_600_000 // Official mineru-api tasks can include model cold starts.
const MAX_ACCURATE_PARSE_BYTES = 200 * 1024 * 1024
// The cloud API rejects documents above 200 pages (-60006). Larger PDFs are
// split into `page_ranges` segments and the resulting Markdown is joined.
// Segments are capped at 100 pages — half the API maximum — because peak-hour
// cloud queues regularly exceed a 200-page segment's polling window, and a
// failed segment costs a full re-upload.
export const MAX_CLOUD_PAGES_PER_TASK = 100

/**
 * Cloud polling window per document. Small documents keep the historical
 * 5-minute window; larger ones scale with page count so peak-hour queueing
 * (segment submitted, waiting for a worker) is not mistaken for a hang.
 */
export function cloudPollTimeoutMs(pageCount: number | null): number {
  if (pageCount === null || pageCount <= 0) return POLL_TIMEOUT_MS
  return Math.min(POLL_TIMEOUT_MS + pageCount * 5_000, 1_200_000)
}

/**
 * Local V1 api-server polling window. CPU deployments parse at tens of
 * seconds per page, so the window scales with page count; the floor covers
 * model cold starts, the ceiling keeps a wedged job from blocking the
 * ingest queue forever.
 */
export function localV1PollTimeoutMs(pageCount: number | null): number {
  const pages = pageCount && pageCount > 0 ? pageCount : 0
  return Math.min(600_000 + pages * 90_000, 6 * 3_600_000)
}

/** Distinguishes "poll window elapsed" from every other cloud failure so the
 *  caller can extend polling of the *same* batch instead of re-uploading. */
export class MineruPollTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MineruPollTimeoutError"
  }
}

/**
 * Whether a cloud MinerU failure is worth one same-backend retry. Permanent
 * errors (bad credentials, quota exhausted, API parameter/limit rejections)
 * fail identically on retry and should go straight to the fallback ladder.
 */
export function classifyMineruFailure(err: unknown): "transient" | "permanent" {
  const message = err instanceof Error ? err.message : String(err)
  if (/token is invalid|token has expired|daily parsing quota|larger than 200 MB|exceeds the 200 page limit|cannot exceed \d+ characters|not configured|supports only pipeline or vlm/i.test(message)) {
    return "permanent"
  }
  // MineruApiErrorMessage formats known API codes as "MinerU <reason> (<msg>)"
  // and unknown ones as "MinerU API error <code>"; parameter/validation codes
  // share the -100xx family with the data_id length limit.
  if (/MinerU API error -100\d\d/i.test(message)) return "permanent"
  if (/HTTP 5\d\d|HTTP 429/i.test(message)) return "transient"
  if (/timed out|error sending request|network|Failed to fetch/i.test(message)) return "transient"
  return "transient"
}
const MINERU_IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "svg",
  "tif",
  "tiff",
])

// ── Types ──

interface TaskResponse {
  code: number | string
  data: { task_id: string }
  msg: string
}

type MineruTaskState = "pending" | "running" | "converting" | "done" | "failed" | "waiting-file"

interface TaskStatus {
  code: number | string
  data: {
    task_id: string
    state: MineruTaskState
    full_zip_url?: string
    err_msg?: string
    extract_progress?: { extracted_pages: number; total_pages: number }
  }
  msg: string
}

interface BatchStatus {
  code: number | string
  data: {
    batch_id: string
    extract_result: Array<{
      file_name: string
      state: MineruTaskState
      full_zip_url?: string
      err_msg?: string
    }>
  }
  msg: string
}

interface UploadUrlResponse {
  code: number | string
  data: {
    batch_id: string
    file_urls: string[]
  }
  msg: string
}

interface MineruAssetOptions {
  projectPath: string
  sourceSummarySlug: string
  /**
   * Sub-directory inserted into `media/<slug>/mineru/<prefix>/…` so that
   * page-range segments of one document never overwrite each other's
   * identically-named zip assets (e.g. `images/1.jpg` in every segment).
   */
  assetPathPrefix?: string
}

interface MineruExtractedMarkdown {
  markdown: string
  savedImages: SavedImage[]
  /** Local backend only: which service flavor produced this result. */
  protocol?: LocalMineruProtocol
}

function localMineruApiBase(endpoint: string | undefined): string {
  const candidate = endpoint?.trim() || DEFAULT_LOCAL_MINERU_ENDPOINT
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new Error("Local MinerU endpoint must be a valid HTTP(S) URL")
  }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("Local MinerU endpoint must be an HTTP(S) URL without credentials")
  }
  return candidate.replace(/\/+$/, "")
}

// ── API calls ──

async function mineruHeaders(token: string): Promise<HeadersInit> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  }
}

function localMineruHeaders(token: string | undefined): HeadersInit | undefined {
  const value = token?.trim()
  return value ? { Authorization: `Bearer ${value}` } : undefined
}

type TauriRequestInit = RequestInit & { maxRedirections?: number }

function localMineruRequestInit(
  token: string | undefined,
  init: RequestInit = {},
): TauriRequestInit {
  return {
    ...init,
    headers: localMineruHeaders(token),
    // plugin-http uses maxRedirections while browser fetch uses redirect.
    // Set both so credentials never follow an untrusted service redirect.
    redirect: "manual",
    maxRedirections: 0,
  }
}

function mineruApiErrorMessage(code: number | string | undefined, msg?: string): string {
  const key = String(code ?? "")
  const known: Record<string, string> = {
    A0202: "MinerU token is invalid. Check the API token in Settings.",
    A0211: "MinerU token has expired. Create a new API token and update Settings.",
    "-60005": "MinerU rejected the file because it is larger than 200 MB.",
    "-60006": "MinerU rejected the file because it exceeds the 200 page limit.",
    "-60018": "MinerU daily parsing quota has been reached.",
  }
  const knownMessage = known[key]
  if (knownMessage) return msg ? `${knownMessage} (${msg})` : knownMessage
  return msg ? `MinerU API error ${key || "unknown"}: ${msg}` : `MinerU API error ${key || "unknown"}`
}

function assertMineruSuccess(json: { code: number | string; msg?: string }): void {
  if (json.code !== 0 && json.code !== "0") {
    throw new Error(mineruApiErrorMessage(json.code, json.msg))
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("MinerU parsing cancelled")
  }
}

function decodeBase64ToBytes(base64: string): Uint8Array {
  if (typeof atob !== "function") {
    throw new Error("Base64 decoding is not available in this runtime")
  }
  const binaryStr = atob(base64)
  const bytes = new Uint8Array(binaryStr.length)
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i)
  }
  return bytes
}

function bytesToUploadBody(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer
  }
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

async function sha256OfBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytesToUploadBody(bytes))
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

function mineruImageMimeType(path: string): string {
  const ext = getFileName(path).split(".").pop()?.toLowerCase() ?? ""
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg"
    case "png":
      return "image/png"
    case "gif":
      return "image/gif"
    case "webp":
      return "image/webp"
    case "bmp":
      return "image/bmp"
    case "svg":
      return "image/svg+xml"
    case "tif":
    case "tiff":
      return "image/tiff"
    default:
      return "application/octet-stream"
  }
}

function mineruExtensionForMimeType(mimeType: string): string | null {
  switch (mimeType.trim().toLowerCase()) {
    case "image/jpeg": return "jpg"
    case "image/png": return "png"
    case "image/gif": return "gif"
    case "image/webp": return "webp"
    case "image/bmp": return "bmp"
    case "image/svg+xml": return "svg"
    case "image/tiff": return "tiff"
    default: return null
  }
}

function safeMineruAssetSegment(segment: string): string {
  const decoded = (() => {
    try {
      return decodeURIComponent(segment)
    } catch {
      return segment
    }
  })()
  const cleaned = decoded
    .replace(/[<>:"|?*\x00-\x1f]/g, "_")
    .replace(/[\\/]+/g, "_")
    .replace(/^\.+$/, "_")
    .replace(/[. ]+$/g, "_")
  if (!cleaned) return "asset"
  if (cleaned.length <= 80) return cleaned

  const dot = cleaned.lastIndexOf(".")
  if (dot > 0 && dot < cleaned.length - 1) {
    const ext = cleaned.slice(dot).slice(0, 16)
    return `${cleaned.slice(0, Math.max(1, 80 - ext.length))}${ext}`
  }
  return cleaned.slice(0, 80)
}

function normalizeMineruZipPath(path: string): string {
  return normalizePath(path)
    .replace(/^\.\/+/, "")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/")
}

function decodeMineruPath(path: string): string {
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}

function isMineruImagePath(path: string): boolean {
  const ext = getFileName(path).split(".").pop()?.toLowerCase() ?? ""
  return MINERU_IMAGE_EXTS.has(ext)
}

function mineruAssetRelPath(sourceSummarySlug: string, zipPath: string, prefix?: string): string {
  const safeParts = normalizeMineruZipPath(zipPath)
    .split("/")
    .map(safeMineruAssetSegment)
    .filter(Boolean)
  const safePath = safeParts.length > 0 ? safeParts.join("/") : "image.png"
  const safePrefix = prefix ? `${safeMineruAssetSegment(prefix)}/` : ""
  return `media/${sourceSummarySlug}/mineru/${safePrefix}${safePath}`
}

function isExternalOrDataUrl(url: string): boolean {
  return /^(https?:|data:|blob:|file:|tauri:|asset:)/i.test(url)
}

function decodeHtmlEntities(text: string): string {
  const safeCodePoint = (raw: string, radix: 10 | 16): string => {
    const n = Number.parseInt(raw, radix)
    if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return radix === 16 ? `&#x${raw};` : `&#${raw};`
    try {
      return String.fromCodePoint(n)
    } catch {
      return radix === 16 ? `&#x${raw};` : `&#${raw};`
    }
  }

  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_m, code: string) => safeCodePoint(code, 10))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code: string) => safeCodePoint(code, 16))
}

function htmlImgTagsToMarkdown(html: string): string {
  return html.replace(/<img\b[^>]*\bsrc=(["'])([^"']+)\1[^>]*>/gi, (full, _quote: string, src: string) => {
    const alt = full.match(/\balt=(["'])([^"']*)\1/i)?.[2] ?? ""
    return `![${alt}](${src})`
  })
}

function htmlCellToMarkdown(cell: string): string {
  return decodeHtmlEntities(
    htmlImgTagsToMarkdown(cell)
      .replace(/<br\s*\/?>/gi, "<br>")
      .replace(/<\/p\s*>/gi, "<br>")
      .replace(/<[^>]+>/g, "")
      .replace(/\s*<br>\s*/gi, "<br>")
      .replace(/\s+/g, " ")
      .trim(),
  ).replace(/\|/g, "\\|")
}

function convertHtmlTablesInSegment(segment: string): string {
  return segment.replace(/<table\b[\s\S]*?<\/table>/gi, (tableHtml) => {
    const rows: string[][] = []
    for (const rowMatch of tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const rowHtml = rowMatch[1] ?? ""
      const cells: string[] = []
      for (const cellMatch of rowHtml.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)) {
        cells.push(htmlCellToMarkdown(cellMatch[1] ?? ""))
      }
      if (cells.length > 0) rows.push(cells)
    }
    if (rows.length === 0) return tableHtml

    const width = Math.max(...rows.map((row) => row.length))
    const padded = rows.map((row) => {
      const out = [...row]
      while (out.length < width) out.push("")
      return out
    })
    const header = padded[0]
    const separator = Array.from({ length: width }, () => "---")
    const body = padded.slice(1)
    return [
      "",
      `| ${header.join(" | ")} |`,
      `| ${separator.join(" | ")} |`,
      ...body.map((row) => `| ${row.join(" | ")} |`),
      "",
    ].join("\n")
  })
}

function convertHtmlTablesToMarkdown(markdown: string): string {
  return markdown
    .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g)
    .map((segment) => (
      segment.startsWith("```") || segment.startsWith("~~~")
        ? segment
        : convertHtmlTablesInSegment(segment)
    ))
    .join("")
}

function encodeMarkdownImageUrl(relPath: string): string {
  return relPath
    .split("/")
    .map((part) =>
      encodeURIComponent(part).replace(/[!'()*]/g, (char) =>
        `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/")
}

function rewriteMineruMarkdownImages(markdown: string, pathMap: Map<string, string>): string {
  const lookup = (rawUrl: string): string | null => {
    if (!rawUrl || isExternalOrDataUrl(rawUrl)) return null
    const cleaned = normalizeMineruZipPath(rawUrl.split("#")[0])
    if (!cleaned) return null
    const decoded = decodeMineruPath(cleaned)
    return pathMap.get(cleaned) ?? pathMap.get(decoded) ?? pathMap.get(getFileName(decoded)) ?? null
  }

  const withMarkdownImages = markdown.replace(
    /!\[([^\]]*)]\(((?:[^()]|\([^()]*\))*)\)/g,
    (full, alt: string, target: string) => {
      const trimmed = target.trim()
      const candidates: Array<{ url: string; suffix: string }> = []
      if (trimmed.startsWith("<") && trimmed.includes(">")) {
        const end = trimmed.indexOf(">")
        candidates.push({ url: trimmed.slice(1, end), suffix: trimmed.slice(end + 1) })
      } else {
        const titleMatch = trimmed.match(/^([\s\S]+?)(\s+["'][^"']*["']\s*)$/)
        if (titleMatch) candidates.push({ url: titleMatch[1].trim(), suffix: titleMatch[2] })
        candidates.push({ url: trimmed, suffix: "" })
        const tokenMatch = trimmed.match(/^(\S+)([\s\S]*)$/)
        if (tokenMatch) candidates.push({ url: tokenMatch[1], suffix: tokenMatch[2] })
      }

      for (const candidate of candidates) {
        const rel = lookup(candidate.url)
        if (!rel) continue
        const rewrittenTarget = `${encodeMarkdownImageUrl(rel)}${candidate.suffix}`
        return `![${alt}](${rewrittenTarget})`
      }
      return full
    },
  )

  return withMarkdownImages.replace(
    /<img\b[^>]*\bsrc=(["'])([^"']+)\1[^>]*>/gi,
    (full, _quote: string, src: string) => {
      const rel = lookup(src)
      if (!rel) return full
      const alt = full.match(/\balt=(["'])([^"']*)\1/i)?.[2] ?? ""
      return `![${alt}](${encodeMarkdownImageUrl(rel)})`
    },
  )
}

async function submitUrlTask(
  token: string,
  url: string,
  modelVersion: string,
  signal?: AbortSignal,
): Promise<string> {
  const httpFetch = await getHttpFetch()
  throwIfAborted(signal)
  const res = await httpFetch(`${API_BASE}/extract/task`, {
    method: "POST",
    headers: await mineruHeaders(token),
    signal,
    body: JSON.stringify({ url, model_version: modelVersion }),
  })
  if (!res.ok) throw new Error(`MinerU submit failed: HTTP ${res.status}`)
  const json: TaskResponse = await res.json()
  assertMineruSuccess(json)
  return json.data.task_id
}

async function uploadFileForTask(
  token: string,
  fileName: string,
  fileBase64: string,
  modelVersion: string,
  signal?: AbortSignal,
  pageRanges?: string,
): Promise<{ batchId: string; uploadUrl: string }> {
  const httpFetch = await getHttpFetch()
  const headers = await mineruHeaders(token)
  throwIfAborted(signal)

  // The API caps `files[].data_id` at 128 characters and rejects the whole
  // batch with -10002 when exceeded — long Chinese inquiry-letter filenames
  // always trip this. Use a deterministic content-hash ID instead; keep the
  // display `name` short too so servers that cap it as well stay happy.
  const contentHash = await sha256OfBytes(decodeBase64ToBytes(fileBase64))
  const rangeTag = pageRanges ? `-${pageRanges.replace(/[^0-9,-]/g, "").slice(0, 24)}` : ""
  const dataId = `wiki-${contentHash.slice(0, 24)}${rangeTag}.pdf`
  const displayName = fileName.length > 120
    ? `${contentHash.slice(0, 8)}…${fileName.slice(-100)}`
    : fileName

  // Step 1: Get upload URL
  const fileEntry: Record<string, string> = { name: displayName, data_id: dataId }
  if (pageRanges) fileEntry.page_ranges = pageRanges
  const res = await httpFetch(`${API_BASE}/file-urls/batch`, {
    method: "POST",
    headers,
    signal,
    body: JSON.stringify({
      files: [fileEntry],
      model_version: modelVersion,
    }),
  })
  if (!res.ok) throw new Error(`MinerU batch submit failed: HTTP ${res.status}`)
  const json: UploadUrlResponse = await res.json()
  assertMineruSuccess(json)

  const batchId = json.data.batch_id
  const uploadUrl = json.data.file_urls[0]
  if (!batchId || !uploadUrl) {
    throw new Error("MinerU did not return a file upload URL")
  }

  // Step 2: Upload file binary (convert base64 back to binary)
  const bytes = decodeBase64ToBytes(fileBase64)
  throwIfAborted(signal)

  const uploadRes = await httpFetch(uploadUrl, {
    method: "PUT",
    signal,
    body: bytesToUploadBody(bytes),
  })
  if (!uploadRes.ok && uploadRes.status !== 200 && uploadRes.status !== 201) {
    throw new Error(`MinerU file upload failed: HTTP ${uploadRes.status}`)
  }

  return { batchId, uploadUrl }
}

function waitForPollInterval(signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, POLL_INTERVAL_MS)
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      reject(new Error("MinerU parsing cancelled"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

async function pollTask(
  token: string,
  taskId: string,
  signal?: AbortSignal,
  timeoutMs: number = POLL_TIMEOUT_MS,
): Promise<string> {
  const httpFetch = await getHttpFetch()
  const headers = await mineruHeaders(token)
  const start = Date.now()

  while (Date.now() - start < timeoutMs) {
    throwIfAborted(signal)
    const res = await httpFetch(`${API_BASE}/extract/task/${taskId}`, {
      headers,
      signal,
    })
    if (!res.ok) throw new Error(`MinerU poll failed: HTTP ${res.status}`)
    const json: TaskStatus = await res.json()
    assertMineruSuccess(json)

    if (json.data.state === "done" && json.data.full_zip_url) {
      return json.data.full_zip_url
    }
    if (json.data.state === "failed") {
      throw new Error(`MinerU parsing failed: ${json.data.err_msg ?? "unknown error"}`)
    }

    await waitForPollInterval(signal)
  }

  throw new MineruPollTimeoutError(
    `MinerU parsing timed out after ${Math.round(timeoutMs / 60_000)} minutes`,
  )
}

async function pollBatchTask(
  token: string,
  batchId: string,
  signal?: AbortSignal,
  timeoutMs: number = POLL_TIMEOUT_MS,
): Promise<string> {
  const httpFetch = await getHttpFetch()
  const headers = await mineruHeaders(token)
  const start = Date.now()

  while (Date.now() - start < timeoutMs) {
    throwIfAborted(signal)
    const res = await httpFetch(
      `${API_BASE}/extract-results/batch/${batchId}`,
      { headers, signal },
    )
    if (!res.ok) throw new Error(`MinerU batch poll failed: HTTP ${res.status}`)
    const json: BatchStatus = await res.json()
    assertMineruSuccess(json)

    const result = json.data.extract_result[0]
    if (result?.state === "done" && result.full_zip_url) {
      return result.full_zip_url
    }
    if (result?.state === "failed") {
      throw new Error(`MinerU parsing failed: ${result.err_msg ?? "unknown error"}`)
    }

    await waitForPollInterval(signal)
  }

  throw new MineruPollTimeoutError(
    `MinerU batch polling timed out after ${Math.round(timeoutMs / 60_000)} minutes`,
  )
}

async function saveMineruZipImages(
  zip: JSZip,
  options: MineruAssetOptions,
  signal?: AbortSignal,
): Promise<{ pathMap: Map<string, string>; savedImages: SavedImage[] }> {
  const pp = normalizePath(options.projectPath)
  const rootDir = options.assetPathPrefix
    ? `${pp}/wiki/media/${options.sourceSummarySlug}/mineru/${safeMineruAssetSegment(options.assetPathPrefix)}`
    : `${pp}/wiki/media/${options.sourceSummarySlug}/mineru`
  const pathMap = new Map<string, string>()
  const savedImages: SavedImage[] = []
  const imageEntries: Array<[string, JSZip.JSZipObject]> = []
  const basenameCounts = new Map<string, number>()

  zip.forEach((relativePath, file) => {
    const normalized = normalizeMineruZipPath(relativePath)
    if (!file.dir && normalized && isMineruImagePath(normalized)) {
      imageEntries.push([normalized, file])
      const basename = getFileName(normalized)
      basenameCounts.set(basename, (basenameCounts.get(basename) ?? 0) + 1)
    }
  })

  if (imageEntries.length === 0) return { pathMap, savedImages }

  await createDirectory(rootDir)
  for (const [zipPath, file] of imageEntries) {
    throwIfAborted(signal)
    const relPath = mineruAssetRelPath(options.sourceSummarySlug, zipPath, options.assetPathPrefix)
    const absPath = `${pp}/wiki/${relPath}`
    const bytes = await file.async("uint8array")
    await writeFileBase64(absPath, bytesToBase64(bytes))
    pathMap.set(zipPath, relPath)
    pathMap.set(decodeMineruPath(zipPath), relPath)
    const basename = getFileName(zipPath)
    if (basenameCounts.get(basename) === 1) {
      pathMap.set(basename, relPath)
      pathMap.set(decodeMineruPath(basename), relPath)
    }
    savedImages.push({
      index: savedImages.length + 1,
      mimeType: mineruImageMimeType(relPath),
      page: null,
      width: 0,
      height: 0,
      relPath,
      absPath,
      sha256: await sha256OfBytes(bytes),
    })
  }

  return { pathMap, savedImages }
}

/** Shared MinerU-archive decoding for every transport (cloud URL, local V1
 *  file store): pick full.md, normalize tables, persist images, rewrite refs. */
async function extractMineruZipBuffer(
  buffer: ArrayBuffer,
  assetOptions: MineruAssetOptions | undefined,
  signal?: AbortSignal,
): Promise<MineruExtractedMarkdown> {
  const zip = await JSZip.loadAsync(buffer)

  // Official MinerU result archives contain full.md. Prefer it; fall
  // back to another Markdown file only for compatibility with older or
  // unusual archives.
  const mdEntries: [string, JSZip.JSZipObject][] = []
  zip.forEach((relativePath, file) => {
    if (!file.dir && relativePath.endsWith(".md")) {
      mdEntries.push([relativePath, file])
    }
  })

  if (mdEntries.length === 0) {
    throw new Error("No Markdown file found in MinerU result zip")
  }

  const fullMd = mdEntries.find(([relativePath]) =>
    relativePath.split("/").pop()?.toLowerCase() === "full.md"
  )
  const markdown = await (fullMd ?? mdEntries[0])[1].async("string")
  const markdownWithTables = convertHtmlTablesToMarkdown(markdown)
  if (!assetOptions) return { markdown: markdownWithTables, savedImages: [] }

  try {
    const { pathMap, savedImages } = await saveMineruZipImages(zip, assetOptions, signal)
    return {
      markdown: pathMap.size > 0
        ? rewriteMineruMarkdownImages(markdownWithTables, pathMap)
        : markdownWithTables,
      savedImages,
    }
  } catch (err) {
    if (signal?.aborted) throw err
    console.warn(
      "[MinerU] failed to save extracted images; keeping parsed Markdown text:",
      err instanceof Error ? err.message : err,
    )
    return { markdown: markdownWithTables, savedImages: [] }
  }
}

async function downloadAndExtractMarkdown(
  zipUrl: string,
  signal?: AbortSignal,
  assetOptions?: MineruAssetOptions,
): Promise<MineruExtractedMarkdown> {
  const httpFetch = await getHttpFetch()
  throwIfAborted(signal)
  const res = await httpFetch(zipUrl, { signal })
  if (!res.ok) throw new Error(`MinerU zip download failed: HTTP ${res.status}`)
  return extractMineruZipBuffer(await res.arrayBuffer(), assetOptions, signal)
}

// ── Local backend ──

/**
 * Which local service flavor is behind `localEndpoint`:
 *  - "v1":    official `mineru-kit api-server` (MinerU 4.x, FastAPI, /v1/*)
 *  - "tasks": the third-party community mineru-api wrapper (POST /tasks)
 * Probed once per endpoint and cached; a wrong guess only costs one 404.
 */
export type LocalMineruProtocol = "v1" | "tasks"

const localProtocolCache = new Map<string, { protocol: LocalMineruProtocol; checkedAt: number }>()
const LOCAL_PROTOCOL_CACHE_TTL_MS = 5 * 60_000

export async function detectLocalMineruProtocol(
  config: Pick<MineruConfig, "localEndpoint" | "localToken">,
  signal?: AbortSignal,
): Promise<LocalMineruProtocol> {
  const base = localMineruApiBase(config.localEndpoint)
  const cached = localProtocolCache.get(base)
  if (cached && Date.now() - cached.checkedAt < LOCAL_PROTOCOL_CACHE_TTL_MS) {
    return cached.protocol
  }
  const httpFetch = await getHttpFetch()
  let protocol: LocalMineruProtocol = "tasks"
  try {
    const res = await httpFetch(
      `${base}/v1/health`,
      localMineruRequestInit(config.localToken, { signal }),
    )
    if (res.ok) {
      const health = await res.json().catch(() => null) as { version?: unknown } | null
      // Only the official V1 server answers /v1/health with a version payload.
      if (health && typeof health === "object" && "version" in health) protocol = "v1"
    }
  } catch (err) {
    if (signal?.aborted) throw err
    // Unreachable endpoint: keep "tasks" so the parse attempt surfaces the
    // connection error with the user-configured URL in it.
  }
  localProtocolCache.set(base, { protocol, checkedAt: Date.now() })
  return protocol
}

/** V1 requests follow same-origin redirects (file content may hand out a
 *  blob URL); the service is the user's own deployment, not a public gateway. */
function localV1RequestInit(
  token: string | undefined,
  init: RequestInit = {},
): RequestInit {
  return {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      ...localMineruHeaders(token),
    },
  }
}

interface V1FileRef {
  file_id: string
  bytes?: number
}

interface V1UploadInit {
  id?: string
  upload_url?: string
  upload_headers?: Record<string, string>
  status?: string
  file?: { id?: string }
}

type V1JobStatus =
  | "queued"
  | "pending"
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "canceled"
  | string

interface V1JobResponse {
  job_id?: string
  status: V1JobStatus
  files?: Array<{
    status?: string
    error?: { message?: string } | null
    output_files?: {
      markdown?: V1FileRef | null
      zip?: V1FileRef | null
    } | null
  }>
  error?: { message?: string } | null
}

const V1_TERMINAL_STATES = new Set(["completed", "partial", "failed", "canceled"])

/**
 * Parse a document through the official `mineru-kit api-server` V1 protocol:
 * uploads (with sha256 dedupe) → parse job → poll → download the self-
 * contained zip artifact so images land in the same media pipeline as the
 * cloud backend. Long CPU runs are expected: the polling window scales with
 * page count (see `localV1PollTimeoutMs`).
 */
async function parseWithLocalMineruV1(
  config: MineruConfig,
  sourcePath: string,
  fileName: string,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal,
  assetOptions?: MineruAssetOptions,
): Promise<MineruExtractedMarkdown> {
  const httpFetch = await getHttpFetch()
  const base = localMineruApiBase(config.localEndpoint)
  const tier = (config.localTier as string) || "standard"

  const healthRes = await httpFetch(
    `${base}/v1/health`,
    localV1RequestInit(config.localToken, { signal }),
  )
  if (!healthRes.ok) {
    throw new Error(`Local MinerU (V1) service unavailable: HTTP ${healthRes.status}`)
  }

  const fileSize = await getFileSize(sourcePath)
  if (fileSize > MAX_ACCURATE_PARSE_BYTES) {
    throw new Error("MinerU accurate parsing supports files up to 200 MB")
  }
  throwIfAborted(signal)
  const { base64 } = await readFileAsBase64(sourcePath)
  const bytes = decodeBase64ToBytes(base64)
  const contentSha = await sha256OfBytes(bytes)

  // Upload with sha256 dedupe; the display name is capped the same way as
  // the cloud path so long inquiry-letter filenames cannot break the server.
  onProgress?.("Uploading to local MinerU (V1)...")
  const displayName = fileName.length > 120 ? `${contentSha.slice(0, 8)}…${fileName.slice(-100)}` : fileName
  const initRes = await httpFetch(
    `${base}/v1/uploads`,
    localV1RequestInit(config.localToken, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: displayName,
        bytes: bytes.length,
        mime_type: "application/pdf",
        sha256sum: contentSha,
      }),
    }),
  )
  if (!initRes.ok) {
    const text = await initRes.text().catch(() => "")
    throw new Error(`Local MinerU (V1) upload init failed: HTTP ${initRes.status}: ${text}`)
  }
  const initiated = await initRes.json() as V1UploadInit

  let fileId: string
  if (initiated.status === "completed" && initiated.file?.id) {
    fileId = initiated.file.id
    onProgress?.("Upload deduplicated (sha256 hit)")
  } else {
    if (!initiated.id || !initiated.upload_url) {
      throw new Error("Local MinerU (V1) did not return an upload URL")
    }
    let putUrl = initiated.upload_url
    if (putUrl.startsWith("/")) putUrl = base + putUrl
    const putRes = await httpFetch(
      putUrl,
      localV1RequestInit(config.localToken, {
        method: "PUT",
        signal,
        headers: initiated.upload_headers ?? {},
        body: bytesToUploadBody(bytes),
      }),
    )
    if (!putRes.ok) {
      throw new Error(`Local MinerU (V1) byte upload failed: HTTP ${putRes.status}`)
    }
    const completeRes = await httpFetch(
      `${base}/v1/uploads/${encodeURIComponent(initiated.id)}/complete`,
      localV1RequestInit(config.localToken, {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    )
    if (!completeRes.ok) {
      throw new Error(`Local MinerU (V1) upload complete failed: HTTP ${completeRes.status}`)
    }
    const completed = await completeRes.json() as V1UploadInit
    fileId = completed.file?.id ?? ""
    if (!fileId) throw new Error("Local MinerU (V1) completion returned no file id")
  }

  // Create the parse job; the zip artifact carries the image assets.
  const jobCreateRes = await httpFetch(
    `${base}/v1/parse/jobs`,
    localV1RequestInit(config.localToken, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: [{ source: { type: "file_id", file_id: fileId } }],
        tier,
        output_formats: ["markdown", "zip"],
      }),
    }),
  )
  if (!jobCreateRes.ok) {
    const text = await jobCreateRes.text().catch(() => "")
    throw new Error(`Local MinerU (V1) job create failed: HTTP ${jobCreateRes.status}: ${text}`)
  }
  const job = await jobCreateRes.json() as V1JobResponse
  const jobId = job.job_id ?? ""
  if (!jobId) throw new Error("Local MinerU (V1) returned no job id")

  onProgress?.(`Waiting for local MinerU (V1, tier=${tier})...`)
  let pageCount: number | null = null
  try {
    pageCount = await getPdfPageCount(sourcePath)
  } catch (err) {
    if (signal?.aborted) throw err
  }
  const timeoutMs = localV1PollTimeoutMs(pageCount)
  const start = Date.now()
  let final: V1JobResponse | null = null
  while (Date.now() - start < timeoutMs) {
    throwIfAborted(signal)
    const res = await httpFetch(
      `${base}/v1/parse/jobs/${encodeURIComponent(jobId)}`,
      localV1RequestInit(config.localToken, { signal }),
    )
    if (!res.ok) {
      throw new Error(`Local MinerU (V1) job poll failed: HTTP ${res.status}`)
    }
    const current = await res.json() as V1JobResponse
    if (V1_TERMINAL_STATES.has(current.status)) {
      final = current
      break
    }
    await waitForPollInterval(signal)
  }
  if (!final) {
    throw new MineruPollTimeoutError(
      `Local MinerU (V1) parsing timed out after ${Math.round(timeoutMs / 60_000)} minutes`,
    )
  }
  if (final.status === "failed" || final.status === "canceled") {
    const reason =
      final.error?.message ?? final.files?.[0]?.error?.message ?? final.status
    throw new Error(`Local MinerU (V1) parsing failed: ${reason}`)
  }
  if (final.status === "partial") {
    console.warn(
      "[MinerU:local-v1] job finished 'partial' — some pages failed; using the recovered output",
    )
  }

  const outputs = final.files?.[0]?.output_files
  if (!outputs) throw new Error("Local MinerU (V1) job completed without output files")
  onProgress?.("Downloading parsed result...")
  if (outputs.zip) {
    const zipRes = await httpFetch(
      `${base}/v1/files/${encodeURIComponent(outputs.zip.file_id)}/content`,
      localV1RequestInit(config.localToken, { signal }),
    )
    if (!zipRes.ok) {
      throw new Error(`Local MinerU (V1) zip download failed: HTTP ${zipRes.status}`)
    }
    return extractMineruZipBuffer(await zipRes.arrayBuffer(), assetOptions, signal)
  }
  if (outputs.markdown) {
    const mdRes = await httpFetch(
      `${base}/v1/files/${encodeURIComponent(outputs.markdown.file_id)}/content`,
      localV1RequestInit(config.localToken, { signal }),
    )
    if (!mdRes.ok) {
      throw new Error(`Local MinerU (V1) markdown download failed: HTTP ${mdRes.status}`)
    }
    return { markdown: convertHtmlTablesToMarkdown(await mdRes.text()), savedImages: [] }
  }
  throw new Error("Local MinerU (V1) job completed without markdown/zip output")
}

const MINERU_3_0_TO_3_2_BACKENDS: Partial<
  Record<NonNullable<MineruConfig["localBackend"]>, string>
> = {
  "vlm-engine": "vlm-auto-engine",
  "hybrid-engine": "hybrid-auto-engine",
}

function localMineruBackendForVersion(
  backend: NonNullable<MineruConfig["localBackend"]>,
  version: unknown,
): string {
  if (typeof version === "string" && /^3\.[0-2](?:\.|$)/.test(version.trim())) {
    return MINERU_3_0_TO_3_2_BACKENDS[backend] ?? backend
  }
  return backend
}

/**
 * Parse a document through the community third-party `mineru-api` wrapper
 * (multipart POST /tasks protocol). Kept for existing setups; new official
 * deployments speak V1 and are routed there by `parseWithLocalMineru`.
 */
async function parseWithLocalMineruTasks(
  config: MineruConfig,
  sourcePath: string,
  fileName: string,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal,
  assetOptions?: MineruAssetOptions,
): Promise<MineruExtractedMarkdown> {
  const httpFetch = await getHttpFetch()
  const apiBase = localMineruApiBase(config.localEndpoint)
  const configuredBackend = config.localBackend || "hybrid-engine"
  if (configuredBackend.endsWith("http-client") && !config.localServerUrl?.trim()) {
    throw new Error("MinerU HTTP client backends require a model server URL")
  }
  const fileSize = await getFileSize(sourcePath)
  if (fileSize > MAX_ACCURATE_PARSE_BYTES) {
    throw new Error("MinerU accurate parsing supports files up to 200 MB")
  }
  throwIfAborted(signal)
  let serverVersion: unknown
  if (configuredBackend.endsWith("-engine")) {
    try {
      const healthRes = await httpFetch(
        `${apiBase}/health`,
        localMineruRequestInit(config.localToken, { signal }),
      )
      if (healthRes.ok) {
        const health = await healthRes.json() as { version?: unknown }
        serverVersion = health.version
      }
    } catch (err) {
      if (signal?.aborted) throw err
    }
  }
  const localBackend = localMineruBackendForVersion(configuredBackend, serverVersion)
  const { base64 } = await readFileAsBase64(sourcePath)
  const bytes = decodeBase64ToBytes(base64)
  const fileBuffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
  const form = new FormData()
  form.append("files", new Blob([fileBuffer], { type: "application/pdf" }), fileName)
  form.append("lang_list", config.localLanguage || "ch")
  form.append("backend", localBackend)
  form.append("effort", config.localEffort || "medium")
  form.append("parse_method", config.localParseMethod || "auto")
  form.append("formula_enable", String(config.localFormulaEnabled !== false))
  form.append("table_enable", String(config.localTableEnabled !== false))
  form.append("image_analysis", String(config.localImageAnalysis !== false))
  form.append("return_md", "true")
  form.append("return_images", String(Boolean(assetOptions)))
  form.append("response_format_zip", "false")
  if (config.localServerUrl?.trim()) form.append("server_url", config.localServerUrl.trim())

  onProgress?.("Uploading to local MinerU...")
  const submitRes = await httpFetch(`${apiBase}/tasks`, localMineruRequestInit(config.localToken, {
    method: "POST",
    signal,
    body: form,
  }))
  if (!submitRes.ok) {
    const text = await submitRes.text().catch(() => "")
    throw new Error(`Local MinerU submit failed: HTTP ${submitRes.status}: ${text}`)
  }

  const submitData = await submitRes.json() as { task_id?: unknown }
  const taskId = typeof submitData.task_id === "string" ? submitData.task_id.trim() : ""
  if (!taskId) throw new Error("Local MinerU returned no task ID")
  const encodedTaskId = encodeURIComponent(taskId)
  // Keep all follow-up requests pinned to the user-configured service. The
  // official response includes absolute URLs, but following arbitrary values
  // from a compromised or incompatible server would create an SSRF redirect.
  const statusUrl = `${apiBase}/tasks/${encodedTaskId}`
  const resultUrl = `${apiBase}/tasks/${encodedTaskId}/result`

  onProgress?.("Waiting for local MinerU to finish...")
  const start = Date.now()
  while (Date.now() - start < LOCAL_POLL_TIMEOUT_MS) {
    throwIfAborted(signal)

    const statusRes = await httpFetch(statusUrl, localMineruRequestInit(config.localToken, {
      signal,
    }))
    if (!statusRes.ok) {
      throw new Error(`Local MinerU status check failed: HTTP ${statusRes.status}`)
    }
    const status = await statusRes.json()

    if (status.status === "completed") {
      onProgress?.("Downloading parsed result...")
      const resultRes = await httpFetch(resultUrl, localMineruRequestInit(config.localToken, {
        signal,
      }))
      if (!resultRes.ok) {
        throw new Error(`Local MinerU download failed: HTTP ${resultRes.status}`)
      }
      const result = await resultRes.json() as {
        results?: Record<string, { md_content?: unknown; images?: unknown }>
      }
      const first = result.results && Object.values(result.results)[0]
      if (!first || typeof first.md_content !== "string" || !first.md_content.trim()) {
        throw new Error("Local MinerU returned an empty parsing result")
      }
      let markdown = convertHtmlTablesToMarkdown(first.md_content)
      const savedImages: SavedImage[] = []
      const pathMap = new Map<string, string>()
      if (assetOptions && first.images && typeof first.images === "object") {
        const mediaDir = `${normalizePath(assetOptions.projectPath)}/wiki/media/${assetOptions.sourceSummarySlug}/mineru/images`
        await createDirectory(mediaDir)
        for (const [rawName, rawData] of Object.entries(first.images)) {
          throwIfAborted(signal)
          if (typeof rawData !== "string") continue
          const match = rawData.match(/^data:(image\/[^;]+);base64,(.+)$/s)
          if (!match) continue
          const sourceName = getFileName(normalizeMineruZipPath(rawName))
          if (!sourceName || !isMineruImagePath(sourceName)) continue
          // The data URI describes the bytes actually written. The server's
          // filename is untrusted lookup metadata and may carry a mismatched
          // extension, which would break previews and downstream MIME handling.
          const mimeType = match[1].toLowerCase()
          const extension = mineruExtensionForMimeType(mimeType)
          if (!extension) continue
          // Server-provided names are untrusted and may collide or contain a
          // Windows reserved device name. Generate deterministic local names
          // while retaining lookup entries for the original Markdown target.
          const safeName = `image-${savedImages.length + 1}.${extension}`
          const absPath = `${mediaDir}/${safeName}`
          const relPath = `media/${assetOptions.sourceSummarySlug}/mineru/images/${safeName}`
          await writeFileBase64(absPath, match[2])
          savedImages.push({
            index: savedImages.length,
            mimeType,
            page: null,
            width: 0,
            height: 0,
            relPath,
            absPath,
            sha256: "",
          })
          pathMap.set(rawName, relPath)
          pathMap.set(sourceName, relPath)
        }
      }
      if (pathMap.size > 0) markdown = rewriteMineruMarkdownImages(markdown, pathMap)
      return { markdown, savedImages }
    }
    if (status.status === "failed") {
      throw new Error(`Local MinerU parsing failed: ${status.error || "unknown error"}`)
    }

    await waitForPollInterval(signal)
  }

  throw new Error("Local MinerU parsing timed out")
}

/**
 * Local-backend entry point: probe the configured endpoint once and route to
 * the matching protocol. Official MinerU 4.x deployments (`mineru-kit
 * api-server`, including the CPU portable package's `launch.ps1 -Api` mode)
 * answer /v1/health and get the V1 protocol; anything else falls back to the
 * community /tasks wrapper.
 */
async function parseWithLocalMineru(
  config: MineruConfig,
  sourcePath: string,
  fileName: string,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal,
  assetOptions?: MineruAssetOptions,
): Promise<MineruExtractedMarkdown> {
  const protocol = await detectLocalMineruProtocol(config, signal)
  const parsed = protocol === "v1"
    ? await parseWithLocalMineruV1(config, sourcePath, fileName, onProgress, signal, assetOptions)
    : await parseWithLocalMineruTasks(config, sourcePath, fileName, onProgress, signal, assetOptions)
  return { ...parsed, protocol }
}

/**
 * Split `total` pages into `page_ranges` strings ("1-200", "201-400", …)
 * accepted by the cloud batch API, so a document above the per-task page
 * limit can be parsed segment by segment instead of being rejected (-60006).
 */
export function splitPageRanges(total: number, maxPerPage = MAX_CLOUD_PAGES_PER_TASK): string[] {
  if (!Number.isFinite(total) || total <= 0 || maxPerPage <= 0) return []
  const ranges: string[] = []
  for (let start = 1; start <= total; start += maxPerPage) {
    const end = Math.min(start + maxPerPage - 1, total)
    ranges.push(`${start}-${end}`)
  }
  return ranges
}

/** Poll a batch task and, if the window elapses while the task is still
 *  queued/running server-side, extend polling of the SAME batch once. The
 *  alternative — re-upload — restarts queue position and burns daily quota. */
async function pollBatchTaskWithExtension(
  token: string,
  batchId: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  onProgress?: (msg: string) => void,
): Promise<string> {
  try {
    return await pollBatchTask(token, batchId, signal, timeoutMs)
  } catch (err) {
    if (!(err instanceof MineruPollTimeoutError)) throw err
    onProgress?.("MinerU: still queued after the polling window; extending (same task, no re-upload)...")
    return await pollBatchTask(token, batchId, signal, timeoutMs)
  }
}

async function pollTaskWithExtension(
  token: string,
  taskId: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  onProgress?: (msg: string) => void,
): Promise<string> {
  try {
    return await pollTask(token, taskId, signal, timeoutMs)
  } catch (err) {
    if (!(err instanceof MineruPollTimeoutError)) throw err
    onProgress?.("MinerU: still queued after the polling window; extending (same task)...")
    return await pollTask(token, taskId, signal, timeoutMs)
  }
}

/**
 * Parse one PDF through the cloud API as multiple `page_ranges` segments and
 * join the Markdown. Each segment gets its own media sub-directory
 * (`mineru/seg-1/…`) so identically-named zip assets cannot collide.
 */
async function parseCloudMineruSegmented(
  config: MineruConfig,
  sourcePath: string,
  ranges: readonly string[],
  onProgress?: (msg: string) => void,
  signal?: AbortSignal,
  assetOptions?: MineruAssetOptions,
): Promise<MineruExtractedMarkdown> {
  const fileName = sourcePath.split("/").pop() ?? "document.pdf"
  throwIfAborted(signal)
  const { base64 } = await readFileAsBase64(sourcePath)

  const markdowns: string[] = []
  const savedImages: SavedImage[] = []
  for (let i = 0; i < ranges.length; i++) {
    const range = ranges[i]
    throwIfAborted(signal)
    onProgress?.(`MinerU: segment ${i + 1}/${ranges.length} (pages ${range})...`)
    const segmentPageCount = Number(range.split("-")[1]) - Number(range.split("-")[0]) + 1

    const { batchId } = await uploadFileForTask(
      config.token,
      fileName,
      base64,
      config.modelVersion,
      signal,
      range,
    )
    const zipUrl = await pollBatchTaskWithExtension(
      config.token,
      batchId,
      signal,
      cloudPollTimeoutMs(segmentPageCount),
      onProgress,
    )
    const segment = await downloadAndExtractMarkdown(zipUrl, signal, assetOptions
      ? { ...assetOptions, assetPathPrefix: `seg-${i + 1}` }
      : undefined)
    markdowns.push(segment.markdown)
    savedImages.push(...segment.savedImages)
  }

  return {
    markdown: markdowns.filter((part) => part.trim()).join("\n\n"),
    savedImages,
  }
}

// ── Public API ──

/**
 * Parse a PDF file using MinerU cloud API.
 *
 * @param config MinerU configuration (token, model version)
 * @param sourcePath Local file path to the PDF
 * @param sourceUrl Optional URL if the PDF was fetched from the web — avoids re-upload
 * @param onProgress Optional progress callback
 * @returns Parsed Markdown content
 */
export async function parseWithMineru(
  config: MineruConfig,
  sourcePath: string,
  sourceUrl?: string,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal,
  assetOptions?: MineruAssetOptions,
): Promise<string> {
  return (await parseWithMineruResult(config, sourcePath, sourceUrl, onProgress, signal, assetOptions)).markdown
}

export async function parseWithMineruResult(
  config: MineruConfig,
  sourcePath: string,
  sourceUrl?: string,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal,
  assetOptions?: MineruAssetOptions,
): Promise<MineruExtractedMarkdown> {
  throwIfAborted(signal)

  if (config.backend === "local") {
    const fileName = getFileName(sourcePath) || "document.pdf"
    const result = await parseWithLocalMineru(
      config,
      sourcePath,
      fileName,
      onProgress,
      signal,
      assetOptions,
    )
    onProgress?.("Done")
    return result
  }

  if (!config.token) throw new Error("MinerU API token not configured")
  if (config.modelVersion !== "pipeline" && config.modelVersion !== "vlm") {
    throw new Error("MinerU PDF parsing supports only pipeline or vlm model versions")
  }

  // Documents above the cloud page limit are transparently split into
  // page-range segments; submitting them whole would fail with -60006 and
  // (pre-fix) silently degrade the source to built-in PDF text extraction.
  let pageCount: number | null = null
  try {
    pageCount = await getPdfPageCount(sourcePath)
  } catch (err) {
    if (signal?.aborted) throw err
    // Unreadable page count (e.g. password-protected PDF): let the single
    // task path surface the real API error instead of guessing here.
  }
  if (pageCount !== null && pageCount > MAX_CLOUD_PAGES_PER_TASK) {
    const ranges = splitPageRanges(pageCount)
    onProgress?.(`MinerU: ${pageCount} pages exceeds the ${MAX_CLOUD_PAGES_PER_TASK}-page limit; splitting into ${ranges.length} segments...`)
    const result = await parseCloudMineruSegmented(config, sourcePath, ranges, onProgress, signal, assetOptions)
    onProgress?.("Done")
    return result
  }

  let zipUrl: string

  if (sourceUrl) {
    onProgress?.("Submitting URL to MinerU...")
    const taskId = await submitUrlTask(config.token, sourceUrl, config.modelVersion, signal)
    onProgress?.("Waiting for MinerU to finish...")
    zipUrl = await pollTaskWithExtension(
      config.token,
      taskId,
      signal,
      cloudPollTimeoutMs(pageCount),
      onProgress,
    )
  } else {
    onProgress?.("Uploading file to MinerU...")
    throwIfAborted(signal)
    const fileSize = await getFileSize(sourcePath)
    if (fileSize > MAX_ACCURATE_PARSE_BYTES) {
      throw new Error("MinerU accurate parsing supports files up to 200 MB")
    }

    // Read file as base64
    const fileName = sourcePath.split("/").pop() ?? "document.pdf"
    throwIfAborted(signal)
    const { base64 } = await readFileAsBase64(sourcePath)

    const { batchId } = await uploadFileForTask(
      config.token,
      fileName,
      base64,
      config.modelVersion,
      signal,
    )
    onProgress?.("Waiting for MinerU to finish...")
    zipUrl = await pollBatchTaskWithExtension(
      config.token,
      batchId,
      signal,
      cloudPollTimeoutMs(pageCount),
      onProgress,
    )
  }

  onProgress?.("Downloading parsed result...")
  const result = await downloadAndExtractMarkdown(zipUrl, signal, assetOptions)
  onProgress?.("Done")

  return result
}

/**
 * Test MinerU connectivity.
 *
 * Cloud backend: submits a minimal task to validate the token.
 * Local backend: checks the local service health endpoint with its optional token.
 */
export async function testMineruConnection(
  token: string,
  config?: Pick<MineruConfig, "backend" | "localEndpoint" | "localToken">,
): Promise<void> {
  const httpFetch = await getHttpFetch()

  if (config?.backend === "local") {
    const base = localMineruApiBase(config.localEndpoint)
    const protocol = await detectLocalMineruProtocol(config)
    if (protocol === "v1") {
      const res = await httpFetch(
        `${base}/v1/health`,
        localV1RequestInit(config.localToken),
      )
      if (!res.ok) {
        throw new Error(`Local MinerU (V1) service unavailable: HTTP ${res.status}`)
      }
      return
    }
    const res = await httpFetch(
      `${base}/health`,
      localMineruRequestInit(config.localToken),
    )
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`Local MinerU service unavailable: HTTP ${res.status}: ${text}`)
    }
    const health = await res.json().catch(() => null) as { status?: unknown } | null
    if (health?.status !== "healthy") {
      throw new Error("Local MinerU service returned an invalid or unhealthy status")
    }
    return
  }

  const res = await httpFetch(`${API_BASE}/extract/task`, {
    method: "POST",
    headers: await mineruHeaders(token),
    body: JSON.stringify({
      url: "https://cdn-mineru.openxlab.org.cn/demo/example.pdf",
      model_version: "pipeline",
    }),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`HTTP ${res.status}: ${text}`)
  }

  const json: TaskResponse = await res.json()
  assertMineruSuccess(json)
}

// Test-only hooks for MinerU's browser/Tauri boundary helpers.
export const __mineruTest = {
  /** Prime the local-protocol cache so a test can pin the flavor without
   *  the /v1/health probe consuming a queued mock response. */
  primeLocalProtocolCache: (endpoint: string, protocol: LocalMineruProtocol) => {
    localProtocolCache.set(localMineruApiBase(endpoint), { protocol, checkedAt: Date.now() })
  },
  clearLocalProtocolCache: () => localProtocolCache.clear(),
  downloadAndExtractMarkdown: async (
    zipUrl: string,
    signal?: AbortSignal,
    assetOptions?: MineruAssetOptions,
  ) => (await downloadAndExtractMarkdown(zipUrl, signal, assetOptions)).markdown,
  downloadAndExtractMarkdownResult: downloadAndExtractMarkdown,
  mineruApiErrorMessage,
  decodeBase64ToBytes,
  rewriteMineruMarkdownImages,
  convertHtmlTablesToMarkdown,
  MAX_ACCURATE_PARSE_BYTES,
}
