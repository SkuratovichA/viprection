import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  prepareBase,
  computeMergeBase,
  commitEpochMs,
  frozenEpochFor,
} from '../src/prepare-base.mjs';
import { resolveFrozenEpoch } from '../src/capture.mjs';

const VERSIONS = { tool: 'tool@1', browser: 'chromium@1' };

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/**
 * "origin" repo: main @ c1 (ui/a.txt = "1"). Optionally a `previews` branch
 * laid out exactly like publish.mjs produces: one subfolder per source branch
 * with manifest.json + preview-meta.json.
 */
async function makeOrigin({ previews, baseConfig } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'vp-pb-origin-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  await mkdir(join(dir, 'ui'), { recursive: true });
  await writeFile(join(dir, 'ui', 'a.txt'), '1');
  if (baseConfig) {
    // Adoption existed at the base commit (the normal steady-state case).
    await writeFile(join(dir, 'visual-preview.config.json'), JSON.stringify(baseConfig));
  }
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'c1');
  const c1 = git(dir, 'rev-parse', 'HEAD');
  if (previews) {
    git(dir, 'checkout', '-q', '--orphan', 'previews');
    git(dir, 'rm', '-rfq', '.');
    await mkdir(join(dir, 'main'), { recursive: true });
    await writeFile(join(dir, 'main', 'manifest.json'), JSON.stringify({ project: 'T', sections: [] }));
    await writeFile(
      join(dir, 'main', 'preview-meta.json'),
      JSON.stringify({ capturedAtSha: c1, toolVersion: VERSIONS.tool, browserVersion: VERSIONS.browser })
    );
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'previews');
    git(dir, 'checkout', '-q', 'main');
  }
  return { dir, c1 };
}

/** Clone origin, branch off a "PR head" with a UI change, drop in a config. */
async function makePrClone(originDir, config) {
  const dir = await mkdtemp(join(tmpdir(), 'vp-pb-clone-'));
  execFileSync('git', ['clone', '-q', originDir, dir]);
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'checkout', '-qb', 'feature');
  await writeFile(join(dir, 'ui', 'a.txt'), '2');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'c2');
  const cfgPath = join(dir, 'visual-preview.config.json');
  await writeFile(cfgPath, JSON.stringify(config));
  return { dir, cfgPath };
}

const CONFIG = {
  up: 'true',
  capture: 'true',
  down: 'true',
  outputDir: 'shots',
  uiGlobs: ['ui/**'],
  healthchecks: [],
  clock: { freeze: true },
};

/** Point GITHUB_OUTPUT/GITHUB_ENV at temp files; return parsed contents after fn. */
async function withGithubFiles(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'vp-pb-gh-'));
  const outPath = join(dir, 'output.txt');
  const envPath = join(dir, 'env.txt');
  await writeFile(outPath, '');
  await writeFile(envPath, '');
  const prev = { out: process.env.GITHUB_OUTPUT, env: process.env.GITHUB_ENV };
  process.env.GITHUB_OUTPUT = outPath;
  process.env.GITHUB_ENV = envPath;
  try {
    const result = await fn();
    return { result, outputs: parseKv(await readFile(outPath, 'utf8')), env: parseKv(await readFile(envPath, 'utf8')) };
  } finally {
    if (prev.out === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = prev.out;
    if (prev.env === undefined) delete process.env.GITHUB_ENV;
    else process.env.GITHUB_ENV = prev.env;
  }
}

function parseKv(text) {
  return Object.fromEntries(
    text.split('\n').filter(Boolean).map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1)];
    })
  );
}

test('merge-base + frozen epoch computed from the merge-base commit', async () => {
  const origin = await makeOrigin();
  const { dir } = await makePrClone(origin.dir, CONFIG);

  const mergeBase = computeMergeBase('main', dir);
  assert.equal(mergeBase, origin.c1);

  const secs = Number(git(dir, 'show', '-s', '--format=%ct', origin.c1));
  assert.equal(commitEpochMs(origin.c1, dir), secs * 1000);
  assert.equal(frozenEpochFor({ clock: { freeze: true } }, origin.c1, dir), secs * 1000);
  assert.equal(frozenEpochFor({}, origin.c1, dir), null);
  assert.equal(
    frozenEpochFor({ clock: { freeze: true, source: 'fixed', fixedEpochMs: 42 } }, origin.c1, dir),
    42
  );
});

test('no merge-base → vp-mode=none, nothing exported for pr-diff', async () => {
  const origin = await makeOrigin({ baseConfig: CONFIG });
  const { dir, cfgPath } = await makePrClone(origin.dir, CONFIG);

  const { result, outputs, env } = await withGithubFiles(() =>
    prepareBase({ configPath: cfgPath, baseRef: 'does-not-exist', repoDir: dir })
  );
  assert.equal(result.mode, 'none');
  assert.equal(result.baseDir, null);
  assert.equal(outputs['vp-mode'], 'none');
  assert.equal(outputs['vp-base-dir'], '');
  assert.equal(env.VP_MERGE_BASE_SHA, undefined);
});

test('published previews branch (publish.mjs layout) resolves VP_PUBLISHED_* → reuse', async () => {
  const origin = await makeOrigin({ previews: true });
  const { dir, cfgPath } = await makePrClone(origin.dir, CONFIG);

  const { result, outputs, env } = await withGithubFiles(() =>
    prepareBase({
      configPath: cfgPath,
      baseRef: 'main',
      pagesBranch: 'previews',
      repoDir: dir,
      currentVersions: VERSIONS,
    })
  );

  assert.equal(result.mode, 'reuse');
  const expectedDir = join(dir, '.viprection', 'published', 'main');
  assert.equal(result.baseDir, expectedDir);
  // The worktree really holds the per-branch subfolder from the pages branch.
  assert.ok(existsSync(join(expectedDir, 'manifest.json')));
  assert.equal(env.VP_PUBLISHED_DIR, expectedDir);
  assert.equal(env.VP_PUBLISHED_META, join(expectedDir, 'preview-meta.json'));
  assert.ok(existsSync(env.VP_PUBLISHED_META));
  assert.equal(env.VP_MERGE_BASE_SHA, origin.c1);
  assert.equal(outputs['vp-mode'], 'reuse');
  assert.equal(outputs['vp-base-dir'], expectedDir);
  assert.equal(outputs['vp-frozen-epoch-ms'], env.CAPTURE_FROZEN_EPOCH_MS);
});

test('capture-base fallback: lifecycle runs inside a merge-base worktree with the frozen epoch', async () => {
  const origin = await makeOrigin({ baseConfig: CONFIG }); // no previews branch → published unavailable
  const config = {
    ...CONFIG,
    install: 'echo installed > installed.txt',
    capture:
      'mkdir -p shots' +
      ' && cp installed.txt shots/installed.txt' +
      ' && cp ui/a.txt shots/ui.txt' +
      ' && printf "%s" "$CAPTURE_FROZEN_EPOCH_MS" > shots/epoch.txt' +
      ' && printf \'{"project":"T","sections":[]}\' > shots/manifest.json',
    down: 'touch shots/down-ran.txt',
  };
  const { dir, cfgPath } = await makePrClone(origin.dir, config);

  const { result, outputs, env } = await withGithubFiles(() =>
    prepareBase({ configPath: cfgPath, baseRef: 'main', repoDir: dir })
  );

  assert.equal(result.mode, 'capture-base');
  const baseDir = join(dir, '.viprection', 'base');
  assert.equal(result.baseDir, baseDir);
  assert.equal(env.VP_BASE_DIR, baseDir);
  assert.equal(outputs['vp-mode'], 'capture-base');

  // capture ran AT THE MERGE-BASE (ui/a.txt was "1" there, "2" at head)…
  assert.equal(await readFile(join(baseDir, 'ui.txt'), 'utf8'), '1');
  // …after install, with the SAME frozen epoch head will get, and down ran.
  assert.ok(existsSync(join(baseDir, 'installed.txt')));
  assert.equal(await readFile(join(baseDir, 'epoch.txt'), 'utf8'), String(result.frozenEpochMs));
  assert.equal(env.CAPTURE_FROZEN_EPOCH_MS, String(result.frozenEpochMs));
  assert.ok(existsSync(join(baseDir, 'down-ran.txt')));
  assert.ok(existsSync(join(baseDir, 'manifest.json')));
  // The scratch worktree is cleaned up after the copy.
  assert.ok(!existsSync(join(dir, '.viprection', 'base-src')));
});

test('capture-base fallback disabled → vp-mode=none but the epoch still exports', async () => {
  const origin = await makeOrigin({ baseConfig: CONFIG });
  const { dir, cfgPath } = await makePrClone(origin.dir, CONFIG);

  const { result, outputs, env } = await withGithubFiles(() =>
    prepareBase({ configPath: cfgPath, baseRef: 'main', repoDir: dir, captureBaseFallback: false })
  );

  assert.equal(result.mode, 'none');
  assert.equal(outputs['vp-mode'], 'none');
  // pr-diff must take its baseline path → no merge-base exported…
  assert.equal(env.VP_MERGE_BASE_SHA, undefined);
  // …but the head capture stays deterministic.
  assert.equal(env.CAPTURE_FROZEN_EPOCH_MS, String(result.frozenEpochMs));
  assert.ok(!existsSync(join(dir, '.viprection', 'base', 'manifest.json')));
});

test('capture.mjs resolveFrozenEpoch prefers the prepare-base env over recomputing', () => {
  process.env.CAPTURE_FROZEN_EPOCH_MS = '1700000000000';
  try {
    assert.equal(resolveFrozenEpoch({ clock: { freeze: true } }), 1700000000000);
    // fixed source still wins over the env (config is explicit).
    assert.equal(
      resolveFrozenEpoch({ clock: { freeze: true, source: 'fixed', fixedEpochMs: 5 } }),
      5
    );
    // freeze off → env ignored.
    assert.equal(resolveFrozenEpoch({}), null);
  } finally {
    delete process.env.CAPTURE_FROZEN_EPOCH_MS;
  }
});

test('base predates adoption (no config at merge-base) → mode=none, no crash', async () => {
  // Default origin: NO config committed at c1 — the first-ever PR after adoption.
  const origin = await makeOrigin();
  const { dir, cfgPath } = await makePrClone(origin.dir, CONFIG);

  const { result, outputs, env } = await withGithubFiles(() =>
    prepareBase({ configPath: cfgPath, baseRef: 'main', repoDir: dir, currentVersions: VERSIONS })
  );
  assert.equal(result.mode, 'none');
  assert.match(result.reason, /predates visual-preview adoption/);
  assert.equal(outputs['vp-mode'], 'none');
  // Baseline run must still be deterministic: the epoch is exported.
  assert.equal(env.CAPTURE_FROZEN_EPOCH_MS, String(result.frozenEpochMs));
  // pr-diff must see no merge-base (establish-baseline path).
  assert.equal(env.VP_MERGE_BASE_SHA, undefined);
});
