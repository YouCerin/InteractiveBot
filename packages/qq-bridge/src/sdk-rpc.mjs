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

import { spawn } from 'node:child_process'
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

  get ready() {
    return this.#ready
  }

  get alive() {
    return this.#child !== null && this.#child.exitCode === null && !this.#closing
  }

  /** 订阅子进程的 stderr（日志）。返回取消订阅函数。 */
  onStderr(fn) {
    this.#stderrListeners.add(fn)
    return () => this.#stderrListeners.delete(fn)
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

  /** dispose 整棵运行时树并退出（官方 shutdown 语义）。 */
  async shutdown({ timeoutMs = 15_000 } = {}) {
    if (!this.#child || this.#child.exitCode !== null) return
    this.#closing = true
    try {
      await this.request('shutdown', {}, timeoutMs)
    } catch (error) {
      this.log(`[rpc] shutdown 未得到应答：${error.message}`)
    }
  }

  /** 强杀（兜底用）。 */
  kill() {
    if (this.#child && this.#child.exitCode === null) {
      this.#closing = true
      this.#child.kill()
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
