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
import { manifestViewports, screenKeyToFilename } from './schema.mjs';

async function getChangedFiles(baseRef) {
  try {
    const { execFileSync } = await import('node:child_process');
    const range = baseRef ? `origin/${baseRef}...HEAD` : 'HEAD~1...HEAD';
    return execFileSync('git', ['diff', '--name-only', range], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch (e) {
    // Never silently: a lost changed-file list degrades the "related files"
    // attribution in the comment — worth a warning so it's diagnosable.
    console.warn(`[pr-diff] could not compute changed files (${e.message.split('\n')[0]}); related-file hints disabled`);
    return [];
  }
}

export async function prDiff({
  configPath = process.env.VP_CONFIG_PATH || 'visual-preview.config.json',
  resolveBase = resolveBaseImpl, // fallback resolver (standalone use only)
  postComment, // injected by the caller (github api); if absent → summary only
  uploadImages, // injected: (changedResults, headDir, baseDir) => urlFor(localPath)
  changedFiles: changedFilesIn, // injected (tests); default: git diff vs the base ref
  isFork = process.env.VP_IS_FORK === 'true',
  artifactMode = false, // true → images are in a run artifact, not inline
  inlineImages = true, // false → comment renders links, not inline <img> (auth-walled base)
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

  // Read the HEAD manifest ONCE up front: it is the canonical source for the
  // capture viewports (threaded into the report for renderers) AND the coverage
  // screen list below. Reading it twice risked a divergent view of the same
  // file; a single read keeps report.viewports and coverage consistent.
  let headManifest = null;
  try {
    headManifest = JSON.parse(await readFile(join(headDir, 'manifest.json'), 'utf8'));
  } catch (e) {
    console.warn(`[pr-diff] head manifest unreadable (${e.message}); viewports default to desktop, coverage skipped`);
  }
  // manifestViewports warns on a legacy (no `viewports`) manifest and returns
  // the desktop default — renderers read ONLY report.viewports.
  report.viewports = manifestViewports(headManifest ?? {});

  const changedFiles = changedFilesIn ?? (await getChangedFiles(baseRef));
  const explained = explainReport(report, changedFiles);

  // Semantic HTML-snapshot diff: attach added/removed visible lines per screen.
  const { attachHtmlDiffs } = await import('./html-diff.mjs');
  await attachHtmlDiffs(explained, base.baseDir, headDir);

  // Draw boxes around changed regions on the AFTER image (readable, unlike the
  // raw overlay under layout shifts). Failures degrade to the plain head image.
  try {
    const { annotatePng } = await import('./annotate.mjs');
    const { mkdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const annDir = join(process.env.RUNNER_TEMP || '/tmp', 'vp-annotated');
    await mkdir(annDir, { recursive: true });
    for (const r of explained) {
      if (r.status !== 'changed' || !r.bbox || !r.head?.png) continue;
      const src = join(headDir, String(r.head.png).replace(/^\.\//, ''));
      // THE canonical sanitizer: keeps '@' so '@mobile' survives, matching
      // image-diff's diff name. The old [^a-zA-Z0-9._-] class ate '@' and made
      // annotated names diverge from diff names — that pairing bug ends here.
      const name = `${screenKeyToFilename(r.key)}.annotated.png`;
      const dest = join(annDir, name);
      try {
        annotatePng(src, dest, [r.bbox]);
        r.annotatedPng = dest;
        r.annotatedPngName = name;
      } catch (e) {
        console.warn(`[annotate] ${r.key}: ${e.message} — falling back to the plain After image`);
      }
    }
  } catch (e) {
    console.warn(`[annotate] disabled: ${e.message}`);
  }

  const touched = report.summary.added + report.summary.removed + report.summary.changed + report.summary.failed;
  await setOutput('changed-count', String(report.summary.changed));

  // Resolve image URLs (upload for same-repo; artifact-relative for forks).
  const urlFor = uploadImages
    ? await uploadImages(explained, headDir, base.baseDir)
    : () => null;

  // Coverage nag inputs (all deterministic, no LLM): what the visual layer
  // could not see on this PR. Reuses the HEAD manifest read once up front.
  const { globMatch } = await import('./glob.mjs');
  let coverage;
  if (headManifest) {
    try {
      const screens = (headManifest.sections ?? []).flatMap((sec) =>
        (sec.screens ?? []).map((sc) => ({ ...sc, sectionId: sec.id }))
      );
      // Sections now list the SAME logical screen once PER viewport, so the
      // route/name of a multi-viewport screen repeats — dedupe to count SCREENS.
      const autoScreens = [
        ...new Set(
          screens
            .filter((sc) => String(sc.name).startsWith('auto--') || /auto-discovered/i.test(sc.caption ?? ''))
            .map((sc) => sc.route || sc.name)
        ),
      ];
      const paramRoutes = [
        ...new Set(
          screens
            .filter((sc) => sc.sectionId === 'needs-attention')
            .map((sc) => sc.route || sc.name)
        ),
      ];
      const uiFiles = (changedFiles ?? []).filter((f) => (cfg.uiGlobs ?? []).some((g) => globMatch(g, f)));
      const seen = new Set(explained.flatMap((r) => r.relatedFiles ?? []));
      const uncoveredChangedFiles = uiFiles.filter((f) => !seen.has(f));
      coverage = { uncoveredChangedFiles, autoScreens, paramRoutes };
    } catch (e) {
      console.warn(`[coverage] skipped: ${e.message}`);
    }
  }

  // In artifact mode the run URL points reviewers at the uploaded images.
  const runUrl =
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null;

  const md = renderComment({
    report,
    explained,
    urlFor,
    galleryUrl: process.env.VP_GALLERY_URL,
    headSha: process.env.GITHUB_SHA,
    readOnly: isFork || !postComment,
    coverage,
    artifactNote: artifactMode && touched > 0 ? runUrl : null,
    // Link-mode: an auth-walled public base can't be rendered by camo (fetches
    // anonymously) → render links instead of inline <img>. report.viewports
    // carries the device order; renderComment reads it off the report.
    inlineImages,
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
    // Image hosting: 'artifact' → stage images for the workflow to upload (no
    // public Pages site); else the default Pages/previews uploader.
    const { readFile: rf } = await import('node:fs/promises');
    const cfg = JSON.parse(await rf(process.env.VP_CONFIG_PATH || 'visual-preview.config.json', 'utf8'));
    const artifactMode = cfg.imageHosting === 'artifact';
    let postComment, uploadImages;
    let inlineImages = true;
    if (!isFork && token && repo && prNumber) {
      const gh = await import('./github.mjs');
      postComment = gh.makeCommentPoster({ repo, prNumber, token });
      if (artifactMode) {
        const { join } = await import('node:path');
        const stageDir = join(process.env.RUNNER_TEMP || '/tmp', 'vp-artifact-images');
        uploadImages = gh.makeArtifactImageStager({ stageDir });
        // Tell the workflow where to find the images to upload as an artifact.
        await setOutput('image-artifact-dir', stageDir);
      } else {
        const pagesBranch = process.env.VP_PAGES_BRANCH || 'previews';
        uploadImages = gh.makeImageUploader({
          repo, prNumber, token, pagesBranch, publicBaseUrl: cfg.publicBaseUrl,
        });
        // Link-mode probe: only a config publicBaseUrl can be auth-walled (the
        // busano Basic-auth CloudFront case). Pages/raw are known camo-friendly
        // for public repos → skip the probe (no cost) and inline. When a
        // publicBaseUrl IS set, an anonymous HEAD tells us whether camo can
        // fetch it; if not, the comment degrades to links.
        if (cfg.publicBaseUrl) {
          const { base } = await gh.resolvePublicBase({
            repo, token, publicBaseUrl: cfg.publicBaseUrl, pagesBranch,
          });
          const probe = await gh.probePublicBase(base);
          inlineImages = probe.inlineImages;
        }
      }
    }
    return prDiff({ postComment, uploadImages, isFork, artifactMode, inlineImages });
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
