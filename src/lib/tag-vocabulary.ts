/**
 * 标签轴词表与落盘值域校验（B3，2026-10-22 审计 S8）。
 *
 * 权威来源：库根 schema.md「标签体系」表（V1.4）。审计实证（2026-10-22，
 * 问询2024 库 2002 页扫描）：ingest 落盘前不验枚举时，`stage:注册` 这类
 * 张冠李戴值与 entity 页错挂 exchange/board/deal 轴的标签直接进库。
 *
 * 校验语义（如实披露，不静默丢弃整页）：
 *   - 闭集轴枚举外值 → 从 tags 剔除，逐条记 warning；
 *   - 已知轴挂在 schema 标注不适用的页面 type 上 → 剔除并记 warning；
 *   - topic: 开放轴（schema「按需扩展，新词须中文且克制度」）→ 只验
 *     含中文字符，不设硬词表；
 *   - 未知前缀（entity 标签约定 A5① 补节前）→ 放行。
 *
 * inquiry-stage 双形态并认：2025 分册已按 schema V1.4 去轮次前缀重写
 * （平铺 21 值），2024 分册（guaji 导入中）仍是 V1.3 前缀形态（26 值，
 * 与 qa-split 的 INQUIRY_STAGE_ALLOWED_VALUES 一致）。过渡期两形态都
 * 合法，待数据收尾轮（A5）统一归一后再收紧为单形态。
 */
import { INQUIRY_STAGE_ALLOWED_VALUES } from "./qa-split"

export const TAG_AXIS_VOCABULARY: Readonly<Record<string, readonly string[]>> = {
  exchange: ["深交所", "上交所", "北交所"],
  board: ["主板", "创业板", "科创板", "北交所"],
  deal: ["IPO", "再融资", "重大资产重组"],
  stage: ["第一轮", "第二轮", "第三轮", "落实函"],
  role: ["财务", "法律", "业务"],
  flow: [
    "项目立项",
    "股改",
    "尽调申报",
    "财务核查",
    "业务核查",
    "行业合规",
    "募投",
    "承销发行",
    "板块规则",
    "上市后持续监管",
  ],
  "reg-nature": [
    "法律",
    "行政法规",
    "部门规章",
    "证监会规范性文件",
    "交易所业务规则",
    "业务指南",
    "财会准则",
    "审计准则",
    "行业监管规则",
    "地方性法规",
    "问询与处罚案例",
  ],
}

/** inquiry-stage 主轴闭集（99 方案批次 3.2 双轴拆分，2026-10-30）：
 *  8 主题粗标签全量打；原 21 值平铺里的 13 细分值迁 detail 轴（见
 *  INQUIRY_STAGE_DETAIL_VALUES）。单一事实源=ipoanswer core/kb/inquiry_stages.py
 *  （STAGE_MAJOR_VALUES / STAGE_DETAIL_VALUES），本文件为管线侧同步副本。 */
const INQUIRY_STAGE_V14_FLAT_VALUES: readonly string[] = [
  "板块定位",
  "业务模式",
  "财务数据真实性",
  "关联交易",
  "核心技术",
  "合规经营",
  "信息披露",
  "募投项目",
]

/** inquiry-stage-detail 细分轴闭集（原后续系 7 + 注册系 6）。 */
const INQUIRY_STAGE_DETAIL_VALUES: readonly string[] = [
  "问询分类",
  "财务数据真实性与业绩质量",
  "业务逻辑与持续经营能力",
  "关联交易与资金往来",
  "信息披露与合规性",
  "重大资产重组与并购",
  "核心技术来源·科创企业",
  "板块定位于产业政策",
  "财务真实性与业绩质量",
  "公司治理与合规性",
  "业务与持续经营能力",
  "信息披露与文件合规性",
  "会后事项与重大变化",
]

const INQUIRY_STAGE_ALL_FORMS: ReadonlySet<string> = new Set([
  ...INQUIRY_STAGE_ALLOWED_VALUES,
  ...INQUIRY_STAGE_V14_FLAT_VALUES,
])

const INQUIRY_STAGE_DETAIL_FORMS: ReadonlySet<string> = new Set(INQUIRY_STAGE_DETAIL_VALUES)

/**
 * 各轴适用的页面 type（schema「标签体系」表「适用」列）。未列出的 type
 * 视为该轴不适用——已知树形轴挂到不适用 type（典型：entity 页挂
 * exchange:/board:/deal:）时剔除。
 */
const AXIS_APPLICABLE_TYPES: Readonly<Record<string, readonly string[]>> = {
  exchange: ["case", "source", "question"],
  board: ["case", "source", "question"],
  deal: ["case", "source", "question"],
  stage: ["source"],
  role: ["issue", "case"],
  topic: ["issue", "case", "source", "question", "synthesis"],
  "inquiry-stage": ["question", "issue", "case"],
  "inquiry-stage-detail": ["question", "issue", "case"],
  flow: ["case", "question", "synthesis"],
  "reg-nature": ["source", "synthesis"],
  year: ["case"],
}

const CHINESE_CHAR_RE = /[\u4e00-\u9fff]/

function splitTag(tag: string): { axis: string; value: string } | null {
  const idx = tag.indexOf(":")
  if (idx <= 0) return null // 无前缀标签（entity 约定待 A5①）——放行
  return { axis: tag.slice(0, idx).trim(), value: tag.slice(idx + 1).trim() }
}

export interface TagValidationResult {
  /** 值域内且适用于该 type 的标签（保持原顺序）。 */
  kept: string[]
  /** 被剔除的标签 + 人可读原因（进 ingest-warnings）。 */
  dropped: { tag: string; reason: string }[]
}

/**
 * 按页面 type 校验 tags 值域。pageType 传空串时跳过适用性检查（type
 * 无法判定是异常形态，交给既有 routing/解析告警，不在这里二次惩罚），
 * 只做枚举值校验。
 *
 * R3 §7.4 核心技术消歧（2026-10-24，需求 10.1）：可选 pageTitle 提供
 * 标题上下文——标题含「研发费用/研发投入/研发支出」的页挂
 * `inquiry-stage:核心技术` 属误归类（研发费用归「财务数据真实性」族），
 * 剔除并记 warning，供人工复核队列回写正确值（PATCH /pages/frontmatter）。
 */
export function validateTagsForPage(
  pageType: string,
  tags: readonly string[],
  pageTitle?: string,
): TagValidationResult {
  const kept: string[] = []
  const dropped: { tag: string; reason: string }[] = []
  const rdExpenseTitle =
    pageTitle !== undefined && /研发(费用|投入|支出)/.test(pageTitle)
  for (const tag of tags) {
    const parsed = splitTag(tag)
    if (!parsed) {
      kept.push(tag)
      continue
    }
    const { axis, value } = parsed
    if (!value) {
      dropped.push({ tag, reason: "空值" })
      continue
    }
    const applicable = AXIS_APPLICABLE_TYPES[axis]
    if (applicable === undefined) {
      kept.push(tag) // 未知前缀轴（entity 标签约定 A5① 前放行）
      continue
    }
    if (pageType && !applicable.includes(pageType)) {
      dropped.push({
        tag,
        reason: `轴 ${axis}: 不适用于 type=${pageType}（适用 ${applicable.join("/")})`,
      })
      continue
    }
    if (axis === "topic") {
      if (CHINESE_CHAR_RE.test(value)) kept.push(tag)
      else dropped.push({ tag, reason: "topic 须为中文主题词" })
      continue
    }
    if (axis === "year") {
      if (/^20\d{2}$/.test(value)) kept.push(tag)
      else dropped.push({ tag, reason: "year 须为四位年份" })
      continue
    }
    if (axis === "inquiry-stage") {
      if (value === "核心技术" && rdExpenseTitle) {
        dropped.push({
          tag,
          reason: "核心技术消歧（R3 §7.4）：标题含研发费用/投入/支出，归财务真实性族复核",
        })
        continue
      }
      if (INQUIRY_STAGE_ALL_FORMS.has(value)) kept.push(tag)
      else dropped.push({ tag, reason: "inquiry-stage 枚举外值" })
      continue
    }
    if (axis === "inquiry-stage-detail") {
      if (INQUIRY_STAGE_DETAIL_FORMS.has(value)) kept.push(tag)
      else dropped.push({ tag, reason: "inquiry-stage-detail 枚举外值" })
      continue
    }
    const vocabulary = TAG_AXIS_VOCABULARY[axis]
    if (vocabulary === undefined) {
      kept.push(tag)
      continue
    }
    if (vocabulary.includes(value)) kept.push(tag)
    else dropped.push({ tag, reason: `轴 ${axis}: 枚举外值「${value}」` })
  }
  return { kept, dropped }
}
