/**
 * F2（2026-10-12 审查）：重拆孤儿页清理单测。
 * 场景：库内已有 slug-q1/q2/q3 三题页面，本次重拆只拆出 q1/q2——
 * q3 的 question 页与它的全部 section 页必须移入隔离区（不直删），
 * 保留题号的页面不动；manifest 如实记录。
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const files = new Map<string, string>()
const deleted = new Set<string>()

vi.mock("@/commands/fs", () => ({
  createDirectory: vi.fn(async (path: string) => {
    files.set(path.endsWith("/") ? `${path}.dir` : path, "")
    return
  }),
  deleteFile: vi.fn(async (path: string) => {
    deleted.add(path)
    files.delete(path)
  }),
  readFile: vi.fn(async (path: string) => {
    const content = files.get(path)
    if (content === undefined) throw new Error(`ENOENT: ${path}`)
    return content
  }),
  writeFile: vi.fn(async (path: string, content: string) => {
    files.set(path, content)
  }),
  listDirectory: vi.fn(async (dir: string) => {
    if (!files.has(`${dir}/.exists`)) return []
    return [...files.keys()]
      .filter((path) => path.startsWith(`${dir}/`) && !path.endsWith(".exists") && !path.endsWith(".dir"))
      .map((path) => ({
        name: path.slice(dir.length + 1),
        path,
        is_dir: false,
      }))
  }),
  // 其余导出：ingest.ts 顶层绑定需要存在，测试路径不会调用
  fileExists: vi.fn(async () => false),
  getFileModifiedTime: vi.fn(async () => 0),
  getFileSize: vi.fn(async () => 0),
  readFileAsBase64: vi.fn(async () => ""),
}))

import { quarantineStaleQaSplitPages } from "./ingest"

function seedWikiDir(dir: string, names: string[]) {
  files.set(`${dir}/.exists`, "")
  for (const name of names) files.set(`${dir}/${name}`, `# ${name}`)
}

beforeEach(() => {
  files.clear()
  deleted.clear()
})

describe("quarantineStaleQaSplitPages (F2)", () => {
  it("quarantines question pages (and their sections) whose numbers vanished from the new split", async () => {
    seedWikiDir("pp/wiki/questions", [
      "acme-q1.md",
      "acme-q2.md",
      "acme-q3.md",
      "other-co-q7.md", // 别的来源——绝不能动
    ])
    seedWikiDir("pp/wiki/sections", [
      "acme-q1-s1.md",
      "acme-q3-s1.md",
      "acme-q3-s2.md",
      "other-co-q7-s1.md",
    ])

    const quarantined = await quarantineStaleQaSplitPages(
      "pp",
      "raw/sources/acme.pdf",
      "acme",
      new Set([1, 2]),
    )

    expect(quarantined.sort()).toEqual([
      "wiki/questions/acme-q3.md",
      "wiki/sections/acme-q3-s1.md",
      "wiki/sections/acme-q3-s2.md",
    ])
    // 保留题号的页面原样在库
    expect(files.has("pp/wiki/questions/acme-q1.md")).toBe(true)
    expect(files.has("pp/wiki/questions/acme-q2.md")).toBe(true)
    expect(files.has("pp/wiki/sections/acme-q1-s1.md")).toBe(true)
    // 别的来源零触碰
    expect(files.has("pp/wiki/questions/other-co-q7.md")).toBe(true)
    expect(files.has("pp/wiki/sections/other-co-q7-s1.md")).toBe(true)
    // 孤儿页移入隔离区（原文件删除 = move，非原地保留）
    const quarantinedFiles = [...files.keys()].filter(
      (path) =>
        path.startsWith("pp/.llm-wiki/quarantine/pages/") && path.endsWith(".md"),
    )
    expect(quarantinedFiles).toHaveLength(3)
    expect(deleted.has("pp/wiki/questions/acme-q3.md")).toBe(true)
    // manifest 记录了来源与页面清单
    const manifest = files.get("pp/.llm-wiki/quarantine/manifest.jsonl") ?? ""
    expect(manifest).toContain("acme.pdf")
    expect(manifest).toContain("wiki/questions/acme-q3.md")
    expect(manifest).toContain("wiki/sections/acme-q3-s2.md")
  })

  it("is a no-op when the new split covers every existing number (or nothing exists yet)", async () => {
    seedWikiDir("pp/wiki/questions", ["acme-q1.md"])
    const kept = await quarantineStaleQaSplitPages(
      "pp",
      "raw/sources/acme.pdf",
      "acme",
      new Set([1, 2]),
    )
    expect(kept).toEqual([])
    expect(deleted).toEqual(new Set())
    expect(files.has("pp/wiki/questions/acme-q1.md")).toBe(true)

    const fresh = await quarantineStaleQaSplitPages(
      "pp",
      "raw/sources/new.pdf",
      "never-seen",
      new Set([1]),
    )
    expect(fresh).toEqual([])
  })
})
