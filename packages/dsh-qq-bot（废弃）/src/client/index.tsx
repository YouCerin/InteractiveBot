/**
 * dsh-qq-bot client half: a sidebar panel entry (`sidebar.panellist` icon) that
 * opens a main-column panel (`main`, key `qq-bot`) with four tabs — conversations
 * (terminal), memory, usage, and an editable settings form that persists config
 * through the host `/config` route.
 */
import React, { useEffect, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

export const inject = ['slots', 'layout']

export function apply(ctx: Context): void {
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
    { name: 'sidebar.panellist', id: 'qq-bot', order: 100, label: 'QQ Bot' },
    QqBotIcon,
  ))
  ctx.slots.inject('main', () => ctx.slots.register(
    { name: 'main', key: 'qq-bot' },
    () => <QqBotModal onClose={() => ctx.layout.selectPanel(null)} />,
  ))
}

const BASE = '/plugins/qq-bot'

interface Conv { id: string; kind: string; title?: string; message_count: number; updated_at: number }
interface Msg { id: number; role: string; user_id?: number; content: string; thinking?: string; created_at: number }
interface Mem { id: number; scope: string; topic: string; summary: string; strength: number; mention_count: number; last_mentioned_at: number }
interface UsageEv { id: number; ts: number; conv_id?: string; model: string; input_tokens?: number; output_tokens?: number; cache_hit?: number; cost?: number }

interface Status {
  enabled: boolean
  endpoint: string
  connected: boolean
  model: string
  modelProvider?: string
  resolvedProvider?: string
  resolvedModel?: string
  lastError?: string | null
  allowlistEnabled?: boolean
  allowlistSize?: number
  wakers?: number
  conversations: number
  messages: number
}

interface Friend { user_id: number; name: string }
interface GroupItem { group_id: number; name: string; member_count?: number | null }
interface AllowEntry { key: string; kind: string; note?: string }
interface AllowData { enabled: boolean; keys: string[]; entries: AllowEntry[] }
interface ActivityEntry { ts: number; conv_id: string; kind: string; detail: string }

interface Cfg {
  enabled: boolean
  endpoint: string
  accessToken: string
  selfId: string
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
  sustain: { enabled: boolean; silentLimit: number; maxReplies: number }
  memory: { halfLifeDays: number; boost: number; forgetThreshold: number; injectTopK: number; injectMaxTokens: number }
}

function usePoll<T>(url: string, initial: T, intervalMs = 5000): [T, () => void] {
  const [data, setData] = useState<T>(initial)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let alive = true
    const load = () => {
      fetch(url, { cache: 'no-store' })
        .then((r) => r.json())
        .then((v) => { if (alive) setData(v) })
        .catch(() => {})
    }
    load()
    const timer = setInterval(load, intervalMs)
    return () => { alive = false; clearInterval(timer) }
  }, [url, intervalMs, nonce])
  return [data, () => setNonce((n) => n + 1)]
}

async function post(path: string, body?: unknown): Promise<unknown> {
  const r = await fetch(BASE + path, {
    method: 'POST', cache: 'no-store',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  return r.json()
}

async function del(path: string): Promise<void> {
  await fetch(BASE + path, { method: 'DELETE', cache: 'no-store' })
}

type Tab = 'conversations' | 'memory' | 'usage' | 'whitelist' | 'diagnostics' | 'settings'

function QqBotIcon(props: { size: number; active: boolean }) {
  return (
    <img
      src={`${BASE}/logo.png`}
      alt="QQ Bot"
      width={props.size}
      height={props.size}
      style={{ display: 'block', borderRadius: 6, objectFit: 'contain', opacity: props.active ? 1 : 0.7 }}
    />
  )
}

function QqBotModal(props: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('conversations')
  const [status] = usePoll<Status>(
    `${BASE}/status`,
    { enabled: false, endpoint: '', connected: false, model: '', conversations: 0, messages: 0 },
    5000,
  )
  return (
    <div style={overlay} onClick={props.onClose}>
      <div style={card} onClick={(e) => e.stopPropagation()}>
        <div style={cardHeader}>
          <img src={`${BASE}/logo.png`} width={20} height={20} style={{ borderRadius: 4 }} alt="QQ Bot" />
          <span style={{ fontWeight: 600 }}>QQ Bot</span>
          <span style={connBadge(status.connected)}>
            <span style={connDot(status.connected)} />
            {status.connected ? '已连接' : '未连接'}
          </span>
          <button style={closeBtn} onClick={props.onClose}>×</button>
        </div>
        {status.lastError && (
          <div style={errorBanner}>
            <strong>上次回复失败：</strong>{status.lastError}
            <span style={{ opacity: 0.7 }}>　（模型 {status.resolvedProvider}/{status.resolvedModel}）</span>
          </div>
        )}
        <div style={tabBar}>
          <TabBtn active={tab === 'conversations'} onClick={() => setTab('conversations')}>会话</TabBtn>
          <TabBtn active={tab === 'memory'} onClick={() => setTab('memory')}>记忆</TabBtn>
          <TabBtn active={tab === 'usage'} onClick={() => setTab('usage')}>用量</TabBtn>
          <TabBtn active={tab === 'whitelist'} onClick={() => setTab('whitelist')}>白名单</TabBtn>
          <TabBtn active={tab === 'diagnostics'} onClick={() => setTab('diagnostics')}>诊断</TabBtn>
          <TabBtn active={tab === 'settings'} onClick={() => setTab('settings')}>设置</TabBtn>
        </div>
        <div style={body}>
          {tab === 'conversations' && <ConversationsTab />}
          {tab === 'memory' && <MemoryTab />}
          {tab === 'usage' && <UsageTab />}
          {tab === 'whitelist' && <WhitelistTab />}
          {tab === 'diagnostics' && <DiagnosticsTab />}
          {tab === 'settings' && <SettingsTab />}
        </div>
      </div>
    </div>
  )
}

function TabBtn(props: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button style={{ ...tabBtn, ...(props.active ? tabBtnActive : {}) }} onClick={props.onClick}>
      {props.children}
    </button>
  )
}

function ConversationsTab() {
  const [data, refresh] = usePoll<{ conversations: Conv[] }>(`${BASE}/conversations`, { conversations: [] }, 4000)
  const [selected, setSelected] = useState<string | null>(null)
  const [messages, setMessages] = useState<Msg[]>([])

  useEffect(() => {
    if (!selected) return
    let alive = true
    const load = () => {
      fetch(`${BASE}/conversations/${selected}`, { cache: 'no-store' })
        .then((r) => r.json())
        .then((v) => { if (alive) setMessages(v.messages ?? []) })
        .catch(() => {})
    }
    load()
    const timer = setInterval(load, 4000)
    return () => { alive = false; clearInterval(timer) }
  }, [selected])

  return (
    <div style={{ display: 'flex', gap: 8, flex: 1, minHeight: 0 }}>
      <div style={listCol}>
        <div style={sectionTitle}>会话 ({data.conversations.length})</div>
        {data.conversations.map((c) => (
          <div key={c.id} style={{ ...convRow, ...(selected === c.id ? convRowActive : {}) }}
            onClick={() => setSelected(c.id)}>
            <div style={{ fontWeight: 500 }}>{c.id}</div>
            <div style={{ fontSize: 11, color: '#888' }}>{c.kind} · {c.message_count} 条</div>
          </div>
        ))}
        {data.conversations.length === 0 && <div style={empty}>暂无会话</div>}
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        {selected ? (
          <>
            <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
              <button style={miniBtn} onClick={() => { void post(`/conversations/${selected}/reply`).then(() => refresh()) }}>补一次回复</button>
              <button style={miniBtnDanger} onClick={() => { void del(`/conversations/${selected}`).then(() => { setSelected(null); setMessages([]); refresh() }) }}>清空</button>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
              {messages.map((m) => (
                <div key={m.id} style={msgRow(m.role)}>
                  <div style={msgMeta}>{m.role === 'user' ? `u${m.user_id ?? '?'}` : 'bot'} · {new Date(m.created_at).toLocaleTimeString()}</div>
                  {m.thinking && <div style={thinking}>{m.thinking}</div>}
                  <div>{m.content}</div>
                </div>
              ))}
              {messages.length === 0 && <div style={empty}>暂无消息</div>}
            </div>
          </>
        ) : (
          <div style={empty}>选择一个会话</div>
        )}
      </div>
    </div>
  )
}

function MemoryTab() {
  const [data] = usePoll<{ memories: Mem[] }>(`${BASE}/memories`, { memories: [] }, 4000)
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      <div style={sectionTitle}>记忆 ({data.memories.length})</div>
      {data.memories.map((m) => (
        <div key={m.id} style={memRow}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ fontWeight: 500 }}>{m.topic}</span>
            <span style={{ fontSize: 11, color: '#888' }}>
              {m.scope === 'group' ? '群' : '友'} · s={m.strength.toFixed(2)} · n={m.mention_count}
            </span>
          </div>
          <div style={{ fontSize: 12 }}>{m.summary}</div>
        </div>
      ))}
      {data.memories.length === 0 && <div style={empty}>暂无记忆</div>}
    </div>
  )
}

function UsageTab() {
  const [data] = usePoll<{ events: UsageEv[] }>(`${BASE}/usage`, { events: [] }, 4000)
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      <div style={sectionTitle}>用量 ({data.events.length})</div>
      {data.events.map((e) => (
        <div key={e.id} style={memRow}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ fontWeight: 500 }}>{e.model}</span>
            <span style={{ fontSize: 11, color: '#888' }}>{new Date(e.ts).toLocaleString()}</span>
          </div>
          <div style={{ fontSize: 12 }}>
            in={e.input_tokens ?? '-'} out={e.output_tokens ?? '-'} cache={e.cache_hit ?? '-'}
            {e.conv_id ? ` · ${e.conv_id}` : ''}
          </div>
        </div>
      ))}
      {data.events.length === 0 && <div style={empty}>暂无用量记录</div>}
    </div>
  )
}

function WhitelistTab() {
  const [data, refresh] = usePoll<AllowData>(`${BASE}/allowlist`, { enabled: false, keys: [], entries: [] }, 8000)
  const [sel, setSel] = useState<Set<string> | null>(null)
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [friends, setFriends] = useState<Friend[]>([])
  const [groups, setGroups] = useState<GroupItem[]>([])
  const [listError, setListError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')

  // Seed the draft from the server exactly once, so a background poll cannot
  // overwrite an in-progress selection.
  useEffect(() => {
    if (sel === null && Array.isArray(data.keys)) setSel(new Set(data.keys))
    if (enabled === null) setEnabled(Boolean(data.enabled))
  }, [data, sel, enabled])

  const loadLists = async (): Promise<void> => {
    setLoading(true)
    setListError(null)
    try {
      const [f, g] = await Promise.all([
        fetch(`${BASE}/friends`, { cache: 'no-store' }).then((r) => r.json()) as Promise<{ friends?: Friend[]; error?: string }>,
        fetch(`${BASE}/groups`, { cache: 'no-store' }).then((r) => r.json()) as Promise<{ groups?: GroupItem[]; error?: string }>,
      ])
      setFriends(f.friends ?? [])
      setGroups(g.groups ?? [])
      const err = f.error ?? g.error
      if (err) setListError(String(err))
    } catch (error) {
      setListError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void loadLists() }, [])

  const toggle = (key: string): void => setSel((prev) => {
    const next = new Set(prev ?? [])
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })

  const setMany = (keys: string[], on: boolean): void => setSel((prev) => {
    const next = new Set(prev ?? [])
    for (const key of keys) {
      if (on) next.add(key)
      else next.delete(key)
    }
    return next
  })

  const save = async (): Promise<void> => {
    setSaveState('saving')
    try {
      const r = (await post('/allowlist', { keys: [...(sel ?? [])], enabled: enabled ?? false })) as { ok?: boolean } | null
      if (r && r.ok) {
        setSaveState('saved')
        setTimeout(() => setSaveState('idle'), 2500)
        refresh()
      } else {
        setSaveState('error')
      }
    } catch {
      setSaveState('error')
    }
  }

  const friendKeys = friends.map((f) => `u:${f.user_id}`)
  const groupKeys = groups.map((g) => `g:${g.group_id}`)
  const known = new Set([...friendKeys, ...groupKeys])
  const orphanKeys = [...(sel ?? [])].filter((k) => !known.has(k))

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      <div style={sectionTitle}>对话白名单</div>
      <Bool label="启用白名单（仅回复勾选的好友 / 群，其它会话一律忽略）" value={enabled ?? false} onChange={setEnabled} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0 10px' }}>
        <button style={miniBtn} disabled={loading} onClick={() => { void loadLists() }}>
          {loading ? '读取中…' : '从 QQ 读取好友 / 群'}
        </button>
        <span style={{ fontSize: 11, color: '#888' }}>
          已选 {(sel ?? new Set()).size} 项 · 好友 {friends.length} · 群 {groups.length}
        </span>
        <button style={{ ...saveBtn, marginLeft: 'auto' }} disabled={saveState === 'saving'} onClick={() => { void save() }}>
          {saveState === 'saving' ? '保存中…' : '保存白名单'}
        </button>
        {saveState === 'saved' && <span style={{ color: '#0f9d6e', fontSize: 12 }}>✓ 已生效</span>}
        {saveState === 'error' && <span style={{ color: '#c00', fontSize: 12 }}>✗ 保存失败</span>}
      </div>

      {listError && <div style={errorText}>读取失败：{listError}（请确认 QQ 已连接 / token 正确）</div>}

      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <div style={colBox}>
          <div style={colHead}>
            <span>好友 ({friends.length})</span>
            <span>
              <button style={miniBtn} onClick={() => setMany(friendKeys, true)}>全选</button>
              <button style={{ ...miniBtn, marginLeft: 4 }} onClick={() => setMany(friendKeys, false)}>清空</button>
            </span>
          </div>
          {friends.map((f) => {
            const key = `u:${f.user_id}`
            return (
              <label key={key} style={checkRow}>
                <input type="checkbox" checked={(sel ?? new Set()).has(key)} onChange={() => toggle(key)} />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                <span style={idHint}>{f.user_id}</span>
              </label>
            )
          })}
          {friends.length === 0 && <div style={empty}>暂无好友</div>}
        </div>

        <div style={colBox}>
          <div style={colHead}>
            <span>群聊 ({groups.length})</span>
            <span>
              <button style={miniBtn} onClick={() => setMany(groupKeys, true)}>全选</button>
              <button style={{ ...miniBtn, marginLeft: 4 }} onClick={() => setMany(groupKeys, false)}>清空</button>
            </span>
          </div>
          {groups.map((g) => {
            const key = `g:${g.group_id}`
            return (
              <label key={key} style={checkRow}>
                <input type="checkbox" checked={(sel ?? new Set()).has(key)} onChange={() => toggle(key)} />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.name}</span>
                <span style={idHint}>{g.group_id}</span>
              </label>
            )
          })}
          {groups.length === 0 && <div style={empty}>暂无群聊</div>}
        </div>
      </div>

      {orphanKeys.length > 0 && (
        <>
          <div style={groupTitle}>其它已选（不在当前好友/群列表中）</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {orphanKeys.map((key) => (
              <button key={key} style={miniBtn} onClick={() => toggle(key)}>{key} ×</button>
            ))}
          </div>
        </>
      )}

      <div style={{ fontSize: 11, color: '#999', marginTop: 10 }}>
        白名单按会话粒度生效：勾选一个群 = 允许该群全部成员触发；勾选一个好友 = 允许该私聊。
        关闭“启用白名单”时不做任何限制。
      </div>
    </div>
  )
}

function DiagnosticsTab() {
  const [status] = usePoll<Status>(
    `${BASE}/status`,
    { enabled: false, endpoint: '', connected: false, model: '', conversations: 0, messages: 0 },
    4000,
  )
  const [data, refresh] = usePoll<{ activity: ActivityEntry[] }>(`${BASE}/activity`, { activity: [] }, 3000)

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      <div style={sectionTitle}>诊断</div>

      <div style={diagGrid}>
        <span style={diagKey}>QQ 连接</span>
        <span style={{ color: status.connected ? '#0f9d6e' : '#c00' }}>{status.connected ? '已连接' : '未连接'}</span>
        <span style={diagKey}>endpoint</span>
        <span>{status.endpoint || '-'}</span>
        <span style={diagKey}>配置的模型</span>
        <span>{status.modelProvider ?? '-'} / {status.model ?? '-'}</span>
        <span style={diagKey}>实际使用</span>
        <span>{status.resolvedProvider ?? '-'} / {status.resolvedModel ?? '-'}</span>
        <span style={diagKey}>白名单</span>
        <span>{status.allowlistEnabled ? `已启用（${status.allowlistSize ?? 0} 项）` : '未启用'}</span>
        <span style={diagKey}>活跃唤醒者</span>
        <span>{status.wakers ?? 0}</span>
        <span style={diagKey}>会话 / 消息</span>
        <span>{status.conversations} / {status.messages}</span>
        <span style={diagKey}>上次错误</span>
        <span style={{ color: status.lastError ? '#c00' : '#0f9d6e' }}>{status.lastError ?? '无'}</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '12px 0 6px' }}>
        <div style={sectionTitle}>最近事件</div>
        <button style={miniBtn} onClick={() => refresh()}>刷新</button>
      </div>
      {data.activity.map((a, i) => (
        <div key={`${a.ts}-${i}`} style={activityRow}>
          <span style={activityTime}>{new Date(a.ts).toLocaleTimeString()}</span>
          <span style={activityKind(a.kind)}>{a.kind}</span>
          <span style={{ color: '#888' }}>{a.conv_id}</span>
          <span style={{ flex: 1, wordBreak: 'break-all' }}>{a.detail}</span>
        </div>
      ))}
      {data.activity.length === 0 && <div style={empty}>暂无事件</div>}
    </div>
  )
}

function SettingsTab() {
  const [data] = usePoll<Cfg>(`${BASE}/config`, null as unknown as Cfg, 8000)
  const [draft, setDraft] = useState<Cfg | null>(null)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')

  useEffect(() => {
    if (data && !draft) setDraft(data)
  }, [data, draft])

  if (!draft) return <div style={empty}>加载配置…</div>

  const upd = (fn: (d: Cfg) => Cfg): void => setDraft((d) => (d ? fn(d) : d))

  const save = async () => {
    setSaveState('saving')
    try {
      const r = (await post('/config', draft)) as { ok?: boolean; error?: string } | null
      if (r && r.ok) {
        setSaveState('saved')
        setTimeout(() => setSaveState('idle'), 2500)
      } else {
        setSaveState('error')
        console.error('[qq-bot] config save failed:', r?.error)
      }
    } catch (error) {
      setSaveState('error')
      console.error('[qq-bot] config save failed:', error)
    }
  }

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      <div style={sectionTitle}>设置</div>

      <div style={groupTitle}>连接</div>
      <Txt label="endpoint" value={draft.endpoint} onChange={(v) => upd((d) => ({ ...d, endpoint: v }))} />
      <Txt label="accessToken" value={draft.accessToken} onChange={(v) => upd((d) => ({ ...d, accessToken: v }))} />

      <div style={groupTitle}>模型 / 人设</div>
      <Txt label="modelProvider" value={draft.modelProvider} onChange={(v) => upd((d) => ({ ...d, modelProvider: v }))} />
      <Txt label="model" value={draft.model} onChange={(v) => upd((d) => ({ ...d, model: v }))} />
      <Area label="persona" value={draft.persona} onChange={(v) => upd((d) => ({ ...d, persona: v }))} />

      <div style={groupTitle}>回复触发</div>
      <Bool label="私聊触发" value={draft.replyTrigger.private.enabled}
        onChange={(v) => upd((d) => ({ ...d, replyTrigger: { ...d.replyTrigger, private: { enabled: v } } }))} />
      <Bool label="被@触发" value={draft.replyTrigger.mention.enabled}
        onChange={(v) => upd((d) => ({ ...d, replyTrigger: { ...d.replyTrigger, mention: { enabled: v } } }))} />
      <Bool label="关键词触发" value={draft.replyTrigger.keyword.enabled}
        onChange={(v) => upd((d) => ({ ...d, replyTrigger: { ...d.replyTrigger, keyword: { ...d.replyTrigger.keyword, enabled: v } } }))} />
      <Txt label="关键词（逗号分隔）" value={draft.replyTrigger.keyword.keywords.join(',')}
        onChange={(v) => upd((d) => ({ ...d, replyTrigger: { ...d.replyTrigger, keyword: { ...d.replyTrigger.keyword, keywords: v.split(',').map((s) => s.trim()).filter(Boolean) } } }))} />
      <Bool label="随机触发" value={draft.replyTrigger.random.enabled}
        onChange={(v) => upd((d) => ({ ...d, replyTrigger: { ...d.replyTrigger, random: { ...d.replyTrigger.random, enabled: v } } }))} />
      <Range label="随机概率" value={draft.replyTrigger.random.probability} min={0} max={1} step={0.05}
        onChange={(v) => upd((d) => ({ ...d, replyTrigger: { ...d.replyTrigger, random: { ...d.replyTrigger.random, probability: v } } }))} />

      <div style={groupTitle}>唤醒（仅群聊）</div>
      <Bool label="唤醒窗口（关闭后只回触发的那一条）" value={draft.sustain.enabled}
        onChange={(v) => upd((d) => ({ ...d, sustain: { ...d.sustain, enabled: v } }))} />
      <Num label="连续未提及 bot 多少条后结束" value={draft.sustain.silentLimit}
        onChange={(v) => upd((d) => ({ ...d, sustain: { ...d.sustain, silentLimit: Math.max(1, Math.round(v)) } }))} />
      <Num label="单窗口最多回复次数" value={draft.sustain.maxReplies}
        onChange={(v) => upd((d) => ({ ...d, sustain: { ...d.sustain, maxReplies: Math.max(1, Math.round(v)) } }))} />

      <div style={groupTitle}>记忆</div>
      <Num label="halfLifeDays" value={draft.memory.halfLifeDays}
        onChange={(v) => upd((d) => ({ ...d, memory: { ...d.memory, halfLifeDays: v } }))} />
      <Num label="boost" step={0.05} value={draft.memory.boost}
        onChange={(v) => upd((d) => ({ ...d, memory: { ...d.memory, boost: v } }))} />
      <Num label="forgetThreshold" step={0.05} value={draft.memory.forgetThreshold}
        onChange={(v) => upd((d) => ({ ...d, memory: { ...d.memory, forgetThreshold: v } }))} />
      <Num label="injectTopK" value={draft.memory.injectTopK}
        onChange={(v) => upd((d) => ({ ...d, memory: { ...d.memory, injectTopK: Math.round(v) } }))} />
      <Num label="injectMaxTokens" value={draft.memory.injectMaxTokens}
        onChange={(v) => upd((d) => ({ ...d, memory: { ...d.memory, injectMaxTokens: Math.round(v) } }))} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
        <button style={saveBtn} disabled={saveState === 'saving'} onClick={() => { void save() }}>
          {saveState === 'saving' ? '保存中…' : '保存配置'}
        </button>
        {saveState === 'saved' && <span style={{ color: '#0f9d6e', fontSize: 12 }}>✓ 已保存并生效</span>}
        {saveState === 'error' && <span style={{ color: '#c00', fontSize: 12 }}>✗ 保存失败（见控制台）</span>}
      </div>
      <div style={{ fontSize: 11, color: '#999', marginTop: 8 }}>
        人设 / 触发 / 唤醒 / 记忆保存后立即生效；endpoint、accessToken、selfId 属连接参数，需重启 DSH 生效。
      </div>
    </div>
  )
}

// ---- form controls ---------------------------------------------------------

function Txt(props: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label style={field}>
      <span style={fieldLabel}>{props.label}</span>
      <input style={input} value={props.value} onChange={(e) => props.onChange(e.target.value)} />
    </label>
  )
}

function Area(props: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label style={field}>
      <span style={fieldLabel}>{props.label}</span>
      <textarea style={{ ...input, minHeight: 70, resize: 'vertical' }} value={props.value} onChange={(e) => props.onChange(e.target.value)} />
    </label>
  )
}

function Num(props: { label: string; value: number; step?: number; onChange: (v: number) => void }) {
  return (
    <label style={field}>
      <span style={fieldLabel}>{props.label}</span>
      <input style={input} type="number" step={props.step} value={props.value}
        onChange={(e) => props.onChange(parseFloat(e.target.value) || 0)} />
    </label>
  )
}

function Range(props: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  return (
    <label style={field}>
      <span style={fieldLabel}>{props.label}：{props.value.toFixed(2)}</span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(parseFloat(e.target.value))}
        style={{ width: '100%' }}
      />
    </label>
  )
}

function Bool(props: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ ...field, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <input type="checkbox" checked={props.value} onChange={(e) => props.onChange(e.target.checked)} />
      <span style={{ fontSize: 12 }}>{props.label}</span>
    </label>
  )
}

// ---- styles ----------------------------------------------------------------

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.4)',
  display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '24px', boxSizing: 'border-box',
}
const card: React.CSSProperties = {
  width: 'min(900px, 94vw)', height: 'min(82vh, 720px)', background: '#fff', color: '#1a1a1a',
  borderRadius: 12, boxShadow: '0 18px 60px rgba(0,0,0,0.35)', display: 'flex', flexDirection: 'column', overflow: 'hidden',
}
const cardHeader: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid #eee', flex: 'none',
}
const closeBtn: React.CSSProperties = { border: 'none', background: 'transparent', fontSize: 20, cursor: 'pointer', color: '#666', marginLeft: 8 }
const tabBar: React.CSSProperties = { display: 'flex', gap: 4, padding: '8px 12px', borderBottom: '1px solid #eee', flex: 'none', alignItems: 'center' }
const connBadge = (connected: boolean): React.CSSProperties => ({
  marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5, fontSize: 12,
  color: connected ? '#0f9d6e' : '#c00', whiteSpace: 'nowrap',
})
const connDot = (connected: boolean): React.CSSProperties => ({
  width: 8, height: 8, borderRadius: 4, background: connected ? '#0f9d6e' : '#c00',
})
const body: React.CSSProperties = { flex: 1, minHeight: 0, padding: 12, overflow: 'hidden', display: 'flex', flexDirection: 'column' }
const tabBtn: React.CSSProperties = { border: 'none', background: 'transparent', padding: '5px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 13 }
const tabBtnActive: React.CSSProperties = { background: '#eef', color: '#5B4CF0', fontWeight: 600 }
const listCol: React.CSSProperties = { width: 160, overflowY: 'auto', borderRight: '1px solid #eee', paddingRight: 8 }
const sectionTitle: React.CSSProperties = { fontSize: 13, fontWeight: 600, marginBottom: 6 }
const groupTitle: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: '#555', margin: '12px 0 6px' }
const convRow: React.CSSProperties = { padding: '6px 8px', borderRadius: 6, cursor: 'pointer', marginBottom: 2 }
const convRowActive: React.CSSProperties = { background: '#eef' }
const empty: React.CSSProperties = { color: '#999', fontSize: 12, padding: 12, textAlign: 'center' }
const miniBtn: React.CSSProperties = { fontSize: 12, padding: '3px 8px', border: '1px solid #ccc', background: '#fff', borderRadius: 4, cursor: 'pointer' }
const miniBtnDanger: React.CSSProperties = { ...miniBtn, color: '#c00', borderColor: '#fcc' }
const msgRow = (role: string): React.CSSProperties => ({
  marginBottom: 6, padding: '6px 8px', borderRadius: 6, fontSize: 13,
  background: role === 'user' ? '#f5f5f5' : '#f0f4ff',
})
const msgMeta: React.CSSProperties = { fontSize: 10, color: '#999', marginBottom: 2 }
const thinking: React.CSSProperties = { fontSize: 11, color: '#777', background: '#fafafa', padding: '4px 6px', borderRadius: 4, marginBottom: 4, whiteSpace: 'pre-wrap' }
const memRow: React.CSSProperties = { padding: '6px 8px', borderBottom: '1px solid #f0f0f0', fontSize: 13 }
const field: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 6 }
const fieldLabel: React.CSSProperties = { fontSize: 11, color: '#888' }
const input: React.CSSProperties = { boxSizing: 'border-box', width: '100%', padding: '6px 8px', fontSize: 12, border: '1px solid #ddd', borderRadius: 6 }
const saveBtn: React.CSSProperties = { padding: '6px 16px', border: 'none', borderRadius: 6, background: '#5B4CF0', color: '#fff', cursor: 'pointer', fontSize: 13 }
const errorBanner: React.CSSProperties = {
  flex: 'none', margin: '8px 12px 0', padding: '6px 10px', borderRadius: 6,
  background: '#fff1f0', border: '1px solid #ffccc7', color: '#a8071a', fontSize: 12, wordBreak: 'break-all',
}
const colBox: React.CSSProperties = {
  flex: 1, minWidth: 0, maxHeight: 320, overflowY: 'auto',
  border: '1px solid #eee', borderRadius: 8, padding: 8,
}
const colHead: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  fontSize: 12, fontWeight: 600, marginBottom: 6, position: 'sticky', top: 0, background: '#fff',
}
const checkRow: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, padding: '3px 2px', fontSize: 12, cursor: 'pointer',
}
const idHint: React.CSSProperties = { fontSize: 10, color: '#aaa', flex: 'none' }
const errorText: React.CSSProperties = { fontSize: 12, color: '#c00', marginBottom: 8 }
const diagGrid: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: '110px 1fr', gap: '4px 10px', fontSize: 12, alignItems: 'baseline',
}
const diagKey: React.CSSProperties = { color: '#888' }
const activityRow: React.CSSProperties = {
  display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12, padding: '3px 0',
  borderBottom: '1px solid #f5f5f5',
}
const activityTime: React.CSSProperties = { color: '#aaa', fontSize: 11, flex: 'none', width: 62 }
const activityKind = (kind: string): React.CSSProperties => ({
  flex: 'none', width: 74, fontWeight: 600,
  color: kind === '失败' ? '#c00' : kind === '已回复' ? '#0f9d6e' : kind.startsWith('连接') ? '#5B4CF0' : '#666',
})
