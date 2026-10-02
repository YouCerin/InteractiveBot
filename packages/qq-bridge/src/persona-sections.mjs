/**
 * **人设分节与节名归一**（纯函数，不碰文件系统、不碰网络）。
 *
 * 从 `src/chat-mode.mjs`（0.3.0beta）里拆出来的：那个模块同时装着
 * "说话方式长什么样"和"怎么把一篇人设切开"，而 0.3.0alpha 把双态判定整条删掉、
 * 说话方式搬了两次家（`src/voice.mjs` 的常量 → **最后落在人设文件里**）——
 * 只剩这一组**纯文本处理**留在这里。
 *
 * ★★ 0.3.0alpha 第二步之后，这个模块**实际在用的只剩 `personaVoiceSections()`**
 *    （给日志与自检回答"这份人设里有没有说话方式那一节"）。下面那套
 *    `split` / `render` / 别名表的**替换机制已经不在生产路径上** ——
 *    说话方式就是人设正文的一部分，没有"哪一节要被换掉"这回事了。
 *    保留它们是因为：① `personaVoiceSections()` 靠它分节；② 它们是**纯函数且有断言**，
 *    删掉等于把"分节这条能力"也一起删了，而将来若又要按节替换（比如多套人设各带口吻），
 *    这里就是现成的那一处。**别把它当成还在生效的机制。**
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么当初必须"替换"而不是"追加"（**历史**：这段判断是实测逼出来的）
 * ══════════════════════════════════════════════════════════════════════════
 * 0.3.0beta 时代，说话方式与基座人设的【怎么说话】【别变成客服】**直接冲突**：
 *   · 基座：「不要习惯性解释自己的行为」 vs 口吻：「……」开场
 *   · 基座：「对方认真问技术问题时就认真答」 vs 口吻：「不科普」
 * 把两段都塞进同一份提示词，等于**让模型自己挑一套听**——那不是"更丰富的风格"，
 * 是自相矛盾（同一份提示词里两处对同一件事给了相反的指令）。
 * ∴ 替换那两节；其余各节（反注入 / 被指出错了 / 别的机器人 / 表情包语境 / 名字块 …）
 *   **逐字保留** —— 它们是安全与硬约束，与口吻无关。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么认两套标题写法（2026-10-01 实测：自带人设就有两套）
 * ══════════════════════════════════════════════════════════════════════════
 * 三份自带人设里，前两份用「【怎么说话】」这种方括号节，第三份
 * （`软糯小鲸鱼（情绪）.md`）用的是 **`二、怎么说话`** 这种编号节 + 散文。
 * 分节器第一版只认 `【】`，于是第三份被当成"没有分节的人设"走进**追加**那条路
 * ⇒ 同一份提示词里同时有「需要说清楚就说够，**长一点也完全可以**」（原人设）
 * 与口吻里的「**极短**」两套相反口吻。这正是"替换而不是追加"要避免的事。
 */

/** 会被说话方式替换掉的节名（**规范名**，见 `canonicalStyleSection` 的别名表）。 */
export const STYLE_SECTIONS = ['怎么说话', '别变成客服']

/**
 * 节名的**别名表** —— 同义写法归一化。
 *
 * 归一化只用于**判断"这一节要不要换掉"**，原样渲染时仍用原标题（不动用户的东西）。
 */
const STYLE_SECTION_ALIASES = [
  { canonical: '怎么说话', re: /^(怎么说话|说话方式|说话的风格|怎么回话|语气)$/ },
  { canonical: '别变成客服', re: /^(别变成客服|不要变成客服|别当客服|不做客服)$/ },
]

/**
 * 中文章节序号前缀：`一、` / `十二、` / `1.` / `（三）` / `3）`。
 *
 * ⚠️ 只剥**序号本身**，剥完还得是个短标题（≤12 字）才算标题 ——
 * 否则正文里一句「一是要早点睡。」会被当成新节，把整篇切碎。
 */
const SECTION_ORDINAL_RE = /^\s*(?:[（(]?\s*(?:[一二三四五六七八九十]+|\d{1,2})\s*[)）]?)\s*[、.．:：]?\s*/

/** 从一行里认出"这一行是不是节标题"，返回标题文本；不是就返回 null。 */
export function personaSectionTitle(line) {
  const raw = String(line ?? '').trim()
  if (!raw) return null
  const bracket = /^【(.+?)】$/.exec(raw)
  if (bracket) return bracket[1].trim()
  // 编号式：剥掉序号后必须还是个**像标题的短句**（没有句末标点）
  const stripped = raw.replace(SECTION_ORDINAL_RE, '').trim()
  if (stripped === raw) return null
  if (!stripped || stripped.length > 12) return null
  if (/[。！？；，,]$/.test(stripped)) return null
  if (stripped.includes('。')) return null
  return stripped
}

/** 节名 → 规范名（不在表里就原样返回）。用于判断"这一节要不要被说话方式替换"。 */
export function canonicalStyleSection(title) {
  const t = String(title ?? '').trim()
  for (const { canonical, re } of STYLE_SECTION_ALIASES) {
    if (t.startsWith(canonical) || re.test(t)) return canonical
  }
  return t
}

/**
 * 按标题把一篇人设切成若干节（**纯函数，不碰文件系统**）。
 *
 * 认两种标题写法（都为实测所必需）：
 *   · 行首 `【怎么说话】`（前两份自带人设）
 *   · 行首 `二、怎么说话` / `2. 怎么说话`（第三份自带人设，也是常见手写习惯）
 *
 * ⚠️ 只在**行首**认：行内出现的「【名字】」这种引用不算新节，
 * 否则一段正文里提一下别的节名就会把整篇切碎。
 *
 * @param {string} text
 * @returns {{pre: string, sections: Array<{title: string, header: string, body: string}>, post: string}}
 *   `pre` = 第一个标题之前的内容（通常是空行/说明），`post` = 最后没有归属的尾巴。
 *   `header` = 标题的**原始那一行**（保留 `二、` 这种编号），渲染时优先用它。
 */
export function splitPersonaSections(text) {
  const src = String(text ?? '')
  if (!src.trim()) return { pre: '', sections: [], post: '' }

  const lines = src.split('\n')
  const marks = []
  for (let i = 0; i < lines.length; i += 1) {
    const title = personaSectionTitle(lines[i])
    // `header` 存**原样的那一行**：编号式人设（`二、怎么说话`）保留下来的节渲染时
    // 必须还是原来那一行 —— 否则"替换两节"会顺手把人设里的 `一、`…`八、` 全改成【】，
    // 那不是我们该动的东西（也让"只换了口吻节"这句话在结果里真的成立）。
    if (title) marks.push({ index: i, title, header: lines[i].trim() })
  }
  if (marks.length === 0) return { pre: src, sections: [], post: '' }

  const pre = lines.slice(0, marks[0].index).join('\n')
  const sections = marks.map((mk, k) => {
    const end = k + 1 < marks.length ? marks[k + 1].index : lines.length
    return { title: mk.title, header: mk.header, body: lines.slice(mk.index + 1, end).join('\n') }
  })
  return { pre, sections, post: '' }
}

/**
 * 从一份人设里找出**说话方式那一节**（0.3.0alpha 第二步）。
 *
 * 为什么需要它：说话方式不再是"代码里的一段、每轮替换人设的那两节"，
 * 而是**直接写在人设文件里**。于是"这份人设到底有没有说话方式"变成了
 * 一个**只有人设文本能回答**的问题 —— 使用者完全可以把文件换成自己写的散文。
 *
 * 认的节名（顺序即优先级）：
 *   ① `【说话方式…】` —— 0.3.0alpha 出厂那份用的标题（后缀那串括注允许变）；
 *   ② `【怎么说话】` 与它的别名 —— 0.3.0beta 之前的写法（`怎么说话` / `说话方式` /
 *      `语气` …，见 `canonicalStyleSection`）；
 *   ③ 编号式 `二、怎么说话` 也认（`splitPersonaSections` 已经处理了序号）。
 *
 * ⚠️ 它**只用于日志与自检**，不参与提示词拼装 —— 提示词用的始终是**整份人设**。
 *   所以"找不到"不是一个错误，只是"这份人设没有可识别的口吻节"这一事实。
 *
 * @param {string} text 人设正文
 * @returns {{voice: {title: string, body: string}|null, sections: Array<{title: string, header: string, body: string}>}}
 */
export function personaVoiceSections(text) {
  const { sections } = splitPersonaSections(text)
  // ① 先找 0.3.0alpha 的标题（`说话方式…`；出厂那份带一长串括注）
  let voice = sections.find((s) => /^说话方式/.test(String(s.title ?? '').trim())) ?? null
  // ② 再找旧的规范名（含别名：`怎么说话` / `说话方式` / `语气` …）
  if (!voice) {
    voice = sections.find((s) => STYLE_SECTIONS.includes(canonicalStyleSection(s.title))) ?? null
  }
  return { voice, sections }
}

/** 渲染回人设文本（与 `splitPersonaSections` 严格互逆，末尾保留换行）。 */
export function renderPersonaSections({ pre = '', sections = [] } = {}) {
  const out = []
  const head = String(pre).replace(/\s+$/, '')
  if (head) out.push(head)
  for (const s of sections) {
    const body = String(s?.body ?? '').replace(/^\n+/, '').replace(/\s+$/, '')
    // ★ 优先用**原始标题行**（编号式人设的 `二、怎么说话` 要原样回去）；
    //   手工构造的 `{title, body}` 没有 header ⇒ 退回【标题】。
    out.push(String(s?.header ?? '').trim() || `【${String(s?.title ?? '').trim()}】`)
    if (body) out.push(body)
  }
  return `${out.join('\n')}\n`
}
