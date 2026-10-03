// ★★★ 真机端到端探针：在**一条命令内**把 Forge 服务端拉起来、连它的 RCON、
// 读真实数据、再优雅停掉。
//
// 为什么要在一条命令内做完：这台沙箱会在每条命令结束时把 detached 子进程一起收走
// （已用隔离实验证实），所以"跨命令的守护/归属"在这里永远验不了。
// 但"RCON 登录与命令通道"完全可以验 —— 只要服务端作为**当前命令的子进程**活着。
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRconClient } from './packages/qq-bridge/src/servers/rcon.mjs';

// ★ spawn 的**可执行文件路径仍然按进程 cwd 解析**（`cwd` 选项只影响子进程的 cwd），
//   所以这里必须给绝对路径 —— 用脚本自己的位置推，不依赖调用者从哪跑。
const HERE = dirname(fileURLToPath(import.meta.url));
const MC = join(HERE, 'packages/qq-bridge/workspace-qq/store/mc-forge-1.20.1');
const exe = join(MC, 'jdk-17.0.20.1+1/bin/java.exe');
const logPath = join(HERE, 'packages/qq-bridge/workspace-qq/runtime/_probe-mc.console.log');

const fd = openSync(logPath, 'a');
const child = spawn(exe, ['@user_jvm_args.txt', '@libraries/net/minecraftforge/forge/1.20.1-47.3.0/win_args.txt', 'nogui'], {
  cwd: MC,
  shell: false,
  stdio: ['ignore', fd, fd],
});
closeSync(fd);
console.log(`服务端子进程 pid = ${child.pid}（它是这条命令的子进程，所以会活到本条命令结束）`);

const portOpen = (port) =>
  new Promise((resolve) => {
    const s = netConnect({ host: '127.0.0.1', port });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => { s.destroy(); resolve(false); });
    setTimeout(() => { s.destroy(); resolve(false); }, 2000);
  });

let pass = 0;
let fail = 0;
const check = (cond, label) => {
  if (cond) { pass += 1; console.log(`  ✅ ${label}`); }
  else { fail += 1; console.log(`  ❌ ${label}`); }
};

try {
  // 等 RCON 端口（它比游戏端口晚一点，但都要等）
  const deadline = Date.now() + 240_000;
  let rconUp = false;
  let gameUp = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 4000));
    gameUp = await portOpen(25565);
    rconUp = await portOpen(25575);
    process.stdout.write(`  … 25565=${gameUp} 25575=${rconUp}\r`);
    if (gameUp && rconUp) break;
  }
  console.log('');
  check(gameUp, '游戏端口 25565 打开');
  check(rconUp, 'RCON 端口 25575 打开');

  console.log('\n=== ★★★ 真机 RCON 登录（这就是之前一直超时的那一步）===');
  const password = process.env.PROBE_RCON_PW ?? '';
  const c = createRconClient({ host: '127.0.0.1', port: 25575, password, timeoutMs: 8000 });
  const t0 = Date.now();
  const r = await c.connect();
  const dt = Date.now() - t0;
  check(r.ok === true, `登录成功（耗时 ${dt}ms；之前是死等 30 秒超时）`);
  check(dt < 5000, `登录是**快**的（${dt}ms < 5000ms）—— 证明没有在等多余的包`);
  check(c.state().authed === true, 'state().authed = true');

  if (r.ok) {
    console.log('\n=== 真机命令通道：读玩家列表 ===');
    const list = await c.exec('list');
    check(list.ok === true, 'list 命令有应答');
    console.log(`     服务端回答：${String(list.body ?? '').trim() || '(空)'}`);

    console.log('\n=== 真机命令通道：读 TPS（Forge 有 /forge tps）===');
    const tps = await c.exec('forge tps');
    check(tps.ok === true, 'forge tps 有应答');
    console.log(`     服务端回答：${String(tps.body ?? '').trim().slice(0, 200) || '(空)'}`);

    console.log('\n=== 密码错必须被拒（真机）===');
    const bad = createRconClient({ host: '127.0.0.1', port: 25575, password: `${password}x`, timeoutMs: 8000 });
    const br = await bad.connect();
    check(br.ok === false, '密码错 ⇒ 登录失败');
    check(br.layer === 'auth', `密码错分类成 auth（实际 ${br.layer}）`);
    check(!JSON.stringify(br).includes(`${password}x`), '★ 失败理由里没有密码原文');
    bad.close();

    console.log('\n=== 优雅停服（真机 RCON stop）===');
    const stop = await c.exec('stop');
    check(stop.ok === true || stop.layer === 'timeout', 'stop 命令已送出（服务端随关闭断开连接属正常）');
  }
  c.close();
} catch (error) {
  console.log(`\n💥 探针异常：${error?.stack ?? error}`);
  fail += 1;
} finally {
  // ★ 就算上面全挂了，也要尽力把服务端**优雅**关掉（绝不 taskkill 一个正在存盘的 JVM）
  try {
    const c2 = createRconClient({ host: '127.0.0.1', port: 25575, password: process.env.PROBE_RCON_PW ?? '', timeoutMs: 5000 });
    const rr = await c2.connect();
    if (rr.ok) await c2.exec('stop');
    c2.close();
  } catch { /* 已经停了就算了 */ }
  // 等它自己退（存盘需要时间）
  const t = Date.now() + 90_000;
  while (Date.now() < t && child.exitCode === null) {
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (child.exitCode === null) {
    console.log('⚠️ 服务端 90 秒内没退出 —— 需要人工看一眼（不强杀，避免坏档）');
  } else {
    console.log(`✅ 服务端已自行退出（exitCode=${child.exitCode}）`);
  }
  console.log(`\n真机探针：${pass} 项通过 · ${fail} 项失败`);
  process.exit(fail === 0 ? 0 : 1);
}
