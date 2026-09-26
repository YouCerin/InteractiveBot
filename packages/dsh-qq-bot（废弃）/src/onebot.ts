import WebSocket from 'ws'

/**
 * Minimal OneBot 11 client over a forward WebSocket connection.
 *
 * Responsibilities (and nothing else):
 *  - open the WS with optional `Authorization: Bearer <accessToken>`
 *  - correlate API responses by the `echo` field (request/response pairing)
 *  - dispatch pushed `message` events
 *  - reconnect with capped exponential backoff until `stop()`
 */

export type OneBotStatus = 'connecting' | 'connected' | 'disconnected' | 'error'

export interface OneBotSegment {
  type: string
  data: Record<string, unknown>
}

export interface OneBotTextSegment {
  type: 'text'
  data: { text: string }
}

/** A pushed `message` event (post_type === 'message'). */
export interface OneBotMessageEvent {
  post_type: 'message'
  message_type: 'group' | 'private'
  sub_type?: string
  group_id?: number
  user_id: number
  message_id: number
  self_id: number
  raw_message?: string
  message?: OneBotSegment[]
  sender?: Record<string, unknown>
}

export interface OneBotClientOptions {
  endpoint: string
  accessToken: string
  selfId: string
  onMessage: (event: OneBotMessageEvent) => void
  onStatus: (status: OneBotStatus, detail?: string) => void
}

/** One entry of the account's friend list (`get_friend_list`). */
export interface OneBotFriend {
  user_id: number
  nickname?: string
  remark?: string
}

/** One entry of the account's group list (`get_group_list`). */
export interface OneBotGroup {
  group_id: number
  group_name?: string
  member_count?: number
  max_member_count?: number
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

const REQUEST_TIMEOUT_MS = 30_000
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000

export class OneBot11Client {
  private ws: WebSocket | null = null
  private echoSeq = 0
  private pending = new Map<string, PendingRequest>()
  private stopped = false
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectAttempt = 0
  private connected = false
  private accountId: number | null = null

  constructor(private readonly options: OneBotClientOptions) {}

  get isConnected(): boolean {
    return this.connected
  }

  /** The signed-in QQ account id, learned from `get_login_info` on connect. */
  get loginUserId(): number | null {
    return this.accountId
  }

  start(): void {
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    this.clearReconnect()
    this.rejectAllPending(new Error('qq-bot: client stopped'))
    this.teardownSocket()
  }

  /** Send a OneBot API action and resolve with its `data`. */
  request<T>(action: string, params: unknown): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('qq-bot: not connected'))
    }
    const echo = `qq-bot-${++this.echoSeq}`
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo)
        reject(new Error(`qq-bot: request "${action}" timed out`))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(echo, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      })
      this.ws!.send(JSON.stringify({ action, params, echo }))
    })
  }

  sendGroupMessage(groupId: number, text: string): Promise<{ message_id: number }> {
    return this.request<{ message_id: number }>('send_group_msg', {
      group_id: groupId,
      message: [{ type: 'text', data: { text } }],
    })
  }

  sendPrivateMessage(userId: number, text: string): Promise<{ message_id: number }> {
    return this.request<{ message_id: number }>('send_private_msg', {
      user_id: userId,
      message: [{ type: 'text', data: { text } }],
    })
  }

  /** Account's friend list — source for the private-chat allowlist picker. */
  getFriendList(): Promise<OneBotFriend[]> {
    return this.request<OneBotFriend[]>('get_friend_list', {})
  }

  /** Account's group list — source for the group allowlist picker. */
  getGroupList(): Promise<OneBotGroup[]> {
    return this.request<OneBotGroup[]>('get_group_list', {})
  }

  private connect(): void {
    if (this.stopped) return
    this.options.onStatus('connecting')

    const headers: Record<string, string> = {}
    if (this.options.accessToken) {
      headers.Authorization = `Bearer ${this.options.accessToken}`
    }

    let ws: WebSocket
    try {
      ws = new WebSocket(this.options.endpoint, { headers })
    } catch (error) {
      this.options.onStatus('error', String(error))
      this.scheduleReconnect()
      return
    }
    this.ws = ws

    ws.on('open', () => {
      this.connected = true
      this.reconnectAttempt = 0
      this.options.onStatus('connected')
      void this.resolveIdentity()
    })

    ws.on('message', (data) => {
      this.handleRaw(data.toString())
    })

    ws.on('close', () => {
      this.connected = false
      this.options.onStatus('disconnected')
      this.rejectAllPending(new Error('qq-bot: connection closed'))
      this.scheduleReconnect()
    })

    ws.on('error', (error) => {
      // `close` fires right after `error`; reconnect is driven there.
      this.options.onStatus('error', error.message)
    })
  }

  private async resolveIdentity(): Promise<void> {
    let info: { user_id: number }
    try {
      // Always resolve, so the panel can exclude the bot from the friend list.
      info = await this.request<{ user_id: number }>('get_login_info', {})
      this.accountId = info.user_id
    } catch {
      // `get_login_info` may be unsupported by some implementations; keep the
      // connection and let the operator resolve it.
      return
    }
    if (this.options.selfId && String(info.user_id) !== this.options.selfId) {
      this.options.onStatus(
        'error',
        `self_id mismatch: connected ${info.user_id}, configured ${this.options.selfId}`,
      )
      this.teardownSocket()
      this.scheduleReconnect()
    }
  }

  private handleRaw(raw: string): void {
    let data: unknown
    try {
      data = JSON.parse(raw)
    } catch {
      return
    }
    if (typeof data !== 'object' || data === null) return
    const obj = data as Record<string, unknown>

    if (typeof obj.echo === 'string' && this.pending.has(obj.echo)) {
      this.resolvePending(obj.echo, obj)
      return
    }

    if (obj.post_type === 'message') {
      this.options.onMessage(obj as unknown as OneBotMessageEvent)
    }
  }

  private resolvePending(echo: string, payload: Record<string, unknown>): void {
    const pending = this.pending.get(echo)
    if (!pending) return
    this.pending.delete(echo)
    clearTimeout(pending.timer)

    const status = payload.status
    const retcode = payload.retcode
    if (status === 'failed' || (typeof retcode === 'number' && retcode !== 0)) {
      pending.reject(new Error(`qq-bot: action failed: ${JSON.stringify(payload)}`))
    } else {
      pending.resolve(payload.data)
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    this.clearReconnect()
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempt)
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private teardownSocket(): void {
    const ws = this.ws
    this.ws = null
    this.connected = false
    if (ws) {
      ws.removeAllListeners()
      try {
        ws.close()
      } catch {
        // ignore
      }
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}
