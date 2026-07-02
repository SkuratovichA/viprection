/**
 * Render the PR comment (and the $GITHUB_STEP_SUMMARY variant for forks).
 *
 * Images are referenced by URL — the caller uploads the changed base/head/diff
 * PNGs somewhere addressable (the previews branch, or a run artifact) and passes
 * a `urlFor(localPath)` resolver. This module is pure markdown, no I/O.
 */

const MARKER = '<!-- viprection:visual-diff -->';

function statusEmoji(s) {
  return { added: '🆕', removed: '🗑️', changed: '🔧', failed: '⚠️' }[s] ?? '•';
}

/**
 * @param {object} p
 * @param {object} p.report        compareGalleries() output
 * @param {object[]} p.explained   explainReport() output (changed/added/removed/failed)
 * @param {(localPath:string)=>string|null} p.urlFor  resolve a PNG path → URL (or null)
 * @param {string} [p.galleryUrl]  link to the full published gallery
 * @param {string} [p.headSha]
 * @param {boolean} [p.readOnly]   fork mode → note that this is a summary only
 * @returns {string} markdown
 */
export function renderComment({ report, explained, urlFor, galleryUrl, headSha, readOnly }) {
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

  // Screens are rendered EXPANDED: reviewers must see the changes without
  // hunting for a disclosure arrow. <details open> keeps them collapsible for
  // long comments; beyond OPEN_LIMIT screens the rest start collapsed.
  const OPEN_LIMIT = 6;
  explained.forEach((r, idx) => {
    const title = `${statusEmoji(r.status)} \`${r.key}\``;
    const open = idx < OPEN_LIMIT ? ' open' : '';
    lines.push('', `<details${open}><summary>${title} — ${r.status}</summary>`, '');
    lines.push(r.explanation, '');

    // Semantic diff of the HTML snapshots: what appeared / disappeared, in
    // words — readable even when the pixel change is just a layout shift, and
    // the way added/removed functionality shows up.
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

    // Image block: Before | After. "After" carries drawn boxes around the
    // changed regions when available — far more readable than the raw pixel
    // overlay, which turns layout shifts into red soup. The raw overlay stays
    // reachable as a link for the curious.
    const baseUrl = r.base ? urlFor(joinDir('base', r.base.png)) : null;
    const annUrl = r.annotatedPngName ? urlFor(`annotated/${r.annotatedPngName}`) : null;
    const headUrl = r.head ? urlFor(joinDir('head', r.head.png)) : null;
    const afterUrl = annUrl ?? headUrl;
    const diffUrl = r.diffPngName ? urlFor(`diff/${r.diffPngName}`) : null;

    if (baseUrl || afterUrl) {
      const headers = [baseUrl && 'Before', afterUrl && (annUrl ? 'After (changes boxed)' : 'After')].filter(Boolean);
      lines.push(`| ${headers.join(' | ')} |`);
      lines.push(`|${headers.map(() => '---').join('|')}|`);
      const cell = (u) => `<img src="${u}" width="380">`;
      lines.push(`| ${[baseUrl, afterUrl].filter(Boolean).map(cell).join(' | ')} |`);
    }
    if (diffUrl) lines.push('', `<sub>[raw pixel diff](${diffUrl})</sub>`);
    lines.push('', '</details>');
  });

  if (galleryUrl) lines.push('', `[Full gallery →](${galleryUrl})`);
  return lines.join('\n');
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
