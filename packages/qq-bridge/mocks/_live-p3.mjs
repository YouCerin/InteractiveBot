// 真机取证（服务器已由用户启动）：现在有玩家在线，问三条关键命令。
// 目标：
//   ① `list` 现在返回什么（确认你的用户名）
//   ② `list uuids` 能不能给"名 → UUID"（P3 绑定要靠它）
//   ③ 现有控制台日志里，玩家进服/聊天的行**逐字**长什么样
import { readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { createRconClient } from '../src/servers/rcon.mjs';

const cfg = JSON.parse(readFileSync('config.json', 'utf8').replace(/^\uFEFF/, ''));
const s = (cfg.servers || [])[0];
const c = createRconClient({ host: s.host, port: s.rconPort, password: s.password, timeoutMs: 8000 });
const conn = await c.connect();
console.log('登录 =', conn.ok ? 'OK' : JSON.stringify(conn));

for (const cmd of ['list', 'list uuids']) {
  const r = await c.exec(cmd);
  console.log(`\n$ ${cmd}\n  ok=${r.ok}\n  body=${JSON.stringify(String(r.body ?? ''))}`);
}
c.close();

// ③ 控制台日志里最后 3000 字节（按 GBK 解，那是真机编码）
const log = 'workspace-qq/runtime/servers/forge1.console.log';
const size = statSync(log).size;
const want = Math.min(3000, size);
const fd = openSync(log, 'r');
const buf = Buffer.alloc(want);
readSync(fd, buf, 0, want, size - want);
closeSync(fd);
const gbk = new TextDecoder('gbk').decode(buf);
console.log('\n=== 控制台日志尾部（按 GBK 解）===');
for (const l of gbk.split(/\r?\n/).filter(Boolean).slice(-18)) console.log('  ' + l);
