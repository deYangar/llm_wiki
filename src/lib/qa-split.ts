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

/** 中文数字 → 阿拉伯数字（v4 映射 + 单字「一」~「九」直取，v4 亦漏此形态）。 */
export function cn2num(s: string): number {
  if (/^\d+$/.test(s)) return parseInt(s, 10)
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
/** H3: `问题N、`/`问题N：`/`问题N.`（后者排除小数 N. 后跟数字）。用于行内任意位置。 */
const H3_ANYWHERE = /问题\s*([0-9]{1,3}|[一二三四五六七八九十]{1,3})\s*[、．:：]|问题\s*([0-9]{1,3})\.(?!\d)/g
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
 *  引号开头的引用行（「"一.关于问询问题 1…"之"（三）」）不命中——前缀字符集不含引号。 */
const H3_BODY_LINE =
  /^[ \t]{0,8}(?:#{1,4}[ \t]+)?(?:[一二三四五六七八九十]{1,3}\s*[.、．]\s*)?(?:(?:《[^》]{2,60}》\s*)?(?:关于\s*)?(?:问询\s*)?问题\s*(?:[0-9]{1,3}|[一二三四五六七八九十]{1,3})\s*(?:[（(][^)）]{0,12}[)）])?\s*(?:[、．:：]|\.(?!\d))|《[^》]{2,60}》\s*[0-9]{1,3}\s*(?:[、．:：]|\.(?!\d))\s*(?:关于|其他))/
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

const MAX_QUESTION_NO = 299

export type SplitChannel = "H1" | "H2" | "H3" | "H4" | "H5" | "L6"

/** qa 文档形态：回复函（含回复块）或问询函原件（只有题目清单）。 */
export type QaDocumentKind = "reply" | "letter"

export interface QaPathMeta {
  company: string
  year?: string
  exchange?: string
  deal?: string
  board?: string
  status?: string
}

export interface QaRoundMeta {
  /** null = 正文与文件名都无法识别轮次（如实省略，不造 1）。 */
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
  // 回复块兜底：泛名回复文件（519 份「发行人及中介机构回复意见.pdf」）
  // 无题号标记也无标准封面句式，但 2+ 个独立「回复：」行已是问询回复的
  // 特异结构（普通文档/法规不会出现）——交给 H4 拆题。
  if (countReplyMarkers(text) >= 2) return "reply"
  if (countReplyMarkers(text) >= 1 && REPLY_OPENING.test(text.slice(0, 20000))) {
    return "reply"
  }
  return null
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

interface LineMarker {
  line: number
  no: number
}

/** 从一行文本提取「问题N」题号（H3 语义：问题N+分隔符，或《函名》N.(关于|其他)直起形态；
 *  题号后允许「（原问题N）」类括号注记——主号优先，注记号不取）。 */
function extractQuestionNo(line: string): number {
  const punct = line.match(/问题\s*([0-9]{1,3}|[一二三四五六七八九十]{1,3})\s*(?:[（(][^)）]{0,12}[)）])?\s*[、．:：]/)
  if (punct) return cn2num(punct[1])
  const dot = line.match(/问题\s*([0-9]{1,3})\s*(?:[（(][^)）]{0,12}[)）])?\.(?!\d)/)
  if (dot) return cn2num(dot[1])
  const letterNum = line.match(/《[^》]{2,60}》\s*([0-9]{1,3})\s*(?:[、．:：]|\.(?!\d))\s*(?:关于|其他)/)
  if (letterNum) return cn2num(letterNum[1])
  return 0
}

/** 正文「问题N、」行首标记（排除目录点线行）。 */
function bodyQuestionMarkers(text: string): LineMarker[] {
  const out: LineMarker[] = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (TOC_DOT_LEADER.test(line)) continue
    if (!H3_BODY_LINE.test(line)) continue
    const no = extractQuestionNo(line)
    if (no > 0 && no <= MAX_QUESTION_NO) out.push({ line: i, no })
  }
  return out
}

/** 目录页「问题N、」题号（带点线）。 */
function tocQuestionNumbers(text: string): number[] {
  const seen = new Set<number>()
  for (const line of text.split(/\r?\n/)) {
    if (!TOC_DOT_LEADER.test(line)) continue
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
export function splitQaDocument(text: string, kind: QaDocumentKind): QaSplitResult {
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
    const { kept, manualQueue } = monotonicMarkers(h1)
    return {
      kind, channel: "H1",
      questions: cutQuestions(lines, kept, replyMarkers, "H1", opinionStyle),
      tocNumbers: toc, manualQueue,
    }
  }
  const h2 = [...headingChannel(H2_LINE), ...contextualH2Markers(lines)].sort(
    (a, b) => a.line - b.line,
  )
  if (h2.length >= 2) {
    const { kept, manualQueue } = monotonicMarkers(h2)
    return {
      kind, channel: "H2",
      questions: cutQuestions(lines, kept, replyMarkers, "H2", opinionStyle),
      tocNumbers: toc, manualQueue,
    }
  }

  if (bodyMarkers.length >= 2) {
    const { kept, manualQueue } = monotonicMarkers(bodyMarkers)
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
  const h5: LineMarker[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim()
    if (!H5_LINE.test(trimmed)) continue
    const cn = trimmed.match(/^([一二三四五六七八九十]{1,3})\s*、/)
    const num = cn ? cn2num(cn[1]) : 0
    if (num > 0 && num <= 99) h5.push({ line: i, no: num })
  }
  if (h5.length >= 2) {
    const { kept } = monotonicMarkers(h5)
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

/**
 * 问答函题号单调递增。非递增的标记行通常是正文里恰好行首出现「问题N、」
 * 的引用/表格残留——跳过标记但不丢内容（该行归前一题的正文）。
 */
function monotonicMarkers(markers: LineMarker[]): {
  kept: LineMarker[]
  manualQueue: string | null
} {
  const kept: LineMarker[] = []
  let skipped = 0
  let last = 0
  for (const marker of markers) {
    if (marker.no > last) {
      kept.push(marker)
      last = marker.no
    } else {
      skipped += 1
    }
  }
  return {
    kept,
    manualQueue:
      skipped > 0
        ? `${skipped} 个非递增题号标记被跳过（疑似正文引用）`
        : null,
  }
}

function cutQuestions(
  lines: string[],
  markers: LineMarker[],
  replyMarkers: number[],
  channel: SplitChannel,
  /** 补充法律意见书形态：题块内没有「回复：」标记行，用第一个论证小节
   *  边界（(一)/一、/## N、…）作为题目/回复分界。 */
  opinionStyle = false,
): SplitQuestion[] {
  const out: SplitQuestion[] = []
  for (let idx = 0; idx < markers.length; idx += 1) {
    const marker = markers[idx]
    const start = marker.line
    const end = idx + 1 < markers.length ? markers[idx + 1].line - 1 : lines.length - 1
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
        // 论证小节输出 # 标题，只认裸行会把整个回复混进题目区）。
        if (
          /^#{0,4}\s*[（(][一二三四五六七八九十]{1,3}[)）]\s*\S/.test(lines[i]) ||
          /^#{1,4}\s*[一二三四五六七八九十]{1,3}\s*[、.．]\s*\S/.test(lines[i])
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

function titleFromBlock(
  lines: string[],
  start: number,
  end: number,
  questionNo: number,
): string {
  for (let i = start; i <= end; i += 1) {
    const line = lines[i].trim()
    if (!line || line.startsWith("## Page") || /^[-—·\s]+$/.test(line)) continue
    return line
      .replace(/^#{1,4}\s*/, "")
      // 意见书前缀：「一.」「一、」「《审核问询函》」「关于问询」
      .replace(/^[一二三四五六七八九十]{1,3}\s*[.、．]\s*/, "")
      .replace(/^《[^》]{2,60}》\s*/, "")
      .replace(/^(?:关于\s*)?(?:问询\s*)?问题\s*[0-9一二三四五六七八九十]{1,3}\s*[、．:：.]?\s*/, "")
      .replace(/^问题\s*[0-9一二三四五六七八九十]{1,3}\s*/, "")
      .slice(0, 40)
      .trim() || `第${questionNo}题`
  }
  return `第${questionNo}题`
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

  const isFeedback = letterName.includes("注册环节反馈意见") || letterName.includes("反馈意见")
  const isImplementation = letterName.includes("落实函") && !isFeedback
  const roundKind: QaRoundMeta["roundKind"] = isFeedback
    ? "注册反馈"
    : isImplementation
      ? "落实函"
      : "审核问询函"
  const issuer: QaRoundMeta["issuer"] =
    isFeedback || /中国证券监督管理委员会|证监会/.test(sentence?.[1] ?? "")
      ? "证监会"
      : "交易所"

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
    return {
      year,
      exchange,
      deal: DEAL_NORMALIZE[rest[2]] ?? rest[2],
      status: rest[3],
      company: rest[4] ?? fileStem,
    }
  }
  return {
    year,
    exchange,
    deal: deal ? (DEAL_NORMALIZE[deal] ?? deal) : undefined,
    board,
    status,
    company: company ?? fileStem,
  }
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

function yamlScalar(value: string): string {
  if (/[:#\[\]{},\"]/.test(value) || value.trim() !== value || !value) {
    return `"${yamlEscape(value)}"`
  }
  return value
}

function questionTitle(
  question: SplitQuestion,
  roundMeta: QaRoundMeta,
): string {
  const round = roundMeta.roundNo ? `第${roundMeta.roundNo}轮` : roundMeta.roundKind
  const stem = question.title.slice(0, TITLE_MAX).trim() || `第${question.questionNo}题`
  return `${round}·问题${question.questionNo}·${stem}`
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
    `title: "${yamlEscape(questionSummaryTitle(pathMeta, roundMeta, split))}"`,
    "parser: qa-split",
    "tags: []",
  ]
  blocks.push(
    `---FILE: wiki/sources/${slug}.md---\n---\n${summaryLines.join("\n")}\n---\n\n` +
      `# ${questionSummaryTitle(pathMeta, roundMeta, split)}\n\n` +
      `本来源为问答函类文档，已按 qa-split 规则逐题拆分至 \`wiki/questions/\`（识别通道 ${split.channel}，共 ${split.questions.length} 题）。\n\n` +
      `- 来源文件：${sourceIdentity}\n- 轮次：${roundMeta.roundKind}${roundMeta.roundNo ? `（第${roundMeta.roundNo}轮）` : "（轮次未识别）"}\n- 识别依据：${roundMeta.basis}\n\n` +
      `> 题目与回复原文逐字转录于各 question 页；本页仅为来源索引，不承载题目内容。\n---END FILE---`,
  )

  for (const question of split.questions) {
    // 质量红线自检：题目/回复必须是 raw md 全文（行尾归一后）的连续子串
    if (!normalizedSource.includes(question.questionText)) {
      violations.push(`q${question.questionNo}: 题目正文不是原文连续子串`)
    }
    if (question.replyText && !normalizedSource.includes(question.replyText)) {
      violations.push(`q${question.questionNo}: 回复正文不是原文连续子串`)
    }

    const fm: string[] = [
      "type: question",
      `title: ${yamlScalar(questionTitle(question, roundMeta))}`,
      `company: ${yamlScalar(pathMeta.company)}`,
    ]
    if (pathMeta.exchange) fm.push(`exchange: ${yamlScalar(pathMeta.exchange)}`)
    if (pathMeta.board) fm.push(`board: ${yamlScalar(pathMeta.board)}`)
    if (pathMeta.deal) fm.push(`deal: ${yamlScalar(pathMeta.deal)}`)
    if (pathMeta.year) fm.push(`year: ${yamlScalar(pathMeta.year)}`)
    if (pathMeta.status) fm.push(`status: ${yamlScalar(pathMeta.status)}`)
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

    const body =
      `## 监管问题\n\n${question.questionText}\n\n` +
      (question.replyText
        ? `## 回复\n\n${question.replyText}\n\n`
        : "") +
      `## 拆题元数据\n\n` +
      `- 识别通道: ${question.channel}\n` +
      `- 题目边界: 第 ${question.startLine + 1}–${(question.replyStartLine ?? question.endLine + 1)} 行\n` +
      `- 回复边界: ${question.replyStartLine === null ? "无（问询函原件）" : `第 ${question.replyStartLine + 1}–${question.endLine + 1} 行`}\n` +
      `- 原文题号: ${question.questionNoIsGenerated ? "无（按回复块顺序生成）" : question.questionNo}\n` +
      `- 来源文档: ${sourceIdentity}\n`

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

function questionSummaryTitle(
  pathMeta: QaPathMeta,
  roundMeta: QaRoundMeta,
  split: QaSplitResult,
): string {
  const round = roundMeta.roundNo ? `第${roundMeta.roundNo}轮` : roundMeta.roundKind
  return `${pathMeta.company} ${round}${roundMeta.roundKind}（qa-split ${split.channel}·${split.questions.length}题）`
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
  "4. tags：一道题可同时属于多个大类，符合的都要挂（多标签，不设数量上限），前缀必须是 inquiry-stage: 或 topic:。",
  "   inquiry-stage 只能取以下枚举值（枚举外一律不输出；光杆根=树级，叶值=大类标签）：",
  INQUIRY_STAGE_ALLOWED_VALUES.map((value) => `   inquiry-stage:${value}`).join("\n"),
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
      if (INQUIRY_STAGE_ALLOWED_VALUES.includes(value.slice("inquiry-stage:".length))) {
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
  status: "ok" | "manual-queue" | "rejected"
  detail: string
  /** L6 兜底通道成本对账（仅 L6 通道出现；stream 客户端不回传 token 计数，如实记字符数）。 */
  llmUsage?: LlmFallbackUsage
  /** L6 打标搭车：写入 question 页的标签数。 */
  tagsApplied?: number
}

export function buildQaSplitReportEntry(
  sourceIdentity: string,
  split: QaSplitResult | null,
  roundMeta: QaRoundMeta | null,
  pages: number,
  status: QaSplitReportEntry["status"],
  detail: string,
  sections = 0,
  extra?: { llmUsage?: LlmFallbackUsage; tagsApplied?: number },
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
    status,
    detail,
    ...(extra?.llmUsage ? { llmUsage: extra.llmUsage } : {}),
    // L4：tagsApplied 由调用方控制——L6 通道恒传（含 0=标签全被值域丢弃），
    // 与「非 L6 通道未打标=字段不出现」在对账文件里可区分。
    ...(extra?.tagsApplied !== undefined ? { tagsApplied: extra.tagsApplied } : {}),
  }
}
