import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_VIEWPORT,
  DEFAULT_VIEWPORTS,
  entryViewport,
  screenKey,
  parseScreenKey,
  screenKeyToFilename,
  parseScreenFile,
  stripOrderPrefix,
  normalizeViewports,
  manifestViewports,
} from '../src/schema.mjs';
import { validateConfig } from '../src/config-schema.mjs';

// ---------- screenKey ----------

test('screenKey: desktop stays unsuffixed (legacy pairing invariant)', () => {
  assert.equal(screenKey({ section: '06-admin', name: '03-users' }), '06-admin/03-users');
  assert.equal(
    screenKey({ section: '06-admin', name: '03-users', viewport: 'desktop' }),
    '06-admin/03-users'
  );
});

test('screenKey: non-default viewport gets @suffix', () => {
  assert.equal(
    screenKey({ section: '06-admin', name: '03-users', viewport: 'mobile' }),
    '06-admin/03-users@mobile'
  );
});

test('screenKey: throws without section or name', () => {
  assert.throws(() => screenKey({ name: 'x' }));
  assert.throws(() => screenKey({ section: 's' }));
});

// ---------- parseScreenKey ----------

test('parseScreenKey: roundtrips desktop and mobile', () => {
  assert.deepEqual(parseScreenKey('06-admin/03-users'), {
    section: '06-admin',
    name: '03-users',
    viewport: 'desktop',
  });
  assert.deepEqual(parseScreenKey('06-admin/03-users@mobile'), {
    section: '06-admin',
    name: '03-users',
    viewport: 'mobile',
  });
});

test('parseScreenKey: normalizes a non-canonical @desktop away', () => {
  assert.deepEqual(parseScreenKey('a/b@desktop'), { section: 'a', name: 'b', viewport: 'desktop' });
});

test('parseScreenKey: @ with a non-slug suffix stays in the name', () => {
  assert.deepEqual(parseScreenKey('a/user@Example.Com'), {
    section: 'a',
    name: 'user@Example.Com',
    viewport: 'desktop',
  });
});

// ---------- screenKeyToFilename ----------

test('screenKeyToFilename: keeps @, maps / to __, collapses runs', () => {
  assert.equal(screenKeyToFilename('06-admin/03-users@mobile'), '06-admin__03-users@mobile');
  assert.equal(screenKeyToFilename('a/b c*d'), 'a__b__c__d');
  assert.equal(screenKeyToFilename('a//b'), 'a__b');
});

test('screenKeyToFilename: parity with the two legacy sanitizers on desktop keys', () => {
  const key = '03-customer/02-order-detail';
  assert.equal(screenKeyToFilename(key), key.replace(/\//g, '__'));
  assert.equal(screenKeyToFilename(key), key.replace(/[^a-zA-Z0-9._-]+/g, '__'));
});

// ---------- parseScreenFile ----------

test('parseScreenFile: flat sanitized diff/annotated names', () => {
  assert.deepEqual(parseScreenFile('06-admin__03-users@mobile.diff.png'), {
    section: '06-admin',
    name: '03-users',
    viewport: 'mobile',
    kind: 'diff',
    ext: 'png',
  });
  assert.deepEqual(parseScreenFile('06-admin__03-users.annotated.png'), {
    section: '06-admin',
    name: '03-users',
    viewport: 'desktop',
    kind: 'annotated',
    ext: 'png',
  });
});

test('parseScreenFile: repo-style relative paths keep the real section', () => {
  assert.deepEqual(parseScreenFile('06-admin/03-users@mobile.png'), {
    section: '06-admin',
    name: '03-users',
    viewport: 'mobile',
    kind: 'plain',
    ext: 'png',
  });
});

test('parseScreenFile: pr-diff bucket dirs are not sections', () => {
  const parsed = parseScreenFile('base/06-admin__03-users.png');
  assert.equal(parsed.section, '06-admin');
  assert.equal(parsed.name, '03-users');
});

test('parseScreenFile: html snapshots', () => {
  const parsed = parseScreenFile('01-public/01-landing.html');
  assert.deepEqual(parsed, {
    section: '01-public',
    name: '01-landing',
    viewport: 'desktop',
    kind: 'plain',
    ext: 'html',
  });
});

test('stripOrderPrefix', () => {
  assert.equal(stripOrderPrefix('03-users'), 'users');
  assert.equal(stripOrderPrefix('users'), 'users');
});

// ---------- viewports ----------

test('normalizeViewports: fills deviceScaleFactor, keeps emulation knobs', () => {
  const [d, m] = normalizeViewports([
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'mobile', width: 390, height: 844, isMobile: true, hasTouch: true },
  ]);
  assert.equal(d.deviceScaleFactor, 2);
  assert.deepEqual(m, {
    name: 'mobile',
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
});

test('normalizeViewports: rejects bad names, duplicates, missing sizes', () => {
  assert.throws(() => normalizeViewports([{ name: 'Mobile', width: 1, height: 1 }]));
  assert.throws(() =>
    normalizeViewports([
      { name: 'mobile', width: 1, height: 1 },
      { name: 'mobile', width: 2, height: 2 },
    ])
  );
  assert.throws(() => normalizeViewports([{ name: 'mobile', width: 1 }]));
  assert.throws(() => normalizeViewports([]));
});

test('manifestViewports: legacy manifest falls back to the desktop default', () => {
  assert.deepEqual(manifestViewports({}), [...DEFAULT_VIEWPORTS]);
  assert.equal(DEFAULT_VIEWPORTS[0].name, DEFAULT_VIEWPORT);
});

test('manifestViewports: echo passes through normalization', () => {
  const echo = manifestViewports({
    viewports: [{ name: 'desktop', width: 1440, height: 900, deviceScaleFactor: 2 }],
  });
  assert.equal(echo[0].width, 1440);
});

test('entryViewport: legacy entries are desktop', () => {
  assert.equal(entryViewport({ name: 'x' }), 'desktop');
  assert.equal(entryViewport({ name: 'x', viewport: 'mobile' }), 'mobile');
});

// ---------- config validation ----------

const BASE_CFG = {
  up: 'true',
  capture: 'x',
  down: 'true',
  outputDir: 'out',
  healthchecks: ['http://localhost:1'],
  uiGlobs: ['src/**'],
};

test('validateConfig: accepts viewports + publicBaseUrl', () => {
  const errs = validateConfig({
    ...BASE_CFG,
    publicBaseUrl: 'https://preview.dev.busano.cz',
    viewports: [
      { name: 'desktop', width: 1440, height: 900 },
      { name: 'mobile', width: 390, height: 844 },
    ],
  });
  assert.deepEqual(errs, []);
});

test('validateConfig: rejects bad publicBaseUrl', () => {
  assert.ok(validateConfig({ ...BASE_CFG, publicBaseUrl: 'http://x' }).length > 0);
  assert.ok(validateConfig({ ...BASE_CFG, publicBaseUrl: 'https://x/' }).length > 0);
});

test('validateConfig: surfaces viewport problems as errors, not throws', () => {
  const errs = validateConfig({ ...BASE_CFG, viewports: [{ name: 'BAD', width: 1, height: 1 }] });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /name must match/);
});
