/**
 * Image-diff engine for visual-preview-action.
 *
 * Given two gallery outputs (base vs head), each a GalleryManifest + PNGs, it:
 *   1. aligns screens by `name` (section-qualified),
 *   2. classifies each as added / removed / changed / unchanged / failed,
 *   3. for changed screens, pixel-diffs (pixelmatch) with optional ignore-regions
 *      and produces an overlay diff image + change stats (%pixels, bounding box).
 *
 * Deterministic and dependency-light: only `pixelmatch` + `pngjs` (both tiny,
 * widely used). No app knowledge — operates purely on manifests + PNG bytes.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

/**
 * @typedef {Object} ScreenRef
 * @property {string} section
 * @property {string} name
 * @property {string} route
 * @property {string} caption
 * @property {string} png        path relative to the manifest dir
 * @property {'ok'|'failed'} status
 */

/** Flatten a GalleryManifest into a name→screen map (section-qualified key). */
export function indexManifest(manifest) {
  const byKey = new Map();
  for (const sec of manifest.sections ?? []) {
    for (const sc of sec.screens ?? []) {
      byKey.set(`${sec.id}/${sc.name}`, { section: sec.id, ...sc });
    }
  }
  return byKey;
}

/** Load a PNG file into a pngjs object. */
async function loadPng(path) {
  const buf = await readFile(path);
  return PNG.sync.read(buf);
}

/**
 * Pad two PNGs to a common canvas (max width/height) so mismatched sizes still
 * diff — a size change is itself a visible change, and we surface it.
 */
function padToCommon(a, b) {
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const pad = (src) => {
    if (src.width === width && src.height === height) return src;
    const out = new PNG({ width, height });
    // transparent background
    out.data.fill(0);
    PNG.bitblt(src, out, 0, 0, src.width, src.height, 0, 0);
    return out;
  };
  return { a: pad(a), b: pad(b), width, height, resized: a.width !== b.width || a.height !== b.height };
}

/** Blank out ignore-region rectangles in both images so volatile UI is skipped. */
function applyIgnoreRegions(img, regions) {
  for (const r of regions) {
    for (let y = r.y; y < Math.min(r.y + r.h, img.height); y++) {
      for (let x = r.x; x < Math.min(r.x + r.w, img.width); x++) {
        const idx = (img.width * y + x) << 2;
        img.data[idx] = 0;
        img.data[idx + 1] = 0;
        img.data[idx + 2] = 0;
        img.data[idx + 3] = 255;
      }
    }
  }
}

/** Bounding box of differing pixels in a pixelmatch diff buffer (magenta = diff). */
function diffBoundingBox(diffPng) {
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  const { width, height, data } = diffPng;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) << 2;
      // pixelmatch marks diffs in red/magenta with full alpha; detect strong R.
      if (data[idx] > 200 && data[idx + 1] < 100 && data[idx + 3] > 0) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * Diff a single screen present in both sets.
 * @returns {{changed:boolean, diffRatio:number, bbox:object|null, resized:boolean, diffPngPath?:string}}
 */
export async function diffScreen({ basePng, headPng, diffOutPath, threshold, changedRatioGate, ignoreRegions }) {
  const [a, b] = await Promise.all([loadPng(basePng), loadPng(headPng)]);
  const { a: pa, b: pb, width, height, resized } = padToCommon(a, b);
  if (ignoreRegions?.length) {
    applyIgnoreRegions(pa, ignoreRegions);
    applyIgnoreRegions(pb, ignoreRegions);
  }
  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(pa.data, pb.data, diff.data, width, height, {
    threshold: threshold ?? 0.1,
    includeAA: false,
  });
  const total = width * height;
  const diffRatio = total === 0 ? 0 : diffPixels / total;
  const changed = resized || diffRatio >= (changedRatioGate ?? 0.001);
  let diffPngPath;
  if (changed) {
    await mkdir(dirname(diffOutPath), { recursive: true });
    await writeFile(diffOutPath, PNG.sync.write(diff));
    diffPngPath = diffOutPath;
  }
  return { changed, diffRatio, bbox: diffBoundingBox(diff), resized, diffPngPath };
}

/**
 * Compare two gallery dirs. `regionsFor(name)` returns ignore-regions for a
 * screen (from config). Returns a structured report.
 *
 * @param {Object} p
 * @param {string} p.baseDir  dir containing base manifest.json + PNGs
 * @param {string} p.headDir  dir containing head manifest.json + PNGs
 * @param {string} p.diffDir  where to write per-screen diff overlays
 * @param {object} p.diffOptions  { threshold, changedRatioGate, ignoreRegions[] }
 */
export async function compareGalleries({ baseDir, headDir, diffDir, diffOptions = {} }) {
  const [baseManifest, headManifest] = await Promise.all([
    readFile(join(baseDir, 'manifest.json'), 'utf8').then(JSON.parse),
    readFile(join(headDir, 'manifest.json'), 'utf8').then(JSON.parse),
  ]);
  const baseIdx = indexManifest(baseManifest);
  const headIdx = indexManifest(headManifest);

  const regionsFor = (key) =>
    (diffOptions.ignoreRegions ?? []).filter((r) => r.screen === '*' || r.screen === key.split('/')[1]);

  const results = [];
  const allKeys = new Set([...baseIdx.keys(), ...headIdx.keys()]);
  for (const key of allKeys) {
    const base = baseIdx.get(key);
    const head = headIdx.get(key);

    if (base && !head) { results.push({ key, status: 'removed', head: null, base }); continue; }
    if (!base && head) { results.push({ key, status: 'added', head, base: null }); continue; }
    if (head.status === 'failed' || base.status === 'failed') {
      results.push({ key, status: 'failed', head, base, failureReason: head.failureReason ?? base.failureReason });
      continue;
    }
    const d = await diffScreen({
      basePng: join(baseDir, base.png.replace(/^\.\//, '')),
      headPng: join(headDir, head.png.replace(/^\.\//, '')),
      diffOutPath: join(diffDir, `${key.replace(/\//g, '__')}.diff.png`),
      threshold: diffOptions.threshold,
      changedRatioGate: diffOptions.changedRatioGate,
      ignoreRegions: regionsFor(key),
    });
    results.push({
      key, status: d.changed ? 'changed' : 'unchanged',
      head, base, diffRatio: d.diffRatio, bbox: d.bbox, resized: d.resized, diffPng: d.diffPngPath,
    });
  }

  const summary = {
    added: results.filter((r) => r.status === 'added').length,
    removed: results.filter((r) => r.status === 'removed').length,
    changed: results.filter((r) => r.status === 'changed').length,
    unchanged: results.filter((r) => r.status === 'unchanged').length,
    failed: results.filter((r) => r.status === 'failed').length,
  };
  // Sort so the interesting stuff (added/removed/changed, biggest diff first)
  // leads the report.
  const order = { added: 0, removed: 1, changed: 2, failed: 3, unchanged: 4 };
  results.sort((x, y) => (order[x.status] - order[y.status]) || ((y.diffRatio ?? 0) - (x.diffRatio ?? 0)));
  return { summary, results, baseProject: baseManifest.project, headProject: headManifest.project };
}
