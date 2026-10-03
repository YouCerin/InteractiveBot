/**
 * 定时任务的**执行器**：tick → 判定 → 唤醒模型 → 交给 `#deliver`（0.3.2 P1）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 与 `schedule.mjs` 的分工（别把两件事混起来）
 * ══════════════════════════════════════════════════════════════════════════
 *   `schedule.mjs`  —— **纯逻辑 + 落盘**：下次什么时候、认领过没有、错过记在哪。
 *   `schedule-runner.mjs`（本文件）—— **与桥接打交道**：起定时器、拿会话锁、
 *                                     调 `rpc.prompt`、把答案交给 `#deliver`。
 *
 * ★ 之所以要这条分界线：纯逻辑那一边可以**完全离线测**（不需要 QQ、不需要 DSH、不花钱），
 *   而本文件里几乎每一条都有"离线测不出来"的接线风险（本项目栽过：任务段的
 *   `chatKey` 在错的作用域里被空 catch 吞掉，那个段在真机上**从未注入过**，
 *   而 124 项纯函数断言全绿）。所以本文件的每一条行为都要有**接线级断言**盯着。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★★ 本文件最要紧的一件事：**"恰好一次"的第二道锁**
 * ══════════════════════════════════════════════════════════════════════════
 * `schedule.mjs` 的 `claimFire()` 在**调模型之前**写一行 `claimed`，于是"同一次触发
 * 不会被认领两次"。但还剩一个缝：**认领之后、消息真的发出去之前**崩溃，
 * 重启后只看得到 `claimed` —— 那时我们**不知道那条消息到底发出去没有**。
 *
 * 这正是 `delivery-ledger.mjs` 用一整份账本在防的事（"发出去但没标上"无法区分 ⇒
 * **绝不自动重放**，重复回复比漏一条更糟）。所以这里**照同一个结论办**：
 *
 *   `claimed`   —— 只认领了，**还没开始干活** ⇒ 重启后可以**接着做完**（同一次触发）
 *   `sending`   —— **已经开始干活**（模型/投递都可能发生过了）⇒ 重启后**只报告，不重做**
 *
 * ⇒ 于是"自动重做"的范围被压到"认领与开工之间"那一瞬间，而真正的
 *   "可能已经发出去"那一类**永远不会被自动重放**。这条边界是刻意划在这里的。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 另外三条纪律
 * ══════════════════════════════════════════════════════════════════════════
 *   ① **失败只记日志、绝不抛**（增强路径；`AGENT.md` 第 9 条：不许安静地失败）。
 *   ② **`unref()`**：绝不能因为一个任务定时器把进程退出拖住
 *      （同 `createConsolidateScheduler`，桥接靠 Ctrl+C / SIGTERM 收尾）。
 *   ③ **不许阻塞桥接启动**：MC 服务端冷启动要几分钟（模组服更久），
 *      定时器只是"每 N 秒看一眼"，任何 IO 失败都只影响这一跳。
 */

import {
  FIRES_REL,
  MISSED_REL,
  claimFire,
  dueAt,
  isClockTask,
  listTasks,
  markTaskFired,
  noteHistory,
  noteMissed,
  occurrenceKey,
  pruneLedgers,
  readFireIndex,
  readLedger,
  settleFire,
} from './schedule.mjs'

/**
 * 默认 tick 间隔：**30 秒**。
 *
 * ★ 为什么不更密：定时任务的精度需求是"分钟级"（"8 点叫我一声"），
 *   30 秒的抖动完全够；而每条 tick 都要读一遍任务目录与台账。
 * ★ 为什么不能更疏：容差窗口默认 2 分钟，tick 太疏会让"重启后补发"
 *   这段判断本身变得不可靠（一次 tick 跨过整个窗口）。
 */
export const DEFAULT_TICK_MS = 30 * 1000

/** tick 间隔的下限（防手滑把 CPU 打满）。 */
export const MIN_TICK_MS = 10 * 1000

/** 同一进程内，一次 tick 最多处理几次触发（防"一堆过期任务"把这一跳拖死）。 */
const MAX_FIRES_PER_TICK = 5

/**
 * 造一个定时任务执行器（**可注入时钟与定时器**，所以能离线测）。
 *
 * @param {object} opts
 * @param {string} opts.workspace
 * @param {object} opts.bridge
 *   桥接侧提供的能力（**只有这三样**，刻意收窄 —— 本模块不碰桥接的内部状态）：
 *   · `resolveTarget({kind, peerId})` → `{ ok, sessionId, chatKey, tier, reason }`
 *     —— 由桥接决定"这个会话的 sessionId 是谁、以什么权限跑"（会话键与会话 id 的映射只有它知道）
 *   · `runProactiveTurn({task, scheduledAt, lateByMs, target, runner})` → `{ ok, text }`
 *     —— 由桥接跑一轮**主动回合**（拼提示词、`rpc.prompt`、收答案、`#deliver` 投递）
 *   · `noteMissedToUser(rows)` —— 把错过台账在下一次交互时如实说出来（可缺省）
 * @param {object} [opts.config]  归一化配置（读 `schedule.*`；缺省视作启用）
 * @param {number} [opts.tickMs]
 * @param {boolean} [opts.enabled]
 * @param {Function} [opts.log]
 * @param {object} [opts.timer]   可注入定时器（测试用）
 * @param {Function} [opts.now]   可注入时钟（测试用）
 * @returns {{start: Function, stop: Function, tick: Function, isRunning: Function, stats: Function, reconcile: Function}}
 */
export function createScheduleRunner({
  workspace,
  bridge = null,
  config = null,
  tickMs = DEFAULT_TICK_MS,
  enabled = true,
  log = () => {},
  timer = { setInterval, clearInterval },
  now = () => Date.now(),
} = {}) {
  const root = String(workspace ?? '')
  let handle = null
  let ticks = 0
  let fired = 0
  let missed = 0
  let lastError = ''
  /** 启动对账只做一次（它会把残局大声报出来，每跳都报就成了刷屏）。 */
  let reconciled = false
  /** 正在处理中的触发键（防同一跳/相邻两跳重复进入同一次触发）。 */
  const inFlight = new Set()
  /** 台账裁剪只做一次（进程内）。 */
  let pruned = false

  /** 读配置（**每跳现读** ⇒ 开关即时生效，与 `plugins.mjs` 的 hot 判据一致）。 */
  function settings() {
    const s = config?.schedule ?? {}
    const every = Number(s.tickMs ?? tickMs)
    return {
      enabled: enabled !== false && s.enabled !== false,
      tickMs: Number.isFinite(every) ? Math.max(MIN_TICK_MS, every) : DEFAULT_TICK_MS,
    }
  }

  /**
   * 启动对账：把**上一次进程留下的、没有结果的触发**如实报出来。
   *
   * ★ 为什么必须有这一步：`delivery-ledger` 那条教训是"**可查 ≠ 会被告知**" ——
   *   真机丢回复时没有任何地方提示过。所以这里在启动时喊一次。
   * ★ 同时它是"接着做完"的依据：`claimed`（没开工）那类**归 runner 重做**，
   *   `sending`（开过工）那类**只报告**，绝不重做（见文件头）。
   */
  function reconcile() {
    const idx = readFireIndex({ workspace: root })
    if (!idx.ok) {
      log(`❌ [schedule] 读不了触发台账（${idx.why}）—— 这一次**无法判断**哪些触发没做完`)
      return { ok: false, why: idx.why, dangling: [], maybeSent: [] }
    }
    const dangling = []
    const maybeSent = []
    for (const [key, row] of idx.map) {
      const status = String(row?.status ?? '')
      if (status === 'delivered' || status === 'failed' || status === 'empty') continue
      // `claimed` 之后若又出现了 `sending`，Map 里留的是**后者**（同一键后者胜）
      if (status === 'sending') maybeSent.push({ key, ...row })
      else if (status === 'claimed') dangling.push({ key, ...row })
    }
    if (maybeSent.length > 0) {
      log(
        `⚠️ [schedule] 有 ${maybeSent.length} 次触发**可能已经说出去、但没有结果**（重启打断）：` +
          maybeSent.map((r) => r.title ?? r.taskId ?? r.key).join('、') +
          ' —— 按投递账本同一条纪律，**不自动重做**（重复一条比漏一条更糟）。' +
          ` 要看细节：node src/index.mjs --schedule --fires`,
      )
    }
    if (dangling.length > 0) {
      log(
        `[schedule] 有 ${dangling.length} 次触发认领了但**没开工**（重启打断）：` +
          dangling.map((r) => r.title ?? r.taskId ?? r.key).join('、') +
          ' —— 会在下一次 tick 接着做完（同一次触发，不会再认领一次）',
      )
    }
    return { ok: true, dangling, maybeSent }
  }

  /**
   * 一次 tick。**绝不在 IO 失败时抛**。
   * @param {{reason?: string}} [opts]
   */
  async function tick({ reason = 'timer' } = {}) {
    ticks += 1
    const s = settings()
    if (!s.enabled) return { ok: true, skipped: 'disabled', ticks }
    if (!root) {
      log('❌ [schedule] 没有 workspace（内部接线问题），这一跳跳过')
      return { ok: false, why: '缺少 workspace' }
    }
    if (!bridge || typeof bridge.runProactiveTurn !== 'function') {
      // 没注入就是接线问题 —— 不许静默（AGENT.md 第 9 条）
      log('❌ [schedule] 没有注入 bridge.runProactiveTurn（内部接线问题），这一跳跳过')
      return { ok: false, why: '没有注入执行能力' }
    }

    // ★ 第一跳顺手做一次启动对账：`start()` 里也会做（真机上定时器先响），
    //   但 `tick()` 也可能被**直接**调用（CLI 巡检、测试、界面上的"立刻看一次"），
    //   那时若不报残局，"可查 ≠ 会被告知"这条又要靠人记得去查。只做一次。
    if (!reconciled) {
      reconciled = true
      try {
        reconcile()
      } catch (error) {
        log(`⚠️ [schedule] 启动对账失败（不影响这一跳）：${error?.message ?? error}`)
      }
    }

    let listed
    try {
      listed = listTasks({ workspace: root })
    } catch (error) {
      log(`❌ [schedule] 列任务失败（这一跳跳过）：${error?.message ?? error}`)
      return { ok: false, why: '列任务失败' }
    }
    if (!listed.ok) {
      log(`❌ [schedule] 列任务失败（这一跳跳过）：${listed.why}`)
      return { ok: false, why: listed.why }
    }
    for (const p of listed.problems) {
      log(`⚠️ [schedule] 任务「${p.id}」读不出来（跳过它，其它任务照常）：${p.why}`)
    }

    const idx = readFireIndex({ workspace: root })
    /**
     * 已认领的键。★ 它是**可变集合**，不是快照 —— 同一个 tick 里前一条任务认领之后，
     * 后一条任务必须看得见它。第一版每跳只读一次盘、认领后不更新，
     * 于是同一跳里"错过台账"会被**记两遍**（`verify-schedule` ⑦ 抓到的）。
     */
    const claimedKeys = new Set(idx.map.keys())
    const at = now()
    const results = []
    let budget = MAX_FIRES_PER_TICK

    for (const task of listed.tasks) {
      if (budget <= 0) {
        // 这一跳用完了配额：剩下的下一次 tick 再说（**不静默** —— 记一行）
        log(`[schedule] 这一跳的触发配额用完了（${MAX_FIRES_PER_TICK} 次），剩下的下一次 tick 继续`)
        break
      }
      // ★★ 事件型任务（`trigger.kind === 'server'`）**不走时钟那条路** ——
      //   它们的触发来自 `src/servers/watch.mjs` 的事件。不排除的话，
      //   它们会被当成"每天某时刻"的任务：`repeat` 是个无意义的占位值，
      //   `dueAt` 会算出一个从来不存在的触发点 ⇒ 要么永不触发、要么**乱报**。
      if (!isClockTask(task)) continue
      let due = null
      try {
        due = dueAt(task, { now: at, isClaimed: (k) => claimedKeys.has(k) })
      } catch (error) {
        log(`❌ [schedule] 算「${task.title}」的下一次触发时抛异常（跳过）：${error?.message ?? error}`)
        continue
      }
      // ── 认领过但没开工的那条：接着做完（**同一次触发**，不重新认领）──
      //
      // ⚠️ 这里**不能再判 `claimedKeys`**：残局那条的键**本来就在集合里**
      //   （它正是被认领过的那一条）⇒ 一判就被跳过，残局永远做不完
      //   （`verify-schedule` ⑧ 抓到的）。`findDangling` 只认 `claimed` 状态，
      //   已经开工过（`sending`）的那类不会被它选出来。
      if (!due) {
        const dangling = findDangling(idx, task.id)
        if (dangling) {
          if (inFlight.has(dangling.key)) continue
          budget -= 1
          results.push(await runOne({ task, scheduledAt: dangling.scheduledAt, key: dangling.key, at, resume: true }))
          continue
        }
        continue
      }

      // ── 迟到太久 ⇒ **不补发**，记一行错过台账（使用者拍板的口径）──
      const tolerance = Number.isFinite(Number(task.lateToleranceMs)) ? Number(task.lateToleranceMs) : 2 * 60 * 1000
      if (due.lateByMs > tolerance) {
        budget -= 1
        missed += 1
        claimedKeys.add(due.occurrenceKey)
        const r = noteMissed({
          workspace: root,
          task,
          scheduledAt: due.scheduledAt,
          now: at,
          lateByMs: due.lateByMs,
          reason: 'late',
        })
        // ★ 认领掉它：否则每一跳都会重新算出同一个点、反复写错过台账
        claimFire({ workspace: root, task, scheduledAt: due.scheduledAt, now: at, lateByMs: due.lateByMs })
        settleFire({ workspace: root, key: due.occurrenceKey, status: 'failed', detail: '迟到超过容差窗口，不补发', now: at })
        log(
          `[schedule] 「${task.title}」的触发点已经过去 ${Math.round(due.lateByMs / 60000)} 分钟` +
            `（超过容差 ${Math.round(tolerance / 60000)} 分钟）⇒ **不补发**，已记进错过台账` +
            (r.ok ? '' : `（⚠️ 错过台账没写成功：${r.why}）`),
        )
        continue
      }

      if (inFlight.has(due.occurrenceKey) || claimedKeys.has(due.occurrenceKey)) continue
      budget -= 1
      claimedKeys.add(due.occurrenceKey)
      results.push(await runOne({ task, scheduledAt: due.scheduledAt, key: due.occurrenceKey, at, resume: false }))
    }

    if (!pruned) {
      pruned = true
      try {
        const pr = pruneLedgers({ workspace: root })
        for (const p of pr) {
          if (!p.ok) log(`⚠️ [schedule] 台账裁剪失败（${p.rel}）：${p.why}`)
          else if (p.dropped > 0) log(`[schedule] 台账裁剪：${p.rel} 丢了 ${p.dropped} 行最旧的`)
        }
      } catch (error) {
        log(`⚠️ [schedule] 台账裁剪抛异常（忽略）：${error?.message ?? error}`)
      }
    }

    return { ok: true, ticks, reason, tasks: listed.tasks.length, results, fired, missed }
  }

  /** 找一条"认领了但没开工"的记录（同一任务、且**是最新那个触发点**才算）。 */
  function findDangling(idx, taskId) {
    let best = null
    for (const [key, row] of idx.map) {
      if (String(row?.taskId ?? '') !== String(taskId)) continue
      if (String(row?.status ?? '') !== 'claimed') continue
      const scheduledAt = Number(row?.scheduledAt)
      if (!Number.isFinite(scheduledAt)) continue
      if (!best || scheduledAt > best.scheduledAt) best = { key, scheduledAt }
    }
    return best
  }

  /**
   * 跑**一次**触发。三道写台账的顺序**不能换**：
   *
   *   claimFire（认领）→ settleFire('sending')（开工）→ 干活 → settleFire(结果)
   *
   * ★ 中间那道 `sending` 是"绝不自动重放"那条边界的落点，见文件头。
   */
  async function runOne({ task, scheduledAt, key, at, resume = false }) {
    inFlight.add(key)
    const lateByMs = Math.max(0, at - scheduledAt)
    try {
      if (!resume) {
        const c = claimFire({ workspace: root, task, scheduledAt, now: at, lateByMs })
        if (!c.ok) {
          // 认领不上 = 去重就没有依据了 ⇒ **宁可不发**（发了可能重复）
          log(`❌ [schedule] 「${task.title}」认领失败（**这次不发**，避免重复）：${c.why}`)
          return { ok: false, key, why: 'claim-failed' }
        }
      }
      // 开工标记：从这一刻起，"发出去没有"我们不再有把握
      settleFire({ workspace: root, key, status: 'sending', detail: resume ? 'resume' : '', now: now() })

      let target
      try {
        target = bridge.resolveTarget({ kind: task.target.kind, peerId: task.target.peerId })
      } catch (error) {
        target = { ok: false, why: `解析目标会话时抛异常：${error?.message ?? error}` }
      }
      if (!target?.ok) {
        settleFire({ workspace: root, key, status: 'failed', detail: `目标会话不可用：${target?.why ?? '未知'}`, now: now() })
        log(
          `❌ [schedule] 「${task.title}」没发成：目标会话不可用（${target?.why ?? '未知'}）` +
            ' —— 这条会出现在 `--schedule --fires` 里，**不会自动重发**',
        )
        return { ok: false, key, why: 'no-target' }
      }

      const r = await bridge.runProactiveTurn({
        task,
        scheduledAt,
        lateByMs,
        target,
        runner: { log },
      })
      const text = String(r?.text ?? '').trim()
      if (r?.ok && text) {
        fired += 1
        // 两份记录各管一件事：`delivered` 管去重，`history` 管"它到底说了什么"
        settleFire({ workspace: root, key, status: 'delivered', chars: text.length, now: now() })
        const h = noteHistory({ workspace: root, task, scheduledAt, text, now: now(), via: r?.via ?? 'model' })
        if (!h.ok) log(`⚠️ [schedule] 「${task.title}」的实际原文没记上：${h.why}`)
        const m = markTaskFired({ workspace: root, id: task.id, scheduledAt, now: now() })
        if (!m.ok) log(`⚠️ [schedule] 「${task.title}」的 lastFiredAt 没更新（去重不受影响，靠台账）：${m.why}`)
        log(`[schedule] 「${task.title}」已发出（${text.length} 字${lateByMs >= 60000 ? `，迟到 ${Math.round(lateByMs / 60000)} 分钟` : ''}）`)
        return { ok: true, key, text }
      }

      // 模型没产出（空回复）：**不重跑模型**（同 `#deliver` 的交付语义），如实记下
      settleFire({ workspace: root, key, status: 'empty', detail: String(r?.why ?? '模型没有产出内容'), now: now() })
      log(
        `❌ [schedule] 「${task.title}」这一轮**没有产出内容**（${r?.why ?? '未知'}）` +
          ' —— 按交付语义**不重跑模型**，也不自动补发',
      )
      return { ok: false, key, why: 'empty' }
    } catch (error) {
      settleFire({ workspace: root, key, status: 'failed', detail: `抛异常：${error?.message ?? error}`, now: now() })
      lastError = String(error?.message ?? error)
      log(`❌ [schedule] 「${task?.title ?? key}」触发时抛异常（已记账，机器人照常工作）：${error?.stack ?? error}`)
      return { ok: false, key, why: 'threw' }
    } finally {
      inFlight.delete(key)
    }
  }

  function start() {
    if (handle) return false
    const s = settings()
    if (!s.enabled) {
      log('[schedule] 定时任务未开启（schedule.enabled=false）')
      return false
    }
    // 启动时先把上一次留下的残局说清楚（可查 ≠ 会被告知）
    try {
      reconcile()
    } catch (error) {
      log(`⚠️ [schedule] 启动对账失败（不影响后续 tick）：${error?.message ?? error}`)
    }
    handle = timer.setInterval(() => {
      // tick 是 async，而 setInterval 不会等它 —— 必须自己接住拒绝，否则
      // 未处理的 Promise 拒绝会按既定策略把进程带走（同 H13 那条真机事故的形状）
      tick({ reason: 'timer' }).catch((error) => {
        lastError = String(error?.message ?? error)
        log(`❌ [schedule] tick 未捕获错误（已吞掉，机器人照常工作）：${error?.stack ?? error}`)
      })
    }, s.tickMs)
    // ★ 绝不能因为一个任务定时器让进程退不掉
    handle?.unref?.()
    log(`[schedule] 定时任务已开启（每 ${Math.round(s.tickMs / 1000)} 秒看一眼，到点才动手）`)
    return true
  }

  function stop() {
    if (!handle) return false
    timer.clearInterval(handle)
    handle = null
    return true
  }

  return {
    start,
    stop,
    tick,
    isRunning: () => Boolean(handle),
    reconcile,
    stats: () => ({ ticks, fired, missed, lastError, inFlight: inFlight.size, running: Boolean(handle) }),
  }
}
