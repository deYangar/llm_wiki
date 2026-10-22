/**
 * B7（2026-10-22 审计 S1+S2 治本）：qa-split → case sources 回写单测。
 * 场景：库内已有同项目 case 页（company 全称 vs 路径短名），问答函入库后
 * 该文件必须并入 case 页 sources（去重、不重复追加）；deal/year 不一致的
 * 同名公司 case 页绝不能误并；无 case 页时静默跳过。
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const files = new Map<string, string>()

vi.mock("@/commands/fs", () => ({
  createDirectory: vi.fn(async (path: string) => {
    files.set(path.endsWith("/") ? `${path}.dir` : path, "")
  }),
  deleteFile: vi.fn(async () => {}),
  readFile: vi.fn(async (path: string) => {
    const content = files.get(path)
    if (content === undefined) throw new Error(`ENOENT: ${path}`)
    return content
  }),
  writeFile: vi.fn(async (path: string, content: string) => {
    files.set(path, content)
  }),
  listDirectory: vi.fn(async (dir: string) => {
    if (!files.has(`${dir}/.exists`)) throw new Error(`ENOENT: ${dir}`)
    return [...files.keys()]
      .filter(
        (path) =>
          path.startsWith(`${dir}/`) &&
          !path.endsWith(".exists") &&
          !path.endsWith(".dir"),
      )
      .map((path) => ({ name: path.slice(dir.length + 1), path, is_dir: false }))
  }),
  fileExists: vi.fn(async () => false),
  getFileModifiedTime: vi.fn(async () => 0),
  getFileSize: vi.fn(async () => 0),
  readFileAsBase64: vi.fn(async () => ""),
}))

import { syncCaseSourcesFromQaSplit } from "./ingest"
import { parseSources } from "./sources-merge"
import type { QaPathMeta } from "./qa-split"

function seedCase(name: string, frontmatter: Record<string, string>) {
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n")
  files.set(`pp/wiki/cases/${name}`, `---\ntype: case\n${fm}\n---\n\n# case\n`)
}

function pathMeta(overrides: Partial<QaPathMeta> = {}): QaPathMeta {
  return {
    year: "2024",
    exchange: "上交所",
    deal: "再融资",
    board: "主板",
    status: "注册",
    company: "德力佳",
    ...overrides,
  }
}

const IDENTITY =
  "scheduled-import/问答/2024/上交所/再融资/主板/注册/德力佳/8-1 关于首轮审核问询函的回复.pdf"

beforeEach(() => {
  files.clear()
})

describe("syncCaseSourcesFromQaSplit (B7)", () => {
  it("appends the qa-split file to the matching case page's sources", async () => {
    files.set("pp/wiki/cases/.exists", "")
    seedCase("德力佳（沪主板再融资·2024）.md", {
      company: "德力佳传动科技股份有限公司",
      deal: "再融资",
      year: "2024",
      created: "2026-10-20",
      updated: "2026-10-20",
    })
    files.set(
      "pp/wiki/cases/德力佳（沪主板再融资·2024）.md",
      files
        .get("pp/wiki/cases/德力佳（沪主板再融资·2024）.md")!
        .replace(
          "type: case",
          `type: case\nsources: ["scheduled-import/问答/2024/上交所/再融资/主板/注册/德力佳/7-3 补充法律意见书.pdf"]`,
        ),
    )

    const result = await syncCaseSourcesFromQaSplit("pp", pathMeta(), IDENTITY)

    expect(result.updatedCasePaths).toEqual([
      "wiki/cases/德力佳（沪主板再融资·2024）.md",
    ])
    expect(result.warnings).toEqual([])
    const written = files.get("pp/wiki/cases/德力佳（沪主板再融资·2024）.md")!
    expect(parseSources(written)).toEqual([
      "scheduled-import/问答/2024/上交所/再融资/主板/注册/德力佳/7-3 补充法律意见书.pdf",
      IDENTITY,
    ])
    // 只 touch updated，created 保持首次时间戳
    expect(written).toContain("created: 2026-10-20")
    expect(written).not.toContain("updated: 2026-10-20\n")
  })

  it("is idempotent — an already-merged source is not appended twice", async () => {
    files.set("pp/wiki/cases/.exists", "")
    seedCase("德力佳（沪主板再融资·2024）.md", {
      company: "德力佳传动科技股份有限公司",
      created: "2026-10-20",
    })
    const page = files.get("pp/wiki/cases/德力佳（沪主板再融资·2024）.md")!
    files.set(
      "pp/wiki/cases/德力佳（沪主板再融资·2024）.md",
      page.replace("type: case", `type: case\nsources: ["${IDENTITY}"]`),
    )

    const result = await syncCaseSourcesFromQaSplit("pp", pathMeta(), IDENTITY)

    expect(result.updatedCasePaths).toEqual([])
    expect(parseSources(files.get("pp/wiki/cases/德力佳（沪主板再融资·2024）.md")!)).toEqual([
      IDENTITY,
    ])
  })

  it("skips same-name case pages whose deal or year disagrees", async () => {
    files.set("pp/wiki/cases/.exists", "")
    seedCase("德力佳（深主板IPO·2023）.md", {
      company: "德力佳传动科技股份有限公司",
      deal: "IPO",
      year: "2023",
    })

    const result = await syncCaseSourcesFromQaSplit("pp", pathMeta(), IDENTITY)

    expect(result.updatedCasePaths).toEqual([])
    expect(parseSources(files.get("pp/wiki/cases/德力佳（深主板IPO·2023）.md")!)).toEqual([])
  })

  it("skips unrelated companies silently", async () => {
    files.set("pp/wiki/cases/.exists", "")
    seedCase("利柏特（沪主板再融资·2024）.md", {
      company: "江苏利柏特股份有限公司",
      deal: "再融资",
      year: "2024",
    })

    const result = await syncCaseSourcesFromQaSplit("pp", pathMeta(), IDENTITY)

    expect(result.updatedCasePaths).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it("returns quietly when the cases directory doesn't exist", async () => {
    const result = await syncCaseSourcesFromQaSplit("pp", pathMeta(), IDENTITY)
    expect(result.updatedCasePaths).toEqual([])
    expect(result.warnings).toEqual([])
  })
})
