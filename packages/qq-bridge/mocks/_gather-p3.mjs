// 真机取证（一条命令内完成）：拉服务端 → 问 RCON 几条关键命令 → 优雅停掉。
// 取证目标：
//   ① `list uuids` 到底存不存在、输出什么形状（UUID 从哪来的关键）
//   ② 控制台里"玩家进出/聊天"那一行**逐字**长什么样（用 /say 造一条聊天行当夹具）
// ★ 为什么要在一条命令内做完：这台沙箱命令一结束就收走 detached 子进程。
import { spawn } from 'node:child_process';
import { openSync, closeSync, mkdirSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createRconClient } from '../src/servers/rcon.mjs';

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
const WS = join(PKG, 'workspace-qq');
const MC = join(WS, 'store/mc-forge-1.20.1');
const exe = join(MC, 'jdk-17.0.20.1+1/bin/java.exe');
const consoleLog = join(WS, 'runtime/servers/forge1.console.log');

const cfg = JSON.parse(readFileSync(join(PKG, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
const srv = (cfg.servers || [])[0];
console.log('配置：', srv?.id, srv?.host, srv?.rconPort, '密码长度', String(srv?.password ?? '').length);

const fd = openSync(consoleLog, 'a');
const child = spawn(exe, ['@user_jvm_args.txt', '@libraries/net/minecraftforge/forge/1.20.1-47.3.0/win_args.txt', 'nogui'], {
  cwd: MC,
  shell: false,
  stdio: ['ignore', fd, fd],
});
closeSync(fd);
console.log('服务端 pid =', child.pid);

const portOpen = (port) =>
  new Promise((resolve) => {
    const s = netConnect({ host: '127.0.0.1', port });
    const done = (v) => { try { s.destroy() } catch {} resolve(v) };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    setTimeout(() => done(false), 2000);
  });

let c = null;
try {
  const deadline = Date.now() + 240_000;
  let up = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 4000));
    if (await portOpen(25575)) { up = true; break }
    process.stdout.write('.');
  }
  console.log('\nRCON 端口起来了 =', up);
  if (!up) throw new Error('RCON 没起来');

  c = createRconClient({ host: srv.host, port: srv.rconPort, password: srv.password, timeoutMs: 8000 });
  const conn = await c.connect();
  console.log('登录 =', conn.ok ? 'OK' : JSON.stringify(conn));

  // ── 取证 ①：UUID 从哪来 ──
  const uuidCmds = ['list', 'list uuids', 'data get entity @a', 'seed'];
  for (const cmd of uuidCmds) {
    const r = await c.exec(cmd);
    console.log(`\n$ ${cmd}\n  ok=${r.ok} body=${JSON.stringify(String(r.body ?? '').slice(0, 260))}`);
  }

  // ── 取证 ②：造一条"聊天行"，看它在控制台里逐字长什么样 ──
  const before = readFileSync(consoleLog, 'utf8').length;
  const sayRes = await c.exec('say 夹具-测试消息');
  console.log('\n$ say 夹具-测试消息 →', sayRes.ok, JSON.stringify(String(sayRes.body ?? '').slice(0, 120)));
  await new Promise((r) => setTimeout(r, 800));
  const after = readFileSync(consoleLog, 'utf8').slice(before);
  console.log('\n=== 新增的控制台内容（逐字）===');
  console.log(JSON.stringify(after));
} catch (error) {
  console.log('💥', error?.message ?? error);
} finally {
  // 优雅停服
  try {
    if (c) { await c.exec('stop'); c.close() }
  } catch {}
  const t = Date.now() + 90_000;
  while (Date.now() < t && child.exitCode === null) await new Promise((r) => setTimeout(r, 2000));
  console.log('\n服务端已退出 =', child.exitCode !== null, '· exitCode =', child.exitCode);
}
