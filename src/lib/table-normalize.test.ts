import { describe, expect, it } from "vitest"

import {
  mergeTwoLevelHeader,
  normalizeTwoLevelTableHeaders,
} from "@/lib/table-normalize"

// 实测样本（ST联合 6-1 回复，2026-10-31 从 raw/parsed 摘录）
const ST_LIANHE_TABLE = [
  "| 项目 | 2025年10月末/2025年1-10月 | 2024年末/2024年度 |  |  |  |  |",
  "| --- | --- | --- | --- | --- | --- | --- |",
  "| 交易前 | 备考数 | 变动率/变动额 | 交易前 | 备考数 | 变动率/变动额 |  |",
  "| 总资产 | 45,419.34 | 217,593.95 | 379.08% | 42,513.07 | 219,062.52 | 415.28% |",
  "| 总负债 | 39,715.73 | 63,989.53 | 61.12% | 33,298.00 | 76,379.08 | 129.38% |",
].join("\n")

describe("mergeTwoLevelHeader", () => {
  it("按整除分组合并 ST联合实测表头", () => {
    // 7 列 = 1 行标签 + 2 个一级日期标签 × 每组 3 列
    const l1 = ["项目", "2025年10月末/2025年1-10月", "2024年末/2024年度", "", "", "", ""]
    const l2 = ["交易前", "备考数", "变动率/变动额", "交易前", "备考数", "变动率/变动额", ""]
    const merged = mergeTwoLevelHeader(l1, l2)
    expect(merged).toHaveLength(7)
    expect(merged![0]).toBe("项目")
    expect(merged![1]).toBe("2025年10月末/2025年1-10月/交易前")
    expect(merged![2]).toBe("2025年10月末/2025年1-10月/备考数")
    expect(merged![3]).toBe("2025年10月末/2025年1-10月/变动率/变动额")
    expect(merged![4]).toBe("2024年末/2024年度/交易前")
    expect(merged![5]).toBe("2024年末/2024年度/备考数")
    expect(merged![6]).toBe("2024年末/2024年度/变动率/变动额")
  })

  it("列数不一致时返回 null（不猜）", () => {
    expect(mergeTwoLevelHeader(["A", "B"], ["x", "y", "z"])).toBeNull()
  })

  it("分组不能整除时返回 null（不猜）", () => {
    // 5 列 = 1 行标签 + 2 标签，但每组 2 列 → 2*2=4 ≠ 4? 实际 span=4, k=2, g=2 可整除；
    // 换成 k=3 而 span=4 则除不尽
    expect(mergeTwoLevelHeader(["行", "A", "B", "C", ""], ["s1", "s2", "s3", "s4", ""])).toBeNull()
  })
})

describe("normalizeTwoLevelTableHeaders", () => {
  it("合并实测两级表头，数据行零改写", () => {
    const { markdown, stats } = normalizeTwoLevelTableHeaders(ST_LIANHE_TABLE)
    expect(stats.merged).toBe(1)
    expect(stats.skipped).toBe(0)
    const lines = markdown.split("\n")
    // 表头变成单级（不再是两行表头）
    expect(lines[0]).toMatch(/^\| 项目 \|/)
    expect(lines[0]).toContain("2025年10月末/2025年1-10月/交易前")
    expect(lines[1]).toMatch(/^\| -{1,} \|/)
    // 数据行逐字节保留
    expect(lines[2]).toBe(
      "| 总资产 | 45,419.34 | 217,593.95 | 379.08% | 42,513.07 | 219,062.52 | 415.28% |",
    )
    expect(lines.length).toBe(4, "二级表头行被吸收，总行数少一")
  })

  it("幂等：合并后的结果再跑一遍不再命中", () => {
    const first = normalizeTwoLevelTableHeaders(ST_LIANHE_TABLE)
    const second = normalizeTwoLevelTableHeaders(first.markdown)
    expect(second.stats.merged).toBe(0)
    expect(second.markdown).toBe(first.markdown)
  })

  it("普通单级表头表原样保留", () => {
    const plain = [
      "| 项目 | 2025年 | 2024年 |",
      "| --- | --- | --- |",
      "| 收入 | 1 | 2 |",
    ].join("\n")
    const { markdown, stats } = normalizeTwoLevelTableHeaders(plain)
    expect(stats.tables).toBe(1)
    expect(stats.skipped).toBe(1)
    expect(markdown).toBe(plain)
  })

  it("列数与数据行不符时原样保留（宁可不错不可猜错）", () => {
    const odd = [
      "| A | B |  |  |",
      "| --- | --- | --- | --- |",
      "| 1 | 2 | 3 |",
    ].join("\n")
    const { markdown, stats } = normalizeTwoLevelTableHeaders(odd)
    expect(stats.skipped).toBe(1)
    expect(markdown).toBe(odd)
  })

  it("多张表逐个处理，非表格内容不动", () => {
    const doc = ["# 标题", "", ST_LIANHE_TABLE, "", "正文段落。", "", plainTable()].join("\n")
    const { markdown, stats } = normalizeTwoLevelTableHeaders(doc)
    expect(stats.tables).toBe(2)
    expect(stats.merged).toBe(1)
    expect(markdown).toContain("# 标题")
    expect(markdown).toContain("正文段落。")
  })

  it("单元格内转义竖线不破坏切分", () => {
    const escaped = [
      "| 项目 | 说明 |",
      "| --- | --- |",
      "| a \\| b | c |",
    ].join("\n")
    const { markdown, stats } = normalizeTwoLevelTableHeaders(escaped)
    expect(stats.skipped).toBe(1, "单级表不合并")
    expect(markdown).toBe(escaped, "原文逐字节保留")
  })
})

function plainTable(): string {
  return ["| 项目 | 2025年 | 2024年 |", "| --- | --- | --- |", "| 收入 | 1 | 2 |"].join("\n")
}
