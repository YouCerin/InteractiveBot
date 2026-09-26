/**
 * Wake-window state machine — pure decision logic, no I/O.
 *
 * A wake window belongs to **one group member** and exists for **group chats
 * only**: a private chat always replies, so it never needs a window. A member
 * opens a window by explicitly activating the bot (`@` or keyword) and closes
 * it when any of these happens:
 *
 *   - the topic drifts (`sameTopic === false`)
 *   - `silentLimit` consecutive messages neither `@`-ed nor keyworded the bot
 *   - the window already sent `maxReplies` replies
 *
 * Windows are independent: several members can hold one at the same time, and
 * another member's trigger never disturbs an existing window. A random hit is
 * not an activation and never opens a window.
 *
 * Kept free of `ctx`/network so the rules can be unit-tested directly — see
 * `scripts/test-awake.mjs`.
 */

/** One member's wake window inside one group conversation. */
export interface WakerState {
  /** Topic summary captured when this member woke the bot. */
  wakeTopic: string
  /** Consecutive messages from this member that neither `@`-ed nor keyworded the bot. */
  silent: number
  /** Replies already sent inside this window. */
  replies: number
  /** Last activity, for stale-window cleanup. */
  lastAt: number
}

export interface WakeInput {
  /** Whether this member already holds a window in this conversation. */
  hasWindow: boolean
  /** Whether this message explicitly activates the bot (`@` or keyword, both enabled). */
  explicit: boolean
  /** Evaluated only when `hasWindow && !explicit`. */
  sameTopic?: boolean
  /** Current window counters; required when `hasWindow`. */
  silent?: number
  replies?: number
  /** Whether the wake window feature is on at all. */
  sustainEnabled: boolean
  silentLimit: number
  maxReplies: number
  /** Whether the random trigger fired (consulted only without a window and without activation). */
  randomHit?: boolean
}

export type WakeDecision =
  /** Window exists and continues: reply, then adopt `silent`/`replies`. */
  | { action: 'reply'; silent: number; replies: number; note: string }
  /** Window exists and the member re-activated: reply, refresh topic, reset counters. */
  | { action: 'reactivate'; note: string }
  /** No window yet and the member activated: create the window, then reply. */
  | { action: 'wake'; note: string }
  /** Reply once without opening a window (random hit, or windows disabled). */
  | { action: 'reply-once'; note: string }
  /** Close the window and stay silent. */
  | { action: 'silence'; reason: string }
  /** Nothing to do. */
  | { action: 'none' }

/**
 * Decide what to do with one group message.
 * @param input - window state, activation facts, and the configured limits.
 * @returns the action plus the counters to store for a continuing window.
 */
export function decideGroupMessage(input: WakeInput): WakeDecision {
  const {
    hasWindow, explicit, sameTopic, sustainEnabled, silentLimit, maxReplies, randomHit,
  } = input
  const silent = input.silent ?? 0
  const replies = input.replies ?? 0

  if (hasWindow) {
    if (explicit) return { action: 'reactivate', note: '再次明确激活' }
    if (!sameTopic) return { action: 'silence', reason: '话题已切换' }
    if (silent + 1 >= silentLimit) {
      return { action: 'silence', reason: `连续 ${silentLimit} 条未提及 bot` }
    }
    if (replies + 1 > maxReplies) {
      return { action: 'silence', reason: `超过上限 ${maxReplies} 次` }
    }
    return {
      action: 'reply',
      silent: silent + 1,
      replies: replies + 1,
      note: `同一话题 · 第 ${replies + 1} 次`,
    }
  }

  if (explicit) {
    if (!sustainEnabled) return { action: 'reply-once', note: '唤醒窗口已关闭' }
    return { action: 'wake', note: '开启唤醒窗口' }
  }

  if (randomHit) return { action: 'reply-once', note: '随机命中（不建立唤醒）' }
  return { action: 'none' }
}
