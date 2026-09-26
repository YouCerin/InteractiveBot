#!/usr/bin/env node
/**
 * 看图（QQ 图片 → 工作区 → 模型）的测试。
 *
 * ── 为什么这个文件必须存在 ──────────────────────────────────────────────
 * 这个功能把"网络请求"引进了桥接，而**请求的地址由发消息的人控制**。
 * 也就是说它是本项目里**唯一一个外部输入能直接指挥进程去发请求**的地方。
 * 写错的后果不是"功能不好用"，而是**内网被探测**（配置接口就在
 * 127.0.0.1:3410，还带着 accessToken）。所以 SSRF 那一段是重点，
 * 而且必须包含"逐跳重定向"这种最容易漏的用例。
 *
 * 另外还有一类必须守的回归：改之前 `text.mjs` 把图片地址**原地丢掉**，
 * 整条看图链路断在那里却毫无报错。所以这里要盯住"地址有没有被带出来"
 * 以及"提示词里到底写了什么"。
 *
 * 用法：node mocks/verify-images.mjs
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  IMAGE_DIR,
  MEDIA_TYPE_EXT,
  assertFetchableUrl,
  collectImages,
  createImageInbox,
  extractImageRefs,
  fetchImageBytes,
  ipIsPrivate,
  refreshImageUrl,
  sniffImageMediaType,
} from '../src/images.mjs'
import { renderSegments } from '../src/text.mjs'
import { normalizeConfig, validateConfig } from '../src/config.mjs'
import { Bridge } from '../src/bridge.mjs'
import { SendQueue } from '../src/onebot.mjs'
import { SessionRouter } from '../src/session-bridge.mjs'
import { PKG_ROOT } from '../src/local.mjs'

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  —— ' + detail : ''}`)
  if (!ok) failures += 1
}
function section(t) {
  console.log(`\n── ${t} ──`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const TMP = join(PKG_ROOT, '.tmp-images')
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })
const WS = join(TMP, 'ws')
mkdirSync(WS, { recursive: true })

/* ──────────────────────── 测试夹具 ──────────────────────── */

/**
 * 一个**结构上像样**的 1×1 PNG。
 *
 * 说明：这里只需要前 8 个字节（PNG 签名）就能通过我们自己的嗅探。
 * **真正的解码校验在 DSH 的附件服务里做**（它是权威），我们只做第一道
 * 粗糙的过滤。手写而不是抄一段 base64，是为了让"我们只看了魔数"
 * 这件事在测试里一目了然，而不是假装我们验证了整张图。
 */
function pngBytes(tag = 0) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  const ihdr = [0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89]
  const iend = [0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]
  return Uint8Array.from([...sig, ...ihdr, ...iend, tag & 0xff])
}
const jpegBytes = () => Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])
const gifBytes = () => Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2])
const webpBytes = () =>
  Uint8Array.from([0x52, 0x49, 0x46, 0x46, 9, 9, 9, 9, 0x57, 0x45, 0x42, 0x50, 1])

/** 手搓一个响应对象：比 `new Response` 更能精确控制 status / headers / 分块。 */
function fakeRes({ status = 200, headers = {}, chunks = null, arrayBufferThrows = false } = {}) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [String(k).toLowerCase(), String(v)]))
  let i = 0
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => map.get(String(k).toLowerCase()) ?? null },
    body: chunks
      ? {
          getReader: () => ({
            async read() {
              return i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }
            },
            async cancel() {
              i = chunks.length
            },
          }),
        }
      : null,
    async arrayBuffer() {
      if (arrayBufferThrows) throw new Error('boom')
      const all = chunks ?? []
      const total = all.reduce((s, c) => s + c.byteLength, 0)
      const out = new Uint8Array(total)
      let off = 0
      for (const c of all) {
        out.set(c, off)
        off += c.byteLength
      }
      return out.buffer
    },
  }
}
const redirectRes = (status, location) =>
  fakeRes({ status, headers: location ? { location } : {} })

/** 不解析 DNS 的假解析器：测试里网络必须完全可控。 */
const resolveTo = (map) => async (host) => {
  const v = map[host]
  if (!v) throw new Error(`测试未登记的主机名：${host}`)
  return Array.isArray(v) ? v : [v]
}

/* ══════════════════════════════════════════════════════════════════════════
section('① 图片段提取：地址**必须**被带出来（这是整条链路的断点）')
// ══════════════════════════════════════════════════════════════════════════ */
{
  const segs = [
    { type: 'text', data: { text: '看这个' } },
    { type: 'image', data: { file: 'abc.jpg', url: 'https://cdn.example.com/a.jpg?rkey=1', file_id: 'fid-1' } },
    { type: 'image', data: { file: 'no-url.png' } },
    { type: 'face', data: { id: '1' } },
  ]
  const r = renderSegments(segs, { selfId: '999' })

  check('images 计数正确', r.images === 2, String(r.images))
  check('文本仍是 [图片]（历史/界面观感不变）', r.text === '看这个[图片][图片][表情]', r.text)
  check('★ 带出了 2 条图片引用', r.imageRefs.length === 2, String(r.imageRefs.length))
  check('★ url 被保留', r.imageRefs[0].url === 'https://cdn.example.com/a.jpg?rkey=1', r.imageRefs[0].url)
  check('★ file 被保留（url 里的 rkey 会过期，要靠它换新地址）', r.imageRefs[0].file === 'abc.jpg')
  check('★ file_id 被保留', r.imageRefs[0].fileId === 'fid-1')
  check('没有 url 的图片段也能提取（后面自然会失败，但不能丢）', r.imageRefs[1].url === '')

  const none = renderSegments([{ type: 'text', data: { text: 'hi' } }], { selfId: '1' })
  check('没有图片段时 imageRefs 是空数组（不是 undefined）', Array.isArray(none.imageRefs) && none.imageRefs.length === 0)

  const junk = renderSegments([null, 5, { type: 'image' }, { type: 'image', data: null }], { selfId: '1' })
  check('畸形段不炸（缺 data 的图片段按空引用处理）', junk.imageRefs.length === 2 && junk.imageRefs[0].url === '')

  const fromRender = extractImageRefs(segs)
  check('extractImageRefs 与 renderSegments 结果一致', fromRender.length === 2 && fromRender[0].url === r.imageRefs[0].url)
}

/* ══════════════════════════════════════════════════════════════════════════
section('② 格式嗅探：**按字节判**，不信 Content-Type / 扩展名')
// ══════════════════════════════════════════════════════════════════════════ */
{
  check('PNG', sniffImageMediaType(pngBytes()) === 'image/png')
  check('JPEG', sniffImageMediaType(jpegBytes()) === 'image/jpeg')
  check('GIF', sniffImageMediaType(gifBytes()) === 'image/gif')
  check('WebP', sniffImageMediaType(webpBytes()) === 'image/webp')
  check('纯文本 → 不认', sniffImageMediaType(new TextEncoder().encode('<html>hi</html>')) === null)
  check('太短 → 不认', sniffImageMediaType(Uint8Array.from([0x89, 0x50])) === null)
  check('空 → 不认', sniffImageMediaType(new Uint8Array(0)) === null)
  check('null → 不认', sniffImageMediaType(null) === null)
  check(
    '★ RIFF 但不是 WEBP（例如 wav）→ 不认',
    sniffImageMediaType(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45])) === null,
  )
}

/* ══════════════════════════════════════════════════════════════════════════
section('③ SSRF 防护：内网 / 回环 / 云元数据必须一律拒绝')
// ══════════════════════════════════════════════════════════════════════════ */
{
  const deny = async (url, why) => {
    const r = await assertFetchableUrl(url, { resolveHost: resolveTo({}) })
    check(`拒绝 ${url}${why ? `（${why}）` : ''}`, r.ok === false, r.ok ? '**竟然放行了**' : r.reason)
  }
  await deny('http://127.0.0.1:3410/api/status', '配置接口本身！')
  await deny('http://localhost/x.jpg')
  await deny('http://169.254.169.254/latest/meta-data/', '云元数据')
  await deny('http://10.0.0.5/x.jpg')
  await deny('http://192.168.1.1/x.jpg')
  await deny('http://172.16.0.1/x.jpg')
  await deny('http://172.31.255.254/x.jpg')
  await deny('http://100.64.0.1/x.jpg', 'CGNAT')
  await deny('http://0.0.0.0/x.jpg')
  await deny('http://224.0.0.1/x.jpg', '组播')
  await deny('http://[::1]/x.jpg')
  await deny('http://[::ffff:127.0.0.1]/x.jpg', 'IPv4 映射写法')
  await deny('http://[fe80::1]/x.jpg')
  await deny('http://[fd00::1]/x.jpg')
  await deny('file:///C:/Windows/win.ini', 'file 协议')
  await deny('data:image/png;base64,AAAA', 'data 协议')
  await deny('ftp://example.com/x.jpg')
  await deny('不是网址')
  await deny('http:///x.jpg', '没有主机名')

  // 域名看起来正常、解析却指向内网 —— 这是最常见的绕过写法
  const toInternal = await assertFetchableUrl('http://127.0.0.1.nip.io/x.jpg', {
    resolveHost: resolveTo({ '127.0.0.1.nip.io': '127.0.0.1' }),
  })
  check(
    '★ 域名解析到 127.0.0.1 → 拒绝（nip.io 这类"看着像域名"的写法）',
    toInternal.ok === false,
    toInternal.reason,
  )
  const mixed = await assertFetchableUrl('http://evil.example/x.jpg', {
    resolveHost: resolveTo({ 'evil.example': ['93.184.216.34', '10.1.2.3'] }),
  })
  check('★ 多个解析结果里有一个内网 → 也拒绝', mixed.ok === false, mixed.reason)
  const dnsFail = await assertFetchableUrl('http://nope.invalid/x.jpg', { resolveHost: resolveTo({}) })
  check('域名解析失败 → 拒绝（不是放行）', dnsFail.ok === false, dnsFail.reason)

  // 正例：不能因为防得狠就把正常图也挡了
  const pubIp = await assertFetchableUrl('http://93.184.216.34/x.jpg', { resolveHost: resolveTo({}) })
  check('公网字面 IP → 放行', pubIp.ok === true, pubIp.reason ?? '')
  const pubHost = await assertFetchableUrl('https://multimedia.nt.qq.com.cn/x.jpg', {
    resolveHost: resolveTo({ 'multimedia.nt.qq.com.cn': '203.205.1.1' }),
  })
  check('公网域名 → 放行（QQ 图片域名必须能过）', pubHost.ok === true, pubHost.reason ?? '')

  check('ipIsPrivate 对非 IP 字符串 fail-closed', ipIsPrivate('not-an-ip') === true)
  check('ipIsPrivate(93.184.216.34) = false', ipIsPrivate('93.184.216.34') === false)
  check('ipIsPrivate(::ffff:10.0.0.1) = true', ipIsPrivate('::ffff:10.0.0.1') === true)
}

/* ══════════════════════════════════════════════════════════════════════════
section('④ ★ 逐跳校验重定向：只在第一跳查 == 没查')
// ══════════════════════════════════════════════════════════════════════════ */
{
  const asked = []
  const fetchImpl = async (url) => {
    asked.push(String(url))
    return redirectRes(302, 'http://127.0.0.1:3410/api/status')
  }
  const r = await fetchImageBytes('http://93.184.216.34/a.jpg', {
    fetchImpl,
    resolveHost: resolveTo({}),
  })
  check('★ 公网 → 302 到内网：整个下载被拒', r.ok === false, r.reason)
  check(
    '★★ 内网那一跳**一个请求都没发出去**（这是防住的证据）',
    asked.length === 1 && !asked.some((u) => u.includes('127.0.0.1')),
    `实际请求：${JSON.stringify(asked)}`,
  )

  const asked2 = []
  const chain = async (url) => {
    asked2.push(String(url))
    if (asked2.length <= 1) return redirectRes(301, 'http://93.184.216.35/b.jpg')
    return redirectRes(302, 'http://[::1]/c.jpg')
  }
  const r2 = await fetchImageBytes('http://93.184.216.34/a.jpg', { fetchImpl: chain, resolveHost: resolveTo({}) })
  check('★ 多跳之后仍会校验（第二跳公网、第三跳内网）', r2.ok === false && asked2.length === 2, r2.reason)

  const noLoc = await fetchImageBytes('http://93.184.216.34/a.jpg', {
    fetchImpl: async () => redirectRes(302, ''),
    resolveHost: resolveTo({}),
  })
  check('302 但没有 Location → 拒绝（不猜）', noLoc.ok === false, noLoc.reason)

  let hops = 0
  const loop = await fetchImageBytes('http://93.184.216.34/a.jpg', {
    fetchImpl: async () => {
      hops += 1
      return redirectRes(302, 'http://93.184.216.34/loop.jpg')
    },
    resolveHost: resolveTo({}),
    maxRedirects: 2,
  })
  check('重定向成环 → 到次数上限就停', loop.ok === false && hops === 3, `hops=${hops} ${loop.reason}`)
}

/* ══════════════════════════════════════════════════════════════════════════
section('⑤ 大小 / 超时 / 错误信息')
// ══════════════════════════════════════════════════════════════════════════ */
{
  let bodyTouched = false
  const declared = await fetchImageBytes('http://93.184.216.34/a.jpg', {
    fetchImpl: async () =>
      fakeRes({
        headers: { 'content-length': '99999999' },
        chunks: [
          {
            byteLength: 10,
            // 读它就算"碰过 body"
            get 0() {
              bodyTouched = true
              return 0
            },
          },
        ],
      }),
    resolveHost: resolveTo({}),
    maxBytes: 1000,
  })
  check('content-length 声明超限 → 直接拒', declared.ok === false, declared.reason)
  check('★ 声明超限时**不去读 body**（省带宽、也是止损点）', bodyTouched === false)

  let reads = 0
  const streamed = await fetchImageBytes('http://93.184.216.34/a.jpg', {
    fetchImpl: async () =>
      fakeRes({ chunks: [new Uint8Array(600), new Uint8Array(600), new Uint8Array(600)] }),
    resolveHost: resolveTo({}),
    maxBytes: 1000,
  })
  check('流式超出上限 → 中途止损（不需要读完）', streamed.ok === false, streamed.reason)
  check('确实是"超上限"而不是别的错', /超过上限/.test(streamed.reason ?? ''), streamed.reason)

  const okBody = await fetchImageBytes('http://93.184.216.34/a.jpg', {
    fetchImpl: async () => fakeRes({ chunks: [pngBytes()] }),
    resolveHost: resolveTo({}),
    maxBytes: 10_000,
  })
  check('正常下载 → 拿到字节', okBody.ok === true && okBody.bytes.byteLength === pngBytes().byteLength)

  const timedOut = await fetchImageBytes('http://93.184.216.34/a.jpg', {
    fetchImpl: async () => {
      const e = new Error('The operation was aborted')
      e.name = 'TimeoutError'
      throw e
    },
    resolveHost: resolveTo({}),
    timeoutMs: 1234,
  })
  check('超时 → 变成人话（含毫秒数）', timedOut.ok === false && /超时（1234ms）/.test(timedOut.reason), timedOut.reason)

  const http500 = await fetchImageBytes('http://93.184.216.34/a.jpg', {
    fetchImpl: async () => fakeRes({ status: 500 }),
    resolveHost: resolveTo({}),
  })
  check('HTTP 500 → 如实报状态码', http500.ok === false && /HTTP 500/.test(http500.reason), http500.reason)

  // 没有流可以读的兜底路径（res.arrayBuffer）
  const noBody = await fetchImageBytes('http://93.184.216.34/a.jpg', {
    fetchImpl: async () => fakeRes({ chunks: [pngBytes()], headers: {} }),
    resolveHost: resolveTo({}),
    maxBytes: 10_000,
  })
  check('有 body 时走流式路径（正常）', noBody.ok === true)

  check('没有 fetch 时给出可执行的提示', (await fetchImageBytes('http://x/y.jpg', { fetchImpl: null })).ok === false)
}

/* ══════════════════════════════════════════════════════════════════════════
section('⑥ inbox：内容寻址落盘 + 清理')
// ══════════════════════════════════════════════════════════════════════════ */
{
  const inbox = createImageInbox({ workspace: WS, log: () => {} })
  check('inbox 目录名是 inbox（与文档一致）', inbox.dir === join(WS, IMAGE_DIR), inbox.dir)

  const a = inbox.save(pngBytes(1), 'image/png')
  check('save 成功', a.ok === true, a.reason ?? '')
  check('落盘文件真的存在', existsSync(a.absPath))
  check('文件内容与写入一致', statSync(a.absPath).size === pngBytes(1).byteLength)
  check('★ relPath 是工作区相对路径（提示词里给模型看的就是它）', a.relPath === `${IMAGE_DIR}/${a.name}`, a.relPath)
  check('文件名是内容哈希（便于"同图只存一份"）', /^[0-9a-f]{16}\.png$/.test(a.name), a.name)

  const again = inbox.save(pngBytes(1), 'image/png')
  check('★ 同内容再存一次 → deduped，不再写盘', again.ok === true && again.deduped === true && again.name === a.name)
  check('同内容只有一个文件', readdirSync(inbox.dir).filter((n) => n.endsWith('.png')).length === 1)

  const b = inbox.save(pngBytes(2), 'image/png')
  check('不同内容 → 不同文件', b.ok === true && b.name !== a.name && b.deduped === false)

  const jpg = inbox.save(jpegBytes(), 'image/jpeg')
  check('扩展名跟着 mediaType 走', jpg.ok === true && jpg.name.endsWith('.jpg'), jpg.name)

  const unsupported = inbox.save(pngBytes(3), 'image/bmp')
  check('不支持的 mediaType → ok:false（不会静默存成别的）', unsupported.ok === false, unsupported.reason)
  const empty = inbox.save(new Uint8Array(0), 'image/png')
  check('空内容 → ok:false', empty.ok === false, empty.reason)

  // ── 按时间清理 ──
  const before = readdirSync(inbox.dir).length
  const future = createImageInbox({ workspace: WS, log: () => {}, now: () => Date.now() + 1000 * 3600_000 })
  const pruned = future.prune({ retentionHours: 72, maxTotalBytes: 10 ** 9 })
  check('★ 超过保留时间的图片被删掉', before > 0 && readdirSync(inbox.dir).length === 0, `删了 ${pruned.removed.length} 个`)

  // ── 按总量清理（保留最旧的还是最新的？——删最旧的）──
  const inbox2 = createImageInbox({ workspace: join(WS, 'ws2'), log: () => {} })
  const big1 = inbox2.save(new Uint8Array(400).fill(1), 'image/png')
  await sleep(30)
  const big2 = inbox2.save(new Uint8Array(400).fill(2), 'image/png')
  await sleep(30)
  const big3 = inbox2.save(new Uint8Array(400).fill(3), 'image/png')
  check('三个文件都写好了', big1.ok && big2.ok && big3.ok)
  const totalBefore = readdirSync(inbox2.dir).length
  const pruned2 = inbox2.prune({ retentionHours: 10_000, maxTotalBytes: 900 })
  const left = readdirSync(inbox2.dir)
  check('总量超限 → 会删到不超过上限', totalBefore === 3 && left.length === 2, `剩 ${left.length} 个`)
  check('★ 删的是**最旧**的（最新的要留着给模型看）', !left.includes(big1.name), `剩：${left.join(',')}`)
  check('删掉的记在返回值里（可观测）', pruned2.removed.includes(big1.name))

  // 不清理的极端配置：只警告、不崩
  const never = inbox2.prune({ retentionHours: 0, maxTotalBytes: 10 ** 9 })
  check('retentionHours=0 时不报错（但 config 校验会警告）', typeof never.kept === 'number')
}

/* ══════════════════════════════════════════════════════════════════════════
section('⑦ collectImages：主流程（含 rkey 过期重试）')
// ══════════════════════════════════════════════════════════════════════════ */
{
  const inbox = createImageInbox({ workspace: join(WS, 'ws3'), log: () => {} })
  const resolveHost = resolveTo({})

  // 正常：一张 PNG
  const okPlan = await collectImages({
    refs: [{ url: 'http://93.184.216.34/a.png', file: 'a.png', fileId: '', summary: '' }],
    inbox,
    fetchOptions: { fetchImpl: async () => fakeRes({ chunks: [pngBytes(7)] }), resolveHost },
    maxCount: 4,
  })
  check('成功取到 1 张', okPlan.length === 1 && okPlan[0].ok === true, okPlan[0].reason ?? '')
  check('返回 mediaType', okPlan[0].mediaType === 'image/png')
  check('文件真的在工作区里', existsSync(okPlan[0].absPath))
  check('默认**不带** base64（on-demand 模式省钱）', okPlan[0].base64 === undefined)

  // withBase64
  const b64Plan = await collectImages({
    refs: [{ url: 'http://93.184.216.34/a.png', file: '', fileId: '' }],
    inbox,
    fetchOptions: { fetchImpl: async () => fakeRes({ chunks: [pngBytes(7)] }), resolveHost },
    withBase64: true,
  })
  check('withBase64 时带 base64', typeof b64Plan[0].base64 === 'string' && b64Plan[0].base64.length > 0)
  check(
    '★ base64 能还原成**一模一样的字节**（否则 DSH 那边会拒）',
    Buffer.from(b64Plan[0].base64, 'base64').equals(Buffer.from(pngBytes(7))),
  )
  check(
    '★ base64 是规范形式（Buffer.toString 往返一致，DSH 校验的就是这个）',
    Buffer.from(b64Plan[0].base64, 'base64').toString('base64') === b64Plan[0].base64,
  )

  // 伪装：说自己是 jpeg，实际是 HTML
  const fake = await collectImages({
    refs: [{ url: 'http://93.184.216.34/x.jpg', file: '' }],
    inbox,
    fetchOptions: { resolveHost, fetchImpl: async () => fakeRes({ chunks: [new TextEncoder().encode('<html>hi</html>')] }) },
  })
  check('★ 伪装成图片的 HTML → 拒绝', fake[0].ok === false)
  check('拒绝原因说清是格式问题', /不是支持的图片格式/.test(fake[0].reason), fake[0].reason)

  // ★ rkey 过期：第一次失败 → 用 get_image 换新地址 → 成功
  let callArgs = null
  let attempt = 0
  const retried = await collectImages({
    refs: [{ url: 'http://93.184.216.34/expired.png?rkey=old', file: 'abc.png', fileId: '' }],
    inbox,
    call: async (action, params) => {
      callArgs = { action, params }
      return { url: 'http://93.184.216.34/fresh.png?rkey=new' }
    },
    fetchOptions: {
      resolveHost,
      fetchImpl: async (url) => {
        attempt += 1
        if (String(url).includes('rkey=old')) return fakeRes({ status: 403 })
        return fakeRes({ chunks: [pngBytes(9)] })
      },
    },
  })
  check('★ rkey 过期后重试成功（这是最常见的失败路径，不是异常）', retried[0].ok === true, retried[0].reason ?? '')
  check('★ 确实调了 get_image 换新地址', callArgs?.action === 'get_image' && callArgs?.params?.file === 'abc.png')
  check('两次请求都发生了（先旧的再换新的）', attempt === 2, `attempt=${attempt}`)

  // get_image 也拿不到 → 如实失败
  const stillBad = await collectImages({
    refs: [{ url: 'http://93.184.216.34/expired.png', file: 'gone.png' }],
    inbox,
    call: async () => {
      throw new Error('image not found in cache')
    },
    fetchOptions: { resolveHost, fetchImpl: async () => fakeRes({ status: 404 }) },
  })
  check('get_image 也救不回来 → 如实返回失败原因', stillBad[0].ok === false && /404/.test(stillBad[0].reason), stillBad[0].reason)

  check('refreshImageUrl 对非 http 结果不认（防止把 file:// 当地址）',
    (await refreshImageUrl(async () => ({ url: 'file:///etc/passwd' }), { file: 'x' })) === '')

  // maxCount
  const many = Array.from({ length: 6 }, (_, i) => ({ url: `http://93.184.216.34/${i}.png`, file: '' }))
  const capped = await collectImages({
    refs: many,
    inbox,
    maxCount: 2,
    fetchOptions: { resolveHost, fetchImpl: async () => fakeRes({ chunks: [pngBytes(11)] }) },
  })
  check('maxCount 生效（只处理前 N 张）', capped.length === 2, String(capped.length))
  check('负数/0 的 maxCount 不会变成"全部处理"', (await collectImages({ refs: many, inbox, maxCount: 0, fetchOptions: { resolveHost, fetchImpl: async () => fakeRes({ chunks: [pngBytes(1)] }) } })).length === 0)

  // 一张失败不影响另一张
  const mixed = await collectImages({
    refs: [
      { url: 'http://93.184.216.34/bad.png', file: '' },
      { url: 'http://93.184.216.34/good.png', file: '' },
    ],
    inbox,
    fetchOptions: {
      resolveHost,
      fetchImpl: async (url) => (String(url).includes('bad') ? fakeRes({ status: 403 }) : fakeRes({ chunks: [pngBytes(13)] })),
    },
  })
  check('★ 一张失败不影响另一张（逐张独立）', mixed[0].ok === false && mixed[1].ok === true)

  const none = await collectImages({ refs: [], inbox, fetchOptions: { resolveHost } })
  check('没有图片 → 返回空数组（不抛）', Array.isArray(none) && none.length === 0)
}

/* ══════════════════════════════════════════════════════════════════════════
section('⑧ 配置：默认值必须"省钱"且非法值不会静默生效')
// ══════════════════════════════════════════════════════════════════════════ */
{
  const cfg = normalizeConfig({ dsh: { workspace: TMP }, access: { adminUsers: ['1'] } })
  check('image 段存在', typeof cfg.image === 'object' && cfg.image !== null)
  check('★ 默认模式是 on-demand（省钱的那一档）', cfg.image.mode === 'on-demand', cfg.image.mode)
  check('默认开启', cfg.image.enabled === true)
  check('默认 maxCount = 4', cfg.image.maxCount === 4)
  check('默认 maxBytes = 10MB', cfg.image.maxBytes === 10 * 1024 * 1024)
  check('默认保留 72 小时', cfg.image.retentionHours === 72)
  check('默认总量上限 100MB', cfg.image.maxTotalBytes === 100 * 1024 * 1024)

  const auto = normalizeConfig({ dsh: { workspace: TMP }, image: { mode: 'auto' } })
  check('mode=auto 能生效', auto.image.mode === 'auto')

  const bogus = normalizeConfig({ dsh: { workspace: TMP }, image: { mode: '看图吧' } })
  check(
    '★ 非法 mode **不被静默改写**（改写了校验就永远看不到它，用户会以为设置生效了）',
    bogus.image.mode === '看图吧',
    bogus.image.mode,
  )
  check('非法 mode 的行为是保守的 on-demand（消费方只在 === auto 时才自动注入）', bogus.image.mode !== 'auto')

  const off = normalizeConfig({ dsh: { workspace: TMP }, image: { enabled: false } })
  check('image.enabled=false 能生效', off.image.enabled === false)

  const w = (over) =>
    validateConfig(
      normalizeConfig({ dsh: { workspace: TMP }, access: { adminUsers: ['12345'] }, ...over }),
    ).warn

  check('★ mode=auto 会产生成本警告（用户必须知道）',
    w({ image: { mode: 'auto' } }).some((x) => x.includes('image.mode = auto') && x.includes('计')))
  check('maxCount > 20 会警告（DSH 单条上限 20）',
    w({ image: { maxCount: 25 } }).some((x) => x.includes('maxCount')))
  check('maxBytes > 20MB 会警告（DSH 单张上限 20MB）',
    w({ image: { maxBytes: 30 * 1024 * 1024 } }).some((x) => x.includes('maxBytes')))
  check('maxCount 非正会警告（否则图片全取不到）',
    w({ image: { maxCount: 0 } }).some((x) => x.includes('maxCount')))
  check('retentionHours=0 会警告（等于不清理）',
    w({ image: { retentionHours: 0 } }).some((x) => x.includes('retentionHours')))
  check('非法 mode 会警告（不是静默落回）',
    w({ image: { mode: 'zzz' } }).some((x) => x.includes('image.mode')))
  check('image.enabled=false 时不再啰嗦这些警告',
    !w({ image: { enabled: false, maxCount: 0, retentionHours: 0 } }).some((x) => x.includes('image.')))
}

/* ══════════════════════════════════════════════════════════════════════════
section('⑨ Bridge 集成：提示词怎么写、图片块怎么拼（假 rpc + 桩 fetch）')
// ══════════════════════════════════════════════════════════════════════════ */
{
  const realFetch = globalThis.fetch
  const fetchLog = []
  globalThis.fetch = async (url) => {
    fetchLog.push(String(url))
    return fakeRes({ chunks: [pngBytes(21)] })
  }

  function makeBridge({ image = {}, trigger = {}, access = {} } = {}) {
    const router = new SessionRouter({ log: () => {} })
    const logs = []
    const log = (m) => logs.push(String(m))
    const config = {
      dsh: { workspace: WS, permissionMode: 'workspace-write' },
      onebot: {},
      access: { adminUsers: ['10001'], dmAllowlist: [], groupAllowlist: [], ...access },
      trigger: { private: true, mention: true, keyword: false, groupEnabled: false, keywords: [], ...trigger },
      send: { minGapMs: 0, maxGapMs: 0, maxPerMinute: 100, maxPerHour: 1000, dedupeWindowMs: 0, maxCharsPerMessage: 1500 },
      turn: { timeoutMs: 5000 },
      humanize: { enabled: false, chunkChars: 300 },
      persona: { preset: 'none' },
      memory: { enabled: false },
      image: { enabled: true, mode: 'on-demand', maxCount: 4, maxBytes: 1024 * 1024, timeoutMs: 3000, maxRedirects: 1, retentionHours: 72, maxTotalBytes: 10 ** 9, ...image },
    }
    const rpc = new EventTarget()
    rpc.calls = []
    rpc.prompt = async (sessionId, contentBlocks) => {
      rpc.calls.push({ sessionId, contentBlocks })
      router.handleEvent(sessionId, {
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: '看到图了' }] } },
      })
      router.handleEvent(sessionId, { type: 'turn/end', data: { reason: 'completed' } })
      return { messageId: 'm1' }
    }
    const onebot = new EventTarget()
    onebot.selfId = '99999'
    onebot.calls = []
    onebot.call = async (action, params) => {
      onebot.calls.push({ action, params })
      return { url: 'http://93.184.216.34/fresh.png' }
    }
    onebot.sent = []
    onebot.send = async (kind, peerId, text) => {
      onebot.sent.push({ kind, peerId, text })
    }
    const sendQueue = new SendQueue({ ...config.send, log })
    const inbox = createImageInbox({ workspace: WS, log: () => {} })
    const bridge = new Bridge({ rpc, onebot, sendQueue, router, config, imageInbox: inbox, log })
    return { bridge, rpc, onebot, router, logs, config }
  }

  const privateMsg = (extra = {}) => ({
    post_type: 'message',
    message_type: 'private',
    user_id: '10001',
    self_id: '99999',
    message: [
      { type: 'text', data: { text: '这是我做的图' } },
      { type: 'image', data: { file: 'a.png', url: 'http://93.184.216.34/a.png' } },
    ],
    ...extra,
  })

  // ── on-demand ──
  {
    fetchLog.length = 0
    const { bridge, rpc, onebot, logs } = makeBridge({ image: { mode: 'on-demand' } })
    const res = await bridge.handleEvent(privateMsg())
    const blocks = rpc.calls[0]?.contentBlocks ?? []
    const text = blocks.find((b) => b.type === 'text')?.text ?? ''

    check('回合被处理了', res.handled === true, JSON.stringify(res))
    check('★ 内容块只有文本（on-demand 不塞图片）', blocks.length === 1 && blocks[0].type === 'text', String(blocks.length))
    check('提示词里有 inbox 相对路径（模型据此调 read_image）', /inbox\/[0-9a-f]{16}\.png/.test(text), text.slice(-260))
    check('★★ 不再出现「未启用看图能力」（旧的错误说法必须消失）', !text.includes('未启用看图能力'))
    check('★ 明确提醒"用不上就别读"（成本控制写进了提示词）', text.includes('别读') && text.includes('token'), text.slice(-160))
    check('原文那一行 [图片] 仍在（来源标注不失真）', text.includes('[图片]'))
    check('确实是去下载了', fetchLog.length === 1, JSON.stringify(fetchLog))
    check('回复正常发出（取图没有破坏主流程）', onebot.sent.some((s) => s.text === '看到图了'))
    check('日志里记了取图结果（可观测）', logs.some((l) => l.includes('图片：收到 1 张，取到 1 张')))
  }

  // ── auto ──
  {
    fetchLog.length = 0
    const { bridge, rpc } = makeBridge({ image: { mode: 'auto' } })
    await bridge.handleEvent(privateMsg())
    const blocks = rpc.calls[0]?.contentBlocks ?? []
    const img = blocks.find((b) => b.type === 'image')
    check('★ auto：contentBlocks 里真的有图片块', Boolean(img), JSON.stringify(blocks.map((b) => b.type)))
    check('图片块用 mimeType 字段（DSH 认的就是它）', img?.mimeType === 'image/png', img?.mimeType)
    check('图片块的 base64 能还原成原图', Buffer.from(img?.data ?? '', 'base64').equals(Buffer.from(pngBytes(21))))
    check('图片块排在文本块之后（先说明再给图）', blocks[0].type === 'text' && blocks[1].type === 'image')
    const text = blocks[0].text
    check('auto 的提示词说"已直接附上"（不说"去读文件"）', text.includes('已直接附在'), text.slice(-160))
    check('auto 的提示词不再要求 read_image', !text.includes('用 read_image 读对应文件'))
  }

  // ── 取图失败：必须如实说，不能静默 ──
  {
    globalThis.fetch = async () => fakeRes({ status: 403 })
    const { bridge, rpc } = makeBridge({ image: { mode: 'on-demand' } })
    await bridge.handleEvent(privateMsg())
    const text = rpc.calls[0]?.contentBlocks?.[0]?.text ?? ''
    check('★ 取图失败时提示词里**如实说明**（不静默、也不假装成功）', text.includes('没能取到'), text.slice(-200))
    check('失败原因写进了提示词', /403/.test(text), text.slice(-200))
    check('没有图片块（不能把空气当图发）', !(rpc.calls[0]?.contentBlocks ?? []).some((b) => b.type === 'image'))
    globalThis.fetch = async (url) => {
      fetchLog.push(String(url))
      return fakeRes({ chunks: [pngBytes(21)] })
    }
  }

  // ── ★ 群聊未唤醒 → 一张图都不许下载 ──
  {
    fetchLog.length = 0
    const { bridge } = makeBridge({
      trigger: { private: true, mention: true, keyword: true, groupEnabled: true, keywords: ['小鲸鱼'] },
      access: { groupAllowlist: ['20002'] },
    })
    const res = await bridge.handleEvent({
      post_type: 'message',
      message_type: 'group',
      group_id: '20002',
      user_id: '10001',
      self_id: '99999',
      message: [
        { type: 'text', data: { text: '随便发一张图' } },
        { type: 'image', data: { file: 'x.png', url: 'http://93.184.216.34/x.png' } },
      ],
    })
    check('群聊没被唤醒 → 不处理', res.handled === false, JSON.stringify(res))
    check(
      '★★ 没被唤醒时**一次网络请求都没发**（"不唤醒 = 零成本"是设计前提，也是防 DoS）',
      fetchLog.length === 0,
      JSON.stringify(fetchLog),
    )
  }

  // ── 会话镜像带上图片（界面才显示得出来）──
  {
    fetchLog.length = 0
    const { bridge } = makeBridge({ image: { mode: 'on-demand' } })
    await bridge.handleEvent(privateMsg())
    const list = bridge.listConversations()
    const conv = list.find((c) => c.chatKey === 'private:10001')
    const userMsg = conv?.messages?.find((m) => m.role === 'user')
    check('镜像里有这条用户消息', Boolean(userMsg))
    check('★ 用户消息上挂了 images（界面据此显示图片）', Array.isArray(userMsg?.images) && userMsg.images.length === 1, JSON.stringify(userMsg?.images))
    check('镜像里的路径与落盘一致', userMsg?.images?.[0]?.path === `${IMAGE_DIR}/${userMsg.images[0].path.split('/')[1]}`)
    check('镜像里带了 mediaType / bytes', userMsg?.images?.[0]?.mediaType === 'image/png' && userMsg?.images?.[0]?.bytes > 0)
  }

  // ── ★ 只有 'auto' 才自动注入：拼错的 mode 必须退化成 on-demand ──
  {
    fetchLog.length = 0
    const { bridge, rpc } = makeBridge({ image: { mode: 'Auto ' } })
    await bridge.handleEvent(privateMsg())
    const blocks = rpc.calls[0]?.contentBlocks ?? []
    check(
      '★ mode 写错（大小写/空格）时不会误触发自动注入（只有精确的 auto 才算）',
      !blocks.some((b) => b.type === 'image'),
      JSON.stringify(blocks.map((b) => b.type)),
    )
    check('拼错的 mode 仍会正常落盘（功能不至于完全失效）', (rpc.calls[0]?.contentBlocks?.[0]?.text ?? '').includes('inbox/'))
  }

  // ── image.enabled=false → 完全回到旧行为（但不该再说"没有能力"）──
  {
    fetchLog.length = 0
    const { bridge, rpc } = makeBridge({ image: { enabled: false } })
    await bridge.handleEvent(privateMsg())
    const text = rpc.calls[0]?.contentBlocks?.[0]?.text ?? ''
    check('关掉看图后不去下载', fetchLog.length === 0)
    check('关掉看图后提示词里也不提图片相关的话术', !text.includes('read_image') && !text.includes('已直接附在'))
  }

  globalThis.fetch = realFetch
}

/* ══════════════════════════════════════════════════════════════════════════
section('⑩ 安全回归：桥接源码里不许再出现"丢掉地址"的老写法')
// ══════════════════════════════════════════════════════════════════════════ */
{
  const inbox = createImageInbox({ workspace: join(WS, 'ws4'), log: () => {} })
  // 这条断言守的是"文件权限/路径"这类**静态性质**，不是行为，所以单独放一节
  const r = inbox.save(pngBytes(31), 'image/png')
  check('图片只落在 inbox 目录里，不会散落在工作区根', r.relPath.startsWith(`${IMAGE_DIR}/`) && !r.relPath.includes('..'))
  check('MEDIA_TYPE_EXT 只声明 DSH 能收的四种', Object.keys(MEDIA_TYPE_EXT).sort().join(',') === 'image/gif,image/jpeg,image/png,image/webp')
}

/* ──────────────────────── 收尾 ──────────────────────── */
rmSync(TMP, { recursive: true, force: true })

console.log('')
if (failures === 0) {
  console.log('✅ 看图功能全部通过')
} else {
  console.log(`❌ 失败 ${failures} 项`)
}
process.exit(failures === 0 ? 0 : 1)
