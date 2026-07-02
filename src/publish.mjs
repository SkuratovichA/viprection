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

  // (Re)generate a tiny cross-branch landing index.
  await writeCrossBranchIndex(wt, repo);

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
    await setOutput('url', pagesUrl(repo, serverUrl, pagesBranch, sourceBranch));
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

  const url = pagesUrl(repo, serverUrl, pagesBranch, sourceBranch);
  console.log(`publish: gallery updated → ${url}`);
  await setOutput('url', url);
}

function pagesUrl(repo, serverUrl, pagesBranch, branch) {
  // If GitHub Pages serves the pages branch, the user's Pages URL is
  // https://<owner>.github.io/<repo>/<branch>/. We surface the raw branch path
  // as a fallback (works regardless of Pages config).
  const [owner, name] = (repo || '/').split('/');
  return `${serverUrl}/${owner}/${name}/tree/${pagesBranch}/${branch}`;
}

async function writeCrossBranchIndex(wt, repo) {
  // List immediate subdirs (branches) — best-effort, dependency-free.
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(wt, { withFileTypes: true });
  const branches = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
  const links = branches
    .map((b) => `<li><a href="./${b}/index.html"><code>${b}</code></a></li>`)
    .join('\n');
  const html = `<!doctype html><meta charset="utf-8">
<title>${repo} — visual previews</title>
<style>body{font:15px system-ui;margin:40px;max-width:640px}h1{font-size:20px}code{background:#f0f0f3;padding:2px 6px;border-radius:5px}</style>
<h1>Visual previews — ${repo}</h1>
<p>Always-current screenshot galleries, one per tracked branch:</p>
<ul>${links}</ul>`;
  await writeFile(join(wt, 'index.html'), html);
}

// Allow direct CLI invocation from the action step.
if (import.meta.url === `file://${process.argv[1]}`) {
  publish().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
