// Viewport-aware pairing: the same logical screen captured at desktop AND mobile
// must NOT collide in indexManifest — each viewport is a distinct canonical key.
// A base with the screen at desktop-only + a head with desktop AND mobile yields
// a desktop pair (changed/unchanged) plus a SEPARATE 'added' result for @mobile,
// and the mobile diff file name is derived through the canonical sanitizer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { compareGalleries } from '../src/image-diff.mjs';

function solidPng(w, h, [r, g, b]) {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    png.data[i * 4] = r; png.data[i * 4 + 1] = g; png.data[i * 4 + 2] = b; png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

// A screen entry; viewport omitted → desktop, else `@vp` file suffix (mirrors the writer).
function screen(name, viewport) {
  const suffix = viewport ? `@${viewport}` : '';
  return {
    name, route: `/${name}`, caption: name,
    png: `./01/${name}${suffix}.png`, status: 'ok',
    ...(viewport ? { viewport } : {}),
  };
}

async function writeGallery(dir, screens, colorFor) {
  await mkdir(join(dir, '01'), { recursive: true });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({
    project: 'T', generatedAt: 'x',
    sections: [{ id: '01', title: 'S', intro: '', screens }],
  }));
  for (const sc of screens) {
    const rel = sc.png.replace(/^\.\//, '');
    await writeFile(join(dir, rel), solidPng(40, 40, colorFor(sc)));
  }
}

test('same screen at desktop+mobile does not collide: desktop pairs, mobile is added', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vipr-vp-'));
  const baseDir = join(root, 'base');
  const headDir = join(root, 'head');

  // Base: home at DESKTOP only.
  await writeGallery(baseDir, [screen('home')], () => [200, 0, 0]);
  // Head: home at DESKTOP (changed vs base) AND MOBILE (new → added).
  await writeGallery(headDir, [screen('home'), screen('home', 'mobile')], () => [0, 0, 200]);

  const report = await compareGalleries({
    baseDir, headDir, diffDir: join(root, 'diff'),
    diffOptions: { threshold: 0.1, changedRatioGate: 0.001, htmlPrefilter: false },
  });

  const byKey = new Map(report.results.map((r) => [r.key, r]));

  // Desktop pair exists under the bare key (no @suffix) and is a real diff pair.
  const desktop = byKey.get('01/home');
  assert.ok(desktop, 'desktop screen must be keyed as 01/home');
  assert.equal(desktop.status, 'changed', 'desktop home changed color → changed');
  assert.equal(desktop.head.viewport, 'desktop', 'desktop head.viewport populated');
  assert.equal(desktop.base.viewport, 'desktop', 'desktop base.viewport populated');

  // Mobile is a SEPARATE result, keyed with the @mobile suffix, classified added
  // (base has no mobile counterpart → set-difference, not a Map overwrite).
  const mobile = byKey.get('01/home@mobile');
  assert.ok(mobile, 'mobile screen must be a separate result keyed 01/home@mobile');
  assert.equal(mobile.status, 'added', 'mobile-only head screen is added');
  assert.equal(mobile.base, null, 'added screen has no base');
  assert.equal(mobile.head.viewport, 'mobile', 'added head.viewport populated');

  assert.equal(report.summary.added, 1, 'exactly one added (the mobile screen)');
  assert.equal(report.summary.changed, 1, 'exactly one changed (the desktop screen)');
});

test('mobile changed case: diffPngName carries @mobile via the canonical sanitizer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vipr-vp2-'));
  const baseDir = join(root, 'base');
  const headDir = join(root, 'head');

  // Both base and head have home@mobile, differing color → changed.
  await writeGallery(baseDir, [screen('home', 'mobile')], () => [200, 0, 0]);
  await writeGallery(headDir, [screen('home', 'mobile')], () => [0, 0, 200]);

  const report = await compareGalleries({
    baseDir, headDir, diffDir: join(root, 'diff'),
    diffOptions: { threshold: 0.1, changedRatioGate: 0.001, htmlPrefilter: false },
  });

  const mobile = report.results.find((r) => r.key === '01/home@mobile');
  assert.ok(mobile, 'mobile pair keyed 01/home@mobile');
  assert.equal(mobile.status, 'changed', 'mobile pair changed color → changed');
  // '/' → '__', '@' survives → the canonical flat stem for a diff overlay.
  assert.equal(mobile.diffPngName, '01__home@mobile.diff.png', 'diff name via screenKeyToFilename');
  assert.ok(mobile.diffPng, 'a diff overlay was written for the changed mobile pair');
});
