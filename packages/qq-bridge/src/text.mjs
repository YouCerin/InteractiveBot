/**
 * 文本与消息段工具。
 *
 * ── 一个必须先讲的背景：CQ 码 vs 消息段数组 ────────────────────────────
 * OneBot 协议收消息有两种格式：
 *   ① CQ 码字符串： "[CQ:at,qq=123] 你好"      ← 老格式，字符串拼接
 *   ② 消息段数组：  [{type:'at',data:{qq:'123'}}, {type:'text',data:{text:' 你好'}}]
 *
 * 它们的**安全性差别很大**：CQ 码是纯文本，如果用户发的消息里含有
 * "[CQ:at,qq=..." 这样的字面文本，程序可能把它**当成真的 @**。
 * 数组格式没有这个问题——结构和数据是分开的。
 *
 * 我们的 SnowLuma 配置里 messageFormat 已经是 "array"，所以主路径走数组。
 * 但历史消息、转发节点等地方仍可能出现 CQ 字符串，所以要能解析，
 * 并且**解析时绝不能把用户正文里的方括号当成控制码**。
 */

/** 从多种可能的字段里取出消息段数组。 */
export function asSegments(value) {
  if (Array.isArray(value)) return value
  return null
}

/**
 * 把消息段数组渲染成可读文本。
 *
 * 设计取舍：我们**不做**复杂的表情/图片描述，只做最小必要的标注。
 * 原因：这些文本最终会进提示词，多余的标注只会让模型分心。
 *
 * @param {Array} segments
 * @param {{ selfId?: string|number|null }} [opts]
 * @returns {{ text: string, mentioned: boolean, ats: Array<{qq:string,name:string}>,
 *             images: number,
 *             imageRefs: Array<{url:string,file:string,fileId:string,summary:string}>,
 *             replyTo: string|null }}
 */
export function renderSegments(segments, { selfId = null } = {}) {
  const parts = []
  let mentioned = false
  let images = 0
  /** ★ 图片段的可下载线索。渲染成文本时它会被丢掉，所以要**单独带出来**。 */
  const imageRefs = []
  /**
   * ★ **@ 了谁**（0.2.3）。
   *
   * 为什么单独带出来：`text` 里它只剩一个 `@名字` 的字符串，
   * 而"@ 的是谁"是唤醒判定器**唯一**能据以判断"这话是不是说给我听的"的线索 ——
   * 实测过一次误判：一条 `@张三 小鲸鱼刚说的那个方案我看行` 被判成
   * "明确@了机器人"（判定器只看见文本里有个 `@`，不知道 @ 的是别人，也不知道
   * 机器人自己的 QQ 号）。所以这里把它结构化地带出来。
   * `all`（@全体成员）也收进来，让调用方自己决定怎么表述。
   */
  const ats = []
  let replyTo = null

  for (const seg of segments ?? []) {
    if (!seg || typeof seg !== 'object') continue
    const type = String(seg.type ?? '')
    const data = seg.data ?? {}

    switch (type) {
      case 'text':
        parts.push(String(data.text ?? ''))
        break
      case 'at': {
        const qq = String(data.qq ?? '')
        if (qq === 'all') {
          parts.push('@全体成员')
          ats.push({ qq: 'all', name: '全体成员' })
        } else {
          if (selfId != null && String(selfId) === qq) mentioned = true
          const name = data.name ? String(data.name) : ''
          parts.push(`@${name || qq}`)
          ats.push({ qq, name })
        }
        break
      }
      case 'reply':
        replyTo = data.id != null ? String(data.id) : null
        parts.push('[引用]')
        break
      case 'image':
        images += 1
        // ★ 这里**必须**把 url/file 带出去。
        //
        // 曾经这里只 `parts.push('[图片]')`，等于把图片地址原地丢弃 ——
        // 后果不是"少了个功能"，而是**整条看图链路断在这里**：
        // 模型明明支持图片输入（deepseek-flash 的 inputModalities 含 image）、
        // SDK 也收图片块，但桥接根本没有地址可下载。
        // 详见 src/images.mjs 顶部那段取证。
        imageRefs.push({
          url: typeof data.url === 'string' ? data.url : '',
          file: typeof data.file === 'string' ? data.file : '',
          fileId: typeof data.file_id === 'string' ? data.file_id : '',
          summary: typeof data.summary === 'string' ? data.summary : '',
        })
        parts.push('[图片]')
        break
      case 'record':
      case 'voice':
        // OneBot 标准段名是 record，部分实现用 voice。两个都当语音处理，
        // 否则会出现「有的客户端显示 [语音]、有的显示 [voice]」这种不一致。
        parts.push('[语音]')
        break
      case 'video':
        parts.push('[视频]')
        break
      case 'file':
        parts.push(`[文件:${String(data.name ?? '')}]`)
        break
      case 'face':
        parts.push('[表情]')
        break
      case 'json':
        parts.push('[卡片]')
        break
      case 'forward':
        parts.push('[合并转发]')
        break
      case 'poke':
        parts.push('[拍一拍]')
        break
      default:
        // 未知段类型**不丢弃**，但也不展开内容 —— 展开发送方控制的字符串
        // 等于把任意文本放进提示词，是提示注入的入口。
        parts.push(`[${type || '未知段'}]`)
        break
    }
  }

  return {
    text: parts.join('').trim(),
    mentioned,
    ats,
    images,
    imageRefs,
    replyTo,
  }
}

/**
 * 判断 CQ 字符串里是否 @ 了自己。
 * 只用于**兜底路径**（数组解析不到时的兼容），不作为主判据。
 */
export function cqMentionsSelf(raw, selfId) {
  if (selfId == null) return false
  const pattern = new RegExp(`\\[CQ:at,[^\\]]*qq=${String(selfId)}(?:[,\\]]|$)`,'i')
  return pattern.test(String(raw ?? ''))
}

/**
 * 把 Markdown 降级成 QQ 能看的纯文本。
 *
 * QQ 不渲染 Markdown。如果不处理，群里会看到一堆 `**粗体**`、`### 标题`、
 * `| 表格 |`。这个函数做最小必要的清理，**不做语义转换**（不把列表改写成
 * 中文标点），因为过度处理会把代码块弄坏。
 */
export function markdownToPlain(text) {
  let out = String(text ?? '')

  // 围栏代码块：去掉围栏本身，保留内容
  out = out.replace(/^```[^\n]*\n?/gm, '').replace(/^```\s*$/gm, '')
  // 标题井号
  out = out.replace(/^#{1,6}\s+/gm, '')
  // 粗体 / 斜体 / 删除线（成对的标记）
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1')
  out = out.replace(/__([^_]+)__/g, '$1')
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
  out = out.replace(/~~([^~]+)~~/g, '$1')
  // 行内代码（保留内容，去掉反引号）
  out = out.replace(/`([^`]+)`/g, '$1')
  // 表格分隔行
  out = out.replace(/^\s*\|?[\s:|-]{3,}\|?\s*$/gm, '')
  // 表格的竖线 → 空格（简单降级）
  out = out.replace(/^\s*\|(.+)\|\s*$/gm, (_m, inner) => inner.split('|').map((s) => s.trim()).join('  '))
  // 链接 [文字](地址) → 文字（QQ 里贴地址反而更好复制，但保留可读性优先）
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 $2')
  // 引用符号
  out = out.replace(/^>\s?/gm, '')
  // 压缩过多空行
  out = out.replace(/\n{3,}/g, '\n\n')

  return out.trim()
}

/**
 * 按长度切分长文本。
 *
 * 优先在**自然边界**切：段落 → 换行 → 句末标点 → 空格。
 * 都不行才硬切（否则遇到一整段没有标点的长文本会卡住）。
 */
export function splitForQQ(text, limit = 1200) {
  const source = String(text ?? '')
  if (source.length <= limit) return source ? [source] : []

  const chunks = []
  let rest = source

  while (rest.length > limit) {
    const window = rest.slice(0, limit)
    let cut = -1

    for (const boundary of ['\n\n', '\n', '。', '！', '？', '. ', '! ', '? ', '；', ';', '，', ',', ' ']) {
      const idx = window.lastIndexOf(boundary)
      // 至少用掉一半窗口，避免切出太碎的片段
      if (idx > limit * 0.5) {
        cut = idx + boundary.length
        break
      }
    }
    if (cut <= 0) cut = limit

    chunks.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut)
  }

  if (rest.trim()) chunks.push(rest.trim())
  return chunks.filter(Boolean)
}
