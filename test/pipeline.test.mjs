// Full pipeline test: build a synthetic 3-screen gallery pair in a tmp dir,
// modify one head screen, then diff → explain → render comment and assert.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { compareGalleries } from '../src/image-diff.mjs';
import { explainReport } from '../src/explain.mjs';
import { renderComment } from '../src/comment.mjs';

// A solid-colour PNG (deterministic, no external fixtures needed).
function solidPng(w, h, [r, g, b]) {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    png.data[i * 4] = r; png.data[i * 4 + 1] = g; png.data[i * 4 + 2] = b; png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

const SCREENS = [
  { name: 'landing', route: '/', caption: 'Landing', png: './01-public/01-landing.png', status: 'ok' },
  { name: 'login', route: '/login', caption: 'Login', png: './01-public/02-login.png', status: 'ok' },
  { name: 'register', route: '/register', caption: 'Register', png: './01-public/03-register.png', status: 'ok' },
];
const MANIFEST = { project: 'T', generatedAt: '2026-07-02', sections: [{ id: '01-public', title: 'Public', intro: '', screens: SCREENS }] };

async function writeGallery(dir, loginColor) {
  await mkdir(join(dir, '01-public'), { recursive: true });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(MANIFEST));
  await writeFile(join(dir, '01-public/01-landing.png'), solidPng(300, 200, [10, 20, 30]));
  await writeFile(join(dir, '01-public/02-login.png'), solidPng(300, 200, loginColor));
  await writeFile(join(dir, '01-public/03-register.png'), solidPng(300, 200, [40, 50, 60]));
}

test('diff → explain → comment: exactly the changed screen surfaces', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vipr-'));
  const baseDir = join(root, 'base'), headDir = join(root, 'head'), diffDir = join(root, 'diff');
  await writeGallery(baseDir, [200, 40, 40]); // base login = red
  await writeGallery(headDir, [40, 40, 200]); // head login = blue  (changed)

  const report = await compareGalleries({ baseDir, headDir, diffDir, diffOptions: { threshold: 0.1, changedRatioGate: 0.001 } });
  assert.equal(report.summary.changed, 1);
  assert.equal(report.summary.unchanged, 2);

  const changed = report.results.find((r) => r.status === 'changed');
  assert.equal(changed.key, '01-public/login');
  assert.ok(changed.diffPngName?.endsWith('.diff.png'));

  const explained = explainReport(report, ['packages/client/src/routes/login.tsx']);
  const loginExpl = explained.find((r) => r.key === '01-public/login');
  assert.match(loginExpl.explanation, /pixels differ/);
  assert.match(loginExpl.explanation, /login\.tsx/); // related-file heuristic

  const md = renderComment({
    report, explained,
    urlFor: (p) => `https://x/${p}`,
    galleryUrl: 'https://x/g/', headSha: 'deadbeefcafef00d',
  });
  assert.ok(md.includes('viprection:visual-diff'));
  assert.ok(md.includes('1 changed'));
  assert.ok(md.includes('diff/01-public__login.diff.png')); // relative diff url
  assert.ok(md.includes('Full gallery'));
});

test('no visual changes → clean comment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vipr-'));
  const baseDir = join(root, 'base'), headDir = join(root, 'head'), diffDir = join(root, 'diff');
  await writeGallery(baseDir, [200, 40, 40]);
  await writeGallery(headDir, [200, 40, 40]); // identical
  const report = await compareGalleries({ baseDir, headDir, diffDir, diffOptions: {} });
  assert.equal(report.summary.changed, 0);
  const md = renderComment({ report, explained: explainReport(report, []), urlFor: () => null });
  assert.ok(md.includes('No visual changes detected'));
});
