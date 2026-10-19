import { describe, it, expect } from "vitest"

import {
  buildQaSplitReportEntry,
  buildQuestionFileBlocks,
  classifyQaDocument,
  cn2num,
  extractPathMeta,
  extractRoundMeta,
  INQUIRY_STAGE_ALLOWED_VALUES,
  llmFallbackSplit,
  sanitizeFallbackTags,
  splitQaDocument,
  splitReplySections,
} from "./qa-split"
import { FILE_BLOCK_REGEX } from "./ingest"

/**
 * Fixtures are condensed from the real 2025 corpus measured by the
 * 2026-10-08 completeness audit (ipoanswer tmp/audit_v4_detail.csv):
 * 嘉德利首轮 H3 13题 / 嘉德利二轮 H2 / 千分一二轮 H2 3题 / 千分一泛名 H4 /
 * ST联合落实函 H4 1题. Channel priority and regex semantics must stay in
 * lockstep with audit v4 (tmp/audit_wiki_completeness_v4.py).
 */

// ── H2: 深交所 IPO 数字标题式（千分一二轮形态）───────────────────────────
const H2_SAMPLE = `## Page 1

深圳市千分一智能技术股份有限公司
关于千分一首次公开发行股票并在创业板上市申请文件的
第二轮审核问询函的回复

## Page 2

贵所于 2026 年 1 月 6 日出具的《关于深圳市千分一智能技术股份有限公司首次公开发行股票并在创业板上市申请文件的第二轮审核问询函》（审核问询函〔2026〕10号）已收悉。

现回复如下：

## 1.关于产品竞争力及未来业绩稳定性

根据申报材料：（1）发行人智能笔业务收入占比较高。

请发行人：（1）结合产品竞争力说明业绩可持续性。

回复：

一、发行人智能笔与终端产品的配套销售模式

发行人智能笔产品与终端产品配套销售。

## 1、发行人智能笔与终端产品的配套销售模式

配套销售模式下的收入确认政策保持一致。

## 2.关于技术先进性具体体现

请发行人结合核心技术指标说明技术先进性。

回复：

一、核心技术指标处于行业领先水平。

发行人核心技术指标如下。`

// ── H3: 目录+正文裸行（嘉德利首轮形态）─────────────────────────────────
const H3_SAMPLE = `## Page 1

泉州嘉德利电子材料股份公司
关于首次公开发行股票并在沪市主板上市申请文件的审核问询函的回复

## Page 3

目录 ............................................................................. 2

问题 1、关于主要产品 .................................................................... 3

问题 2、关于板块定位 ................................................................... 24

问题 3、关于客户 ......................................................................... 52

## Page 4

根据贵所出具的《关于泉州嘉德利电子材料股份公司首次公开发行股票并在沪市主板上市申请文件的审核问询函》（上证上审〔2025〕200号）：

问题 1、关于主要产品

根据申报材料：（1）发行人核心产品为 BOPP 电工膜。

回复：

一、结合电容器的主要类型及行业技术革新情况说明主要产品的市场地位。

发行人 BOPP 电工膜市场占有率较高。

问题 2、关于板块定位

请发行人结合业务实质说明板块定位的准确性。

回复：

一、公司业务属于主板定位的传统产业转型升级领域。

问题 3、关于客户

请发行人补充披露主要客户基本情况。

回复：

一、主要客户为电力电容器生产企业。`

// ── H4: 回复块计数兜底（ST联合落实函形态：全文无题号标记）─────────────────
const H4_SAMPLE = `## Page 1

国旅文化投资集团股份有限公司
关于对《国旅文化投资集团股份有限公司申请注册环节反馈意见落实函》的回复

## Page 2

根据贵会发出的《关于国旅文化投资集团股份有限公司申请注册环节反馈意见落实函》，发行人与中介机构认真落实相关问题，现回复如下：

请发行人补充说明 2025 年业绩变动情况及原因。

回复：

2025 年度公司实现营业收入较上年同期基本稳定，净利润有所增长，主要系处置子公司股权投资收益增加所致。

关于前次审核问询回复报告中产品质量问题 266.77 万元退换货金额的构成说明如下。

其中：产品质量问题 266.77 181.93 84.29`

// ── H3-意见书：补充法律意见书形态（日播时尚/松发股份实测，2026-10-10 补）──
const OPINION_SAMPLE = `北京市康达律师事务所
关于广东松发陶瓷股份有限公司重大资产置换及发行股份购买资产并募集配套资金
暨关联交易之补充法律意见书（三）

致：广东松发陶瓷股份有限公司

本所接受发行人委托，就其重大资产置换及发行股份购买资产并募集配套资金暨关联交易事项出具本补充法律意见书。

一、《审核问询函》问题 2.关于交易方案和整合管控

根据问询函回复：（1）请结合最近三年上市公司及其控股股东、实际控制人、现任董事、高级管理人员受到的行政处罚等情况说明。

（一）结合最近三年上市公司及其控股股东、实际控制人、现任董事、高级管理人员受到的行政处罚、刑事处罚或者被采取监管措施的情况，说明相关情况是否构成重大违法。

经核查，报告期内上市公司及其控股股东不存在受到重大行政处罚的情形，最近三年上市公司现任董事、高级管理人员不存在受到中国证监会行政处罚或被采取证券市场禁入措施的情形，不构成重大违法行为。上市公司已在重组报告书中如实披露相关风险。

（二）请律师核查（4）并发表明确意见

经核查，本所律师认为，上市公司符合《上市公司重大资产重组管理办法》规定的相关条件，上述处罚事项不会对本次交易构成实质性法律障碍。

二、《审核问询函》问题 13.关于置出资产的债务转移

（一）置出资产负债转移取得债权人同意函的最新进展，未获得同意部分债务的处置方案及对本次交易的影响。

经核查，截至本补充法律意见书出具之日，置出资产债务转移已获得绝大部分债权人出具的同意函，未获得同意的债务占置出资产债务总额的比例较低，上市公司已与交易对方约定由其承接相应债务并承担全部责任。

（二）上市公司与中坤投资的前述约定能否达到债务转移的实质效果，交易对方是否实际具备债务清偿能力。

经核查，根据上市公司与中坤投资签署的《债务转移及承接协议》，中讯投资已就相关债务提供连带责任保证，债务转移安排具备实质效果。`
// 无题号结构的普通文档（法规/研报形态）——不得被分类为 qa
const NON_QA_SAMPLE = `## Page 1

首次公开发行股票注册管理办法

第一章 总则

第一条 为了规范首次公开发行股票相关活动，制定本办法。

第二条 在中华人民共和国境内首次公开发行股票，适用本办法。`

// ── T2 扩展（2026-10-14）：评估/会计师核查意见族 ————————————————
// 实测来源：至正股份 6-5 评估机构核查意见（98K）、日播时尚评估专项核查意见
// （52K）——题边界「问题一（原问题六）、关于XX」中文题号+括号注记、
// 回复块用「答复：」，此前 H1-H5 全不认 → 整族 not-qa 走归纳式丢题目层。
const EVAL_REVIEW_SAMPLE = `## Page 1

某资产评估机构
关于某股份有限公司发行股份及支付现金购买资产
并募集配套资金申请的审核问询函
之回复的专项核查意见

## 上海证券交易所：

贵所出具的《审核问询函》已收悉，评估机构对问询函所列问题进行了核查。

## 问题一（原问题六）、关于评估作价和商誉

重组报告书披露，（1）本次交易采用资产基础法和收益法对标的资产进行了评估。

答复：

一、本次评估最终选取市场法定价的原因，两种评估方法产生的差异分析如下。

## 问题二（原问题七）、关于资产基础法评估

重组报告书披露：（1）目标公司采用资产基础法评估，增值率较高。

答复：

一、各项长期股权投资的评估过程及增值原因说明。

## 问题三（问题十二）、关于目标公司的存货

重组报告书披露：（1）报告期各期末，存货余额持续增长。

答复：

一、报告期各期末库存商品的订单覆盖率及备货原因。`

// ── T2 扩展（2026-10-14）：会计师专项说明「函回复」动宾语序 ——————————
// 实测来源：中国银行 7-2「关于对…审核问询函回复的专项说明」（2.9K 单题）
// ——封面自称「函回复的专项说明」（非「的回复」），单「回复：」块，
// 此前 REPLY_TITLE_SIGNATURE 锚「的回复」漏判 + 回复块门槛 ≥2 拒收。
const ACCOUNTANT_REPLY_SAMPLE = `## 关于对中国银行股份有限公司向特定对象发行股票申请文件审核问询函回复的专项说明

上海证券交易所：

某会计师事务所（特殊普通合伙）作为申报会计师，对审核问询函回复中涉及财务会计事项进行了专项说明。

回复：

## 一、发行人说明

## 2、相关预计负债计提是否充分

发行人已就预计负债计提政策进行了说明。

## 二、申报会计师核查情况

## （一） 核查程序

我们查阅了相关合同及减值测试底稿。

## （二） 核查意见

经核查，我们认为发行人预计负债计提充分。`


// ── H1: 上交所标题行形态（构造样本，正文实库存在此形态）─────────────────
const H1_SAMPLE = `## Page 1

某股份有限公司
关于向特定对象发行股票申请文件的审核问询函回复报告

## 问题 1

发行人及中介机构对审核问询函所列问题逐项落实。

## 问题 2

关于本次募投项目必要性的说明。

回复：

一、本次募投项目符合产业政策。`

// ── T4: 中介机构「序数大节」体（2026-10-19 第三梯队；实库形态：中贝通信
//    7-2 会计师回复意见——目录「一、关于XX」点线行 + 正文裸行大节 + 节内
//    「## N、」阿拉伯小节，节序每题重启，全文无「回复：」独立块） ─────────
const T4_ACCOUNTANT_SAMPLE = `## Page 1

目 录
一、关于融资规模与效益预测……第1—26页
二、关于收入……第26—48页
三、关于成本与毛利率情况……第48—62页

## Page 2

一、关于融资规模与效益预测

根据问询函要求，发行人说明了本次融资规模的测算依据及效益预测过程。

## 1、募集资金总额

本次募集资金总额不超过十亿元，全部用于主营项目建设。

## 2、效益预测

效益预测基于现有产能利用率与在手订单测算得出。

二、关于收入

发行人补充披露了收入确认政策与主要客户构成情况。

## 1、收入构成

报告期各期营业收入保持持续增长态势。

## 2、客户集中度

前五大客户收入占比保持在合理区间。

三、关于成本与毛利率情况

发行人量化分析了主要产品毛利率变动的原因及未来趋势。

## 1、单位成本

主要原材料采购价格回落带动单位成本下降。

## 2、毛利率

毛利率变动与同行业可比公司变动趋势一致。`

/** T4B 题干直述档（方正科技 7-2 实测形态：大节标题=完整问询题干长句，
 *  不带「关于」；节内阿拉伯顿号小节）。 */
const T4_DIRECT_STEM_SAMPLE = `某会计师事务所关于某公司审核问询函的专项说明

一、建筑工程费、设备购置及安装费等具体内容及测算过程，建筑面积、建筑单价、设备购置数量的确定依据及合理性

发行人逐项说明了建筑工程费与设备购置费的测算过程。

## 1、建筑工程费

建筑面积按规划许可载明的面积确定。

二、本次募集资金用于非资本性支出的规模及占比，是否存在置换董事会前投入的情形说明

发行人披露了非资本性支出占比及置换情况核查结论。

## 1、非资本性支出

本次募集资金不涉及非资本性支出项目。`

/** 标准章节体红线（《编报规则 12 号》法律意见书骨架：序数递增但节标题
 *  不带「关于」且为短名词短语——益坤电气实测形态，绝不可拆）。 */
const T4_STANDARD_CHAPTER_SAMPLE = `某律师事务所关于某公司首次公开发行股票的法律意见书

一、本次发行上市的批准和授权

本所律师核查了发行人本次发行上市的批准与授权程序。

二、发行人本次发行上市的主体资格

发行人为依法设立且合法存续的股份有限公司。

三、发行人的独立性

发行人在业务、资产、人员、机构、财务方面独立。

四、募集资金的运用

募集资金将用于主营业务相关的项目建设。`

/** 「第X部分」层结构（千岸科技实测：T4B 的长题干节撞第二部分标准章节，
 *  必须让位——第一部分已由 H3/H5 正确拆解）。 */
const T4_PART_STRUCTURE_SAMPLE = `第一部分 《审核问询函》回复 ……6
《审核问询函》问题1. 关于经营合法合规性……6
第二部分 《律师工作报告》《法律意见书》更新内容……38

《审核问询函》问题1. 关于经营合法合规性

回复：

发行人报告期内合法合规经营，不存在重大违法行为。

一、报告期内是否存在重大违法行为的详细说明及依据、相关主管部门出具的证明

发行人取得了主管部门出具的合规证明文件。`

/** T4A 接管路径（中贝通信实测形态）：顿号小节带佐证撞 H2 弱信号、序号每节
 *  重启——此前 H2 把 6 节混成 1 题；接管后按大节切分。 */
const T4_TAKEOVER_SAMPLE = `目 录
一、关于融资规模与效益预测……第1—26页
二、关于收入……第26—48页
三、关于成本与毛利率情况……第48—62页

一、关于融资规模与效益预测

根据审核问询函，发行人说明如下。

## 1、募投项目投资构成

请发行人说明募投项目投资构成的测算依据。

投资构成与建设进度相匹配。

## 2、效益测算与持续盈利情况

请发行人说明效益测算的谨慎性与可实现性。

效益测算基于产能利用率。

二、关于收入

根据审核问询函，发行人说明如下。

## 1、收入确认政策

请发行人披露收入确认政策的执行情况。

政策与合同约定一致。

## 2、客户集中度

请发行人补充披露主要客户合作稳定性。

前五大客户占比稳定。

三、关于成本与毛利率情况

根据审核问询函，发行人说明如下。

## 1、单位成本

请发行人量化分析单位成本变动原因。

原材料价格回落。`

/** 「一、关于《审核问询函》问题N」律师函形态（山高环能实测）：序数+关于+
 *  函名+题号——归 H3/H5 域，T4A 不得收（防抢 H5 已拆对的文档）。 */
const T4_QUESTION_REF_SAMPLE = `某律师事务所补充法律意见书

## 一、关于《审核问询函》问题1.关于业绩波动

本所律师就发行人业绩波动情况进行了核查。

核查程序及结论如下。

## 二、关于《审核问询函》问题2.关于关联交易

本所律师核查了报告期内的关联交易情况。

核查程序及结论如下。`



describe("qa-split — cn2num", () => {
  it("converts digits and Chinese numerals (v4 mapping + single digits)", () => {
    expect(cn2num("42")).toBe(42)
    expect(cn2num("三")).toBe(3)
    expect(cn2num("十")).toBe(10)
    expect(cn2num("十三")).toBe(13)
    expect(cn2num("三十")).toBe(30)
    expect(cn2num("三十三")).toBe(33)
    expect(cn2num("百")).toBe(0) // 超域如实返回 0（题号上限 299）
  })
})

describe("qa-split — classifyQaDocument", () => {
  it("classifies reply-letter by opening sentence", () => {
    expect(classifyQaDocument(H2_SAMPLE)).toBe("reply")
    expect(classifyQaDocument(H3_SAMPLE)).toBe("reply")
    expect(classifyQaDocument(H4_SAMPLE)).toBe("reply")
  })

  it("classifies inquiry-letter sample with reply blocks as reply", () => {
    // H1_SAMPLE 含「回复：」块 → 实为回复函形态（kind 只影响 H4 兜底资格
    // 与摘要文案，不影响 H1-H3 拆题）
    expect(classifyQaDocument(H1_SAMPLE)).toBe("reply")
  })

  it("rejects plain regulation text", () => {
    expect(classifyQaDocument(NON_QA_SAMPLE)).toBeNull()
    expect(classifyQaDocument("")).toBeNull()
  })

  it("classifies supplementary legal opinions by numbered inquiry sections (2026-10-10 fix)", () => {
    expect(classifyQaDocument(OPINION_SAMPLE)).toBe("reply")
  })

  it("classifies evaluation/accountant review letters with annotated question numbers (T2, 2026-10-14)", () => {
    // 「问题一（原问题六）、」注记形态即特异结构（普通文档/法规不出现）；
    // 回复块「答复：」认进 H4 后 hasReplyMarker 自然命中。
    expect(classifyQaDocument(EVAL_REVIEW_SAMPLE)).toBe("reply")
  })

  it("classifies 「函回复」 word-order accountant special statements (T2, 2026-10-14)", () => {
    // 封面「审核问询函回复的专项说明」动宾语序 + 单「回复：」块——
    // 此前「的回复」锚漏判整族。
    expect(classifyQaDocument(ACCOUNTANT_REPLY_SAMPLE)).toBe("reply")
  })
})

describe("qa-split — splitQaDocument channels", () => {
  it("splits H1 heading style (## 问题N)", () => {
    const result = splitQaDocument(H1_SAMPLE, "letter")
    expect(result.channel).toBe("H1")
    expect(result.questions).toHaveLength(2)
    expect(result.questions[0].questionNo).toBe(1)
    expect(result.questions[1].questionNo).toBe(2)
    // letter 原件：问题1 无回复块 → replyText 为空
    expect(result.questions[0].replyText).toBe("")
    expect(result.questions[1].replyText).toContain("一、本次募投项目符合产业政策")
  })

  it("splits H2 shenzhen IPO style and ignores reply-body subheadings", () => {
    const result = splitQaDocument(H2_SAMPLE, "reply")
    expect(result.channel).toBe("H2")
    // 千分一二轮实测口径 3 题；本截取样本含 2 个真标题
    expect(result.questions).toHaveLength(2)
    expect(result.questions[0].questionNo).toBe(1)
    expect(result.questions[0].title).toContain("产品竞争力")
    expect(result.questions[0].questionText).toContain("根据申报材料")
    // 回复内的 `## 1、发行人智能笔…` 小节不得成为题边界：归入题 1 回复正文
    expect(result.questions[0].replyText).toContain("## 1、发行人智能笔与终端产品的配套销售模式")
    expect(result.questions[0].replyText).toContain("配套销售模式下的收入确认政策保持一致")
    expect(result.questions[1].questionNo).toBe(2)
    expect(result.questions[1].replyText).toContain("核心技术指标处于行业领先水平")
  })

  it("splits H3 using body markers, skipping TOC dot-leader lines", () => {
    const result = splitQaDocument(H3_SAMPLE, "reply")
    expect(result.channel).toBe("H3")
    expect(result.questions).toHaveLength(3)
    expect(result.tocNumbers).toEqual([1, 2, 3])
    expect(result.questions[0].questionNo).toBe(1)
    expect(result.questions[0].title).toBe("关于主要产品")
    // 目录行（点线）不得混进正文
    expect(result.questions[0].questionText).not.toContain("....")
    expect(result.questions[0].questionText).toContain("发行人核心产品为 BOPP 电工膜")
    expect(result.questions[0].replyText).toContain("市场占有率较高")
    expect(result.questions[2].replyText).toContain("电力电容器生产企业")
  })

  it("splits H4 by reply-block count when no question numbers exist", () => {
    const result = splitQaDocument(H4_SAMPLE, "reply")
    expect(result.channel).toBe("H4")
    expect(result.questions).toHaveLength(1)
    expect(result.questions[0].questionNoIsGenerated).toBe(true)
    expect(result.questions[0].questionNo).toBe(1)
    expect(result.questions[0].questionText).toContain("请发行人补充说明 2025 年业绩变动情况")
    // 小数防御：质量问题 266.77 不得产生题号 266
    expect(result.questions.map((q) => q.questionNo)).not.toContain(266)
    expect(result.questions).toHaveLength(1)
  })

  it("splits annotated question numbers 「问题一（原问题六）、」 with 答复 blocks (T2, 2026-10-14)", () => {
    const result = splitQaDocument(EVAL_REVIEW_SAMPLE, "reply")
    expect(result.channel).toBe("H3")
    expect(result.questions).toHaveLength(3)
    // 主号优先：问题一（原问题六）取 1，注记里的 6 不产生独立题
    expect(result.questions.map((q) => q.questionNo)).toEqual([1, 2, 3])
    expect(result.questions[0].title).toContain("评估作价和商誉")
    expect(result.questions[0].replyText).toContain("市场法定价")
    expect(result.questions[2].replyText).toContain("订单覆盖率")
  })

  it("splits single-reply accountant special statement via H4 (T2, 2026-10-14)", () => {
    const result = splitQaDocument(ACCOUNTANT_REPLY_SAMPLE, "reply")
    expect(result.questions).toHaveLength(1)
    expect(result.questions[0].questionNoIsGenerated).toBe(true)
    expect(result.questions[0].replyText).toContain("核查意见")
  })

  it("rejects decimal false positives (问题 266.77)", () => {
    const decimalOnly = `某公司问询函回复

回复：

其中：产品质量问题 266.77 181.93 84.29

处理措施：已整改。`
    const result = splitQaDocument(decimalOnly, "reply")
    expect(result.questions.every((q) => q.questionNo !== 266)).toBe(true)
  })

  it("routes unidentifiable documents to the manual queue, not silence", () => {
    const scanned = `## Page 1

（扫描件，无文本层）`
    const result = splitQaDocument(scanned, "letter")
    expect(result.questions).toHaveLength(0)
    expect(result.manualQueue).toContain("无法识别")
  })

  it("splits supplementary legal opinions via prefixed 「一、《审核问询函》问题N.」 markers (2026-10-10 fix)", () => {
    const result = splitQaDocument(OPINION_SAMPLE, "reply")
    expect(result.channel).toBe("H3")
    expect(result.questions).toHaveLength(2)
    expect(result.questions[0].questionNo).toBe(2)
    expect(result.questions[0].title).toContain("交易方案和整合管控")
    expect(result.questions[1].questionNo).toBe(13)
    // 意见书无「回复：」标记：第一个论证小节（（一）…）作为题目/回复分界
    expect(result.questions[0].questionText).toContain("请结合最近三年上市公司")
    expect(result.questions[0].replyText).toContain("（一）结合最近三年上市公司及其控股股东")
    expect(result.questions[0].replyText).toContain("不构成重大违法行为")
    // 小节内容必须在所属题目内（不丢内容）
    expect(result.questions[1].replyText).toContain("连带责任保证")
  })

  it("splits bare-line question boundaries missing ## heading (千分一二轮 题4/5, 2026-10-12 fix)", () => {
    // MinerU 对部分真题边界不加 ##：题4/5 裸行 + 紧邻「首轮问询回复及申报
    // 材料显示：」三段式佐证。修复前题4/5 整体混入题3 页（漏题实锤）。
    const sample = `## 1.关于产品竞争力

根据申报材料：（1）发行人智能笔业务收入占比较高。

回复：

一、产品竞争力较强。

3.关于收入

请发行人说明收入确认政策。

回复：

一、收入确认政策保持一致。

4.关于成本核算的准确性与采购公允性

首轮问询回复及申报材料显示：

（1）报告期各期，发行人 IC 采购单价持续下降。

回复：

一、成本核算准确。

5.关于存货跌价准备计提的充分性

首轮问询回复及申报材料显示：

（1）报告期各期末，发行人原材料余额较高。

回复：

一、存货跌价准备计提充分。`
    const kind = classifyQaDocument(sample)
    expect(kind).toBe("reply")
    const split = splitQaDocument(sample, kind!)
    expect(split.channel).toBe("H2")
    expect(split.questions.map((q) => q.questionNo)).toEqual([1, 3, 4, 5])
    const build = buildQuestionFileBlocks(
      sample, split,
      extractPathMeta("scheduled-import/问答/2025/深交所/IPO/创业板/注册/某/x.pdf"),
      extractRoundMeta(sample, "回复.pdf"),
      "x.pdf", "slug",
    )
    expect(build.verbatimViolations).toEqual([])
  })

  it("splits dun-heading true boundaries with TOC dot-leader exclusion (埃泰克二轮, 2026-10-12 fix)", () => {
    // 真题边界是顿号标题「## 1、关于行业代表性」+ 紧邻「根据申报材料…」；
    // 同形态目录行带点线页码被排除；回复内顿号小节无佐证不误收。
    const sample = `## 目录

1、关于行业代表性 …… 4

2、关于营业收入 …… 28

## 1、关于行业代表性

根据申报材料及问询回复：（1）发行人在细分市场占有率第一。

请发行人披露：行业代表性的论证依据。

回复：

一、细分市场占有率数据如下。

## 2、关于营业收入

根据申报材料及问询回复：（1）发行人营业收入持续增长。

回复：

一、增长原因合理。

## 3、回复内小节形态（不应成题）

该小节后面没有题干三段式，属于上一题回复的论证内容，较长的正文
在这里展开，用以确认顿号小节不会被结构佐证误收为题边界。`
    const kind = classifyQaDocument(sample)
    expect(kind).toBe("reply")
    const split = splitQaDocument(sample, kind!)
    expect(split.channel).toBe("H2")
    expect(split.questions.map((q) => q.questionNo)).toEqual([1, 2])
  })

  it("splits 《函名》N.关于 boundaries without 问题 word (天风证券 7-3 律师函形态, 2026-10-12 fix)", () => {
    // 7-3 律师函一族：题边界「## 一、 《问询函》1.关于发行方案」——《函名》
    // + 题号直起、无「问题」字样；题号跳号（律师只覆盖法律题）合法。
    const sample = `北京市某律师事务所
关于天风证券股份有限公司向特定对象发行A股股票的补充法律意见书（一）

一、《问询函》1.关于发行方案....8

二、《问询函》2.关于融资必要性与合理性....14

三、《问询函》4.其他....25

## 一、 《问询函》1.关于发行方案

（一）本次发行方案的内容

发行方案的内容论述。

## 二、《问询函》2.关于融资必要性与合理性

（一）融资必要性

融资必要性论述。

## 三、《问询函》4.其他

（一）其他事项

其他事项论述。`
    const kind = classifyQaDocument(sample)
    expect(kind).toBe("reply")
    const split = splitQaDocument(sample, kind!)
    expect(split.channel).toBe("H3")
    expect(split.questions.map((q) => q.questionNo)).toEqual([1, 2, 4])
    expect(split.questions[0].title).toContain("发行方案")
  })

  it("rejects single-marker fallback without question-context corroboration (天风假边界治本, 2026-10-12)", () => {
    // 无题号意见书：散落的「## 2. 合规风控层面」是论证小节——单行 H2 弱信号
    // 直收会把小节当题、前文全部混进假题。无佐证必须 0 题（交给 L6/人工）。
    const sample = `某公司补充法律意见书

本所律师已履行核查程序。

## 1. 生产经营方面

发行人生产经营正常。

## 2. 合规风控层面

合规风控建设完善，全面风险管理体系健全，切实发挥三道防线协同配合作用。

## 1. 核查程序

本所律师执行了以下核查程序。`
    const kind = classifyQaDocument(sample)
    const split = splitQaDocument(sample, kind ?? "reply")
    expect(split.questions).toHaveLength(0)
    expect(split.manualQueue).toContain("无法识别")
  })

  it("is deterministic on rerun (idempotent split)", () => {
    const first = splitQaDocument(H3_SAMPLE, "reply")
    const second = splitQaDocument(H3_SAMPLE, "reply")
    expect(second).toEqual(first)
    // 页路径由 slug+question_no 决定，重跑同题号覆盖、页数不翻倍
    expect(first.questions.map((q) => `q${q.questionNo}`)).toEqual(["q1", "q2", "q3"])
  })
})

describe("qa-split — T4 中介机构序数大节通道（2026-10-19）", () => {
  it("classify admits accountant letters with 一、关于XX major sections (was not-qa)", () => {
    expect(classifyQaDocument(T4_ACCOUNTANT_SAMPLE)).toBe("reply")
    expect(classifyQaDocument(T4_DIRECT_STEM_SAMPLE)).toBe("reply")
  })

  it("rejects standard-chapter legal opinions (编报规则 12 号骨架红线)", () => {
    // 序数递增 + 短名词短语章节 + 不带「关于」/问询句式长题干 → not-qa
    expect(classifyQaDocument(T4_STANDARD_CHAPTER_SAMPLE)).toBeNull()
  })

  it("splits marker-less accountant letters into 一、关于 major sections (H5 admission via classify)", () => {
    const split = splitQaDocument(T4_ACCOUNTANT_SAMPLE, "reply")
    expect(split.questions.length).toBe(3)
    expect(split.questions[0].title).toContain("关于融资规模与效益预测")
    expect(split.questions.map((q) => q.questionNo)).toEqual([1, 2, 3])
  })

  it("T4A takes over H2 when dun-numbered subsections restart per section (中贝通信混题治本)", () => {
    const split = splitQaDocument(T4_TAKEOVER_SAMPLE, "reply")
    expect(split.channel).toBe("T4")
    expect(split.questions.length).toBe(3)
    // 题干区不含论证小节（题目/回复分界落在「## 1、」阿拉伯小节上）
    expect(split.questions[0].replyText).toContain("## 1、募投项目投资构成")
    expect(split.questions[0].questionText).not.toContain("募投项目投资构成")
  })

  it("T4B catches direct-stem major sections (方正科技族) as the last structural fallback", () => {
    const split = splitQaDocument(T4_DIRECT_STEM_SAMPLE, "reply")
    expect(split.channel).toBe("T4")
    expect(split.questions.length).toBe(2)
    expect(split.questions[0].title).toContain("建筑工程费")
  })

  it("T4B yields to 第X部分 layered documents (千岸科技形态)", () => {
    const split = splitQaDocument(T4_PART_STRUCTURE_SAMPLE, "reply")
    expect(split.channel).not.toBe("T4")
    // 第一部分由回复块通道兜住，不被部分结构的直述长节拆坏
    expect(split.questions.length).toBeGreaterThanOrEqual(1)
  })

  it("T4A ignores 一、关于《函名》问题N reference lines (山高环能形态，归 H3/H5 域)", () => {
    const split = splitQaDocument(T4_QUESTION_REF_SAMPLE, "reply")
    expect(split.channel).not.toBe("T4")
    expect(split.questions.length).toBe(2)
  })

  it("keeps title verbatim slices as raw-md substrings (verbatim红线)", () => {
    const split = splitQaDocument(T4_TAKEOVER_SAMPLE, "reply")
    for (const q of split.questions) {
      expect(T4_TAKEOVER_SAMPLE.replace(/\r\n/g, "\n").includes(q.questionText)).toBe(true)
      if (q.replyText) {
        expect(T4_TAKEOVER_SAMPLE.replace(/\r\n/g, "\n").includes(q.replyText)).toBe(true)
      }
    }
  })
})

describe("qa-split — extractRoundMeta", () => {
  it("reads round from the body issuance sentence, not the filename", () => {
    // 千分一泛名文件实测形态：文件名无轮次，正文出具句直接带「第三轮」
    const body = `关于深圳市千分一智能技术股份有限公司

贵所于 2026 年 1 月 6 日出具的《关于深圳市千分一智能技术股份有限公司首次公开发行股票并在创业板上市申请文件的第三轮审核问询函》已收悉。`
    const meta = extractRoundMeta(body, "发行人及中介机构回复意见.pdf")
    expect(meta.roundNo).toBe(3)
    expect(meta.roundKind).toBe("审核问询函")
    expect(meta.issuer).toBe("交易所")
    expect(meta.basis).toContain("正文出具句")
  })

  it("defaults marker-less 审核问询函 to round 1 without misreading 首次公开发行 as a round", () => {
    const body = `贵所于 2025 年 11 月 27 日出具的《关于泉州嘉德利电子材料股份公司首次公开发行股票并在沪市主板上市申请文件的审核问询函》已收悉。`
    // 正文无轮次字样（「首次」修饰公开发行，不是轮次）；2026-10-19 定案：
    // 审核问询函族无轮次标记 = 首轮（上交所首轮函制度性无「第N轮」字样）
    const meta = extractRoundMeta(body, "8-1 发行人及中介机构关于审核问询函的回复.pdf")
    expect(meta.roundNo).toBe(1)
    expect(meta.basis).toContain("首轮默认")
    expect(meta.basis).not.toContain("文件名轮次")
    // 文件名带「首轮」上下文 → 回退识别（basis 标弱参考，非默认）
    expect(extractRoundMeta(body, "8-1 发行人及中介机构关于首轮审核问询函的回复.pdf").roundNo).toBe(1)
  })

  it("maps 注册环节反馈意见 to CSRC issuer and 注册反馈 kind", () => {
    const body = `根据贵会于 2025 年 8 月 1 日出具的《关于某公司首次公开发行股票注册环节反馈意见函》：
回复：`
    const meta = extractRoundMeta(body, "6-1-1 落实函回复.pdf")
    expect(meta.issuer).toBe("证监会")
    expect(meta.roundKind).toBe("注册反馈")
  })

  it("falls back to the filename as a weak reference", () => {
    const meta = extractRoundMeta("正文没有任何轮次信息。", "关于第一轮审核问询函的回复.pdf")
    expect(meta.roundNo).toBe(1)
    expect(meta.basis).toBe("文件名弱参考")
  })
  it("keeps 落实函/注册反馈 honest (no round invention) while 审核问询函 defaults to 1", () => {
    // 无关文本 + 泛名文件：函类判为审核问询函族 → 首轮默认 1（制度性形态）
    const meta = extractRoundMeta("无关文本。", "发行人及中介机构回复意见.pdf")
    expect(meta.roundNo).toBe(1)
    expect(meta.basis).toContain("首轮默认")
    // 落实函/注册反馈识别不出轮次保持 null——落实函对应第N轮问询的落实，
    // 轮次不可默认（如实省略）
    const impl = extractRoundMeta(
      "贵所于 2025 年 9 月 10 日出具的《关于某公司向特定对象发行股票的审核中心意见落实函》已收悉。",
      "7-3 落实函回复.pdf",
    )
    expect(impl.roundKind).toBe("落实函")
    expect(impl.roundNo).toBeNull()
  })
})

describe("qa-split — extractPathMeta", () => {
  it("parses the SSE/SZSE six-segment layout", () => {
    const meta = extractPathMeta(
      "scheduled-import/问答/2025/上交所/IPO/主板/注册/嘉德利/8-1 发行人及中介机构关于首轮审核问询函的回复.pdf",
    )
    expect(meta).toEqual({
      year: "2025",
      exchange: "上交所",
      deal: "IPO",
      board: "主板",
      status: "注册",
      company: "嘉德利",
    })
  })

  it("adapts the Beijing layout (no board segment, deal normalized to IPO)", () => {
    const meta = extractPathMeta(
      "scheduled-import/问答/2025/北交所/公开发行并上市/注册/世纪数码/世纪数码：第二轮问询的回复.pdf",
    )
    expect(meta.year).toBe("2025")
    expect(meta.exchange).toBe("北交所")
    expect(meta.deal).toBe("IPO")
    expect(meta.board).toBeUndefined()
    expect(meta.status).toBe("注册")
    expect(meta.company).toBe("世纪数码")
  })

  it("normalizes 并购重组 directory naming into the deal value domain", () => {
    const meta = extractPathMeta(
      "scheduled-import/问答/2025/上交所/并购重组/主板/注册/某公司/回复.pdf",
    )
    expect(meta.deal).toBe("重大资产重组")
  })

  it("falls back to the file stem outside the 问答 tree", () => {
    const meta = extractPathMeta("notes/发行人回复意见.pdf")
    expect(meta.company).toBe("发行人回复意见")
    expect(meta.exchange).toBeUndefined()
  })
})

describe("qa-split — buildQuestionFileBlocks (verbatim quality gate)", () => {
  const split = splitQaDocument(H3_SAMPLE, "reply")
  const pathMeta = extractPathMeta(
    "scheduled-import/问答/2025/上交所/IPO/主板/注册/嘉德利/x.pdf",
  )
  const roundMeta = extractRoundMeta(H3_SAMPLE, "8-1 回复.pdf")
  const build = buildQuestionFileBlocks(
    H3_SAMPLE,
    split,
    pathMeta,
    roundMeta,
    "scheduled-import/问答/2025/上交所/IPO/主板/注册/嘉德利/x.pdf",
    "test-slug",
  )

  it("emits zero verbatim violations and one FILE block per question plus the source page", () => {
    expect(build.verbatimViolations).toEqual([])
    expect(build.pageCount).toBe(3)
    const matches = [...build.fileBlocksText.matchAll(FILE_BLOCK_REGEX)]
    expect(matches).toHaveLength(4) // 1 sources + 3 questions
    const paths = matches.map((m) => m[1])
    expect(paths[0]).toBe("wiki/sources/test-slug.md")
    expect(paths.slice(1)).toEqual([
      "wiki/questions/test-slug-q1.md",
      "wiki/questions/test-slug-q2.md",
      "wiki/questions/test-slug-q3.md",
    ])
  })

  it("writes question/reply bodies as verbatim substrings of the raw markdown", () => {
    for (const question of split.questions) {
      expect(H3_SAMPLE.includes(question.questionText)).toBe(true)
      expect(H3_SAMPLE.includes(question.replyText)).toBe(true)
      expect(build.fileBlocksText).toContain(question.questionText)
      expect(build.fileBlocksText).toContain(question.replyText)
    }
  })

  it("carries path metadata and original question numbers in frontmatter", () => {
    expect(build.fileBlocksText).toContain("type: question")
    expect(build.fileBlocksText).toContain("question_no: 1")
    expect(build.fileBlocksText).toContain("question_no: 3")
    expect(build.fileBlocksText).toContain("exchange: 上交所")
    expect(build.fileBlocksText).toContain("board: 主板")
    expect(build.fileBlocksText).toContain("deal: IPO")
    expect(build.fileBlocksText).toContain("split_channel: H3")
    expect(build.fileBlocksText).toContain("round_kind: 审核问询函")
    expect(build.fileBlocksText).toContain("issuer: 交易所")
  })

  it("writes related wikilink + sources path on every question page (F1)", () => {
    // related 回挂 sources 摘要页（wikilink 进图）；sources 为来源文件
    // 路径（schema.md V1.3 question 专用字段样例形态）。
    expect(build.fileBlocksText).toContain('related: ["[[test-slug]]"]')
    expect(build.fileBlocksText).toContain(
      'sources: ["scheduled-import/问答/2025/上交所/IPO/主板/注册/嘉德利/x.pdf"]',
    )
    const matches = [...build.fileBlocksText.matchAll(FILE_BLOCK_REGEX)]
    const questionBlocks = matches.filter((m) => m[1].startsWith("wiki/questions/"))
    expect(questionBlocks).toHaveLength(3)
    for (const match of questionBlocks) {
      expect(match[2]).toContain('related: ["[[test-slug]]"]')
    }
  })

  it("escapes backslashes inside quoted frontmatter values (G3)", () => {
    // 题干标题含半角冒号触发双引号包裹，标题里的 `\` 必须转义成 `\\`——
    // js-yaml 对 `\`+字母按非法转义整页解析失败，Rust 子集却原样保留。
    const backslashSample = [
      "## 1.关于C:\\Users目录:披露口径的说明",
      "",
      "请发行人说明披露口径。",
      "",
      "回复：",
      "",
      "已按统一口径披露。",
      "",
      "## 2.关于环保处罚",
      "",
      "请发行人说明整改情况。",
      "",
      "回复：",
      "",
      "已完成整改。",
      "",
      "## 3.关于社保缴纳",
      "",
      "请发行人说明缴纳情况。",
      "",
      "回复：",
      "",
      "已足额缴纳。",
    ].join("\n")
    const split = splitQaDocument(backslashSample, "reply")
    expect(split.channel).toBe("H2")
    const build = buildQuestionFileBlocks(
      backslashSample,
      split,
      extractPathMeta("问答/2025/深交所/IPO/创业板/注册/某公司/x.pdf"),
      extractRoundMeta(backslashSample, "x.pdf"),
      "x.pdf",
      "bs-slug",
    )
    expect(build.verbatimViolations).toEqual([])
    // YAML 落盘形态：C:\Users → C:\\Users（字面双反斜杠）
    expect(build.fileBlocksText).toContain("关于C:\\\\Users目录")
  })
})

describe("qa-split — buildQaSplitReportEntry (L4)", () => {
  it("keeps tagsApplied: 0 when explicitly passed; omits when undefined", () => {
    // L6 通道恒传（含 0=标签全被值域丢弃），与「非 L6 通道未打标=
    // 字段不出现」在对账文件里可区分。
    const withZero = buildQaSplitReportEntry("x.pdf", null, null, 0, "ok", "d", 0, {
      tagsApplied: 0,
    })
    expect(withZero.tagsApplied).toBe(0)
    const without = buildQaSplitReportEntry("x.pdf", null, null, 0, "ok", "d", 0, {})
    expect(without.tagsApplied).toBeUndefined()
  })
})

describe("qa-split — reply-section learning layer (W7.7, 2026-10-10)", () => {
  // 宇隆科技实测形态：题1回复内含「## 1、…」「## 2、…」论证小节——
  // 风险分析/产能消化/客户可持续性论证，有独立学习价值（咩咩拍板拆分学习）。
  const SECTION_SAMPLE = `## Page 1

某公司关于第二轮审核问询函的回复

## 1.关于业绩稳定性

请发行人结合市场情况说明业绩稳定性。

回复：

## 1、市场竞争加剧的风险

近年来，我国半导体显示面板及消费电子行业稳步发展，并带动配套产业链得到长足的进步，逐步成为全球重要的电子信息产业生产制造基地。若公司不能顺应市场与行业快速发展的趋势，通过研发投入、产品创新等方式巩固市场竞争力，则存在业绩下滑风险。

## 2、募投项目新建产能无法得到充分消化的风险

公司本次募投项目达产后可年产智能控制卡产品近 15,000 万片、年产精密功能器件 30,360 万片，较目前公司现有产能增加较多。公司本次募投项目系基于公司生产经营实际业务的需要，且有较为广阔的下游市场空间。若下游市场空间不及预期或市场拓展进度缓慢，募投项目新增产能存在无法充分消化的风险，公司已就相关风险在招股说明书中作出充分提示。

## 3、短小节

太短。

## 2.关于技术先进性

请发行人说明核心技术指标。

回复：

一、核心技术指标处于行业领先水平，公司与同行业可比公司相比具备明显技术优势，具体分析如下。

（一）研发投入占比高于同行业可比公司平均水平，报告期内累计研发投入占营业收入比例稳定在较高水平，为持续技术迭代和产品升级提供了充分的资金保障，形成了覆盖材料、工艺、结构设计的完整技术体系。

（二）核心产品性能参数达到国际主流厂商同等技术水平，公司主要产品已通过多家头部客户的产品认证并实现规模化量产，客户覆盖率和复购率均处于行业前列，技术先进性具有充分的市场验证。`

  it("emits section pages for numbered ## subsections (dominant shape + increasing sequence)", () => {
    const kind = classifyQaDocument(SECTION_SAMPLE)
    expect(kind).toBe("reply")
    const split = splitQaDocument(SECTION_SAMPLE, kind!)
    expect(split.questions).toHaveLength(2)
    const pathMeta = extractPathMeta("scheduled-import/问答/2025/深交所/IPO/创业板/注册/某公司/x.pdf")
    const roundMeta = extractRoundMeta(SECTION_SAMPLE, "回复.pdf")
    const build = buildQuestionFileBlocks(SECTION_SAMPLE, split, pathMeta, roundMeta, "x.pdf", "slug")
    expect(build.verbatimViolations).toEqual([])
    // 题1 的「## 1、」「## 2、」递增序列成节（## 3、短小节 <120 字不成页，
    // 内容仍在 question 页）；题2 回复里的裸「一、」「（一）」无 ## 前缀且
    // 不构成主导递增序列——不产 section（2026-10-10 爆量收口后的口径）。
    expect(build.sectionCount).toBe(2)
    const matches = [...build.fileBlocksText.matchAll(FILE_BLOCK_REGEX)]
    const sectionPaths = matches.map((m) => m[1]).filter((p) => p.startsWith("wiki/sections/"))
    expect(sectionPaths).toEqual(["wiki/sections/slug-q1-s1.md", "wiki/sections/slug-q1-s2.md"])
    // section 页正文逐字 + frontmatter 挂 question/section 归属
    expect(build.fileBlocksText).toContain("type: section")
    expect(build.fileBlocksText).toContain("section_no: 2")
    expect(build.fileBlocksText).toContain('related: ["[[slug-q1]]"]')
    // 短小节内容不丢：仍在所属题的回复正文里
    expect(split.questions[0].replyText).toContain("## 3、短小节")
  })

  it("keeps section text verbatim against the raw source", () => {
    const split = splitQaDocument(SECTION_SAMPLE, "reply")
    for (const question of split.questions) {
      for (const section of splitReplySections(question.replyText, question.questionNo)) {
        expect(SECTION_SAMPLE.replace(/\r\n/g, "\n").includes(section.text)).toBe(true)
      }
    }
  })
})

// ── L6 难例 LLM 兜底通道（2026-10-12 混合架构） ──────────────────────────

// T2 单题意见书（中贝 7-3 型）：无题号序列、无「回复：」块——规则通道
// 必然 0 题；分类签名（意见书类 + 「问询函第 N.M 题」对应句）进 qa 类。
const SINGLE_TOPIC_SAMPLE = `北京市某律师事务所
关于某通信集团股份有限公司向特定对象发行股票的
专项核查意见

致：某通信集团股份有限公司

本所接受发行人委托，就上海证券交易所审核问询函回复事项出具本专项核查意见。

现就问询函第 7.3 题所述事项进行核查并发表明确意见如下：

（一）核查过程及核查手段

本所律师查阅了发行人报告期内的银行流水、大额资金往来凭证，并对主要客户进行了访谈。

（二）核查结论

经核查，本所律师认为，发行人相关事项符合法律法规的规定，不存在重大违法违规情形。

本专项核查意见一式肆份，经盖章后生效。`

// T2 真实形态（中贝 7-3 实测摘录）：正文通篇无「第N题」字样，题干是
// 裸行小数题号直起「6.1 请发行人说明：…」；论证小节带 ## 前缀。
const ZHONGBEI_SAMPLE = `北京国枫律师事务所

# 关于中贝通信集团股份有限公司

# 2025 年度向特定对象发行股票的

补充法律意见书之一

致：中贝通信集团股份有限公司（发行人）

本所接受发行人的委托，担任发行人本次发行的专项法律顾问，并据此出具本补充法律意见书。

现出具补充法律意见如下：

6.1 请发行人说明：公司共享电动车业务的具体内容、经营模式、报告期各期的收入、利润规模及占比情况，是否存在互联网平台业务，相关经营是否合法合规。

请保荐机构及发行人律师核查并发表明确意见。

## 一、公司共享电动车业务的具体内容、经营模式、报告期各期的收入、利润规模及占比情况

## （一）公司共享电动车业务的具体内容、经营模式

根据发行人的陈述，公司共享电动车业务仅涉及共享电单车，主要分为产品销售模式和自有电单车运营模式。产品销售模式，即公司通过采购车架、电池等，组装成共享电单车后，向共享电单车运营商销售的方式实现收入。

## （二）报告期各期的收入、利润规模及占比情况

根据发行人的陈述，报告期内，公司共享电单车全部业务模式的营业收入占比较低。

## 二、是否存在互联网平台业务，相关经营是否合法合规

根据《国务院反垄断委员会关于平台经济领域的反垄断指南》第二条的规定，公司共享电单车业务不涉及互联网平台业务。`

// T1 难例（规则拆不出的不规则形态；LLM 边界候选可定位）
const IRREGULAR_SAMPLE = `某公司问询回复（转写格式不规则）

甲、关于经营资质
请发行人补充披露经营资质情况。

乙、关于环保处罚
请发行人说明环保处罚整改情况。

丙、关于社保缴纳
请发行人补充说明社保缴纳情况。`

const mockLlm = (payload: unknown) => async () => JSON.stringify(payload)

describe("qa-split — L6 llmFallbackSplit", () => {
  it("classifies single-topic opinion letters via SINGLE_TOPIC_OPINION_MARK (T2)", () => {
    expect(classifyQaDocument(SINGLE_TOPIC_SAMPLE)).toBe("reply")
    // 规则通道确实拆不出（否则轮不到 L6）
    expect(splitQaDocument(SINGLE_TOPIC_SAMPLE, "reply").questions).toHaveLength(0)
  })

  it("classifies the real 中贝 7-3 form: bare decimal lead-in, no 第N题 sentence (T2 form B)", () => {
    expect(classifyQaDocument(ZHONGBEI_SAMPLE)).toBe("reply")
    // 规则通道 0 题（题干是裸行 6.1，论证小节带 ## 前缀均不撞规则）
    expect(splitQaDocument(ZHONGBEI_SAMPLE, "reply").questions).toHaveLength(0)
    // 普通法规文本不受 form B 影响（无意见书签名）
    expect(classifyQaDocument(NON_QA_SAMPLE)).toBeNull()
  })

  it("splits the real 中贝 7-3 via one LLM boundary; ## 论证小节作题目/回复分界", async () => {
    const outcome = await llmFallbackSplit(ZHONGBEI_SAMPLE, "reply", {
      callLlm: mockLlm({
        questions: [
          {
            no: 6.1,
            first_line:
              "6.1 请发行人说明：公司共享电动车业务的具体内容、经营模式、报告期各期的收入、利润规模及占比情况，是否存在互联网平台业务，相关经营是否合法合规。",
            title_hint: "共享电动车业务合规性",
          },
        ],
        tags: ["inquiry-stage:交易所后续问询", "topic:业务合规"],
      }),
    })
    expect(outcome.split.channel).toBe("L6")
    expect(outcome.split.questions).toHaveLength(1)
    const q = outcome.split.questions[0]
    expect(q.questionNo).toBe(6.1)
    // 题目区：6.1 题干行 + 请保荐机构核查行；回复区：## 一、 起
    expect(q.questionText).toContain("6.1 请发行人说明")
    expect(q.questionText).toContain("请保荐机构及发行人律师核查")
    expect(q.questionText).not.toContain("## 一、公司共享电动车业务")
    expect(q.replyText).toContain("## 一、公司共享电动车业务的具体内容")
    expect(q.replyText).toContain("不涉及互联网平台业务")
    // 逐字红线
    expect(ZHONGBEI_SAMPLE.includes(q.questionText)).toBe(true)
    expect(ZHONGBEI_SAMPLE.includes(q.replyText)).toBe(true)
    expect(outcome.tags).toEqual(["inquiry-stage:交易所后续问询", "topic:业务合规"])
  })

  it("splits the single-topic opinion letter from one LLM boundary (中贝 7-3 型)", async () => {
    const outcome = await llmFallbackSplit(SINGLE_TOPIC_SAMPLE, "reply", {
      callLlm: mockLlm({
        questions: [
          {
            no: 7.3,
            first_line: "现就问询函第 7.3 题所述事项进行核查并发表明确意见如下：",
            title_hint: "银行流水核查",
          },
        ],
        tags: [
          "inquiry-stage:交易所后续问询",
          "topic:资金流水核查",
          "bogus:不在值域",
        ],
      }),
    })
    expect(outcome.split.channel).toBe("L6")
    expect(outcome.split.questions).toHaveLength(1)
    expect(outcome.split.questions[0].questionNo).toBe(7.3)
    expect(outcome.split.questions[0].questionText).toContain("现就问询函第 7.3 题")
    // 意见书形态：第一个（一）论证小节作为题目/回复分界
    expect(outcome.split.questions[0].replyText).toContain("（一）核查过程及核查手段")
    // 枚举外标签丢弃，值域内保留
    expect(outcome.tags).toEqual(["inquiry-stage:交易所后续问询", "topic:资金流水核查"])
    expect(outcome.detail).toContain("枚举外标签丢弃")
  })

  it("locates boundaries verbatim, allows question-number skips (会计师文件 [1,2,4])", async () => {
    const outcome = await llmFallbackSplit(IRREGULAR_SAMPLE, "reply", {
      callLlm: mockLlm({
        questions: [
          { no: 1, first_line: "甲、关于经营资质" },
          { no: 2, first_line: "乙、关于环保处罚" },
          { no: 4, first_line: "丙、关于社保缴纳" },
        ],
        tags: [],
      }),
    })
    expect(outcome.split.questions.map((q) => q.questionNo)).toEqual([1, 2, 4])
    // 全量逐字红线：题目与回复都是原文子串
    for (const q of outcome.split.questions) {
      expect(IRREGULAR_SAMPLE.includes(q.questionText)).toBe(true)
      if (q.replyText) expect(IRREGULAR_SAMPLE.includes(q.replyText)).toBe(true)
    }
  })

  it("prunes non-increasing question numbers and records the reason", async () => {
    const outcome = await llmFallbackSplit(IRREGULAR_SAMPLE, "reply", {
      callLlm: mockLlm({
        questions: [
          { no: 1, first_line: "甲、关于经营资质" },
          { no: 3, first_line: "乙、关于环保处罚" },
          { no: 2, first_line: "丙、关于社保缴纳" },
        ],
        tags: [],
      }),
    })
    expect(outcome.split.questions.map((q) => q.questionNo)).toEqual([1, 3])
    expect(outcome.detail).toContain("题号非递增")
  })

  it("rejects hallucinated first_line: all candidates dropped → manual queue with reason", async () => {
    const outcome = await llmFallbackSplit(IRREGULAR_SAMPLE, "reply", {
      callLlm: mockLlm({
        questions: [{ no: 1, first_line: "这一行在原文里根本不存在（LLM 幻觉）" }],
        tags: [],
      }),
    })
    expect(outcome.split.questions).toHaveLength(0)
    expect(outcome.split.manualQueue).toContain("llm-fallback-failed")
    expect(outcome.split.manualQueue).toContain("作废")
  })

  it("never locates a boundary on a TOC dot-leader line (L1)", async () => {
    // 目录行以 needle 开头会抢走「行前缀」命中——排除目录行后必须落到
    // 正文真行（其后紧跟题干）。
    const tocSample = [
      "目录",
      "甲、关于经营资质 .................. 3",
      "乙、关于环保处罚 .................. 5",
      "",
      "甲、关于经营资质",
      "请发行人补充披露经营资质情况。",
      "",
      "乙、关于环保处罚",
      "请发行人说明环保处罚整改情况。",
    ].join("\n")
    const outcome = await llmFallbackSplit(tocSample, "reply", {
      callLlm: mockLlm({
        questions: [
          { no: 1, first_line: "甲、关于经营资质" },
          { no: 2, first_line: "乙、关于环保处罚" },
        ],
        tags: [],
      }),
    })
    expect(outcome.split.questions).toHaveLength(2)
    expect(outcome.split.questions[0].questionText).toContain("请发行人补充披露经营资质情况")
    expect(outcome.split.questions[0].questionText).not.toContain("....")
    expect(outcome.split.questions[1].questionText).toContain("请发行人说明环保处罚整改情况")
  })

  it("drops candidates whose first_line is under 6 chars — over-short excerpts are mislocation bait (L1)", async () => {
    const outcome = await llmFallbackSplit(IRREGULAR_SAMPLE, "reply", {
      callLlm: mockLlm({
        questions: [{ no: 1, first_line: "甲、资质" }],
        tags: [],
      }),
    })
    expect(outcome.split.questions).toHaveLength(0)
    expect(outcome.split.manualQueue).toContain("llm-fallback-failed")
  })

  it("retries once on transient LLM failure and succeeds", async () => {
    let calls = 0
    const outcome = await llmFallbackSplit(IRREGULAR_SAMPLE, "reply", {
      callLlm: async () => {
        calls += 1
        if (calls === 1) throw new Error("network timeout")
        return JSON.stringify({
          questions: [{ no: 1, first_line: "甲、关于经营资质" }],
          tags: [],
        })
      },
    })
    expect(calls).toBe(2)
    expect(outcome.usage.retries).toBe(1)
    expect(outcome.split.questions).toHaveLength(1)
  })

  it("falls to manual queue with llm-fallback-failed when the call keeps failing", async () => {
    const outcome = await llmFallbackSplit(IRREGULAR_SAMPLE, "reply", {
      callLlm: async () => {
        throw new Error("503 service unavailable")
      },
    })
    expect(outcome.split.questions).toHaveLength(0)
    expect(outcome.split.manualQueue).toContain("llm-fallback-failed")
    expect(outcome.split.manualQueue).toContain("503")
  })

  it("rejects non-JSON output without retry (parse failure is not transient)", async () => {
    let calls = 0
    const outcome = await llmFallbackSplit(IRREGULAR_SAMPLE, "reply", {
      callLlm: async () => {
        calls += 1
        return "抱歉，我无法完成这个任务。"
      },
    })
    expect(calls).toBe(1)
    expect(outcome.split.manualQueue).toContain("无法解析")
  })

  it("writes fallback tags into question frontmatter (not sections), verbatim gate holds", async () => {
    const outcome = await llmFallbackSplit(SINGLE_TOPIC_SAMPLE, "reply", {
      callLlm: mockLlm({
        questions: [
          {
            no: 7.3,
            first_line: "现就问询函第 7.3 题所述事项进行核查并发表明确意见如下：",
          },
        ],
        tags: ["inquiry-stage:交易所后续问询", "topic:资金流水核查"],
      }),
    })
    const build = buildQuestionFileBlocks(
      SINGLE_TOPIC_SAMPLE,
      outcome.split,
      extractPathMeta("scheduled-import/问答/2025/上交所/再融资/主板/注册/某公司/7-3.pdf"),
      extractRoundMeta(SINGLE_TOPIC_SAMPLE, "7-3.pdf"),
      "7-3.pdf",
      "zhongbei",
      outcome.tags,
    )
    expect(build.verbatimViolations).toEqual([])
    expect(build.fileBlocksText).toContain("split_channel: L6")
    expect(build.fileBlocksText).toContain(
      'tags: ["inquiry-stage:交易所后续问询", "topic:资金流水核查"]',
    )
  })
})

describe("qa-split — sanitizeFallbackTags value domain (附录 B 全量枚举)", () => {
  it("keeps enum roots/leaves and topic: words; drops free-form detail and unknown roots", () => {
    const result = sanitizeFallbackTags([
      "inquiry-stage:交易所首轮问询", // 光杆根合法
      "inquiry-stage:交易所首轮问询·首轮·财务数据真实性", // 枚举叶值合法
      "inquiry-stage:交易所首轮问询·财务数据真实性", // 自由细目（旧形态）→ 枚举外
      "inquiry-stage:证监会注册审核", // 旧根名（少「问询」）→ 枚举外
      "inquiry-stage:不存在的轴根",
      "topic:收入确认",
      "随便一个标签",
      "topic:",
    ])
    expect(result.kept).toEqual([
      "inquiry-stage:交易所首轮问询",
      "inquiry-stage:交易所首轮问询·首轮·财务数据真实性",
      "topic:收入确认",
    ])
    expect(result.dropped).toEqual([
      "inquiry-stage:交易所首轮问询·财务数据真实性",
      "inquiry-stage:证监会注册审核",
      "inquiry-stage:不存在的轴根",
      "随便一个标签",
      "topic:",
    ])
  })

  it("multi-tag: keeps every conforming tag with no total cap (咩咩 2026-10-12)", () => {
    const result = sanitizeFallbackTags([
      "inquiry-stage:交易所后续问询",
      "inquiry-stage:交易所后续问询·后续·财务数据真实性与业绩质量",
      "inquiry-stage:交易所后续问询·后续·关联交易与资金往来",
      "inquiry-stage:证监会注册审核问询·注册·财务真实性与业绩质量",
      "topic:收入确认",
      "topic:关联交易",
      "topic:资金占用",
    ])
    expect(result.kept).toHaveLength(7)
    expect(result.dropped).toEqual([])
  })

  it("caps topic: at 6 (guardrail), drops duplicates silently", () => {
    const tags = [
      "topic:收入确认",
      "topic:关联交易",
      "topic:资金占用",
      "topic:存货跌价",
      "topic:客户稳定性",
      "topic:股份支付",
      "topic:研发费用", // 超限
      "topic:收入确认", // 重复
    ]
    const result = sanitizeFallbackTags(tags)
    expect(result.kept).toEqual([
      "topic:收入确认",
      "topic:关联交易",
      "topic:资金占用",
      "topic:存货跌价",
      "topic:客户稳定性",
      "topic:股份支付",
    ])
    expect(result.dropped).toEqual(["topic:研发费用"])
  })

  it("allowed values cover 3 roots + 23 appendix-B leaves (root names unified)", () => {
    expect(INQUIRY_STAGE_ALLOWED_VALUES).toHaveLength(26)
    expect(INQUIRY_STAGE_ALLOWED_VALUES).toContain("交易所首轮问询")
    expect(INQUIRY_STAGE_ALLOWED_VALUES).toContain("证监会注册审核问询")
    expect(INQUIRY_STAGE_ALLOWED_VALUES).toContain("交易所后续问询·后续·核心技术来源·科创企业")
    expect(INQUIRY_STAGE_ALLOWED_VALUES).not.toContain("证监会注册审核")
  })

  it("returns empty for non-array input", () => {
    expect(sanitizeFallbackTags(undefined)).toEqual({ kept: [], dropped: [] })
    expect(sanitizeFallbackTags("topic:x")).toEqual({ kept: [], dropped: [] })
  })
})
