// Comment grouping by LOGICAL screen with per-viewport sub-sections + link-mode.
// Pure (no env, no I/O): builds `explained`-shaped arrays and asserts the
// markdown structure renderComment produces.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderComment } from '../src/comment.mjs';

// A fake resolver — any path becomes a stable URL.
const urlFor = (p) => `https://example.test/${p}`;

// Minimal explained-item factory. Viewport lives on head/base (authoritative on
// the object), the file suffix mirrors the writer. Desktop → bare key.
function item({ section = '01', name = 'home', viewport = 'desktop', status = 'changed', diffRatio = 0.02 }) {
  const suffix = viewport === 'desktop' ? '' : `@${viewport}`;
  const key = `${section}/${name}${suffix}`;
  const vpSuffix = viewport === 'desktop' ? '' : `@${viewport}`;
  const png = `./${section}/${name}${vpSuffix}.png`;
  const entry = (side) => ({ name, route: `/${name}`, caption: name, png, viewport, side });
  const base = status === 'added' ? null : entry('base');
  const head = status === 'removed' ? null : entry('head');
  return {
    key,
    status,
    explanation: `**${status}** ${(diffRatio * 100).toFixed(1)}% of pixels differ.`,
    htmlChanges: null,
    base,
    head,
    diffRatio,
    diffPngName: status === 'changed' ? `${section}__${name}${suffix}.diff.png` : null,
    annotatedPngName: null,
  };
}

// A report shell with a viewports matrix (desktop first, mobile second).
function reportFor(explained, viewports = [{ name: 'desktop' }, { name: 'mobile' }]) {
  const summary = { added: 0, removed: 0, changed: 0, failed: 0, unchanged: 3 };
  for (const r of explained) summary[r.status] = (summary[r.status] ?? 0) + 1;
  return { summary, viewports };
}

test('a screen changed at desktop+mobile renders ONE <details> with a 🖥 and a 📱 sub-section', () => {
  const explained = [
    item({ name: 'home', viewport: 'desktop', status: 'changed' }),
    item({ name: 'home', viewport: 'mobile', status: 'changed' }),
  ];
  const md = renderComment({ report: reportFor(explained), explained, urlFor });

  // Exactly one <details> for the single logical screen.
  const detailsCount = (md.match(/<details/g) || []).length;
  assert.equal(detailsCount, 1, 'desktop+mobile of one screen collapse into ONE <details>');
  // The summary title carries the base key (no @suffix) once.
  assert.ok(md.includes('`01/home`'), 'summary title is the logical base key');
  assert.ok(!md.includes('01/home@mobile`'), 'the @mobile suffix is not in the summary title');
  // Both device sub-sections present.
  assert.ok(md.includes('🖥 Desktop'), 'desktop sub-section badge');
  assert.ok(md.includes('📱 mobile'), 'mobile sub-section badge');
});

test('a screen added at mobile only shows a 📱 sub-section marked added', () => {
  const explained = [item({ name: 'settings', viewport: 'mobile', status: 'added' })];
  const md = renderComment({ report: reportFor(explained), explained, urlFor });

  assert.equal((md.match(/<details/g) || []).length, 1, 'one bucket for the mobile-only screen');
  assert.ok(md.includes('`01/settings`'), 'base key in title');
  assert.ok(md.includes('📱 mobile'), 'the mobile device sub-section is shown');
  // Single-variant bucket → status is uniform → summary line reads "added".
  assert.ok(md.includes('— added'), "the bucket's overall status is added");
  assert.ok(!md.includes('🖥 Desktop'), 'no desktop sub-section when the screen is mobile-only');
});

test('mixed statuses across viewports: per-device status is annotated', () => {
  // Desktop changed, mobile newly added → bucket status is "multiple", each
  // device sub-heading carries its own status.
  const explained = [
    item({ name: 'home', viewport: 'desktop', status: 'changed' }),
    item({ name: 'home', viewport: 'mobile', status: 'added' }),
  ];
  const md = renderComment({ report: reportFor(explained), explained, urlFor });
  assert.equal((md.match(/<details/g) || []).length, 1, 'still one logical screen');
  assert.ok(md.includes('— multiple'), 'summary reflects the mixed statuses');
  // The mobile sub-heading names its own status.
  assert.match(md, /📱 mobile[^\n]*added/, 'mobile sub-heading annotated as added');
});

test('inlineImages=false renders NO <img> tags and uses [view]( links', () => {
  const explained = [item({ name: 'home', viewport: 'desktop', status: 'changed' })];
  const md = renderComment({ report: reportFor(explained), explained, urlFor, inlineImages: false });

  assert.ok(!md.includes('<img'), 'link-mode emits no inline <img> tags');
  assert.ok(md.includes('[view]('), 'link-mode emits compact [view]( image links');
  assert.ok(md.includes('Before: [view]('), 'before link present');
  assert.ok(md.includes('After: [view]('), 'after link present');
  assert.ok(md.includes('[raw diff]('), 'raw diff link present');
});

test('inlineImages=true (default) still renders an <img> Before|After table', () => {
  const explained = [item({ name: 'home', viewport: 'desktop', status: 'changed' })];
  const md = renderComment({ report: reportFor(explained), explained, urlFor });
  assert.ok(md.includes('<img'), 'inline mode emits <img> tags');
  assert.ok(md.includes('Before'), 'Before column');
  assert.ok(md.includes('After'), 'After column');
});

test('open-limit counts SCREENS: 8 screens (16 device-rows) → exactly 6 <details open>', () => {
  const explained = [];
  for (let i = 0; i < 8; i++) {
    const name = `screen${i}`;
    explained.push(item({ name, viewport: 'desktop', status: 'changed', diffRatio: (8 - i) / 100 }));
    explained.push(item({ name, viewport: 'mobile', status: 'changed', diffRatio: (8 - i) / 100 }));
  }
  const md = renderComment({ report: reportFor(explained), explained, urlFor });

  const totalDetails = (md.match(/<details/g) || []).length;
  const openDetails = (md.match(/<details open>/g) || []).length;
  assert.equal(totalDetails, 8, '8 logical screens → 8 <details>, not 16 device-rows');
  assert.equal(openDetails, 6, 'exactly OPEN_LIMIT=6 screens start open');
});

test('within a bucket, Desktop is ordered before other viewports', () => {
  // Feed mobile FIRST in the explained order; desktop must still render first.
  const explained = [
    item({ name: 'home', viewport: 'mobile', status: 'changed' }),
    item({ name: 'home', viewport: 'desktop', status: 'changed' }),
  ];
  const md = renderComment({ report: reportFor(explained), explained, urlFor });
  assert.ok(md.indexOf('🖥 Desktop') < md.indexOf('📱 mobile'), 'desktop sub-section precedes mobile');
});
