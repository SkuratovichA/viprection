// Smoke test: modify one head screen, run compareGalleries, assert exactly that
// screen is reported "changed" and the others "unchanged".
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { compareGalleries } from '../src/image-diff.mjs';

const T = process.env.DIFF_TEST_DIR;
if (!T) throw new Error('set DIFF_TEST_DIR');

// Paint a red 200x200 block into the head "login" screen so it differs.
const loginPng = join(T, 'head', '01-public', '02-login.png');
const img = PNG.sync.read(await readFile(loginPng));
for (let y = 0; y < Math.min(200, img.height); y++) {
  for (let x = 0; x < Math.min(200, img.width); x++) {
    const i = (img.width * y + x) << 2;
    img.data[i] = 255; img.data[i + 1] = 0; img.data[i + 2] = 0; img.data[i + 3] = 255;
  }
}
await writeFile(loginPng, PNG.sync.write(img));

const report = await compareGalleries({
  baseDir: join(T, 'base'),
  headDir: join(T, 'head'),
  diffDir: join(T, 'diff'),
  diffOptions: { threshold: 0.1, changedRatioGate: 0.001 },
});

console.log('summary:', JSON.stringify(report.summary));
const changed = report.results.filter((r) => r.status === 'changed').map((r) => r.key);
const unchanged = report.results.filter((r) => r.status === 'unchanged').map((r) => r.key);
console.log('changed:', changed);
console.log('unchanged:', unchanged);

const ok =
  changed.length === 1 &&
  changed[0] === '01-public/login' &&
  unchanged.sort().join(',') === '01-public/landing,01-public/register-choose-role';
const loginResult = report.results.find((r) => r.key === '01-public/login');
console.log('login bbox:', JSON.stringify(loginResult.bbox), 'diffRatio:', loginResult.diffRatio.toFixed(4), 'diffPng:', !!loginResult.diffPng);
console.log(ok ? 'SMOKE OK' : 'SMOKE FAIL');
process.exit(ok ? 0 : 1);
