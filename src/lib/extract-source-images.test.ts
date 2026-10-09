import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  copyFile: vi.fn(),
  createDirectory: vi.fn(),
  readFileAsBase64: vi.fn(),
  invoke: vi.fn(),
}))

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }))
vi.mock("@/commands/fs", () => ({
  copyFile: mocks.copyFile,
  createDirectory: mocks.createDirectory,
  fileExists: vi.fn(),
  readFileAsBase64: mocks.readFileAsBase64,
}))

import { buildImageMarkdownSection, extractAndSaveSourceImages, findLocalMarkdownImageRefs } from "./extract-source-images"

beforeEach(() => {
  vi.clearAllMocks()
  mocks.copyFile.mockResolvedValue(undefined)
  mocks.createDirectory.mockResolvedValue(undefined)
  mocks.readFileAsBase64.mockResolvedValue({ base64: "aW1hZ2U=", mimeType: "image/png" })
})

describe("findLocalMarkdownImageRefs", () => {
  it("extracts Obsidian and markdown local image references", () => {
    const refs = findLocalMarkdownImageRefs(`
![[attachments/chart.png]]
![Figure](images/plot%201.jpg "title")
![Remote](https://example.com/a.png)
![[attachments/chart.png|400]]
`)
    expect(refs).toEqual(["attachments/chart.png", "images/plot 1.jpg"])
  })

  it("ignores non-image links and remote/data references", () => {
    const refs = findLocalMarkdownImageRefs(`
![Doc](notes/page.md)
![Data](data:image/png;base64,abc)
![[draft.txt]]
`)
    expect(refs).toEqual([])
  })
})

describe("extractAndSaveSourceImages", () => {
  it("imports a standalone image as the source's only saved image", async () => {
    const images = await extractAndSaveSourceImages(
      "/project",
      "/project/raw/sources/process flow.JPG",
      "process-flow",
    )

    expect(mocks.createDirectory).toHaveBeenCalledWith("/project/wiki/media/process-flow")
    expect(mocks.copyFile).toHaveBeenCalledWith(
      "/project/raw/sources/process flow.JPG",
      "/project/wiki/media/process-flow/001-process flow.JPG",
    )
    expect(mocks.invoke).not.toHaveBeenCalled()
    expect(images).toHaveLength(1)
    expect(images[0]).toMatchObject({
      index: 1,
      mimeType: "image/jpeg",
      page: null,
      relPath: "media/process-flow/001-process flow.JPG",
      absPath: "/project/wiki/media/process-flow/001-process flow.JPG",
    })
    expect(images[0].sha256).toMatch(/^[a-f0-9]{64}$/)
  })
})

describe("buildImageMarkdownSection page-san / embedded split", () => {
  const img = (over: Partial<import("./extract-source-images").SavedImage> & { index: number; relPath: string; sha256: string; kind?: "embedded" | "page-scan" }) => ({
    mimeType: "image/png",
    page: 1,
    width: 100,
    height: 100,
    absPath: `/proj/wiki/${over.relPath}`,
    ...over,
  })

  it("keeps embedded figures in the per-page section and folds page scans separately", () => {
    const section = buildImageMarkdownSection([
      img({ index: 1, relPath: "media/doc/img-1.png", sha256: "a1", kind: "page-scan" }),
      img({ index: 2, relPath: "media/doc/img-2.png", sha256: "a2", kind: "embedded", page: 3 }),
      img({ index: 3, relPath: "media/doc/img-3.png", sha256: "a3", kind: "page-scan" }),
    ])

    expect(section).toContain("## Embedded Images")
    expect(section).toContain("### Page 3")
    expect(section).toContain("media/doc/img-2.png")
    expect(section).toContain("## Scanned Pages (degraded parse)")
    expect(section).toContain("<details>")
    expect(section).toContain("2 page scans")
    expect(section).toContain("media/doc/img-1.png")
    // Page scans must not be listed as per-page `### Page N` entries.
    expect(section).not.toMatch(/^### Page 1$/m)
  })

  it("treats images without a kind as embedded (legacy extraction data)", () => {
    const section = buildImageMarkdownSection([
      img({ index: 1, relPath: "media/doc/img-1.png", sha256: "a1" }),
    ])
    expect(section).toContain("## Embedded Images")
    expect(section).not.toContain("Scanned Pages")
  })
})
