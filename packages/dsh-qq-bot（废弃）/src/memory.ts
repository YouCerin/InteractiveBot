/**
 * Memory service: strength-based summary memory with time decay.
 *
 *   decay:    s ← s · exp(-Δt / halfLife)
 *   reinforce: s ← min(1, s · exp(-Δt / halfLife) + boost)
 *   forget:   s < forgetThreshold → soft-delete (archive)
 *
 * Batch extraction reuses the reply model via the harness `llm` service.
 * Group conversations feed `scope='group'` (what the group discusses); private
 * conversations feed `scope='member'` (the user's impression).
 */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Store } from './store.js'

export interface MemoryOptions {
  modelProvider: string
  model: string
  halfLifeDays: number
  boost: number
  forgetThreshold: number
  injectTopK: number
  injectMaxTokens: number
}

const INITIAL_STRENGTH = 0.3
const MAX_SUMMARY_CHARS = 200

export class MemoryService {
  constructor(
    private readonly ctx: Context,
    private readonly store: Store,
    private readonly options: MemoryOptions,
  ) {}

  /** Batch-extract memories from the conversation's recent messages. */
  async extract(convId: string, kind: 'group' | 'private'): Promise<void> {
    const scope = kind === 'group' ? 'group' : 'member'
    const messages = this.store.listMessages(convId, 20)
    const transcript = messages
      .map((m) => `${m.role === 'user' ? (m.user_id ? `u${m.user_id}` : 'user') : 'bot'}: ${m.content}`)
      .join('\n')
    if (!transcript.trim()) return

    const system = scope === 'group'
      ? '从下面的群聊记录中提取这个群长期讨论的话题。输出 JSON 数组，每项 {"topic":"简短主题标签","summary":"一句话描述"}。只提取反复出现或有价值的话题，忽略闲聊。只输出 JSON。'
      : '从下面的聊天记录中提取这个用户的偏好、性格、事实等信息形成印象。输出 JSON 数组，每项 {"topic":"简短标签","summary":"一句话描述"}。只提取有价值的信息，忽略闲聊。只输出 JSON。'

    const text = await this.llmText(system, transcript)
    for (const item of this.parseItems(text)) {
      this.absorb(scope, convId, item.topic, item.summary)
    }

    if (scope === 'group') this.refreshGroupProfile(Number(convId.slice(2)))
  }

  /** Apply decay to every memory and soft-delete the weak ones. */
  async decay(): Promise<void> {
    const halfLifeMs = this.options.halfLifeDays * 24 * 60 * 60 * 1000
    const now = Date.now()
    for (const mem of this.store.allMemoriesForDecay()) {
      const strength = mem.strength * Math.exp(-(now - mem.last_mentioned_at) / halfLifeMs)
      if (strength < this.options.forgetThreshold) {
        this.store.archiveMemory(mem.id, 'decayed')
      } else {
        this.store.setMemoryStrength(mem.id, strength)
      }
    }
  }

  /** Build a memory block for injection into the reply system prompt. */
  injectFor(convId: string, senderUserId?: number): string {
    const keys = [convId]
    if (senderUserId !== undefined && convId.startsWith('g:')) keys.push(`u:${senderUserId}`)
    const memories = this.store.listMemories(keys, this.options.injectTopK)

    const budgetChars = this.options.injectMaxTokens * 4
    const parts: string[] = []
    let used = 0

    if (convId.startsWith('g:')) {
      const profile = this.store.getGroupProfile(Number(convId.slice(2)))
      if (profile) {
        parts.push(`群常聊：${profile}`)
        used += profile.length
      }
    }

    for (const m of memories) {
      const summary = m.summary.length > MAX_SUMMARY_CHARS
        ? `${m.summary.slice(0, MAX_SUMMARY_CHARS)}…`
        : m.summary
      const line = `- ${m.topic}：${summary}`
      if (used + line.length > budgetChars) break
      parts.push(line)
      used += line.length
    }
    return parts.join('\n')
  }

  private absorb(scope: 'member' | 'group', scopeKey: string, topic: string, summary: string): void {
    const now = Date.now()
    const halfLifeMs = this.options.halfLifeDays * 24 * 60 * 60 * 1000
    const existing = this.store.findMemoryByTopic(scopeKey, topic)
    if (existing) {
      const strength = Math.min(1, existing.strength * Math.exp(-(now - existing.last_mentioned_at) / halfLifeMs) + this.options.boost)
      this.store.reinforceMemory(existing.id, strength, existing.mention_count + 1, now)
    } else {
      this.store.addMemory({
        scope,
        scope_key: scopeKey,
        topic,
        summary,
        strength: INITIAL_STRENGTH,
        mention_count: 1,
        first_seen_at: now,
        last_mentioned_at: now,
        updated_at: now,
      })
    }
  }

  private refreshGroupProfile(groupId: number): void {
    const memories = this.store.listMemories([`g:${groupId}`], 10)
    const topics = memories.map((m) => m.topic).join('、')
    if (topics) this.store.upsertGroupProfile(groupId, topics)
  }

  private parseItems(text: string): Array<{ topic: string; summary: string }> {
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
    try {
      const json: unknown = JSON.parse(cleaned)
      if (!Array.isArray(json)) return []
      return json
        .filter((x): x is { topic: unknown; summary: unknown } =>
          typeof x === 'object' && x !== null && typeof (x as { topic?: unknown }).topic === 'string' && typeof (x as { summary?: unknown }).summary === 'string')
        .map((x) => ({ topic: (x.topic as string).trim(), summary: (x.summary as string).trim() }))
        .filter((x) => x.topic.length > 0 && x.summary.length > 0)
    } catch {
      return []
    }
  }

  private async llmText(system: string, user: string): Promise<string> {
    const stream = this.ctx.llm.stream({
      provider: this.options.modelProvider,
      model: this.options.model,
      system,
      messages: [createUserMessage({ content: [{ type: 'text', text: user }], source: { kind: 'user' } })],
    })
    let text = ''
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') text += chunk.text
    }
    return text
  }
}
