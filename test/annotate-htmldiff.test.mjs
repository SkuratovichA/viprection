import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { annotatePng } from '../src/annotate.mjs';
import { extractTextLines, htmlDiff, attachHtmlDiffs } from '../src/html-diff.mjs';

test('annotatePng draws a red border around the padded box', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vp-ann-'));
  const img = new PNG({ width: 60, height: 60 });
  img.data.fill(255); // white
  const src = join(dir, 'src.png');
  await writeFile(src, PNG.sync.write(img));
  const dest = join(dir, 'out.png');
  annotatePng(src, dest, [{ x: 20, y: 20, w: 10, h: 10 }], { pad: 4, thickness: 2 });
  const out = PNG.sync.read(readFileSync(dest));
  const px = (x, y) => out.data[(out.width * y + x) << 2]; // red channel
  assert.equal(px(16, 16), 220);  // top-left of padded border is red
  assert.equal(px(30, 30), 255);  // interior untouched (white)
});

test('extractTextLines strips tags/scripts and decodes entities', () => {
  const html = `<html><head><style>.x{}</style></head><body>
    <script>var a=1;</script>
    <div>Email &#x2014; Email sender not connected</div>
    <p>Total &amp; more</p></body></html>`;
  const lines = extractTextLines(html);
  assert.ok(lines.includes('Email — Email sender not connected'));
  assert.ok(lines.includes('Total & more'));
  assert.ok(!lines.some((l) => l.includes('var a=1')));
});

test('htmlDiff reports added and removed visible lines (multiset)', () => {
  const base = '<div>Summary</div><div>Old block</div><div>Twice</div>';
  const head = '<div>Summary</div><div>New block</div><div>Twice</div><div>Twice</div>';
  const { added, removed } = htmlDiff(base, head);
  assert.deepEqual(added.sort(), ['New block', 'Twice']);
  assert.deepEqual(removed, ['Old block']);
});

test('attachHtmlDiffs decorates changed screens from snapshot files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vp-hd-'));
  await writeFile(join(dir, 'b.html'), '<div>Same</div>');
  await writeFile(join(dir, 'h.html'), '<div>Same</div><div>Email sender not connected</div>');
  const explained = [
    { key: 'k', status: 'changed', base: { html: 'b.html' }, head: { html: 'h.html' } },
    { key: 'skip', status: 'added', head: { html: 'h.html' } },
  ];
  await attachHtmlDiffs(explained, dir, dir);
  assert.deepEqual(explained[0].htmlChanges.added, ['Email sender not connected']);
  assert.equal(explained[1].htmlChanges, undefined);
});

test('digit-only differences pair off as noise; real changes survive', () => {
  const base = '<div>loadedAt: 1783014227000</div><div>Old feature</div>';
  const head = '<div>loadedAt: 1783016593000</div><div>New feature</div>';
  const { added, removed } = htmlDiff(base, head);
  assert.deepEqual(added, ['New feature']);
  assert.deepEqual(removed, ['Old feature']);
});
