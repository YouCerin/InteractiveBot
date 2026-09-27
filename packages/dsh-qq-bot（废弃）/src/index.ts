/**
 * dsh-qq-bot — configurable QQ chat-bot bridge for DeepSeek Harness.
 *
 * Host-only plugin: OneBot 11 forward WebSocket, SQLite persistence, and
 * trigger-gated auto-reply through the harness `llm` service (with thinking and
 * usage capture). Memory (M4) and the client UI (M5) are still pending.
 */
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { deepMerge, loadConfigJson, saveConfigJson } from './config-store.js'
import { decideGroupMessage, type WakerState } from './awake.js'
import { OneBot11Client, type OneBotMessageEvent } from './onebot.js'
import { MemoryService } from './memory.js'
import { ReplyService } from './reply.js'
import { Store } from './store.js'

export const name = 'qq-bot'

/** Services required before this plugin activates. */
export const inject = ['tools', 'llm']

export interface Config {
  enabled: boolean
  endpoint: string
  accessToken: string
  selfId: string
  /** Legacy prefix trigger; folded into `replyTrigger.keyword` (unused in M3). */
  commandPrefix: string
  dataDir: string
  /** System prompt persona used for every reply. */
  persona: string
  modelProvider: string
  model: string
  allowlistEnabled: boolean
  replyTrigger: {
    keyword: { enabled: boolean; keywords: string[] }
    mention: { enabled: boolean }
    private: { enabled: boolean }
    random: { enabled: boolean; probability: number }
  }
  sustain: {
    enabled: boolean
    /** 连续多少条「未 @、未命中关键词」的消息后结束与该唤醒者的对话。 */
    silentLimit: number
    /** 单个唤醒窗口内最多自动回复次数（安全上限）。 */
    maxReplies: number
  }
  memory: {
    halfLifeDays: number
    boost: number
    forgetThreshold: number
    injectTopK: number
    injectMaxTokens: number
  }
}

export const Config = z.object({
  enabled: z.boolean().default(true),
  endpoint: z.string().default('ws://127.0.0.1:3001'),
  accessToken: z.string().default(''),
  selfId: z.string().default(''),
  commandPrefix: z.string().default('/'),
  dataDir: z.string().default(''),
  persona: z.string().default('你是 QQ 群里的智能助手，回复简洁、友好、自然。'),
  modelProvider: z.string().default('deepseek-official'),
  model: z.string().default('deepseek-flash'),
  allowlistEnabled: z.boolean().default(false),
  replyTrigger: z.object({
    keyword: z.object({
      enabled: z.boolean().default(false),
      keywords: z.array(z.string()).default([]),
    }),
    mention: z.object({ enabled: z.boolean().default(true) }),
    private: z.object({ enabled: z.boolean().default(true) }),
    random: z.object({ enabled: z.boolean().default(false), probability: z.number().default(0) }),
  }),
  sustain: z.object({
    enabled: z.boolean().default(true),
    silentLimit: z.number().default(3),
    maxReplies: z.number().default(20),
  }),
  memory: z.object({
    halfLifeDays: z.number().default(7),
    boost: z.number().default(0.2),
    forgetThreshold: z.number().default(0.1),
    injectTopK: z.number().default(5),
    injectMaxTokens: z.number().default(400),
  }),
})

function convIdOf(event: OneBotMessageEvent): string {
  return event.message_type === 'private' ? `u:${event.user_id}` : `g:${event.group_id}`
}

function textOf(event: OneBotMessageEvent): string {
  return (
    event.raw_message ??
    event.message?.map((seg) => (seg.type === 'text' ? seg.data.text : `[${seg.type}]`)).join('') ??
    ''
  )
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => { data += chunk })
    req.on('end', () => {
      if (!data.trim()) return resolve({})
      try { resolve(JSON.parse(data)) } catch (error) { reject(error) }
    })
    req.on('error', reject)
  })
}

export function apply(ctx: Context, config: Config): void {
  config = deepMerge(config, loadConfigJson<Config>(config.dataDir))
  if (!config.enabled) return

  const store = new Store(config.dataDir)
  let connected = false
  /** Last reply failure, surfaced to the panel so "不回复" is diagnosable. */
  let lastError: string | null = null

  /**
   * Live LLM target. The configured provider/model is validated against the
   * registered adapters before first use, because an unknown id fails the
   * stream instantly with a bare `NO_ADAPTER`. Every option object that carries
   * a provider/model is tracked so a fallback reaches both services.
   */
  const targets: Array<{ modelProvider: string; model: string }> = []
  let targetValidated = false
  let resolvedProvider = config.modelProvider
  let resolvedModel = config.model

  async function ensureTarget(): Promise<void> {
    if (targetValidated) return
    try {
      const providers = ctx.llm.listProviders().map((p) => p.id)
      if (providers.length === 0) return // adapters not registered yet; retry later
      let provider = resolvedProvider
      if (!providers.includes(provider)) {
        provider = providers.includes('deepseek-official') ? 'deepseek-official' : providers[0]!
        console.error(`[qq-bot] provider "${resolvedProvider}" 未注册，回退到 "${provider}"（可用：${providers.join(', ')}）`)
      }
      const models = (await ctx.llm.listModels(provider)).map((m) => m.id)
      let model = resolvedModel
      if (models.length > 0 && !models.includes(model)) {
        model = models.find((m) => m === 'deepseek-flash')
          ?? models.find((m) => m.startsWith('deepseek'))
          ?? models[0]!
        console.error(`[qq-bot] model "${resolvedModel}" 不存在于 ${provider}，回退到 "${model}"（可用：${models.join(', ')}）`)
      }
      resolvedProvider = provider
      resolvedModel = model
      for (const sink of targets) {
        sink.modelProvider = provider
        sink.model = model
      }
      targetValidated = true
    } catch (error) {
      console.error('[qq-bot] 模型解析失败:', error instanceof Error ? error.message : error)
    }
  }

  // ---- activity log (in-memory ring buffer for the panel's diagnostics) ----

  const activity: Array<{ ts: number; conv_id: string; kind: string; detail: string }> = []
  function logActivity(convId: string, kind: string, detail = ''): void {
    activity.push({ ts: Date.now(), conv_id: convId, kind, detail })
    if (activity.length > 300) activity.splice(0, activity.length - 300)
  }

  // ---- conversation allowlist ---------------------------------------------

  let allowlist = new Set(store.listAllowlist().map((entry) => entry.key))

  function isAllowed(convId: string): boolean {
    return !config.allowlistEnabled || allowlist.has(convId)
  }

  const client = new OneBot11Client({
    endpoint: config.endpoint,
    accessToken: config.accessToken,
    selfId: config.selfId,
    onMessage: (event) => {
      handleMessage(event).catch((error) => {
        const detail = error instanceof Error ? error.message : String(error)
        lastError = detail
        logActivity(convIdOf(event), '异常', detail)
        console.error('[qq-bot] handleMessage failed:', detail)
      })
    },
    onStatus: (state, detail) => {
      connected = state === 'connected'
      if (state === 'error' && detail) console.error(`[qq-bot] ${detail}`)
      logActivity('', `连接:${state}`, detail ?? '')
    },
  })

  const memoryOptions = {
    modelProvider: resolvedProvider,
    model: resolvedModel,
    halfLifeDays: config.memory.halfLifeDays,
    boost: config.memory.boost,
    forgetThreshold: config.memory.forgetThreshold,
    injectTopK: config.memory.injectTopK,
    injectMaxTokens: config.memory.injectMaxTokens,
  }
  const replyOptions = {
    persona: config.persona,
    modelProvider: resolvedProvider,
    model: resolvedModel,
  }
  targets.push(memoryOptions, replyOptions)

  const memory = new MemoryService(ctx, store, memoryOptions)
  const replyService = new ReplyService(ctx, store, client, replyOptions, memory)

  // ---- wake windows (groups only) -----------------------------------------

  /** convId → (member QQ → that member's own wake window). */
  const wakers = new Map<string, Map<number, WakerState>>()
  /** A window untouched for this long is stale and dropped on the next message. */
  const WAKER_TTL_MS = 30 * 60 * 1000

  const replying = new Set<string>()
  const pending = new Map<string, number>()

  function isMentioned(event: OneBotMessageEvent): boolean {
    return (
      event.message?.some((seg) => seg.type === 'at' && String(seg.data.qq) === String(event.self_id)) ?? false
    )
  }

  function matchKeyword(text: string): boolean {
    return config.replyTrigger.keyword.keywords.some((k) => k.length > 0 && text.includes(k))
  }

  /** Human-readable reason for an explicit activation. */
  function explicitReason(mentioned: boolean, keyword: boolean): string {
    if (mentioned && keyword) return '@提及 + 关键词'
    return mentioned ? '@提及' : '关键词'
  }

  function dropWaker(convId: string, userId: number): void {
    const map = wakers.get(convId)
    if (!map) return
    map.delete(userId)
    if (map.size === 0) wakers.delete(convId)
  }

  /** Drop windows whose owner has been silent long enough to be considered gone. */
  function pruneWakers(convId: string): void {
    const map = wakers.get(convId)
    if (!map) return
    const now = Date.now()
    for (const [userId, state] of map) {
      if (now - state.lastAt > WAKER_TTL_MS) map.delete(userId)
    }
    if (map.size === 0) wakers.delete(convId)
  }

  function countWakers(): number {
    let total = 0
    for (const map of wakers.values()) total += map.size
    return total
  }

  /** Summarize what the conversation is about, falling back to the raw message. */
  async function captureTopic(convId: string, fallback: string): Promise<string> {
    try {
      return (await replyService.summarizeTopic(convId)) || fallback.slice(0, 80)
    } catch {
      return fallback.slice(0, 80)
    }
  }

  async function reply(convId: string, senderUserId?: number): Promise<void> {
    if (replying.has(convId)) {
      logActivity(convId, '跳过', '上一条回复仍在进行')
      return
    }
    replying.add(convId)
    try {
      await ensureTarget()
      logActivity(convId, '回复中', `${resolvedProvider}/${resolvedModel}`)
      const outcome = await replyService.replyOnce(convId, senderUserId)
      if (!outcome.sent) {
        lastError = outcome.error
          ? `发送失败：${outcome.error}`
          : `模型没有返回可见内容（${resolvedProvider}/${resolvedModel}）`
        logActivity(convId, '失败', lastError)
      } else {
        lastError = null
        logActivity(convId, '已回复', outcome.text.slice(0, 120))
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      logActivity(convId, '失败', lastError)
      console.error('[qq-bot] reply failed:', lastError)
    } finally {
      replying.delete(convId)
    }
  }

  async function handleMessage(event: OneBotMessageEvent): Promise<void> {
    if (event.message_type !== 'group' && event.message_type !== 'private') return
    const convId = convIdOf(event)
    const text = textOf(event)
    logActivity(convId, '收到', text.slice(0, 120))

    store.upsertConversation(convId, event.message_type)
    store.addMessage({
      conv_id: convId,
      role: 'user',
      user_id: event.user_id,
      content: text,
      thinking: null,
      message_id: event.message_id,
      created_at: Date.now(),
    })

    if (!isAllowed(convId)) {
      logActivity(convId, '白名单拦截', '该会话不在白名单内')
      return
    }

    // Batch memory extraction every N messages.
    const pendingCount = (pending.get(convId) ?? 0) + 1
    pending.set(convId, pendingCount)
    if (pendingCount >= 20) {
      pending.set(convId, 0)
      void memory.extract(convId, event.message_type).catch((err) => console.error('[qq-bot] extract failed:', err))
    }

    /** 明确激活：`@` 或关键词。随机命中不算激活，也不会开启唤醒窗口。 */
    const mentioned = isMentioned(event) && config.replyTrigger.mention.enabled
    const keyword = matchKeyword(text) && config.replyTrigger.keyword.enabled
    const explicit = mentioned || keyword

    // 1. 私聊：永远回复（开关打开时），不存在唤醒状态。
    if (event.message_type === 'private') {
      if (!config.replyTrigger.private.enabled) {
        logActivity(convId, '未触发', '私聊回复已关闭')
        return
      }
      logActivity(convId, '触发', '私聊')
      await reply(convId, event.user_id)
      return
    }

    // 2. 群聊：按唤醒者分别判定（规则见 awake.ts）。
    pruneWakers(convId)
    const state = wakers.get(convId)?.get(event.user_id)

    // 仅在「已有窗口且本条不是明确激活」时才需要多花一次 LLM 判话题。
    let sameTopic: boolean | undefined
    if (state && !explicit) {
      sameTopic = false
      try {
        sameTopic = await replyService.judgeSameTopic(state.wakeTopic, text)
      } catch (error) {
        // 判定失败时按「离题」收尾，避免窗口无限拖下去。
        console.error('[qq-bot] judgeSameTopic failed:', error instanceof Error ? error.message : error)
      }
    }

    const decision = decideGroupMessage({
      hasWindow: state !== undefined,
      explicit,
      sameTopic,
      silent: state?.silent,
      replies: state?.replies,
      sustainEnabled: config.sustain.enabled,
      silentLimit: config.sustain.silentLimit,
      maxReplies: config.sustain.maxReplies,
      randomHit: config.replyTrigger.random.enabled
        && Math.random() < config.replyTrigger.random.probability,
    })

    switch (decision.action) {
      case 'none':
        logActivity(convId, '未触发', '未命中 @ / 关键词 / 随机')
        return
      case 'silence':
        dropWaker(convId, event.user_id)
        logActivity(convId, '唤醒结束', decision.reason)
        return
      case 'reactivate': {
        if (!state) return
        state.wakeTopic = await captureTopic(convId, text)
        state.silent = 0
        state.replies = 1
        state.lastAt = Date.now()
        logActivity(convId, '唤醒中·再次激活', `${explicitReason(mentioned, keyword)} · ${decision.note}`)
        await reply(convId, event.user_id)
        return
      }
      case 'reply': {
        if (!state) return
        state.silent = decision.silent
        state.replies = decision.replies
        state.lastAt = Date.now()
        logActivity(convId, '唤醒中', decision.note)
        await reply(convId, event.user_id)
        return
      }
      case 'wake': {
        const wakeTopic = await captureTopic(convId, text)
        let map = wakers.get(convId)
        if (!map) {
          map = new Map<number, WakerState>()
          wakers.set(convId, map)
        }
        map.set(event.user_id, { wakeTopic, silent: 0, replies: 1, lastAt: Date.now() })
        logActivity(convId, '触发·唤醒', `${explicitReason(mentioned, keyword)} · 唤醒者 u${event.user_id}`)
        await reply(convId, event.user_id)
        return
      }
      case 'reply-once':
        logActivity(convId, '触发', decision.note)
        await reply(convId, event.user_id)
        return
    }
  }

  ctx.effect(() => {
    client.start()
    void ensureTarget()
    const decayTimer = setInterval(() => {
      void memory.decay().catch((err) => console.error('[qq-bot] decay failed:', err))
    }, 60 * 60 * 1000)
    return () => {
      clearInterval(decayTimer)
      client.stop()
      store.close()
    }
  })

  // ---- tools ---------------------------------------------------------------

  ctx.tools.register(defineTool({
    name: 'qq_bot_status',
    description:
      'Report the QQ bot bridge status, its configured endpoint, and persisted conversation/message counts.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          enabled: { type: 'boolean', required: true },
          endpoint: { type: 'string', required: true },
          connected: { type: 'boolean', required: true },
          model: { type: 'string', required: true },
          conversations: { type: 'integer', required: true },
          messages: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `qq-bot: enabled=${value.enabled} endpoint=${value.endpoint} connected=${value.connected} model=${value.model} conversations=${value.conversations} messages=${value.messages}`,
      }],
    },
    isConcurrencySafe: () => true,
    async execute() {
      return {
        enabled: config.enabled,
        endpoint: config.endpoint,
        connected,
        model: config.model,
        conversations: store.listConversations().length,
        messages: store.countMessages(),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'qq_bot_send_group_message',
    description:
      'Send a text message to a QQ group through the connected OneBot 11 bridge. ' +
      'Requires a live connection (check qq_bot_status first).',
    parameters: {
      group_id: { type: 'number', required: true, description: 'Target QQ group id.' },
      message: { type: 'string', required: true, description: 'Text content to send.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          message_id: { type: 'integer', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `sent to group ${args.group_id}, message_id=${value.message_id}`,
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const result = await client.sendGroupMessage(args.group_id, args.message)
      store.addMessage({
        conv_id: `g:${args.group_id}`,
        role: 'bot',
        user_id: null,
        content: args.message,
        thinking: null,
        message_id: result.message_id,
        created_at: Date.now(),
      })
      return result
    },
  }))

  ctx.tools.register(defineTool({
    name: 'qq_bot_send_private_message',
    description:
      'Send a text message to a QQ user (private chat) through the connected OneBot 11 bridge. ' +
      'Requires a live connection (check qq_bot_status first).',
    parameters: {
      user_id: { type: 'number', required: true, description: 'Target QQ user id.' },
      message: { type: 'string', required: true, description: 'Text content to send.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          message_id: { type: 'integer', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `sent to user ${args.user_id}, message_id=${value.message_id}`,
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const result = await client.sendPrivateMessage(args.user_id, args.message)
      store.addMessage({
        conv_id: `u:${args.user_id}`,
        role: 'bot',
        user_id: null,
        content: args.message,
        thinking: null,
        message_id: result.message_id,
        created_at: Date.now(),
      })
      return result
    },
  }))

  ctx.tools.register(defineTool({
    name: 'qq_bot_list_conversations',
    description: 'List persisted QQ conversations (groups and private chats), newest activity first.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          conversations: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                kind: { type: 'string', required: true, enum: ['group', 'private'] },
                title: { type: 'string' },
                message_count: { type: 'integer', required: true },
                updated_at: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.conversations.length === 0
          ? 'no conversations'
          : value.conversations
              .map((c) => `${c.id} (${c.kind}, ${c.message_count} msgs)`)
              .join('\n'),
      }],
    },
    isConcurrencySafe: () => true,
    async execute() {
      return { conversations: store.listConversations() }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'qq_bot_get_conversation',
    description:
      'Read the history of one QQ conversation (oldest first). Thinking/reasoning content is included when present.',
    parameters: {
      conv_id: { type: 'string', required: true, description: 'Conversation id: `g:<group_id>` or `u:<user_id>`.' },
      limit: { type: 'number', description: 'Max messages to return (default 200).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          conversation: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              kind: { type: 'string', required: true, enum: ['group', 'private'] },
              title: { type: 'string' },
            },
          },
          messages: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'integer', required: true },
                role: { type: 'string', required: true, enum: ['user', 'bot'] },
                user_id: { type: 'integer' },
                content: { type: 'string', required: true },
                thinking: { type: 'string' },
                created_at: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.messages.length === 0
          ? `no messages in ${value.conversation.id}`
          : value.messages
              .map((m) => `[${m.role}${m.user_id ? ` u${m.user_id}` : ''}] ${m.content}`)
              .join('\n'),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const conversation = store.getConversation(args.conv_id)
      if (!conversation) throw new Error(`qq-bot: conversation ${args.conv_id} not found`)
      const limit = args.limit === undefined ? 200 : Math.max(1, args.limit)
      return {
        conversation: { id: conversation.id, kind: conversation.kind, title: conversation.title },
        messages: store.listMessages(args.conv_id, limit),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'qq_bot_delete_message',
    description: 'Delete one persisted QQ message by its id (from qq_bot_get_conversation or qq_bot_get_recent_messages).',
    parameters: {
      message_id: { type: 'number', required: true, description: 'Persisted message id.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.ok ? 'deleted' : 'not found' }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      store.deleteMessage(args.message_id)
      return { ok: true }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'qq_bot_get_recent_messages',
    description:
      'Read recently received QQ messages across all conversations (oldest first). ' +
      'Use this to catch up on what users sent before replying.',
    parameters: {
      limit: { type: 'number', description: 'Max messages to return (default 50).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          messages: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'integer', required: true },
                conv_id: { type: 'string', required: true },
                role: { type: 'string', required: true, enum: ['user', 'bot'] },
                user_id: { type: 'integer' },
                content: { type: 'string', required: true },
                thinking: { type: 'string' },
                created_at: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.messages.length === 0
          ? 'no recent QQ messages'
          : value.messages
              .map((m) => `[${m.conv_id} ${m.role}] ${m.content}`)
              .join('\n'),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const limit = args.limit === undefined ? 50 : Math.max(1, args.limit)
      return { messages: store.listRecentMessages(limit) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'qq_bot_list_memories',
    description:
      'List persisted memories for a scope. scope_key: `u:<qq>` (群友印象) or `g:<group_id>` (群聊记忆), ordered by strength descending.',
    parameters: {
      scope_key: { type: 'string', required: true, description: '`u:<qq>` or `g:<group_id>`.' },
      limit: { type: 'number', description: 'Max memories (default 50).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          memories: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'integer', required: true },
                scope: { type: 'string', required: true, enum: ['member', 'group'] },
                topic: { type: 'string', required: true },
                summary: { type: 'string', required: true },
                strength: { type: 'number', required: true },
                mention_count: { type: 'integer', required: true },
                last_mentioned_at: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.memories.length === 0
          ? 'no memories'
          : value.memories
              .map((m) => `- ${m.topic} (s=${m.strength.toFixed(2)}, n=${m.mention_count}): ${m.summary}`)
              .join('\n'),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const limit = args.limit === undefined ? 50 : Math.max(1, args.limit)
      const memories = store.listMemories([args.scope_key], limit).map((m) => ({
        id: m.id,
        scope: m.scope,
        topic: m.topic,
        summary: m.summary,
        strength: m.strength,
        mention_count: m.mention_count,
        last_mentioned_at: m.last_mentioned_at,
      }))
      return { memories }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'qq_bot_forget_memory',
    description: 'Forget one memory by id (soft-delete into the archive).',
    parameters: {
      memory_id: { type: 'number', required: true, description: 'Memory id from qq_bot_list_memories.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.ok ? 'forgotten' : 'not found' }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      store.archiveMemory(args.memory_id, 'manual')
      return { ok: true }
    },
  }))

  // ---- HTTP routes (for the M5 UI panel; registered when webServer is mounted) ----

  ctx.inject(['webServer'], (webCtx) => {
    const web = webCtx.get('webServer')
    if (!web) return

    webCtx.effect(() => web.register({
      kind: 'exact',
      path: '/plugins/qq-bot/logo.png',
      handler: (req: IncomingMessage, res: ServerResponse) => {
        try {
          const data = readFileSync(fileURLToPath(new URL('../assets/logo.png', import.meta.url)))
          res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' })
          res.end(data)
        } catch {
          res.writeHead(404)
          res.end()
        }
      },
    }), 'qq-bot: logo')

    webCtx.effect(() => web.register({
      kind: 'exact',
      path: '/plugins/qq-bot/config',
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method === 'GET') {
          return json(res, 200, config)
        }
        if (req.method === 'POST') {
          try {
            const body = await readJsonBody(req)
            const previous = config
            const validated = Config(deepMerge(config, body))
            saveConfigJson(config.dataDir, validated)
            // Apply to the running instance. The services read their option
            // objects on every call, so mutating them takes effect immediately
            // for triggers, allowlist, persona, and memory parameters.
            config = validated
            replyOptions.persona = validated.persona
            memoryOptions.halfLifeDays = validated.memory.halfLifeDays
            memoryOptions.boost = validated.memory.boost
            memoryOptions.forgetThreshold = validated.memory.forgetThreshold
            memoryOptions.injectTopK = validated.memory.injectTopK
            memoryOptions.injectMaxTokens = validated.memory.injectMaxTokens
            const restartRequired = (['endpoint', 'accessToken', 'selfId', 'dataDir'] as const)
              .filter((field) => previous[field] !== validated[field])
            return json(res, 200, { ok: true, config: validated, restartRequired })
          } catch (error) {
            return json(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
        }
        json(res, 405, { error: 'method not allowed' })
      },
    }), 'qq-bot: config')

    webCtx.effect(() => web.register({
      kind: 'exact',
      path: '/plugins/qq-bot/status',
      handler: (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
        json(res, 200, {
          enabled: config.enabled,
          endpoint: config.endpoint,
          connected,
          model: config.model,
          modelProvider: config.modelProvider,
          resolvedProvider,
          resolvedModel,
          lastError,
          allowlistEnabled: config.allowlistEnabled,
          allowlistSize: allowlist.size,
          wakers: countWakers(),
          conversations: store.listConversations().length,
          messages: store.countMessages(),
        })
      },
    }), 'qq-bot: status')

    webCtx.effect(() => web.register({
      kind: 'exact',
      path: '/plugins/qq-bot/activity',
      handler: (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
        json(res, 200, { activity: [...activity].reverse().slice(0, 100) })
      },
    }), 'qq-bot: activity')

    webCtx.effect(() => web.register({
      kind: 'exact',
      path: '/plugins/qq-bot/friends',
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
        try {
          const friends = await client.getFriendList()
          const selfId = client.loginUserId
          json(res, 200, {
            selfId,
            friends: (friends ?? [])
              .filter((f) => selfId === null || f.user_id !== selfId)
              .map((f) => ({
                user_id: f.user_id,
                name: f.remark && f.remark.trim() ? `${f.remark}（${f.nickname ?? ''}）` : (f.nickname ?? String(f.user_id)),
              })),
          })
        } catch (error) {
          json(res, 502, { error: error instanceof Error ? error.message : String(error), friends: [] })
        }
      },
    }), 'qq-bot: friends')

    webCtx.effect(() => web.register({
      kind: 'exact',
      path: '/plugins/qq-bot/groups',
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
        try {
          const groups = await client.getGroupList()
          json(res, 200, {
            groups: (groups ?? []).map((g) => ({
              group_id: g.group_id,
              name: g.group_name ?? String(g.group_id),
              member_count: g.member_count ?? null,
            })),
          })
        } catch (error) {
          json(res, 502, { error: error instanceof Error ? error.message : String(error), groups: [] })
        }
      },
    }), 'qq-bot: groups')

    webCtx.effect(() => web.register({
      kind: 'exact',
      path: '/plugins/qq-bot/allowlist',
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method === 'GET') {
          return json(res, 200, {
            enabled: config.allowlistEnabled,
            keys: [...allowlist],
            entries: store.listAllowlist(),
          })
        }
        if (req.method === 'POST') {
          try {
            const body = (await readJsonBody(req)) as { keys?: unknown; entries?: unknown; enabled?: unknown }
            const raw = Array.isArray(body.keys) ? body.keys : (Array.isArray(body.entries) ? body.entries : [])
            const entries = raw.flatMap((item): Array<{ key: string; kind: 'group' | 'private' }> => {
              if (typeof item === 'string') {
                if (!item) return []
                return [{ key: item, kind: item.startsWith('g:') ? 'group' : 'private' }]
              }
              if (typeof item === 'object' && item !== null) {
                const entry = item as { key?: unknown; kind?: unknown }
                if (typeof entry.key !== 'string' || !entry.key) return []
                const kind = entry.kind === 'group' || entry.kind === 'private'
                  ? entry.kind
                  : (entry.key.startsWith('g:') ? 'group' : 'private')
                return [{ key: entry.key, kind }]
              }
              return []
            })
            store.replaceAllowlist(entries)
            allowlist = new Set(entries.map((entry) => entry.key))
            if (typeof body.enabled === 'boolean') {
              config = Config({ ...config, allowlistEnabled: body.enabled })
              saveConfigJson(config.dataDir, config)
            }
            return json(res, 200, {
              ok: true,
              enabled: config.allowlistEnabled,
              keys: [...allowlist],
              entries: store.listAllowlist(),
            })
          } catch (error) {
            return json(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
        }
        json(res, 405, { error: 'method not allowed' })
      },
    }), 'qq-bot: allowlist')

    webCtx.effect(() => web.register({
      kind: 'exact',
      path: '/plugins/qq-bot/memories',
      handler: (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
        json(res, 200, { memories: store.listAllMemories() })
      },
    }), 'qq-bot: memories')

    webCtx.effect(() => web.register({
      kind: 'exact',
      path: '/plugins/qq-bot/usage',
      handler: (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
        json(res, 200, { events: store.listUsageEvents() })
      },
    }), 'qq-bot: usage')

    webCtx.effect(() => web.register({
      kind: 'exact',
      path: '/plugins/qq-bot/conversations',
      handler: (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
        json(res, 200, { conversations: store.listConversations() })
      },
    }), 'qq-bot: list conversations')

    webCtx.effect(() => web.register({
      kind: 'prefix',
      path: '/plugins/qq-bot/conversations/',
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        const pathname = new URL(req.url ?? '/', 'http://x').pathname
        const rest = pathname.slice('/plugins/qq-bot/conversations/'.length)
        const slash = rest.indexOf('/')
        const id = decodeURIComponent(slash === -1 ? rest : rest.slice(0, slash))
        const sub = slash === -1 ? '' : rest.slice(slash + 1)
        if (!id) return json(res, 404, { error: 'not found' })

        if (sub === 'reply') {
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          await reply(id)
          return json(res, 200, { ok: true })
        }
        if (req.method === 'GET') {
          const conversation = store.getConversation(id)
          if (!conversation) return json(res, 404, { error: 'not found' })
          return json(res, 200, { conversation, messages: store.listMessages(id) })
        }
        if (req.method === 'DELETE') {
          store.clearConversation(id)
          return json(res, 200, { ok: true })
        }
        json(res, 405, { error: 'method not allowed' })
      },
    }), 'qq-bot: conversation detail/reply/clear')
  })
}
