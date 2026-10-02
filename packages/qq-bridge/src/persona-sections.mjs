/**
 * **人设分节与节名归一**（纯函数，不碰文件系统、不碰网络）。
 *
 * 从 `src/chat-mode.mjs`（0.3.0beta）里拆出来的：那个模块同时装着
 * "说话方式长什么样"和"怎么把一篇人设切开"，而 0.3.0alpha 把前者搬进了
 * `src/voice.mjs`、把双态判定整条删掉 —— 只剩这一组**纯文本处理**留在这里。
 * 拆开的理由很实际：这组函数与"用哪份口吻"无关，任何按节替换人设的用法都要它。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么必须"替换"而不是"追加"（这段判断是实测逼出来的，别退回追加）
 * ══════════════════════════════════════════════════════════════════════════
 * 说话方式里有一部分与基座人设的【怎么说话】【别变成客服】**直接冲突**：
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
