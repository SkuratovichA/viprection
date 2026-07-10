import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeCommentPoster, makeImageUploader } from '../src/github.mjs';

// Swap global fetch with a recording stub for the duration of a test.
function withFetch(handler, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = handler;
  return (async () => { try { return await fn(); } finally { globalThis.fetch = orig; } })();
}

const MARKER = '<!-- viprection:visual-diff -->';
const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

test('postComment creates a new comment when none carries the marker', async () => {
  const calls = [];
  await withFetch(
    async (url, opts) => {
      calls.push({ url, method: opts?.method || 'GET' });
      if ((opts?.method || 'GET') === 'GET') return ok([{ id: 1, body: 'unrelated' }]);
      return ok({ id: 2 });
    },
    async () => {
      const post = makeCommentPoster({ repo: 'o/r', prNumber: '7', token: 't' });
      await post(`${MARKER}\nhi`, MARKER);
    }
  );
  const post = calls.find((c) => c.method === 'POST');
  assert.ok(post, 'should POST a new comment');
  assert.match(post.url, /\/repos\/o\/r\/issues\/7\/comments$/);
});

test('postComment patches the existing marker comment', async () => {
  const calls = [];
  await withFetch(
    async (url, opts) => {
      calls.push({ url, method: opts?.method || 'GET' });
      if ((opts?.method || 'GET') === 'GET') return ok([{ id: 42, body: `old\n${MARKER}` }]);
      return ok({ id: 42 });
    },
    async () => {
      const post = makeCommentPoster({ repo: 'o/r', prNumber: '7', token: 't' });
      await post(`${MARKER}\nupdated`, MARKER);
    }
  );
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.ok(patch, 'should PATCH the existing comment');
  assert.match(patch.url, /\/issues\/comments\/42$/);
});

// ---------------------------------------------------------------------------
// uploadImages ↔ .nojekyll (field bug #12: Pages' Jekyll builds fail/lag on
// PNG-heavy pushes, 404-ing every preview image until .nojekyll disables them).
// Real git against a local bare "origin"; only the GitHub REST call is stubbed.
// ---------------------------------------------------------------------------

const IDENT = ['-c', 'user.name=t', '-c', 'user.email=t@t.local'];
function sh(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

test('uploadImages ensures .nojekyll on the previews branch (staged when missing, skipped when present)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vipr-gh-'));
  const originDir = join(root, 'origin.git');
  const repoDir = join(root, 'repo');

  // A bare "origin" plus a working clone with one commit on main.
  sh(['init', '--bare', '-b', 'main', originDir]);
  sh(['init', '-b', 'main', repoDir]);
  await writeFile(join(repoDir, 'README.md'), 'hi');
  sh(['add', '-A'], repoDir);
  sh([...IDENT, 'commit', '-m', 'init'], repoDir);
  sh(['remote', 'add', 'origin', originDir], repoDir);
  sh(['push', '-q', 'origin', 'main'], repoDir);

  // Seed a pre-existing previews branch WITHOUT .nojekyll — the exact state
  // every adopter had before this fix.
  const seedWt = join(root, 'seed');
  sh(['worktree', 'add', '--detach', seedWt], repoDir);
  sh(['checkout', '--orphan', 'previews'], seedWt);
  sh(['reset', '--hard'], seedWt);
  await writeFile(join(seedWt, 'seed.txt'), 'x');
  sh(['add', '-A'], seedWt);
  sh([...IDENT, 'commit', '-m', 'seed'], seedWt);
  sh(['push', '-q', 'origin', 'HEAD:previews'], seedWt);
  sh(['worktree', 'remove', '--force', seedWt], repoDir);

  // One changed screen with a base+head image to upload.
  const baseDir = join(root, 'base');
  const headDir = join(root, 'head');
  await mkdir(join(baseDir, '01'), { recursive: true });
  await mkdir(join(headDir, '01'), { recursive: true });
  await writeFile(join(baseDir, '01/home.png'), 'base-bytes');
  await writeFile(join(headDir, '01/home.png'), 'head-bytes');
  const explained = [
    { key: '01/home', status: 'changed', base: { png: './01/home.png' }, head: { png: './01/home.png' } },
  ];

  const upload = makeImageUploader({ repo: 'o/r', prNumber: '5', pagesBranch: 'previews', workRoot: root, token: 't' });
  const wt = join(root, 'vp-pr-images');
  const origCwd = process.cwd();
  try {
    process.chdir(repoDir); // the uploader's git calls run from the repo checkout
    await withFetch(
      async () => ok({ has_pages: false }),
      async () => {
        // Run 1: .nojekyll missing on the branch → staged WITH the images
        // (one commit — no separate housekeeping commit).
        const urlFor = await upload(explained, headDir, baseDir);
        assert.equal(typeof urlFor, 'function');
        const tree = sh(['ls-tree', '-r', '--name-only', 'previews'], originDir).split('\n');
        assert.ok(tree.includes('.nojekyll'), '.nojekyll must be committed at the branch root');
        assert.ok(tree.includes('pr-5/head/01/home.png'), 'images land under pr-<n>/');
        assert.equal(sh(['rev-list', '--count', 'previews'], originDir), '2', 'seed + ONE upload commit');

        // Run 2: .nojekyll present, images identical → nothing to commit.
        sh(['worktree', 'remove', '--force', wt], repoDir); // fresh runner ≈ no stale worktree
        await upload(explained, headDir, baseDir);
        assert.equal(sh(['rev-list', '--count', 'previews'], originDir), '2', 'idempotent: no empty commit');
        const tree2 = sh(['ls-tree', '--name-only', 'previews'], originDir).split('\n');
        assert.ok(tree2.includes('.nojekyll'), '.nojekyll stays on the branch');
      }
    );
  } finally {
    process.chdir(origCwd);
  }
});

// ---------- resolvePublicBase / probePublicBase (v1.1) ----------
import { resolvePublicBase, probePublicBase } from '../src/github.mjs';

test('resolvePublicBase: explicit publicBaseUrl wins, trailing slash trimmed', async () => {
  const r = await resolvePublicBase({
    repo: 'o/r',
    publicBaseUrl: 'https://preview.dev.busano.cz/',
  });
  assert.deepEqual(r, { base: 'https://preview.dev.busano.cz', source: 'publicBaseUrl' });
});

test('resolvePublicBase: raw fallback when Pages detection errors', async () => {
  // Bogus API host → gh() throws → warned raw fallback.
  process.env.GITHUB_API_URL = 'http://127.0.0.1:1';
  try {
    const r = await resolvePublicBase({ repo: 'o/r', token: 'x', pagesBranch: 'previews' });
    assert.equal(r.source, 'raw');
    assert.equal(r.base, 'https://raw.githubusercontent.com/o/r/previews');
  } finally {
    delete process.env.GITHUB_API_URL;
  }
});

test('probePublicBase: 401 → links mode (reachable, no inline images)', async () => {
  const r = await probePublicBase('https://x', {
    fetchImpl: async () => ({ status: 401, ok: false }),
  });
  assert.deepEqual(r, { reachable: true, status: 401, inlineImages: false });
});

test('probePublicBase: 200 → inline images', async () => {
  const r = await probePublicBase('https://x', {
    fetchImpl: async () => ({ status: 200, ok: true }),
  });
  assert.deepEqual(r, { reachable: true, status: 200, inlineImages: true });
});

test('probePublicBase: network error degrades to links, never throws', async () => {
  const r = await probePublicBase('https://x', {
    fetchImpl: async () => { throw new Error('boom'); },
  });
  assert.deepEqual(r, { reachable: false, status: 0, inlineImages: false });
});
