/**
 * "What changed" explanation — smart-mechanical (no LLM required).
 *
 * Joins the image-diff results with the gallery manifest metadata
 * (section/route/caption) and the PR's changed files, producing a concise,
 * honest per-screen note. It does NOT claim causality — it surfaces "related
 * changes" by matching route/section segments against changed file paths.
 *
 * An optional LLM pass (src/llm-summary.mjs) can enrich these later; this is the
 * always-on, deterministic, free baseline.
 */

/** Tokenize a path/route into lowercased alnum segments for fuzzy overlap. */
function segments(s) {
  return (s || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOP.has(t));
}
const STOP = new Set([
  'src', 'packages', 'app', 'index', 'the', 'com', 'tsx', 'ts', 'jsx', 'js',
  'mjs', 'json', 'client', 'admin', 'server', 'components', 'component', 'page',
  'pages', 'routes', 'route', 'modules', 'module', 'dto',
]);

/** Prose keeps the 3 best hits — more reads as noise in the comment line. */
const PROSE_RELATED_LIMIT = 3;
/**
 * The structured list feeds the coverage subtraction in pr-diff.mjs, so it must
 * carry EVERY changed file the heuristic ties to the screen — capping it to the
 * prose top-3 falsely reported all further related files as "uncovered". The
 * high cap only guards against pathological overlap on huge PRs.
 */
const STRUCTURED_RELATED_LIMIT = 50;

/**
 * Rank changed files by segment-overlap with a screen's route/name/section.
 * Returns the top-N most-related file paths (best-effort, not causal).
 */
export function relatedFiles(screenResult, changedFiles, limit = PROSE_RELATED_LIMIT) {
  const sc = screenResult.head ?? screenResult.base ?? {};
  const key = screenResult.key ?? '';
  const needle = new Set([
    ...segments(sc.route),
    ...segments(sc.name),
    ...segments(key),
    ...segments(sc.caption),
  ]);
  if (needle.size === 0) return [];
  const scored = changedFiles
    .map((f) => {
      const fileSegs = segments(f);
      let overlap = 0;
      for (const s of fileSegs) if (needle.has(s)) overlap++;
      return { f, overlap };
    })
    .filter((x) => x.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap);
  return scored.slice(0, limit).map((x) => x.f);
}

/** Human size of a diff (pixels %). */
function pct(ratio) {
  if (ratio == null) return '';
  const p = ratio * 100;
  return p < 0.1 ? '<0.1%' : `${p.toFixed(1)}%`;
}

/**
 * One-line, honest explanation for a single screen result.
 * @param {object} r          a compareGalleries() result item
 * @param {string[]} changedFiles  PR changed file paths
 */
export function explainScreen(r, changedFiles) {
  const sc = r.head ?? r.base ?? {};
  const where = [sc.route && `\`${sc.route}\``, sc.caption].filter(Boolean).join(' — ');
  switch (r.status) {
    case 'added':
      return `**new screen**${where ? ` (${where})` : ''}.`;
    case 'removed':
      return `**screen removed**${where ? ` (was ${where})` : ''}.`;
    case 'failed':
      return `**capture failed**${r.failureReason ? `: ${r.failureReason}` : ''}.`;
    case 'changed': {
      const bits = [];
      if (r.resized) bits.push('dimensions changed');
      bits.push(`${pct(r.diffRatio)} of pixels differ`);
      if (r.bbox) bits.push(`region ~${r.bbox.w}×${r.bbox.h}px at (${r.bbox.x},${r.bbox.y})`);
      const rel = relatedFiles(r, changedFiles, STRUCTURED_RELATED_LIMIT);
      r.relatedFiles = rel; // structured (full list), for coverage reporting downstream
      const prose = rel.slice(0, PROSE_RELATED_LIMIT);
      const relNote = prose.length ? ` — likely related to ${prose.map((f) => `\`${f}\``).join(', ')}` : '';
      return `${bits.join(', ')}${relNote}.`;
    }
    default:
      return '';
  }
}

/** Build explanations for the whole report (skips unchanged). */
export function explainReport(report, changedFiles) {
  return report.results
    .filter((r) => r.status !== 'unchanged')
    .map((r) => {
      // explainScreen sets r.relatedFiles as a side effect — it must run BEFORE
      // the spread copies r, or the structured field silently vanishes from the
      // returned items (which blanked the coverage subtraction downstream).
      const explanation = explainScreen(r, changedFiles);
      return { ...r, explanation };
    });
}
