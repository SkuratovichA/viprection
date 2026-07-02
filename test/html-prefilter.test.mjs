import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { hashHtml } from '../src/html-prefilter.mjs';
import { compareGalleries } from '../src/image-diff.mjs';

function solidPng(w, h, [r, g, b]) {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    png.data[i * 4] = r; png.data[i * 4 + 1] = g; png.data[i * 4 + 2] = b; png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

test('normalizeHtml ignores the injected <base href> port but keeps classes/styles', () => {
  const a = '<html><head><base href="http://localhost:3000/"></head><body class="x" style="color:red">hi</body></html>';
  const b = '<html><head><base href="http://localhost:5173/"></head><body class="x" style="color:red">hi</body></html>';
  assert.equal(hashHtml(a), hashHtml(b)); // only the base port differs → equal
  const c = a.replace('color:red', 'color:blue'); // a real style change
  assert.notEqual(hashHtml(a), hashHtml(c));
});

test('prefilter skips pixel-diff when HTML is identical (even if PNG differs)', async () => {
  // This encodes the contract: HTML-equal ⇒ trust it, skip the pixel work.
  const root = await mkdtemp(join(tmpdir(), 'vipr-pf-'));
  const html = '<html><head><base href="http://localhost:3000/"></head><body class="login">form</body></html>';
  const manifest = {
    project: 'T', generatedAt: 'x',
    sections: [{ id: '01', title: 'S', intro: '', screens: [
      { name: 'login', route: '/login', caption: '', png: './01/login.png', html: './01/login.html', status: 'ok' },
    ] }],
  };
  for (const [side, color] of [['base', [200, 0, 0]], ['head', [0, 0, 200]]]) {
    const d = join(root, side, '01');
    await mkdir(d, { recursive: true });
    await writeFile(join(root, side, 'manifest.json'), JSON.stringify(manifest));
    await writeFile(join(d, 'login.png'), solidPng(50, 50, color)); // PNGs DIFFER
    await writeFile(join(d, 'login.html'), html);                    // HTML identical
  }
  const report = await compareGalleries({ baseDir: join(root, 'base'), headDir: join(root, 'head'), diffDir: join(root, 'diff'), diffOptions: {} });
  const r = report.results[0];
  assert.equal(r.status, 'unchanged');
  assert.equal(r.prefiltered, true); // proves the skip path fired
});

test('prefilter falls through to pixel-diff when HTML differs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vipr-pf2-'));
  const mkHtml = (cls) => `<html><head><base href="http://localhost:3000/"></head><body class="${cls}">x</body></html>`;
  const manifest = {
    project: 'T', generatedAt: 'x',
    sections: [{ id: '01', title: 'S', intro: '', screens: [
      { name: 'login', route: '/login', caption: '', png: './01/login.png', html: './01/login.html', status: 'ok' },
    ] }],
  };
  for (const [side, color, cls] of [['base', [200, 0, 0], 'a'], ['head', [0, 0, 200], 'b']]) {
    const d = join(root, side, '01');
    await mkdir(d, { recursive: true });
    await writeFile(join(root, side, 'manifest.json'), JSON.stringify(manifest));
    await writeFile(join(d, 'login.png'), solidPng(50, 50, color));
    await writeFile(join(d, 'login.html'), mkHtml(cls)); // HTML differs
  }
  const report = await compareGalleries({ baseDir: join(root, 'base'), headDir: join(root, 'head'), diffDir: join(root, 'diff'), diffOptions: { changedRatioGate: 0.001 } });
  const r = report.results[0];
  assert.equal(r.status, 'changed');   // pixel-diff ran and found the color change
  assert.ok(!r.prefiltered);
});
