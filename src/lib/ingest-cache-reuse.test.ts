/**
 * Cache-reuse short-circuit（2026-10-12 小批量实测发现的吞吐缺陷）：
 * PDF 已有高质量 MinerU cache（.cache 文本非空且非「## Page 1」降级形态）时，
 * 重放/重导入任务必须直接复用 cache，不得重新提交 MinerU 解析——
 * 173 页 PDF 云端重排队实测 14-19 分钟/任务，全库放量会打爆云端额度。
 * pdfium 降级 cache 不短路（保留 issue806 修复机会）由下方负例断言。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import path from "node:path"
import fs from "node:fs/promises"
import os from "node:os"
import { realFs } from "@/test-helpers/fs-temp"

vi.mock("@/commands/fs", () => {
  // realFs 的 readFile 是纯 Node 实现，没有 Rust 端 read_file 的
  // 「.cache 优先」逻辑（生产环境 PDF 文本来自 cache）。这里包一层：
  // .pdf 路径重定向到同目录 .cache/{name}.txt，对齐生产语义。
  const real = realFs as unknown as Record<string, unknown>
  const realReadFile = real.readFile as (p: string, o?: unknown) => Promise<string>
  return {
    ...real,
    readFile: vi.fn(async (path: string, opts?: unknown) => {
      if (path.toLowerCase().endsWith(".pdf")) {
        const cache = path.replace(/([^/\\]+)$/, ".cache/$1.txt")
        try {
          return await realReadFile(cache, opts)
        } catch {
          return ""
        }
      }
      return realReadFile(path, opts)
    }),
  }
})

const mineruSpy = vi.fn()
vi.mock("@/lib/mineru", () => ({
  parseWithMineruResult: (...args: unknown[]) => {
    mineruSpy(...args)
    throw new Error("parseWithMineruResult must not be called when a MinerU cache exists")
  },
  classifyMineruFailure: () => "permanent",
}))

vi.mock("./llm-client", () => ({
  streamChat: vi.fn(async (_cfg: unknown, _msgs: unknown, cb: { onDone: () => void }) => {
    cb.onDone()
  }),
}))

import { autoIngest } from "./ingest"
import { useWikiStore } from "@/stores/wiki-store"
import { useActivityStore } from "@/stores/activity-store"
import type { LlmConfig } from "@/stores/wiki-store"

const DOC_TEXT = [
  "# 某公司关于第二轮审核问询函的回复",
  "",
  "## 1.关于经营情况",
  "",
  "报告期内公司经营稳定。",
  "",
  "回复：公司经营情况良好。",
  "",
  "## 2.关于财务规范",
  "",
  "公司财务核算规范。",
  "",
  "回复：公司财务规范无异常。",
  "",
].join("\n")

const LLM: LlmConfig = {
  provider: "openai",
  apiKey: "test",
  baseUrl: "http://127.0.0.1:9",
  model: "test",
} as unknown as LlmConfig

let projectPath = ""

beforeEach(async () => {
  mineruSpy.mockClear()
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cache-reuse-"))
  projectPath = tmp.replace(/\\/g, "/")
  const srcDir = `${projectPath}/raw/sources/scheduled-import/问答/2025/上交所/IPO/主板/注册/某公司`
  await fs.mkdir(`${srcDir}/.cache`, { recursive: true })
  const pdfName = "8-1 发行人及中介机构关于第二轮审核问询函的回复.pdf"
  await fs.writeFile(`${srcDir}/${pdfName}`, Buffer.from("%PDF-1.4 dummy"))
  useWikiStore.setState({
    mineruConfig: {
      enabled: true,
      backend: "cloud",
      token: "test-token",
      modelVersion: "pipeline",
      localEndpoint: "",
    } as never,
  })
  useActivityStore.setState({ items: [] })
})

afterEach(async () => {
  await fs.rm(projectPath, { recursive: true, force: true })
})

async function writeCache(content: string | null) {
  const srcDir = `${projectPath}/raw/sources/scheduled-import/问答/2025/上交所/IPO/主板/注册/某公司`
  const pdfName = "8-1 发行人及中介机构关于第二轮审核问询函的回复.pdf"
  if (content === null) return
  await fs.writeFile(`${srcDir}/.cache/${pdfName}.txt`, content, "utf-8")
}

describe("MinerU cache-reuse short-circuit", () => {
  it("reuses an existing MinerU-grade cache and never submits the PDF for parsing", async () => {
    await writeCache(DOC_TEXT)
    const src = `${projectPath}/raw/sources/scheduled-import/问答/2025/上交所/IPO/主板/注册/某公司/8-1 发行人及中介机构关于第二轮审核问询函的回复.pdf`

    await autoIngest(projectPath, src, LLM)

    expect(mineruSpy).not.toHaveBeenCalled()
    // qa-split 正常落库（H2 规则通道拆 2 题）
    const qDir = `${projectPath}/wiki/questions`
    const qFiles = await fs.readdir(qDir)
    expect(qFiles.length).toBe(2)
    // sources 页正常生成（qa-split 模式下 parser 字段标注拆题通道，
    // 与生产一致；复用事实由上方「未提交解析」断言钉死）
    const sDir = `${projectPath}/wiki/sources`
    const [sourcePage] = await fs.readdir(sDir)
    const sourceBody = await fs.readFile(`${sDir}/${sourcePage}`, "utf-8")
    expect(sourceBody).toContain('parser: qa-split')
    expect(sourceBody).toContain('qa-split H2·2题')
  })

  it("still submits for parsing when the cache is a pdfium-degraded artifact", async () => {
    // 「## Page 1」开头 = pdfium 降级形态——不短路，走解析梯（mock 会 throw，
    // 被梯级捕获后落 pdfium 分支并写警告；断言点=确实尝试过提交）。
    await writeCache("## Page 1\nplain pdfium text")
    const src = `${projectPath}/raw/sources/scheduled-import/问答/2025/上交所/IPO/主板/注册/某公司/8-1 发行人及中介机构关于第二轮审核问询函的回复.pdf`

    await autoIngest(projectPath, src, LLM)

    expect(mineruSpy).toHaveBeenCalled()
  })
})
