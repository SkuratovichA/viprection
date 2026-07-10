/**
 * W5 — publish the per-branch gallery to an orphan Pages branch.
 *
 * Layout on the pages branch (default `previews`):
 *   <branch>/                     ← one subfolder per tracked source branch
 *     index.html, manifest.json, preview-meta.json, <section>/*.png, *.html
 *   index.html                    ← a small cross-branch landing page
 *
 * The published gallery doubles as the PR image-diff BASE (see pr-diff.mjs), so
 * we also write `preview-meta.json` with { capturedAtSha, toolVersion,
 * browserVersion } for the base-reuse staleness check.
 *
 * Uses plain git (worktree add on the orphan branch) — no external deps. On a
 * fork PR the token is read-only; publishing is a no-op there (guarded upstream).
 *
 * Env:
 *   VP_CONFIG_PATH, VP_PAGES_BRANCH, VP_GITHUB_TOKEN
 *   GITHUB_REF_NAME (source branch), GITHUB_SHA, GITHUB_REPOSITORY,
 *   GITHUB_SERVER_URL, RUNNER_TEMP
 */
import { readFile, writeFile, mkdir, cp, rm, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { toolVersion, browserVersion } from './versions.mjs';
import { writeRootIndex } from './index-pages.mjs';
import { ensureNojekyll } from './github.mjs';
import { renderGalleryHtml } from './gallery.mjs';

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

async function setOutput(key, value) {
  const out = process.env.GITHUB_OUTPUT;
  if (out) await appendFile(out, `${key}=${value}\n`);
  else process.stdout.write(`${key}=${value}\n`);
}

export async function publish({
  configPath = process.env.VP_CONFIG_PATH || 'visual-preview.config.json',
  pagesBranch = process.env.VP_PAGES_BRANCH || 'previews',
  sourceBranch = process.env.GITHUB_REF_NAME,
  sha = process.env.GITHUB_SHA,
  repo = process.env.GITHUB_REPOSITORY,
  serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com',
  workRoot = process.env.RUNNER_TEMP || '/tmp',
} = {}) {
  const cfg = JSON.parse(await readFile(configPath, 'utf8'));
  const outputDir = cfg.outputDir;
  if (!existsSync(join(outputDir, 'manifest.json'))) {
    throw new Error(`publish: ${outputDir}/manifest.json not found — did capture run?`);
  }

  // Write the base-reuse metadata alongside the gallery (does NOT touch the
  // shared gallery renderer / manifest.json).
  const meta = {
    capturedAtSha: sha,
    toolVersion: await toolVersion(cfg),
    browserVersion: await browserVersion(),
    branch: sourceBranch,
    generatedAt: undefined, // stamped by the caller if needed (no Date in lib)
  };
  await writeFile(join(outputDir, 'preview-meta.json'), JSON.stringify(meta, null, 2));

  // Prepare an orphan worktree for the pages branch.
  const wt = join(workRoot, 'vp-pages');
  await rm(wt, { recursive: true, force: true });
  const branchExists = (() => {
    try {
      git(['ls-remote', '--exit-code', '--heads', 'origin', pagesBranch]);
      return true;
    } catch {
      return false;
    }
  })();

  if (branchExists) {
    git(['fetch', 'origin', pagesBranch, '--depth=1']);
    git(['worktree', 'add', wt, `origin/${pagesBranch}`]);
    // Detach onto a local branch we can commit + push.
    git(['-C', wt, 'switch', '-C', pagesBranch]);
  } else {
    git(['worktree', 'add', '--detach', wt]);
    git(['-C', wt, 'checkout', '--orphan', pagesBranch]);
    git(['-C', wt, 'reset', '--hard']);
    git(['-C', wt, 'clean', '-fdx']);
  }

  // Replace just this branch's subfolder; leave other branches' galleries intact.
  const dest = join(wt, sourceBranch);
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  await cp(outputDir, dest, { recursive: true });

  // A project's outputDir often carries a repo-side .gitignore (e.g. "ignore
  // all generated content"). Copied onto the previews branch it would make the
  // `git add -A` below silently skip the entire gallery — an empty publish
  // that looks green. The previews branch owns its own ignore rules; drop it.
  await rm(join(dest, '.gitignore'), { force: true });

  // Bake the branch gallery page from the manifest with the SHARED renderer —
  // presentation is owned here, not by each project's capture harness (the
  // per-project templates had already drifted apart once).
  try {
    const manifest = JSON.parse(await readFile(join(dest, 'manifest.json'), 'utf8'));
    await writeFile(join(dest, 'index.html'), renderGalleryHtml(manifest));
  } catch (e) {
    console.warn(`publish: gallery bake failed (${e.message}) — keeping the harness-rendered index.html if any`);
  }

  // (Re)generate a tiny cross-branch landing index.
  await writeCrossBranchIndex(wt, repo);

  // Without .nojekyll a first branch-publish leaves Pages running Jekyll,
  // which chokes on PNG-heavy pushes (msg-40 incident on message-flow #228).
  await ensureNojekyll(wt);

  // Commit + push.
  git(['-C', wt, 'add', '-A']);
  const hasChanges = (() => {
    try {
      git(['-C', wt, 'diff', '--cached', '--quiet']);
      return false;
    } catch {
      return true;
    }
  })();
  if (!hasChanges) {
    console.log('publish: no gallery changes to publish.');
    await setOutput('url', galleryUrl(cfg, repo, serverUrl, pagesBranch, sourceBranch));
    return;
  }
  // Commit as the pushing actor; author identity is set by the workflow env.
  git([
    '-C', wt,
    // CI runners have no git identity configured; commit as the Actions bot.
    '-c', 'user.name=github-actions[bot]',
    '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
    'commit', '-m', `preview(${sourceBranch}): update gallery @ ${String(sha).slice(0, 7)}`,
  ]);
  git(['-C', wt, 'push', 'origin', `HEAD:${pagesBranch}`]);

  const url = galleryUrl(cfg, repo, serverUrl, pagesBranch, sourceBranch);
  console.log(`publish: gallery updated → ${url}`);
  await setOutput('url', url);
}

function galleryUrl(cfg, repo, serverUrl, pagesBranch, branch) {
  // Where a human opens this branch's gallery. An explicit publicBaseUrl
  // (S3/CloudFront mirror of the whole previews branch) wins; otherwise the
  // github.com tree path — it works regardless of Pages config (the Pages URL
  // itself is owner-derivable but Pages may not be enabled).
  if (cfg?.publicBaseUrl) {
    return `${String(cfg.publicBaseUrl).replace(/\/+$/, '')}/${branch}/index.html`;
  }
  const [owner, name] = (repo || '/').split('/');
  return `${serverUrl}/${owner}/${name}/tree/${pagesBranch}/${branch}`;
}

async function writeCrossBranchIndex(wt, repo) {
  // Delegated to the shared landing-page renderer so branch publishes and
  // PR-image uploads produce the same root index (branch galleries + PRs
  // grouped by state; pr-<n>/ dirs get their own gallery page from the
  // uploader). The old inline version listed pr dirs as "branches" and linked
  // per-PR index.html files that never existed.
  await writeRootIndex(wt, repo, {
    token: process.env.VP_GITHUB_TOKEN || process.env.GITHUB_TOKEN,
  });
}

// Allow direct CLI invocation from the action step.
if (import.meta.url === `file://${process.argv[1]}`) {
  publish().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
