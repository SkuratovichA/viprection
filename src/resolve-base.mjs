/**
 * Base-gallery resolution for the PR visual diff (the "reuse the published
 * per-branch gallery as the base" optimization, with the staleness guard).
 *
 * A published gallery is a valid base for a PR iff:
 *   1. `preview-meta.json` exists next to its manifest and parses, AND
 *   2. its tool + browser versions match the current environment (a renderer
 *      or capture-tool bump invalidates pixel comparability), AND
 *   3. its `capturedAtSha` equals the PR's merge-base, OR is an ancestor of
 *      the merge-base with NO UI-affecting files changed in between
 *      (`git diff --name-only capturedAtSha..mergeBaseSha` vs `uiGlobs`) —
 *      the change-gate skips non-UI commits, so a "stale" SHA is often still
 *      visually identical to the merge-base.
 *
 * Contract (the pr-diff seam):
 *   in : { config, mergeBaseSha, publishedMetaPath, publishedDir, freshBaseDir }
 *   out: { mode: 'reuse',        baseDir: publishedDir, reason }
 *      | { mode: 'capture-base', baseDir: freshBaseDir, reason }
 *      | { mode: 'none',         baseDir: null,         reason }   // base unreachable
 *
 * 'none' is returned ONLY when there is no merge-base to compare against
 * (e.g. unrelated histories / missing SHA) — the caller treats it as
 * "establish a baseline", not an error.
 *
 * Dependency-free; git is invoked via execFile. All git failures degrade to
 * the safe answer ('capture-base'), never throw.
 */
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { globMatch } from './glob.mjs';
import { toolVersion, browserVersion } from './versions.mjs';

/**
 * True when two browser version strings share the same MAJOR.MINOR series
 * (e.g. "Google Chrome 149.0.7827.200" vs "... 149.0.7827.155" → true;
 * 149.x vs 150.x → false). Falls back to exact comparison when no version
 * number can be extracted.
 */
export function browserSeriesMatch(a, b) {
  const series = (v) => {
    const m = /(\d+)\.(\d+)/.exec(String(v ?? ''));
    return m ? `${m[1]}.${m[2]}` : null;
  };
  const sa = series(a);
  const sb = series(b);
  if (sa === null || sb === null) return String(a) === String(b);
  return sa === sb;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function isAncestor(ancestor, descendant, cwd) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      cwd,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function changedFiles(from, to, cwd) {
  const out = git(['diff', '--name-only', `${from}..${to}`], cwd);
  return out.split('\n').filter(Boolean);
}

function touchesUiGlobs(files, uiGlobs) {
  return files.some((file) => uiGlobs.some((glob) => globMatch(glob, file)));
}

/**
 * @param {object} args
 * @param {object} args.config            validated visual-preview config (uiGlobs used)
 * @param {string|null} args.mergeBaseSha merge-base of the PR vs its base branch
 * @param {string} args.publishedMetaPath path to the published preview-meta.json
 * @param {string} args.publishedDir      dir of the published base gallery
 * @param {string} args.freshBaseDir      dir a fresh base capture would use
 * @param {string} [args.repoDir]         git repo dir (default: cwd)
 * @param {object} [args.currentVersions] {tool, browser} override (tests / precomputed)
 */
export async function resolveBase({
  config,
  mergeBaseSha,
  publishedMetaPath,
  publishedDir,
  freshBaseDir,
  repoDir = process.cwd(),
  currentVersions,
}) {
  if (!mergeBaseSha) {
    return { mode: 'none', baseDir: null, reason: 'no merge-base (unrelated histories?)' };
  }

  let meta;
  try {
    meta = JSON.parse(await readFile(publishedMetaPath, 'utf8'));
  } catch {
    return {
      mode: 'capture-base',
      baseDir: freshBaseDir,
      reason: `no published preview-meta at ${publishedMetaPath}`,
    };
  }
  if (!meta || typeof meta.capturedAtSha !== 'string' || meta.capturedAtSha.length < 7) {
    return { mode: 'capture-base', baseDir: freshBaseDir, reason: 'invalid preview-meta' };
  }

  const current = currentVersions ?? {
    tool: await toolVersion(config),
    browser: await browserVersion(),
  };
  // Tool version must match exactly (a capture-tool change invalidates pixel
  // comparability). Browser matches on MAJOR.MINOR only: GitHub runner pools
  // roll Chrome PATCH versions independently (e.g. 149.0.7827.200 vs .155), so
  // an exact match would defeat reuse on almost every run — and patch-level
  // rendering drift is what the pixelmatch threshold + changed-ratio gate
  // already absorb.
  if (meta.toolVersion !== current.tool) {
    return {
      mode: 'capture-base',
      baseDir: freshBaseDir,
      reason: `tool version mismatch (published ${meta.toolVersion}, current ${current.tool})`,
    };
  }
  if (!browserSeriesMatch(meta.browserVersion, current.browser)) {
    return {
      mode: 'capture-base',
      baseDir: freshBaseDir,
      reason: `browser series mismatch (published ${meta.browserVersion}, current ${current.browser})`,
    };
  }

  if (meta.capturedAtSha === mergeBaseSha) {
    return { mode: 'reuse', baseDir: publishedDir, reason: 'published capture is exactly the merge-base' };
  }

  try {
    if (!isAncestor(meta.capturedAtSha, mergeBaseSha, repoDir)) {
      return {
        mode: 'capture-base',
        baseDir: freshBaseDir,
        reason: `published capture ${meta.capturedAtSha.slice(0, 10)} is not an ancestor of merge-base`,
      };
    }
    const files = changedFiles(meta.capturedAtSha, mergeBaseSha, repoDir);
    if (touchesUiGlobs(files, config.uiGlobs ?? [])) {
      return {
        mode: 'capture-base',
        baseDir: freshBaseDir,
        reason: `UI-affecting changes between published capture and merge-base (${files.length} files)`,
      };
    }
    return {
      mode: 'reuse',
      baseDir: publishedDir,
      reason: `published capture is an ancestor with no UI-affecting changes (${files.length} non-UI files)`,
    };
  } catch (e) {
    // Any git hiccup (shallow clone missing the SHA, etc.) degrades to the safe answer.
    return {
      mode: 'capture-base',
      baseDir: freshBaseDir,
      reason: `git comparison failed (${e.message.split('\n')[0]})`,
    };
  }
}
