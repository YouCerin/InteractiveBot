import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const files = [...pkg.scripts.test.matchAll(/mocks\/verify-[\w.-]+\.mjs/g)].map((m) => m[0]);
console.log(`链上套件数 = ${files.length}`);
const failed = [];
for (const f of files) {
  const r = spawnSync(process.execPath, [f], { stdio: 'inherit' });
  if (r.status !== 0) {
    failed.push({ f, status: r.status });
    console.log(`\n❌❌❌ 这一套失败：${f}（退出码 ${r.status}）\n`);
  }
}
console.log(`\n${'='.repeat(70)}`);
console.log(`链上 ${files.length} 套；失败 ${failed.length} 套`);
for (const x of failed) console.log(`  ❌ ${x.f}（退出码 ${x.status}）`);
console.log(`${'='.repeat(70)}`);
process.exit(failed.length ? 1 : 0);
