import { describe, expect, it } from "vitest"
import { applyCaseInfoFacts, extractCaseInfoFacts } from "./case-info"
import { deriveFinancingType } from "./qa-split"

const CASE_PAGE = `---
type: case
title: 万通液压（北交所再融资·2025）
company: "山东万通液压股份有限公司"
deal: 再融资
---

# 万通液压（北交所再融资·2025）

## 项目概览

山东万通液压股份有限公司（证券代码：830839）是一家专注于液压产品研发、生产和销售的企业。本次项目为公司向特定对象发行可转换公司债券，募集资金总额不超过1.5亿元，全部用于补充流动资金。保荐机构为长江证券承销保荐有限公司，律师事务所为北京市中伦律师事务所，会计师事务所为和信会计师事务所（特殊普通合伙）。
`

describe("case-info — R3 §7.3 基本信息抽取", () => {
  it("extracts intermediary firms, stock code and proceeds from case prose", () => {
    const facts = extractCaseInfoFacts(CASE_PAGE, "2026-10-24")
    expect(facts.stock_code).toBe("830839")
    expect(facts.sponsor).toBe("长江证券承销保荐有限公司")
    expect(facts.lawyer).toBe("北京市中伦律师事务所")
    expect(facts.auditor).toContain("和信")
    expect(facts.proposed_proceeds).toContain("1.5亿元")
    expect(facts.info_as_of).toBe("2026-10-24")
  })

  it("applies facts into frontmatter idempotently", () => {
    const facts = extractCaseInfoFacts(CASE_PAGE, "2026-10-24")
    const once = applyCaseInfoFacts(CASE_PAGE, facts)
    expect(once).toContain("stock_code: 830839")
    expect(once).toContain("sponsor: 长江证券承销保荐有限公司")
    // 二次应用零变化（幂等）
    expect(applyCaseInfoFacts(once, facts)).toBe(once)
    // 已有键不被覆盖
    expect(once).toContain('company: "山东万通液压股份有限公司"')
  })

  it("extracts sponsor representatives from signature block", () => {
    const page = `${CASE_PAGE}\n保荐代表人：张三、李四\n`
    const facts = extractCaseInfoFacts(page, "2026-10-24")
    expect(facts.sponsor_representatives).toEqual(["张三", "李四"])
    const applied = applyCaseInfoFacts(page, facts)
    expect(applied).toContain("sponsor_representatives: [张三, 李四]")
  })

  it("financing_type derivation is filename-keyword driven and zero-LLM", () => {
    expect(deriveFinancingType("IPO", "x/y.pdf")).toBe("首发")
    expect(deriveFinancingType("再融资", "问答/2025/北交所/再融资/注册/万通液压/向特定对象发行可转换公司债券回复.pdf"))
      .toBe("再融资-定向可转债")
    expect(deriveFinancingType("再融资", "问答/2025/上交所/再融资/主板/注册/X/向不特定对象发行可转换公司债券回复.pdf"))
      .toBe("再融资-公开发行可转债")
    expect(deriveFinancingType("再融资", "问答/2025/深交所/再融资/创业板/注册生效/上能电气/向特定对象发行股票审核问询函回复.pdf"))
      .toBe("再融资-定增")
    expect(deriveFinancingType("再融资", "问答/2025/x/配股说明书.pdf")).toBe("再融资-配股")
    expect(deriveFinancingType("重大资产重组", "x.pdf")).toBeNull()
    expect(deriveFinancingType("再融资", "无关键词文件.pdf")).toBeNull()
  })
})
