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
import { mkdir, cp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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
 * Ensure an empty `.nojekyll` exists at the root of a pages-branch worktree.
 *
 * Without it, GitHub Pages "legacy" builds run Jekyll on the previews branch,
 * and Jekyll intermittently fails ("Page build failed") or lags for hours on
 * PNG-heavy pushes — every image URL in the PR comment 404s until it recovers.
 * `.nojekyll` switches Pages to the plain static deploy (seconds, no Jekyll).
 *
 * No-op when the file already exists, so callers that stage-then-commit stay
 * idempotent: the file rides along in the same commit as the content when
 * absent, and never forces an otherwise-empty commit.
 *
 * Exported for reuse by every writer of the pages branch (the branch-gallery
 * publisher in publish.mjs should call this on its worktree root too).
 */
export async function ensureNojekyll(worktreeRoot) {
  const p = join(worktreeRoot, '.nojekyll');
  if (!existsSync(p)) await writeFile(p, '');
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
  token = process.env.VP_GITHUB_TOKEN || process.env.GITHUB_TOKEN,
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
      if (r.annotatedPng && r.annotatedPngName)
        await copyInto(r.annotatedPng, join(prDir, 'annotated', r.annotatedPngName));
    }

    // Pages must never run Jekyll on this branch (its builds fail/lag on
    // PNG-heavy pushes → hours of 404 images). Staged with the images below.
    await ensureNojekyll(wt);

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
      // The plain repo GET is readable with ANY GITHUB_TOKEN (metadata scope is
      // implicit) — unlike GET /pages, which needs a pages permission the job
      // may not have. has_pages tells us the site exists; project sites live at
      // the derivable owner.github.io/name URL (custom domains are rare enough
      // to accept the default here).
      const meta = await gh(`/repos/${repo}`, { token });
      if (meta?.has_pages) base = `https://${owner}.github.io/${name}`;
    } catch (e) {
      // Keep the raw fallback (fine for public repos) — but never silently:
      // three of the first live bugs hid behind silent fallbacks.
      console.warn(`[pr-images] Pages detection failed (${e.message}); using raw URLs`);
    }
    return (localRel) => `${base}/pr-${prNumber}/${localRel}`;
  };
}

/**
 * Artifact image "uploader": instead of pushing to a public Pages/previews
 * branch, copy the changed screens' images into a local dir the workflow uploads
 * as a run artifact (nothing served publicly). urlFor returns null → the comment
 * shows no inline images but links to the artifact. For private repos that don't
 * want a public Pages site (user's choice on trips-auctions).
 *
 * @returns {Promise<(p:string)=>null>}  (always null; images live in the artifact)
 */
export function makeArtifactImageStager({ stageDir }) {
  return async function stageImages(explained, headDir, baseDir) {
    const strip = (p) => String(p).replace(/^\.\//, '');
    for (const r of explained) {
      if (r.base?.png) await copyInto(join(baseDir, strip(r.base.png)), join(stageDir, 'base', strip(r.base.png)));
      if (r.head?.png) await copyInto(join(headDir, strip(r.head.png)), join(stageDir, 'head', strip(r.head.png)));
      if (r.diffPng && r.diffPngName) await copyInto(r.diffPng, join(stageDir, 'diff', r.diffPngName));
      if (r.annotatedPng && r.annotatedPngName) await copyInto(r.annotatedPng, join(stageDir, 'annotated', r.annotatedPngName));
    }
    return () => null; // no inline URLs; images are in the uploaded artifact
  };
}

async function copyInto(src, dest) {
  await mkdir(join(dest, '..'), { recursive: true });
  await cp(src, dest);
}
