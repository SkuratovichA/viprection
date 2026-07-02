/**
 * prepare-base — PR-mode step that makes the diff BASE available (or declares
 * there is none) BEFORE the head stack boots.
 *
 * Order of operations (git failures degrade to safe answers, never throw):
 *   1. fetch origin/<GITHUB_BASE_REF>, compute the merge-base vs HEAD.
 *      No merge-base → vp-mode=none (the caller establishes a baseline) and
 *      exit successfully.
 *   2. compute the frozen clock epoch (merge-base committer time × 1000, or
 *      cfg.clock.fixedEpochMs) and export CAPTURE_FROZEN_EPOCH_MS via
 *      $GITHUB_ENV — the SINGLE source of the epoch for base AND head captures
 *      (capture.mjs computes its own only when this env is absent, i.e.
 *      standalone / branch mode).
 *   3. fetch the published per-branch gallery — pages-branch layout owned by
 *      publish.mjs: branch <pagesBranch> (default `previews`), ONE SUBFOLDER
 *      PER SOURCE BRANCH holding manifest.json + preview-meta.json — into a
 *      detached worktree at .viprection/published. The base branch's gallery
 *      is then .viprection/published/<GITHUB_BASE_REF>.
 *   4. resolveBase(...) — reuse the published gallery when still valid
 *      (exact-sha / ancestor-with-no-UI-changes + version match), else a fresh
 *      base capture is needed.
 *   5. capture-base fallback (mode 'capture-base'): check the merge-base out
 *      into a second worktree (.viprection/base-src) and run the project's
 *      lifecycle there — install? → up → healthchecks → seed? → capture (with
 *      the SAME frozen epoch) — with down in a finally; then copy
 *      <worktree>/<outputDir> to .viprection/base (VP_BASE_DIR). Guarded by
 *      VP_CAPTURE_BASE_FALLBACK (default 'true'); when disabled, emit
 *      vp-mode=none so the run establishes a new baseline instead.
 *
 * GitHub outputs: vp-mode (none|reuse|capture-base), vp-base-dir,
 * vp-frozen-epoch-ms.
 * $GITHUB_ENV exports (consumed by capture.mjs + pr-diff.mjs):
 *   CAPTURE_FROZEN_EPOCH_MS, VP_MERGE_BASE_SHA, VP_PUBLISHED_DIR,
 *   VP_PUBLISHED_META, VP_BASE_DIR.
 * When the final mode is 'none', VP_MERGE_BASE_SHA is deliberately NOT
 * exported — pr-diff then resolves 'none' too and takes its baseline path.
 *
 * Env in: VP_CONFIG_PATH, VP_PAGES_BRANCH, VP_CAPTURE_BASE_FALLBACK,
 *   GITHUB_BASE_REF, GITHUB_OUTPUT, GITHUB_ENV.
 */
import { readFile, appendFile, mkdir, cp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveBase } from './resolve-base.mjs';
import { run, waitForHealth } from './stack.mjs';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function tryGit(args, cwd) {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

const firstLine = (s) => String(s).split('\n')[0];

async function setOutput(key, value) {
  const out = process.env.GITHUB_OUTPUT;
  const line = `${key}=${value}\n`;
  if (out) await appendFile(out, line);
  else process.stdout.write(line); // local dry-run
}

async function exportEnv(key, value) {
  const envFile = process.env.GITHUB_ENV;
  if (envFile) await appendFile(envFile, `${key}=${value}\n`);
  else process.stdout.write(`(env) ${key}=${value}\n`);
}

/**
 * Ensure the base ref is fetchable and compute the merge-base vs HEAD.
 * @returns {string|null} merge-base SHA, or null when it cannot be computed
 *   (missing ref / unrelated histories / no remote) — the 'none' signal.
 */
export function computeMergeBase(baseRef, repoDir) {
  if (!baseRef) return null;
  tryGit(['fetch', 'origin', baseRef], repoDir); // tolerate failure (already fetched / no remote)
  return tryGit(['merge-base', `origin/${baseRef}`, 'HEAD'], repoDir);
}

/** Committer time of a commit, in milliseconds — the frozen-clock epoch. */
export function commitEpochMs(sha, repoDir) {
  const secs = tryGit(['show', '-s', '--format=%ct', sha], repoDir);
  const n = Number(secs);
  return Number.isFinite(n) && n > 0 ? n * 1000 : null;
}

/** The epoch capture must freeze to, per cfg.clock — or null when freeze is off. */
export function frozenEpochFor(cfg, mergeBaseSha, repoDir) {
  const clock = cfg.clock;
  if (!clock?.freeze) return null;
  if (clock.source === 'fixed') return clock.fixedEpochMs ?? null;
  // default source: merge-base-commit-time (identical for base & head).
  return mergeBaseSha ? commitEpochMs(mergeBaseSha, repoDir) : null;
}

/**
 * Fetch the pages branch into a detached worktree and derive the base branch's
 * published paths per the publish.mjs layout (<worktree>/<sourceBranch>/…).
 * A missing branch (or fetch failure) just means "published unavailable" —
 * resolveBase then answers 'capture-base' via the missing preview-meta.
 */
export async function fetchPublished({ pagesBranch, baseRef, repoDir, publishedRoot }) {
  const dir = join(publishedRoot, baseRef);
  const metaPath = join(dir, 'preview-meta.json');
  let available = false;
  try {
    git(['ls-remote', '--exit-code', '--heads', 'origin', pagesBranch], repoDir);
    await rm(publishedRoot, { recursive: true, force: true });
    tryGit(['worktree', 'prune'], repoDir);
    git(['fetch', 'origin', pagesBranch, '--depth=1'], repoDir);
    git(['worktree', 'add', '--detach', '--force', publishedRoot, `origin/${pagesBranch}`], repoDir);
    available = existsSync(metaPath);
    console.log(
      available
        ? `[prepare-base] published gallery for ${baseRef} → ${dir}`
        : `[prepare-base] pages branch fetched, but no gallery for ${baseRef}`
    );
  } catch (e) {
    console.log(`[prepare-base] published gallery unavailable (${firstLine(e.message)})`);
  }
  return { dir, metaPath, available };
}

/**
 * Fresh base capture: run the project's lifecycle inside a worktree pinned at
 * the merge-base, then copy its outputDir into `baseDir`. `down` always runs
 * (finally); the worktree is removed afterwards (best-effort).
 */
/** True when the given commit contains the project config (adoption existed). */
function configExistsAtCommit(repoDir, sha, configPath) {
  // git addresses blobs repo-relative; callers may hold an absolute path.
  const rel = isAbsolute(configPath) ? relative(repoDir, configPath) : configPath;
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}:${rel}`], {
      cwd: repoDir,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

export async function captureBaseInWorktree({
  cfg,
  mergeBaseSha,
  repoDir,
  worktreeDir,
  baseDir,
  frozenEpochMs,
}) {
  await rm(worktreeDir, { recursive: true, force: true });
  tryGit(['worktree', 'prune'], repoDir);
  git(['worktree', 'add', '--detach', '--force', worktreeDir, mergeBaseSha], repoDir);

  const env = { ...(cfg.env ?? {}) };
  if (frozenEpochMs != null) env.CAPTURE_FROZEN_EPOCH_MS = String(frozenEpochMs);
  const inWorktree = (cmd) => run(cmd, env, { cwd: worktreeDir });

  try {
    if (cfg.install) {
      console.log(`[prepare-base] base install: ${cfg.install}`);
      await inWorktree(cfg.install);
    }
    console.log(`[prepare-base] base up: ${cfg.up}`);
    await inWorktree(cfg.up);
    const checks = cfg.healthchecks ?? [];
    if (checks.length) {
      console.log(`[prepare-base] waiting for ${checks.length} healthcheck(s)…`);
      await Promise.all(checks.map((hc) => waitForHealth(hc)));
    }
    if (cfg.seed) {
      console.log(`[prepare-base] base seed: ${cfg.seed}`);
      await inWorktree(cfg.seed);
    }
    console.log(`[prepare-base] base capture: ${cfg.capture}`);
    await inWorktree(cfg.capture);
  } finally {
    if (cfg.down) {
      await inWorktree(cfg.down).catch((e) =>
        console.warn(`[prepare-base] base down failed: ${e.message}`)
      );
    }
  }

  const produced = join(worktreeDir, cfg.outputDir);
  if (!existsSync(join(produced, 'manifest.json'))) {
    throw new Error(`base capture produced no ${cfg.outputDir}/manifest.json`);
  }
  await rm(baseDir, { recursive: true, force: true });
  await mkdir(baseDir, { recursive: true });
  await cp(produced, baseDir, { recursive: true });

  // The worktree served its purpose; drop it (best-effort).
  tryGit(['worktree', 'remove', '--force', worktreeDir], repoDir);
  console.log(`[prepare-base] fresh base gallery → ${baseDir}`);
}

/**
 * @param {object} [opts]
 * @param {string} [opts.configPath]
 * @param {string} [opts.baseRef]              PR base branch (GITHUB_BASE_REF)
 * @param {string} [opts.pagesBranch]
 * @param {boolean} [opts.captureBaseFallback] default true (VP_CAPTURE_BASE_FALLBACK)
 * @param {string} [opts.repoDir]
 * @param {string} [opts.workDir]              default <repoDir>/.viprection
 * @param {object} [opts.currentVersions]      {tool, browser} override (tests)
 * @returns {Promise<{mode:string, baseDir:string|null, mergeBaseSha:string|null,
 *   frozenEpochMs:number|null, reason:string}>}
 */
export async function prepareBase({
  configPath = process.env.VP_CONFIG_PATH || 'visual-preview.config.json',
  baseRef = process.env.GITHUB_BASE_REF,
  pagesBranch = process.env.VP_PAGES_BRANCH || 'previews',
  captureBaseFallback = (process.env.VP_CAPTURE_BASE_FALLBACK ?? 'true') !== 'false',
  repoDir = process.cwd(),
  workDir,
  currentVersions,
} = {}) {
  const cfg = JSON.parse(await readFile(configPath, 'utf8'));
  const vpDir = resolve(workDir ?? join(repoDir, '.viprection'));

  const emit = async ({ mode, baseDir, frozenEpochMs, env = {} }) => {
    await setOutput('vp-mode', mode);
    await setOutput('vp-base-dir', baseDir ?? '');
    await setOutput('vp-frozen-epoch-ms', frozenEpochMs ?? '');
    // Export the authoritative verdict to $GITHUB_ENV so pr-diff trusts it
    // instead of re-running resolveBase (single decision point, no drift).
    await exportEnv('VP_BASE_MODE', mode);
    await exportEnv('VP_RESOLVED_BASE_DIR', baseDir ?? '');
    for (const [k, v] of Object.entries(env)) await exportEnv(k, v);
  };

  // 1. merge-base (the anchor for both the epoch and the base gallery).
  const mergeBaseSha = computeMergeBase(baseRef, repoDir);
  if (!mergeBaseSha) {
    const reason = `no merge-base for origin/${baseRef ?? '?'} vs HEAD`;
    console.log(`[prepare-base] ${reason} → mode=none (baseline run)`);
    await emit({ mode: 'none', baseDir: null, frozenEpochMs: null });
    return { mode: 'none', baseDir: null, mergeBaseSha: null, frozenEpochMs: null, reason };
  }
  console.log(`[prepare-base] merge-base: ${mergeBaseSha}`);

  // 2. frozen clock epoch — computed ONCE here, shared by base & head captures.
  const frozenEpochMs = frozenEpochFor(cfg, mergeBaseSha, repoDir);
  if (frozenEpochMs != null) console.log(`[prepare-base] frozen epoch: ${frozenEpochMs}`);

  // 3. published per-branch gallery (publish.mjs layout).
  const published = await fetchPublished({
    pagesBranch,
    baseRef,
    repoDir,
    publishedRoot: join(vpDir, 'published'),
  });
  const freshBaseDir = join(vpDir, 'base');

  // 4. reuse vs fresh capture.
  const resolved = await resolveBase({
    config: cfg,
    mergeBaseSha,
    publishedMetaPath: published.metaPath,
    publishedDir: published.dir,
    freshBaseDir,
    repoDir,
    currentVersions,
  });
  console.log(`[prepare-base] resolveBase → ${resolved.mode} (${resolved.reason})`);

  if (resolved.mode === 'capture-base' && !captureBaseFallback) {
    // No VP_MERGE_BASE_SHA export → pr-diff resolves 'none' and establishes a
    // baseline. The epoch is still exported so the head capture stays
    // deterministic (and becomes a reusable baseline).
    const reason = 'capture-base needed but VP_CAPTURE_BASE_FALLBACK=false';
    console.log(`[prepare-base] ${reason} → mode=none (baseline run)`);
    const env = frozenEpochMs != null ? { CAPTURE_FROZEN_EPOCH_MS: String(frozenEpochMs) } : {};
    await emit({ mode: 'none', baseDir: null, frozenEpochMs, env });
    return { mode: 'none', baseDir: null, mergeBaseSha, frozenEpochMs, reason };
  }

  // Bootstrap guard: if the project had not adopted visual-preview at the
  // merge-base (no config file in that commit), a base capture is impossible —
  // the base worktree has no up/capture commands to run. First-ever PR after
  // adoption hits exactly this. Treat it as "establish baseline", not an error.
  if (resolved.mode === 'capture-base' && !configExistsAtCommit(repoDir, mergeBaseSha, configPath)) {
    const reason = `base ${mergeBaseSha.slice(0, 10)} predates visual-preview adoption (no ${configPath})`;
    console.log(`[prepare-base] ${reason} → mode=none (baseline run)`);
    const env = frozenEpochMs != null ? { CAPTURE_FROZEN_EPOCH_MS: String(frozenEpochMs) } : {};
    await emit({ mode: 'none', baseDir: null, frozenEpochMs, env });
    return { mode: 'none', baseDir: null, mergeBaseSha, frozenEpochMs, reason };
  }

  // 5. fresh base capture at the merge-base (worktree) when reuse isn't valid.
  if (resolved.mode === 'capture-base') {
    await captureBaseInWorktree({
      cfg,
      mergeBaseSha,
      repoDir,
      worktreeDir: join(vpDir, 'base-src'),
      baseDir: freshBaseDir,
      frozenEpochMs,
    });
  }

  const env = {
    VP_MERGE_BASE_SHA: mergeBaseSha,
    VP_PUBLISHED_DIR: published.dir,
    VP_PUBLISHED_META: published.metaPath,
    VP_BASE_DIR: freshBaseDir,
    ...(frozenEpochMs != null ? { CAPTURE_FROZEN_EPOCH_MS: String(frozenEpochMs) } : {}),
  };
  await emit({ mode: resolved.mode, baseDir: resolved.baseDir, frozenEpochMs, env });
  return {
    mode: resolved.mode,
    baseDir: resolved.baseDir,
    mergeBaseSha,
    frozenEpochMs,
    reason: resolved.reason,
  };
}

// Allow direct CLI invocation from the action step.
if (import.meta.url === `file://${process.argv[1]}`) {
  prepareBase().catch((e) => {
    console.error(`[prepare-base] ${e.message}`);
    process.exit(1);
  });
}
