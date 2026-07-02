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

  for (const r of explained) {
    const title = `${statusEmoji(r.status)} \`${r.key}\``;
    lines.push('', `<details><summary>${title} — ${r.status}</summary>`, '');
    lines.push(r.explanation, '');

    // Image block: before | after | diff, whichever exist.
    const baseUrl = r.base ? urlFor(joinDir('base', r.base.png)) : null;
    const headUrl = r.head ? urlFor(joinDir('head', r.head.png)) : null;
    const diffUrl = r.diffPngName ? urlFor(`diff/${r.diffPngName}`) : null;

    if (headUrl || baseUrl || diffUrl) {
      lines.push('| ' + [baseUrl && 'Before', headUrl && 'After', diffUrl && 'Diff'].filter(Boolean).join(' | ') + ' |');
      lines.push('|' + [baseUrl, headUrl, diffUrl].filter(Boolean).map(() => '---').join('|') + '|');
      const cell = (u) => (u ? `<img src="${u}" width="260">` : '');
      lines.push('| ' + [baseUrl && cell(baseUrl), headUrl && cell(headUrl), diffUrl && cell(diffUrl)].filter((x) => x !== false && x !== null).join(' | ') + ' |');
    }
    lines.push('', '</details>');
  }

  if (galleryUrl) lines.push('', `[Full gallery →](${galleryUrl})`);
  return lines.join('\n');
}

// PNG paths in the manifest are relative to the gallery dir; images are uploaded
// under base/ and head/ subfolders. Normalize "./x.png" → "<side>/x.png".
function joinDir(side, png) {
  return `${side}/${String(png).replace(/^\.\//, '')}`;
}

export { MARKER };
