/**
 * 本地语料库：把每条消息落进 SQLite + **中文全文检索**（H7）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么要有它（现在只有"实时拉一次"，没有任何"搜过去"的能力）
 * ══════════════════════════════════════════════════════════════════════════
 * 现在要回看历史只有一条路：`qq_group_history` 调 OneBot 现拉 —— 拉一次算一次，
 * 不能检索、没有本地索引，而且协议端一重启/换实例就什么都没了。
 * 于是"我上次说的那个方案叫什么来着"这类问题，机器人**真的答不了**。
 *
 * 这一层提供的是**纯词法检索**（不做 embedding，零额外模型调用、零网络）：
 *   · FTS5 + `tokenize='trigram'` —— 中文子串匹配（不需要分词）；
 *   · ★ **trigram 对 1~2 个汉字几乎无效**（实测：`MATCH '茶姬'` 返回 0 条），
 *     所以短查询**自动走 LIKE 回退**（实测同一条数据 `LIKE '%茶姬%'` 命中）；
 *   · 结果自带 `[mid:<消息id>]`，与 H6 的 `[reply:<id>]` 标记**闭环** ——
 *     搜到的消息可以被真正引用。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 三条边界（**用户确认过的**，别放宽）
 * ══════════════════════════════════════════════════════════════════════════
 * ① **七类隐私不落库**：入库前过 `privacy.screenForStore()`，命中就**不写**，
 *    只往 `memory/privacy-audit.jsonl` 记**类别与长度**（绝不记原文）。
 *    这比"先存下来再删"强得多 —— 存过一次就已经在磁盘上了。
 * ② **30 天 TTL**：`--corpus --prune`（默认预演，`--apply` 才真删）。
 *    语料库是"最近聊过什么"的索引，不是归档；无上限增长迟早把工作区撑爆。
 * ③ **不存媒体本体**（也不存媒体路径）：只留一个"这条里有几张图"的计数。
 *    存路径更糟 —— `inbox/` 里的文件会被清理，留下的是一堆**指向空气的路径**。
 *
 * ⚠️ 它同样遵守"增强路径不许弄挂主流程"：**任何失败只记一行日志**，
 *    并且**必须留证据**（`AGENT.md` 第 9 条）。
 */

import { mkdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import { screenForStore, logPrivacyBlock } from './privacy.mjs'

/**
 * 同步 require（本模块是 ESM）。
 *
 * 为什么不用 `await import('node:sqlite')`：`record()` 在**每条消息**的同步路径上，
 * 变成 async 会把整条消息处理链染成异步（而它现在是同步的）。
 * 只有真要写库时才加载 —— 不启用这一层的部署完全不会碰到它（实验特性）。
 */
const nodeRequire = createRequire(import.meta.url)

/** 语料库文件（工作区相对路径）。放 `runtime/` —— 与操作日志、任务台账同级。 */
export const CORPUS_REL = 'runtime/corpus.sqlite'

/** 保留天数（用户确认的边界：30 天）。 */
export const CORPUS_TTL_DAYS = 30

/** 各种上限（都刻意留了余量，防一次畸形输入把库撑坏）。 */
export const CORPUS_LIMITS = {
  /** 查询串最长多少字（更长的直接截断 —— FTS 的长查询没有意义，只是慢）。 */
  query: 200,
  /** 单次返回条数上限 / 默认条数。 */
  limit: 100,
  defaultLimit: 8,
  /** 每条结果的预览字数（结果里带全文会让注入爆掉）。 */
  preview: 120,
  /** 单条入库内容上限（转发/长文会很长，超出截断并标注）。 */
  content: 4000,
}

/** 检索方式（结果里会如实标出来，便于排查"为什么这条没搜到"）。 */
export const SEARCH_MODE = { FTS: 'fts', LIKE: 'like' }

/** 中文字符计数（判断要不要走 LIKE 回退）。 */
export function countCjk(text) {
  return (String(text ?? '').match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) ?? []).length
}

/**
 * 屏蔽 `node:sqlite` 的 `ExperimentalWarning`。
 *
 * 为什么只屏蔽这一条：它每次进程启动都会打一行，而我们**每天要跑几十次 CLI**
 * （`--memory` / `--tasks` / `--corpus` …），一行已知无害的警告重复几十遍，
 * 只会训练人忽略输出。**其它警告一律照旧**（不许无差别 `process.on('warning')` 静音）。
 */
export function silenceSqliteWarning() {
  if (silenceSqliteWarning.done) return
  silenceSqliteWarning.done = true
  const original = process.emitWarning
  process.emitWarning = function patched(warning, ...rest) {
    const text = typeof warning === 'string' ? warning : String(warning?.message ?? '')
    if (text.includes('SQLite is an experimental feature')) return
    return original.call(process, warning, ...rest)
  }
}

/** 建表（**幂等**：开库时无条件跑一遍，与 hermes 的 init/rebuild 分离一致）。 */
function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT UNIQUE,
      chat_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      peer_id TEXT NOT NULL,
      user_id TEXT,
      sender_name TEXT,
      content TEXT NOT NULL,
      is_bot INTEGER NOT NULL DEFAULT 0,
      media_count INTEGER NOT NULL DEFAULT 0,
      at_targets TEXT,
      reply_to_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_chat_time ON messages(chat_key, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(created_at);
  `)
  // ★ FTS5 用**外部内容表**（`content=`）而不是再存一份正文：
  //   两份正文迟早不一致，而外部内容表的正文只有一个来源（messages.content）。
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
      USING fts5(content, tokenize='trigram', content='messages', content_rowid='id');
  `)
  // 触发器保持索引与正文同步（含删除 —— 只建插入触发器的话，prune 之后
  // FTS 里会留下一堆指向已删行的幽灵条目，搜索会返回"查到但读不出来"的结果）
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
    END;
  `)
}

/**
 * 造一个语料库句柄（**连接缓存在句柄里**，不是每次调用都开库）。
 *
 * @param {object} opts
 * @param {string} opts.workspace
 * @param {(m: string) => void} [opts.log]
 */
export function createCorpus({ workspace, log = () => {}, readOnly = false } = {}) {
  const root = String(workspace ?? '')
  const file = root ? join(root, CORPUS_REL) : null
  /** 建表只需成功一次（同一进程内不重复跑 DDL）。 */
  let schemaReady = false
  /** 打不开就记住，避免每条消息都重试 + 重复刷日志。 */
  let broken = false

  /** 本次操作里打开过的连接（操作结束统一关掉，见文件头"为什么不留长连接"）。 */
  const opened = []
  function releaseAll() {
    for (const db of opened.splice(0)) {
      try {
        db.close()
      } catch {
        /* 关不掉无所谓 */
      }
    }
  }

  function open() {
    if (!root || !file) return null
    if (broken) return null
    try {
      silenceSqliteWarning()
      const { DatabaseSync } = nodeRequire('node:sqlite')
      let db = null
      if (readOnly) {
        // 只读：**不建表、不写盘**。文件还不存在会抛 —— 那是"还没有语料库"，如实回报。
        db = new DatabaseSync(file, { readOnly: true })
      } else {
        mkdirSync(dirname(file), { recursive: true })
        db = new DatabaseSync(file)
        // WAL 与 NORMAL 都不是"图快不要数据"：WAL 仍然保证崩溃一致性，
        // 只是把 fsync 从"每次写入"降到"检查点"。语料库是**可重建的索引**
        // （不是账本、不是记忆），这个取舍是合适的。
        db.exec('PRAGMA journal_mode = WAL')
        db.exec('PRAGMA synchronous = NORMAL')
        // 桥接在写、MCP 工具在读 → 让 SQLite 自己等一会儿，而不是立刻 SQLITE_BUSY
        db.exec('PRAGMA busy_timeout = 2000')
        if (!schemaReady) {
          ensureSchema(db)
          schemaReady = true
        }
      }
      opened.push(db)
      return db
    } catch (error) {
      // ★ 只报一次，绝不反复刷屏（每来一条消息都会走到这里）
      broken = true
      log(`❌ [corpus] 语料库打不开（这一层停用，其它功能不受影响）：${error?.message ?? error}`)
      return null
    }
  }

  /**
   * 记一条消息。**幂等**：同一个 `message_id` 只写一次。
   *
   * @returns {{ok: boolean, skipped?: string, why?: string}}
   */
  function recordInner({
    kind,
    peerId,
    messageId = null,
    userId = null,
    senderName = null,
    text = '',
    isBot = false,
    mediaCount = 0,
    atTargets = null,
    replyToId = null,
    at = new Date(),
  } = {}) {
    const chatKey = `${kind}:${peerId}`
    let content = String(text ?? '').trim()
    if (!content) return { ok: false, skipped: 'empty' }
    if (content.length > CORPUS_LIMITS.content) {
      content = `${content.slice(0, CORPUS_LIMITS.content)}…（已截断，原文 ${content.length} 字）`
    }

    // ── 边界①：七类隐私**不落库**（在写之前拦，不是写完再删）──────────────
    const priv = screenForStore(content)
    if (!priv.ok) {
      logPrivacyBlock({
        workspace: root,
        side: 'corpus',
        categories: priv.categories ?? [],
        length: content.length,
        chatKey,
      })
      log(`[corpus] 一条消息含隐私（${(priv.categories ?? []).join('、')}）→ 未入库（只记类别与长度）`)
      return { ok: false, skipped: 'privacy' }
    }

    const d = open()
    if (!d) return { ok: false, why: '语料库不可用' }
    try {
      const stmt = d.prepare(
        `INSERT OR IGNORE INTO messages
           (message_id, chat_key, kind, peer_id, user_id, sender_name, content, is_bot, media_count, at_targets, reply_to_id, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      const r = stmt.run(
        messageId == null ? null : String(messageId),
        chatKey,
        String(kind),
        String(peerId),
        userId == null ? null : String(userId),
        senderName == null ? null : String(senderName).slice(0, 60),
        content,
        isBot ? 1 : 0,
        Math.max(0, Number(mediaCount) || 0),
        atTargets ? String(atTargets).slice(0, 200) : null,
        replyToId == null ? null : String(replyToId),
        at instanceof Date ? at.getTime() : Number(at) || Date.now(),
      )
      const changes = Number(r.changes ?? 0)
      return changes > 0 ? { ok: true } : { ok: true, skipped: 'duplicate' }
    } catch (error) {
      log(`❌ [corpus] 写入失败（这条不入库，其它功能不受影响）：${error?.message ?? error}`)
      return { ok: false, why: error?.message ?? String(error) }
    }
  }

  /**
   * 检索。
   *
   * 策略（**实测依据**见文件头）：
   *   ① 查询含 <3 个汉字 → 直接 LIKE（trigram 对这种长度几乎无效）
   *   ② 否则先 FTS MATCH（短语匹配，避免特殊字符把语法搞坏）
   *   ③ FTS 抛错或 0 命中且含中文 → LIKE 回退
   *
   * @returns {{ok: boolean, mode?: string, rows?: object[], why?: string}}
   */
  function searchInner({ query, chatKey = null, limit = CORPUS_LIMITS.defaultLimit } = {}) {
    const q = String(query ?? '').trim()
    if (!q) return { ok: true, rows: [], mode: null }
    const capped = q.slice(0, CORPUS_LIMITS.query)
    const max = Math.min(Math.max(1, Number(limit) || CORPUS_LIMITS.defaultLimit), CORPUS_LIMITS.limit)
    const d = open()
    if (!d) return { ok: false, why: '语料库不可用', rows: [] }

    const cjk = countCjk(capped)
    const preview = (s) =>
      String(s ?? '').length > CORPUS_LIMITS.preview
        ? `${String(s).slice(0, CORPUS_LIMITS.preview)}…`
        : String(s ?? '')
    const shape = (row) => ({
      messageId: row.message_id,
      chatKey: row.chat_key,
      userId: row.user_id,
      senderName: row.sender_name,
      isBot: Number(row.is_bot) === 1,
      createdAt: Number(row.created_at),
      preview: preview(row.content),
      atTargets: row.at_targets,
      replyToId: row.reply_to_id,
    })

    const likeQuery = `%${capped.replace(/[%_]/g, (m) => `\\${m}`)}%`
    const likeSql =
      `SELECT * FROM messages WHERE content LIKE ? ESCAPE '\\'` +
      (chatKey ? ' AND chat_key = ?' : '') +
      ' ORDER BY created_at DESC LIMIT ?'
    const runLike = () => {
      try {
        const args = chatKey ? [likeQuery, String(chatKey), max] : [likeQuery, max]
        return { ok: true, mode: SEARCH_MODE.LIKE, rows: d.prepare(likeSql).all(...args).map(shape) }
      } catch (error) {
        return { ok: false, why: error?.message ?? String(error), rows: [] }
      }
    }

    if (cjk > 0 && cjk < 3) return runLike() // ①

    const ftsSql =
      `SELECT m.*, bm25(messages_fts) AS score FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid` +
      ` WHERE messages_fts MATCH ?` +
      (chatKey ? ' AND m.chat_key = ?' : '') +
      ' ORDER BY score LIMIT ?'
    try {
      // 短语匹配：整串当一个短语（去掉引号，免得把 FTS 语法搞坏）
      const phrase = `"${capped.replace(/"/g, '')}"`
      const args = chatKey ? [phrase, String(chatKey), max] : [phrase, max]
      const rows = d.prepare(ftsSql).all(...args).map(shape)
      if (rows.length > 0) return { ok: true, mode: SEARCH_MODE.FTS, rows }
      // ③ FTS 0 命中且含中文 → LIKE 再试一次（trigram 的边界情况比想象的多）
      if (cjk > 0) return runLike()
      return { ok: true, mode: SEARCH_MODE.FTS, rows: [] }
    } catch {
      return runLike() // ② 语法/方言问题 → 回退，而不是让检索整个失败
    }
  }

  /** 统计（给 `--corpus` 与体检用）。 */
  function statsInner({ now = new Date() } = {}) {
    const d = open()
    if (!d) return { ok: false, why: '语料库不可用' }
    try {
      const total = d.prepare('SELECT COUNT(*) c FROM messages').get().c
      const bots = d.prepare('SELECT COUNT(*) c FROM messages WHERE is_bot = 1').get().c
      const oldest = d.prepare('SELECT MIN(created_at) t FROM messages').get().t
      const newest = d.prepare('SELECT MAX(created_at) t FROM messages').get().t
      const byChat = d
        .prepare('SELECT chat_key, COUNT(*) c FROM messages GROUP BY chat_key ORDER BY c DESC LIMIT 20')
        .all()
      const expireBefore = now.getTime() - CORPUS_TTL_DAYS * 86_400_000
      const expired = d.prepare('SELECT COUNT(*) c FROM messages WHERE created_at < ?').get(expireBefore).c
      let bytes = 0
      try {
        bytes = statSync(file).size
      } catch {
        /* 文件可能刚建 */
      }
      return {
        ok: true,
        file: CORPUS_REL,
        bytes,
        total: Number(total),
        botMessages: Number(bots),
        oldestAt: oldest ? Number(oldest) : null,
        newestAt: newest ? Number(newest) : null,
        byChat: byChat.map((r) => ({ chatKey: r.chat_key, count: Number(r.c) })),
        expired: Number(expired),
        ttlDays: CORPUS_TTL_DAYS,
      }
    } catch (error) {
      return { ok: false, why: error?.message ?? String(error) }
    }
  }

  /**
   * 按 TTL 清理。**默认预演**（`apply:false` 只算不删）—— 与 `--memory --compact` 同一条纪律：
   * 一次误删的代价远大于多打一个参数的不便。
   */
  function pruneInner({ days = CORPUS_TTL_DAYS, apply = false, now = new Date() } = {}) {
    const d = open()
    if (!d) return { ok: false, why: '语料库不可用' }
    const before = now.getTime() - Math.max(1, Number(days) || CORPUS_TTL_DAYS) * 86_400_000
    try {
      const doomed = d.prepare('SELECT COUNT(*) c FROM messages WHERE created_at < ?').get(before).c
      if (!apply || Number(doomed) === 0) {
        return { ok: true, days, apply, removed: 0, wouldRemove: Number(doomed), before }
      }
      d.prepare('DELETE FROM messages WHERE created_at < ?').run(before)
      // 顺手压一下索引（删除是靠触发器同步的，压完查询更快、文件更小）
      try {
        d.exec("INSERT INTO messages_fts(messages_fts) VALUES('optimize')")
      } catch {
        /* 压不动不影响正确性 */
      }
      return { ok: true, days, apply, removed: Number(doomed), wouldRemove: Number(doomed), before }
    } catch (error) {
      return { ok: false, why: error?.message ?? String(error) }
    }
  }

  /** 重建 FTS 索引（人工改过库、或怀疑索引与正文不一致时用）。 */
  function rebuildInner() {
    const d = open()
    if (!d) return { ok: false, why: '语料库不可用' }
    try {
      d.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')")
      return { ok: true }
    } catch (error) {
      return { ok: false, why: error?.message ?? String(error) }
    }
  }

  function close() {
    try {
      db?.close()
    } catch {
      /* 关不掉无所谓 */
    }
    db = null
  }

  // ★ 统一在这里**收尾关连接**：每个操作跑完（含抛异常）都关掉本次打开的连接。
  //   这样调用方不用记得关，也不会因为某条 return 路径漏关而留句柄
  //   （"留句柄"的代价实测过：临时目录删不掉、工作区迁移被挡住）。
  const wrap = (fn) => (...args) => {
    try {
      return fn(...args)
    } finally {
      releaseAll()
    }
  }

  /**
   * 按"**还没被计入记忆的消息**"取一段（给"立刻建档"那个按钮用）。
   *
   * ⚠️ 与 `searchInner` 的关键差别：这里返回的是**全文**（不是截断预览）——
   *    因为它的用途是把对话交给抽取模型，截断会把句子切断、让模型猜。
   *    所以有两条硬上限兜住体积（条数 + 单条字数），超出如实报出来。
   *
   * @param {object} opts
   * @param {string} opts.chatKey         会话（`group:` / `private:` 前缀）
   * @param {string} [opts.userId]        只看这个人的发言（个人档案用；不传=整段会话）
   * @param {number} [opts.afterId]       只取 id **大于**它的（游标 = 上次处理到哪条）
   * @param {number} [opts.limit]         最多几条（默认 60）
   * @param {number} [opts.maxChars]      单条正文上限（默认 500，超出截断并标记）
   * @param {boolean} [opts.latest]       true = 取**最近** N 条（不是从 `afterId` 往后最早的 N 条）；
   *   返回顺序仍是**由旧到新**。用途见 `bridge.mjs` 的「你被叫到之前群里刚说了什么」
   *   （机器人只被唤醒的那几条消息进模型，所以它对自己没参与的那段是瞎的）。
   * @returns {{ok: boolean, rows?: object[], why?: string, lastId?: number}}
   */
  function recentInner({ chatKey, userId = null, afterId = 0, limit = 60, maxChars = 500, latest = false } = {}) {
    const ck = String(chatKey ?? '').trim()
    if (!ck) return { ok: false, why: '必须指定会话（fail-closed）', rows: [] }
    const max = Math.min(Math.max(1, Number(limit) || 60), 200)
    const perChar = Math.min(Math.max(80, Number(maxChars) || 500), 4000)
    const d = open()
    if (!d) return { ok: false, why: '语料库不可用', rows: [] }
    try {
      const params = [ck]
      let sql
      if (latest) {
        // ★ `latest`：要**最近 N 条**（不是最早 N 条）—— 语义不同，`afterId` 表达不了它。
        //   用途是"你被叫到之前群里刚说了什么"（`bridge.mjs` 的最近上下文段）：
        //   靠 `afterId` 得先知道最大 id，而那正好是这里不掌握的东西。
        //   实现是 DESC 取 N 再翻回来 ⇒ 返回给调用方的仍是**由旧到新**。
        sql = 'SELECT * FROM messages WHERE chat_key = ?'
        if (userId) {
          sql += ' AND user_id = ?'
          params.push(String(userId))
        }
        sql += ' ORDER BY id DESC LIMIT ?'
        params.push(max)
      } else {
        params.push(Number(afterId) || 0)
        sql = 'SELECT * FROM messages WHERE chat_key = ? AND id > ?'
        if (userId) {
          sql += ' AND user_id = ?'
          params.push(String(userId))
        }
        sql += ' ORDER BY id ASC LIMIT ?'
        params.push(max)
      }
      const rows = d.prepare(sql).all(...params).map((row) => {
        const full = String(row.content ?? '')
        return {
          id: Number(row.id),
          messageId: row.message_id,
          chatKey: row.chat_key,
          userId: row.user_id,
          senderName: row.sender_name,
          isBot: Number(row.is_bot) === 1,
          createdAt: Number(row.created_at),
          text: full.length > perChar ? `${full.slice(0, perChar)}…（本条被截断）` : full,
          truncated: full.length > perChar,
        }
      })
      if (latest) rows.reverse() // 由旧到新（调用方不必猜顺序）
      return { ok: true, rows, lastId: rows.length ? rows[rows.length - 1].id : Number(afterId) || 0 }
    } catch (error) {
      return { ok: false, why: error?.message ?? String(error), rows: [] }
    }
  }

  return {
    record: wrap(recordInner),
    search: wrap(searchInner),
    recent: wrap(recentInner),
    stats: wrap(statsInner),
    prune: wrap(pruneInner),
    rebuild: wrap(rebuildInner),
    close: () => releaseAll(),
    file: CORPUS_REL,
    ready: () => {
      try {
        return Boolean(open())
      } finally {
        releaseAll()
      }
    },
  }
}

/**
 * 把检索结果渲染成给模型看的一段（**带 `[mid:]`**，与 `[reply:]` 闭环）。
 *
 * ⚠️ 措辞纪律：必须明说"只能引用上面出现过的 id" —— 否则模型会顺手编一个，
 *    而编出来的 id 在 H6 的校验里会被丢掉（正文照发，等于白写）。
 */
export function renderSearchResults({ rows = [], query = '', mode = null } = {}) {
  if (!rows.length) return ''
  const lines = [`【群聊/私聊历史检索】关键词「${String(query).slice(0, 40)}」命中 ${rows.length} 条（${mode ?? '?'}）：`]
  for (const r of rows) {
    const when = new Date(r.createdAt).toLocaleString('zh-CN', { hour12: false })
    const who = r.isBot ? '你' : r.senderName || r.userId || '某人'
    lines.push(`[mid:${r.messageId ?? '?'}] ${when} ${who}：${r.preview}`)
  }
  lines.push('（想引用上面某条，就在回复里写 `[reply:<那条的 mid 数字>]`；**只能引用上面出现过的 id**，编的不会生效。）')
  return lines.join('\n')
}
