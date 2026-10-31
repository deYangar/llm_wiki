/**
 * 表格两级表头规整（99 方案批次 5.4 规则版，2026-10-31）。
 *
 * ## 背景
 *
 * MinerU 把 PDF 的两级合并表头拍平成**两行平铺**的 markdown 表格：
 *
 * ```
 * | 项目 | 2025年10月末/2025年1-10月 | 2024年末/2024年度 |  |  |  |  |
 * | --- | --- | --- | --- | --- | --- | --- |
 * | 交易前 | 备考数 | 变动率/变动额 | 交易前 | 备考数 | 变动率/变动额 |  |
 * | 总资产 | 45,419.34 | 217,593.95 | 379.08% | 42,513.07 | 219,062.52 | 415.28% |
 * ```
 *
 * markdown 表格语法无法表达「一格横跨三列」，渲染必然错位。实测（ST联合
 * 6-1/6-2-1 两份原文）一级表头行 7 列里后 4 列是空、二级表头 7 列里最后
 * 1 列空——这是 MinerU 拍平时把「合并单元格」摊成空列留下的痕迹。
 *
 * ## 规则（只做能确定的部分）
 *
 * 判定一组连续表头行是两级表头：
 *  1. 第 1 行（一级）有 ≥2 个连续空列在**尾部**（或中间成段）；
 *  2. 第 2 行（二级）列数与数据行相同，且非空列数量 > 一级非空列数量；
 *  3. 数据行列数 = 二级行列数。
 *
 * 满足则合并为单级：一级的非空列名按「连续空列段」的列跨度**重复填充**到
 * 下一行对应列位，拼成 `一级/二级`：
 *
 * ```
 * | 项目 | 2025年10月末/交易前 | 2025年1月-10月/备考数 | ... |
 * ```
 *
 * **不做的事**（明确的边界）：
 *  - 不猜「哪个一级标签对应哪几列」以外的语义（只按空列段的行跨度重复）；
 *  - 列数与数据行不一致的表**原样保留**并计入 `skipped`（宁可不错、不可猜错）；
 *  - 只处理 markdown 表格，不碰 HTML 表格（HTML 走 `convertHtmlTablesToMarkdown`）。
 *
 * 与 2026-10-23 立项的 MinerU 表格识别研究（`plans/2026-10-23-table-recognition-research.md`）
 * 的关系：本模块是**规则版兜底**（零成本、可回滚），研究线（换模型/参数 A/B）
 * 仍是后续。规则版判不出的表交给研究线，不在规则里堆特例。
 */

/** 一行 markdown 表格拆成单元格（已 trim，但保留原文以支持零改写回退） */
export interface TableRow {
  /** 原文整行 */
  raw: string
  /** 拆出的单元格（trim 后） */
  cells: string[]
}

/** 规整统计，供 dry-run 报告与验收 */
export interface TableNormalizeStats {
  /** 扫描到的表格块数 */
  tables: number
  /** 命中两级表头并被合并的 */
  merged: number
  /** 列数不一致 / 形态可疑而原样保留的 */
  skipped: number
}

/** 拆分一行表格为单元格；不是表格行返回 null */
function splitRow(line: string): string[] | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith("|")) return null
  // 去掉首尾竖线后按未转义竖线切分
  let body = trimmed
  if (body.endsWith("|")) body = body.slice(0, -1)
  body = body.slice(1)
  const cells: string[] = []
  let buf = ""
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch === "\\" && body[i + 1] === "|") {
      buf += "|"
      i++
      continue
    }
    if (ch === "|") {
      cells.push(buf.trim())
      buf = ""
      continue
    }
    buf += ch
  }
  cells.push(buf.trim())
  return cells
}

/** 判断是否是 markdown 表头的分隔行（`| --- | --- |`） */
function isSeparatorRow(cells: string[]): boolean {
  if (cells.length === 0) return false
  return cells.every((c) => /^:?-{1,}:?$/.test(c))
}

/**
 * 合并两级表头为一行；无法安全合并时返回 null（调用方原样保留）。
 *
 * ## 跨度如何定（2026-10-31 实测修正）
 *
 * 首版按「一级的空列段归给前一个标签」推跨度，在 ST联合 实测表上给了错误
 * 结果：一级是 `项目 | 2025年10月末 | 2024年末 | 空×4`，二级是
 * `交易前 | 备考数 | 变动率 | 交易前 | 备考数 | 变动率 | 空` —— MinerU 把
 * 两行**各自拍平成不同形态**（一级把两列日期标签挤到前面，二级把首列空
 * 补到了尾部），空列段位置根本不可信。
 *
 * 改用**整除推断**：一行表格 n 列 = 1 个行标签列 + k 个一级标签 × 每组 g 列。
 * 只要 `(n-1) % k == 0` 且二级非空值数量恰为 `(n-1)`，跨度就是确定的：
 * 每个一级标签覆盖 g 列，二级非空值按顺序每 g 个一组归到一个标签。
 * 这样 ST联合 表得到语义正确的
 * `项目 | 2025年10月末-交易前 | …-备考数 | …-变动率 | 2024年末-交易前 | …`。
 *
 * 整除不成立（列数对不上分组）就返回 null —— 宁可原标题保留，不猜。
 *
 * @param level1 一级表头（含空列）
 * @param level2 二级表头（列数 = 一级列数）
 */
export function mergeTwoLevelHeader(level1: string[], level2: string[]): string[] | null {
  const n = level1.length
  if (n === 0 || level2.length !== n) return null

  // 行标签列：一级首列；一级首列为空时退回二级首列
  const rowLabel = level1[0]?.trim() || ""
  if (!rowLabel) return null

  // 一级的分组标签（去掉首列与空列）
  const groupLabels = level1
    .slice(1)
    .map((c) => c.trim())
    .filter((c) => c !== "")
  const k = groupLabels.length
  if (k === 0) return null

  // 二级的非空子标签（顺序即分组内顺序）
  const subs = level2
    .map((c) => c.trim())
    .filter((c) => c !== "")
  if (subs.length !== n - 1) return null

  const span = n - 1
  if (span % k !== 0) return null
  const g = span / k
  if (g < 1) return null

  const merged: string[] = [rowLabel]
  for (let i = 0; i < k; i++) {
    const label = groupLabels[i]
    for (let j = 0; j < g; j++) {
      const sub = subs[i * g + j] ?? ""
      merged.push(sub ? `${label}/${sub}` : label)
    }
  }
  return merged.length === n ? merged : null
}

/** 渲染一行单元格回 markdown（保持原格式风格：`| a | b |`） */
function renderRow(cells: string[]): string {
  return `| ${cells.join(" | ")} |`
}

/**
 * 规整 markdown 正文中的两级表头表格。
 *
 * 幂等：已合并的单级表头不会再次命中（一级行已无空列尾随 → 不满足条件 1）。
 *
 * @param markdown 原文
 * @param stats 可选统计累加器（调用方传空对象即可）
 */
export function normalizeTwoLevelTableHeaders(
  markdown: string,
  stats: TableNormalizeStats = { tables: 0, merged: 0, skipped: 0 },
): { markdown: string; stats: TableNormalizeStats } {
  const lines = markdown.split("\n")
  const out: string[] = []
  let i = 0

  while (i < lines.length) {
    // 表格块起点判定：本行是表格行，下一行是分隔行
    const cur = splitRow(lines[i])
    const next = i + 1 < lines.length ? splitRow(lines[i + 1]) : null
    if (!cur || !next || !isSeparatorRow(next)) {
      out.push(lines[i])
      i++
      continue
    }

    // 收集整块：表头1 + 分隔 + 后续所有表格行
    const block: { line: string; cells: string[] }[] = [{ line: lines[i], cells: cur }]
    let j = i + 1
    while (j < lines.length) {
      const row = splitRow(lines[j])
      if (!row) break
      block.push({ line: lines[j], cells: row })
      j++
    }
    stats.tables++

    // block[0]=一级表头, block[1]=分隔行, block[2]=二级候选, block[3..]=数据
    const sep = block[1]
    const level1 = block[0].cells
    const dataStart = 2
    const dataRows = block.slice(dataStart).filter((b) => !isSeparatorRow(b.cells))

    if (dataRows.length === 0) {
      stats.skipped++
      out.push(...block.map((b) => b.line))
      i = j
      continue
    }

    const level2 = block[dataStart]?.cells
    const dataCols = dataRows[0].cells.length

    // 条件 1：一级表头必须有空列（否则不是两级表头）
    const hasEmpty = level1.some((c) => c === "")
    // 条件 3：二级列数 = 数据列数
    const okShape =
      !!level2 &&
      level2.length === dataCols &&
      level1.length === dataCols &&
      hasEmpty &&
      !isSeparatorRow(level2) &&
      // 条件 2：二级非空列数 > 一级非空列数（真两级而非重复表头）
      level2.filter((c) => c !== "").length > level1.filter((c) => c !== "").length

    if (!okShape) {
      stats.skipped++
      out.push(...block.map((b) => b.line))
      i = j
      continue
    }

    const merged = mergeTwoLevelHeader(level1, level2!)
    if (!merged) {
      stats.skipped++
      out.push(...block.map((b) => b.line))
      i = j
      continue
    }

    // 输出：合并后的表头 + 分隔行 + 数据行（二级行被吸收）
    out.push(renderRow(merged))
    out.push(sep.line)
    for (const row of block.slice(dataStart + 1)) {
      out.push(row.line)
    }
    stats.merged++
    i = j
  }

  return { markdown: out.join("\n"), stats }
}
