import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { parseWikiSchemaRouting } from "@/lib/wiki-schema"
import { parseFrontmatter } from "@/lib/frontmatter"

// 一次性应用侧验证（2026-10-10 schema.md V1.2 定稿后跑）：
// 1. 案例库 Page Types 表新增的 question 行能被应用路由解析器读出；
// 2. 两库 schema.md 新标签段不影响现有 typeDirs；
// 3. 新 question 页 frontmatter 形态（qa-split 产物）能被前端解析器解析。
// 外部库路径不存在时跳过（CI 环境）。

const CASE_LIB = "C:/library/wiki/schema.md"
const KB_LIB = "C:/library/知识库/schema.md"

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, "utf-8")
  } catch {
    return null
  }
}

describe("real library schema.md after V1.2 tagging update", () => {
  it("case library parses the question route", () => {
    const raw = safeRead(CASE_LIB)
    if (!raw) return
    const routing = parseWikiSchemaRouting(raw)
    expect(routing.typeDirs.case).toBe("wiki/cases")
    expect(routing.typeDirs.issue).toBe("wiki/issues")
    expect(routing.typeDirs.question).toBe("wiki/questions")
    expect(routing.typeDirs.source).toBe("wiki/sources")
  })

  it("knowledge base routing table is unchanged (中文标题不被路由解析，属既有行为)", () => {
    const raw = safeRead(KB_LIB)
    if (!raw) return
    const routing = parseWikiSchemaRouting(raw)
    // 知识库的页面类型表标题是中文「一、页面类型」，从不被
    // loadProjectWikiSchemaRouting 解析——本测试钉住这个既有事实，
    // 防止 V1.2 标签段改动意外引入可解析的英文标题。
    expect(Object.keys(routing.typeDirs)).toHaveLength(0)
  })

  it("qa-split question frontmatter shape parses on the TS side", () => {
    const sample = [
      "---",
      "type: question",
      'title: "第2轮·问题4·关于产品竞争力"',
      "company: 千分一智能技术股份有限公司",
      "exchange: 深交所",
      "board: 创业板",
      "deal: IPO",
      'year: "2026"',
      "round_no: 2",
      "round_kind: 审核问询函",
      "issuer: 交易所",
      "question_no: 4",
      "split_channel: H2",
      "tags: []",
      "sources:",
      '  - "scheduled-import/问答/2026/x.pdf"',
      "---",
      "",
      "## 监管问题",
    ].join("\n")
    const split = parseFrontmatter(sample)
    expect(split.frontmatter).toBeTruthy()
    expect(split.frontmatter!.type).toBe("question")
    expect(split.frontmatter!.round_kind).toBe("审核问询函")
    expect(split.frontmatter!.question_no).toBe("4")
    expect(split.frontmatter!.split_channel).toBe("H2")
  })
})
