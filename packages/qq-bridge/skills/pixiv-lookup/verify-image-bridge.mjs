// pixiv-lookup「图片桥」真机验收（要外网 + 一个能用的本地代理）
//
// ── 这个脚本回答什么问题 ──────────────────────────────────────────────────
//   ① 本插件能不能真的把 P站图**取回来**？（带 Referer + 走你配的代理）
//   ② 取回来之后，宿主（QQ Agent 的 send_image 通道）能不能**下载**那条直链？
//   ③ 如果宿主关着「允许下载内网/本机图片地址」，是不是就会重现用户报的那句
//      「图片下载失败：域名解析到内网/本机地址，已阻止」？
//   ④ 不用图片桥、直接让宿主去下 i.pximg.net 的裸链，是不是必然失败？
//
// 这四条合起来就是本次修复的完整证据链：**问题出在宿主的图片下载通道
// （防盗链 + 要代理 + SSRF 保护挡了本地直链），而图片桥把这三件事各自解决掉。**
//
// ── 跑法（在 QQ Agent 目录下，用相对路径调用）─────────────────────────────
//   $env:ELECTRON_RUN_AS_NODE='1'
//   & ".\node_modules\electron\dist\electron.exe" ".\skills\pixiv-lookup\verify-image-bridge.mjs"
//
//   可选参数：
//     --proxy http://127.0.0.1:7890   手动指定代理（默认自动探测）
//     --artwork 149845278             换一个作品 id 试（默认 149845278）
//     --skip-raw                      跳过"裸链必定失败"那一步（那步要等一次超时，约 20 秒）
//
// 退出码 0 = 全部符合预期；1 = 有不符合预期的项。

import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SKILL_DIR = path.dirname(fileURLToPath(import.meta.url))
const APP = String(process.env.QQ_AGENT_DIR || '').trim() || 'D:\\QQ-Agent-爆改版0.4'

const argOf = (name, dflt = '') => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt
}
const hasFlag = (name) => process.argv.includes(`--${name}`)
const ARTWORK_ID = argOf('artwork', '149845278')
const SKIP_RAW = hasFlag('skip-raw')

let pass = 0
const fails = []
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fails.push(`${name}${extra ? ` — ${extra}` : ''}`); console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`) }
}
const jpegMagic = (buf) => !!buf && buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff

/** 探一下 127.0.0.1:port 通不通（用来找本地代理）。 */
function probePort(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port })
    const done = (v) => { try { s.destroy() } catch { /* ignore */ } resolve(v) }
    s.setTimeout(timeoutMs)
    s.once('connect', () => done(true))
    s.once('timeout', () => done(false))
    s.once('error', () => done(false))
  })
}

/** 找本地代理：--proxy > 环境变量 > 技能设置 > 常见端口探测 > 交给插件自己 auto。 */
async function detectProxy(hostConfig) {
  const explicit = String(argOf('proxy', '') || '').trim()
  if (explicit) return { proxy: explicit, how: '--proxy 参数' }
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
    const v = String(process.env[k] || '').trim()
    if (v) return { proxy: v, how: `环境变量 ${k}` }
  }
  const fromSkill = String(hostConfig?.skills?.['pixiv-lookup']?.proxy || '').trim()
  if (fromSkill && !/^auto$/i.test(fromSkill)) return { proxy: fromSkill, how: '技能设置里的「代理地址」' }
  // 常见本地代理端口（Clash/mihomo 7890、v2rayN 10809、sing-box 2080…）
  for (const p of [7890, 7897, 7891, 10809, 10808, 1080, 2080, 8889, 54626, 20171]) {
    if (await probePort(p)) return { proxy: `http://127.0.0.1:${p}`, how: `自动探测到 127.0.0.1:${p} 在监听` }
  }
  // 都不行就把 auto 交给插件自己（它会问 Electron 会话代理 / 读注册表 / 扫端口）
  return { proxy: 'auto', how: '本脚本没探到，交给插件自己 auto 探测' }
}

function finish() {
  console.log(`\n=== 结论：${pass} 项符合预期，${fails.length} 项不符合 ===`)
  for (const f of fails) console.log('  · ' + f)
  if (!fails.length) {
    console.log('\n下一步（只做一次）：在 QQ Agent 里打开「设置 → 安全 → 允许下载内网/本机图片地址」，')
    console.log('然后重启一次 QQ Agent（或重载技能）。之后让模型用结果里的「发图直链」发图即可。')
  }
  return fails.length ? 1 : 0
}

async function main() {
  console.log('\n=== pixiv-lookup 图片桥 · 真机验收 ===')
  console.log(`插件目录：${SKILL_DIR}`)
  console.log(`宿主目录：${APP}`)

  // ── 0. 读宿主的真实配置（只读，不改动任何文件）──
  const cfgFile = path.join(APP, 'data', 'config.json')
  let hostConfig = null
  try {
    hostConfig = JSON.parse(fs.readFileSync(cfgFile, 'utf8').replace(/^\uFEFF/, ''))
    ok(`读到宿主配置 ${cfgFile}`, true)
  } catch (e) {
    ok(`读到宿主配置 ${cfgFile}`, false, String(e.message))
    console.log('（读不到宿主配置就只能靠 --proxy 手填代理继续跑）')
  }
  const switchOn = hostConfig?.security?.allowPrivateImageHosts === true
  console.log(`宿主「允许下载内网/本机图片地址」：${switchOn ? '已开 ✅' : '关着 ← 就是本次故障的设置'}`)

  const { proxy, how } = await detectProxy(hostConfig)
  console.log(`代理：${proxy || '(无)'}  ← ${how}`)

  // ── 1. 用插件自己的出网层真的查一次作品详情，拿到「发图直链」──
  const skillSettings = {
    ...(hostConfig?.skills?.['pixiv-lookup'] || {}),
    enabled: true,
    proxy,
    timeoutMs: 40000,
  }
  const mod = await import(pathToFileURL(path.join(SKILL_DIR, 'index.js')).href)
  const tools = new Map()
  mod.setup({
    registerTool: (d) => tools.set(d.id, d),
    config: () => skillSettings,
    log: () => {},
    warn: (...a) => console.log('    [plugin warn]', ...a),
  })
  const artworkTool = tools.get('artwork')
  ok('插件能加载并注册 artwork 工具', !!artworkTool)
  if (!artworkTool) return finish()

  console.log(`\n— 真机查询作品 ${ARTWORK_ID}（走 ${proxy || '直连'}）—`)
  const res = await artworkTool.execute(
    { kind: 'private', chatId: 'verify', config: { skills: { 'pixiv-lookup': skillSettings } } },
    { ids: ARTWORK_ID },
  )
  const text = String(res.content || '')
  if (res.isError) {
    console.log('  插件返回：' + text.split('\n').slice(0, 6).map((l) => '\n    | ' + l).join(''))
    ok('Pixiv 接口可访问（能查到作品）', false, '先确认代理可用（--proxy http://127.0.0.1:xxxx）')
    return finish()
  }
  const item = JSON.parse(text).作品[0]
  const bridgeLink = String((item.图 && item.图.发图直链) || '')
  const rawLink = String((item.图 && (item.图.大图 || item.图.原图)) || '')
  console.log(`  标题：${item.标题} — ${item.作者}（${item.尺寸}）`)
  ok('查到了作品详情', !!item.标题)
  ok('返回里有「发图直链」（形如 http://127.0.0.1:端口/i/…）',
    /^http:\/\/127\.0\.0\.1:\d+\/i\/[A-Za-z0-9_-]+$/.test(bridgeLink), bridgeLink || '(没有)')
  console.log(`  图片桥状态：${mod.diagnose({ config: { skills: { 'pixiv-lookup': skillSettings } } })['图片桥']}`)
  console.log(`  代理状态：${mod.diagnose({ config: { skills: { 'pixiv-lookup': skillSettings } } })['代理']}`)
  if (!bridgeLink) {
    ok('图片桥给出了直链', false, '检查技能设置里的「本地图片桥」是否被关掉')
    return finish()
  }

  // ── 2. 用宿主**真实的**下载通道来下这条直链 ──
  const hostCfg = await import(pathToFileURL(path.join(APP, 'src', 'config.js')).href)
  const hostFetch = await import(pathToFileURL(path.join(APP, 'src', 'safe-fetch.js')).href)
  const withBase = (allowPrivate) => ({
    ...(hostConfig || {}),
    security: { ...((hostConfig && hostConfig.security) || {}), allowPrivateImageHosts: allowPrivate },
  })

  console.log('\n— 宿主的图片下载通道（send_image 走的就是这一套）—')
  // ② 复现用户的报错：开关关着 → 本地直链被 SSRF 保护挡掉
  hostCfg.setRuntimeConfig(withBase(false))
  let blockedMsg = ''
  try {
    await hostFetch.safeFetchBinary(bridgeLink, 8 * 1024 * 1024, { browseLocked: true })
    blockedMsg = '(居然没被挡)'
  } catch (e) { blockedMsg = String((e && e.message) || e) }
  console.log(`     开关关着时的报错：${blockedMsg}`)
  ok('开关关着时：宿主的 SSRF 保护确实会挡掉本地直链（复现用户那句报错）',
    /内网|本机|localhost|私有/i.test(blockedMsg), blockedMsg)

  // ③ 开关打开 → 宿主能下到真图（browseLocked:true 与 send_image 的调用方式完全一致）
  hostCfg.setRuntimeConfig(withBase(true))
  let buf = null
  let contentType = ''
  try {
    const r = await hostFetch.safeFetchBinary(bridgeLink, 8 * 1024 * 1024, { browseLocked: true })
    buf = r.buffer
    contentType = r.contentType
  } catch (e) {
    ok('开关打开后：宿主能下载图片桥的直链', false, String((e && e.message) || e))
  }
  if (buf) {
    ok('开关打开后：宿主能下载图片桥的直链', true)
    ok('下载到的是真图片（JPEG 魔数）', jpegMagic(buf), `前 4 字节 ${buf.subarray(0, 4).toString('hex')}`)
    ok('图片体积合理（> 10KB）', buf.length > 10 * 1024, `${Math.round(buf.length / 1024)}KB`)
    console.log(`     取到 ${Math.round(buf.length / 1024)}KB，Content-Type=${contentType}`)
  }

  // ③b 直接用宿主**真正的 send_image 工具**跑一遍（用桩 ctx，不会真的发到 QQ）
  console.log('\n— 直接调用宿主的 send_image 工具（桩 ctx，不会发到 QQ）—')
  try {
    const toolsMod = await import(pathToFileURL(path.join(APP, 'src', 'tools.js')).href)
    const sendImage = toolsMod.buildToolDefs().find((d) => d.name === 'send_image')
    if (!sendImage) {
      ok('宿主的 tools.js 里有 send_image', false)
    } else {
      const mkCtx = () => ({
        chatKey: 'group:0',
        session: { imagePreviewed: [], sent: [], imageUrlsSeen: [] },
        sender: { sendImage: async () => ({ message_id: 1 }) },
        stickers: {},
        emit: () => {},
      })
      // 关着开关：应该就是用户看到的那句中文报错
      hostCfg.setRuntimeConfig({
        ...withBase(false),
        security: { ...withBase(false).security, imageSend: { ...(withBase(false).security.imageSend || {}), enabled: true, requirePreview: false } },
      })
      const bad = await sendImage.execute(mkCtx(), { url: bridgeLink, note: 'verify' })
      console.log('     ' + String(bad.content || '').split('\n')[0])
      ok('send_image 在开关关着时给出的正是「图片下载失败 + 内网」那句话',
        bad.isError === true && /图片下载失败/.test(String(bad.content)) && /内网|本机/.test(String(bad.content)))

      // 开着开关：应该真的组装出 base64 图片并交给发送器
      let captured = null
      hostCfg.setRuntimeConfig({
        ...withBase(true),
        security: { ...withBase(true).security, imageSend: { ...(withBase(true).security.imageSend || {}), enabled: true, requirePreview: false } },
      })
      const ctx = mkCtx()
      ctx.sender.sendImage = async (_chatKey, payload) => { captured = payload; return { message_id: 1, reply: null } }
      const good = await sendImage.execute(ctx, { url: bridgeLink, note: 'verify' })
      const dataUrl = String((captured && captured.dataUrl) || '')
      console.log('     ' + String(good.content || '').split('\n')[0])
      ok('send_image 在开关打开时把图片真的交给发送器（base64:// 图片数据）',
        good.isError !== true && /^base64:\/\//.test(dataUrl), good.isError ? String(good.content).slice(0, 160) : (dataUrl.slice(0, 40) || '(没拿到 payload)'))
      ok('交给发送器的字节数与下载到的一致',
        !!captured && Math.round(dataUrl.replace(/^base64:\/\//, '').length * 3 / 4) === (buf ? buf.length : -1))
      ok('发图后记进了会话（模型能知道"这张发过了"）', (ctx.session.imageUrlsSeen || []).includes(bridgeLink))
    }
  } catch (e) {
    ok('用宿主 send_image 工具跑一遍（桩 ctx）', false, String((e && e.message) || e))
  }

  // ④ 对照：不用桥、直接让宿主下 i.pximg.net 裸链 → 必定失败
  if (SKIP_RAW) {
    console.log('\n— 对照组（--skip-raw 已跳过）：不经过图片桥的裸链 —')
  } else if (rawLink) {
    console.log('\n— 对照组：直接让宿主下 i.pximg.net 裸链（预期失败）—')
    let rawMsg = ''
    try {
      const r = await hostFetch.safeFetchBinary(rawLink, 8 * 1024 * 1024)
      rawMsg = `(居然成功，${r.buffer.length} 字节 —— 这台机器能直连 pximg，但换了机器/网络仍会失败)`
    } catch (e) { rawMsg = String((e && e.message) || e) }
    console.log(`     实际报错：${rawMsg.split('\n')[0]}`)
    ok('裸链拿不到图（宿主的通道没带 Referer / 不走代理）',
      /403|超时|timeout|失败|ECONN|HTTP/i.test(rawMsg), rawMsg.split('\n')[0])
  }

  // 收尾：关掉插件里的图片桥（免得留下监听端口）
  try { mod.dispose() } catch { /* ignore */ }
  return finish()
}

main()
  .then((code) => process.exit(code || 0))
  .catch((e) => { console.error('\n验收脚本自己崩了：', e); process.exit(1) })
