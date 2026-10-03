/**
 * 重启编排：**停 → 等端口释放 → 起 → 等恢复**，以及"试一次就够"（0.3.2 P4）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★★ 为什么这件事必须**谨慎到偏执**
 * ══════════════════════════════════════════════════════════════════════════
 * 需求原话：「小鲸鱼会且仅会一次在选定聊天中报告服务器情况，**并尝试一次重启**，
 * 重启失败向管理员求助等待指令」。三条后果都是**不可逆**的：
 *
 *   ① **两个 JVM 同时写同一个世界目录 = 存档损坏。** ∴ "停"之后**必须等端口真的释放**
 *      （那是"进程真退出了"唯一能观测到的证据），**绝不允许"停完立刻起"**。
 *   ② **重启失败不能变成重启风暴。** 一个坏掉的模组会让机器整夜重启 ⇒
 *      必须有冷却，且冷却状态**落盘**（否则重启一次就绕过了它）。
 *   ③ **"我试过重启了"不能是假象。** 判成功只能是**端口重新可连**，
 *      不是"我把命令发出去了"。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 关于"能不能重启"的诚实边界（照 §6.3.1，不许含糊）
 * ══════════════════════════════════════════════════════════════════════════
 * 这个模块**自己不认识任何进程**。它要的是一份**归属证据**（`evidence`）：
 *   · `owner: 'bridge'`  —— 服务端是我们拉起来的（`running.json` 的 `pid@启动时刻` 对得上）；
 *   · `owner: 'external'` —— 端口活着但**不是我们起的**（别人手动起的、服务管理器起的）。
 * 只有 `owner === 'bridge'` 才允许重启；`external` 时**如实降级成"只报告、不重启"**，
 * 并把原因写清楚。**绝不"先杀再抢"** —— 那可能是在杀别人的服务端。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 与另三个模块的分工
 * ══════════════════════════════════════════════════════════════════════════
 *   `rcon.mjs`     —— 协议（发 `stop` 用它）
 *   `monitor.mjs`  —— 判定（`down`/`up` 事件）
 *   `loop.mjs`     —— 采样编排
 *   **本模块**      —— **处置**：重启编排与它的冷却/求助状态机
 *
 * ★ 本模块**自己发消息吗**？不发。它返回结构化结论（`outcome`），由桥接决定怎么播报
 *   —— 与"监测与说话解耦"同一条纪律。
 */

import { connect } from 'node:net'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 重启状态文件所在目录（工作区相对）。 */
export const RESTART_DIR = 'runtime/servers'

/** 冷却：重启成功之后这么久内又 down ⇒ **不再自动重启**，直接求助（默认 10 分钟）。 */
export const DEFAULT_COOLDOWN_MS = 10 * 60_000

/** 等端口释放的上限（停服之后）。超时 ⇒ **不强杀**，转求助。 */
export const DEFAULT_STOP_WAIT_MS = 60_000

/** 等恢复（端口重新可连）的上限。模组服冷启动 2~5 分钟是常态。 */
export const DEFAULT_UP_WAIT_MS = 180_000

/** 轮询间隔（等服务端状态变化时）。 */
export const POLL_STEP_MS = 2000

/** 结论类型（桥接按它决定播报措辞）。 */
export const OUTCOME = {
  /** 重启成功（端口重新可连）。 */
  RESTARTED: 'restarted',
  /** 不允许重启（并说明为什么）。 */
  SKIPPED: 'skipped',
  /** 试过了，但没起来 —— **该求助并等指令**。 */
  FAILED: 'failed',
  /** 我们发起了重启，但过程中被中断（桥接收尾）—— 如实记账，不重来。 */
  INTERRUPTED: 'interrupted',
}

/** 一次重启尝试的状态机（落盘，所以"试过几次"跨重启仍然算数）。 */
function initialState(serverId) {
  return {
    version: 1,
    serverId: String(serverId),
    /** 累计尝试次数（**只增**，管理员说 retry 才继续）。 */
    attempts: 0,
    /** 最近一次尝试的结果与时刻。 */
    lastAttemptAt: null,
    lastOutcome: null,
    lastDetail: '',
    /** 冷却截止时刻（重启成功之后才设）。 */
    cooldownUntil: null,
    /** 是否处于"等管理员指令"状态（求助之后置位，管理员 retry/abandon 才清）。 */
    waitingForAdmin: false,
    /** 管理员批准过一次重试（消费掉就清）。 */
    adminApproved: false,
  }
}

/**
 * 造一个重启编排器（**注入时钟、IO 与动作**，所以能离线测）。
 *
 * @param {object} opts
 * @param {string} opts.workspace
 * @param {string} opts.serverId
 * @param {object} [opts.config] 归一化配置（读 `servers[].restart.*` 之类的开关）
 * @param {() => Promise<{ok: boolean, why?: string}>} [opts.stopGracefully]
 *        优雅停服（通常 = 通过 RCON 发 `stop`）。**只在连接还在时有意义**。
 * @param {(server: object) => Promise<{ok: boolean, pid?: number, why?: string}>} [opts.launch]
 *        把服务端拉起来（`detached` + `unref` + 记 `running.json` 由调用方做）。
 * @param {(host: string, port: number, timeoutMs: number) => Promise<boolean>} [opts.portOpen]
 *        端口探针（默认用一次 TCP connect）。**"进程真的退出了"只认它**。
 * @param {() => number} [opts.now]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @param {Function} [opts.log]
 */
export function createRestarter({
  workspace,
  serverId,
  config = null,
  stopGracefully = null,
  launch = null,
  portOpen = null,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = () => {},
} = {}) {
  const root = String(workspace ?? '')
  const id = String(serverId ?? '').replace(/[^a-zA-Z0-9_.-]/g, '_')
  const rel = `${RESTART_DIR}/${id}.restart.json`

  const openProbe =
    portOpen ??
    ((host, port, timeoutMs) =>
      new Promise((resolve) => {
        let settled = false
        const done = (v) => {
          if (settled) return
          settled = true
          try {
            sock.destroy()
          } catch {
            /* 已经关了 */
          }
          resolve(v)
        }
        const sock = connect({ host: String(host), port: Number(port) })
        sock.setTimeout(timeoutMs)
        sock.once('connect', () => done(true))
        sock.once('timeout', () => done(false))
        sock.once('error', () => done(false))
      }))

  let state = initialState(id)

  function load() {
    if (!root) return { ok: false, why: '缺少 workspace' }
    try {
      const p = join(root, rel)
      if (!existsSync(p)) return { ok: true, restored: false }
      let text = readFileSync(p, 'utf8')
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
      const v = JSON.parse(text)
      if (v && typeof v === 'object' && v.serverId === id) {
        state = { ...state, ...v }
        // ★ 白名单化：盘上被手改成非法值时**不许当成"已批准"**
        state.attempts = Number.isFinite(Number(v.attempts)) ? Math.max(0, Number(v.attempts)) : 0
        state.waitingForAdmin = v.waitingForAdmin === true
        state.adminApproved = v.adminApproved === true
        state.cooldownUntil = Number.isFinite(Number(v.cooldownUntil)) ? Number(v.cooldownUntil) : null
        return { ok: true, restored: true }
      }
      return { ok: true, restored: false }
    } catch (error) {
      log(`⚠️ [restart] ${id} 重启状态读不出来（按全新处理）：${error?.message ?? error}`)
      return { ok: false, why: String(error?.message ?? error) }
    }
  }

  function save() {
    if (!root) return { ok: false, why: '缺少 workspace' }
    try {
      const p = join(root, rel)
      mkdirSync(join(p, '..'), { recursive: true })
      const tmp = `${p}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify(state, null, 1)}\n`, 'utf8')
      renameSync(tmp, p)
      return { ok: true }
    } catch (error) {
      // 增强路径，但它影响"冷却会不会被绕过" ⇒ 必须喊
      log(`⚠️ [restart] ${id} 重启状态没写盘（冷却在重启后可能失效）：${error?.message ?? error}`)
      return { ok: false, why: String(error?.message ?? error) }
    }
  }

  /**
   * **能不能重启**（纯判断，不改状态）。
   *
   * ★ 判据顺序就是优先级：先"有没有资格"（归属），再"该不该"（事件类型/冷却/等指令）。
   *   顺序反了会出现"冷却过了但没有归属证据就去重启"这种荒唐结果。
   *
   * @param {object} o
   * @param {string} o.reason         事件类型（`down` 才允许；`anomaly` 永不）
   * @param {{owner?: 'bridge'|'external'|'unknown', pid?: number|null, startedAt?: number|null}} o.evidence
   * @param {object} [o.rules]        `{cooldownMs, maxAttempts}`
   * @returns {{ok: boolean, why: string, text?: string}}
   */
  function canRestart({ reason = 'down', evidence = {}, rules = {} } = {}) {
    const t = now()
    // ① 只有 `down` 允许重启（"TPS 低就重启"是赌博 —— 契约 §6.1）
    if (reason !== 'down') {
      return { ok: false, why: 'not-down', text: `只有"连不上"才允许重启（这次是 ${reason}）—— 指标异常重启一次是赌博。` }
    }
    // ② **归属证据**（最重要的一条）
    const owner = String(evidence.owner ?? 'unknown')
    if (owner !== 'bridge') {
      return {
        ok: false,
        why: owner === 'external' ? 'not-owner' : 'no-evidence',
        text:
          owner === 'external'
            ? '这个服务端**不是我拉起来的**（端口活着但归属不是本桥接实例）—— 按纪律不抢别人的服务端，只报告不重启。'
            : '没有"这个服务端是我拉起来的"的证据（缺 running.json 或 pid@启动时刻 对不上）—— 宁可不动，也不赌一把。',
      }
    }
    if (typeof launch !== 'function') {
      return { ok: false, why: 'no-launcher', text: '没有可用的启动方式（配置里缺 `restart.startCommand`）—— 我拉不起来它。' }
    }
    // ③ 累计尝试上限（**"试一次"的硬保证**）
    //
    // ★ 顺序刻意排在"等管理员指令"**之前**：两者都会拦住重启，但**说法完全不同** ——
    //   "次数用尽"是"我按纪律不再试了"，"在等你"是"我在等你回话"。
    //   反过来的话，"重试用尽"会被说成"在等你"（实测抓到的措辞错位）。
    const maxAttempts = Number.isFinite(Number(rules.maxAttempts)) ? Math.max(1, Number(rules.maxAttempts)) : 1
    if (state.attempts >= maxAttempts && !state.adminApproved) {
      return {
        ok: false,
        why: 'attempts-exhausted',
        text: `已经试过 ${state.attempts} 次（上限 ${maxAttempts}）—— **不再自动重启**，等你指令（\`retry\` 或 \`abandon\`）。`,
      }
    }
    // ④ 等管理员指令期间**不动**（"真的等"）
    if (state.waitingForAdmin && !state.adminApproved) {
      return { ok: false, why: 'waiting-admin', text: '上一次重启失败之后我在**等你的指令**（`retry` 或 `abandon`）—— 这期间不再自动重启。' }
    }
    // ⑤ 冷却
    const cooldownMs = Number.isFinite(Number(rules.cooldownMs)) ? Number(rules.cooldownMs) : DEFAULT_COOLDOWN_MS
    const until = Number(state.cooldownUntil)
    if (Number.isFinite(until) && until > t) {
      const leftMin = Math.ceil((until - t) / 60000)
      return {
        ok: false,
        why: 'cooldown',
        text: `在冷却窗口里（还有约 ${leftMin} 分钟）—— 重启成功后短时间又坏，说明自动重启救不了它。`,
      }
    }
    return { ok: true, why: '' }
  }

  /**
   * 跑一次重启编排。**永不抛**；返回结构化结论。
   *
   * 步骤（**顺序不能换**，每一步都可观测）：
   *   1. 连接还在 ⇒ 尝试优雅停服（`stop`）        ← 记 attempts+1（**落盘**）
   *   2. **等端口释放**（超时 ⇒ 转求助，**不强杀**）
   *   3. `launch()` 把服务端拉起来
   *   4. **等端口重新可连**（这才是"成功了"的判据）
   *
   * @param {object} o
   * @param {object} o.server     配置里那一台（要能拿到 host/port 与启动命令）
   * @param {string} [o.reason]
   * @param {object} [o.evidence]
   * @param {object} [o.rules]
   * @param {{stopWaitMs?: number, upWaitMs?: number, sleep?: Function}} [o.timing]
   *        ★ `sleep` 可以**按调用**覆盖构造期那个：接线测试要跑"等恢复失败"这条路径，
   *          而它要等满 `upWaitMs`（默认 3 分钟）—— 真等下来整条测试链就没法看了。
   */
  async function restart({ server = {}, reason = 'down', evidence = {}, rules = {}, timing = {} } = {}) {
    const nap = typeof timing.sleep === 'function' ? timing.sleep : sleep
    const allowed = canRestart({ reason, evidence, rules })
    if (!allowed.ok) {
      log(`[restart] ${id} 不重启：${allowed.text ?? allowed.why}`)
      return { ok: true, outcome: OUTCOME.SKIPPED, why: allowed.why, text: allowed.text ?? '' }
    }

    const stopWaitMs = Number.isFinite(Number(timing.stopWaitMs)) ? Number(timing.stopWaitMs) : DEFAULT_STOP_WAIT_MS
    const upWaitMs = Number.isFinite(Number(timing.upWaitMs)) ? Number(timing.upWaitMs) : DEFAULT_UP_WAIT_MS
    const host = String(server.host ?? '127.0.0.1')
    const gamePort = Number(server.port ?? 25565)

    // ── 记账：尝试次数**在动手之前**落盘（同定时任务"先认领再干活"的纪律）──
    state.attempts += 1
    state.lastAttemptAt = now()
    state.lastOutcome = 'running'
    state.lastDetail = ''
    // ★★ 这一次尝试是**真的在动** ⇒ 清掉"等指令"。
    //   不清的话：重试之后若又失败，状态会同时是"等指令"与"次数用尽"，
    //   而判据里"等指令"排在前面 ⇒ 说法错位（实测抓到）；更糟的是
    //   `waitingForAdmin` 会**粘住**，让后面的判断全部走错分支。
    state.waitingForAdmin = false
    state.adminApproved = false // 批准是一次性的
    save()
    log(`[restart] ${id} 开始第 ${state.attempts} 次重启尝试（reason=${reason}）`)

    // ── ① 优雅停服（连接还在时才有意义）──
    //
    // ★★ 安全闸（实测踩出来的）：**服务端已经崩了的时候 RCON 是连不上的**，
    //   于是我们**没有任何命令通道**去叫它停。此时"等端口释放"毫无意义
    //   （端口本来就不通），而如果它还偏偏通着（半死状态），干等 60 秒只会让
    //   "我准备重启"这句话迟到一分钟才说出口。
    //   ∴ 停服失败 ⇒ **跳过等待，直接进下一步**（端口通不通由下面的判据说话）。
    //   ⚠️ 这**没有**放宽"停完必须等端口释放"那条纪律：只要停服**成功**过，
    //      后面照样必须等到端口真的释放才允许起。
    let stopConfirmed = false
    if (typeof stopGracefully === 'function') {
      try {
        const r = await stopGracefully()
        stopConfirmed = Boolean(r?.ok)
        if (!stopConfirmed) {
          log(`[restart] ${id} 优雅停服没成功（${r?.why ?? '未知'}）—— 跳过"等端口释放"这一步（多半是它已经崩了，没有命令通道）`)
        }
      } catch (error) {
        log(`[restart] ${id} 优雅停服抛异常（跳过等待）：${error?.message ?? error}`)
      }
    } else {
      log(`[restart] ${id} 没有优雅停服方式（跳过等待）`)
    }

    // ── ② 等端口释放（**证明进程真的退出了**）──
    if (stopConfirmed) {
      const released = await waitFor(async () => !(await openProbe(host, gamePort, 1500)), stopWaitMs, nap)
      if (!released) {
        state.lastOutcome = OUTCOME.FAILED
        state.lastDetail = '停不下来：端口一直没释放'
        state.waitingForAdmin = true
        save()
        log(
          `❌ [restart] ${id} 端口在 ${Math.round(stopWaitMs / 1000)} 秒内一直没释放 ⇒ **不强杀**（强杀一个正在写世界的 JVM 就是存档损坏的成因）`,
        )
        return {
          ok: true,
          outcome: OUTCOME.FAILED,
          why: 'stop-timeout',
          text: `我叫它停，但它 ${Math.round(stopWaitMs / 1000)} 秒后还占着端口。**我没有强杀它**（强杀正在写世界的服务端会损坏存档）—— 需要你来看一眼。`,
        }
      }
    }

    // ── ③ 拉起来 ──
    let launched
    try {
      launched = await launch(server)
    } catch (error) {
      launched = { ok: false, why: `启动抛异常：${error?.message ?? error}` }
    }
    if (!launched?.ok) {
      state.lastOutcome = OUTCOME.FAILED
      state.lastDetail = `拉不起来：${launched?.why ?? '未知'}`
      state.waitingForAdmin = true
      save()
      log(`❌ [restart] ${id} 拉不起来：${launched?.why ?? '未知'}`)
      return { ok: true, outcome: OUTCOME.FAILED, why: 'launch-failed', text: `我试过重启，但**没能把它拉起来**：${launched?.why ?? '未知原因'}。等你指令。` }
    }

    // ── ④ 等恢复（**这才是"成功了"的判据**）──
    const up = await waitFor(async () => openProbe(host, gamePort, 1500), upWaitMs, nap)
    if (!up) {
      state.lastOutcome = OUTCOME.FAILED
      state.lastDetail = `起来了但端口在 ${Math.round(upWaitMs / 1000)} 秒内没恢复`
      state.waitingForAdmin = true
      save()
      log(`❌ [restart] ${id} 起来了但 ${Math.round(upWaitMs / 1000)} 秒内端口没恢复`)
      return {
        ok: true,
        outcome: OUTCOME.FAILED,
        why: 'up-timeout',
        text:
          `我重启了一次，但它在 ${Math.round(upWaitMs / 1000)} 秒内没有恢复（端口仍然连不上）。` +
          '**我不再自动重启了**，等你指令。',
      }
    }

    // ── 成功：设冷却（**防重启风暴的那一半**）+ **把尝试计数归零** ──
    //
    // ★★ 为什么成功要归零 `attempts`（这是个"定时炸弹"型的语义问题）：
    //   `attempts` 的语义是「**这一次故障**我试过几次」。若它只增不减，那么
    //   机器跑上几个月、偶尔重启过几次之后，累计值迟早撞上上限 ⇒
    //   **从此永远拒绝自动重启**，而原因（"已经试过 N 次"）与当时的故障毫无关系。
    //   归零之后："每次故障最多试一次"这条保证**仍然成立**，而且是它本来的意思。
    //   （历史仍然可查：`lastOutcome` / `lastDetail` / `lastAttemptAt` 都留着。）
    const cooldownMs = Number.isFinite(Number(rules.cooldownMs)) ? Number(rules.cooldownMs) : DEFAULT_COOLDOWN_MS
    state.lastOutcome = OUTCOME.RESTARTED
    state.lastDetail = `第 ${state.attempts} 次尝试成功`
    state.attempts = 0
    state.cooldownUntil = now() + cooldownMs
    state.waitingForAdmin = false
    save()
    log(`✅ [restart] ${id} 已恢复（第 ${state.attempts} 次尝试；冷却 ${Math.round(cooldownMs / 60000)} 分钟）`)
    return { ok: true, outcome: OUTCOME.RESTARTED, attempts: state.attempts, text: '' }
  }

  /**
   * 等一个异步谓词变真，超时返回 false。
   *
   * ★★ 为什么除了时间死线还要一个**迭代上限**（这是实测踩出来的）：
   *   死线靠 `now()` 推进。如果注入的时钟**不随 sleep 前进**（测试里很容易写成这样），
   *   死线永远到不了 ⇒ 这个循环变成**不流动时间的紧循环**：
   *   事件循环被占死、进程既不退出也不打印（表现为"测试挂住、超时被杀"）。
   *   ∴ 两条死线都要有：时间 **或** 迭代次数。
   * ★ `nap` 是**调用级**的 sleep（`restart({timing:{sleep}})` 能换掉它）——
   *   接线测试要跑"等恢复失败"这条路径，而它默认要等满 3 分钟，真等下来整条测试链没法看。
   */
  async function waitFor(predicate, timeoutMs, nap = sleep) {
    const deadline = now() + Math.max(0, timeoutMs)
    const maxIterations = 2000
    for (let i = 0; i < maxIterations; i += 1) {
      let ok = false
      try {
        ok = await predicate()
      } catch {
        ok = false
      }
      if (ok) return true
      if (now() >= deadline) return false
      await nap(Math.min(POLL_STEP_MS, Math.max(0, deadline - now())))
    }
    log(`⚠️ [restart] ${id} 等待循环到了迭代上限（${maxIterations}）—— 时钟可能没在前进，按超时处理`)
    return false
  }

  return {
    load,
    save,
    canRestart,
    restart,
    rel,
    serverId: id,
    state: () => JSON.parse(JSON.stringify(state)),
    /** 管理员说"再试一次"（**这是显式动作**，会清掉"等指令"并允许一次新尝试）。 */
    approveRetry() {
      state.adminApproved = true
      state.waitingForAdmin = false
      state.cooldownUntil = null
      // ★ **不清 `attempts`**：那是"我试过几次"的历史，清了就等于允许无限重试
      save()
      return { ok: true }
    },
    /** 管理员说"放弃"（不再自动动它，直到有人重新打开）。 */
    abandon() {
      state.waitingForAdmin = true
      state.adminApproved = false
      save()
      return { ok: true }
    },
  }
}
