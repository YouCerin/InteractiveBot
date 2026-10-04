/**
 * **真机取证**：问服务端几条关键命令，并把控制台日志尾部按真机编码打出来。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★★ 为什么这个脚本要留在仓库里（而不是"用完就删"）
 * ══════════════════════════════════════════════════════════════════════════
 * 它产出的是**两份结论的证据**，而那两份结论现在都写死在代码与夹具里：
 *
 *   ① **控制台日志不是 UTF-8**（是 GBK）。
 *      `say 夹具-测试消息` 落成的字节是 `bcd0bedf2db2e2cad4cffbcfa2`，
 *      按 UTF-8 解是替换字符、按 GBK 解才对。
 *      ⇒ 依据在 `src/servers/log-source.mjs` 的 `decodeConsoleBytes`，
 *        夹具在 `mocks/fixtures/chat-dialects.mjs`。
 *   ② **「名 → UUID」从哪来**。
 *      实测两条路：
 *        · `list uuids` → `YoCerin (00000000-0000-4000-8000-000000000001)`（只在此刻在线时才有）
 *        · 登录日志 → `UUID of player YoCerin is bbf13b2f-…`（**更好**：一登录就写，
 *          不用他说话、也不用他还在线）
 *      ⇒ 依据在 `log-source.mjs` 的 `UUID_RE` 与那条 `uuid-of-player` 方言夹具。
 *
 * ∴ 以后再怀疑"日志格式/编码变了""UUID 拿不到了"，**重跑这个脚本**，
 *   而不是凭记忆猜 —— 这与 `mocks/_gather-p3` 存在的理由是同一个。
 *
 * ⚠️ 它**只在服务端已经在跑时**可用（它不负责拉起服务端）。
 * ⚠️ 它读 `config.json`（**含密码**）但**绝不打印密码** —— 只打印密码长度。
 */
import { readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { createRconClient } from '../src/servers/rcon.mjs';

const cfg = JSON.parse(readFileSync('config.json', 'utf8').replace(/^\uFEFF/, ''));
const s = (cfg.servers || [])[0];
if (!s) {
  console.log('❌ config.json 里没有配服务器');
  process.exit(1);
}
console.log(`服务器：${s.id}（${s.name}）· ${s.host}:${s.port} · RCON ${s.rconPort} · 密码长度 ${String(s.password ?? '').length}`);

const c = createRconClient({ host: s.host, port: s.rconPort, password: s.password, timeoutMs: 8000 });
const conn = await c.connect();
console.log('登录 =', conn.ok ? 'OK' : JSON.stringify(conn));
if (!conn.ok) process.exit(1);

// ① 两条"名 → UUID"的路子
for (const cmd of ['list', 'list uuids']) {
  const r = await c.exec(cmd);
  console.log(`\n$ ${cmd}\n  ok=${r.ok}\n  body=${JSON.stringify(String(r.body ?? ''))}`);
}
c.close();

// ② 控制台日志尾部 —— **按真机编码（GBK）解**，这就是"那个文件不是 UTF-8"的直接证据
const log = `workspace-qq/runtime/servers/${String(s.id).replace(/[^a-zA-Z0-9_.-]/g, '_')}.console.log`;
try {
  const size = statSync(log).size;
  const want = Math.min(4000, size);
  const fd = openSync(log, 'r');
  const buf = Buffer.alloc(want);
  readSync(fd, buf, 0, want, size - want);
  closeSync(fd);
  console.log(`\n=== 控制台日志尾部（${want} 字节，按 GBK 解）===`);
  const gbk = new TextDecoder('gbk').decode(buf);
  for (const l of gbk.split(/\r?\n/).filter(Boolean).slice(-20)) console.log('  ' + l);
  const utf8All = buf.toString('utf8');
  const fffdAll = (utf8All.match(/\uFFFD/g) ?? []).length;
  console.log(`\n  ★ 尾部这一段按 UTF-8 解：替换字符 ${fffdAll} 个`);

  // ★★ 关键补充：尾部可能**碰巧全是 ASCII**（那样上面那个计数是 0，
  //   会让人误以为"没有编码问题"——实测就踩了这个假象）。
  //   ∴ 再**定位整个文件里第一处非 ASCII 的行**并两种解码对照 —— 那才是硬证据。
  const all = readFileSync(log);
  const lines = all.toString('latin1').split('\n');
  const firstNonAscii = lines.findIndex((l) => /[\u0080-\u00ff]/.test(l));
  if (firstNonAscii >= 0) {
    const start = lines.slice(0, firstNonAscii).reduce((n, l) => n + Buffer.byteLength(l, 'latin1') + 1, 0);
    const end = start + Buffer.byteLength(lines[firstNonAscii], 'latin1');
    const seg = all.subarray(start, end);
    console.log('\n=== 文件里**第一处含非 ASCII**的那一行（编码的硬证据）===');
    console.log(`  原始字节：${seg.toString('hex').match(/.{1,32}/g).join(' ')}`);
    console.log(`  按 UTF-8 解：${JSON.stringify(seg.toString('utf8'))}`);
    console.log(`  按 GBK   解：${JSON.stringify(new TextDecoder('gbk').decode(seg))}`);
    console.log(
      `  ⇒ UTF-8 有替换字符 ${(seg.toString('utf8').match(/\uFFFD/g) ?? []).length} 个` +
        '（这就是"这个文件不是 UTF-8"的判定依据）',
    );
  } else {
    console.log('\n  （整个日志文件里一处非 ASCII 都没有 —— 中文还没出现过）');
  }
} catch (e) {
  console.log(`\n（读控制台日志失败：${e?.message ?? e}）`);
}
