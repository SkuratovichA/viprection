/**
 * Render the PR comment (and the $GITHUB_STEP_SUMMARY variant for forks).
 *
 * Images are referenced by URL — the caller uploads the changed base/head/diff
 * PNGs somewhere addressable (the previews branch, or a run artifact) and passes
 * a `urlFor(localPath)` resolver. This module is pure markdown, no I/O.
 */

import { parseScreenKey } from './schema.mjs';

const MARKER = '<!-- viprection:visual-diff -->';

function statusEmoji(s) {
  return { added: '🆕', removed: '🗑️', changed: '🔧', failed: '⚠️' }[s] ?? '•';
}

/** Viewport of a diff RESULT — authoritative on the object, never string-parsed. */
function resultViewport(r) {
  return r.head?.viewport ?? r.base?.viewport ?? 'desktop';
}

/** Device sub-heading badge: desktop → 🖥, anything else → 📱 + its name. */
function deviceBadge(vp) {
  return vp === 'desktop' ? '🖥 Desktop' : `📱 ${vp}`;
}

/**
 * @param {object} p
 * @param {object} p.report        compareGalleries() output
 * @param {object[]} p.explained   explainReport() output (changed/added/removed/failed)
 * @param {(localPath:string)=>string|null} p.urlFor  resolve a PNG path → URL (or null)
 * @param {string} [p.galleryUrl]  link to the full published gallery
 * @param {string} [p.headSha]
 * @param {boolean} [p.readOnly]   fork mode → note that this is a summary only
 * @param {boolean} [p.inlineImages=true]  false → auth-walled base camo can't render;
 *   render image links instead of inline <img>. (report.viewports carries device order.)
 * @returns {string} markdown
 */
export function renderComment({ report, explained, urlFor, galleryUrl, headSha, readOnly, coverage, artifactNote, inlineImages = true }) {
  const deviceOrder = (report.viewports ?? [{ name: 'desktop' }]).map((v) => v.name);
  const { summary } = report;
  const totalTouched = summary.added + summary.removed + summary.changed + summary.failed;

  const lines = [MARKER, '## 📸 Visual changes'];

  if (totalTouched === 0) {
    lines.push('', '✅ No visual changes detected across the screen catalog.');
    if (galleryUrl) lines.push('', `[Full gallery →](${galleryUrl})`);
    return lines.join('\n');
  }

  const parts = [];
  if (summary.changed) parts.push(`**${summary.changed} changed**`);
  if (summary.added) parts.push(`**${summary.added} new**`);
  if (summary.removed) parts.push(`**${summary.removed} removed**`);
  if (summary.failed) parts.push(`**${summary.failed} failed**`);
  lines.push('', parts.join(' · ') + ` · ${summary.unchanged} unchanged`);
  if (headSha) lines.push('', `<sub>head \`${headSha.slice(0, 7)}\`</sub>`);
  if (readOnly) {
    lines.push(
      '',
      '> ℹ️ Fork PR — read-only run. Images are in the workflow artifact; a maintainer can re-run with the `visual-diff-approved` label for inline previews.'
    );
  }
  if (artifactNote) {
    lines.push(
      '',
      `> 📎 Before/after/diff images are attached to this run as the **visual-diff-images** artifact — [download from the run](${artifactNote}). (Inline previews are off for this private repo.)`
    );
  }

  // BUCKET explained items by LOGICAL screen (section/name, no @viewport): the
  // desktop and mobile variants of one screen are SEPARATE explained items but
  // must render as ONE <details> with per-device sub-sections. A bucket's
  // position = the position of its first-seen member, so the pre-sorted
  // explained order (added→removed→changed→failed, biggest-diff-first) is kept.
  const buckets = new Map(); // baseKey → { baseKey, section, name, variants: [] }
  for (const r of explained) {
    const { section, name } = parseScreenKey(r.key);
    const baseKey = `${section}/${name}`;
    let b = buckets.get(baseKey);
    if (!b) {
      b = { baseKey, section, name, variants: [] };
      buckets.set(baseKey, b);
    }
    b.variants.push(r);
  }
  // Within a bucket, order devices Desktop-first then by report.viewports order.
  const deviceRank = (vp) => {
    if (vp === 'desktop') return -1;
    const i = deviceOrder.indexOf(vp);
    return i === -1 ? deviceOrder.length : i;
  };

  // Screens are rendered EXPANDED: reviewers must see the changes without
  // hunting for a disclosure arrow. <details open> keeps them collapsible for
  // long comments; beyond OPEN_LIMIT SCREENS (not device-rows) the rest start
  // collapsed.
  const OPEN_LIMIT = 6;
  [...buckets.values()].forEach((bucket, idx) => {
    const variants = [...bucket.variants].sort(
      (a, b) => deviceRank(resultViewport(a)) - deviceRank(resultViewport(b))
    );
    const open = idx < OPEN_LIMIT ? ' open' : '';
    // One overall status for the summary line: if every variant shares a status
    // show it, else 'multiple'.
    const statuses = new Set(variants.map((v) => v.status));
    const overall = statuses.size === 1 ? [...statuses][0] : 'multiple';
    const title = `${statusEmoji(variants[0].status)} \`${bucket.baseKey}\``;
    lines.push('', `<details${open}><summary>${title} — ${overall}</summary>`, '');

    variants.forEach((r, vi) => {
      const vp = resultViewport(r);
      // Per-device sub-heading with a device badge; append the device status when
      // the bucket mixes statuses (e.g. 'mobile — ➕ added').
      const perStatus = overall === 'multiple' ? ` — ${statusEmoji(r.status)} ${r.status}` : '';
      lines.push(`#### ${deviceBadge(vp)}${perStatus}`, '');
      renderScreenBody(lines, r, { urlFor, inlineImages });
      if (vi < variants.length - 1) lines.push('');
    });

    lines.push('', '</details>');
  });

  renderCoverage(lines, { coverage });

  if (galleryUrl) lines.push('', `[Full gallery →](${galleryUrl})`);
  return lines.join('\n');
}

/**
 * Render ONE device variant's body: the prose explanation, the semantic HTML
 * "what changed" bullets, and the visuals (inline Before|After table, or —
 * when inlineImages is false, e.g. the auth-walled base that camo can't proxy —
 * compact image links). Appends to `lines`.
 */
function renderScreenBody(lines, r, { urlFor, inlineImages }) {
  lines.push(r.explanation, '');

  // Semantic diff of the HTML snapshots: what appeared / disappeared, in
  // words — readable even when the pixel change is just a layout shift, and
  // the way added/removed functionality shows up. (Text-only → stays in both
  // inline and link modes.)
  const hc = r.htmlChanges;
  if (hc && (hc.added.length || hc.removed.length)) {
    const CAP = 8;
    lines.push('**What changed on the screen:**', '');
    for (const l of hc.added.slice(0, CAP)) lines.push(`- ➕ \`${escapeMd(l)}\``);
    if (hc.added.length > CAP) lines.push(`- ➕ …and ${hc.added.length - CAP} more added`);
    for (const l of hc.removed.slice(0, CAP)) lines.push(`- ➖ \`${escapeMd(l)}\``);
    if (hc.removed.length > CAP) lines.push(`- ➖ …and ${hc.removed.length - CAP} more removed`);
    lines.push('');
  }

  // "After" carries drawn boxes around the changed regions when available — far
  // more readable than the raw pixel overlay, which turns layout shifts into red
  // soup. The raw overlay stays reachable as a link for the curious.
  const baseUrl = r.base ? urlFor(joinDir('base', r.base.png)) : null;
  const annUrl = r.annotatedPngName ? urlFor(`annotated/${r.annotatedPngName}`) : null;
  const headUrl = r.head ? urlFor(joinDir('head', r.head.png)) : null;
  const afterUrl = annUrl ?? headUrl;
  const diffUrl = r.diffPngName ? urlFor(`diff/${r.diffPngName}`) : null;

  if (inlineImages) {
    // Image block: Before | After.
    if (baseUrl || afterUrl) {
      const headers = [baseUrl && 'Before', afterUrl && (annUrl ? 'After (changes boxed)' : 'After')].filter(Boolean);
      lines.push(`| ${headers.join(' | ')} |`);
      lines.push(`|${headers.map(() => '---').join('|')}|`);
      const cell = (u) => `<img src="${u}" width="380">`;
      lines.push(`| ${[baseUrl, afterUrl].filter(Boolean).map(cell).join(' | ')} |`);
    }
    if (diffUrl) lines.push('', `<sub>[raw pixel diff](${diffUrl})</sub>`);
  } else {
    // LINK-MODE: the auth-walled busano path — camo can't inline, so link the
    // present images compactly instead of an <img> table.
    const parts = [];
    if (baseUrl) parts.push(`Before: [view](${baseUrl})`);
    if (afterUrl) parts.push(`After: [view](${afterUrl})`);
    if (diffUrl) parts.push(`[raw diff](${diffUrl})`);
    if (parts.length) lines.push(`- ${parts.join(' · ')}`);
  }
}

/**
 * Deterministic, zero-cost coverage nag (the no-LLM alternative to an agentic
 * enrichment bot): tell the PR author exactly what the visual layer could NOT
 * see, so gaps get fixed as part of the PR instead of rotting silently.
 */
function renderCoverage(lines, { coverage }) {
  if (!coverage) return;
  const { uncoveredChangedFiles = [], autoScreens = [], paramRoutes = [] } = coverage;
  if (!uncoveredChangedFiles.length && !autoScreens.length && !paramRoutes.length) return;

  lines.push('', '### 🧭 Coverage', '');
  if (uncoveredChangedFiles.length) {
    lines.push(
      `⚠️ **${uncoveredChangedFiles.length} changed UI file(s) matched no captured screen** — their visual effect may be untested. Consider a catalog entry or a state walker:`
    );
    for (const f of uncoveredChangedFiles.slice(0, 8)) lines.push(`- \`${f}\``);
    if (uncoveredChangedFiles.length > 8) lines.push(`- …and ${uncoveredChangedFiles.length - 8} more`);
    lines.push('');
  }
  if (autoScreens.length) {
    lines.push(
      `📝 **${autoScreens.length} screen(s) are auto-covered but undocumented** — add a catalog entry (caption/details) to enrich: ${autoScreens.slice(0, 6).map((s) => `\`${s}\``).join(', ')}${autoScreens.length > 6 ? ', …' : ''}`
    );
    lines.push('');
  }
  if (paramRoutes.length) {
    lines.push(
      `🧩 **${paramRoutes.length} parameterized route(s) need fixtures** to be captured at all: ${paramRoutes.slice(0, 6).map((s) => `\`${s}\``).join(', ')}`
    );
    lines.push('');
  }
}

function escapeMd(s) {
  return String(s).replace(/`/g, "'").replace(/\|/g, '/').slice(0, 160);
}

// PNG paths in the manifest are relative to the gallery dir; images are uploaded
// under base/ and head/ subfolders. Normalize "./x.png" → "<side>/x.png".
function joinDir(side, png) {
  return `${side}/${String(png).replace(/^\.\//, '')}`;
}

export { MARKER };
