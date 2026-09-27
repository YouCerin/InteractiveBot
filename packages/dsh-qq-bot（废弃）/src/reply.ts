/**
 * Reply service: one-shot LLM reply over the harness `llm` service.
 *
 * Captures visible text, reasoning (thinking), and TokenUsage from the stream,
 * persists the bot message, sends it over OneBot, and records usage.
 * Topic helpers power the experimental topic-mode wake.
 */
import type { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createUserMessage, type TokenUsage } from '@deepseek-ai/dsh-llm'
import type { OneBot11Client } from './onebot.js'
import type { MemoryService } from './memory.js'
import type { Store } from './store.js'

export interface ReplyOptions {
  persona: string
  modelProvider: string
  model: string
}

interface Generated {
  text: string
  thinking: string
  usage: TokenUsage | null
}

/** Outcome of one reply attempt, so callers can report *why* nothing was sent. */
export interface ReplyOutcome {
  /** Visible reply text; empty when the model produced no visible content. */
  text: string
  /** Whether the text actually reached QQ. */
  sent: boolean
  /** Why delivery failed, when `sent` is false and a reply was generated. */
  error?: string
}

/** Render a terminal `finish` reason (adapter failure) into a diagnostic string. */
function describeReason(reason: unknown): string {
  if (typeof reason !== 'object' || reason === null) return String(reason)
  const r = reason as { kind?: string; failure?: { code?: string; message?: string } }
  const code = r.failure?.code ?? r.kind ?? 'UNKNOWN'
  const message = r.failure?.message ?? ''
  return message ? `[${code}] ${message}` : `[${code}]`
}

export class ReplyService {
  constructor(
    private readonly ctx: Context,
    private readonly store: Store,
    private readonly client: OneBot11Client,
    private readonly options: ReplyOptions,
    private readonly memory?: MemoryService,
  ) {}

  /** Generate one reply for a conversation and send it. */
  async replyOnce(convId: string, senderUserId?: number): Promise<ReplyOutcome> {
    let system = this.options.persona
    const memoryText = this.memory?.injectFor(convId, senderUserId)
    if (memoryText) system += `\n\n[关于当前对话的记忆]\n${memoryText}`
    const { text, thinking, usage } = await this.generate(convId, system)
    if (!text.trim()) return { text: '', sent: false }

    let messageId: number | null = null
    let sent = false
    let sendError: string | undefined
    try {
      if (convId.startsWith('g:')) {
        messageId = (await this.client.sendGroupMessage(Number(convId.slice(2)), text)).message_id
      } else if (convId.startsWith('u:')) {
        messageId = (await this.client.sendPrivateMessage(Number(convId.slice(2)), text)).message_id
      }
      sent = true
    } catch (error) {
      // Keep the generated reply even when sending failed, so it is not lost.
      sendError = error instanceof Error ? error.message : String(error)
      console.error('[qq-bot] send failed:', sendError)
    }

    this.store.addMessage({
      conv_id: convId,
      role: 'bot',
      user_id: null,
      content: text,
      thinking: thinking || null,
      message_id: messageId,
      created_at: Date.now(),
    })

    if (usage) {
      this.store.addUsageEvent({
        ts: Date.now(),
        conv_id: convId,
        model: this.options.model,
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        cache_hit: usage.cacheReadTokens ?? 0,
        cost: null,
        raw: JSON.stringify(usage),
      })
    }

    return { text, sent, error: sendError }
  }

  /** One-line topic summary of a conversation (topic-mode wake capture). */
  async summarizeTopic(convId: string): Promise<string> {
    const { text } = await this.generate(convId, '用一句话概括这段对话正在讨论的话题，只输出话题本身，不要解释。')
    return text.trim()
  }

  /** Whether `incoming` continues the given topic (topic-mode wake judgment). */
  async judgeSameTopic(topic: string, incoming: string): Promise<boolean> {
    const stream = this.ctx.llm.stream({
      provider: this.options.modelProvider,
      model: this.options.model,
      system: `你判断一条新消息是否仍在讨论给定话题。只回答"是"或"否"，不要解释。\n话题：${topic}`,
      messages: [createUserMessage({ content: [{ type: 'text', text: incoming }], source: { kind: 'user' } })],
    })
    let answer = ''
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') answer += chunk.text
    }
    const a = answer.trim()
    if (/否|不是|不同|没有|无法|no|not/i.test(a)) return false
    return /是|同|继续|对|yes|same/i.test(a)
  }

  private async generate(convId: string, system: string): Promise<Generated> {
    const history = this.store.listMessages(convId, 50).map((m) =>
      m.role === 'user'
        ? createUserMessage({ content: [{ type: 'text', text: m.content }], source: { kind: 'user' } })
        : createAssistantMessage({
            content: [{ type: 'text', text: m.content }],
            source: { provider: this.options.modelProvider, model: this.options.model },
          }),
    )

    const stream = this.ctx.llm.stream({
      provider: this.options.modelProvider,
      model: this.options.model,
      system,
      messages: history,
    })

    let text = ''
    let thinking = ''
    let usage: TokenUsage | null = null
    // One-shot replies carry a single text block and a single reasoning block,
    // so arrival-order concatenation is correct; tool-call blocks are ignored
    // by design (this path has no tool loop).
    try {
      for await (const chunk of stream) {
        switch (chunk.type) {
          case 'text-delta': text += chunk.text; break
          case 'reasoning-delta': thinking += chunk.text; break
          case 'usage': usage = chunk.usage; break
          case 'finish':
            if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
              throw new Error(`模型调用失败 ${describeReason(chunk.reason)}`)
            }
            break
          default: break
        }
      }
    } catch (error) {
      throw new Error(
        `模型调用失败（provider=${this.options.modelProvider}, model=${this.options.model}）` +
        `：${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return { text, thinking, usage }
  }
}
