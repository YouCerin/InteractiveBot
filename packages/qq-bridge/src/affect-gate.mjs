/**
 * ★★ **情绪闸门**：给"未被唤醒但有情绪信号"的消息装一道判定器（2026-09-30 用户拍板）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 它解决的是哪一半问题（另一半是"零成本"，两边都不能丢）
 * ══════════════════════════════════════════════════════════════════════════
 * `affect-cues.mjs` 的判定是**确定性**的，命中即落盘 —— 但它只在桥接**真的注意到**的
 * 消息上跑：群聊里没 @ 机器人、也没命中唤醒词的消息，桥接在唤醒判定那一刻就丢掉了。
 * 实测这份真机语料：3598 条群聊消息里 **3488 条（97%）是未唤醒的**。
 *
 * 那把判定前移到唤醒之前行不行？**实测不行** —— 未唤醒消息里命中的 5 条，**4 条是错的**：
 *   · 「舍不得就别走呐」→ 会被记成"他希望你留在这里"（那是对**别人**说的挽留）
 *   · 「压力大肥鱼是吧」→ 记成"他焦虑的时候"（说的是别人，而且是玩笑）
 *   · 「别数着数着哭出来」→ 记成"他情绪低落"（"哭出来"说的是对方）
 *   · 「没意思」→ 两个字，多半在说游戏
 * 根因：群里"对别人说的话"占绝大多数，而**情绪词本身分不出在对谁说**。
 * 更要紧的是个人层**跟人走** —— 记错了会让他在别的群也被当成说过那句话。
 *
 * ∴ 折中方案（用户拍板）：**规则先筛、判定器再确认、默认一个字都不记**。
 *   只有"未唤醒 + 确定性判定命中"的那 0.35%（实测 3672 条里 13 条）才值得问一次模型。
 *
 * ── 三个档位（`memory.affect.prewake`）────────────────────────────────────
 *   · `off`（**默认**）：一个字都不问、不记 —— 与升级前完全一致；
 *   · `shadow`：判定照跑、**只记账不写盘** —— 先用一周看看"它到底会记下什么"；
 *   · `judge`：判定说"是在跟机器人说话"才写。
 *
 * ── 判定不出来时算哪个结论：**不记**（fail-closed）──────────────────────
 * 与唤醒判定正好相反。唤醒那边判不出来要放过（宁可多回一句）；这里判不出来**不记** ——
 * 因为写错了会**长期留在档案里、还会跟着人跨群走**，而漏记最多是少一条。
 * 所以 `failVerdict = VERDICT.NOT_TO_BOT`。
 */

import { createModelGate } from './model-gate.mjs'

/** 闸门档位（封闭集合）。 */
export const PREWAKE = Object.freeze({
  OFF: 'off',
  SHADOW: 'shadow',
  JUDGE: 'judge',
})

/** 闸门结论（封闭集合）。 */
export const GATE_VERDICT = Object.freeze({
  TO_BOT: 'to-bot',
  NOT_TO_BOT: 'not-to-bot',
})

export const AFFECT_GATE_DEFAULTS = {
  /**
   * 每小时最多判多少次。
   * 实测候选率约 0.35%（3672 条消息里 13 条）⇒ 120 远超正常量，
   * 只用来挡住"某个群集体刷情绪词"这种最坏情况。超了**不记**。
   */
  maxPerHour: 120,
  /** 单次超时。这里不赶时间（不阻塞回复），可以比唤醒判定宽松一点。 */
  timeoutMs: 8000,
  /** 只要一个小 JSON。 */
  maxTokens: 300,
  /** 分类任务：要的是稳定，不是创造力。 */
  temperature: 0,
}

/**
 * 配置值 → 档位。**未知取值一律 `off`**（fail-closed：宁可不动，也不要因为写错一个字
 * 就开始往档案里写东西），并且**不在这里告警** —— 告警是 `config.mjs` 的事
 * （那里能在启动时喊一次；这里每来一条消息都会调用）。
 */
export function normalizePrewakeMode(value) {
  const v = String(value ?? '').trim().toLowerCase()
  if (v === PREWAKE.SHADOW) return PREWAKE.SHADOW
  if (v === PREWAKE.JUDGE) return PREWAKE.JUDGE
  return PREWAKE.OFF
}

/** 这个取值认不认（给 `config.mjs` 的启动告警用 —— 它要能区分"没写"与"写错了"）。 */
export function isPrewakeMode(value) {
  const v = String(value ?? '').trim().toLowerCase()
  return v === PREWAKE.OFF || v === PREWAKE.SHADOW || v === PREWAKE.JUDGE
}

/**
 * 闸门提示词。
 *
 * ★ 为什么把"近期对话"也给它：**同一条消息，有没有上下文决定了它是不是在跟机器人说**。
 *   实测那句「舍不得就别走呐」单看像挽留，放在"某人说要退群"的上下文里就一目了然。
 * ★ 为什么把"没 @ 机器人、也没写它的名字"写进去：这是**事实**（它正是这个闸门存在的前提），
 *   不说的话模型会以为它已经被叫到了，于是倾向答 true。
 * ★ 为什么连反例一起写：这类判定最怕"看到情绪词就点头"。反例表是**被真机语料打出来的**
 *   （那 4 条误报），不是设想出来的。
 */
export function buildAffectGatePrompt({ senderName = '', text = '', recent = [], botNames = ['小鲸鱼'] } = {}) {
  const names = (Array.isArray(botNames) ? botNames : []).filter(Boolean).slice(0, 6).join('、') || '小鲸鱼'
  const ctx = (Array.isArray(recent) ? recent : [])
    .filter((m) => String(m?.text ?? '').trim())
    .slice(-10)
    .map((m) => `${m.isBot ? `机器人(${names})` : String(m.senderName ?? m.name ?? '某人')}：${String(m.text).trim()}`)

  return [
    `机器人在一个 QQ 群里的名字是「${names}」。群里刚刚有人说了一句话，**这句话没有 @ 它、也没写它的名字**。`,
    '请判断：**这句话是不是冲着机器人说的**（在向它倾诉、向它倾诉情绪、向它求助、向它表达接纳/期待，或把它当听众）。',
    '',
    '回答 `true` 只有这一种情形：说话人**把机器人当成说话对象**——哪怕只是"叹给它听"。',
    '以下一律回答 `false`：',
    '· 是在跟**别人**说（挽留别人、安慰别人、吐槽别人、对别人开玩笑）；',
    '· 说的是**别的东西**或别人（"这游戏崩溃了""我朋友最近很累""他难受"）；',
    '· 只是**提到**机器人（"那个机器人做得挺好"）或转述它的话；',
    '· 自言自语、玩梗、复读、感叹（"没意思""压力大肥鱼是吧"）；',
    '· **看不出在对谁说** ⇒ 一律 `false`。宁可不记，也不要记错（记错会长期留在档案里）。',
    '',
    ctx.length > 0 ? '【群里刚才说了这些（由旧到新）】' : '【群里刚才说了这些】',
    ...(ctx.length > 0 ? ctx.map((l) => `- ${l}`) : ['- （没有上下文）']),
    '',
    `【要判断的这一句】${senderName ? `${senderName}：` : ''}${String(text ?? '').trim()}`,
    '',
    '只输出**一行 JSON**，不要任何解释文字：',
    '{"toBot": true 或 false, "why": "不超过 20 字的理由"}',
  ].join('\n')
}

/** 结论字段名（模型不会只写 `toBot` —— 与唤醒判定同一类经验）。 */
const TRUE_KEYS = /^(tobot|to_bot|to-?机器人|对机器人说|是不是对机器人说|target|verdict|answer|conclusion|结论|回答)$/
const FALSE_WORDS = /^(false|no|0|否|不是|不是的|没有|不|错)$/
const TRUE_WORDS = /^(true|yes|1|是|是的|对|有|没错)$/

/**
 * 解析闸门输出。**认不出就 `ok:false`**（调用方据此按"不记"处理）。
 *
 * 支持的形状（都来自实测经验：模型不一定照格式写）：
 *   · 标准 JSON：`{"toBot": true, "why": "..."}`
 *   · 宽松 JSON / 夹杂文字：`结论：{"toBot": false}`、`to_bot = 是`
 *   · 裸布尔：`true` / `false` / `是` / `否`（只在整段就是这个词时才认）
 *
 * @returns {{ok: boolean, verdict?: string, reason?: string, via?: string, why?: string}}
 */
export function parseAffectGateVerdict(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return { ok: false, why: '判定输出为空' }

  const decide = (v, why, via) => {
    if (v === true) return { ok: true, verdict: GATE_VERDICT.TO_BOT, reason: oneLine(why, 60), via }
    if (v === false) return { ok: true, verdict: GATE_VERDICT.NOT_TO_BOT, reason: oneLine(why, 60), via }
    return null
  }
  const asBool = (v) => {
    if (typeof v === 'boolean') return v
    if (typeof v === 'number') return v === 1 ? true : v === 0 ? false : null
    const s = String(v ?? '').trim().toLowerCase()
    if (TRUE_WORDS.test(s)) return true
    if (FALSE_WORDS.test(s)) return false
    return null
  }

  // ── ① 标准 JSON ─────────────────────────────────────────────────────────
  let obj = null
  try {
    const strict = JSON.parse(text)
    if (strict && typeof strict === 'object' && !Array.isArray(strict)) obj = strict
  } catch {
    /* 落到宽松解析 */
  }

  // ── ② 宽松 JSON：从原文里截第一个平衡的花括号块 ──────────────────────────
  if (!obj) {
    const fb = firstBalancedSpan(text)
    if (fb) {
      try {
        const loose = JSON.parse(fb)
        if (loose && typeof loose === 'object' && !Array.isArray(loose)) obj = loose
      } catch {
        /* 继续往下 */
      }
    }
  }

  if (obj) {
    const hits = new Set()
    let why = ''
    for (const [k, v] of Object.entries(obj)) {
      const key = String(k).trim().toLowerCase()
      if (/(why|reason|原因|理由|说明)/.test(key) && typeof v === 'string') {
        why = v
        continue
      }
      if (!TRUE_KEYS.test(key)) continue
      const b = asBool(v)
      if (b !== null) hits.add(b)
    }
    if (hits.size === 1) {
      const r = decide([...hits][0], why, 'json')
      if (r) return r
    }
    if (hits.size > 1) {
      return { ok: false, why: '判定输出里同时出现了 true 与 false（互相矛盾），不敢猜', via: 'json' }
    }
    // 对象在、但结论字段认不出 ⇒ 继续往下扫
  }

  // ── ③ 纯文本配对：`toBot：是` / `to_bot = false` ────────────────────────
  const pair =
    /(?:^|[^A-Za-z0-9_])(toBot|to_bot|to-?机器人|对机器人说|verdict|answer|结论|回答|target)\s*["'」』]?\s*[:：=]\s*["'「『]?\s*(true|false|yes|no|是|否|对|不是|1|0)/i.exec(
      text,
    )
  if (pair) {
    const b = asBool(pair[2])
    if (b !== null) {
      const r = decide(b, pickWhy(text), 'scan')
      if (r) return r
    }
  }

  // ── ④ 整段就是一个裸布尔 ────────────────────────────────────────────────
  if (/^(true|false|yes|no|是|否|不是)$/i.test(text)) {
    const r = decide(asBool(text), '', 'bare')
    if (r) return r
  }

  return { ok: false, why: '判定输出里没有能认出来的结论（既不是 JSON，也没有 `toBot：是/否`）' }
}

/** 取理由：`why`/`reason`/`原因`/`理由` 后面那一段（与唤醒判定同一套经验）。 */
function pickWhy(text) {
  const m = /["'「『]?(why|reason|原因|理由|说明)["'」』]?\s*[:：=]\s*([\s\S]{1,200})/.exec(String(text ?? ''))
  if (!m) return ''
  return String(m[2])
    .replace(/["'」』]?\s*\}?\s*$/, '')
    .replace(/^["'「『\s]+/, '')
    .trim()
}

/** 截一行（理由要进日志，不能带换行）。 */
function oneLine(s, max) {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/**
 * 找第一个**平衡**的花括号块。
 *
 * ★ 为什么需要它（这是从 `extract.mjs` 的真机事故里学来的）：模型经常在 JSON 前后
 *   写一句话，或者**多写一个 `}`** —— 直接 `JSON.parse` 整段必然失败，
 *   而失败的表现是"判定没做"（于是这条就不记了），完全看不出原因。
 */
function firstBalancedSpan(text) {
  const s = String(text ?? '')
  const start = s.indexOf('{')
  if (start < 0) return ''
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return s.slice(start, i + 1)
    }
  }
  return ''
}

/**
 * 建情绪闸门。政策（通路 / 预算 / 超时 / 用量）全在 `model-gate.mjs`。
 *
 * ★ `failVerdict = NOT_TO_BOT`：**判不出来就不记** —— 与唤醒判定方向相反，理由见文件头。
 */
export function createAffectGate(opts = {}) {
  return createModelGate({
    ...opts,
    buildPrompt: buildAffectGatePrompt,
    parseVerdict: parseAffectGateVerdict,
    failVerdict: GATE_VERDICT.NOT_TO_BOT,
    tag: 'affect-gate',
    label: opts.label ?? '情绪闸门',
    timeoutMs: opts.timeoutMs ?? AFFECT_GATE_DEFAULTS.timeoutMs,
    maxPerHour: opts.maxPerHour ?? AFFECT_GATE_DEFAULTS.maxPerHour,
    maxTokens: opts.maxTokens ?? AFFECT_GATE_DEFAULTS.maxTokens,
    temperature: opts.temperature ?? AFFECT_GATE_DEFAULTS.temperature,
  })
}
