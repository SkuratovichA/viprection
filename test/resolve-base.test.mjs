import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveBase } from '../src/resolve-base.mjs';

const VERSIONS = { tool: 'tool@1', browser: 'chromium@1' };

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** Tiny repo: c1 (ui.txt) → c2 (docs only) → c3 (ui change). */
async function makeRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'vp-rb-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  await mkdir(join(dir, 'ui'), { recursive: true });
  await writeFile(join(dir, 'ui', 'a.txt'), '1');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'c1');
  const c1 = git(dir, 'rev-parse', 'HEAD');
  await writeFile(join(dir, 'README.md'), 'docs');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'c2');
  const c2 = git(dir, 'rev-parse', 'HEAD');
  await writeFile(join(dir, 'ui', 'a.txt'), '2');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'c3');
  const c3 = git(dir, 'rev-parse', 'HEAD');
  return { dir, c1, c2, c3 };
}

async function writeMeta(dir, meta) {
  const p = join(dir, 'preview-meta.json');
  await writeFile(p, JSON.stringify(meta));
  return p;
}

const baseArgs = (repo, metaPath) => ({
  config: { uiGlobs: ['ui/**'] },
  publishedMetaPath: metaPath,
  publishedDir: '/published',
  freshBaseDir: '/fresh',
  repoDir: repo.dir,
  currentVersions: VERSIONS,
});

test('no merge-base → none', async () => {
  const repo = await makeRepo();
  const meta = await writeMeta(repo.dir, {});
  const r = await resolveBase({ ...baseArgs(repo, meta), mergeBaseSha: null });
  assert.equal(r.mode, 'none');
});

test('missing meta → capture-base', async () => {
  const repo = await makeRepo();
  const r = await resolveBase({
    ...baseArgs(repo, join(repo.dir, 'nope.json')),
    mergeBaseSha: repo.c3,
  });
  assert.equal(r.mode, 'capture-base');
  assert.equal(r.baseDir, '/fresh');
});

test('version mismatch → capture-base', async () => {
  const repo = await makeRepo();
  const meta = await writeMeta(repo.dir, {
    capturedAtSha: repo.c3,
    toolVersion: 'tool@0',
    browserVersion: VERSIONS.browser,
  });
  const r = await resolveBase({ ...baseArgs(repo, meta), mergeBaseSha: repo.c3 });
  assert.equal(r.mode, 'capture-base');
  assert.match(r.reason, /version mismatch/);
});

test('exact merge-base SHA → reuse', async () => {
  const repo = await makeRepo();
  const meta = await writeMeta(repo.dir, {
    capturedAtSha: repo.c3,
    toolVersion: VERSIONS.tool,
    browserVersion: VERSIONS.browser,
  });
  const r = await resolveBase({ ...baseArgs(repo, meta), mergeBaseSha: repo.c3 });
  assert.equal(r.mode, 'reuse');
  assert.equal(r.baseDir, '/published');
});

test('ancestor with only non-UI changes in between → reuse', async () => {
  const repo = await makeRepo();
  // published at c1, merge-base c2: only README.md changed → visually identical
  const meta = await writeMeta(repo.dir, {
    capturedAtSha: repo.c1,
    toolVersion: VERSIONS.tool,
    browserVersion: VERSIONS.browser,
  });
  const r = await resolveBase({ ...baseArgs(repo, meta), mergeBaseSha: repo.c2 });
  assert.equal(r.mode, 'reuse');
  assert.match(r.reason, /no UI-affecting/);
});

test('ancestor with UI changes in between → capture-base', async () => {
  const repo = await makeRepo();
  // published at c1, merge-base c3: ui/a.txt changed → must re-capture
  const meta = await writeMeta(repo.dir, {
    capturedAtSha: repo.c1,
    toolVersion: VERSIONS.tool,
    browserVersion: VERSIONS.browser,
  });
  const r = await resolveBase({ ...baseArgs(repo, meta), mergeBaseSha: repo.c3 });
  assert.equal(r.mode, 'capture-base');
  assert.match(r.reason, /UI-affecting/);
});

test('descendant with only non-UI changes in between → reuse', async () => {
  const repo = await makeRepo();
  // published at c2 (base branch moved past the merge-base), merge-base c1:
  // only README.md landed in c1..c2 → the newer gallery is still pixel-valid.
  const meta = await writeMeta(repo.dir, {
    capturedAtSha: repo.c2,
    toolVersion: VERSIONS.tool,
    browserVersion: VERSIONS.browser,
  });
  const r = await resolveBase({ ...baseArgs(repo, meta), mergeBaseSha: repo.c1 });
  assert.equal(r.mode, 'reuse');
  assert.match(r.reason, /descendant.*no UI-affecting/);
});

test('descendant with UI changes in between → capture-base', async () => {
  const repo = await makeRepo();
  // published at c3, merge-base c1: ui/a.txt changed in c1..c3 → must re-capture
  const meta = await writeMeta(repo.dir, {
    capturedAtSha: repo.c3,
    toolVersion: VERSIONS.tool,
    browserVersion: VERSIONS.browser,
  });
  const r = await resolveBase({ ...baseArgs(repo, meta), mergeBaseSha: repo.c1 });
  assert.equal(r.mode, 'capture-base');
  assert.match(r.reason, /UI-affecting/);
});

test('truly diverged published SHA → capture-base', async () => {
  const repo = await makeRepo();
  // A side branch off c1: its tip is neither ancestor nor descendant of c3.
  git(repo.dir, 'checkout', '-q', '-b', 'side', repo.c1);
  await writeFile(join(repo.dir, 'side.md'), 'side');
  git(repo.dir, 'add', '.');
  git(repo.dir, 'commit', '-qm', 'side');
  const side = git(repo.dir, 'rev-parse', 'HEAD');
  const meta = await writeMeta(repo.dir, {
    capturedAtSha: side,
    toolVersion: VERSIONS.tool,
    browserVersion: VERSIONS.browser,
  });
  const r = await resolveBase({ ...baseArgs(repo, meta), mergeBaseSha: repo.c3 });
  assert.equal(r.mode, 'capture-base');
  assert.match(r.reason, /diverged/);
});

test('unknown SHA in meta degrades safely → capture-base', async () => {
  const repo = await makeRepo();
  const meta = await writeMeta(repo.dir, {
    capturedAtSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    toolVersion: VERSIONS.tool,
    browserVersion: VERSIONS.browser,
  });
  const r = await resolveBase({ ...baseArgs(repo, meta), mergeBaseSha: repo.c2 });
  assert.equal(r.mode, 'capture-base');
});

test('browser PATCH drift across runners does not break reuse (series match)', async () => {
  const repo = await makeRepo();
  const meta = await writeMeta(repo.dir, {
    capturedAtSha: repo.c3,
    toolVersion: VERSIONS.tool,
    browserVersion: 'Google Chrome 149.0.7827.200',
  });
  const r = await resolveBase({
    ...baseArgs(repo, meta),
    mergeBaseSha: repo.c3,
    currentVersions: { tool: VERSIONS.tool, browser: 'Google Chrome 149.0.7827.155' },
  });
  assert.equal(r.mode, 'reuse'); // same 149.0 series → patch drift tolerated
});

test('browser MAJOR bump still forces capture-base', async () => {
  const repo = await makeRepo();
  const meta = await writeMeta(repo.dir, {
    capturedAtSha: repo.c3,
    toolVersion: VERSIONS.tool,
    browserVersion: 'Google Chrome 149.0.7827.200',
  });
  const r = await resolveBase({
    ...baseArgs(repo, meta),
    mergeBaseSha: repo.c3,
    currentVersions: { tool: VERSIONS.tool, browser: 'Google Chrome 150.0.8001.10' },
  });
  assert.equal(r.mode, 'capture-base');
  assert.match(r.reason, /browser series mismatch/);
});
