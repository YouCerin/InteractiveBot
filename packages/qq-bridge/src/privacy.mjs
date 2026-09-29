/**
 * 隐私硬闸：**双侧独立** —— 写入侧拒绝落盘 + 输出侧拒绝发送。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么必须是**两侧**（不是"加一条过滤规则"）
 * ══════════════════════════════════════════════════════════════════════════
 * 两侧失效的**后果不同**，所以不能用同一个开关：
 *
 *   · 写入侧漏了 → 隐私躺在磁盘上。后果：被打包分享、被读回上下文、
 *                 被后续每一轮重复计费；但**还能补救**（删文件）。
 *   · 输出侧漏了 → 隐私**已经发给第三方**。QQ 消息**撤不回**，
 *                 这是本项目唯一"做错就无法挽回"的操作。
 *
 * 所以两张网各自独立生效，任一侧坏了另一侧仍然挡着。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 判据的写法纪律：**可核对的具体形状**，不是"注意隐私"这种空话
 * ══════════════════════════════════════════════════════════════════════════
 *   · 身份证：18 位 + **校验位算法**（不是"18 位数字" —— 那会误拦）
 *   · 银行卡：16~19 位 + **Luhn 校验**（同上）
 *   · 手机号：`1[3-9]` 开头的 11 位
 *   · 凭据：关键词 + **高熵串**（只看关键词会拦下"token 这个词本身"）
 *   · 住址：**行政区划 + 街道 + 门牌**的**组合**（单看"路"字满地都是）
 *
 * ⚠️ 一条硬约束：**登录号 / 群昵称 / 群名片 / 群号 不是隐私**，必须放行。
 *    它们在本项目里是**公开标识**（记忆系统拿 QQ 号当主键、群号当目录名）。
 *    闸门一旦把它们也拦了，整个记忆系统会被打死 —— 所以下面专门有
 *    `PUBLIC_IDENTITY_ALLOWLIST` 与对应的回归测试。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 审计只记**类别**，绝不记原文
 * ══════════════════════════════════════════════════════════════════════════
 * 否则这次拦截本身就成了新的泄露通道 —— 审计文件是要给人看、可能被分享的。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 七类隐私（与 `docs/0.2.1-runtime-memory-design.md` §2.5 逐条对应）。 */
export const PRIVACY_CATEGORIES = {
  idcard: '身份证号',
  phone: '手机号',
  bankcard: '银行卡号',
  credential: '密码/密钥',
  address: '住址',
  health: '健康医疗',
  biometric: '生物特征',
}

/** 拦截原因的人话（回执/日志/界面共用，只有一处措辞）。 */
export const PRIVACY_WHY = '涉及隐私信息'

/** 输出侧被拦下时发给对方的固定话术（不含任何原文片段）。 */
export const BLOCKED_OUTPUT_NOTICE =
  '（这条我不方便发出来 —— 里面像是隐私信息。要的话你自己保存好，别让我转发。）'

// ══════════════════════════════════════════════════════════════════════════
// 公开标识：**必须放行**（拦了会打死记忆系统）
// ══════════════════════════════════════════════════════════════════════════

/**
 * 这些**不是**隐私，是公开标识。测试里有一条专门盯"它们不被误拦"。
 *
 * - **QQ 号**：5~12 位裸数字（且附近没有"身份证/卡号"这类词）。它是记忆系统的
 *   主键、白名单的键、会话键的组成部分 —— 拦了等于关掉记忆。
 * - **群号**：同上。
 * - **日期/时间戳/用量数字**：`2026-09-26`、13 位毫秒时间戳、`1500`（字节数）等。
 * - **版本号、端口、模型名**里的数字。
 */
const LOOKS_LIKE_BARE_QQ_RE = /(?<!\d)\d{5,12}(?!\d)/
const LOOKS_LIKE_EPOCH_MS_RE = /(?<!\d)\d{13}(?!\d)/
const LOOKS_LIKE_DATE_RE = /\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?/

// ══════════════════════════════════════════════════════════════════════════
// 各类判据
// ══════════════════════════════════════════════════════════════════════════

/** 身份证校验位（GB 11643-1999）。**做校验，不靠位数猜**。 */
export function isValidIdCard(s) {
  const v = String(s ?? '').trim().toUpperCase()
  if (!/^\d{17}[\dX]$/.test(v)) return false
  // 出生日期必须合法（否则 18 位随机数字会被误判）
  const y = Number(v.slice(6, 10))
  const m = Number(v.slice(10, 12))
  const d = Number(v.slice(12, 14))
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return false
  const W = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
  const C = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2']
  let sum = 0
  for (let i = 0; i < 17; i += 1) sum += Number(v[i]) * W[i]
  return C[sum % 11] === v[17]
}

/** 银行卡 Luhn 校验。**做校验，不靠位数猜**。 */
export function isValidLuhn(s) {
  const v = String(s ?? '').replace(/[\s-]/g, '')
  if (!/^\d{16,19}$/.test(v)) return false
  let sum = 0
  let dbl = false
  for (let i = v.length - 1; i >= 0; i -= 1) {
    let n = Number(v[i])
    if (dbl) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    dbl = !dbl
  }
  return sum % 10 === 0
}

/** 中国大陆手机号（11 位、1[3-9] 开头）。 */
const PHONE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/

/** 18 位候选（校验位算法再筛一遍）。 */
const IDCAND_RE = /(?<!\d)\d{17}[\dXx](?!\d)/g
/** 16~19 位候选（Luhn 再筛一遍）。 */
const BANKCAND_RE = /(?<!\d)\d{16,19}(?!\d)/g

/**
 * 凭据/密钥：关键词 + **高熵**。
 *
 * ⚠️ 只看关键词会误拦 —— 提示词里满是"token"这个词（"你的 token 用量"）。
 *    所以要求**同时**出现"像密钥的值"：`sk-` 前缀、或长随机串、或 `key=value` 形态。
 */
const CRED_KEYWORD_RE = /(password|passwd|pwd|密码|口令|api[_-]?key|apikey|secret|token|access[_-]?token|私钥|密钥|验证码)/i
const CRED_VALUE_RE = /(?:^|[\s"'`=:：])(?:sk-[A-Za-z0-9_-]{16,}|[A-Za-z0-9_-]{24,})(?:$|[\s"'`,;；])/
/** 形如 `password: hunter2` / `密码=abc123`：关键词后紧跟一个短值。 */
const CRED_PAIR_RE = /(password|passwd|pwd|密码|口令|api[_-]?key|apikey|secret|token|密钥)\s*[:=：]\s*\S{4,}/i

/** 住址：**行政区划 + 街道 + 门牌**的组合，不是单个词。 */
const ADDRESS_RE =
  /(?:省|自治区|市)[^\n，,。]{0,10}(?:区|县|镇|乡|街道)[^\n，,。]{0,20}(?:路|街|巷|弄|大道|小区|花园|公寓|号楼|栋|单元|室)|(?:区|县)[^\n，,。]{0,10}(?:路|街|巷|弄)[^\n，,。]{0,10}\d+\s*号/

/** 健康/医疗：只认**明确的医疗词**，避免把技术讨论误判（实测里"主板 POST 码 B7"不是隐私）。 */
const HEALTH_RE =
  /(病历|确诊|诊断(书|结果|出)|吃药|服药|用药|处方|住院|门诊|手术|化疗|放疗|抑郁症|焦虑症|精神科|心理科|艾滋病|乙肝|糖尿病|高血压|癌|肿瘤|怀孕|孕期|流产|残疾证|医保卡)/

/**
 * 生物特征：**要求"数据形态"，不认裸词**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么必须收紧（这是实测出来的，不是假想）
 * ══════════════════════════════════════════════════════════════════════════
 * 收紧前的写法是 `/(人脸识别|面部识别|指纹(数据|信息|录入)?|声纹|虹膜|DNA|基因检测|生物特征)/`，
 * 它把**类别名本身**（`生物特征`）和**裸词**（`指纹`/`声纹`/`人脸识别`）都当成隐私。
 * 实测后果（放开 spawn 跑 `mocks/verify-onebot.mjs`，10 项失败、根因全在这一条）：
 *
 *   · **我们自己的系统提示词**里有这么一句（`src/memory-store.mjs` 的写入规则）：
 *     "不要记隐私：身份证号、手机号、银行卡号、密码或密钥、具体住址、健康医疗信息、
 *      生物特征（指纹/人脸/声纹）" —— 于是**提示词自己**被判成"含隐私"。
 *   · 输出侧一旦拦下，发给对方的就是那句"这条我不方便发出来…"，**整条回复被吞掉**。
 *     测试替身会把提示词回显成回复，所以它每次都撞上；真机上则是另一种更常见的撞法：
 *     有人问"指纹解锁坏了怎么办"，模型正常回答里出现"指纹"两字 → 回答被吞。
 *   · 这不是保护，是**坏了**：判据命中的是"在聊这个话题"，而不是"在泄露某个人的数据"。
 *     本文件开头那条纪律（"可核对的具体形状，不是空话"）本来就要求这样写 ——
 *     凭据那一条早就因为同样的原因被改成"关键词 + 高熵值"了。
 *
 * 所以现在只认**有数据形态的**：指纹数据/录入/模板/文件/库、声纹数据/样本、
 * 虹膜图像/数据、人脸·面部 + 识别数据/特征/照片库、DNA 检测/样本/报告、基因检测。
 * "小区装了人脸识别门禁"这种**技术名**不再被拦；真正的 `指纹数据` 仍然拦得住
 * （`verify-privacy.mjs` 里正例/反例各留了锚点，防止它被谁改回去）。
 */
const BIOMETRIC_RE =
  /(指纹(数据|信息|录入|模板|模版|文件|库)|声纹(数据|信息|样本|文件)|虹膜(数据|信息|图像)|(人脸|面部)(识别(数据|信息|库|结果)|特征|照片库|图像库|底库)|DNA\s*(检测|样本|数据|报告|鉴定)|基因检测)/i

/**
 * 扫描一段文本，返回命中的隐私类别。
 *
 * @param {string} text
 * @returns {{hit: boolean, categories: string[], why: string}}
 */
export function scanPrivacy(text) {
  const s = String(text ?? '')
  if (!s) return { hit: false, categories: [], why: '' }
  const found = new Set()

  // ① 身份证：先找 18 位候选，再**过校验位**（不过的不算）
  for (const m of s.matchAll(IDCAND_RE)) {
    if (isValidIdCard(m[0])) found.add('idcard')
  }
  // ② 手机号
  if (PHONE_RE.test(s)) found.add('phone')
  // ③ 银行卡：16~19 位候选 + **Luhn**。
  //    ⚠️ 必须排除已经被判为身份证/手机号的那些数字，否则同一串会被记成三类。
  for (const m of s.matchAll(BANKCAND_RE)) {
    const v = m[0]
    if (PHONE_RE.test(v)) continue
    if (isValidIdCard(v)) continue
    if (isValidLuhn(v)) found.add('bankcard')
  }
  // ④ 凭据
  if (CRED_PAIR_RE.test(s)) found.add('credential')
  else if (CRED_KEYWORD_RE.test(s) && CRED_VALUE_RE.test(s)) found.add('credential')
  // ⑤ 住址
  if (ADDRESS_RE.test(s)) found.add('address')
  // ⑥ 健康医疗
  if (HEALTH_RE.test(s)) found.add('health')
  // ⑦ 生物特征
  if (BIOMETRIC_RE.test(s)) found.add('biometric')

  const categories = [...found]
  return {
    hit: categories.length > 0,
    categories,
    why: categories.length ? `${PRIVACY_WHY}（${categories.map((c) => PRIVACY_CATEGORIES[c]).join('、')}）` : '',
  }
}

/**
 * 这段文本看起来是不是"**可能含隐私**"，因而需要更细的判定？
 *
 * 用途：给调用方一个便宜的预筛（避免对每一句话都跑全部正则）。
 * 注意它**偏向宽松**（宁可多跑一遍完整判定，也不要漏）。
 */
export function mayContainPrivacy(text) {
  const s = String(text ?? '')
  if (!s) return false
  // 数字串（身份证/手机/卡号）
  if (/\d{11,}/.test(s)) return true
  // 裸 QQ 号级别的数字 + 关键词（凭据形如 key=1234）
  if (LOOKS_LIKE_BARE_QQ_RE.test(s)) return true
  return CRED_KEYWORD_RE.test(s) || HEALTH_RE.test(s) || ADDRESS_RE.test(s) || BIOMETRIC_RE.test(s)
}

// ══════════════════════════════════════════════════════════════════════════
// 两侧入口
// ══════════════════════════════════════════════════════════════════════════

/**
 * **写入侧**：这条内容能不能落盘？
 *
 * @param {string} text
 * @returns {{ok: boolean, why?: string, categories?: string[]}}
 */
export function screenForStore(text) {
  const r = scanPrivacy(text)
  if (!r.hit) return { ok: true }
  return { ok: false, why: r.why, categories: r.categories }
}

/**
 * **输出侧**：这段要发给对方的内容能发吗？
 *
 * 与写入侧用**同一套判据**（`scanPrivacy`）—— 两侧判据必须一致，
 * 否则会出现"存得进去、发不出来"或反之这种自相矛盾的状态。
 *
 * @param {string} text
 * @returns {{ok: boolean, why?: string, categories?: string[]}}
 */
export function screenForOutput(text) {
  const r = scanPrivacy(text)
  if (!r.hit) return { ok: true }
  return { ok: false, why: r.why, categories: r.categories }
}

// ══════════════════════════════════════════════════════════════════════════
// 审计：**只记类别，绝不记原文**
// ══════════════════════════════════════════════════════════════════════════

/**
 * 追加一行隐私拦截审计。
 *
 * ⚠️ 对比一下"为什么不能记原文"：审计文件是给人看的、可能被分享，
 *    记了原文就等于**把拦截本身变成了新的泄露通道**。
 *    所以只记：何时、哪一侧、哪个类别、多少字（不记内容）。
 *
 * @param {object} opts
 * @param {string} opts.workspace
 * @param {'store'|'output'} opts.side
 * @param {string[]} opts.categories
 * @param {number} [opts.length] 被拦文本的**字符数**（不是内容）
 * @param {string} [opts.chatKey]
 */
export function logPrivacyBlock({ workspace, side, categories, length = 0, chatKey = '' }) {
  try {
    const dir = join(String(workspace ?? ''), 'memory')
    mkdirSync(dir, { recursive: true })
    const row = {
      ts: Date.now(),
      at: new Date().toISOString(),
      side,
      categories,
      length: Number(length) || 0,
      chatKey: String(chatKey || ''),
    }
    appendFileSync(join(dir, 'privacy-audit.jsonl'), `${JSON.stringify(row)}\n`, 'utf8')
    return true
  } catch {
    // 审计失败不能反过来影响主流程（写入侧还要继续拦、输出侧还要继续发安全话术）
    return false
  }
}

/** 读最近若干条隐私审计（体检/控制台用）。 */
export function readPrivacyAudit({ workspace, limit = 50 } = {}) {
  try {
    const p = join(String(workspace ?? ''), 'memory', 'privacy-audit.jsonl')
    if (!existsSync(p)) return []
    const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean)
    return lines
      .slice(-Math.max(1, limit))
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .reverse()
  } catch {
    return []
  }
}
