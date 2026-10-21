/** 离线自检：「需要重启 DSH」的文本判定（lib/alarm.js 导出的 restartHitOf）。
 *  样本是合成的（test/fixtures/restart-samples.json，字段 id / note / excerpt / expected），
 *  只跑纯函数，不启动 DSH、不投递提醒（所以不会响铃）。 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { restartHitOf } from '../lib/alarm.js';

const here = dirname(fileURLToPath(import.meta.url));
const samples = JSON.parse(readFileSync(join(here, 'fixtures', 'restart-samples.json'), 'utf8'));

let failed = 0;
for (const sample of samples) {
  const got = restartHitOf(sample.excerpt);
  const ok = got === sample.expected;
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${sample.id} expected=${sample.expected} got=${got}`);
}

if (failed === 0) {
  console.log(`\n${samples.length}/${samples.length} PASS`);
} else {
  console.log(`\n${failed}/${samples.length} FAIL`);
  process.exitCode = 1;
}
