/**
 * R3 §7.3 基本信息补齐（2026-10-24）：case 页正文里的中介机构/募集金额/
 * 证券代码是 LLM 归纳产物的事实句——抽成 frontmatter 平键供
 * ipoanswer `ProjectCase` 结构化消费（此前只在正文里，检索/过滤用不上）。
 *
 * 纯规则正则抽取（零 LLM、幂等：已有键不覆盖），走 qa-split→case
 * sources 回写同路的写回通道。抽取不到的键如实缺省——不造数。
 */
import { listDirectory, readFile, writeFile } from "@/commands/fs"

export interface CaseInfoFacts {
  /** 证券代码（纯数字）。 */
  stock_code?: string
  /** 保荐机构/独立财务顾问全称。 */
  sponsor?: string
  /** 会计师事务所全称。 */
  auditor?: string
  /** 律师事务所全称。 */
  lawyer?: string
  /** 评估机构全称。 */
  evaluator?: string
  /** 保荐代表人（函件落款「保荐代表人：X、Y」）。 */
  sponsor_representatives?: string[]
  /** 预计募集金额原文（含单位，如「不超过1.5亿元」）。 */
  proposed_proceeds?: string
  /** 信息更新日期（抽取执行日，YYYY-MM-DD）。 */
  info_as_of?: string
}

const SPONSOR_RE = /(?:保荐机构|主承销商|独立财务顾问)[为是]([^\s，。；、]{4,40}(?:公司|事务所|有限责任公司|股份有限公司))/
const AUDITOR_RE = /(?:会计师事务所|审计机构)[为是]([^\s，。；、]{4,40}(?:会计师事务所|有限责任公司的会计师|特殊普通合伙)?)/
const LAWYER_RE = /(?:律师事务所|律师)[为是]([^\s，。；、]{3,40}律师事务所)/
const EVALUATOR_RE = /(?:评估机构|资产评估机构)[为是]([^\s，。；、]{4,40}(?:公司|事务所))/
const STOCK_CODE_RE = /[（(]证券代码[：:]\s*(\d{6})[)）]/
const PROCEEDS_RE = /(募集资金(?:总额)?(?:不超过|不超过人民币|不超过)?[\d.,亿万万元]{2,20}(?:亿元|万元|元))/
const SPONSOR_REPS_RE = /保荐代表人[：:]\s*([^\n]{2,60})/

/** 从 case 页正文抽取基本信息事实句（纯函数，测试友好）。 */
export function extractCaseInfoFacts(content: string, asOf: string): CaseInfoFacts {
  // 抽取只看正文头部（项目概览段是归纳通道固定结构，信息都在前 2000 字）
  const head = content.replace(/^---[\s\S]*?---\s*/, "").slice(0, 2000)
  const facts: CaseInfoFacts = {}
  const stockCode = STOCK_CODE_RE.exec(content)
  if (stockCode) facts.stock_code = stockCode[1]
  const sponsor = SPONSOR_RE.exec(head)
  if (sponsor) facts.sponsor = sponsor[1]
  const auditor = AUDITOR_RE.exec(head)
  if (auditor) facts.auditor = auditor[1].replace(/（特殊普通合伙）$/, "") || auditor[1]
  const lawyer = LAWYER_RE.exec(head)
  if (lawyer) facts.lawyer = lawyer[1]
  const evaluator = EVALUATOR_RE.exec(head)
  if (evaluator) facts.evaluator = evaluator[1]
  const proceeds = PROCEEDS_RE.exec(head)
  if (proceeds) facts.proposed_proceeds = proceeds[1]
  const reps = SPONSOR_REPS_RE.exec(content)
  if (reps) {
    const names = reps[1]
      .split(/[、，,;/\s]+/)
      .map((name) => name.trim())
      .filter((name) => /^[\u4e00-\u9fff]{2,4}$/.test(name))
    if (names.length > 0) facts.sponsor_representatives = names.slice(0, 4)
  }
  // info_as_of 只在抽到至少一个实质事实时记录——恒写会让每个 case 页
  // 在每次同步时都被 touch（updated 时间戳漂移），违背幂等。
  if (Object.keys(facts).length > 0) facts.info_as_of = asOf
  return facts
}

function yamlScalar(value: string): string {
  return /[:#\[\]{},"]/.test(value) || value.trim() !== value || !value
    ? `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
    : value
}

/** 把事实键写进 case 页 frontmatter（已有键不动——幂等，重跑零重复）。 */
export function applyCaseInfoFacts(content: string, facts: CaseInfoFacts): string {
  const fmBlock = content.match(/^(---\s*\r?\n)([\s\S]*?)(\r?\n---\s*(?:\r?\n|$))/)
  if (!fmBlock) return content
  let payload = fmBlock[2]
  const scalars: Array<[keyof CaseInfoFacts, (f: CaseInfoFacts) => string | undefined]> = [
    ["stock_code", (f) => f.stock_code],
    ["sponsor", (f) => f.sponsor],
    ["auditor", (f) => f.auditor],
    ["lawyer", (f) => f.lawyer],
    ["evaluator", (f) => f.evaluator],
    ["proposed_proceeds", (f) => f.proposed_proceeds],
    ["info_as_of", (f) => f.info_as_of],
  ]
  let changed = false
  for (const [key, pick] of scalars) {
    const value = pick(facts)
    if (!value) continue
    const exists = new RegExp(`^${key}:`, "m").test(payload)
    if (exists) continue
    payload += `\n${key}: ${yamlScalar(value)}`
    changed = true
  }
  const reps = facts.sponsor_representatives
  if (reps && reps.length > 0 && !/^sponsor_representatives:/m.test(payload)) {
    payload += `\nsponsor_representatives: [${reps.map((name) => yamlScalar(name)).join(", ")}]`
    changed = true
  }
  if (!changed) return content
  return `${fmBlock[1]}${payload}${fmBlock[3]}${content.slice(fmBlock[0].length)}`
}

/**
 * 扫 wiki/cases/ 全部 case 页补齐基本信息平键。幂等（已有键不覆盖），
 * 逐页 try/catch 不阻断批量；返回更新页相对路径与 warning 清单。
 */
export async function enrichCaseInfoFrontmatter(
  projectPath: string,
  asOf: string,
): Promise<{ updatedCasePaths: string[]; warnings: string[] }> {
  const updatedCasePaths: string[] = []
  const warnings: string[] = []
  const casesDir = `${projectPath}/wiki/cases`
  let nodes
  try {
    nodes = await listDirectory(casesDir)
  } catch {
    return { updatedCasePaths, warnings }
  }
  for (const node of nodes) {
    if (node.is_dir || !node.name.toLowerCase().endsWith(".md")) continue
    const absPath = node.path || `${casesDir}/${node.name}`
    const relPath = `wiki/cases/${node.name}`
    try {
      const content = await readFile(absPath)
      const fmMatch = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/)
      if (!fmMatch || !/^type:\s*case\s*$/m.test(fmMatch[1])) continue
      const facts = extractCaseInfoFacts(content, asOf)
      const next = applyCaseInfoFacts(content, facts)
      if (next !== content) {
        await writeFile(absPath, next)
        updatedCasePaths.push(relPath)
      }
    } catch (err) {
      warnings.push(
        `[case-info] ${relPath} 抽取/回写失败：${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  return { updatedCasePaths, warnings }
}
