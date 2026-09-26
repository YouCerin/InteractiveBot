/**
 * 与 `dsh --profile sdk` 子进程通信的 JSON-RPC 客户端。
 *
 * ── 这一层在干什么（打比方）────────────────────────────────────────────
 * 想象你给一个在隔壁房间的助手递纸条。规矩是：
 *   · 一张纸条 = 一行 JSON（这叫 JSONL，JSON Lines）
 *   · 你写的纸条带一个编号，助手回的纸条也带同一个编号
 *   · 助手主动告诉你的事（不回应任何纸条）叫「通知」
 * 这个文件就是「写纸条 / 读纸条 / 按编号配对」的全部逻辑。
 *
 * ── 协议事实（已取证，不是猜的）───────────────────────────────────────
 * 来源：@deepseek-ai/dsh-sdk-jsonrpc-server@0.1.5-rc.2
 *   case "initialize":     ...
 *   case "session/prompt": ...
 *   case "shutdown":       ...
 * 服务端 → 客户端的通知：session.event / session.status /
 *                        subagent.started / subagent.finished
 *
 * ── 一条重要纪律 ───────────────────────────────────────────────────────
 * sdk 进程的 stdout **只允许跑协议帧**（官方原话 "Stdout is reserved for
 * protocol frames"）。所以任何日志都必须走 stderr，否则会把协议流冲坏。
 * 本文件把 stderr 当作日志源原样转发，绝不往 stdout 写东西。
 */

import { spawn, spawnSync } from 'node:child_process'
import { resolveModelCredentials } from './credentials.mjs'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'

/** 官方文档里逐字出现的服务名与版本；用于确认对面真的在说话。 */
export const SERVER_NAME = 'deepseek-harness-sdk-runtime'

/**
 * ★ 这里**刻意没有**"默认 CLI 路径"这个常量。
 *
 * 以前写的是一个绝对的桌面版安装路径（`D:\DeepSeekHarness\…\dsh\lib\bin.js`），
 * 那是开发机上的位置：对任何别的机器都无意义，而且会掩盖"根本没找到 DSH"这个事实 ——
 * 报错变成"找不到 dsh CLI：D:\…"（用户会以为自己该去建这个目录），
 * 而不是"没找到 DSH，请安装或用 dsh.searchPaths / DSH_DESKTOP_APP 指定"。
 *
 * 现在唯一入口是 `config.dsh.cliPath`（由 normalizeConfig 解析：
 * 显式配置 → findDshCli 的候选表）。`SdkRpcClient` 拿不到就直接报错，不兜底。
 */
export class SdkRpcError extends Error {
  constructor(message, { code = null, data = null, method = null } = {}) {
    super(message)
    this.name = 'SdkRpcError'
    this.code = code
    this.data = data
    this.method = method
  }
}

/**
 * 长驻的 SDK RPC 连接。
 *
 * 为什么不做成「每次提问起一个进程」？因为会话（上下文）长在进程里。
 * 进程一关，机器人就失忆了。所以这里刻意做成**长驻**。
 */
export class SdkRpcClient extends EventTarget {
  #child = null
  #rl = null
  #pending = new Map() // rpcId -> { resolve, reject, method, timer }
  #nextId = 0
  #closing = false
  #ready = false
  #buffer = ''

  /** @type {Set<(line: string) => void>} */
  #stderrListeners = new Set()

  constructor({ cliPath, cwd, env = {}, log = () => {}, provider, model, reasoningEffort, apiKey } = {}) {
    super()
    this.cliPath = cliPath ?? null
    this.cwd = cwd
    this.env = env
    this.log = log
    // 模型目标由 initialize 使用（initialize 之后改无效：官方模型选择是
    // 每回合从会话日志的 model/selection 事件解析的）。
    this.provider = provider
    this.model = model
    this.reasoningEffort = reasoningEffort
    // 用户在 config.json / 界面里填的 API key（可选）。留空则由 environment /
    // $DSH_HOME/.credentials.yaml 兜底 —— 优先级见 src/credentials.mjs。
    this.apiKey = apiKey
  }

  /**
   * 子进程是否**已经终止**（无论正常退出还是被信号杀死）。
   *
   * ══════════════════════════════════════════════════════════════════════════
   * ★ 为什么必须同时看 exitCode 与 signalCode（这是一个真实 bug）
   * ══════════════════════════════════════════════════════════════════════════
   * 被信号杀死的进程，`exitCode` 永远是 **null**，只有 `signalCode` 有值。
   * 而 `kill()` 走的正是"发信号"这条路 —— 所以只看 `exitCode` 会把
   * **已经死掉的子进程判定成还活着**，后果是：
   *   · `kill()` 白等一轮再上 taskkill，最后可能**误报"未能确认退出"**；
   *   · `shutdown()` 对着尸体发请求，超时后才说"对面不理我"；
   *   · `alive` 永远是 true。
   * 这个 bug 是行为测试抓出来的（`signalCode=SIGTERM` 而 `exitCode=null`），
   * 静态断言完全看不见它。
   */
  #hasTerminated() {
    if (!this.#child) return true
    return this.#child.exitCode !== null || this.#child.signalCode !== null
  }

  get ready() {
    return this.#ready
  }

  get alive() {
    return this.#child !== null && !this.#hasTerminated() && !this.#closing
  }

  /** 订阅子进程的 stderr（日志）。返回取消订阅函数。 */
  onStderr(fn) {
    this.#stderrListeners.add(fn)
    return () => this.#stderrListeners.delete(fn)
  }

  /**
   * **诊断用**：把内部生命周期状态露出来（只读）。
   *
   * 为什么需要：`kill()` / `shutdown()` 的判定依赖"子进程是否已退出"与"是否已在关闭中"，
   * 而这些状态在测试里从外面看不见 —— 出问题时只能靠猜（本次就卡在这里很久）。
   * 露出来之后，`--doctor` 与测试都能直接断言状态，而不是靠推理。
   */
  lifecycleState() {
    return {
      hasChild: this.#child !== null,
      pid: this.#child?.pid ?? null,
      exitCode: this.#child?.exitCode ?? null,
      signalCode: this.#child?.signalCode ?? null,
      closing: this.#closing,
      ready: this.#ready,
      pending: this.#pending.size,
    }
  }

  /**
   * **测试专用**：把一个已经在跑的子进程接管进来，跳过 `start()` / `initialize`。
   *
   * 为什么需要它：`kill()` 里"等确认 + 超时 taskkill 强杀"这条防线
   * 恰恰是"退不掉"事故的根治点，必须有**行为测试**盯着它。
   * 而正常路径要起真的 DSH（慢、依赖环境、还可能被沙箱拦），
   * 所以给测试一个注入点：塞一个"什么协议都不懂、只会占着不退出"的哑进程进来，
   * 就能验证"杀得掉"和"杀不掉时如实报告"这两条。
   *
   * ⚠️ 产品代码永远不该调用它。
   */
  attachExistingChild(child) {
    this.#child = child
    return this
  }

  /**
   * 启动子进程。
   *
   * @param {{ timeoutMs?: number, permissionMode?: string }} [opts]
   *   permissionMode 通过环境变量 DSH_PERMISSION_MODE 传给 dsh-base。
   *   取证：dsh-base/cordis.patch.yml
   *     mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'
   *     policy: !!js (... === 'danger-full-access' ? 'never' : 'ask')
   *   也就是说：workspace-write 这一档自带 ask（需要审批），而 sdk profile
   *   里没有人能应答审批 → 越界操作会自动落 'unavailable'（被拒绝），
   *   且不会把对话卡死。这正是我们要的"权限只限工作区"。
   */
  async start({ timeoutMs = 60_000, permissionMode = 'workspace-write' } = {}) {
    if (this.#child) throw new Error('SdkRpcClient.start() 被调用了两次')
    // 找不到入口时给出**可操作**的错误，而不是一个绝对路径（那是哪台机器的路径都没意义）。
    if (!this.cliPath) {
      throw new Error(
        '没找到 DSH（DeepSeek Harness）。它是运行环境，本包不随包分发，需要你自己安装。\n' +
          '  任选一种方式指定它：\n' +
          '    ① 装好 DSH 桌面版后重跑（会自动在常见安装位置找到）；\n' +
          '    ② 设环境变量 DSH_DESKTOP_APP 指向它的安装根；\n' +
          '    ③ 在 config.json 里填 dsh.cliPath 或 dsh.searchPaths。\n' +
          '  跑 `start.bat --check` 可以看到所有候选位置。',
      )
    }
    if (!existsSync(this.cliPath)) {
      throw new Error(
        `找不到 dsh CLI：${this.cliPath}\n` +
          '  这个路径是配置指定的，但它不存在。请检查 config.json 的 dsh.cliPath，' +
          '或删掉它改用自动查找（见 dsh.searchPaths / 环境变量 DSH_DESKTOP_APP）。',
      )
    }

    // 只用显式传入的 cwd；不做兜底，因为 workspace-write 的沙箱根就是它，
    // 一旦兜底成 process.cwd() 就可能把整个磁盘变成可写区。
    if (!this.cwd) throw new Error('必须显式指定 cwd（它是 workspace 沙箱的根）')

    // ★ 注入模型凭据 —— 不加这段，DSH 子进程会因为 MISSING_CREDENTIAL
    //   让每一次模型调用立刻失败，表现为"机器人完全不输出内容"（详见 credentials.mjs）。
    //
    // 为什么必须由桥接注入：桌面版把 DSH 跑在能读凭据的进程里，而这里起的是
    // 普通 node 子进程 —— 环境变量里没有 key，SDK 那条路径也不会去读凭据文件。
    //
    // 值**只进子进程环境**，不写日志、不进接口响应。
    const env = {
      ...process.env,
      ...this.env,
      ...resolveModelCredentials({
        dshHome: process.env.DSH_HOME,
        env: process.env,
        apiKey: this.apiKey,
      }).env,
      DSH_PERMISSION_MODE: permissionMode,
    }

    this.#child = spawn(process.execPath, [this.cliPath, '--profile', 'sdk'], {
      cwd: this.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    this.#child.stdout.setEncoding('utf8')
    this.#child.stderr.setEncoding('utf8')

    // 用 readline 按行切分 stdout —— 协议是「一行一个 JSON」，
    // 自己用 indexOf('\n') 拼缓冲也能做，但 readline 更不容易在
    // 半行 / \r\n / 大块到达的边界上出错。
    this.#rl = createInterface({ input: this.#child.stdout, crlfDelay: Infinity })
    this.#rl.on('line', (line) => this.#handleLine(line))

    this.#child.stderr.on('data', (chunk) => {
      for (const text of String(chunk).split(/\r?\n/)) {
        if (!text.trim()) continue
        for (const fn of this.#stderrListeners) {
          try {
            fn(text)
          } catch {
            /* 订阅者自己出错不该影响协议流 */
          }
        }
      }
    })

    this.#child.on('exit', (code, signal) => {
      this.#ready = false
      this.log(`[rpc] sdk 子进程退出 code=${code} signal=${signal ?? '-'}`)
      this.#failAllPending(
        new SdkRpcError(`sdk 子进程已退出（code=${code}, signal=${signal ?? '-'})`),
      )
      this.dispatchEvent(new CustomEvent('exit', { detail: { code, signal } }))
    })

    this.#child.on('error', (error) => {
      this.#ready = false
      this.log(`[rpc] sdk 子进程启动失败：${error.message}`)
      this.#failAllPending(new SdkRpcError(`sdk 子进程启动失败：${error.message}`))
      this.dispatchEvent(new CustomEvent('error', { detail: { error } }))
    })

    // initialize 的参数在服务端被逐个校验：
    //   index.js:113  const cwd = resolve(params.cwd)
    //   index.js:111  reasoningEffort 必须是非空字符串或 undefined
    //   index.js:112  maxTokens 必须是正安全整数或 undefined
    // 因此这里只放确定合法的字段，别塞多余的东西。
    const init = await this.request('initialize', {
      cwd: this.cwd,
      provider: this.provider,
      model: this.model,
      ...(this.reasoningEffort ? { reasoningEffort: this.reasoningEffort } : {}),
    }, timeoutMs)

    this.#ready = true
    this.log(
      `[rpc] initialize 成功：${init?.serverInfo?.name ?? '?'} v${init?.serverInfo?.version ?? '?'}`,
    )
    return init
  }

  /** 记下默认模型目标；由 initialize 使用。 */
  setModelTarget({ provider, model, reasoningEffort } = {}) {
    if (provider) this.provider = provider
    if (model) this.model = model
    if (reasoningEffort !== undefined) this.reasoningEffort = reasoningEffort
  }

  #handleLine(line) {
    const text = line.trim()
    if (!text) return

    let msg
    try {
      msg = JSON.parse(text)
    } catch {
      // 不是合法 JSON：说明 stdout 被别的东西污染了（例如某个依赖 print 了
      // 调试信息）。这类问题必须显式暴露，不能吞掉。
      this.log(`[rpc] ⚠️ stdout 出现非 JSON 内容（协议流可能被污染）：${text.slice(0, 200)}`)
      return
    }

    // ① 应答：带 id，且我们在等它
    if (msg.id !== undefined && this.#pending.has(msg.id)) {
      const entry = this.#pending.get(msg.id)
      this.#pending.delete(msg.id)
      clearTimeout(entry.timer)
      if (msg.error) {
        entry.reject(
          new SdkRpcError(
            `RPC ${entry.method} 失败：${msg.error.message ?? JSON.stringify(msg.error)}`,
            { code: msg.error.code ?? null, data: msg.error.data ?? null, method: entry.method },
          ),
        )
      } else {
        entry.resolve(msg.result)
      }
      return
    }

    // ② 通知：没有 id，有 method
    if (msg.method) {
      this.dispatchEvent(
        new CustomEvent('notification', {
          detail: { method: msg.method, params: msg.params ?? {} },
        }),
      )
      return
    }

    this.log(`[rpc] 收到无法归类的帧：${text.slice(0, 200)}`)
  }

  /**
   * 发一个请求并等应答。
   *
   * @param {string} method
   * @param {object} params
   * @param {number} [timeoutMs] 默认 0 = 不超时（长回合可能跑很久）
   */
  request(method, params = {}, timeoutMs = 0) {
    if (this.#closing) {
      return Promise.reject(new SdkRpcError('连接正在关闭', { method }))
    }
    if (!this.#child || !this.#child.stdin.writable) {
      return Promise.reject(new SdkRpcError('sdk 子进程不可写（未启动或已退出）', { method }))
    }

    const id = ++this.#nextId
    return new Promise((resolve, reject) => {
      let timer = null
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.#pending.delete(id)
          reject(new SdkRpcError(`RPC ${method} 超时（${timeoutMs}ms）`, { method }))
        }, timeoutMs)
        // Node 不会因为一个 pending 的 setTimeout 就保持进程活着吗？会。
        // 但这是长驻进程，无所谓；显式 unref 反而可能在退出时丢应答。
      }
      this.#pending.set(id, { resolve, reject, method, timer })

      const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params })
      this.#child.stdin.write(frame + '\n', (error) => {
        if (!error) return
        this.#pending.delete(id)
        if (timer) clearTimeout(timer)
        reject(new SdkRpcError(`写入 sdk stdin 失败：${error.message}`, { method }))
      })
    })
  }

  /**
   * 投递一条用户消息。
   *
   * 取证：index.js:143-155
   *   async prompt(params) {
   *     const rec = await this.getOrCreateSession(params.sessionId);
   *     const content = await durablePromptContent(this.ctx, params.contentBlocks);
   *     rec.handle.agent.followup(message);
   *     return { messageId: message.id };
   *   }
   * → sessionId **由我们指定**，首次出现即按需创建。这一点很关键：
   *   它让我们可以直接用 «QQ 会话键» 当 sessionId（见 session-id.js）。
   */
  prompt(sessionId, contentBlocks, { timeoutMs = 20_000 } = {}) {
    if (!Array.isArray(contentBlocks) || contentBlocks.length === 0) {
      return Promise.reject(new SdkRpcError('contentBlocks 不能为空'))
    }
    return this.request('session/prompt', { sessionId, contentBlocks }, timeoutMs)
  }

  /**
   * 优雅关停：请 DSH 自己 dispose 整棵运行时树。
   *
   * ★ 自带**硬截止**。这不是保险丝，是必须的：`request()` 万一因为协议流半死不活
   *   而永远拿不到应答，调用方就会被无限拖住 —— 而调用方是 `shutdown()`，
   *   它被拖住意味着**进程退不掉**，正是"上一个进程卡住关不掉"的成因之一。
   *   超时后**不抛异常**：这只是"优雅"的方式没成功，上层还有强杀兜底。
   *
   * @returns {Promise<{graceful: boolean, timedOut?: boolean, error?: string}>}
   */
  async shutdown({ timeoutMs = 15_000 } = {}) {
    // 判据只有一条：**子进程还在不在**。已经退出的（含被信号杀死的），没什么可关的。
    if (this.#hasTerminated()) {
      return { graceful: true, alreadyGone: true }
    }

    // ★★ 这里**不能**事先把 `#closing` 置真 —— 踩过这个坑，值得写清楚。
    //
    //   `#closing` 的语义是"**准备强杀，别再发请求了**"（`kill()` 才该置它）。
    //   而"优雅关停"恰恰**必须**发一个请求（`shutdown`）。第一版在发请求前就置了它，
    //   于是 `request()` 一进来就判"连接正在关闭"并立刻拒绝 —— 表现是
    //   `shutdown()` **0ms 返回**、还被误报成"等超时了"，把"根本没发出去"
    //   伪装成"对面不理我"，两者排查方向完全不同。
    //   所以：优雅关停期间 `#closing` 保持原样；只有确认要走强杀时才置位。
    const wasClosing = this.#closing

    let timer = null
    let timeoutReason = null
    try {
      await Promise.race([
        this.request('shutdown', {}, timeoutMs),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            timeoutReason = `等 DSH 应答 shutdown 超过 ${Math.round(timeoutMs / 1000)} 秒`
            reject(new Error(timeoutReason))
          }, timeoutMs)
        }),
      ])
      // 优雅关停已经发出去了，之后不该再接受新请求
      this.#closing = true
      return { graceful: true }
    } catch (error) {
      this.log(`[rpc] shutdown 未能优雅完成：${error.message}（将由强杀兜底）`)
      // ★ "是不是等超时了"要按**错误来源**判定，不能只看我们自己的那个定时器：
      //   `request()` 自己也有超时，而且当它先到点时抛的是
      //   `RPC shutdown 超时（600ms）` —— 我们的定时器还没轮到触发。
      //   第一版只看自己的定时器，于是把这种超时说成 reason:'error'，
      //   把"对面不理我"和"协议坏了"混成一种，给了错误线索。
      const isTimeout = Boolean(timeoutReason) || /超时|timeout/i.test(String(error?.message ?? ''))
      return {
        graceful: false,
        timedOut: isTimeout,
        reason: wasClosing ? 'already-closing' : isTimeout ? 'timeout' : 'error',
        error: error.message,
      }
    } finally {
      // ★ 必须清掉：这个 timer 若留着，会通过事件循环把进程的退出**拖住**
      //   （Node 里一个 pending 的 timer 就是一条 keep-alive 引用）。
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * 强杀兜底：**必须等它真的死了才返回**。
   *
   * ══════════════════════════════════════════════════════════════════════════
   * 为什么不能只写 `this.#child.kill()` 就完事（这里踩过坑）
   * ══════════════════════════════════════════════════════════════════════════
   * 原实现是"发一个 kill 就返回"，调用方紧接着 `process.exit(0)`。问题是：
   *
   *   · Windows 上子进程若卡在文件句柄 / sandbox 驱动 / sqlite 写锁里，
   *     `kill()`（TerminateProcess）可能**迟迟不生效甚至失败**；
   *   · 而桥接自己已经退出了 → 那个 DSH 成了**孤儿**，继续持有工作区与会话库；
   *   · 下一次启动的新桥接再起一个 DSH 指着同一份工作区 —— 两个 agent 写同一份
   *     状态，症状是回复错乱 / 文件写冲突，而日志里**没有任何线索**指向"有两个 DSH"。
   *
   * 所以这里：先发 kill → 等 `exit`（最多 `graceMs`）→ 还没走就用 `taskkill /T /F`
   * 连整棵进程树一起杀 → 再等一小段确认 → **如实报告死没死**。
   * `/T` 是必须的：DSH 自己还会派生 subagent 子进程，只杀父进程会留下一串孤儿。
   *
   * @returns {Promise<{stopped: boolean, method?: string, pid?: number, error?: string}>}
   */
  async kill({ graceMs = 3000, confirmMs = 2000 } = {}) {
    const child = this.#child
    // ★ 先判"本来就不需要杀"：**绝不能**给这种情况打上 `#closing`。
    //   注意用 #hasTerminated()（同时看 signalCode）—— 只看 exitCode 会把
    //   被信号杀死的进程当成活的，于是对它白等一轮再 taskkill。
    if (this.#hasTerminated()) return { stopped: true, alreadyGone: true }
    this.#closing = true
    const pid = child.pid

    // 注意：被信号杀死时 **exitCode 是 null、只有 signalCode**，
    // 所以这里两个都要看（见 #hasTerminated 的说明）。
    const isDead = () => child.exitCode !== null || child.signalCode !== null

    /** 等子进程真的退出（用 exit 事件 + 状态双判，避免事件已错过）。 */
    const waitExit = (ms) =>
      new Promise((resolve) => {
        if (isDead()) return resolve(true)
        let timer = null
        const done = (ok) => {
          if (timer) clearTimeout(timer)
          child.off('exit', onExit)
          resolve(ok)
        }
        const onExit = () => done(true)
        child.once('exit', onExit)
        timer = setTimeout(() => done(isDead()), ms)
      })

    // ① 先礼：普通 kill
    try {
      child.kill()
    } catch (error) {
      this.log(`[rpc] kill() 抛错：${error.message}`)
    }
    if (await waitExit(graceMs)) return { stopped: true, method: 'kill', pid }

    // ② 后兵：整棵进程树强杀（仅 Windows；其他平台再试一次普通 kill）
    this.log(`[rpc] 子进程 pid ${pid} 在 ${graceMs}ms 内没退出，改用强制终止`)
    let method = 'kill-retry'
    if (process.platform === 'win32' && pid) {
      method = 'taskkill /T /F'
      try {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
          timeout: confirmMs + 2000,
        })
      } catch (error) {
        this.log(`[rpc] taskkill 调用失败：${error.message}`)
      }
    } else {
      try {
        child.kill('SIGKILL')
      } catch {
        /* 已经死了就算了 */
      }
    }

    // ③ 如实报告：**不要假定它死了**。上层要据此决定是否报警。
    const stopped = await waitExit(confirmMs)
    if (stopped) return { stopped: true, method, pid }
    return {
      stopped: false,
      method,
      pid,
      error: `pid ${pid} 在强制终止后仍未确认退出（可能卡在内核态）。工作区可能仍被占用。`,
    }
  }

  #failAllPending(error) {
    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.#pending.clear()
  }
}
