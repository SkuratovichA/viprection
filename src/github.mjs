/**
 * GitHub integration for pr-diff: sticky-comment upsert + image upload.
 * Dependency-free (raw REST via fetch); the token comes from the workflow.
 *
 * Comment upsert: find the existing comment carrying MARKER on the PR and PATCH
 * it, else POST a new one — so each run updates ONE comment instead of spamming.
 *
 * Image upload: push the changed base/head/diff PNGs to the pages branch under
 * `pr-<num>/` via a git worktree, and return a `urlFor(localPath)` that resolves
 * to the raw githubusercontent URL. (Reuses the same orphan pages branch the
 * per-branch galleries live on, in a PR-scoped subfolder that can be pruned.)
 */
import { mkdir, cp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const API = process.env.GITHUB_API_URL || 'https://api.github.com';

async function gh(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.status === 204 ? null : res.json();
}

/**
 * Upsert the sticky comment. Returns a postComment(md, marker) function bound to
 * this repo/PR/token — matching pr-diff's injected shape.
 */
export function makeCommentPoster({ repo, prNumber, token }) {
  return async function postComment(md, marker) {
    const [owner, name] = repo.split('/');
    const listPath = `/repos/${owner}/${name}/issues/${prNumber}/comments?per_page=100`;
    const comments = await gh(listPath, { token });
    const existing = comments.find((c) => typeof c.body === 'string' && c.body.includes(marker));
    if (existing) {
      await gh(`/repos/${owner}/${name}/issues/comments/${existing.id}`, {
        method: 'PATCH', token, body: { body: md },
      });
    } else {
      await gh(`/repos/${owner}/${name}/issues/${prNumber}/comments`, {
        method: 'POST', token, body: { body: md },
      });
    }
  };
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * Upload the changed screens' base/head/diff PNGs to the pages branch under
 * pr-<num>/ and return urlFor(localRelPath) → raw URL. `localRelPath` uses the
 * "base/…", "head/…", "diff/…" convention that comment.mjs builds.
 *
 * @returns {Promise<(p:string)=>string|null>}
 */
export function makeImageUploader({
  repo, prNumber, pagesBranch = 'previews',
  serverRawUrl = 'https://raw.githubusercontent.com',
  workRoot = process.env.RUNNER_TEMP || '/tmp',
  token = process.env.GITHUB_TOKEN,
}) {
  return async function uploadImages(explained, headDir, baseDir) {
    const wt = join(workRoot, 'vp-pr-images');
    await rm(wt, { recursive: true, force: true });

    const branchExists = (() => {
      try { git(['ls-remote', '--exit-code', '--heads', 'origin', pagesBranch]); return true; }
      catch { return false; }
    })();
    if (branchExists) {
      git(['fetch', 'origin', pagesBranch, '--depth=1']);
      git(['worktree', 'add', wt, `origin/${pagesBranch}`]);
      git(['-C', wt, 'switch', '-C', pagesBranch]);
    } else {
      git(['worktree', 'add', '--detach', wt]);
      git(['-C', wt, 'checkout', '--orphan', pagesBranch]);
      git(['-C', wt, 'reset', '--hard']);
    }

    const prDir = join(wt, `pr-${prNumber}`);
    await rm(prDir, { recursive: true, force: true });

    // Copy only the changed screens' images (keeps the PR folder small).
    const strip = (p) => String(p).replace(/^\.\//, '');
    for (const r of explained) {
      if (r.base?.png) await copyInto(join(baseDir, strip(r.base.png)), join(prDir, 'base', strip(r.base.png)));
      if (r.head?.png) await copyInto(join(headDir, strip(r.head.png)), join(prDir, 'head', strip(r.head.png)));
      if (r.diffPng && r.diffPngName) await copyInto(r.diffPng, join(prDir, 'diff', r.diffPngName));
    }

    git(['-C', wt, 'add', '-A']);
    let changed = true;
    try { git(['-C', wt, 'diff', '--cached', '--quiet']); changed = false; } catch { /* has changes */ }
    if (changed) {
      git([
        '-C', wt,
        // CI runners ship no git identity (same fix as publish.mjs).
        '-c', 'user.name=github-actions[bot]',
        '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
        'commit', '-m', `preview(pr-${prNumber}): diff images`,
      ]);
      git(['-C', wt, 'push', 'origin', `HEAD:${pagesBranch}`]);
    }

    const [owner, name] = repo.split('/');
    // raw.githubusercontent only renders in comments for PUBLIC repos — GitHub's
    // camo proxy fetches anonymously, so private-repo raw URLs show as broken
    // images. Prefer the repo's GitHub Pages site (publicly served even for
    // private repos when Pages is enabled on the previews branch); fall back to
    // raw URLs when Pages is unavailable.
    let base = `${serverRawUrl}/${owner}/${name}/${pagesBranch}`;
    try {
      const pages = await gh(`/repos/${repo}/pages`, { token });
      if (pages?.html_url) base = pages.html_url.replace(/\/$/, '');
    } catch {
      // Pages not enabled — keep the raw fallback (works for public repos).
    }
    return (localRel) => `${base}/pr-${prNumber}/${localRel}`;
  };
}

async function copyInto(src, dest) {
  await mkdir(join(dest, '..'), { recursive: true });
  await cp(src, dest);
}
