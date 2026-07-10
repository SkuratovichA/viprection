// Orchestration test: prDiff() wires resolveBase → compareGalleries → explain →
// renderComment → postComment, and sets outputs. Uses a fake postComment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { prDiff, resolveGalleryUrl } from '../src/pr-diff.mjs';

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

// A viewport-matrix gallery: ONE logical auto-- screen captured at desktop AND
// mobile. The manifest lists it once per viewport (desktop @section/name, mobile
// @section/name@mobile) and echoes the `viewports` array. Coverage must count
// the SCREEN once, not once per device row.
async function matrixGallery(dir, color, name = 'auto--products') {
  await mkdir(join(dir, '01'), { recursive: true });
  const m = {
    project: 'T', generatedAt: 'x',
    viewports: [
      { name: 'desktop', width: 1440, height: 900, deviceScaleFactor: 2 },
      { name: 'mobile', width: 390, height: 844, deviceScaleFactor: 3, isMobile: true },
    ],
    sections: [{ id: '01', title: 'S', intro: '', screens: [
      { name, route: `/${name}`, caption: name, png: `./01/${name}.png`, status: 'ok', viewport: 'desktop' },
      { name, route: `/${name}`, caption: name, png: `./01/${name}@mobile.png`, status: 'ok', viewport: 'mobile' },
    ] }],
  };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(m));
  await writeFile(join(dir, `01/${name}.png`), solidPng(40, 40, color));
  await writeFile(join(dir, `01/${name}@mobile.png`), solidPng(20, 40, color));
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
// resolveGalleryUrl: the "[Full gallery →]" link must resolve through the public
// base (mirror publish.mjs), not a hardcoded raw git-tree URL.
// ---------------------------------------------------------------------------

test('resolveGalleryUrl: publicBaseUrl wins → <base>/<baseRef>/index.html', () => {
  const url = resolveGalleryUrl({
    cfg: { publicBaseUrl: 'https://cdn.example.com/previews/' }, // trailing slash trimmed
    baseRef: 'main',
    envUrl: 'https://github.com/o/r/tree/previews/main', // must be IGNORED
    serverUrl: 'https://github.com',
    repo: 'o/r',
    pagesBranch: 'previews',
  });
  assert.equal(url, 'https://cdn.example.com/previews/main/index.html');
});

test('resolveGalleryUrl: no publicBaseUrl → VP_GALLERY_URL env value is used verbatim', () => {
  const warns = [];
  const realWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  let url;
  try {
    url = resolveGalleryUrl({
      cfg: {},
      baseRef: 'main',
      envUrl: 'https://github.com/o/r/tree/previews/main',
      serverUrl: 'https://github.com',
      repo: 'o/r',
      pagesBranch: 'previews',
    });
  } finally {
    console.warn = realWarn;
  }
  assert.equal(url, 'https://github.com/o/r/tree/previews/main');
  assert.equal(warns.length, 0, 'a present env URL is the expected Pages default — no warn');
});

test('resolveGalleryUrl: neither publicBaseUrl nor env → constructed tree path + one warn', () => {
  const warns = [];
  const realWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  let url;
  try {
    url = resolveGalleryUrl({
      cfg: {},
      baseRef: 'develop',
      envUrl: undefined,
      serverUrl: 'https://github.example.com',
      repo: 'acme/widgets',
      pagesBranch: 'gh-previews',
    });
  } finally {
    console.warn = realWarn;
  }
  assert.equal(url, 'https://github.example.com/acme/widgets/tree/gh-previews/develop');
  assert.equal(warns.length, 1, 'both sources absent is a genuine gap → warn once');
  assert.ok(warns[0].includes('no publicBaseUrl and no VP_GALLERY_URL'));
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

test('coverage: coverageIgnore globs drop capture-harness files from the nag (not the gate)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vipr-covign-'));
  const baseDir = join(root, 'base');
  const headDir = join(root, 'head');
  await gallery(baseDir, [200, 0, 0], 'dashboard');
  await gallery(headDir, [0, 0, 200], 'dashboard'); // changed
  await writeFile(join(root, 'cfg.json'), JSON.stringify({
    up: 'x', capture: 'x', down: 'x', outputDir: headDir,
    healthchecks: ['http://x'], uiGlobs: ['**'],
    coverageIgnore: ['packages/client/scripts/**', '**/gallery-template.*'],
    diff: { changedRatioGate: 0.001, htmlPrefilter: false },
  }));
  process.env.RUNNER_TEMP = root;
  process.env.GITHUB_STEP_SUMMARY = join(root, 'summary.md');
  process.env.GITHUB_OUTPUT = join(root, 'out.txt');

  // Two uncorrelated changed files: one is a real product file (should nag),
  // one is a capture-harness script matched by coverageIgnore (must NOT nag).
  const productFile = 'packages/client/src/features/billing/Invoice.tsx';
  const harnessScript = 'packages/client/scripts/capture-screens.mjs';
  const harnessTemplate = 'packages/client/e2e/catalog/gallery-template.ts';

  let posted = null;
  await prDiff({
    configPath: join(root, 'cfg.json'),
    resolveBase: async () => ({ mode: 'reuse', baseDir }),
    postComment: async (md) => { posted = md; },
    uploadImages: async () => (p) => `https://cdn/${p}`,
    changedFiles: [productFile, harnessScript, harnessTemplate],
    isFork: false,
  });

  assert.ok(posted, 'comment should be posted');
  assert.ok(posted.includes('### 🧭 Coverage'), 'coverage section renders');
  assert.ok(posted.includes('**1 changed UI file(s)'), 'only the product file is uncovered');
  assert.ok(posted.includes(productFile), 'the product file is still nagged');
  assert.ok(!posted.includes(harnessScript), 'the capture-harness script is exempt from the nag');
  assert.ok(!posted.includes(harnessTemplate), 'the vendored gallery template is exempt from the nag');
});

// ---------------------------------------------------------------------------
// Viewport-matrix wiring (Task 2): the head manifest now lists the same logical
// screen once PER viewport. Coverage must not double-count, and the report must
// carry the capture viewports for renderers.
// ---------------------------------------------------------------------------

test('coverage: a desktop+mobile auto-- screen counts ONCE, not per viewport', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vipr-pr6-'));
  const baseDir = join(root, 'base');
  const headDir = join(root, 'head');
  // Base has just the desktop image (a plain gallery of the same screen);
  // head is the viewport-matrix gallery with a color change → the screen is
  // "changed" but the coverage list is what we assert on.
  await gallery(baseDir, [200, 0, 0], 'auto--products');
  await matrixGallery(headDir, [0, 0, 200], 'auto--products');
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
    postComment: async (md) => { posted = md; },
    uploadImages: async () => (p) => `https://cdn/${p}`,
    changedFiles: [],
    isFork: false,
  });

  assert.ok(posted, 'comment should be posted');
  // The dedup guard: the auto-covered-but-undocumented nag must COUNT the screen
  // once (not once per viewport row). Assert on the coverage section only — the
  // route also appears in per-screen titles/prose, which is unrelated to dedup.
  assert.ok(posted.includes('**1 screen(s) are auto-covered'), 'autoScreens count is 1, not 2');
  const cov = posted.slice(posted.indexOf('### 🧭 Coverage'));
  const inCoverage = cov.split('`/auto--products`').length - 1;
  assert.equal(inCoverage, 1, 'the auto-covered screen is listed once in the coverage nag, not per viewport');
});

test('report.viewports is populated from the head manifest (no legacy warn)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vipr-pr7-'));
  const baseDir = join(root, 'base');
  const headDir = join(root, 'head');
  await gallery(baseDir, [200, 0, 0], 'auto--products');
  await matrixGallery(headDir, [0, 0, 200], 'auto--products'); // has a `viewports` echo
  await writeFile(join(root, 'cfg.json'), JSON.stringify({
    up: 'x', capture: 'x', down: 'x', outputDir: headDir,
    healthchecks: ['http://x'], uiGlobs: ['**'],
    diff: { changedRatioGate: 0.001, htmlPrefilter: false },
  }));
  process.env.RUNNER_TEMP = root;
  process.env.GITHUB_STEP_SUMMARY = join(root, 'summary.md');
  process.env.GITHUB_OUTPUT = join(root, 'out.txt');

  // manifestViewports warns ONLY when the manifest has no `viewports` field.
  // A matrix manifest carries one → report.viewports is sourced from it, no warn.
  const warns = [];
  const realWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    await prDiff({
      configPath: join(root, 'cfg.json'),
      resolveBase: async () => ({ mode: 'reuse', baseDir }),
      postComment: async () => {},
      uploadImages: async () => (p) => `https://cdn/${p}`,
      changedFiles: [],
      isFork: false,
    });
  } finally {
    console.warn = realWarn;
  }
  assert.ok(
    !warns.some((w) => w.includes('manifest has no `viewports`')),
    'a manifest that echoes viewports must NOT trigger the legacy desktop fallback'
  );

  // Complement: a legacy manifest (no viewports) DOES warn → report.viewports
  // falls back to the desktop default, proving the threading reads the manifest.
  const headDir2 = join(root, 'head2');
  await gallery(headDir2, [0, 0, 200], 'home'); // plain manifest(), no viewports
  await writeFile(join(root, 'cfg2.json'), JSON.stringify({
    up: 'x', capture: 'x', down: 'x', outputDir: headDir2,
    healthchecks: ['http://x'], uiGlobs: ['**'],
    diff: { changedRatioGate: 0.001, htmlPrefilter: false },
  }));
  const warns2 = [];
  console.warn = (...a) => warns2.push(a.join(' '));
  try {
    await prDiff({
      configPath: join(root, 'cfg2.json'),
      resolveBase: async () => ({ mode: 'reuse', baseDir }),
      postComment: async () => {},
      uploadImages: async () => (p) => `https://cdn/${p}`,
      changedFiles: [],
      isFork: false,
    });
  } finally {
    console.warn = realWarn;
  }
  assert.ok(
    warns2.some((w) => w.includes('manifest has no `viewports`')),
    'a legacy manifest must trigger the desktop-default fallback (report.viewports came from the manifest read)'
  );
});

test('inlineImages=false still renders a full comment (link-mode path)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vipr-pr8-'));
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
    postComment: async (md) => { posted = md; },
    uploadImages: async () => (p) => `https://cdn/${p}`,
    changedFiles: [],
    isFork: false,
    inlineImages: false,
  });

  assert.ok(posted, 'link-mode still posts a comment');
  assert.ok(posted.includes('1 changed'), 'the change summary still renders in link mode');
});
