/**
 * W7 qa-split: deterministic question splitter for inquiry-reply documents.
 *
 * Design contract (plans/2026-10-08-frontmatter-tagging-and-filter.md §3 W7):
 * completeness of the question layer is guaranteed by deterministic rules —
 * the LLM never decides "which questions are worth recording". The four
 * channel recognizers below are ported verbatim (regex semantics) from the
 * 2026-10-08 completeness audit script (ipoanswer tmp/audit_wiki_completeness_v4.py)
 * so both ends count questions identically:
 *   H1  `## 问题N` heading lines (SSE / SZSE refinancing)
 *   H2  `## N.关于XX` numbered keyword headings (SZSE IPO)
 *   H3  `问题N、`-style markers incl. TOC pages (fallback: body markers)
 *   H4  standalone `回复：`/`【回复】` blocks (reply-count fallback)
 * Round/kind/issuer metadata comes from the document body, never the file
 * name (519 generic-named files carry no round info); directory metadata
 * (year/exchange/deal/board/status/company) comes from the curated path.
 */

/** 中文数字 → 阿拉伯数字（v4 映射 + 单字「一」~「九」直取，v4 亦漏此形态）。
 *  2026-11-03 M4.2 批A 检查门：加小数子题号（5.1/18.2）分支——恒运昌实测
 *  「## 问题 5.1、关于客户——关于单一客户依赖」整行不命中 H3，5/6/18 三个
 *  题位被吞进前题（q4 吞 5.1+5.2）。 */
export function cn2num(s: string): number {
  if (/^\d+$/.test(s)) return parseInt(s, 10)
  if (/^\d+\.\d+$/.test(s)) return parseFloat(s)
  const CN: Record<string, number> = {
    一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  }
  if (s.length === 1) return CN[s] ?? 0
  if (s === "十") return 10
  if (s.length === 2 && s[0] === "十") return 10 + (CN[s[1]] ?? 0)
  if (s.length === 2 && s[1] === "十") return (CN[s[0]] ?? 0) * 10
  if (s.length === 3 && s[1] === "十") return (CN[s[0]] ?? 0) * 10 + (CN[s[2]] ?? 0)
  return 0
}

// ---- 四通道正则（与审计 v4 同一套语义） --------------------------------

/** H1: `## 问题 4` / `## 问题四、` 标题行（题号后到行尾）。 */
const H1_LINE = /^#{1,4}\s*问题\s*([0-9]{1,3}|[一二三四五六七八九十]{1,3})\s*[、.．:：]?\s*$/
/** H2: `## 4.关于…` 数字+关键词标题行——**只认半角点**。顿号形态
 *  `## 4、关于…`（全库 1,804 行 vs 半角点 270 行，2026-10-10 实测）多
 *  数是回复正文内的论证小节，归 section 层（v4 正则混收两种分隔符是其
 *  题数虚高的主因，此处治本分离）。
 *  2026-10-12 深审补充：分隔符与标题形态都不是题边界的可靠判据——
 *  ① MinerU 对部分真题边界不加 `##`（千分一二轮题4/5 裸行实测漏题，
 *  题4/5 整体混入题3 页）；② 部分函件真题边界就是顿号标题
 *  「## 1、关于行业代表性」（埃泰克二轮实测，其目录同形态+点线页码）。
 *  判据升级为**结构三段式佐证**：顿号标题/裸行候选后 10 行内出现
 *  「根据申报材料/请发行人披露/回复：」类问询题干标志才收为题边界
 *  （嘉德利「## 1、关于HC300BF…」小节无佐证，正确排除）。 */
const H2_KEYWORDS =
  "关于|业绩|收入|毛利|客户|应收|存货|募投|关联|同业|股权|合规|诉讼|环保|安全|税务|研发|技术|专利|数据|政府|补贴|现金|持续|业务|模式|竞争|采购|供应|产能|产销|成本|费用|商誉|减值|披露|内控|对赌|红筹|VIE"
const H2_LINE = new RegExp(
  `^#{1,4}\\s*([0-9]{1,3})\\s*\\.\\s*(${H2_KEYWORDS})`,
  "i",
)
/** H2 佐证候选形态：顿号标题行（埃泰克）与无 `##` 裸行（千分一）。 */
const H2_DUN_HEADING = new RegExp(
  `^#{1,4}\\s*([0-9]{1,3})\\s*、\\s*(${H2_KEYWORDS})`,
  "i",
)
const H2_BARE_LINE = new RegExp(
  `^([0-9]{1,3})\\s*[\\.、．]\\s*(${H2_KEYWORDS})`,
  "i",
)
/** 结构三段式佐证行：问询题干起始段的典型句式（问什么/怎么答的标志）。 */
const QUESTION_CONTEXT_LINE =
  /^\s*(?:#{0,4}\s*)?回复\s*[：:]|请\s*(?:发行人|保荐人|保荐机构|会计师|律师)|首轮问询回复及申报材料|申报材料(?:及问询回复|显示)|根据.{0,30}(?:申报材料|问询回复)/
/** H3: `问题N、`/`问题N：`/`问题N.`（后者排除小数 N. 后跟数字）。用于行内任意位置。
 *  2026-10-24 R3 补：中文题号后跟半角点（目录「问题一...... 3」点线形态，
 *  上能电气实测——原正则中文分支只认全角分隔符，toc 收不到中文题号）。 */
const H3_ANYWHERE = /问题\s*([0-9]{1,3}(?:[.．][0-9]{1,2})?|[一二三四五六七八九十]{1,3})\s*[、．:：]|问题\s*([0-9]{1,3}(?:[.．][0-9]{1,2})?|[一二三四五六七八九十]{1,3})\s*\.(?!\d)/g
/** H3 边界行（行首锚）。四种实测形态：
 *  1. 「问题N、/问题N：/问题N.」裸行（防小数 N. 后跟数字；北交所函件半角点形态）
 *  2. 「一. 关于问询问题 1.关于XX」——补充法律意见书：中文序数前缀（日播时尚实测）
 *  3. 「一、《审核问询函》问题 2.关于XX」——序数+《函名》前缀（松发股份实测）
 *  4. 「一、《问询函》1.关于发行方案」——《函名》+题号直起、无「问题」字样
 *     （天风证券 7-3 实测 2026-10-12：7-3 律师函一族的通用形态；《函名》必选
 *     + 尾锚 关于|其他——枚举小节「1、溜呗出行…」既无《函名》也无尾锚，不误收）
 *  5. 「问题一（原问题六）、关于XX」——中文题号+括号注记（评估机构/会计师
 *     核查意见族实测 2026-10-14：至正股份 6-5 `## 问题二（原问题七）、关于
 *     资产基础法评估`、日播时尚评估专项裸行同形态；注记限 ≤12 字防长括号
 *     内容误伤）。
 *  6. 裸行「问题一」——题号后无分隔符直接行尾（上能电气定增回复实测
 *     2026-10-24 R3：深交所函件题边界裸中文题号独行，原正则要求分隔符
 *     全落空坠入 H4 兜底，Q2 混入 11 万字符多题）。分隔符组加行尾 `$`
 *     锚：行首锚+题号后即行尾才命中——「问题一的回复如下」「问题 1 」
 *     之类句中/带尾缀形态不收。
 *  引号开头的引用行（「"一.关于问询问题 1…"之"（三）」）不命中——前缀字符集不含引号。 */
const H3_BODY_LINE =
  /^[ \t]{0,8}(?:#{1,4}[ \t]+)?(?:[一二三四五六七八九十]{1,3}\s*[.、．]\s*)?(?:(?:《[^》]{2,60}》\s*)?(?:关于\s*)?(?:问询\s*)?问题\s*(?:[0-9]{1,3}(?:[.．][0-9]{1,2})?|[一二三四五六七八九十]{1,3})\s*(?:[（(][^)）]{0,12}[)）])?\s*(?:[、．:：]|\.(?!\d)|$)|《[^》]{2,60}》\s*[0-9]{1,3}\s*(?:[、．:：]|\.(?!\d))\s*(?:关于|其他))/
/** 目录行特征：4+ 连续 `.` 或 2+ 连续 `…`（页码引导点线；中文省略号
 *  习惯「……」两字符成对，2026-10-12 埃泰克目录实测）。 */
const TOC_DOT_LEADER = /\.{4,}|…{2,}/
/** H4: 独立行 `回复：` / `【回复】` / `回复如下：`（允许 `## 回复`）。
 *  2026-10-14 T2 扩展：① 加 `答复`（评估机构/会计师核查意见族的回复块
 *  用「答复：」——至正股份 6-5、日播时尚评估专项实测）；② 加中介机构
 *  签名形态 `【申报会计师回复】`/`【保荐机构回复】`/`【发行人回复】`等
 *  （德昌股份 7-2 会计师回复实测——会计师文件每题以该签名块收束，
 *  既作 H4 计数拆题单位也作题/回复分界，此前不认导致全文塞进题目段）。 */
const H4_LINE = /^\s*#{0,4}\s*[【\[]?(?:(?:回复|答复)(?:如下|意见)?|(?:申报会计师|保荐机构|主承销商|发行人及中介机构|中介机构|发行人|律师|会计师|评估机构|评估师|独立财务顾问|财务顾问|保荐人及申报会计师)(?:专项)?回复)[】\]]?\s*[：:]?\s*$/
/** H5: 上交所回复报告体题边界——裸中文序数行「一、关于主营业务和行业代表性」
 *  （红板科技实测 2026-10-10：无「问题N」字样、无 ## 标题，序数+关键词即题）。 */
const H5_LINE = new RegExp(`^[一二三四五六七八九十]{1,3}\\s*、\\s*(${H2_KEYWORDS})`)

// ---- T4: 中介机构「序数大节」体（2026-10-19 第三梯队，探针报告定案） ----
// 会计师/评估/律师逐题文件：题边界=「一、**关于**XX」递增大节，无「问题N」
// 题号、无「回复：」块——classify 判 not-qa、split 时 H5 的「题数=回复块数」
// 校验必挂，整族进归纳式，题目层丢失（2026-10-14 探针：not-qa 139 的主体）。
// 判据三件套（探针 §四.1）：序数构成递增序列 + 节标题紧邻「关于」（挡标准
// 章节体红线——《编报规则 12 号》法律意见书 16 章骨架节标题不带「关于」）+
// 节长下限（挡目录行，点线行先剔除）。
const T4A_LINE = /^#{0,4}\s*([一二三四五六七八九十]{1,3})\s*、\s*关于/
/** T4A 行内含「问题N」题号结构（「一、关于《审核问询函》问题1.」律师函形态，
 *  山高环能实测）= 函题号引用，归 H3/H5 域——T4A 不收，防抢 H5 已拆对的文档。 */
const T4_QUESTION_REF = /问题\s*(?:[0-9]{1,3}|[一二三四五六七八九十]{1,3})/
/** T4B 题干直述档（方正科技实测）：大节标题不带「关于」，是完整问询题干
 *  长句（「一、建筑工程费、设备购置及安装费等具体内容及测算过程，…合理性」）。
 *  与标准章节体的区分：≥T4B_MIN_TITLE 字的长句 + 问询句式词；短名词短语
 *  （「本次发行上市的批准和授权」）= 章节体，不收。 */
const T4B_LINE = /^#{0,4}\s*([一二三四五六七八九十]{1,3})\s*、\s*(.{8,})$/
const T4B_MIN_TITLE = 25
const T4_INQUIRY_WORDS =
  /说明|披露|合理性|依据|是否存在|测算|情况|过程|原因|影响|规模|占比|构成/
/** 「第X部分」层结构（千岸科技实测：第一部分=问询回复、第二部分=意见书
 *  更新）——T4B 的长题干节会撞第二部分的标准章节长行，误抢拆坏；此类
 *  文档 H5/H3 已能拆第一部分，T4B 整体让位。 */
const T4_PART_STRUCTURE = /第\s*[一二三四五六七八九十]{1,2}\s*部分/
/** 节长下限（行）：真大节正文成块；目录残留/孤立引用行不成块。 */
const T4_MIN_SECTION_LINES = 5
/** 首边界位置上限：大节组织必须从文档前部开始（封面/目录容差）——
 *  8-1 主回复的回复正文里也遍在「一、关于」递增小节（全库实测 810/1650
 *  qa 命中朴素判据），但它们起于第一题回复区；T4 只兜「无题号形态」的
 *  文档（H1/H2/H3 拆不出时才轮到），此处 30% 是文档级组织性校验。 */
const T4_HEAD_RATIO = 0.3

const MAX_QUESTION_NO = 299

export type SplitChannel = "H1" | "H2" | "H3" | "H4" | "H5" | "T4" | "L6"

/** qa 文档形态：回复函（含回复块）或问询函原件（只有题目清单）。 */
export type QaDocumentKind = "reply" | "letter"

export interface QaPathMeta {
  company: string
  year?: string
  exchange?: string
  deal?: string
  board?: string
  status?: string
  /** deal 的融资类型细分（R3 §7.2 零 LLM 推导；IPO→首发，重组无值）。 */
  financingType?: string | null
}

export interface QaRoundMeta {
  /** 轮次。审核问询函族无轮次标记时默认 1（上交所首轮函制度性无「第N轮」
   *  字样，2026-10-19 定案）；落实函/注册反馈识别不出保持 null（不造数）。 */
  roundNo: number | null
  /** 审核问询函 | 落实函 | 注册反馈 */
  roundKind: "审核问询函" | "落实函" | "注册反馈"
  /** 交易所 | 证监会 */
  issuer: "交易所" | "证监会"
  /** 识别依据（对账溯源）。 */
  basis: string
}

export interface SplitQuestion {
  /** 原文题号（H4 通道无题号时按回复块顺序生成，并在元数据里如实标注）。 */
  questionNo: number
  /** 题干标题（题号行原文截断；LLM 标题清洗 2026-10-17 后另行补跑）。 */
  title: string
  /** 题目原文（含题号行，逐字转录）。 */
  questionText: string
  /** 回复原文（含回复标记行，逐字转录）；问询函原件为 ""。 */
  replyText: string
  channel: SplitChannel
  questionNoIsGenerated: boolean
  startLine: number
  replyStartLine: number | null
  endLine: number
}

export interface QaSplitResult {
  kind: QaDocumentKind
  channel: SplitChannel
  questions: SplitQuestion[]
  /** 目录页识别到的题号全集（对账用）。 */
  tocNumbers: number[]
  /** 正文标记与目录不一致等需要人工关注的说明；null=干净。 */
  manualQueue: string | null
}

// ---- W7.1 文档分类器 ----------------------------------------------------

const REPLY_OPENING =
  /对《[^》\n]{0,160}?(审核问询函|问询函|落实函|注册环节反馈意见|意见函)[^》\n]{0,60}》的回复/

/** 上交所回复函封面形态（无书名号）：「……审核问询函的回复（报告）」
 *  裸标题（红板科技/摩尔线程实测，2026-10-10 补）。
 *  2026-10-14 T2 扩展：覆盖「函回复」动宾语序（中国银行 7-2 实测
 *  「……审核问询函回复的专项说明」——会计师/评估/律师的回复载体族
 *  都用这个语序自称，此前「的回复」锚漏判导致整族 not-qa）。 */
const REPLY_TITLE_SIGNATURE =
  /(审核问询函|问询函|意见落实函|反馈意见|落实函)[^\n]{0,12}(?:的)?回复/

/** 补充法律意见书签名：封面/首部出现「补充法律意见书」+ 序数化问询问题章节。
 *  两种实测形态：松发「一、《审核问询函》问题 2.关于XX」；天风 7-3
 *  「一、 《问询函》1.关于发行方案」（无「问题」字样——《函名》+题号+
 *  「关于」强锚定，2026-10-12 补）。 */
const LEGAL_OPINION_MARK =
  /(补充法律意见书|补充法律意见|法律意见书).{0,2000}?[一二三四五六七八九十]\s*[.、．]\s*(?:(?:《[^》]{2,60}》\s*)?(?:关于\s*)?(?:问询\s*)?问题\s*[0-9]{1,3}|《[^》]{2,60}》\s*[0-9]{1,3}\s*[.、．]\s*(?:关于|其他))/s

/**
 * 单题意见书签名（2026-10-12 L6 通道 T2 触发）：意见书/核查意见/专项说明
 * 类文件 + 题目对应句——整文档只覆盖一道题，无题号序列（规则通道拆不出，
 * 此前被分类为 not-qa 走归纳式 ingest，题目层直接丢失）。kind 仍为 "reply"。
 * 两种实测形态：
 *  A. 「问询函第 N（.M）题」对应句（方案原假设）；
 *  B. 裸行小数题号直起（中贝 7-3 实测：「6.1 请发行人说明：公司共享
 *     电动车业务…」——正文通篇无「第N题」字样，题号就是行首的 6.1）。
 */
const SINGLE_TOPIC_OPINION_MARK_A =
  /(法律意见书|核查意见|专项说明|专项核查).{0,400}?(第\s*\d{1,2}(\.\d{1,2})?\s*[题个问])/s
const SINGLE_TOPIC_DECIMAL_LEAD_IN = /^\s*\d{1,3}\.\d{1,3}\s*(?:请|关于)/

function isSingleTopicOpinion(text: string): boolean {
  const head = text.slice(0, 20000)
  if (SINGLE_TOPIC_OPINION_MARK_A.test(head)) return true
  if (!/(法律意见书|核查意见|专项说明|专项核查)/.test(head)) return false
  return text.split(/\r?\n/).some((line) => SINGLE_TOPIC_DECIMAL_LEAD_IN.test(line))
}

/**
 * 判定文档是否问答函类。qa 类走 qa-split 通道，其余继续走归纳式 ingest。
 * 依据内容特征（回复函句式 / 题号标记结构 / 意见书章节签名），文件名仅弱参考。
 */
export function classifyQaDocument(text: string): QaDocumentKind | null {
  if (!text.trim()) return null
  const head = text.slice(0, 8000)
  const hasReplyOpening = REPLY_OPENING.test(head)
  const h1 = countHeadingMarkers(text, H1_LINE)
  const h2 = countHeadingMarkers(text, H2_LINE)
  const bodyH3 = bodyQuestionMarkers(text)
  const hasQuestionStructure = h1 >= 1 || h2 >= 1 || bodyH3.length >= 2
  if (hasReplyOpening) return "reply"
  if (REPLY_TITLE_SIGNATURE.test(head)) return "reply"
  // 补充法律意见书（6-3/6-4 系列中介文件）：按「序数. 关于问询问题N」章节
  // 组织，是对问询函逐题的回复载体——同样进 qa-split 逐题拆分。
  if (LEGAL_OPINION_MARK.test(text.slice(0, 12000)) && bodyH3.length >= 1) {
    return "reply"
  }
  // 单题意见书（L6 通道 T2）：无题号序列但有题目对应句（「第 N.M 题」或
  // 裸行小数题号直起），规则通道必然拆不出——先进 qa 类，0 题时由 LLM
  // 兜底通道接管。
  if (isSingleTopicOpinion(text)) {
    return "reply"
  }
  if (hasQuestionStructure) return hasReplyMarker(text) ? "reply" : "letter"
  // T4 签名（2026-10-19）：中介机构「序数大节」体——会计师/评估/律师逐题
  // 文件无「问题N」题号也无「回复：」块，此前整族判 not-qa 走归纳式，
  // 题目层丢失。判据组织性校验见 validateT4Structure。
  if (hasT4Signature(text)) return "reply"
  // 回复块兜底：泛名回复文件（519 份「发行人及中介机构回复意见.pdf」）
  // 无题号标记也无标准封面句式，但 2+ 个独立「回复：」行已是问询回复的
  // 特异结构（普通文档/法规不会出现）——交给 H4 拆题。
  if (countReplyMarkers(text) >= 2) return "reply"
  if (countReplyMarkers(text) >= 1 && REPLY_OPENING.test(text.slice(0, 20000))) {
    return "reply"
  }
  return null
}

/** T4 签名：T4A（紧邻「关于」）或 T4B（题干直述，排除「第X部分」层结构）。 */
function hasT4Signature(text: string): boolean {
  const lines = text.split(/\r?\n/)
  if (validateT4Structure(lines, collectT4Markers(lines, "A")) !== null) return true
  if (T4_PART_STRUCTURE.test(text.slice(0, 4000))) return false
  return validateT4Structure(lines, collectT4Markers(lines, "B")) !== null
}

function hasReplyMarker(text: string): boolean {
  return text
    .split(/\r?\n/)
    .slice(0, 4000)
    .some((line) => H4_LINE.test(line))
}

function countReplyMarkers(text: string): number {
  return text.split(/\r?\n/).filter((line) => H4_LINE.test(line)).length
}

function countHeadingMarkers(text: string, pattern: RegExp): number {
  let count = 0
  for (const line of text.split(/\r?\n/)) {
    if (pattern.test(line.trimEnd())) count += 1
  }
  return count
}

/**
 * T4 大节候选收集（T4A 紧邻「关于」主判据；T4B 题干直述档可选启用）。
 * 目录点线行排除；T4A 排除行内「问题N」引用形态（归 H3/H5 域）。
 */
function collectT4Markers(lines: string[], variant: "A" | "B"): LineMarker[] {
  const out: LineMarker[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim()
    if (TOC_DOT_LEADER.test(trimmed)) continue
    if (variant === "A") {
      const m = T4A_LINE.exec(trimmed)
      if (!m || T4_QUESTION_REF.test(trimmed)) continue
      const no = cn2num(m[1])
      if (no > 0 && no <= 99) out.push({ line: i, no })
    } else {
      const m = T4B_LINE.exec(trimmed)
      if (!m) continue
      const title = m[2]
      if (title.slice(0, 4).includes("关于")) continue // T4A 域
      if (title.length < T4B_MIN_TITLE) continue // 短名词短语=标准章节体
      if (!T4_INQUIRY_WORDS.test(title)) continue
      if (T4_QUESTION_REF.test(trimmed)) continue
      const no = cn2num(m[1])
      if (no > 0 && no <= 99) out.push({ line: i, no })
    }
  }
  return out
}

/**
 * T4 组织性校验：候选序数构成递增序列（≥2 节）+ 每节长度 ≥ 下限（挡目录
 * 残留）+ 首边界在文档前部（文档级组织而非回复内小节）。返回通过的边界
 * 集合；不满足返回 null。
 */
function validateT4Structure(
  lines: string[],
  candidates: LineMarker[],
  opts: { requireHead?: boolean } = {},
): LineMarker[] | null {
  const { kept } = monotonicMarkers(candidates)
  if (kept.length < 2) return null
  let minGap = Infinity
  for (let i = 0; i < kept.length; i += 1) {
    const end = i + 1 < kept.length ? kept[i + 1].line : lines.length - 1
    minGap = Math.min(minGap, end - kept[i].line)
  }
  if (minGap < T4_MIN_SECTION_LINES) return null
  if ((opts.requireHead ?? true) && kept[0].line / Math.max(lines.length, 1) > T4_HEAD_RATIO) {
    return null
  }
  return kept
}

interface LineMarker {
  line: number
  no: number
}

/** 从一行文本提取「问题N」题号（H3 语义：问题N+分隔符，或《函名》N.(关于|其他)直起形态；
 *  题号后允许「（原问题N）」类括号注记——主号优先，注记号不取。
 *  2026-11-03 子题号支持（M4.2 批A 检查门：5.1/18.2 形态）。 */
function extractQuestionNo(line: string): number {
  const punct = line.match(/问题\s*([0-9]{1,3}(?:[.．][0-9]{1,2})?|[一二三四五六七八九十]{1,3})\s*(?:[（(][^)）]{0,12}[)）])?\s*[、．:：]/)
  if (punct) return cn2num(punct[1])
  const dot = line.match(/问题\s*([0-9]{1,3}(?:[.．][0-9]{1,2})?)\s*(?:[（(][^)）]{0,12}[)）])?\.(?!\d)/)
  if (dot) return cn2num(dot[1])
  const letterNum = line.match(/《[^》]{2,60}》\s*([0-9]{1,3})\s*(?:[、．:：]|\.(?!\d))\s*(?:关于|其他)/)
  if (letterNum) return cn2num(letterNum[1])
  // 裸行「问题一」形态（R3 2026-10-24）：题号后直接行尾，整行无其他内容。
  const bare = line.trim().match(/^问题\s*([一二三四五六七八九十]{1,3})$/)
  if (bare) return cn2num(bare[1])
  return 0
}

/** 正文「问题N、」行首标记（排除目录点线行）。 */
/** 行尾页码点线（M5.1，2026-11-03 鼎佳实测）：目录条目尾「..33」只有
 *  两点，不命中 TOC_DOT_LEADER 的 4+ 点判定——该目录行混进正文标记
 *  且抢先立 head，把后续真题号压成回退。点串（2+）+行尾数字=目录
 *  页码引导，标记/目录两侧统一用它。 */
const TOC_PAGE_TAIL = /[.．…]{2,}\s*\d{1,4}\s*$/
/** 目录裸页码尾（M4.2 批A 三轮回炉，2026-11-03）：目录行「问题1、关于
 *  本次募投项目必要性及发行方案 3」无任何点线，尾「空白+1-4 位数字」
 *  就是页码——不排除会进正文标记序列抢先立 head（目录恒在正文前），
 *  正文 `## 问题N` 同号全部被判回退跳过：题干段退化为单行目录、末题
 *  吞全文（中科星图会计师核查意见 4,180 行实测：目录锚 1-4 立题、
 *  正文锚 L35/L172/L2554/L3671 全跳过、q4 吞 4,140 行）。只认无 #
 *  前缀行（MinerU 对正文题号标题必出 #）；剥除后前置文本 ≥6 字符
 *  （挡正文短行误伤）。 */
function isTocBarePageTail(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed.startsWith("#")) return false
  const m = trimmed.match(/\s\d{1,4}\s*$/)
  if (!m || m.index === undefined) return false
  return trimmed.slice(0, m.index).trim().length >= 6
}

function bodyQuestionMarkers(text: string): LineMarker[] {
  const out: LineMarker[] = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (TOC_DOT_LEADER.test(line) || TOC_PAGE_TAIL.test(line) || isTocBarePageTail(line)) continue
    if (!H3_BODY_LINE.test(line)) continue
    const no = extractQuestionNo(line)
    if (no > 0 && no <= MAX_QUESTION_NO) out.push({ line: i, no })
  }
  return out
}

/** 目录页「问题N、」题号（带点线或裸页码尾）。 */
function tocQuestionNumbers(text: string): number[] {
  const seen = new Set<number>()
  for (const line of text.split(/\r?\n/)) {
    if (
      !TOC_DOT_LEADER.test(line) &&
      !TOC_PAGE_TAIL.test(line) &&
      !isTocBarePageTail(line)
    ) continue
    const m = H3_ANYWHERE.exec(line)
    H3_ANYWHERE.lastIndex = 0
    if (!m) continue
    const no = cn2num(m[1] || m[2])
    if (no > 0 && no <= MAX_QUESTION_NO) seen.add(no)
  }
  return [...seen].sort((a, b) => a - b)
}

// ---- W7.2 拆题引擎 ------------------------------------------------------

/**
 * 按题号边界切块。通道优先级与审计 v4 count_q 一致（H1 > H2 > H3 > H4）。
 * 题目与回复正文是原文行切片的逐字拼接——零改写零删减是质量红线，
 * buildQuestionFileBlocks 内还有 includes() 自检兜底。
 */
/** M5.1 改动 3 出口防线：title 回落「问题N（题干待人工）」的题不静默——
 *  汇总进 manualQueue（各通道 return 统一后处理）。 */
export function splitQaDocument(text: string, kind: QaDocumentKind): QaSplitResult {
  const result = splitQaDocumentImpl(text, kind)
  const pending = result.questions
    .filter((q) => q.title.includes("题干待人工"))
    .map((q) => `q${q.questionNo}`)
  if (pending.length > 0) {
    result.manualQueue = [
      result.manualQueue,
      `题干待人工：${pending.join("、")}（title 无实质行，占位回落）`,
    ]
      .filter(Boolean)
      .join("；")
  }
  return result
}

function splitQaDocumentImpl(text: string, kind: QaDocumentKind): QaSplitResult {
  const lines = text.split(/\r?\n/)
  const replyMarkers = collectReplyMarkers(lines)
  const toc = tocQuestionNumbers(text)
  const bodyMarkers = bodyQuestionMarkers(text)

  // 标题通道（H1/H2）的单行命中是弱信号——回复正文小节（如「## 11、募投
  // 项目风险」）也会撞白名单。两个及以上才信任该通道；单行时让位给更强
  // 的正文标记（H3）或回复块（H4），全部不足再退回单行信号。
  const headingChannel = (pattern: RegExp) => {
    const markers: LineMarker[] = []
    for (let i = 0; i < lines.length; i += 1) {
      const m = pattern.exec(lines[i].trimEnd())
      if (m) {
        const no = cn2num(m[1])
        if (no > 0 && no <= MAX_QUESTION_NO) markers.push({ line: i, no })
      }
    }
    return markers
  }

  // 补充法律意见书形态：无「回复：」标记，题目/回复分界用第一个论证小节。
  const opinionStyle =
    kind === "reply" && replyMarkers.length === 0 && LEGAL_OPINION_MARK.test(text.slice(0, 12000))

  const h1 = headingChannel(H1_LINE)
  if (h1.length >= 2) {
    const { kept, manualQueue } = monotonicMarkers(h1, text)
    return {
      kind, channel: "H1",
      questions: cutQuestions(lines, kept, replyMarkers, "H1", opinionStyle),
      tocNumbers: toc, manualQueue,
    }
  }
  const h2 = [...headingChannel(H2_LINE), ...contextualH2Markers(lines)].sort(
    (a, b) => a.line - b.line,
  )
  // T4A 接管资格（江淮汽车实测）：无回复块 + 大节组织（递增/节长/首边界
  // 校验全过）且节数比 H2 保留的题数更多——H2 的顿号小节（序号每题重启）
  // 是大节内的次级结构，此前 monotonic 砍剩的头几个被当题、多节混进一题。
  // 8-1 主回复函不受影响：它们带「回复：」块（replyMarkers>0 即失格），
  // 且真题数 ≥ 大节数（至信 17>5 / 马矿 15>10，全库实测）。
  const t4aKept =
    replyMarkers.length === 0
      ? validateT4Structure(lines, collectT4Markers(lines, "A"))
      : null
  if (h2.length >= 2) {
    const { kept, manualQueue } = monotonicMarkers(h2, text)
    // H2 防误拆：候选 ≥2 但 monotonic 后只剩 1（序号重启=顿号小节形态，
    // 中贝通信实测 6 节拆 1 题）——弱信号让位，续走 H3/T4/H5/H4。
    if (kept.length >= 2) {
      if (t4aKept && t4aKept.length > kept.length) {
        return {
          kind, channel: "T4",
          questions: cutQuestions(lines, t4aKept, replyMarkers, "T4", true),
          tocNumbers: toc, manualQueue: null,
        }
      }
      return {
        kind, channel: "H2",
        questions: cutQuestions(lines, kept, replyMarkers, "H2", opinionStyle),
        tocNumbers: toc, manualQueue,
      }
    }
  }

  if (bodyMarkers.length >= 2) {
    const { kept, manualQueue } = monotonicMarkers(bodyMarkers, text)
    // 对账回退（2026-10-27 B-Step3 上能电气实测）：正文题号标记比目录
    // 列的题号少（kept < toc）或回复块明显多于题数（delta >= 2）= 正文
    // 有题的边界标记被解析通道丢失（「问题三」标题行在 .cache 产物里
    // 缺失、题干直接顶上），H3 切出的题会吞并后续整题。
    // M4.1（2026-11-02）改造：不再「整体弃 H3 → 按回复块编题号」——
    // 有已识别题号锚（head ≥1）时按锚切分（真题号零生成，中科星图
    // 7-2：4 锚 18 块 → 4 题）；head=0 才回退旧 cutByReplyBlocks。
    // 目录与回复块都齐的文档（kept == toc == reply）不受影响；无目录
    // 文档 toc=0 永不触发（仅 replyDelta 分支可能）。
    const heads = kept.filter((k) => k.block === "head")
    const keptNos = new Set(heads.map((k) => k.no))
    const tocMissing = toc.filter((n) => !keptNos.has(n)).length
    const replyDelta = replyMarkers.length - heads.length
    const missesBoundary = kind === "reply" && replyMarkers.length >= 1 &&
      (tocMissing >= 1 || replyDelta >= 2)
    if (missesBoundary) {
      if (heads.length >= 1) {
        const anchored = cutByKnownAnchors(lines, heads, replyMarkers, opinionStyle)
        // manualQueue 合并保留（v5，2026-11-03）：monotonic 的「编号重启」
        // 标记是 ingest 侧触发 L6 的关键词，不能被 trailing 文案顶掉。
        return {
          kind, channel: "H4",
          questions: anchored.questions,
          tocNumbers: toc,
          manualQueue: [
            manualQueue,
            anchored.trailing > 0
              ? `末题锚后仍有 ${anchored.trailing} 个回复块（归末题回复，可能吞并无锚尾题）`
              : null,
          ].filter(Boolean).join("；") || null,
        }
      }
      return {
        kind, channel: "H4",
        questions: cutByReplyBlocks(lines, replyMarkers),
        tocNumbers: toc, manualQueue: null,
      }
    }
    return {
      kind, channel: "H3",
      questions: cutQuestions(lines, kept, replyMarkers, "H3", opinionStyle),
      tocNumbers: toc, manualQueue,
    }
  }

  // H5: 上交所回复报告体「一、关于XX」序数题边界（无「问题N」字样）。
  // 序数在题内小节会重启（汇创达实测：题内小节同为「一、关于…」形态，
  // monotonic 砍到 2）——H5 题数必须与回复块数吻合（±2）才可信，
  // 否则序数是小节不是题，回退 H4 按回复块计。
  // 2026-10-19 修目录盲区：会计师/律师文件的目录页同形态双出现
  // （「一、关于融资规模……第1—26页」），此前目录行先进 monotonic、
  // 正文边界被当重启砍掉，拆出的「题」只剩目录行自身（21 字题干）。
  // 目录点线行与 bodyQuestionMarkers 同口径排除——目录行绝不是题边界。
  const h5: LineMarker[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim()
    if (TOC_DOT_LEADER.test(trimmed) || isTocBarePageTail(trimmed)) continue
    // md 化的序数大节（山高环能实测「## 一、关于《审核问询函》问题1.」）
    // 剥 ## 前缀后同形态收——MinerU 对律师函序数节输出 # 标题。
    const stripped = trimmed.replace(/^#{1,4}\s*/, "")
    if (!H5_LINE.test(stripped)) continue
    const cn = stripped.match(/^([一二三四五六七八九十]{1,3})\s*、/)
    const num = cn ? cn2num(cn[1]) : 0
    if (num > 0 && num <= 99) h5.push({ line: i, no: num })
  }
  if (h5.length >= 2) {
    const { kept } = monotonicMarkers(h5, text)
    const h5Count = kept.length
    const blockDelta = Math.abs(h5Count - replyMarkers.length)
    if (kept.length >= 2 && (blockDelta <= 2 || (replyMarkers.length === 0 && h5Count >= 3))) {
      return {
        kind, channel: "H5",
        questions: cutQuestions(lines, kept, replyMarkers, "H5", opinionStyle),
        tocNumbers: toc,
        manualQueue: null,
      }
    }
  }

  if (replyMarkers.length >= 1 && kind === "reply") {
    return {
      kind, channel: "H4",
      questions: cutByReplyBlocks(lines, replyMarkers),
      tocNumbers: toc, manualQueue: null,
    }
  }

  // T4B 题干直述档（方正科技族）：H1/H2/H3/H5/H4 全落空后的末位大节兜底。
  // 「第X部分」层结构文档不进——千岸科技实测其长题干节撞判据，但 H5 已
  // 把第一部分拆对，T4B 会拆坏。
  // （T4A 无独立兜底位：「一、关于XX」⊆ H5_LINE 关键词集，无回复块的
  //  ≥2 节大节文档已被 H5 的 blockDelta/无回复块分支接住——T4A 只在 H2
  //  接管位出场，抢在顿号小节弱信号混题之前。）
  if (!T4_PART_STRUCTURE.test(text.slice(0, 4000))) {
    const t4bKept = validateT4Structure(lines, collectT4Markers(lines, "B"))
    if (t4bKept) {
      return {
        kind, channel: "T4",
        questions: cutQuestions(lines, t4bKept, replyMarkers, "T4", true),
        tocNumbers: toc, manualQueue: null,
      }
    }
  }

  if (h1.length === 1 || h2.length === 1) {
    const single = h1.length === 1 ? h1 : h2
    const channel: SplitChannel = h1.length === 1 ? "H1" : "H2"
    // 单行是弱信号：无题号意见书的论证小节（「## 2. 合规风控层面」，天风
    // 7-3 实测 2026-10-12）也会撞白名单，单行直收会把小节当题、前文全部
    // 混进假题。必须像 contextualH2Markers 一样有题干三段式佐证才收；
    // 否则让位 L6 兜底/人工队列——弱信号宁可不放行。
    if (hasQuestionContextWithin(lines, single[0].line)) {
      return {
        kind, channel,
        questions: cutQuestions(lines, single, replyMarkers, channel, opinionStyle),
        tocNumbers: toc, manualQueue: null,
      }
    }
  }

  return {
    kind,
    channel: "H4",
    questions: [],
    tocNumbers: toc,
    manualQueue: "无法识别题号标记（无 H1/H2 标题、无正文「问题N、」行、无回复块）",
  }
}

function collectReplyMarkers(lines: string[]): number[] {
  const out: number[] = []
  for (let i = 0; i < lines.length; i += 1) {
    if (H4_LINE.test(lines[i])) out.push(i)
  }
  return out
}

/** 结构三段式佐证窗口（默认 4 行）：真题题干紧跟候选行（实测差 2 行：候选/
 *  空行/「根据申报材料…」），更远处出现的佐证句属于下一题（宇隆 fixture：
 *  小节后第 9 行的「请发行人」属下题题干，误收会砍断 section 层）。 */
function hasQuestionContextWithin(lines: string[], idx: number, window = 4): boolean {
  for (let j = idx + 1; j <= Math.min(idx + window, lines.length - 1); j += 1) {
    if (QUESTION_CONTEXT_LINE.test(lines[j])) return true
  }
  return false
}

/** H2 佐证候选：顿号标题行与裸行题边界，须结构三段式佐证才收。
 *  半角点标题行（H2_LINE 已收）不重复；目录点线行排除。 */
function contextualH2Markers(lines: string[]): LineMarker[] {
  const out: LineMarker[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim()
    if (TOC_DOT_LEADER.test(trimmed)) continue
    if (H2_LINE.test(trimmed)) continue
    const m = H2_DUN_HEADING.exec(trimmed) ?? H2_BARE_LINE.exec(trimmed)
    if (!m) continue
    const no = cn2num(m[1])
    if (!(no > 0 && no <= MAX_QUESTION_NO)) continue
    if (hasQuestionContextWithin(lines, i)) {
      out.push({ line: i, no })
    }
  }
  return out
}

/** 同题多块标记（M5.1 改动 1，2026-11-02）：意见书「问题10(1)(2)(3)」
 *  会在正文重复出现同号题块锚——严格递增把后三个 10 当正文引用跳过，
 *  2,116 行全文塞进孤页 q10（鼎佳信达实测）。同号标记保留为该题的
 *  分段锚（sub）：cutQuestions 不重复起题，块内容并入该题正文；
 *  回退（< last）仍跳过（真引用）。sub 生效须双轴佐证（防正文引用
 *  恰好同号误合并）：该行命中 H3_BODY_LINE 行首锚形态，或文书本身
 *  是意见书（LEGAL_OPINION_MARK 已在正文命中）；目录点线行恒排除。 */
type MarkedLine = LineMarker & { block: "head" | "sub" }

function monotonicMarkers(
  markers: LineMarker[],
  text = "",
): {
  kept: MarkedLine[]
  manualQueue: string | null
  sameNoSkipped: number
  backSkipped: number
} {
  const isOpinion = text ? LEGAL_OPINION_MARK.test(text.slice(0, 12000)) : false
  const kept: MarkedLine[] = []
  let sameNoSkipped = 0
  let backSkipped = 0
  let backHeadingSkipped = 0
  let last = 0
  for (const marker of markers) {
    if (marker.no > last) {
      kept.push({ ...marker, block: "head" })
      last = marker.no
      continue
    }
    if (marker.no === last) {
      const lineText = text ? (text.split("\n")[marker.line] ?? "") : ""
      const lineLooksLikeAnchor =
        H3_BODY_LINE.test(lineText) && !TOC_DOT_LEADER.test(lineText)
      if (isOpinion || lineLooksLikeAnchor) {
        kept.push({ ...marker, block: "sub" })
        sameNoSkipped += 1
      } else {
        backSkipped += 1
      }
      continue
    }
    // 回退细分（M4.2 批A 三轮回炉，2026-11-03）：被压掉的回退锚若本身是
    // 正文标题行形态（# 前缀题号标题），两处及以上 = 「编号重启」文书
    // （多轮合订/大节分组内子编号从 1 重编：五新隧装核查意见 16 锚 4
    // 序列、乔路铭第二轮回复实测）——规则通道无法给重启段唯一题号，
    // manualQueue 带关键词，ingest 侧据此触发 L6 LLM 判定真边界。
    const lineText = text ? (text.split("\n")[marker.line] ?? "") : ""
    backSkipped += 1
    if (/^\s*#{1,4}\s*(?:关于\s*)?(?:问询\s*)?问题/.test(lineText)) {
      backHeadingSkipped += 1
    }
  }
  const skipped = sameNoSkipped + backSkipped
  const restart = backHeadingSkipped >= 2
  return {
    kept,
    manualQueue:
      skipped > 0
        ? `${skipped} 个非递增题号标记被跳过（同题合并 ${sameNoSkipped} / 回退 ${backSkipped}${restart ? `，编号重启形态（回退标题行 ${backHeadingSkipped} 个，规则通道不可信）` : ""}）`
        : null,
    sameNoSkipped,
    backSkipped,
  }
}

function cutQuestions(
  lines: string[],
  markers: (LineMarker | MarkedLine)[],
  replyMarkers: number[],
  channel: SplitChannel,
  /** 补充法律意见书形态：题块内没有「回复：」标记行，用第一个论证小节
   *  边界（(一)/一、/## N、…）作为题目/回复分界。 */
  opinionStyle = false,
): SplitQuestion[] {
  const out: SplitQuestion[] = []
  // M5.1 改动 1：sub 标记（同题多块）不起新题——把序列按 head 分组，
  // 每题块延伸到下一个 head 之前（sub 块内容并入该题，verbatim 不丢）。
  const heads: { marker: LineMarker; end: number }[] = []
  for (let idx = 0; idx < markers.length; idx += 1) {
    const marker = markers[idx] as MarkedLine
    if (marker.block && marker.block === "sub") continue
    let nextHead = idx + 1
    while (
      nextHead < markers.length &&
      (markers[nextHead] as MarkedLine).block === "sub"
    ) {
      nextHead += 1
    }
    const end =
      nextHead < markers.length
        ? (markers[nextHead] as LineMarker).line - 1
        : lines.length - 1
    heads.push({ marker, end })
  }
  for (let hIdx = 0; hIdx < heads.length; hIdx += 1) {
    const { marker, end } = heads[hIdx]
    const start = marker.line
    // 回复起点：题块内第一个回复标记行
    let replyStart: number | null = null
    for (const r of replyMarkers) {
      if (r > start && r <= end) {
        replyStart = r
        break
      }
    }
    if (replyStart === null && opinionStyle) {
      for (let i = start + 1; i <= end; i += 1) {
        // 意见书小节形态：裸「（一）」行（松发），或带 ## 前缀的
        // 「## （一）」/「## 一、」标题行（中贝 7-3 实测——MinerU 对意见书
        // 论证小节输出 # 标题，只认裸行会把整个回复混进题目区）；
        // 「## 1、」阿拉伯序数小节（T4 会计师文件，方正科技实测——节内
        // 论证小节是阿拉伯顿号形态，不认则题干区吞掉整个大节）。
        if (
          /^#{0,4}\s*[（(][一二三四五六七八九十]{1,3}[)）]\s*\S/.test(lines[i]) ||
          /^#{1,4}\s*[一二三四五六七八九十]{1,3}\s*[、.．]\s*\S/.test(lines[i]) ||
          /^#{1,4}\s*[0-9]{1,3}\s*[、.．]\s*\S/.test(lines[i])
        ) {
          replyStart = i
          break
        }
      }
    }
    const questionEnd = replyStart === null ? end : replyStart - 1
    const questionText = lines.slice(start, questionEnd + 1).join("\n").trimEnd()
    const replyText =
      replyStart === null ? "" : lines.slice(replyStart, end + 1).join("\n").trimEnd()
    out.push({
      questionNo: marker.no,
      title: titleFromBlock(lines, start, questionEnd, marker.no),
      questionText,
      replyText,
      channel,
      questionNoIsGenerated: false,
      startLine: start,
      replyStartLine: replyStart,
      endLine: end,
    })
  }
  return out
}

/** 致函/封面收尾特征行（H4 首题前言剥离用，R3 2026-10-24）：中介核查
 *  意见族（落实函回复之核查意见等单题文件）「回复：」之前的题目区是
 *  封面+致函+字体说明，真题干在其后——最后一个此类行之后才是题干。
 *  句尾收尾（说明如下/回复如下/请予审核）与独立字体说明行（黑体/宋体/楷体）。 */
const PREFATORY_LINE = /(?:说明如下|回复如下|请予审核|予以审核|请审核|审核照鉴)[。：:！]?\s*$|^[ \t]*(?:黑体|宋体|楷体)/

function cutByReplyBlocks(lines: string[], replyMarkers: number[]): SplitQuestion[] {
  const out: SplitQuestion[] = []
  for (let idx = 0; idx < replyMarkers.length; idx += 1) {
    const replyStart = replyMarkers[idx]
    let blockStart = idx === 0 ? 0 : replyMarkers[idx - 1] + 1
    const end = idx + 1 < replyMarkers.length ? replyMarkers[idx + 1] - 1 : lines.length - 1
    if (idx === 0) {
      // 首块题目区可能整页是封面/目录：从最后一个目录点线行之后截起。
      // 切片本身仍逐字（只挪起点，不改写内容），边界如实记进拆题元数据。
      let lastToc = -1
      let tocCount = 0
      for (let i = blockStart; i < replyStart; i += 1) {
        if (TOC_DOT_LEADER.test(lines[i])) {
          lastToc = i
          tocCount += 1
        }
      }
      if (tocCount >= 3 && lastToc + 1 < replyStart) {
        blockStart = lastToc + 1
      }
      // R3 前言剥离：无题号标记的核查意见族首块，题目区开头是封面+致函
      // （「现将相关回复说明如下」/字体说明收尾）——真题干从最后一个致函
      // 收尾行之后起。剥离过猛（题干区为空）则回退整块，宁可封面混入
      // 不可题干丢失（题干为空由 §六 的空题干防线另行处理）。
      let leadInEnd = -1
      for (let i = blockStart; i < replyStart; i += 1) {
        if (PREFATORY_LINE.test(lines[i])) leadInEnd = i
      }
      if (leadInEnd >= 0 && leadInEnd + 1 < replyStart) {
        const stripped = lines.slice(leadInEnd + 1, replyStart).join("\n").trim()
        if (stripped) blockStart = leadInEnd + 1
      }
    }
    const questionText = lines.slice(blockStart, replyStart).join("\n").trim()
    const replyText = lines.slice(replyStart, end + 1).join("\n").trimEnd()
    // 首块的题目区可能包含封面/目录/「现回复如下」说明——截到最后一个
    // 看起来像题目要求的段落：题目区 >60% 为空或为目录点线时进人工队列。
    out.push({
      questionNo: idx + 1,
      title: titleFromBlock(lines, blockStart, replyStart - 1, idx + 1),
      questionText,
      replyText,
      channel: "H4",
      questionNoIsGenerated: true,
      startLine: blockStart,
      replyStartLine: replyStart,
      endLine: end,
    })
  }
  return out
}

/** 机构名/页码/装饰行——不配当题标题（R3 2026-10-24 首题白名单防线）：
 *  H4 首块封面以中介机构全称开头的形态（ST 联合华泰核查意见实测，
 *  此前 title=「华泰联合证券有限责任公司」）跳过取实质行。判据：整行
 *  是机构名（品牌前缀短 + 机构关键词 + 公司/事务所后缀 + 可选括号注释
 *  后即行尾）——题干长句中段虽含「会计师事务所(特殊普通合伙)被暂停
 *  从事证券服务…」（华泰实测误杀形态）但括号后仍有正文，行尾锚挡住。
 *  2026-10-27 B-Step3 实跑补两类（华泰核查意见 .cache 形态）：
 *  ①「如无特别说明，本回复所述…释义…」监管文书固定格式句（题干区
 *  开头的简称/口径说明段）；② markdown 表格行（字体说明表等，任何
 *  题的 title 都不应该是表格行）。 */
const NON_TITLE_LINE =
  /^[\d\s-]{1,14}$|^\||^如无特别说明|^[\u4e00-\u9fa5A-Za-z0-9]{2,16}(?:证券|会计师|律师|资产评估|评估|财务顾问|保荐)[\u4e00-\u9fa5]{0,10}(?:公司|事务所|中心|集团)?(?:[（(][^）)]{1,60}[)）])?\s*$/

/** M4.1（2026-11-02 验收缺陷 4）：已知题号锚定切分——missesBoundary
 *  对账回退不再「整体弃 H3 按回复块编题号」（中科星图 7-2：4 真题号 +
 *  18 回复块被编成 18 个假题），改为把已识别题号锚（head）作为题块边界：
 *  每锚一题（真题号、零生成），区间内回复块只作 replyStart 分段；末锚
 *  之后的区间外回复块归末题回复尾部并计数回传（写 manualQueue）。
 *  首锚前的封面/目录由首块剥离逻辑处理（与 cutByReplyBlocks 同款）。 */
function cutByKnownAnchors(
  lines: string[],
  anchors: LineMarker[],
  replyMarkers: number[],
  opinionStyle: boolean,
): { questions: SplitQuestion[]; trailing: number } {
  const questions: SplitQuestion[] = []
  let trailing = 0
  for (let aIdx = 0; aIdx < anchors.length; aIdx += 1) {
    const anchor = anchors[aIdx]
    const start = aIdx === 0 ? anchor.line : anchor.line
    const end =
      aIdx + 1 < anchors.length ? anchors[aIdx + 1].line - 1 : lines.length - 1
    // 题内回复起点：区间内第一个回复标记
    let replyStart: number | null = null
    for (const r of replyMarkers) {
      if (r > start && r <= end) {
        replyStart = r
        break
      }
    }
    if (replyStart === null && opinionStyle) {
      for (let i = start + 1; i <= end; i += 1) {
        if (
          /^#{0,4}\s*[（(][一二三四五六七八九十]{1,3}[)）]\s*\S/.test(lines[i]) ||
          /^#{1,4}\s*[一二三四五六七八九十]{1,3}\s*[、.．]\s*\S/.test(lines[i]) ||
          /^#{1,4}\s*[0-9]{1,3}\s*[、.．]\s*\S/.test(lines[i])
        ) {
          replyStart = i
          break
        }
      }
    }
    const questionEnd = replyStart === null ? end : replyStart - 1
    questions.push({
      questionNo: anchor.no,
      title: titleFromBlock(lines, start, questionEnd, anchor.no),
      questionText: lines.slice(start, questionEnd + 1).join("\n").trimEnd(),
      replyText:
        replyStart === null
          ? ""
          : lines.slice(replyStart, end + 1).join("\n").trimEnd(),
      channel: "H4",
      questionNoIsGenerated: false,
      startLine: start,
      replyStartLine: replyStart,
      endLine: end,
    })
  }
  // 末锚之后的区间外回复块：末题区间本就延伸到文件尾（已含在其
  // replyText 里，内容不丢）——此处只计数回传，调用方写 manualQueue
  // 标记「末锚后仍有 N 个回复块（可能吞并无锚尾题）」供人工复核。
  const lastAnchorLine = anchors.length
    ? anchors[anchors.length - 1].line
    : lines.length
  trailing = replyMarkers.filter((r) => r > lastAnchorLine).length
  return { questions, trailing }
}

/** M5.1 改动 3（2026-11-02）：题干标题取到目录行/保留词的病——
 *  鼎佳 q10 标题带目录页码尾巴「…影响..33」、科马 q1 标题「释 义」。
 *  三道净化：① 目录点线行剥尾部页码后可用（剥空跳过）；② 保留词
 *  （释义/目录/CONTENTS）跳过取下一实质行；③ 全块无实质行回退
 *  「问题N（题干待人工）」（splitQaDocument 出口据此写 manualQueue）。 */
const TITLE_RESERVED_WORDS = /^(?:释\s*义|目\s*录|CONTENTS|前\s*言|声\s*明)$/u

/** 挂账①（2026-11-05）：源 PDF 窄栏物理断行（行宽 ~40 字恰 ≤ TITLE_MAX）
 *  使断行行走「不超限原样返回」、行尾悬在数字串中间直通 title（国科天成
 *  「-2,9」「-」悬尾、茂莱光学「43,872.54 万元、4」切窗中段等 8 条断行族）。
 *  修法：行尾悬空时并入下一实质行，直到自然边界或上限，再走词边界截断。 */
const DANGLING_TAIL = /[\dA-Za-z,，.%-]$/u // 行尾是数字/字母/千分位/负号成员
const BOUNDARY_TAIL = /[。；：、，；;:！？\s]$/u // 行尾已是自然边界
const TITLE_MERGE_MAX = 80 // 合并上限（防目录/结构区长拼）

/** 导出供存量重算管道复用（缺陷①B，2026-11-04）：重算脚本按
 *  split.question_range 取题干块重新走本函数（单一事实源，与引擎
 *  增量产出零漂移），不重拆文档。 */
export function titleFromBlock(
  lines: string[],
  start: number,
  end: number,
  questionNo: number,
): string {
  for (let i = start; i <= end; i += 1) {
    const line = lines[i].trim()
    if (!line || line.startsWith("## Page") || /^[-—·\s]+$/.test(line)) continue
    if (NON_TITLE_LINE.test(line)) continue
    // ① 目录页码尾巴（「……33」/「.... 12」/两点尾「..33」）一律剥——
    //    不依赖 TOC_DOT_LEADER 的 4+ 点判定（鼎佳实测目录「..33」仅两点）；
    //    裸页码尾（无点线，「…发行方案 3」北汽蓝谷实测）仅对无 # 前缀行
    //    剥除（正文 # 标题行尾数字是内容不是页码）；
    //    剥空（整行就是点线页码）则该行不配当标题，继续找下一实质行
    let tocStripped = line.replace(/[.．…]{2,}\s*\d{1,4}\s*$/u, "").trim()
    if (tocStripped === line.trim() && isTocBarePageTail(line)) {
      tocStripped = tocStripped.replace(/\s\d{1,4}\s*$/u, "").trim()
    }
    if (!tocStripped) continue
    let stripped = tocStripped
      .replace(/^#{1,4}\s*/, "")
      // 意见书前缀：「一.」「一、」「《审核问询函》」「关于问询」
      .replace(/^[一二三四五六七八九十]{1,3}\s*[.、．]\s*/, "")
      .replace(/^《[^》]{2,60}》\s*/, "")
      // 2026-11-03 子题号（5.1/18.2）剥除——M4.2 批A 判卷实锤纯数字 title
      // （「问题 3.2 关于xx」剥「问题 3」后剩「.2 关于xx」起题号残迹）。
      .replace(/^(?:关于\s*)?(?:问询\s*)?问题\s*[0-9一二三四五六七八九十]{1,3}(?:[.．][0-9]{1,2})?\s*[、．:：.]?\s*/, "")
      .replace(/^问题\s*[0-9一二三四五六七八九十]{1,3}(?:[.．][0-9]{1,2})?\s*/, "")
      // 无「问题」前缀的裸子题号 heading（「3.2 关于xx」）
      .replace(/^[0-9]{1,3}[.．][0-9]{1,2}\s*[、．:：.]?\s*/, "")
      .trim()
    // ② 保留词（释义/目录…）→ 剥空形态，继续找下一实质行
    if (stripped && TITLE_RESERVED_WORDS.test(stripped)) {
      stripped = ""
    }
    // 剥空（裸题号行「问题一」上能电气形态）→ 继续找第一个实质行当标题
    // （题干首句）；全块剥空才回退占位（M5.1：带「题干待人工」标记，
    // 出口扫到即写 manualQueue，不静默）。
    // 缺陷①（2026-11-04）：此处的 slice(0,40) 硬切正是「题干整段当标题+
    // 截断」形态的产出点（ST联合「…业务 6」实锤）——与 questionTitle
    // 同源同修，统一走词边界回退。
    if (stripped) {
      // 挂账①（2026-11-05）：行尾悬空（数字/字母/千分位/负号成员收尾）时
      // 并入下一实质行——CJK 断行无空格直拼；三道防线：目录点线页码行、
      // 结构行（数字开头的金额续行「1,944.38 万元」除外，不能误杀）、
      // 80 字上限；并到自然边界即停，再统一走词边界截断。
      let merged = stripped
      for (let j = i + 1; j <= end && merged.length < TITLE_MERGE_MAX; j += 1) {
        if (!DANGLING_TAIL.test(merged)) break // 行尾自然 → 不并
        const nextLine = lines[j].trim()
        // 空行 = 段落边界，不跨段拼（2026-11-05 实测：空行分隔的「悬空尾+
        // 独立段」形态——如「关于 XNW5004 / (空) / 根据首轮回复…」——跳空行
        // 续拼会把 45+ 页合法型号/题号尾 title 误拼成两段杂糅；空行分隔的
        // 断行（春风动力「…9 月 1」形态，全库实测仅 1 条）如实挂账单独处理）
        if (!nextLine || nextLine.startsWith("## Page")) break
        if (/^[-—·\s]+$/.test(nextLine)) break
        // 目录行防线（吉和昌形态）：点线页码/裸页码尾行不并
        if (/[.．…]{2,}\s*\d{1,4}\s*$/u.test(nextLine)) break
        // 结构行防线：## 标题、回复段标记等不并（数字开头的续行除外——
        // 金额续行「1,944.38 万元」以数字开头，不能误杀）
        if (NON_TITLE_LINE.test(nextLine) && !/^[\dA-Za-z,，.%-]/.test(nextLine)) break
        merged = `${merged}${nextLine}` // CJK 断行无空格直拼
        if (BOUNDARY_TAIL.test(merged)) break // 并到自然边界 → 停
      }
      return truncateTitleAtBoundary(merged).trim() || `问题${questionNo}（题干待人工）`
    }
  }
  return `问题${questionNo}（题干待人工）`
}

// ---- W7.2 轮次与函类型识别（不依赖文件名） ------------------------------

// 函名允许跨行：MinerU 会把长函名折成多行（《关于XX\n首次公开发行…\n审核问询函》）。
const ROUND_SENTENCE =
  /[^\n]{0,30}(贵所|中国证券监督管理委员会|证监会|贵会)[^\n]{0,20}于\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*出具的\s*《([^》]{0,400}?)》/
const ROUND_IN_TITLE = /《[^》]{0,400}?(第\s*([0-9]{1,2}|[一二三四五六七八九十]{1,3})\s*轮|首轮|首次)[^》]{0,80}?(审核问询函|问询函|落实函)/

export function extractRoundMeta(text: string, fileName: string): QaRoundMeta {
  const head = text.slice(0, 20000)

  const sentence = ROUND_SENTENCE.exec(head)
  let letterName = sentence?.[5] ?? ""
  let basis = sentence ? "正文出具句" : ""

  if (!letterName) {
    const inTitle = ROUND_IN_TITLE.exec(head)
    if (inTitle) {
      letterName = inTitle[0]
      basis = "正文函名"
    }
  }

  let roundNo: number | null = null
  const roundFromLetter = letterName.match(/第\s*([0-9]{1,2}|[一二三四五六七八九十]{1,3})\s*轮/)
  if (roundFromLetter) {
    roundNo = cn2num(roundFromLetter[1])
  } else if (/首轮/.test(letterName)) {
    roundNo = 1
  }
  // 正文拿不到轮次时回退文件名（「关于第二轮审核问询函的回复」）。
  // 只认「第N轮/首轮」+ 函类上下文——「首次公开发行」的「首次」不是轮次，
  // 绝不能当第一轮用（上交所首轮函名通体无轮次字样）。
  if (roundNo === null) {
    const fromFile = fileName.match(
      /(第\s*[0-9]{1,3}|第\s*[一二三四五六七八九十]{1,3}|首)\s*轮(?=[^]{0,30}(?:审核问询函|问询函|落实函|回复|意见))/,
    )
    if (fromFile) {
      roundNo = fromFile[1] === "首" ? 1 : cn2num(fromFile[1].replace(/\s|第/g, ""))
      basis = basis ? `${basis}+文件名轮次` : "文件名弱参考"
    }
  }

  // 函类兜底（2026-10-19）：出具句无日期变体（「根据贵所出具的《…落实函》：」）
  // 不命中 ROUND_SENTENCE 时 letterName 为空，落实函会被误判为审核问询函族、
  // 再被首轮默认错给 roundNo=1——文件名的「落实函/反馈意见」字样做 kind 兜底
  //（泛名文件无 kind 字样，不受影响）。
  // 「问询函」在场时「反馈意见」是问询函的行文别名，不是注册反馈（2026-10-21
  // 炬申/中成/宏创 7 页实锤：抬头交易所、出具句为《审核问询函》，文件名却带
  // 「审核问询函…反馈意见」字样）——只有显式「注册环节反馈意见」或无问询函
  // 在场的反馈意见才判注册反馈。
  const mentionsInquiry = /问询函/.test(letterName) || /问询函/.test(fileName)
  const isFeedback =
    letterName.includes("注册环节反馈意见") ||
    (letterName.includes("反馈意见") && !mentionsInquiry) ||
    (/反馈意见/.test(fileName) && !mentionsInquiry)
  const isImplementation =
    (letterName.includes("落实函") || /落实函/.test(fileName)) && !isFeedback
  const roundKind: QaRoundMeta["roundKind"] = isFeedback
    ? "注册反馈"
    : isImplementation
      ? "落实函"
      : "审核问询函"
  const issuer: QaRoundMeta["issuer"] =
    isFeedback || /中国证券监督管理委员会|证监会/.test(sentence?.[1] ?? "")
      ? "证监会"
      : "交易所"

  // 首轮默认（2026-10-19 第三梯队，探针报告定案）：审核问询函族函名/正文
  // 均无轮次标记 = 首轮——上交所《审核问询函》首轮函通体无「第N轮」字样
  // 是制度性形态（全库实测 1,009 份 roundNo=null）。落实函/注册反馈保持
  // 如实 null（落实函对应的是第N轮问询的落实，轮次不可默认）。basis 记
  // 「首轮默认」可溯源，与真实识别区分。
  if (roundNo === null && roundKind === "审核问询函") {
    roundNo = 1
    basis = basis ? `${basis}+首轮默认` : "首轮默认（函名与正文均无轮次标记）"
  }

  return {
    roundNo,
    roundKind,
    issuer,
    basis: basis || "未识别（正文与文件名均无轮次信息）",
  }
}

// ---- W7.2 路径元数据 -----------------------------------------------------

/** deal 值域归一（schema §4：{IPO, 再融资, 重大资产重组}；raw 目录名不动）。 */
const DEAL_NORMALIZE: Record<string, string> = {
  IPO: "IPO",
  再融资: "再融资",
  重大资产重组: "重大资产重组",
  并购重组: "重大资产重组",
  购买资产: "重大资产重组",
  公开发行并上市: "IPO",
}

/**
 * `问答/{year}/{exchange}/{deal}/{board}/{status}/{company}/file.pdf`；
 * 北交所无板块层：`问答/{year}/北交所/{deal}/{status}/{company}/file.pdf`。
 * sourceIdentity 不含「问答/」时只回退 company=文件名 stem。
 */
export function extractPathMeta(sourceIdentity: string): QaPathMeta {
  const parts = sourceIdentity.split("/").filter(Boolean)
  const qaIdx = parts.findIndex((part) => part === "问答")
  if (qaIdx < 0) {
    const fileName = parts[parts.length - 1] ?? "source"
    return { company: fileName.replace(/\.[^/.]+$/, "") }
  }
  const rest = parts.slice(qaIdx + 1)
  // rest 尾部至少还有公司目录与文件名；不足时尽力降级
  const [year, exchange, deal, board, status, company] = rest
  const fileStem = (parts[parts.length - 1] ?? "source").replace(/\.[^/.]+$/, "")
  if (exchange === "北交所") {
    // 问答/2025/北交所/公开发行并上市/注册/世纪数码/file.pdf
    // B5（2026-10-22 审计 S6）：北交所无板块层，但北交所股票全部在
    // 「北交所」板块——board 直接补「北交所」，不再产出 428 页无 board
    // 的 question 页（存量由 A5④ 数据 PATCH 补齐）。
    const normalizedDeal = rest[2] ? (DEAL_NORMALIZE[rest[2]] ?? rest[2]) : undefined
    return {
      year,
      exchange,
      board: "北交所",
      deal: normalizedDeal,
      status: rest[3],
      company: rest[4] ?? fileStem,
      financingType: deriveFinancingType(normalizedDeal, sourceIdentity),
    }
  }
  return {
    year,
    exchange,
    deal: deal ? (DEAL_NORMALIZE[deal] ?? deal) : undefined,
    board,
    status,
    company: company ?? fileStem,
    financingType: deriveFinancingType(deal ? (DEAL_NORMALIZE[deal] ?? deal) : undefined, sourceIdentity),
  }
}

/** financing_type 细分（R3 §7.2，2026-10-24，零 LLM）：deal 的再融资细分
 *  由文件名关键词推导——路径只给到 deal 粒度（IPO/再融资/重大资产重组），
 *  「（北交所再融资·2025）」+ 文件名「向不特定对象发行可转换公司债券」
 *  类关键词交叉细化。值域（schema V1.5）：首发/再融资-定增/再融资-配股/
 *  再融资-向不特定对象发行/再融资-公开发行可转债/再融资-定向可转债/
 *  公开发行公司债。IPO→首发；重大资产重组不在融资类型轴上（null）。 */
export function deriveFinancingType(deal: string | undefined, sourceIdentity: string): string | null {
  if (!deal) return null
  if (deal === "IPO") return "首发"
  if (deal !== "再融资") return null
  const fileName = sourceIdentity.split("/").pop() ?? ""
  if (/优先股/.test(fileName)) return "再融资-优先股"
  if (/配股/.test(fileName)) return "再融资-配股"
  if (/可转换公司债券|可转债/.test(fileName)) {
    return /向特定对象/.test(fileName) ? "再融资-定向可转债" : "再融资-公开发行可转债"
  }
  if (/公司债/.test(fileName)) return "公开发行公司债"
  if (/向不特定对象发行/.test(fileName)) return "再融资-向不特定对象发行"
  if (/向特定对象发行/.test(fileName)) return "再融资-定增"
  return null
}

/** financing_type 题干兜底（99 方案批次 3.1，2026-10-30，零 LLM）：
 *  文件名规则（deriveFinancingType）对「补充法律意见书/会计师专项说明」类
 *  回复文书名不命中（同案例全部文书都可能无关键词，上能/中仑实测），此时
 *  用题干里「本次发行/本次募集」句式锚定融资表述——「本次」限定排除
 *  「隆利科技 2020 年向不特定对象发行可转债」这类他司/前次历史引用。
 *  匹配窗：`本次` 后 40 字（不含句号换行）内出现关键词，关键词判定序与
 *  deriveFinancingType 一致（优先股→配股→可转债→公司债→向不特定→向特定）。
 *  值域同 deriveFinancingType（schema V1.5 八类）。 */
export function deriveFinancingTypeFromBody(
  deal: string | undefined,
  body: string,
): string | null {
  if (deal !== "再融资") return null
  // 页内品种频次取众（平频取最早位置命中）。最早位置规则会被「历史文书原文
  // 里的本次」抢跑——上能实测：题干 15 处「本次向特定对象发行股票」混 1 处
  // 「本次向不特定对象发行可转换公司债券首次董事会决议日（2022年…）」（旧
  // 可转债文件原文自带「本次」字样），品种频次取众可吸收这类历史引用噪声。
  const KEYWORDS = [
    "优先股", "配股", "可转换公司债券", "可转债", "公司债", "向不特定对象发行", "向特定对象发行",
  ] as const
  const bucketOf: Record<string, string> = {
    优先股: "优先股", 配股: "配股", 可转换公司债券: "可转债", 可转债: "可转债",
    公司债: "公司债", 向不特定对象发行: "向不特定", 向特定对象发行: "定增",
  }
  const hits: Record<string, { count: number; firstPos: number; window: string }> = {}
  for (let i = body.indexOf("本次"); i >= 0; i = body.indexOf("本次", i + 1)) {
    const rest = body.slice(i + 2)
    const stop = rest.search(/[。\n]/)
    const window = stop >= 0 && stop <= 40 ? rest.slice(0, stop) : rest.slice(0, 40)
    for (const kw of KEYWORDS) {
      const p = window.indexOf(kw)
      if (p < 0) continue
      const bucket = bucketOf[kw]
      const h = (hits[bucket] ??= { count: 0, firstPos: i + p, window })
      h.count += 1
      if (i + p < h.firstPos) {
        h.firstPos = i + p
        h.window = window
      }
    }
  }
  const ranked = Object.entries(hits).sort(
    (a, b) => b[1].count - a[1].count || a[1].firstPos - b[1].firstPos,
  )
  const [bucket, h] = ranked[0] ?? ["", null as unknown as { window: string }]
  if (!bucket) return null
  const window: string = h.window
  if (bucket === "优先股") return "再融资-优先股"
  if (bucket === "配股") return "再融资-配股"
  if (bucket === "可转债") {
    return window.includes("向特定对象") ? "再融资-定向可转债" : "再融资-公开发行可转债"
  }
  if (bucket === "公司债") return "公开发行公司债"
  if (bucket === "向不特定") {
    return /可转换公司债券|可转债/.test(window) ? "再融资-公开发行可转债" : "再融资-向不特定对象发行"
  }
  return /可转换公司债券|可转债/.test(window) ? "再融资-定向可转债" : "再融资-定增"
}

// ---- W7.3 question 页生成 ------------------------------------------------

export interface QuestionPageBuild {
  /** FILE-block 协议文本（喂给 writeFileBlocks，复用全部写盘护栏）。 */
  fileBlocksText: string
  /** 逐字一致性自检失败清单（质量红线：非空即拒绝写盘）。 */
  verbatimViolations: string[]
  /** question 页数（不含 sources 摘要页）。 */
  pageCount: number
  /** section 页数（回复论证小节学习层）。 */
  sectionCount: number
}

const TITLE_MAX = 40

/** 词边界回退的保底长度：切点至少保留这么多字，防止把标题切太碎。 */
const TITLE_SAFE_CUT_MIN = 20

/** 数字/字母连续串成员（含千分位逗号与小数点；2026-11-05 挂账①补负号
 * ——国科天成「-12,969.72」整串含负号，否则词边界回退把「-」当非串
 * 成员、切点可落在「-」后产出「…-」尾巴）——切点落在这种串中间
 * 会产出「…业务 6」「…4,387」孤立数字尾巴（2026-11-04 缺陷①取证）。 */
const TITLE_ALNUM_RUN = /[\dA-Za-z,，.%-]/

/**
 * 题干截断的词边界回退（缺陷①，2026-11-04 方案 §2.3.A）。
 *
 * 旧版 ``slice(0, TITLE_MAX)`` 硬切不截词不截句读——ST联合题干切点
 * 恰好落在「6 个月」的「6」后面，产出「…业务 6」孤立数字尾巴（全库
 * title 尾数字形态 151 行 PG / 540 页 wiki）。规则：
 *
 * 1. 不超限原样返回；
 * 2. 窗口内向后找最近安全切点（CJK 句读或空白之后），保底 20 字；
 * 3. 切点落在数字/字母连续串中间 → 回退到该串起点之前；
 * 4. 截断补「…」——「这是截断标题」一眼可辨，消除数字结尾误读；
 * 5. 前 20 字无任何边界（极端形态）→ 40 处最近的非数字串位置，
 *    仍无则原样硬切（保底路径，与现状同形不更糟）。
 */
export function truncateTitleAtBoundary(cleaned: string): string {
  if (cleaned.length <= TITLE_MAX) return cleaned
  const window = cleaned.slice(0, TITLE_MAX)
  const isBoundary = (ch: string) => "。；：、，；;: ".includes(ch)
  // 步骤 2/3：最近的「边界之后、非数字串中间」切点
  for (let i = window.length; i >= TITLE_SAFE_CUT_MIN; i--) {
    const prev = window[i - 1] ?? ""
    if (!isBoundary(prev)) continue
    // 数字串中间判定：切点两侧同为数字串成员（「234,|499」「237,|802.69」
    // 的逗号是标点也是数字一部分）→ 回退到整个数字串起点之前
    const next = cleaned[i] ?? ""
    if (TITLE_ALNUM_RUN.test(prev) && next && TITLE_ALNUM_RUN.test(next)) {
      let j = i - 1
      while (j > TITLE_SAFE_CUT_MIN && TITLE_ALNUM_RUN.test(window[j - 1] ?? "")) j -= 1
      if (TITLE_ALNUM_RUN.test(window[j - 1] ?? "")) continue // 回退后仍不完整 → 弃
      return cleaned.slice(0, j).trim() + "…"
    }
    return cleaned.slice(0, i).trim() + "…"
  }
  // 步骤 5：窗口内无任何句读/空白边界 → 40 处最近的非数字串位置
  for (let i = window.length; i >= TITLE_SAFE_CUT_MIN; i--) {
    const prev = window[i - 1] ?? ""
    const next = cleaned[i] ?? ""
    if (!TITLE_ALNUM_RUN.test(prev) || !next || !TITLE_ALNUM_RUN.test(next)) {
      return cleaned.slice(0, i).trim() + "…"
    }
  }
  return window // 原样硬切（与现状同形，不更糟）
}

function yamlScalar(value: string): string {
  if (/[:#\[\]{},\"]/.test(value) || value.trim() !== value || !value) {
    return `"${yamlEscape(value)}"`
  }
  return value
}

const CN_DIGITS = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"]

function toChineseNumber(n: number): string | null {
  if (!Number.isInteger(n) || n < 1 || n > 99) return null
  if (n < 10) return CN_DIGITS[n]
  const tens = Math.floor(n / 10)
  const ones = n % 10
  const tensPart = tens === 1 ? "十" : CN_DIGITS[tens] + "十"
  return ones === 0 ? tensPart : tensPart + CN_DIGITS[ones]
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * 剥掉题干标题行自带的题号前缀（B4，2026-10-22 审计 S7）：questionTitle
 * 模板已拼「问题N·」，标题原文再带「7、」就会产出「第1轮·问题7·7、关于
 * 股份支付」的重复（2025 分册曾靠外部 PATCH 清洗 120 页，规则内置后新库
 * 免洗）。只剥「恰好以本题题号开头 + 显式分隔符/括号包裹」的形态——
 * 「7个交易日」这类数字开头的语义标题没有分隔符，不受影响；剥空则回退
 * 原文（宁可重复不可截没）。
 */
export function stripQuestionNoPrefix(stem: string, questionNo: number): string {
  const literals = [String(questionNo), toChineseNumber(questionNo) ?? ""]
  for (const literal of literals) {
    if (!literal) continue
    const escaped = escapeRegExp(literal)
    const patterns = [
      new RegExp(`^${escaped}\\s*[、．.,，:：]\\s*`),
      new RegExp(`^[（(]${escaped}[)）]\\s*`),
    ]
    for (const pattern of patterns) {
      const stripped = stem.replace(pattern, "")
      if (stripped !== stem && stripped.trim() !== "") return stripped.trim()
    }
  }
  return stem
}

/**
 * question 页 title：真标题本体（R3 2026-10-24 §六.4 治本）——不再拼
 * 「{轮次}·问题N·」前缀。轮次/题号信息由 frontmatter round_no/round_kind/
 * question_no 结构化字段承载，展示层无需从 title 里剥；此前「审核问询函·
 * 问题1·第1题」形态在消费端需展示层二次清洗（IPO 案例页实看实锤）。
 * 同文档内标题重复时由调用方 buildQuestionFileBlocks 消歧（回退
 * 「问题N·」前缀），questionTitle 本身保持单题纯标题。
 */
/** 导出供存量重算管道复用（缺陷①B，2026-11-04）：与 questionTitle
 *  同链（剥题号前缀 → 词边界截断），重算脚本对题干块直调。 */
export function retitleFromStem(stem: string, questionNo: number): string {
  const cleaned = stripQuestionNoPrefix(stem, questionNo)
  return truncateTitleAtBoundary(cleaned).trim() || `第${questionNo}题`
}

export function questionTitle(question: SplitQuestion): string {
  // 缺陷①（2026-11-04）：slice(0,40) 硬切改为词边界回退——切点不落
  // 数字串中间，截断补「…」。sectionTitleFull/questionSummaryTitle
  // 同日实勘为纯拼接无 40 截断，不受此缺陷影响，不改。
  return retitleFromStem(question.title, question.questionNo)
}

/**
 * 生成 sources 摘要页 + 每题一页的 FILE blocks。正文严格原文切片，
 * 生成后逐题对 raw md 全文做 includes() 自检（质量红线：切块即复制、
 * 零改写零删减；violations 非空时调用方必须拒绝写盘）。
 *
 * tags（可选，L6 兜底通道打标搭车）：仅写入 question 页 frontmatter
 * （section/sources 页留白——规则通道文档 tags 仍留白，全量打标生产
 * 归 ipoanswer 批次 2A 经 W4 回写）。元素含「:」（inquiry-stage: 等
 * 轴前缀），统一双引号包裹保证 YAML 与 Rust/TS 两侧子集解析器语义一致。
 */
export function buildQuestionFileBlocks(
  sourceText: string,
  split: QaSplitResult,
  pathMeta: QaPathMeta,
  roundMeta: QaRoundMeta,
  sourceIdentity: string,
  slug: string,
  tags: string[] = [],
): QuestionPageBuild {
  const violations: string[] = []
  const blocks: string[] = []
  // 行尾归一：切片用 \r?\n 拆行再 join("\n")，对 CRLF 原文断言子串前必须
  // 同样归一——\r 是编码细节，不是内容字符；内容层面的逐字红线不变。
  const normalizedSource = sourceText.replace(/\r\n/g, "\n")

  // sources 摘要页（writeFileBlocks 会把 wiki/sources/ 前缀重定向到 canonical slug 路径）
  const summaryLines = [
    "type: source",
    `title: "${yamlEscape(questionSummaryTitle(pathMeta, roundMeta, sourceIdentity))}"`,
    "parser: qa-split",
    `split_summary: "${yamlEscape(splitSummaryKey(split))}"`,
    "tags: []",
  ]
  // M5.3（2026-11-02）：源页挂题号索引——related 回指各 question 页，
  // 前端「原文壳」据此直达题目列表（此前源页是 950B 壳无任何出口）。
  const relatedLines = split.questions.map(
    (q) => `  - "[[${slug}-q${q.questionNo}]]"`,
  )
  if (relatedLines.length > 0) {
    summaryLines.push("related:", ...relatedLines)
  }
  blocks.push(
    `---FILE: wiki/sources/${slug}.md---\n---\n${summaryLines.join("\n")}\n---\n\n` +
      `# ${questionSummaryTitle(pathMeta, roundMeta, sourceIdentity)}\n\n` +
      `本来源为问答函类文档，已按 qa-split 规则逐题拆分至 \`wiki/questions/\`（识别通道 ${split.channel}，共 ${split.questions.length} 题）。\n\n` +
      `- 来源文件：${sourceIdentity}\n- 轮次：${roundMeta.roundKind}${roundMeta.roundNo ? `（第${roundMeta.roundNo}轮）` : "（轮次未识别）"}\n- 识别依据：${roundMeta.basis}\n\n` +
      `> 题目与回复原文逐字转录于各 question 页；本页仅为来源索引，不承载题目内容。\n---END FILE---`,
  )

  // R3 批内消歧：纯标题制（questionTitle 不再带题号前缀）下，同文档两题
  // 撞标题时第二个起回退「问题N·」前缀——文件名唯一性不受影响，title
  // 只承担展示区分。
  const titleCounts = new Map<string, number>()
  for (const question of split.questions) {
    const base = questionTitle(question)
    const seen = titleCounts.get(base) ?? 0
    titleCounts.set(base, seen + 1)
  }
  const titleUsed = new Map<string, number>()

  for (const question of split.questions) {
    // 质量红线自检：题目/回复必须是 raw md 全文（行尾归一后）的连续子串
    if (!normalizedSource.includes(question.questionText)) {
      violations.push(`q${question.questionNo}: 题目正文不是原文连续子串`)
    }
    if (question.replyText && !normalizedSource.includes(question.replyText)) {
      violations.push(`q${question.questionNo}: 回复正文不是原文连续子串`)
    }

    const baseTitle = questionTitle(question)
    const dupRank = titleUsed.get(baseTitle) ?? 0
    titleUsed.set(baseTitle, dupRank + 1)
    const finalTitle =
      (titleCounts.get(baseTitle) ?? 1) > 1 && dupRank > 0
        ? `问题${question.questionNo}·${baseTitle}`
        : baseTitle

    const fm: string[] = [
      "type: question",
      `title: ${yamlScalar(finalTitle)}`,
      `company: ${yamlScalar(pathMeta.company)}`,
    ]
    if (pathMeta.exchange) fm.push(`exchange: ${yamlScalar(pathMeta.exchange)}`)
    if (pathMeta.board) fm.push(`board: ${yamlScalar(pathMeta.board)}`)
    if (pathMeta.deal) fm.push(`deal: ${yamlScalar(pathMeta.deal)}`)
    if (pathMeta.year) fm.push(`year: ${yamlScalar(pathMeta.year)}`)
    if (pathMeta.status) fm.push(`status: ${yamlScalar(pathMeta.status)}`)
    // 批次 3.1：文件名规则未命中（补充法律意见书类文书名）时题干「本次」句式兜底
    const financingType =
      pathMeta.financingType ??
      deriveFinancingTypeFromBody(pathMeta.deal, question.questionText)
    if (financingType) {
      fm.push(`financing_type: ${yamlScalar(financingType)}`)
    }
    if (roundMeta.roundNo !== null) fm.push(`round_no: ${roundMeta.roundNo}`)
    fm.push(
      `round_kind: ${yamlScalar(roundMeta.roundKind)}`,
      `issuer: ${yamlScalar(roundMeta.issuer)}`,
      `question_no: ${question.questionNo}`,
      `split_channel: ${question.channel}`,
      tags.length > 0
        ? `tags: [${tags.map((tag) => `"${yamlEscape(tag)}"`).join(", ")}]`
        : "tags: []",
      // F1（2026-10-12 审查）：related 回挂 sources 摘要页（wikilink 进图，
      // question→source 建边，与 section 页 related 回挂 question 同构）；
      // sources 填来源文件路径（schema.md V1.3 question 专用字段样例形态，
      // 纯路径非 wikilink——溯源走平键，图谱边走 related）。
      // wikilink 必须用纯文件名（无目录前缀）：schema.md V1.3 source 页样例
      // 即此形态，且 api_server resolve_link 只按节点 id（文件名）解析——
      // 带 sources/ 前缀的链接解析落空，图谱建不出边（2026-10-12 小批量实测）。
      `related: ["[[${slug}]]"]`,
      `sources: ["${yamlEscape(sourceIdentity)}"]`,
    )
    if (question.questionNoIsGenerated) {
      fm.push("question_no_generated: true")
    }
    // 批次 3.5（M14，2026-10-30）：拆题元数据迁 frontmatter 结构化字段——
    // 正文纯净原则（结构化信息一律 frontmatter），行号区间供 M5 回复段
    // 回补/M4 排查复用；正文尾部的「## 拆题元数据」段不再产出。
    fm.push(
      "split:",
      `  channel: ${question.channel}`,
      `  question_range: [${question.startLine + 1}, ${(question.replyStartLine ?? question.endLine + 1)}]`,
      ...(question.replyStartLine === null
        ? ["  reply_range: null"]
        : [`  reply_range: [${question.replyStartLine + 1}, ${question.endLine + 1}]`]),
      ...(question.questionNoIsGenerated
        ? []
        : [`  source_no: ${question.questionNo}`]),
      `  source_doc: "${yamlEscape(sourceIdentity)}"`,
    )

    const body =
      `## 监管问题\n\n${question.questionText}\n\n` +
      (question.replyText
        ? `## 回复\n\n${question.replyText}\n\n`
        : "")

    blocks.push(
      `---FILE: wiki/questions/${slug}-q${question.questionNo}.md---\n---\n${fm.join("\n")}\n---\n\n${body}---END FILE---`,
    )
  }

  // ── W7.7 section 页：回复论证小节学习层 ──
  // question 页保持全量逐字（事实源不动）；实质小节（≥SECTION_MIN_CHARS）
  // 独立成页，related 回挂所属 question。短小节内容不丢——留在 question 页。
  let sectionCount = 0
  for (const question of split.questions) {
    if (!question.replyText) continue
    const sections = splitReplySections(question.replyText, question.questionNo)
    for (const section of sections) {
      if (!normalizedSource.includes(section.text)) {
        violations.push(
          `q${question.questionNo}-s${section.sectionNo}: 小节正文不是原文连续子串`,
        )
      }
      const sectionFm: string[] = [
        "type: section",
        `title: ${yamlScalar(sectionTitleFull(question, section, roundMeta))}`,
        `company: ${yamlScalar(pathMeta.company)}`,
      ]
      if (pathMeta.exchange) sectionFm.push(`exchange: ${yamlScalar(pathMeta.exchange)}`)
      if (pathMeta.board) sectionFm.push(`board: ${yamlScalar(pathMeta.board)}`)
      if (pathMeta.deal) sectionFm.push(`deal: ${yamlScalar(pathMeta.deal)}`)
      if (pathMeta.year) sectionFm.push(`year: ${yamlScalar(pathMeta.year)}`)
      if (pathMeta.status) sectionFm.push(`status: ${yamlScalar(pathMeta.status)}`)
      if (roundMeta.roundNo !== null) sectionFm.push(`round_no: ${roundMeta.roundNo}`)
      sectionFm.push(
        `round_kind: ${yamlScalar(roundMeta.roundKind)}`,
        `issuer: ${yamlScalar(roundMeta.issuer)}`,
        `question_no: ${question.questionNo}`,
        `section_no: ${section.sectionNo}`,
        "tags: []",
        `related: ["[[${slug}-q${question.questionNo}]]"]`,
      )
      const sectionBody =
        `${section.text}\n\n## 小节元数据\n\n` +
        `- 所属题目: [[${slug}-q${question.questionNo}]]\n` +
        `- 来源文档: ${sourceIdentity}\n`
      blocks.push(
        `---FILE: wiki/sections/${slug}-q${question.questionNo}-s${section.sectionNo}.md---\n---\n${sectionFm.join("\n")}\n---\n\n${sectionBody}---END FILE---`,
      )
      sectionCount += 1
    }
  }

  return {
    fileBlocksText: blocks.join("\n\n"),
    verbatimViolations: violations,
    pageCount: split.questions.length,
    sectionCount,
  }
}

function sectionTitleFull(
  question: SplitQuestion,
  section: SplitSection,
  roundMeta: QaRoundMeta,
): string {
  const round = roundMeta.roundNo ? `第${roundMeta.roundNo}轮` : roundMeta.roundKind
  return `${round}·问题${question.questionNo}·${section.title}`
}

/** M5.1 改动 2（2026-11-02）：源页标题带文书名——旧模板 92% 产出
 *  「公司 第N轮审核问询函」，专项意见书被题名成问询函，搜索命中而
 *  不可识别（鼎佳精密实测）。docShort 从文件名清洗（纯正则零 LLM）：
 *  去扩展名 → 去「{company}：/／」前缀 → 折叠空白。对齐库内归纳式
 *  通道的好形态（「蘅东光·广东华商律师事务所补充法律意见书（一）」）。
 *  同名消歧：清洗保留括号序号（（一）（二））覆盖绝大多数；真同名
 *  （光电股份族）由存量修复脚本全库消歧 + M5.4 对账防线「同 case 同轮
 *  零撞名」兜底——本函数不做 IO。 */
export function docShortFromSourceIdentity(
  sourceIdentity: string,
  company: string,
): string {
  let stem = sourceIdentity.split("/").pop() ?? ""
  stem = stem.replace(/\.md$/i, "").replace(/\.pdf$/i, "").trim()
  const prefixRe = new RegExp(`^${escapeRegExp(company)}\\s*[:：]\\s*`)
  stem = stem.replace(prefixRe, "")
  stem = stem.replace(/\s+/g, " ").trim()
  return stem
}

function questionSummaryTitle(
  pathMeta: QaPathMeta,
  roundMeta: QaRoundMeta,
  sourceIdentity = "",
): string {
  // 无轮号时只拼一次 roundKind
  const round = roundMeta.roundNo ? `第${roundMeta.roundNo}轮·` : ""
  const docShort = docShortFromSourceIdentity(sourceIdentity, pathMeta.company)
  if (docShort) {
    return `${pathMeta.company}·${docShort}（${round}${roundMeta.roundKind}）`
  }
  // 文书名清洗落空（空 sourceIdentity 等）：回退旧形态（不带机读后缀）
  return `${pathMeta.company} ${round}${roundMeta.roundKind}`
}

/** 机读摘要（通道·题数）——从 title 挪进 frontmatter 平键
 *  split_summary（title 面向用户，机读信息不占标题位）。 */
function splitSummaryKey(split: QaSplitResult): string {
  return `${split.channel}·${split.questions.length}题`
}

function yamlEscape(value: string): string {
  // G3（2026-10-12 审查）：双引号 YAML 串里 `\` 与 `"` 都必须转义——js-yaml
  // 对 `\`+字母 的非法转义直接解析失败（整页 frontmatter 坏），Rust 子集
  // 解析器却原样保留。顺序必须先 `\` 后 `"`：反过来会把转义产生的 `\` 再
  // 翻倍。title 来自任意原文行，两类字符都可能命中。
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

// ---- W7.7 回复论证小节拆分（section 层） --------------------------------
//
// 回复正文按小节组织（「## N、」「(一)」「一、」「## （1）」…），每个小节是
// 一个独立论证单元（风险分析/产能消化论证/客户可持续性论证——2026-10-10
// 咩咩拍板：有价值的结构单元都要拆分学习，不只按题拆）。question 页仍是
// 题目层事实源（全量逐字不动）；section 页是小节学习层：实质小节（≥阈值
// 字符）独立成页，related 回挂所属 question 页；短小节内容不丢——留在
// question 页正文里。

/** 小节正文低于此值不成页（内容仍在 question 页，只是没有独立学习单元）。 */
export const SECTION_MIN_CHARS = 120

const SECTION_RESERVED = /^(?:page\s*\d+|回复|监管问题|拆题元数据)/i

/**
 * 带序号的小节标题行（md 标题 + 序号）。MinerU 输出里无序号的 `##` 行
 * 遍地都是（连封面地址都是 `##`，全库 27 万行），**序号才是结构信号**。
 * 四种序号形态：`## N、` / `## N.` / `## （N）` / `## （一）` / `## 一、`。
 */
const SECTION_NUMBERED = /^#{1,4}\s*(?:([0-9]{1,3})\s*[、.]|[（(]([0-9]{1,3}|[一二三四五六七八九十]{1,3})[)）]|[（(]?([一二三四五六七八九十]{1,3})[)）]\s*[、.])/

type SectionShape = "arabic" | "arabic-paren" | "cn-paren" | "cn-dun"

interface SectionCandidate {
  line: number
  no: number
  shape: SectionShape
}

function classifySectionLine(line: string): { no: number; shape: SectionShape } | null {
  if (SECTION_RESERVED.test(line.replace(/^#{1,4}\s*/, ""))) return null
  const m = SECTION_NUMBERED.exec(line)
  if (!m) return null
  if (m[1]) return { no: parseInt(m[1], 10), shape: "arabic" }
  if (m[2]) {
    const no = cn2num(m[2])
    return no > 0 ? { no, shape: /[0-9]/.test(m[2]) ? "arabic-paren" : "cn-paren" } : null
  }
  if (m[3]) {
    const no = cn2num(m[3])
    return no > 0 ? { no, shape: "cn-dun" } : null
  }
  return null
}

export interface SplitSection {
  questionNo: number
  /** 题内小节序号（1 起）。 */
  sectionNo: number
  /** 小节标题（边界行去标记截断）。 */
  title: string
  /** 小节正文（含标题行，逐字转录）。 */
  text: string
}

/**
 * 把一段回复按小节边界切块。算法（2026-10-10 爆量收口后的治本版）：
 * 1. 只认「md 标题+序号」行（无序号的 ## 行是 MinerU 噪声，全库 27 万行）；
 * 2. 序号必须构成**递增序列**——真小节序号 1,2,3…递增，正文里散落的
 *    `## 2、xxx` 引用行构不成序列（与题号 monotonic 同一防线）；
 * 3. 每题取覆盖行数最多的**主导序号形态**切分——嵌套的三级编号
 *    （（1）（2）…）归入所属二级小节正文，不再各自成节；
 * 4. 小节正文 ≥ SECTION_MIN_CHARS 才成页（内容不丢，留在 question 页）。
 */
export function splitReplySections(replyText: string, questionNo: number): SplitSection[] {
  const lines = replyText.split(/\r?\n/)
  const candidates: SectionCandidate[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const parsed = classifySectionLine(lines[i])
    if (parsed && parsed.no > 0 && parsed.no <= 99) {
      candidates.push({ line: i, ...parsed })
    }
  }
  if (candidates.length === 0) return []

  const byShape = new Map<SectionShape, SectionCandidate[]>()
  for (const candidate of candidates) {
    const list = byShape.get(candidate.shape) ?? []
    list.push(candidate)
    byShape.set(candidate.shape, list)
  }

  // 每形态取递增序列，选覆盖最多行的主导形态
  let best: { shape: SectionShape; kept: SectionCandidate[] } | null = null
  for (const [shape, list] of byShape) {
    const kept: SectionCandidate[] = []
    let last = 0
    for (const candidate of list) {
      if (candidate.no > last) {
        kept.push(candidate)
        last = candidate.no
      }
    }
    // 序列至少 2 项才可信（单行不成序列）
    if (kept.length >= 2 && (!best || kept.length > best.kept.length)) {
      best = { shape, kept }
    }
  }
  if (!best) return []

  const out: SplitSection[] = []
  const { kept } = best
  for (let idx = 0; idx < kept.length; idx += 1) {
    const start = kept[idx].line
    const end = idx + 1 < kept.length ? kept[idx + 1].line - 1 : lines.length - 1
    const text = lines.slice(start, end + 1).join("\n").trimEnd()
    if (text.length < SECTION_MIN_CHARS) continue
    out.push({
      questionNo,
      sectionNo: out.length + 1,
      title: sectionTitle(lines[start]),
      text,
    })
  }
  return out
}

function sectionTitle(boundaryLine: string): string {
  return boundaryLine
    .replace(/^#{1,4}\s*/, "")
    .replace(/^[（(][0-9一二三四五六七八九十]{1,3}[)）]\s*/, "")
    .replace(/^[一二三四五六七八九十]{1,3}\s*[、.．]\s*/, "")
    .replace(/^[0-9]{1,2}\s*[、.．]\s*/, "")
    .slice(0, 40)
    .trim() || "小节"
}

// ---- L6 难例 LLM 兜底通道（2026-10-12 混合架构） -------------------------
//
// 规则通道（H1-H5）拆不出题的难例（T1 manualQueue / T2 单题意见书）交给
// LLM 识别题边界。LLM 的判定权是受限的：它只输出「题干起始行的原文逐字
// 摘录 + 题号 + 标签」，输出必须通过下面的机械校验器（逐字定位 / 序列
// 严格递增允许跳号 / 覆盖性）才被采信；切块仍复用 cutQuestions——
// 题目与回复正文始终是原文切片，LLM 永远不碰正文（质量红线不降级）。

/**
 * L6 输出的标签值域（2026-10-12 咩咩拍板收紧）：inquiry-stage 必须取
 * ipoanswer 附录 B 全量枚举——3 个光杆树根 + 23 个「根·大类标签」叶值，
 * 细目不再允许 LLM 自由生成；根名与附录 B 统一（证监会注册审核**问询**）。
 */
const INQUIRY_STAGE_ROOTS = [
  "交易所首轮问询",
  "交易所后续问询",
  "证监会注册审核问询",
]

/** 附录 B1 二级大类标签字面（「后续·问询分类」分类维度拆 3 值）。 */
const INQUIRY_STAGE_LEAVES: Record<string, readonly string[]> = {
  交易所首轮问询: [
    "首轮·板块定位",
    "首轮·业务模式",
    "首轮·财务数据真实性",
    "首轮·关联交易",
    "首轮·核心技术",
    "首轮·合规经营",
    "首轮·信息披露",
    "首轮·募投项目",
  ],
  交易所后续问询: [
    "后续·问询分类：年报问询",
    "后续·问询分类：重组问询",
    "后续·问询分类：IPO问询",
    "后续·财务数据真实性与业绩质量",
    "后续·业务逻辑与持续经营能力",
    "后续·关联交易与资金往来",
    "后续·信息披露与合规性",
    "后续·重大资产重组与并购",
    "后续·核心技术来源·科创企业",
  ],
  "证监会注册审核问询": [
    "注册·板块定位于产业政策",
    "注册·财务真实性与业绩质量",
    "注册·公司治理与合规性",
    "注册·业务与持续经营能力",
    "注册·信息披露与文件合规性",
    "注册·会后事项与重大变化",
  ],
}

/** 合法 inquiry-stage 取值全集（3 光杆根 + 23 叶值），枚举外一律丢弃。 */
export const INQUIRY_STAGE_ALLOWED_VALUES: readonly string[] = [
  ...INQUIRY_STAGE_ROOTS,
  ...INQUIRY_STAGE_ROOTS.flatMap((root) =>
    (INQUIRY_STAGE_LEAVES[root] ?? []).map((leaf) => `${root}·${leaf}`),
  ),
]

/** 批次 3.2 双轴拆分：主轴 8 主题平铺值 + detail 轴 13 细分平铺值。
 *  单一事实源=ipoanswer core/kb/inquiry_stages.py（管线侧同步副本），
 *  V1.3 树形态过渡期并认（tag-vocabulary.ts 同款口径）。 */
export const INQUIRY_STAGE_MAJOR_FLAT: readonly string[] = [
  "板块定位", "业务模式", "财务数据真实性", "关联交易",
  "核心技术", "合规经营", "信息披露", "募投项目",
]
export const INQUIRY_STAGE_DETAIL_FLAT: readonly string[] = [
  "问询分类", "财务数据真实性与业绩质量", "业务逻辑与持续经营能力",
  "关联交易与资金往来", "信息披露与合规性", "重大资产重组与并购",
  "核心技术来源·科创企业", "板块定位于产业政策", "财务真实性与业绩质量",
  "公司治理与合规性", "业务与持续经营能力", "信息披露与文件合规性",
  "会后事项与重大变化",
]

/** topic 主题词护栏上限（防 LLM 幻觉撒标签；超限丢弃记明细，不拒题）。 */
const MAX_FALLBACK_TOPIC_TAGS = 6

export interface LlmFallbackCandidate {
  /** 原文题号；单题意见书允许小数（6.1 / 7.3 形态）。 */
  no: number
  /** 题干起始行的原文逐字摘录（LLM 数行号不可靠，用摘录做机械定位）。 */
  firstLine: string
  titleHint?: string
}

export interface LlmFallbackDeps {
  /** LLM 请求（ingest 侧 = streamChatWithContinuation 包装；测试 = mock）。 */
  callLlm: (systemPrompt: string, userPrompt: string) => Promise<string>
  signal?: AbortSignal
}

export interface LlmFallbackUsage {
  promptChars: number
  completionChars: number
  durationMs: number
  retries: number
}

export interface LlmFallbackOutcome {
  /** questions 为空 = 兜底失败（manualQueue 带 llm-fallback 原因）。 */
  split: QaSplitResult
  /** 通过值域校验的标签（question 页 frontmatter tags 实值）。 */
  tags: string[]
  usage: LlmFallbackUsage
  /** 校验作废/修剪/标签丢弃明细（失败可见，进 report detail）。 */
  detail: string
}

const LLM_FALLBACK_SYSTEM_PROMPT = [
  "你是问询函类文档的题边界识别器。给定一份审核问询回复/意见书的全文 Markdown，",
  "你的唯一任务：找出每一道问询题的题干起始行，并逐字摘录该行原文。",
  "",
  "输出严格 JSON（不要任何其他文字、不要 markdown 围栏）：",
  '{"questions": [{"no": <题号，数字，允许小数如 7.3>, "first_line": "<题干起始行原文逐字摘录>", "title_hint": "<不超过20字的主题>"}], "tags": ["<标签>"]}',
  "",
  "规则：",
  "1. first_line 必须逐字复制原文中该行的完整文字（含题号），不得改写、缩略、增删字符。",
  "2. 题干起始行 = 问题标题行（如「4.关于成本核算的准确性与采购公允性」「问题 7、关于关联交易」「一、关于行业代表性」）；",
  "   不含封面、目录页、函件出具句、回复正文。",
  "3. no 用原文题号（会计师/律师文件可能只覆盖部分题，跳号是正常的）；无题号形态（单题意见书）用「主.子」形态（如 7.3）。",
  "4. tags：一道题可同时属于多个大类，符合的都要挂（多标签，不设数量上限），前缀必须是 inquiry-stage: / inquiry-stage-detail: / topic:。",
  "   inquiry-stage 是主题粗轴（8 值闭集，每题至少 1 个）；inquiry-stage-detail 是问询细分轴（13 值闭集，轮次细分适用才挂）：",
  "   inquiry-stage:板块定位 | 业务模式 | 财务数据真实性 | 关联交易 | 核心技术 | 合规经营 | 信息披露 | 募投项目",
  "   inquiry-stage-detail:问询分类 | 财务数据真实性与业绩质量 | 业务逻辑与持续经营能力 | 关联交易与资金往来 | 信息披露与合规性 | 重大资产重组与并购 | 核心技术来源·科创企业 | 板块定位于产业政策 | 财务真实性与业绩质量 | 公司治理与合规性 | 业务与持续经营能力 | 信息披露与文件合规性 | 会后事项与重大变化",
  "   （99 方案批次 3.2 双轴拆分；旧轮次前缀形态一律不再输出）",
  "   topic: 后接主题词（如 topic:收入确认），最多 6 个。",
  "",
  "示例（千分一二轮裸行形态，MinerU 对部分题边界不加 ## 标题）：",
  "原文节选：",
  "  4.关于成本核算的准确性与采购公允性",
  "  首轮问询回复及申报材料显示：",
  "输出片段：{\"no\": 4, \"first_line\": \"4.关于成本核算的准确性与采购公允性\", \"title_hint\": \"成本核算与采购公允性\"}",
  "",
  "示例（单题法律意见书，整文档只覆盖问询函第 7 题）：",
  "输出片段：{\"no\": 7, \"first_line\": \"<第 7 题题干起始行原文>\", \"title_hint\": \"...\"}",
].join("\n")

/** 从 LLM 输出剥围栏/杂文，解析 JSON；失败返回 null（不重试——解析失败不是瞬时故障）。 */
function parseLlmFallbackResponse(raw: string): {
  questions: LlmFallbackCandidate[]
  tags: unknown
} | null {
  const stripped = raw.replace(/```(?:json)?/gi, "").trim()
  const start = stripped.indexOf("{")
  const end = stripped.lastIndexOf("}")
  if (start < 0 || end <= start) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const obj = parsed as { questions?: unknown; tags?: unknown }
  if (!Array.isArray(obj.questions)) return null
  const questions: LlmFallbackCandidate[] = []
  for (const item of obj.questions) {
    if (!item || typeof item !== "object") continue
    const { no, first_line: firstLine } = item as { no?: unknown; first_line?: unknown }
    // L3：+1 是题号上界放一号的容差——LLM 对题号略有出入时不在此处立刻
    // 作废，序列严格递增校验兜底；MAX_QUESTION_NO 是规则通道的 299 上限。
    if (typeof no !== "number" || !Number.isFinite(no) || no <= 0 || no > MAX_QUESTION_NO + 1) continue
    // L1：摘录过短（<6 字符）在前缀/包含定位下极易误命中无关行，
    // 直接作废该候选。
    if (typeof firstLine !== "string" || firstLine.trim().length < 6) continue
    questions.push({
      no,
      firstLine,
      titleHint: typeof (item as { title_hint?: unknown }).title_hint === "string"
        ? ((item as { title_hint?: string }).title_hint ?? undefined)
        : undefined,
    })
  }
  return { questions, tags: obj.tags }
}

/**
 * 标签值域校验（plan §5，2026-10-12 收紧）：inquiry-stage 完整值必须取
 * 附录 B 全量枚举（光杆根或「根·大类」叶值），枚举外丢弃 + 记明细，
 * 不拒题；topic: 主题词符合的全收（多标签），护栏上限 6 个；重复静默去重。
 */
export function sanitizeFallbackTags(tags: unknown): { kept: string[]; dropped: string[] } {
  if (!Array.isArray(tags)) return { kept: [], dropped: [] }
  const kept: string[] = []
  const dropped: string[] = []
  const seen = new Set<string>()
  let topicCount = 0
  for (const tag of tags) {
    if (typeof tag !== "string" || !tag.trim()) continue
    const value = tag.trim()
    if (seen.has(value)) continue
    if (value.startsWith("inquiry-stage:")) {
      // 批次 3.2 双轴：主轴认 8 主题平铺值（V1.3 树形态过渡期并认）
      const v = value.slice("inquiry-stage:".length)
      if (INQUIRY_STAGE_ALLOWED_VALUES.includes(v) || INQUIRY_STAGE_MAJOR_FLAT.includes(v)) {
        kept.push(value)
        seen.add(value)
      } else {
        dropped.push(value)
      }
    } else if (value.startsWith("inquiry-stage-detail:")) {
      if (INQUIRY_STAGE_DETAIL_FLAT.includes(value.slice("inquiry-stage-detail:".length))) {
        kept.push(value)
        seen.add(value)
      } else {
        dropped.push(value)
      }
    } else if (value.startsWith("topic:") && value.length > "topic:".length + 1) {
      if (topicCount < MAX_FALLBACK_TOPIC_TAGS) {
        kept.push(value)
        seen.add(value)
        topicCount += 1
      } else {
        dropped.push(value)
      }
    } else {
      dropped.push(value)
    }
  }
  return { kept, dropped }
}

/**
 * 机械校验器（plan §4，不信 LLM 的部分）：
 * 1. 逐字定位——first_line 必须在原文某行中逐字存在（整行相等优先，
 *    其次行前缀，最后行内包含），目录点线行不参与定位；多处命中取首个
 *    未被占用的行；
 * 2. 序列合法——边界按行号排序后题号必须**严格递增、允许跳号**（会计师
 *    文件只含部分题，欣战江 [1,2,4] 实证合法；同题号/回退题号视为 LLM
 *    幻觉，修剪并记明细）；
 * 3. 覆盖性——首边界前内容 >5% 只 warn 不拒（封面/目录容差）。
 */
function validateLlmBoundaries(
  lines: string[],
  candidates: LlmFallbackCandidate[],
): { markers: LineMarker[]; detail: string[] } {
  const detail: string[] = []
  const claimed = new Set<number>()
  const located: LineMarker[] = []

  for (const candidate of candidates) {
    const needle = candidate.firstLine.trim()
    let hit = -1
    let mode = ""
    for (let i = 0; i < lines.length; i += 1) {
      if (claimed.has(i)) continue
      // L1（2026-10-12 审查）：目录点线行不是题边界（与 bodyQuestionMarkers
      // 同一排除口径）——LLM 摘录撞目录行（点线页码形态）时三级定位全部
      // 落空，由作废路径处理，不让封面/目录混进题目区。
      if (TOC_DOT_LEADER.test(lines[i])) continue
      const trimmed = lines[i].trim()
      if (trimmed === needle) {
        hit = i
        mode = "整行"
        break
      }
      if (hit < 0 && trimmed.startsWith(needle)) {
        hit = i
        mode = "行前缀"
      }
    }
    if (hit < 0) {
      // 第三优先级：行内包含（低置信，最后再扫一遍）
      for (let i = 0; i < lines.length; i += 1) {
        if (claimed.has(i)) continue
        if (TOC_DOT_LEADER.test(lines[i])) continue
        if (lines[i].includes(needle)) {
          hit = i
          mode = "行内包含"
          break
        }
      }
    }
    if (hit < 0) {
      detail.push(`q${candidate.no}: first_line 未在原文逐字定位，作废`)
      continue
    }
    claimed.add(hit)
    located.push({ line: hit, no: candidate.no })
    if (mode !== "整行") detail.push(`q${candidate.no}: first_line 以「${mode}」方式定位`)
  }

  located.sort((a, b) => a.line - b.line)
  const markers: LineMarker[] = []
  let last = 0
  for (const marker of located) {
    if (marker.no > last) {
      markers.push(marker)
      last = marker.no
    } else {
      detail.push(`q${marker.no}: 题号非递增（前值 ${last}），修剪`)
    }
  }

  if (markers.length > 0) {
    const charsBefore = lines.slice(0, markers[0].line).join("\n").length
    const total = lines.join("\n").length
    if (total > 0 && charsBefore / total > 0.05) {
      detail.push(`首边界前内容占 ${Math.round((charsBefore / total) * 100)}%（>5%，封面/目录容差内 warn）`)
    }
  }
  return { markers, detail }
}

/**
 * L6 兜底编排（plan 2026-10-12-llm-fallback-split §3-§5）。LLM 输出经
 * 机械校验器过滤后复用 cutQuestions 切块——verbatim 红线自动生效
 * （buildQuestionFileBlocks 的 includes 自检）。失败（调用异常重试一次
 * 仍败 / 解析失败 / 校验后 0 题）返回 0 题的 QaSplitResult，
 * manualQueue 带 llm-fallback 原因，由调用方落人工队列。
 */
export async function llmFallbackSplit(
  text: string,
  kind: QaDocumentKind,
  deps: LlmFallbackDeps,
): Promise<LlmFallbackOutcome> {
  const startedAt = Date.now()
  const usage: LlmFallbackUsage = { promptChars: 0, completionChars: 0, durationMs: 0, retries: 0 }
  const fail = (reason: string): LlmFallbackOutcome => {
    usage.durationMs = Date.now() - startedAt
    return {
      split: {
        kind,
        channel: "L6",
        questions: [],
        tocNumbers: tocQuestionNumbers(text),
        manualQueue: `llm-fallback-failed: ${reason}`,
      },
      tags: [],
      usage,
      detail: reason,
    }
  }

  let raw = ""
  try {
    const userPrompt = text
    usage.promptChars = LLM_FALLBACK_SYSTEM_PROMPT.length + userPrompt.length
    raw = await deps.callLlm(LLM_FALLBACK_SYSTEM_PROMPT, userPrompt)
    usage.completionChars = raw.length
  } catch (err) {
    if (deps.signal?.aborted) throw err
    // transient（网络/超时/5xx）重试 1 次；仍败 → 显式人工队列
    try {
      usage.retries = 1
      raw = await deps.callLlm(LLM_FALLBACK_SYSTEM_PROMPT, text)
      usage.completionChars = raw.length
    } catch (retryErr) {
      if (deps.signal?.aborted) throw retryErr
      const message = retryErr instanceof Error ? retryErr.message : String(retryErr)
      return fail(`LLM 调用重试后仍失败：${message}`)
    }
  }

  const parsed = parseLlmFallbackResponse(raw)
  if (!parsed) return fail("LLM 输出无法解析为约定 JSON")
  if (parsed.questions.length === 0) return fail("LLM 未识别出任何题边界")

  const lines = text.split(/\r?\n/)
  const { markers, detail } = validateLlmBoundaries(lines, parsed.questions)
  const { kept: tags, dropped } = sanitizeFallbackTags(parsed.tags)
  if (dropped.length > 0) detail.push(`枚举外标签丢弃：${dropped.join("、")}`)

  if (markers.length < 1) {
    return fail(`机械校验作废全部 ${parsed.questions.length} 个边界候选（${detail.join("; ")}）`)
  }

  const replyMarkers = collectReplyMarkers(lines)
  const opinionStyle =
    kind === "reply" &&
    replyMarkers.length === 0 &&
    (LEGAL_OPINION_MARK.test(text.slice(0, 12000)) || isSingleTopicOpinion(text))

  usage.durationMs = Date.now() - startedAt
  return {
    split: {
      kind,
      channel: "L6",
      questions: cutQuestions(lines, markers, replyMarkers, "L6", opinionStyle),
      tocNumbers: tocQuestionNumbers(text),
      manualQueue: null,
    },
    tags,
    usage,
    detail: detail.length > 0 ? detail.join("; ") : "机械校验全过",
  }
}

// ---- W7.5 对账行 ---------------------------------------------------------

export interface QaSplitReportEntry {
  at: string
  source: string
  mode: "qa-split"
  kind: QaDocumentKind | "not-qa"
  channel: SplitChannel | null
  questions: number
  pages: number
  /** section 页数（回复论证小节学习层，W7.7）。 */
  sections: number
  tocNumbers: number
  round: string
  status: "ok" | "warn" | "manual-queue" | "rejected"
  detail: string
  /** L6 兜底通道成本对账（仅 L6 通道出现；stream 客户端不回传 token 计数，如实记字符数）。 */
  llmUsage?: LlmFallbackUsage
  /** L6 打标搭车：写入 question 页的标签数。 */
  tagsApplied?: number
}

/** M5.1 改动 4（2026-11-02）新入库防线：跳过即静默 ok 的病（鼎佳
 *  report status:"ok" 无任何告警面）。两条 warn 判据：
 *  ① sameNoSkipped>0 且合并后题数 < 正文标记数（同题多块合并仍吞并）；
 *  ② 拆出 1 题 && 正文 > 30,000 字符 && kind==="reply"（全文吞并形态）。
 *  warn 不阻断入库（页面照建），ipoanswer 侧对账会拦（双保险）。 */
export function qaSplitWarnReasons(
  split: QaSplitResult | null,
  sourceText: string,
): string[] {
  if (!split || split.kind !== "reply") return []
  const reasons: string[] = []
  const generatedCount = split.questions.filter((q) => q.questionNoIsGenerated).length
  if (generatedCount > 0) {
    reasons.push(`${generatedCount} 题为生成题号（H4 编号，待人工复核）`)
  }
  if (
    split.questions.length === 1 &&
    sourceText.length > 30000
  ) {
    reasons.push("单题吞并形态：拆出 1 题但正文 >30,000 字符")
  }
  return reasons
}

export function buildQaSplitReportEntry(
  sourceIdentity: string,
  split: QaSplitResult | null,
  roundMeta: QaRoundMeta | null,
  pages: number,
  status: QaSplitReportEntry["status"],
  detail: string,
  sections = 0,
  extra?: { llmUsage?: LlmFallbackUsage; tagsApplied?: number; warnReasons?: string[] },
): QaSplitReportEntry {
  return {
    at: new Date().toISOString(),
    source: sourceIdentity,
    mode: "qa-split",
    kind: split?.kind ?? "not-qa",
    channel: split?.channel ?? null,
    questions: split?.questions.length ?? 0,
    pages,
    sections,
    tocNumbers: split?.tocNumbers.length ?? 0,
    round: roundMeta
      ? `${roundMeta.roundKind}·${roundMeta.roundNo ?? "?"}轮·${roundMeta.issuer}`
      : "?",
    status: status === "ok" && (extra?.warnReasons?.length ?? 0) > 0 ? "warn" : status,
    detail:
      status === "ok" && (extra?.warnReasons?.length ?? 0) > 0
        ? [detail, ...extra!.warnReasons!].filter(Boolean).join("；")
        : detail,
    ...(extra?.llmUsage ? { llmUsage: extra.llmUsage } : {}),
    // L4：tagsApplied 由调用方控制——L6 通道恒传（含 0=标签全被值域丢弃），
    // 与「非 L6 通道未打标=字段不出现」在对账文件里可区分。
    ...(extra?.tagsApplied !== undefined ? { tagsApplied: extra.tagsApplied } : {}),
  }
}
