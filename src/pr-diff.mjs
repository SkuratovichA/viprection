/**
 * W4 glue — the PR-mode orchestration.
 *
 * head gallery (already captured into cfg.outputDir) vs a BASE gallery:
 *   1. resolve the base (reuse the published per-branch gallery when valid,
 *      else it must be freshly captured — see resolveBase seam below),
 *   2. compareGalleries (with the HTML pre-filter),
 *   3. explain + render the comment,
 *   4. same-repo → upsert a sticky PR comment + upload images to the pages branch;
 *      fork      → write the report to $GITHUB_STEP_SUMMARY + an artifact (no push).
 *
 * The base-resolution staleness logic (capturedAtSha ancestor-check + uiGlob diff
 * + tool/browser version match) is salon-reach's `resolveBase` from change-gate.mjs.
 * Until that lands we stub it to "capture-base" (safe fallback) and read a base
 * dir the caller provides via VP_BASE_DIR.
 */
import { readFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compareGalleries } from './image-diff.mjs';
import { explainReport } from './explain.mjs';
import { renderComment, MARKER } from './comment.mjs';
import { resolveBase as resolveBaseImpl } from './resolve-base.mjs';

async function getChangedFiles(baseRef) {
  try {
    const { execFileSync } = await import('node:child_process');
    const range = baseRef ? `origin/${baseRef}...HEAD` : 'HEAD~1...HEAD';
    return execFileSync('git', ['diff', '--name-only', range], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}

export async function prDiff({
  configPath = process.env.VP_CONFIG_PATH || 'visual-preview.config.json',
  resolveBase = resolveBaseImpl, // fallback resolver (standalone use only)
  postComment, // injected by the caller (github api); if absent → summary only
  uploadImages, // injected: (changedResults, headDir, baseDir) => urlFor(localPath)
  isFork = process.env.VP_IS_FORK === 'true',
} = {}) {
  const cfg = JSON.parse(await readFile(configPath, 'utf8'));
  const headDir = cfg.outputDir;
  const baseRef = process.env.GITHUB_BASE_REF;

  // TRUST prepare-base's verdict. It already resolved base mode/dir once; re-
  // resolving here risks a divergent answer if git state shifted between steps.
  // Only fall back to resolving ourselves when prepare-base didn't run (e.g.
  // standalone/local invocation without VP_BASE_MODE).
  let base;
  if (process.env.VP_BASE_MODE) {
    base = { mode: process.env.VP_BASE_MODE, baseDir: process.env.VP_RESOLVED_BASE_DIR || null };
  } else {
    base = await resolveBase({
      config: cfg,
      mergeBaseSha: process.env.VP_MERGE_BASE_SHA,
      publishedMetaPath: process.env.VP_PUBLISHED_META,
      publishedDir: process.env.VP_PUBLISHED_DIR,
      freshBaseDir: process.env.VP_BASE_DIR,
    });
  }

  if (base.mode === 'none' || !base.baseDir) {
    // No base to diff against (first-ever run on this branch) — publish head as
    // the new baseline instead of erroring; report "baseline established".
    await summarize('📸 No base gallery yet — this run establishes the baseline.');
    await setOutput('changed-count', '0');
    return;
  }

  const report = await compareGalleries({
    baseDir: base.baseDir,
    headDir,
    diffDir: join(process.env.RUNNER_TEMP || '/tmp', 'vp-diff'),
    diffOptions: { ...(cfg.diff || {}) },
  });
  const changedFiles = await getChangedFiles(baseRef);
  const explained = explainReport(report, changedFiles);

  const touched = report.summary.added + report.summary.removed + report.summary.changed + report.summary.failed;
  await setOutput('changed-count', String(report.summary.changed));

  // Resolve image URLs (upload for same-repo; artifact-relative for forks).
  const urlFor = uploadImages
    ? await uploadImages(explained, headDir, base.baseDir)
    : () => null;

  const md = renderComment({
    report,
    explained,
    urlFor,
    galleryUrl: process.env.VP_GALLERY_URL,
    headSha: process.env.GITHUB_SHA,
    readOnly: isFork || !postComment,
  });

  // Always write the job summary (works on forks too).
  await summarize(md);

  if (postComment && !isFork) {
    await postComment(md, MARKER);
    console.log(`pr-diff: comment posted (${touched} screens touched).`);
  } else {
    console.log('pr-diff: fork/read-only — report in job summary + artifact only.');
  }
}

async function summarize(md) {
  const p = process.env.GITHUB_STEP_SUMMARY;
  if (p) await appendFile(p, md + '\n');
  else console.log(md);
}

async function setOutput(key, value) {
  const out = process.env.GITHUB_OUTPUT;
  if (out) await appendFile(out, `${key}=${value}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Wire the real GitHub API for same-repo runs; forks (read-only token) get the
  // job-summary path only.
  (async () => {
    const isFork = process.env.VP_IS_FORK === 'true';
    const token = process.env.VP_GITHUB_TOKEN;
    const repo = process.env.GITHUB_REPOSITORY;
    const prNumber = process.env.VP_PR_NUMBER;
    let postComment, uploadImages;
    if (!isFork && token && repo && prNumber) {
      const { makeCommentPoster, makeImageUploader } = await import('./github.mjs');
      postComment = makeCommentPoster({ repo, prNumber, token });
      uploadImages = makeImageUploader({
        repo, prNumber, token, pagesBranch: process.env.VP_PAGES_BRANCH || 'previews',
      });
    }
    return prDiff({ postComment, uploadImages, isFork });
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
