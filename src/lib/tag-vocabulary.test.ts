import { describe, it, expect } from "vitest"
import { validateTagsForPage, TAG_AXIS_VOCABULARY } from "./tag-vocabulary"
import { INQUIRY_STAGE_ALLOWED_VALUES } from "./qa-split"

describe("tag-vocabulary — validateTagsForPage (B3, 审计 S8)", () => {
  it("keeps in-vocabulary axis values", () => {
    const { kept, dropped } = validateTagsForPage("case", [
      "exchange:深交所",
      "board:主板",
      "deal:IPO",
      "role:财务",
      "year:2024",
    ])
    expect(kept).toEqual([
      "exchange:深交所",
      "board:主板",
      "deal:IPO",
      "role:财务",
      "year:2024",
    ])
    expect(dropped).toEqual([])
  })

  it("drops out-of-vocabulary values with readable reasons (stage:注册)", () => {
    const { kept, dropped } = validateTagsForPage("source", [
      "stage:第一轮",
      "stage:注册",
      "deal:并购重组",
    ])
    expect(kept).toEqual(["stage:第一轮"])
    expect(dropped.map((d) => d.tag)).toEqual(["stage:注册", "deal:并购重组"])
    expect(dropped[0].reason).toContain("枚举外值")
  })

  it("drops known axes on page types they don't apply to (entity + exchange)", () => {
    const { kept, dropped } = validateTagsForPage("entity", [
      "exchange:深交所",
      "board:主板",
      "deal:IPO",
      "机构:律师事务所",
    ])
    expect(kept).toEqual(["机构:律师事务所"])
    expect(dropped.map((d) => d.tag)).toEqual([
      "exchange:深交所",
      "board:主板",
      "deal:IPO",
    ])
    expect(dropped[0].reason).toContain("不适用于 type=entity")
  })

  it("drops stage on question pages (schema: stage applies to source only)", () => {
    const { dropped } = validateTagsForPage("question", ["stage:第一轮"])
    expect(dropped).toHaveLength(1)
    expect(dropped[0].reason).toContain("不适用于 type=question")
  })

  it("accepts both inquiry-stage shapes during the V1.3→V1.4 transition", () => {
    const v13 = `交易所后续问询·${INQUIRY_STAGE_ALLOWED_VALUES[10]}`
    const { kept } = validateTagsForPage("question", [
      v13,
      "inquiry-stage:板块定位",
      "inquiry-stage:不存在的阶段",
    ])
    expect(kept).toEqual([v13, "inquiry-stage:板块定位"])
  })

  it("topic is an open axis — any Chinese value passes, non-Chinese is dropped", () => {
    const { kept, dropped } = validateTagsForPage("issue", [
      "topic:换股吸收合并",
      "topic:revenue recognition",
    ])
    expect(kept).toEqual(["topic:换股吸收合并"])
    expect(dropped.map((d) => d.tag)).toEqual(["topic:revenue recognition"])
  })

  it("year must be a four-digit 20xx value", () => {
    const { kept, dropped } = validateTagsForPage("case", [
      "year:2024",
      "year:24",
      "year:二〇二四",
    ])
    expect(kept).toEqual(["year:2024"])
    expect(dropped).toHaveLength(2)
  })

  it("passes through unknown-prefix and prefix-less tags (entity 约定 A5① 前放行)", () => {
    const { kept, dropped } = validateTagsForPage("entity", [
      "entity:保荐机构",
      "自由标签",
      "lifecycle:上市后",
    ])
    expect(kept).toEqual(["entity:保荐机构", "自由标签", "lifecycle:上市后"])
    expect(dropped).toEqual([])
  })

  it("skips applicability checks when pageType is unknown but still validates enums", () => {
    const { kept, dropped } = validateTagsForPage("", [
      "exchange:深交所",
      "exchange:纳斯达克",
    ])
    expect(kept).toEqual(["exchange:深交所"])
    expect(dropped).toHaveLength(1)
  })

  it("vocabulary mirrors the schema 标签体系 table (spot-check anchors)", () => {
    expect(TAG_AXIS_VOCABULARY.deal).toEqual(["IPO", "再融资", "重大资产重组"])
    expect(TAG_AXIS_VOCABULARY.stage).toEqual([
      "第一轮",
      "第二轮",
      "第三轮",
      "落实函",
    ])
    expect(TAG_AXIS_VOCABULARY.flow).toContain("上市后持续监管")
    expect(TAG_AXIS_VOCABULARY["reg-nature"]).toContain("问询与处罚案例")
  })
})

describe("inquiry-stage 双轴拆分（99 方案批次 3.2）", () => {
  it("主轴闭集=8 主题粗标签，细分值在主轴被剔", () => {
    const { kept, dropped } = validateTagsForPage("question", [
      "inquiry-stage:募投项目",
      "inquiry-stage:财务数据真实性与业绩质量", // 细分值混主轴 → 剔
    ])
    expect(kept).toEqual(["inquiry-stage:募投项目"])
    expect(dropped).toHaveLength(1)
  })

  it("detail 轴闭集=13 细分值，8 主题值在 detail 轴被剔", () => {
    const { kept, dropped } = validateTagsForPage("question", [
      "inquiry-stage-detail:信息披露与合规性",
      "inquiry-stage-detail:信息披露", // 主题值混 detail 轴 → 剔
    ])
    expect(kept).toEqual(["inquiry-stage-detail:信息披露与合规性"])
    expect(dropped).toHaveLength(1)
  })

  it("detail 轴适用于 question/issue/case", () => {
    for (const t of ["question", "issue", "case"]) {
      const { kept } = validateTagsForPage(t, ["inquiry-stage-detail:问询分类"])
      expect(kept).toEqual(["inquiry-stage-detail:问询分类"])
    }
    const { dropped } = validateTagsForPage("source", ["inquiry-stage-detail:问询分类"])
    expect(dropped).toHaveLength(1)
  })
})
