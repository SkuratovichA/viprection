import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildPrIndexHtml,
  buildRootIndexHtml,
  classifyEntries,
  entriesFromExplained,
  entriesFromScan,
  fetchPrStates,
  writeRootIndex,
} from '../src/index-pages.mjs';

const REPO = 'acme/widgets';

test('classifyEntries splits branch dirs from pr dirs and orders them', () => {
  const { branches, prs } = classifyEntries(['pr-9', 'dev', 'pr-101', 'main', 'pr-x']);
  assert.deepEqual(branches, ['dev', 'main', 'pr-x']); // non-numeric pr-x is a branch name
  assert.deepEqual(prs, [101, 9]); // newest first
});

test('root index groups PRs by state and never links branches as PRs', () => {
  const states = new Map([
    [101, { state: 'open', title: 'Add <widgets> & things' }],
    [9, { state: 'merged', title: 'Old work' }],
    [7, { state: 'closed', title: 'Abandoned' }],
  ]);
  const html = buildRootIndexHtml({ repo: REPO, branches: ['dev'], prs: [101, 9, 7], states });

  const openAt = html.indexOf('Open pull requests');
  const mergedAt = html.indexOf('Merged pull requests');
  const closedAt = html.indexOf('Closed without merging');
  assert.ok(html.indexOf('Branch galleries') < openAt < mergedAt && mergedAt < closedAt);

  assert.match(html, /href="\.\/dev\/index\.html"/);
  assert.match(html, /href="\.\/pr-101\/index\.html"/);
  assert.match(html, /href="https:\/\/github\.com\/acme\/widgets\/pull\/101"/);
  assert.ok(html.includes('Add &lt;widgets&gt; &amp; things'), 'titles are HTML-escaped');
  // The branch section must not contain pr links (the original bug).
  const branchSection = html.slice(html.indexOf('Branch galleries'), openAt);
  assert.ok(!branchSection.includes('pr-'), 'branch section lists only branch galleries');
});

test('root index falls back to one stateless PR section without states', () => {
  const states = new Map([[5, null]]);
  const html = buildRootIndexHtml({ repo: REPO, branches: [], prs: [5], states });
  assert.ok(html.includes('>Pull requests<'), 'stateless bucket rendered');
  assert.ok(!html.includes('Open pull requests'));
  assert.match(html, /visual diff for pull request #5/);
});

test('fetchPrStates maps API answers and degrades per-PR on failure', async () => {
  const api = async (path) => {
    if (path.endsWith('/1')) return { state: 'open', draft: false, title: 'One', merged_at: null };
    if (path.endsWith('/2')) return { state: 'closed', merged_at: '2026-01-01', title: 'Two' };
    if (path.endsWith('/3')) return { state: 'open', draft: true, title: 'Three', merged_at: null };
    throw new Error('boom');
  };
  const states = await fetchPrStates(REPO, [1, 2, 3, 4], { token: 't', api });
  assert.equal(states.get(1).state, 'open');
  assert.equal(states.get(2).state, 'merged');
  assert.equal(states.get(3).state, 'draft');
  assert.equal(states.get(4), null);
  // Without a token there is no API call at all.
  const offline = await fetchPrStates(REPO, [1], { api });
  assert.equal(offline.get(1), null);
});

test('entriesFromExplained maps uploader results to relative page paths', () => {
  const [e] = entriesFromExplained([
    {
      key: 'dashboard__populated',
      status: 'changed',
      explanation: '6% of pixels differ — likely related to `Dash.tsx`.',
      base: { png: './dashboard/01-populated.png' },
      head: { png: './dashboard/01-populated.png' },
      diffPngName: 'dashboard__populated.diff.png',
      annotatedPngName: 'dashboard__populated.annotated.png',
    },
  ]);
  assert.equal(e.basePng, 'base/dashboard/01-populated.png');
  assert.equal(e.headPng, 'head/dashboard/01-populated.png');
  assert.equal(e.diffPng, 'diff/dashboard__populated.diff.png');
  assert.equal(e.annotatedPng, 'annotated/dashboard__populated.annotated.png');
});

test('pr page renders pairs, escapes prose, and handles added screens', () => {
  const html = buildPrIndexHtml({
    repo: REPO,
    prNumber: 42,
    info: { state: 'open', title: 'Chips <everywhere>' },
    entries: [
      {
        key: 'a__b',
        status: 'changed',
        explanation: 'region ~10×10px — likely related to `B.tsx`.',
        basePng: 'base/a/01-b.png',
        annotatedPng: 'annotated/a__b.annotated.png',
        headPng: 'head/a/01-b.png',
        diffPng: 'diff/a__b.diff.png',
      },
      { key: 'a__new', status: 'added', headPng: 'head/a/02-new.png' },
    ],
  });
  assert.ok(html.includes('Chips &lt;everywhere&gt;'));
  assert.ok(html.includes('<code>B.tsx</code>'), 'backticked prose becomes <code>');
  assert.match(html, /href="\.\/diff\/a__b\.diff\.png"/);
  assert.ok(html.includes('New screen — no previous version'), 'added screen renders an empty Before');
  assert.match(html, /https:\/\/github\.com\/acme\/widgets\/pull\/42/);
});

test('entriesFromScan reconstructs entries from an uploaded pr dir layout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vp-scan-'));
  await mkdir(join(dir, 'base/dashboard'), { recursive: true });
  await mkdir(join(dir, 'head/dashboard'), { recursive: true });
  await mkdir(join(dir, 'annotated'), { recursive: true });
  await mkdir(join(dir, 'diff'), { recursive: true });
  await writeFile(join(dir, 'base/dashboard/01-populated.png'), 'x');
  await writeFile(join(dir, 'head/dashboard/01-populated.png'), 'x');
  await writeFile(join(dir, 'annotated/dashboard__populated.annotated.png'), 'x');
  await writeFile(join(dir, 'diff/dashboard__populated.diff.png'), 'x');
  await writeFile(join(dir, 'head/dashboard/09-fresh.png'), 'x'); // head-only → added

  const entries = await entriesFromScan(dir);
  assert.deepEqual(
    entries.map((e) => [e.key, e.status]),
    [
      ['dashboard__fresh', 'added'],
      ['dashboard__populated', 'changed'],
    ],
  );
  const populated = entries[1];
  assert.equal(populated.basePng, 'base/dashboard/01-populated.png');
  assert.equal(populated.annotatedPng, 'annotated/dashboard__populated.annotated.png');
  assert.equal(populated.diffPng, 'diff/dashboard__populated.diff.png');
});

test('writeRootIndex scans a worktree and honors statesByPr overrides', async () => {
  const wt = await mkdtemp(join(tmpdir(), 'vp-root-'));
  await mkdir(join(wt, 'dev'));
  await mkdir(join(wt, 'pr-7'));
  await mkdir(join(wt, '.git')); // dot-dirs are ignored
  await writeRootIndex(wt, REPO, { statesByPr: new Map([[7, { state: 'merged', title: 'Done' }]]) });
  const html = await readFile(join(wt, 'index.html'), 'utf8');
  assert.match(html, /Branch galleries/);
  assert.match(html, /Merged pull requests/);
  assert.ok(!html.includes('.git'));
});
