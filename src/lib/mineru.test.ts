import JSZip from "jszip"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockHttpFetch = vi.fn<(url: string, opts?: RequestInit) => Promise<Response>>()

vi.mock("@/lib/tauri-fetch", () => ({
  getHttpFetch: () => Promise.resolve(mockHttpFetch),
}))

const fsMocks = vi.hoisted(() => ({
  createDirectory: vi.fn<() => Promise<void>>(),
  getFileSize: vi.fn<() => Promise<number>>(),
  getPdfPageCount: vi.fn<() => Promise<number>>(),
  readFileAsBase64: vi.fn<() => Promise<{ base64: string; mimeType: string }>>(),
  writeFileBase64: vi.fn<(path: string, base64: string) => Promise<void>>(),
}))

vi.mock("@/commands/fs", () => ({
  createDirectory: fsMocks.createDirectory,
  getFileSize: fsMocks.getFileSize,
  getPdfPageCount: fsMocks.getPdfPageCount,
  readFileAsBase64: fsMocks.readFileAsBase64,
  writeFileBase64: fsMocks.writeFileBase64,
}))

import { __mineruTest, classifyMineruFailure, detectLocalMineruProtocol, parseWithMineru, parseWithMineruResult, splitPageRanges, testMineruConnection } from "./mineru"

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  })
}

async function zipResponse(files: Record<string, string>): Promise<Response> {
  const zip = new JSZip()
  for (const [path, content] of Object.entries(files)) {
    zip.file(path, content)
  }
  const bytes = await zip.generateAsync({ type: "uint8array" })
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
  return new Response(buffer)
}

beforeEach(() => {
  mockHttpFetch.mockReset()
  // Pin the local-protocol cache to the community /tasks flavor for every
  // endpoint used below, so the /v1/health probe never consumes a queued
  // mock response. V1-protocol tests re-prime with "v1" explicitly.
  __mineruTest.clearLocalProtocolCache()
  __mineruTest.primeLocalProtocolCache("http://127.0.0.1:8000", "tasks")
  __mineruTest.primeLocalProtocolCache("http://localhost:9000/custom/", "tasks")
  // Default routing for any endpoint that still probes: unknown URLs fail
  // loudly; queued mockResolvedValueOnce responses take precedence.
  mockHttpFetch.mockImplementation(async (url: string) => {
    if (url.endsWith("/v1/health")) {
      return new Response("not found", { status: 404 })
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
  fsMocks.createDirectory.mockReset()
  fsMocks.getFileSize.mockReset()
  fsMocks.getPdfPageCount.mockReset()
  fsMocks.readFileAsBase64.mockReset()
  fsMocks.writeFileBase64.mockReset()
  fsMocks.createDirectory.mockResolvedValue(undefined)
  fsMocks.getFileSize.mockResolvedValue(1024)
  fsMocks.getPdfPageCount.mockResolvedValue(10)
  fsMocks.readFileAsBase64.mockResolvedValue({
    base64: btoa("pdf bytes"),
    mimeType: "application/pdf",
  })
  fsMocks.writeFileBase64.mockResolvedValue(undefined)
})

describe("MinerU API helpers", () => {
  it("maps official API error codes to actionable messages", () => {
    expect(__mineruTest.mineruApiErrorMessage("A0202", "bad token")).toContain("invalid")
    expect(__mineruTest.mineruApiErrorMessage("A0211", "expired")).toContain("expired")
    expect(__mineruTest.mineruApiErrorMessage(-60005, "too large")).toContain("200 MB")
    expect(__mineruTest.mineruApiErrorMessage(-60006, "too many pages")).toContain("200 page")
    expect(__mineruTest.mineruApiErrorMessage(-60018, "quota")).toContain("quota")
    expect(__mineruTest.mineruApiErrorMessage(123, "other")).toBe("MinerU API error 123: other")
  })

  it("prefers full.md from MinerU result zip", async () => {
    mockHttpFetch.mockResolvedValueOnce(await zipResponse({
      "result/other.md": "other markdown",
      "result/full.md": "full markdown",
    }))

    await expect(__mineruTest.downloadAndExtractMarkdown("https://cdn/result.zip"))
      .resolves.toBe("full markdown")
  })

  it("falls back to another markdown file when full.md is missing", async () => {
    mockHttpFetch.mockResolvedValueOnce(await zipResponse({
      "result/page.md": "fallback markdown",
    }))

    await expect(__mineruTest.downloadAndExtractMarkdown("https://cdn/result.zip"))
      .resolves.toBe("fallback markdown")
  })

  it("rejects MinerU zip files without markdown output", async () => {
    mockHttpFetch.mockResolvedValueOnce(await zipResponse({
      "result/layout.json": "{}",
    }))

    await expect(__mineruTest.downloadAndExtractMarkdown("https://cdn/result.zip"))
      .rejects.toThrow("No Markdown file")
  })

  it("converts MinerU HTML tables inside full.md to Markdown tables", async () => {
    mockHttpFetch.mockResolvedValueOnce(await zipResponse({
      "full.md": [
        "# Parsed",
        "<table>",
        "<tr><th>Name</th><th>Value</th></tr>",
        "<tr><td>A&amp;B</td><td>1|2</td></tr>",
        "</table>",
      ].join("\n"),
    }))

    await expect(__mineruTest.downloadAndExtractMarkdown("https://cdn/result.zip"))
      .resolves.toContain("| Name | Value |\n| --- | --- |\n| A&B | 1\\|2 |")
  })

  it("keeps malformed numeric HTML entities from crashing table conversion", async () => {
    mockHttpFetch.mockResolvedValueOnce(await zipResponse({
      "full.md": [
        "<table>",
        "<tr><td>&#65;</td><td>&#9999999999;</td><td>&#x41;</td><td>&#xFFFFFFF;</td></tr>",
        "</table>",
      ].join("\n"),
    }))

    await expect(__mineruTest.downloadAndExtractMarkdown("https://cdn/result.zip"))
      .resolves.toContain("| A | &#9999999999; | A | &#xFFFFFFF; |")
  })

  it("does not convert HTML tables inside fenced code blocks", async () => {
    const code = [
      "```html",
      "<table><tr><td>Keep raw</td></tr></table>",
      "```",
    ].join("\n")
    mockHttpFetch.mockResolvedValueOnce(await zipResponse({
      "full.md": `${code}\n\n<table><tr><td>Convert me</td></tr></table>`,
    }))

    const markdown = await __mineruTest.downloadAndExtractMarkdown("https://cdn/result.zip")

    expect(markdown).toContain(code)
    expect(markdown).toContain("| Convert me |")
  })

  it("preserves and rewrites images inside MinerU HTML table cells", async () => {
    mockHttpFetch.mockResolvedValueOnce(await zipResponse({
      "full.md": [
        "<table>",
        "<tr><th>Figure</th><th>Note</th></tr>",
        "<tr><td><img src=\"images/chart.png\" alt=\"Chart\"></td><td>A</td></tr>",
        "</table>",
      ].join("\n"),
      "images/chart.png": "chart-bytes",
    }))

    const markdown = await __mineruTest.downloadAndExtractMarkdown(
      "https://cdn/result.zip",
      undefined,
      { projectPath: "/project", sourceSummarySlug: "paper" },
    )

    expect(markdown).toContain("| ![Chart](media/paper/mineru/images/chart.png) | A |")
  })

  it("extracts MinerU zip images and rewrites Markdown image references", async () => {
    mockHttpFetch.mockResolvedValueOnce(await zipResponse({
      "full.md": [
        "# Parsed",
        "![Chart](images/chart.png)",
        "<img src=\"figures/table 1.jpg\" alt=\"Table\">",
        "![Remote](https://example.test/x.png)",
      ].join("\n"),
      "images/chart.png": "chart-bytes",
      "figures/table 1.jpg": "table-bytes",
    }))

    const markdown = await __mineruTest.downloadAndExtractMarkdown(
      "https://cdn/result.zip",
      undefined,
      { projectPath: "/project", sourceSummarySlug: "paper" },
    )

    expect(fsMocks.createDirectory).toHaveBeenCalledWith("/project/wiki/media/paper/mineru")
    expect(fsMocks.writeFileBase64).toHaveBeenCalledWith(
      "/project/wiki/media/paper/mineru/images/chart.png",
      btoa("chart-bytes"),
    )
    expect(fsMocks.writeFileBase64).toHaveBeenCalledWith(
      "/project/wiki/media/paper/mineru/figures/table 1.jpg",
      btoa("table-bytes"),
    )
    expect(markdown).toContain("![Chart](media/paper/mineru/images/chart.png)")
    expect(markdown).toContain("![Table](media/paper/mineru/figures/table%201.jpg)")
    expect(markdown).toContain("![Remote](https://example.test/x.png)")
  })

  it("returns SavedImage metadata for MinerU zip images", async () => {
    mockHttpFetch.mockResolvedValueOnce(await zipResponse({
      "full.md": "![Chart](images/chart.png)",
      "images/chart.png": "chart-bytes",
    }))

    const result = await __mineruTest.downloadAndExtractMarkdownResult(
      "https://cdn/result.zip",
      undefined,
      { projectPath: "/project", sourceSummarySlug: "paper" },
    )

    expect(result.markdown).toBe("![Chart](media/paper/mineru/images/chart.png)")
    expect(result.savedImages).toHaveLength(1)
    expect(result.savedImages[0]).toMatchObject({
      index: 1,
      mimeType: "image/png",
      page: null,
      width: 0,
      height: 0,
      relPath: "media/paper/mineru/images/chart.png",
      absPath: "/project/wiki/media/paper/mineru/images/chart.png",
    })
    expect(result.savedImages[0].sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it("rewrites Markdown image paths containing spaces", async () => {
    mockHttpFetch.mockResolvedValueOnce(await zipResponse({
      "full.md": "![Wide chart](images/wide chart.png)",
      "images/wide chart.png": "chart-bytes",
    }))

    const markdown = await __mineruTest.downloadAndExtractMarkdown(
      "https://cdn/result.zip",
      undefined,
      { projectPath: "/project", sourceSummarySlug: "paper" },
    )

    expect(markdown).toBe("![Wide chart](media/paper/mineru/images/wide%20chart.png)")
  })

  it("rewrites image filenames containing parentheses into balanced encoded links", async () => {
    mockHttpFetch.mockResolvedValueOnce(await zipResponse({
      "full.md": "![Chart](images/chart(1).png)",
      "images/chart(1).png": "chart-bytes",
    }))

    const markdown = await __mineruTest.downloadAndExtractMarkdown(
      "https://cdn/result.zip",
      undefined,
      { projectPath: "/project", sourceSummarySlug: "paper" },
    )

    expect(markdown).toBe("![Chart](media/paper/mineru/images/chart%281%29.png)")
  })

  it("writes large extracted images with exact base64 content", async () => {
    const bytes = "x".repeat(40_000)
    mockHttpFetch.mockResolvedValueOnce(await zipResponse({
      "full.md": "![Large](images/large.png)",
      "images/large.png": bytes,
    }))

    await __mineruTest.downloadAndExtractMarkdown(
      "https://cdn/result.zip",
      undefined,
      { projectPath: "/project", sourceSummarySlug: "paper" },
    )

    expect(fsMocks.writeFileBase64).toHaveBeenCalledWith(
      "/project/wiki/media/paper/mineru/images/large.png",
      btoa(bytes),
    )
  })

  it("rewrites image links by basename when MinerU Markdown omits image directories", async () => {
    mockHttpFetch.mockResolvedValueOnce(await zipResponse({
      "result/full.md": "![Chart](chart.png)",
      "result/images/chart.png": "chart-bytes",
    }))

    const markdown = await __mineruTest.downloadAndExtractMarkdown(
      "https://cdn/result.zip",
      undefined,
      { projectPath: "/project", sourceSummarySlug: "paper" },
    )

    expect(markdown).toBe("![Chart](media/paper/mineru/result/images/chart.png)")
  })

  it("keeps extracted zip paths inside the MinerU media directory", async () => {
    mockHttpFetch.mockResolvedValueOnce(await zipResponse({
      "full.md": "![Evil](evil.png)",
      "../../evil.png": "evil-bytes",
    }))

    const markdown = await __mineruTest.downloadAndExtractMarkdown(
      "https://cdn/result.zip",
      undefined,
      { projectPath: "/project", sourceSummarySlug: "paper" },
    )

    expect(fsMocks.writeFileBase64).toHaveBeenCalledWith(
      "/project/wiki/media/paper/mineru/evil.png",
      btoa("evil-bytes"),
    )
    expect(markdown).toBe("![Evil](media/paper/mineru/evil.png)")
  })

  it("does not use basename fallback when zip image basenames collide", async () => {
    mockHttpFetch.mockResolvedValueOnce(await zipResponse({
      "full.md": "![Ambiguous](chart.png)\n![A](a/chart.png)",
      "a/chart.png": "a-bytes",
      "b/chart.png": "b-bytes",
    }))

    const markdown = await __mineruTest.downloadAndExtractMarkdown(
      "https://cdn/result.zip",
      undefined,
      { projectPath: "/project", sourceSummarySlug: "paper" },
    )

    expect(markdown).toContain("![Ambiguous](chart.png)")
    expect(markdown).toContain("![A](media/paper/mineru/a/chart.png)")
  })

  it("keeps parsed Markdown when extracted image saving fails", async () => {
    fsMocks.writeFileBase64.mockRejectedValueOnce(new Error("disk full"))
    mockHttpFetch.mockResolvedValueOnce(await zipResponse({
      "full.md": "![Chart](images/chart.png)\nBody",
      "images/chart.png": "chart-bytes",
    }))

    await expect(__mineruTest.downloadAndExtractMarkdown(
      "https://cdn/result.zip",
      undefined,
      { projectPath: "/project", sourceSummarySlug: "paper" },
    )).resolves.toBe("![Chart](images/chart.png)\nBody")
  })

  it("leaves external HTML image tags untouched", async () => {
    mockHttpFetch.mockResolvedValueOnce(await zipResponse({
      "full.md": "<img src=\"https://example.test/x.png\" alt=\"Remote\">",
      "images/local.png": "local-bytes",
    }))

    const markdown = await __mineruTest.downloadAndExtractMarkdown(
      "https://cdn/result.zip",
      undefined,
      { projectPath: "/project", sourceSummarySlug: "paper" },
    )

    expect(markdown).toBe("<img src=\"https://example.test/x.png\" alt=\"Remote\">")
  })
})

describe("parseWithMineru", () => {
  it("submits a Windows-path PDF and pipeline mode to a custom local endpoint", async () => {
    mockHttpFetch
      .mockResolvedValueOnce(jsonResponse({
        task_id: "task/1",
        status_url: "http://localhost:9000/custom/tasks/task%2F1",
        result_url: "http://localhost:9000/custom/tasks/task%2F1/result",
      }, { status: 202 }))
      .mockResolvedValueOnce(jsonResponse({ status: "completed" }))
      .mockResolvedValueOnce(jsonResponse({
        results: { report: { md_content: "# Parsed locally" } },
      }))

    await expect(parseWithMineru({
      enabled: true,
      backend: "local",
      localEndpoint: "http://localhost:9000/custom/",
      localToken: "local-secret",
      localBackend: "pipeline",
      token: "",
      modelVersion: "pipeline",
    }, "C:\\documents\\report.pdf")).resolves.toBe("# Parsed locally")

    const form = mockHttpFetch.mock.calls[0]?.[1]?.body as FormData
    expect(form.get("files")).toBeInstanceOf(Blob)
    expect(form.get("backend")).toBe("pipeline")
    expect(form.get("return_md")).toBe("true")
    expect(mockHttpFetch.mock.calls[0]?.[0]).toBe("http://localhost:9000/custom/tasks")
    expect(mockHttpFetch.mock.calls[1]?.[0]).toContain("/tasks/task%2F1")
    expect(mockHttpFetch.mock.calls[2]?.[0]).toContain("/tasks/task%2F1/result")
    for (const call of mockHttpFetch.mock.calls) {
      expect(call[1]?.headers).toEqual({ Authorization: "Bearer local-secret" })
      expect(call[1]).toMatchObject({ redirect: "manual", maxRedirections: 0 })
    }
  })

  it.each([
    ["2.1.11", "hybrid-engine"],
    ["3.1.15", "hybrid-auto-engine"],
    ["3.4.4", "hybrid-engine"],
  ])("submits the backend name supported by MinerU %s", async (version, expectedBackend) => {
    mockHttpFetch
      .mockResolvedValueOnce(jsonResponse({ status: "healthy", version }))
      .mockResolvedValueOnce(jsonResponse({ task_id: "task-1" }, { status: 202 }))
      .mockResolvedValueOnce(jsonResponse({ status: "completed" }))
      .mockResolvedValueOnce(jsonResponse({
        results: { report: { md_content: "# Parsed locally" } },
      }))

    await expect(parseWithMineru({
      enabled: true,
      backend: "local",
      localBackend: "hybrid-engine",
      token: "",
      modelVersion: "vlm",
    }, "/tmp/report.pdf")).resolves.toBe("# Parsed locally")

    const form = mockHttpFetch.mock.calls[1]?.[1]?.body as FormData
    expect(form.get("backend")).toBe(expectedBackend)
  })

  it("rejects oversized local-backend files before reading or uploading", async () => {
    fsMocks.getFileSize.mockResolvedValueOnce(__mineruTest.MAX_ACCURATE_PARSE_BYTES + 1)

    await expect(parseWithMineru({
      enabled: true,
      backend: "local",
      token: "",
      modelVersion: "vlm",
    }, "/tmp/large.pdf")).rejects.toThrow("200 MB")

    expect(fsMocks.readFileAsBase64).not.toHaveBeenCalled()
    expect(mockHttpFetch).not.toHaveBeenCalled()
  })

  it("rejects an empty local-backend result instead of caching it as success", async () => {
    mockHttpFetch
      .mockResolvedValueOnce(jsonResponse({ status: "healthy", version: "3.1.15" }))
      .mockResolvedValueOnce(jsonResponse({ task_id: "task-1" }, { status: 202 }))
      .mockResolvedValueOnce(jsonResponse({ status: "completed" }))
      .mockResolvedValueOnce(jsonResponse({ results: { doc: { md_content: "  " } } }))

    await expect(parseWithMineru({
      enabled: true,
      backend: "local",
      token: "",
      modelVersion: "vlm",
    }, "/tmp/doc.pdf")).rejects.toThrow("empty parsing result")
  })

  it("saves and rewrites images returned by the official local API", async () => {
    mockHttpFetch
      .mockResolvedValueOnce(jsonResponse({ status: "healthy", version: "3.1.15" }))
      .mockResolvedValueOnce(jsonResponse({ task_id: "task-1" }, { status: 202 }))
      .mockResolvedValueOnce(jsonResponse({ status: "completed" }))
      .mockResolvedValueOnce(jsonResponse({
        results: {
          doc: {
            md_content: "![Chart](images/chart.png)",
            images: { "chart.png": `data:image/png;base64,${btoa("image bytes")}` },
          },
        },
      }))

    const result = await parseWithMineruResult({
      enabled: true,
      backend: "local",
      token: "",
      modelVersion: "vlm",
      localBackend: "hybrid-engine",
    }, "/tmp/doc.pdf", undefined, undefined, undefined, {
      projectPath: "/project",
      sourceSummarySlug: "doc",
    })

    expect(result.markdown).toBe("![Chart](media/doc/mineru/images/image-1.png)")
    expect(result.savedImages[0]?.relPath).toBe("media/doc/mineru/images/image-1.png")
    expect(fsMocks.writeFileBase64).toHaveBeenCalledWith(
      "/project/wiki/media/doc/mineru/images/image-1.png",
      btoa("image bytes"),
    )
    const form = mockHttpFetch.mock.calls[1]?.[1]?.body as FormData
    expect(form.get("return_images")).toBe("true")
  })

  it("uses the data URI MIME type when the MinerU filename extension disagrees", async () => {
    mockHttpFetch
      .mockResolvedValueOnce(jsonResponse({ status: "healthy", version: "3.1.15" }))
      .mockResolvedValueOnce(jsonResponse({ task_id: "task-1" }, { status: 202 }))
      .mockResolvedValueOnce(jsonResponse({ status: "completed" }))
      .mockResolvedValueOnce(jsonResponse({
        results: {
          doc: {
            md_content: "![Chart](images/chart.jpg)",
            images: { "chart.jpg": `data:image/png;base64,${btoa("png bytes")}` },
          },
        },
      }))

    const result = await parseWithMineruResult({
      enabled: true,
      backend: "local",
      token: "",
      modelVersion: "vlm",
      localBackend: "hybrid-engine",
    }, "/tmp/doc.pdf", undefined, undefined, undefined, {
      projectPath: "/project",
      sourceSummarySlug: "doc",
    })

    expect(result.markdown).toBe("![Chart](media/doc/mineru/images/image-1.png)")
    expect(result.savedImages[0]?.mimeType).toBe("image/png")
    expect(result.savedImages[0]?.relPath).toBe("media/doc/mineru/images/image-1.png")
  })

  it("requires a model server URL for official HTTP-client backends", async () => {
    await expect(parseWithMineru({
      enabled: true,
      backend: "local",
      token: "",
      modelVersion: "vlm",
      localBackend: "vlm-http-client",
      localServerUrl: "",
    }, "/tmp/doc.pdf")).rejects.toThrow("require a model server URL")

    expect(mockHttpFetch).not.toHaveBeenCalled()
  })

  it("rejects malformed or credential-bearing local endpoints before upload", async () => {
    await expect(parseWithMineru({
      enabled: true,
      backend: "local",
      localEndpoint: "file:///tmp/mineru",
      token: "",
      modelVersion: "pipeline",
    }, "/tmp/doc.pdf")).rejects.toThrow("HTTP(S)")

    await expect(testMineruConnection("", {
      backend: "local",
      localEndpoint: "http://user:pass@localhost:8000",
    })).rejects.toThrow("without credentials")
    expect(mockHttpFetch).not.toHaveBeenCalled()
  })

  it("rejects unsupported MinerU model versions before reading or uploading", async () => {
    await expect(parseWithMineru({
      enabled: true,
      token: "token",
      modelVersion: "mineru-html" as "vlm",
    }, "/tmp/doc.pdf")).rejects.toThrow("pipeline or vlm")

    expect(fsMocks.getFileSize).not.toHaveBeenCalled()
    expect(mockHttpFetch).not.toHaveBeenCalled()
  })

  it("rejects local files over MinerU's 200 MB accurate parsing limit before upload", async () => {
    fsMocks.getFileSize.mockResolvedValue(__mineruTest.MAX_ACCURATE_PARSE_BYTES + 1)

    await expect(parseWithMineru({
      enabled: true,
      token: "token",
      modelVersion: "vlm",
    }, "/tmp/large.pdf")).rejects.toThrow("200 MB")

    expect(mockHttpFetch).not.toHaveBeenCalled()
    expect(fsMocks.readFileAsBase64).not.toHaveBeenCalled()
  })

  it("rejects before network access when the abort signal is already cancelled", async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(parseWithMineru({
      enabled: true,
      token: "token",
      modelVersion: "vlm",
    }, "/tmp/doc.pdf", undefined, undefined, controller.signal)).rejects.toThrow("cancelled")

    expect(mockHttpFetch).not.toHaveBeenCalled()
  })

  it("rejects batch upload responses without an upload URL", async () => {
    mockHttpFetch.mockResolvedValueOnce(jsonResponse({
      code: 0,
      msg: "ok",
      data: { batch_id: "batch-1", file_urls: [] },
    }))

    await expect(parseWithMineru({
      enabled: true,
      token: "token",
      modelVersion: "vlm",
    }, "/tmp/doc.pdf")).rejects.toThrow("upload URL")
  })

  it("uploads the decoded PDF bytes to the MinerU upload URL", async () => {
    fsMocks.readFileAsBase64.mockResolvedValueOnce({
      base64: btoa("custom pdf bytes"),
      mimeType: "application/pdf",
    })
    mockHttpFetch
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        msg: "ok",
        data: { batch_id: "batch-1", file_urls: ["https://upload"] },
      }))
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        msg: "ok",
        data: {
          batch_id: "batch-1",
          extract_result: [{ file_name: "doc.pdf", state: "done", full_zip_url: "https://zip" }],
        },
      }))
      .mockResolvedValueOnce(await zipResponse({ "full.md": "parsed markdown" }))

    await expect(parseWithMineru({
      enabled: true,
      token: "token",
      modelVersion: "vlm",
    }, "/tmp/doc.pdf")).resolves.toBe("parsed markdown")

    const uploadBody = mockHttpFetch.mock.calls[1]?.[1]?.body
    expect(uploadBody).toBeInstanceOf(ArrayBuffer)
    expect(new TextDecoder().decode(uploadBody as ArrayBuffer)).toBe("custom pdf bytes")
  })

  it("passes asset options through local MinerU parsing so images can be saved", async () => {
    mockHttpFetch
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        msg: "ok",
        data: { batch_id: "batch-1", file_urls: ["https://upload"] },
      }))
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        msg: "ok",
        data: {
          batch_id: "batch-1",
          extract_result: [{ file_name: "doc.pdf", state: "done", full_zip_url: "https://zip" }],
        },
      }))
      .mockResolvedValueOnce(await zipResponse({
        "full.md": "![Chart](images/chart.png)",
        "images/chart.png": "chart-bytes",
      }))

    await expect(parseWithMineru({
      enabled: true,
      token: "token",
      modelVersion: "vlm",
    }, "/tmp/doc.pdf", undefined, undefined, undefined, {
      projectPath: "/project",
      sourceSummarySlug: "doc",
    })).resolves.toBe("![Chart](media/doc/mineru/images/chart.png)")

    expect(fsMocks.writeFileBase64).toHaveBeenCalledWith(
      "/project/wiki/media/doc/mineru/images/chart.png",
      btoa("chart-bytes"),
    )
  })

  it("returns saved MinerU images from local parsing result", async () => {
    mockHttpFetch
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        msg: "ok",
        data: { batch_id: "batch-1", file_urls: ["https://upload"] },
      }))
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        msg: "ok",
        data: {
          batch_id: "batch-1",
          extract_result: [{ file_name: "doc.pdf", state: "done", full_zip_url: "https://zip" }],
        },
      }))
      .mockResolvedValueOnce(await zipResponse({
        "full.md": "![Chart](images/chart.png)",
        "images/chart.png": "chart-bytes",
      }))

    const result = await parseWithMineruResult({
      enabled: true,
      token: "token",
      modelVersion: "vlm",
    }, "/tmp/doc.pdf", undefined, undefined, undefined, {
      projectPath: "/project",
      sourceSummarySlug: "doc",
    })

    expect(result.markdown).toBe("![Chart](media/doc/mineru/images/chart.png)")
    expect(result.savedImages.map((image) => image.relPath)).toEqual([
      "media/doc/mineru/images/chart.png",
    ])
  })

  it("submits URL tasks without reading or uploading a local file", async () => {
    mockHttpFetch
      .mockResolvedValueOnce(jsonResponse({
        code: "0",
        msg: "ok",
        data: { task_id: "task-1" },
      }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        msg: "ok",
        data: { task_id: "task-1", state: "done", full_zip_url: "https://zip" },
      }))
      .mockResolvedValueOnce(await zipResponse({ "full.md": "url markdown" }))

    await expect(parseWithMineru({
      enabled: true,
      token: "token",
      modelVersion: "pipeline",
    }, "/tmp/doc.pdf", "https://example.test/doc.pdf")).resolves.toBe("url markdown")

    expect(fsMocks.getFileSize).not.toHaveBeenCalled()
    expect(fsMocks.readFileAsBase64).not.toHaveBeenCalled()
    expect(JSON.parse(String(mockHttpFetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      url: "https://example.test/doc.pdf",
      model_version: "pipeline",
    })
  })

  it("rejects MinerU failed states with the service error message", async () => {
    mockHttpFetch
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        msg: "ok",
        data: { batch_id: "batch-1", file_urls: ["https://upload"] },
      }))
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        msg: "ok",
        data: {
          batch_id: "batch-1",
          extract_result: [{ file_name: "doc.pdf", state: "failed", err_msg: "parse exploded" }],
        },
      }))

    await expect(parseWithMineru({
      enabled: true,
      token: "token",
      modelVersion: "vlm",
    }, "/tmp/doc.pdf")).rejects.toThrow("parse exploded")
  })

  it("stops polling immediately when the abort signal fires during the poll interval", async () => {
    mockHttpFetch
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        msg: "ok",
        data: { batch_id: "batch-1", file_urls: ["https://upload"] },
      }))
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        msg: "ok",
        data: { batch_id: "batch-1", extract_result: [{ file_name: "doc.pdf", state: "running" }] },
      }))

    const controller = new AbortController()
    const result = parseWithMineru({
      enabled: true,
      token: "token",
      modelVersion: "vlm",
    }, "/tmp/doc.pdf", undefined, undefined, controller.signal)

    setTimeout(() => controller.abort(), 10)

    await expect(result).rejects.toThrow("cancelled")
    expect(mockHttpFetch).toHaveBeenCalledTimes(3)
  })

  it("handles official pending, waiting-file, converting, and running states before completion", async () => {
    mockHttpFetch
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        msg: "ok",
        data: { batch_id: "batch-1", file_urls: ["https://upload"] },
      }))
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        msg: "ok",
        data: { batch_id: "batch-1", extract_result: [{ file_name: "doc.pdf", state: "pending" }] },
      }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        msg: "ok",
        data: { batch_id: "batch-1", extract_result: [{ file_name: "doc.pdf", state: "waiting-file" }] },
      }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        msg: "ok",
        data: { batch_id: "batch-1", extract_result: [{ file_name: "doc.pdf", state: "converting" }] },
      }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        msg: "ok",
        data: { batch_id: "batch-1", extract_result: [{ file_name: "doc.pdf", state: "running" }] },
      }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        msg: "ok",
        data: {
          batch_id: "batch-1",
          extract_result: [{ file_name: "doc.pdf", state: "done", full_zip_url: "https://zip" }],
        },
      }))
      .mockResolvedValueOnce(await zipResponse({ "full.md": "parsed markdown" }))

    const progress: string[] = []
    await expect(parseWithMineru({
      enabled: true,
      token: "token",
      modelVersion: "vlm",
    }, "/tmp/doc.pdf", undefined, (msg) => progress.push(msg))).resolves.toBe("parsed markdown")

    expect(progress).toContain("Waiting for MinerU to finish...")
    expect(mockHttpFetch).toHaveBeenCalledTimes(8)
  }, 16_000)
})

describe("testMineruConnection", () => {
  it("checks local health without requiring a cloud token", async () => {
    mockHttpFetch.mockResolvedValueOnce(jsonResponse({ status: "healthy" }))

    await expect(testMineruConnection("", {
      backend: "local",
      localToken: "health-secret",
    })).resolves.toBeUndefined()
    expect(mockHttpFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8000/health",
      expect.objectContaining({
        headers: { Authorization: "Bearer health-secret" },
        redirect: "manual",
        maxRedirections: 0,
      }),
    )
  })

  it("accepts a configured endpoint that already ends in /v1", async () => {
    __mineruTest.clearLocalProtocolCache()
    mockHttpFetch
      .mockResolvedValueOnce(jsonResponse({ status: "ok", version: "4.0.10" }))
      .mockResolvedValueOnce(jsonResponse({ status: "ok", version: "4.0.10" }))

    await expect(testMineruConnection("", {
      backend: "local",
      localEndpoint: "http://127.0.0.1:8000/v1/",
    })).resolves.toBeUndefined()
    // detect probe + connection verify, both normalized — never /v1/v1/health.
    expect(mockHttpFetch.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:8000/v1/health",
      "http://127.0.0.1:8000/v1/health",
    ])
  })

  it("rejects a 200 response that is not a healthy official MinerU service", async () => {
    mockHttpFetch.mockResolvedValueOnce(jsonResponse({ status: "unhealthy" }))

    await expect(testMineruConnection("", { backend: "local" })).rejects.toThrow(
      "invalid or unhealthy",
    )
  })

  it("resolves when MinerU accepts the connection test task", async () => {
    mockHttpFetch.mockResolvedValueOnce(jsonResponse({
      code: "0",
      msg: "ok",
      data: { task_id: "task-1" },
    }))

    await expect(testMineruConnection("token")).resolves.toBeUndefined()
  })

  it("includes HTTP status and response body when connection test transport fails", async () => {
    mockHttpFetch.mockResolvedValueOnce(new Response("bad gateway", { status: 502 }))

    await expect(testMineruConnection("token")).rejects.toThrow("HTTP 502: bad gateway")
  })

  it("maps MinerU API errors during connection test", async () => {
    mockHttpFetch.mockResolvedValueOnce(jsonResponse({
      code: "A0202",
      msg: "token invalid",
      data: {},
    }))

    await expect(testMineruConnection("bad-token")).rejects.toThrow("invalid")
  })
})

describe("cloud page-range segmentation", () => {
  const cloudConfig = {
    enabled: true,
    backend: "cloud" as const,
    token: "cloud-token",
    modelVersion: "vlm" as const,
  }

  it("splitPageRanges splits totals into per-task page windows", () => {
    // Segments are capped at 100 pages — half the API's 200-page ceiling —
    // so peak-hour queueing cannot outgrow a segment's polling window.
    expect(splitPageRanges(100)).toEqual(["1-100"])
    expect(splitPageRanges(101)).toEqual(["1-100", "101-101"])
    expect(splitPageRanges(202)).toEqual(["1-100", "101-200", "201-202"])
    expect(splitPageRanges(402)).toEqual(["1-100", "101-200", "201-300", "301-400", "401-402"])
    expect(splitPageRanges(0)).toEqual([])
    expect(splitPageRanges(-5)).toEqual([])
    expect(Number.isNaN(splitPageRanges(Number.NaN).length)).toBe(false)
  })

  it("submits one segmented task per page window and joins the markdown", async () => {
    fsMocks.getPdfPageCount.mockResolvedValue(202)
    mockHttpFetch
      // segment 1: batch submit → upload → poll → zip
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        data: { batch_id: "batch-1", file_urls: ["https://upload/1"] },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        data: { extract_result: [{ state: "done", full_zip_url: "https://zip/1" }] },
      }))
      .mockResolvedValueOnce(await zipResponse({ "full.md": "# Segment 1" }))
      // segment 2
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        data: { batch_id: "batch-2", file_urls: ["https://upload/2"] },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        data: { extract_result: [{ state: "done", full_zip_url: "https://zip/2" }] },
      }))
      .mockResolvedValueOnce(await zipResponse({ "full.md": "# Segment 2" }))
      // segment 3
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        data: { batch_id: "batch-3", file_urls: ["https://upload/3"] },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        data: { extract_result: [{ state: "done", full_zip_url: "https://zip/3" }] },
      }))
      .mockResolvedValueOnce(await zipResponse({ "full.md": "# Segment 3" }))

    await expect(parseWithMineru(cloudConfig, "/docs/big.pdf"))
      .resolves.toBe("# Segment 1\n\n# Segment 2\n\n# Segment 3")

    const submitBodies = mockHttpFetch.mock.calls
      .filter((call) => String(call[0]).endsWith("/file-urls/batch"))
      .map((call) => JSON.parse(String(call[1]?.body)))
    expect(submitBodies).toHaveLength(3)
    expect(submitBodies.map((body: { files: Array<{ page_ranges?: string }> }) => body.files[0].page_ranges))
      .toEqual(["1-100", "101-200", "201-202"])
  })

  it("keeps single-task flow with no page_ranges when within the limit", async () => {
    fsMocks.getPdfPageCount.mockResolvedValue(100)
    mockHttpFetch
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        data: { batch_id: "batch-1", file_urls: ["https://upload/1"] },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        data: { extract_result: [{ state: "done", full_zip_url: "https://zip/1" }] },
      }))
      .mockResolvedValueOnce(await zipResponse({ "full.md": "# Whole document" }))

    await expect(parseWithMineru(cloudConfig, "/docs/ok.pdf"))
      .resolves.toBe("# Whole document")

    const submit = mockHttpFetch.mock.calls
      .filter((call) => String(call[0]).endsWith("/file-urls/batch"))
      .map((call) => JSON.parse(String(call[1]?.body)))[0]
    expect(submit.files[0].page_ranges).toBeUndefined()
  })

  it("isolates segment images into per-segment media directories", async () => {
    fsMocks.getPdfPageCount.mockResolvedValue(150)
    const zipOne = await zipResponse({
      "full.md": "![img](images/1.jpg)",
      "images/1.jpg": "seg1-bytes",
    })
    const zipTwo = await zipResponse({
      "full.md": "![img](images/1.jpg)",
      "images/1.jpg": "seg2-bytes",
    })
    mockHttpFetch
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        data: { batch_id: "batch-1", file_urls: ["https://upload/1"] },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        data: { extract_result: [{ state: "done", full_zip_url: "https://zip/1" }] },
      }))
      .mockResolvedValueOnce(zipOne)
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        data: { batch_id: "batch-2", file_urls: ["https://upload/2"] },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        data: { extract_result: [{ state: "done", full_zip_url: "https://zip/2" }] },
      }))
      .mockResolvedValueOnce(zipTwo)

    const result = await parseWithMineruResult(cloudConfig, "/docs/scan.pdf", undefined, undefined, undefined, {
      projectPath: "/proj",
      sourceSummarySlug: "slug",
    })

    expect(result.markdown).toContain("media/slug/mineru/seg-1/images/1.jpg")
    expect(result.markdown).toContain("media/slug/mineru/seg-2/images/1.jpg")
    expect(result.savedImages).toHaveLength(2)
    const writtenPaths = fsMocks.writeFileBase64.mock.calls.map((call) => String(call[0]))
    expect(writtenPaths).toContain("/proj/wiki/media/slug/mineru/seg-1/images/1.jpg")
    expect(writtenPaths).toContain("/proj/wiki/media/slug/mineru/seg-2/images/1.jpg")
  })

  it("falls back to the single-task path when the page count cannot be read", async () => {
    fsMocks.getPdfPageCount.mockRejectedValue(new Error("PDF is password-protected"))
    mockHttpFetch
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        data: { batch_id: "batch-1", file_urls: ["https://upload/1"] },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        data: { extract_result: [{ state: "done", full_zip_url: "https://zip/1" }] },
      }))
      .mockResolvedValueOnce(await zipResponse({ "full.md": "# Passthrough" }))

    await expect(parseWithMineru(cloudConfig, "/docs/locked.pdf"))
      .resolves.toBe("# Passthrough")
  })
})

describe("cloud data_id cap (-10002 fix)", () => {
  it("submits a short content-hash data_id and capped display name", async () => {
    const longName = "6-3 华兴会计师事务所关于上海证券交易所《关于国旅文化投资集团股份有限公司发行股份及支付现金购买资产并募集配套资金暨关联交易申请的审核问询函》回复之核查意见.pdf"
    mockHttpFetch
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        msg: "ok",
        data: { batch_id: "batch-1", file_urls: ["https://upload"] },
      }))
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        msg: "ok",
        data: { batch_id: "batch-1", extract_result: [{ state: "done", full_zip_url: "https://zip" }] },
      }))
      .mockResolvedValueOnce(await zipResponse({ "full.md": "md" }))

    await expect(parseWithMineru({
      enabled: true,
      token: "token",
      modelVersion: "vlm",
    }, `/docs/${longName}`)).resolves.toBe("md")

    const submit = mockHttpFetch.mock.calls
      .filter((call) => String(call[0]).endsWith("/file-urls/batch"))
      .map((call) => JSON.parse(String(call[1]?.body)))[0]
    const entry = submit.files[0]
    expect(entry.data_id).toMatch(/^wiki-[0-9a-f]{24}\.pdf$/)
    expect(entry.data_id.length).toBeLessThanOrEqual(128)
    expect(entry.name.length).toBeLessThanOrEqual(120)
  })
})

describe("classifyMineruFailure", () => {
  it("treats credential, quota, and validation rejections as permanent", () => {
    expect(classifyMineruFailure(new Error("MinerU token is invalid. Check the API token in Settings."))).toBe("permanent")
    expect(classifyMineruFailure(new Error("MinerU token has expired. Create a new API token and update Settings."))).toBe("permanent")
    expect(classifyMineruFailure(new Error("MinerU daily parsing quota has been reached."))).toBe("permanent")
    expect(classifyMineruFailure(new Error("MinerU API error -10002: field \"files.data_id\" cannot exceed 128 characters"))).toBe("permanent")
    expect(classifyMineruFailure(new Error("MinerU rejected the file because it is larger than 200 MB."))).toBe("permanent")
    expect(classifyMineruFailure(new Error("MinerU API token not configured"))).toBe("permanent")
  })

  it("treats timeouts, 5xx, and network errors as transient", () => {
    expect(classifyMineruFailure(new Error("MinerU parsing timed out after 5 minutes"))).toBe("transient")
    expect(classifyMineruFailure(new Error("MinerU poll failed: HTTP 502"))).toBe("transient")
    expect(classifyMineruFailure(new Error("MinerU poll failed: HTTP 429"))).toBe("transient")
    expect(classifyMineruFailure(new Error("error sending request for url (https://mineru.net/)"))).toBe("transient")
  })
})

describe("local V1 protocol (mineru-kit api-server)", () => {
  const v1Config = {
    enabled: true,
    backend: "local" as const,
    localEndpoint: "http://192.168.0.175:8000",
    localToken: "",
    localTier: "standard" as const,
    token: "",
    modelVersion: "vlm" as const,
  }

  it("detects the V1 flavor via /v1/health", async () => {
    __mineruTest.clearLocalProtocolCache()
    mockHttpFetch.mockResolvedValueOnce(jsonResponse({ status: "ok", version: "4.0.11" }))
    await expect(detectLocalMineruProtocol(v1Config)).resolves.toBe("v1")
    expect(String(mockHttpFetch.mock.calls[0]?.[0])).toBe("http://192.168.0.175:8000/v1/health")
  })

  it("falls back to the tasks flavor when /v1/health is absent", async () => {
    __mineruTest.clearLocalProtocolCache()
    mockHttpFetch.mockResolvedValueOnce(new Response("not found", { status: 404 }))
    await expect(detectLocalMineruProtocol(v1Config)).resolves.toBe("tasks")
  })

  it("uploads, polls, and downloads the self-contained zip artifact", async () => {
    __mineruTest.primeLocalProtocolCache(v1Config.localEndpoint, "v1")
    mockHttpFetch
      // health probe
      .mockResolvedValueOnce(jsonResponse({ status: "ok", version: "4.0.11" }))
      // upload init → full upload flow
      .mockResolvedValueOnce(jsonResponse({
        id: "upload-1",
        upload_url: "/v1/uploads/upload-1/content",
        upload_headers: {},
        status: "pending",
      }))
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({ status: "completed", file: { id: "file-9" } }))
      // job create
      .mockResolvedValueOnce(jsonResponse({ job_id: "job-1", status: "queued" }))
      // first poll: running; second poll: completed with zip + markdown refs
      .mockResolvedValueOnce(jsonResponse({ job_id: "job-1", status: "running" }))
      .mockResolvedValueOnce(jsonResponse({
        job_id: "job-1",
        status: "completed",
        files: [{
          status: "completed",
          output_files: {
            markdown: { file_id: "md-file" },
            zip: { file_id: "zip-file" },
          },
        }],
      }))
      // zip download
      .mockResolvedValueOnce(await zipResponse({ "full.md": "# V1 result", "images/1.jpg": "bytes" }))

    const result = await parseWithMineruResult(v1Config, "/docs/scan.pdf", undefined, undefined, undefined, {
      projectPath: "/proj",
      sourceSummarySlug: "slug",
    })

    expect(result.markdown).toContain("# V1 result")
    expect(result.savedImages).toHaveLength(1)
    expect(result.protocol).toBe("v1")

    const jobCreate = mockHttpFetch.mock.calls
      .filter((call) => String(call[0]).endsWith("/v1/parse/jobs"))
      .map((call) => JSON.parse(String(call[1]?.body)))[0]
    expect(jobCreate.tier).toBe("standard")
    expect(jobCreate.output_formats).toContain("zip")
    expect(jobCreate.files[0].source).toEqual({ type: "file_id", file_id: "file-9" })
  })

  it("does not leak the local API token to a cross-origin upload URL", async () => {
    __mineruTest.primeLocalProtocolCache(v1Config.localEndpoint, "v1")
    mockHttpFetch
      // health verify inside parseWithLocalMineruV1
      .mockResolvedValueOnce(jsonResponse({ status: "ok", version: "4.0.11" }))
      // upload init → pending with a FOREIGN upload_url
      .mockResolvedValueOnce(jsonResponse({
        id: "upload-x",
        upload_url: "https://objects.example/upload-x",
        upload_headers: { "X-Upload-Token": "signed" },
        status: "pending",
      }))
      // byte PUT to the foreign origin
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({ status: "completed", file: { id: "file-x" } }))
      .mockResolvedValueOnce(jsonResponse({ job_id: "job-x", status: "queued" }))
      .mockResolvedValueOnce(jsonResponse({
        job_id: "job-x",
        status: "completed",
        files: [{ status: "completed", output_files: { zip: { file_id: "zip-x" } } }],
      }))
      .mockResolvedValueOnce(await zipResponse({ "full.md": "# V1 result" }))

    const result = await parseWithMineru(
      { ...v1Config, localToken: "local-secret" },
      "/docs/scan.pdf",
    )
    expect(result).toBe("# V1 result")

    // The foreign PUT carries only the server-signed headers — no token.
    const put = mockHttpFetch.mock.calls.find((call) => call[1]?.method === "PUT")
    expect(put?.[0]).toBe("https://objects.example/upload-x")
    expect(put?.[1]?.headers).toEqual({ "X-Upload-Token": "signed" })
    // Same-origin calls keep the bearer token.
    for (const call of mockHttpFetch.mock.calls.filter((c) => String(c[0]).endsWith("/v1/health"))) {
      expect(call[1]?.headers).toEqual({ Authorization: "Bearer local-secret" })
    }
  })

  it("honors the sha256 dedupe hit without uploading bytes", async () => {
    __mineruTest.primeLocalProtocolCache(v1Config.localEndpoint, "v1")
    mockHttpFetch
      .mockResolvedValueOnce(jsonResponse({ status: "ok", version: "4.0.11" }))
      .mockResolvedValueOnce(jsonResponse({ status: "completed", file: { id: "file-dedup" } }))
      .mockResolvedValueOnce(jsonResponse({ job_id: "job-2", status: "queued" }))
      .mockResolvedValueOnce(jsonResponse({
        job_id: "job-2",
        status: "completed",
        files: [{ status: "completed", output_files: { markdown: { file_id: "md-only" } } }],
      }))
      .mockResolvedValueOnce(new Response("# Markdown only", { headers: { "Content-Type": "text/markdown" } }))

    const result = await parseWithMineruResult(v1Config, "/docs/small.pdf")
    expect(result.markdown).toBe("# Markdown only")
    // no PUT byte upload happened: only 5 requests (health, init, job, poll, download)
    expect(mockHttpFetch.mock.calls.filter((call) => call[1]?.method === "PUT")).toHaveLength(0)
  })

  it("surfaces job failures with the server message", async () => {
    __mineruTest.primeLocalProtocolCache(v1Config.localEndpoint, "v1")
    mockHttpFetch
      .mockResolvedValueOnce(jsonResponse({ status: "ok", version: "4.0.11" }))
      .mockResolvedValueOnce(jsonResponse({ status: "completed", file: { id: "f" } }))
      .mockResolvedValueOnce(jsonResponse({ job_id: "job-3", status: "queued" }))
      .mockResolvedValueOnce(jsonResponse({
        job_id: "job-3",
        status: "failed",
        error: { message: "model load failed" },
      }))

    await expect(parseWithMineru(v1Config, "/docs/bad.pdf"))
      .rejects.toThrow("Local MinerU (V1) parsing failed: model load failed")
  })
})
