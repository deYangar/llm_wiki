import { describe, it, expect, beforeEach, vi } from "vitest"

// Mock fs so the tests don't touch real disk.
vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  fileExists: vi.fn(),
}))

import { checkIngestCache, saveIngestCache } from "./ingest-cache"
import { readFile, writeFile, fileExists } from "@/commands/fs"

const mockReadFile = vi.mocked(readFile)
const mockWriteFile = vi.mocked(writeFile)
const mockFileExists = vi.mocked(fileExists)

beforeEach(() => {
  mockReadFile.mockReset()
  mockWriteFile.mockReset()
  mockFileExists.mockReset()
  mockWriteFile.mockResolvedValue(undefined as unknown as void)
})

describe("ingest-cache — checkIngestCache", () => {
  it("returns null when no entry exists", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ entries: {} }))
    const result = await checkIngestCache("/project", "foo.pdf", "content")
    expect(result).toBeNull()
  })

  it("returns cached filesWritten when hash matches AND all files exist", async () => {
    // Pre-seed cache with a hash matching "hello".
    // We compute the expected hash by running saveIngestCache first in
    // a controlled round-trip, then feeding the same JSON back in.
    let persisted = ""
    mockReadFile.mockImplementation(async () => persisted || JSON.stringify({ entries: {} }))
    mockWriteFile.mockImplementation(async (_p: string, c: string) => {
      persisted = c
    })
    await saveIngestCache("/project", "foo.pdf", "hello", [
      "wiki/sources/foo.md",
      "wiki/entities/bar.md",
    ])

    mockFileExists.mockResolvedValue(true)
    const result = await checkIngestCache("/project", "foo.pdf", "hello")
    expect(result).toEqual(["wiki/sources/foo.md", "wiki/entities/bar.md"])
  })

  it("returns null when hash matches but a cached file no longer exists on disk", async () => {
    // Prime cache, then simulate user deleting one of the written files.
    let persisted = ""
    mockReadFile.mockImplementation(async () => persisted || JSON.stringify({ entries: {} }))
    mockWriteFile.mockImplementation(async (_p: string, c: string) => {
      persisted = c
    })
    await saveIngestCache("/project", "foo.pdf", "hello", [
      "wiki/sources/foo.md",
      "wiki/entities/bar.md",
    ])

    // wiki/entities/bar.md has been deleted since the cache was written.
    mockFileExists.mockImplementation(async (p: string) => {
      return !p.includes("entities/bar.md")
    })

    const result = await checkIngestCache("/project", "foo.pdf", "hello")
    expect(result).toBeNull()
  })

  it("returns null when the content hash no longer matches (cache stale on content change)", async () => {
    let persisted = ""
    mockReadFile.mockImplementation(async () => persisted || JSON.stringify({ entries: {} }))
    mockWriteFile.mockImplementation(async (_p: string, c: string) => {
      persisted = c
    })
    await saveIngestCache("/project", "foo.pdf", "hello", ["wiki/sources/foo.md"])

    const result = await checkIngestCache("/project", "foo.pdf", "different content")
    expect(result).toBeNull()
  })

  it("returns null if fileExists itself throws (safer to re-ingest than to trust)", async () => {
    let persisted = ""
    mockReadFile.mockImplementation(async () => persisted || JSON.stringify({ entries: {} }))
    mockWriteFile.mockImplementation(async (_p: string, c: string) => {
      persisted = c
    })
    await saveIngestCache("/project", "foo.pdf", "hello", ["wiki/sources/foo.md"])

    mockFileExists.mockRejectedValue(new Error("stat failed"))

    const result = await checkIngestCache("/project", "foo.pdf", "hello")
    expect(result).toBeNull()
  })
})

describe("ingest-cache — logicVersion (extraction-requirement changes)", () => {
  function primeCache(mode = "summarize", logicVersion = "1") {
    let persisted = ""
    mockReadFile.mockImplementation(async () => persisted || JSON.stringify({ entries: {} }))
    mockWriteFile.mockImplementation(async (_p: string, c: string) => {
      persisted = c
    })
    return {
      seed: () =>
        saveIngestCache("/project", "foo.pdf", "hello", ["wiki/sources/foo.md"], mode, logicVersion),
      check: (mode2: string, version2: string) =>
        checkIngestCache("/project", "foo.pdf", "hello", mode2, version2),
      persistedRef: () => persisted,
    }
  }

  beforeEach(() => {
    mockFileExists.mockResolvedValue(true)
  })

  it("hits when the logic version matches", async () => {
    const c = primeCache()
    await c.seed()
    const result = await c.check("summarize", "1")
    expect(result).toEqual(["wiki/sources/foo.md"])
  })

  it("misses after the logic version is bumped (prompt/rule change must invalidate cache)", async () => {
    const c = primeCache()
    await c.seed()
    const result = await c.check("summarize", "2")
    expect(result).toBeNull()
  })

  it("treats legacy entries (no logicVersion field) as version \"1\" — versioned rollout must NOT re-ingest the whole library", async () => {
    const c = primeCache()
    await c.seed()
    // Strip the field from the persisted entry to simulate a pre-versioning cache file.
    const parsed = JSON.parse(c.persistedRef())
    delete parsed.entries["foo.pdf"].logicVersion
    mockReadFile.mockImplementation(async () => JSON.stringify(parsed))

    // Current pipeline (version "1") still hits a legacy entry.
    expect(await c.check("summarize", "1")).toEqual(["wiki/sources/foo.md"])
    // After a future bump to "2", legacy entries are invalidated too —
    // they were produced by the pre-bump logic.
    expect(await c.check("summarize", "2")).toBeNull()
  })

  it("persists the logicVersion on save (round-trip visible in the cache file)", async () => {
    const c = primeCache("qa-split", "7")
    await c.seed()
    const parsed = JSON.parse(c.persistedRef())
    expect(parsed.entries["foo.pdf"].logicVersion).toBe("7")
    expect(parsed.entries["foo.pdf"].mode).toBe("qa-split")
  })
})
