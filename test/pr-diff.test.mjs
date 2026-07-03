// Orchestration test: prDiff() wires resolveBase → compareGalleries → explain →
// renderComment → postComment, and sets outputs. Uses a fake postComment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { prDiff } from '../src/pr-diff.mjs';

function solidPng(w, h, [r, g, b]) {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    png.data[i * 4] = r; png.data[i * 4 + 1] = g; png.data[i * 4 + 2] = b; png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}
function manifest(name = 'home') {
  return {
    project: 'T', generatedAt: 'x',
    sections: [{ id: '01', title: 'S', intro: '', screens: [
      { name, route: `/${name}`, caption: name, png: `./01/${name}.png`, status: 'ok' },
    ] }],
  };
}
async function gallery(dir, color, name = 'home') {
  await mkdir(join(dir, '01'), { recursive: true });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest(name)));
  await writeFile(join(dir, `01/${name}.png`), solidPng(40, 40, color));
}

test('prDiff posts a comment for same-repo with a changed screen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vipr-pr-'));
  const baseDir = join(root, 'base');
  const headDir = join(root, 'head');
  await gallery(baseDir, [200, 0, 0]);
  await gallery(headDir, [0, 0, 200]); // changed
  await writeFile(join(root, 'cfg.json'), JSON.stringify({
    up: 'x', capture: 'x', down: 'x', outputDir: headDir,
    healthchecks: ['http://x'], uiGlobs: ['**'],
    diff: { changedRatioGate: 0.001, htmlPrefilter: false },
  }));

  process.env.RUNNER_TEMP = root;
  process.env.GITHUB_STEP_SUMMARY = join(root, 'summary.md');
  process.env.GITHUB_OUTPUT = join(root, 'out.txt');

  let posted = null;
  await prDiff({
    configPath: join(root, 'cfg.json'),
    resolveBase: async () => ({ mode: 'reuse', baseDir }),
    postComment: async (md, marker) => { posted = { md, marker }; },
    uploadImages: async () => (p) => `https://cdn/${p}`,
    isFork: false,
  });

  assert.ok(posted, 'comment should be posted for same-repo');
  assert.ok(posted.md.includes('1 changed'));
  assert.ok(posted.md.includes('viprection:visual-diff'));
});

test('prDiff on a fork does NOT post — summary only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vipr-pr2-'));
  const baseDir = join(root, 'base');
  const headDir = join(root, 'head');
  await gallery(baseDir, [10, 10, 10]);
  await gallery(headDir, [250, 250, 250]);
  await writeFile(join(root, 'cfg.json'), JSON.stringify({
    up: 'x', capture: 'x', down: 'x', outputDir: headDir,
    healthchecks: ['http://x'], uiGlobs: ['**'],
    diff: { changedRatioGate: 0.001, htmlPrefilter: false },
  }));
  process.env.RUNNER_TEMP = root;
  process.env.GITHUB_STEP_SUMMARY = join(root, 'summary.md');
  process.env.GITHUB_OUTPUT = join(root, 'out.txt');

  let posted = false;
  await prDiff({
    configPath: join(root, 'cfg.json'),
    resolveBase: async () => ({ mode: 'reuse', baseDir }),
    postComment: async () => { posted = true; },
    isFork: true,
  });
  assert.equal(posted, false, 'fork must not post a comment');
});

test('prDiff with no base establishes baseline gracefully', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vipr-pr3-'));
  const headDir = join(root, 'head');
  await gallery(headDir, [0, 0, 0]);
  await writeFile(join(root, 'cfg.json'), JSON.stringify({
    up: 'x', capture: 'x', down: 'x', outputDir: headDir,
    healthchecks: ['http://x'], uiGlobs: ['**'],
  }));
  process.env.RUNNER_TEMP = root;
  process.env.GITHUB_STEP_SUMMARY = join(root, 'summary.md');
  process.env.GITHUB_OUTPUT = join(root, 'out.txt');

  await prDiff({
    configPath: join(root, 'cfg.json'),
    resolveBase: async () => ({ mode: 'none', baseDir: null }),
    postComment: async () => { throw new Error('should not post'); },
  });
  // No throw = graceful baseline path.
  assert.ok(true);
});

test('prDiff TRUSTS VP_BASE_MODE from prepare-base and does not re-resolve', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vipr-pr4-'));
  const baseDir = join(root, 'base');
  const headDir = join(root, 'head');
  await gallery(baseDir, [200, 0, 0]);
  await gallery(headDir, [0, 0, 200]); // changed
  await writeFile(join(root, 'cfg.json'), JSON.stringify({
    up: 'x', capture: 'x', down: 'x', outputDir: headDir,
    healthchecks: ['http://x'], uiGlobs: ['**'],
    diff: { changedRatioGate: 0.001, htmlPrefilter: false },
  }));
  process.env.RUNNER_TEMP = root;
  process.env.GITHUB_STEP_SUMMARY = join(root, 'summary.md');
  process.env.GITHUB_OUTPUT = join(root, 'out.txt');
  // Prepare-base already resolved: reuse this baseDir.
  process.env.VP_BASE_MODE = 'reuse';
  process.env.VP_RESOLVED_BASE_DIR = baseDir;

  let resolveCalled = false;
  let posted = false;
  try {
    await prDiff({
      configPath: join(root, 'cfg.json'),
      resolveBase: async () => { resolveCalled = true; return { mode: 'none', baseDir: null }; },
      postComment: async () => { posted = true; },
      uploadImages: async () => (p) => `https://cdn/${p}`,
    });
  } finally {
    delete process.env.VP_BASE_MODE;
    delete process.env.VP_RESOLVED_BASE_DIR;
  }
  assert.equal(resolveCalled, false, 'must NOT re-run resolveBase when VP_BASE_MODE is set');
  assert.ok(posted, 'should diff + post using the trusted base');
});

// ---------------------------------------------------------------------------
// Coverage false positives: the structured relatedFiles used to be capped to
// the prose top-3, so every 4th+ correlated file was reported "uncovered".
// ---------------------------------------------------------------------------

test('explain: structured relatedFiles is uncapped while the prose stays top-3', async () => {
  const { explainReport } = await import('../src/explain.mjs');
  const files = [1, 2, 3, 4, 5, 6].map((i) => `packages/client/src/features/dashboard/File${i}.tsx`);
  const report = { results: [{
    key: '01/dashboard', status: 'changed', diffRatio: 0.05,
    head: { name: 'dashboard', route: '/dashboard', caption: 'Dashboard', png: './01/dashboard.png' },
  }] };
  const [r] = explainReport(report, files);
  assert.deepEqual(r.relatedFiles, files, 'structured field must carry ALL correlated files');
  const inProse = files.filter((f) => r.explanation.includes(f));
  assert.equal(inProse.length, 3, 'the prose "likely related" line stays capped at 3');
});

test('coverage: every correlated file counts as covered — only truly unrelated files are nagged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vipr-pr5-'));
  const baseDir = join(root, 'base');
  const headDir = join(root, 'head');
  await gallery(baseDir, [200, 0, 0], 'dashboard');
  await gallery(headDir, [0, 0, 200], 'dashboard'); // changed
  await writeFile(join(root, 'cfg.json'), JSON.stringify({
    up: 'x', capture: 'x', down: 'x', outputDir: headDir,
    healthchecks: ['http://x'], uiGlobs: ['**'],
    diff: { changedRatioGate: 0.001, htmlPrefilter: false },
  }));
  process.env.RUNNER_TEMP = root;
  process.env.GITHUB_STEP_SUMMARY = join(root, 'summary.md');
  process.env.GITHUB_OUTPUT = join(root, 'out.txt');

  // 6 files the heuristic ties to the changed "dashboard" screen + 1 unrelated.
  const related = [1, 2, 3, 4, 5, 6].map((i) => `packages/client/src/features/dashboard/File${i}.tsx`);
  const unrelated = 'packages/client/src/features/billing/Invoice.tsx';

  let posted = null;
  await prDiff({
    configPath: join(root, 'cfg.json'),
    resolveBase: async () => ({ mode: 'reuse', baseDir }),
    postComment: async (md) => { posted = md; },
    uploadImages: async () => (p) => `https://cdn/${p}`,
    changedFiles: [...related, unrelated],
    isFork: false,
  });

  assert.ok(posted, 'comment should be posted');
  assert.ok(posted.includes('### 🧭 Coverage'), 'coverage section renders');
  assert.ok(posted.includes('**1 changed UI file(s)'), 'exactly ONE file is uncovered');
  assert.ok(posted.includes(unrelated), 'the unrelated file is still nagged');
  for (const f of related.slice(3)) {
    assert.ok(!posted.includes(f), `${f} is correlated (beyond prose top-3) and must NOT be listed anywhere`);
  }
  assert.ok(posted.includes(related[0]), 'top correlated files still appear in the prose');
});
