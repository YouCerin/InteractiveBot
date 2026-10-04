// 实测：readServerConsole 与 probeOnce（用真桥接，不启动整个程序）。
import { readFileSync } from 'node:fs';
import { Bridge } from '../src/bridge.mjs';
import { SessionRouter } from '../src/session-bridge.mjs';
import { SendQueue } from '../src/onebot.mjs';

const cfg = JSON.parse(readFileSync('config.json', 'utf8').replace(/^\uFEFF/, ''));
const logs = [];
const rpc = new EventTarget();
rpc.prompt = async () => ({ messageId: 'm1' });
const onebot = new EventTarget();
onebot.selfId = '200000001';
onebot.call = async () => ({ status: 'ok', retcode: 0, data: null });
onebot.send = async () => ({ status: 'ok', retcode: 0 });
const bridge = new Bridge({
  rpc,
  onebot,
  sendQueue: new SendQueue({ ...cfg.send, log: () => {} }),
  router: new SessionRouter({ log: () => {} }),
  config: cfg,
  log: (m) => logs.push(String(m)),
});

console.log('=== readServerConsole（该你看到真实控制台）===');
const c = bridge.readServerConsole({ serverId: cfg.servers[0].id, limit: 12 });
console.log('  ok =', c.ok, '· 行数 =', c.lines?.length, '· 编码 =', c.encoding, '· why =', c.why ?? '');
for (const l of c.lines ?? []) console.log('   ', l);

console.log('\n=== probeServerForApi（主动检测）===');
const p = await bridge.probeServerForApi({ serverId: cfg.servers[0].id });
console.log('  ok =', p.ok, '· snapshot =', JSON.stringify(p.snapshot ?? p.why));

console.log('\n=== 桥接日志（看有没有主动检测那行）===');
for (const l of logs.slice(-4)) console.log('   ', l);
