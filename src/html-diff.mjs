/**
 * Structural HTML diff for the PR comment: compare the base/head self-contained
 * HTML SNAPSHOTS of a screen and report which visible text lines were added or
 * removed.
 *
 * This answers "WHAT changed" semantically — a new block ("Email sender not
 * connected"), a removed button, a renamed heading — and is immune to the
 * layout shifts that make pixel overlays unreadable. The pixel diff stays the
 * DETECTOR (which screens/regions changed); this explains the change in words.
 * PRs that add or remove functionality show up as added/removed lines here
 * even when the pixel bbox is just "everything below shifted".
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const BLOCK_TAGS =
  /<\/?(?:div|p|h[1-6]|li|ul|ol|tr|td|th|table|section|article|header|footer|nav|aside|form|label|button|dt|dd|dl|figcaption|blockquote|pre|br|hr)\b[^>]*>/gi;

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Visible, normalized text lines of an HTML document (order-preserving). */
export function extractTextLines(html) {
  let s = String(html);
  s = s.replace(/<script\b[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style\b[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(BLOCK_TAGS, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  return s
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 1);
}

/**
 * Multiset diff of visible lines: what appears in `head` but not `base`
 * (added) and vice versa (removed). Repeated lines are counted, so a block
 * that renders twice after the change still reports one addition.
 */
export function htmlDiff(baseHtml, headHtml) {
  const count = (lines) => {
    const m = new Map();
    for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1);
    return m;
  };
  const base = count(extractTextLines(baseHtml));
  const head = count(extractTextLines(headHtml));

  const added = [];
  for (const [line, n] of head) {
    const delta = n - (base.get(line) ?? 0);
    for (let i = 0; i < delta; i++) added.push(line);
  }
  const removed = [];
  for (const [line, n] of base) {
    const delta = n - (head.get(line) ?? 0);
    for (let i = 0; i < delta; i++) removed.push(line);
  }
  return pairOffNumericNoise(added, removed);
}

/**
 * Drop added/removed pairs that differ ONLY in digits (timestamps, counters,
 * generated ids): "loadedAt: 1783016593000" vs "loadedAt: 1783014227000" is
 * volatile noise, not a semantic change. A numeric line with no counterpart
 * (a genuinely new metric block, say) is kept.
 */
function pairOffNumericNoise(added, removed) {
  const norm = (l) => l.replace(/\d+/g, '#');
  const removedPool = new Map(); // norm → indices into removed
  removed.forEach((l, i) => {
    const k = norm(l);
    if (!removedPool.has(k)) removedPool.set(k, []);
    removedPool.get(k).push(i);
  });
  const dropRemoved = new Set();
  const keptAdded = [];
  for (const l of added) {
    const pool = removedPool.get(norm(l));
    if (pool && pool.length && norm(l) !== l) {
      dropRemoved.add(pool.shift()); // paired: numeric-only difference
    } else {
      keptAdded.push(l);
    }
  }
  return { added: keptAdded, removed: removed.filter((_, i) => !dropRemoved.has(i)) };
}

/**
 * Attach `htmlChanges = {added, removed}` to every explained CHANGED screen
 * whose base+head HTML snapshots are available. Missing/broken snapshots are
 * skipped with a warning (never silently — first-day lesson).
 */
export async function attachHtmlDiffs(explained, baseDir, headDir, { cap = 40 } = {}) {
  for (const r of explained) {
    if (r.status !== 'changed') continue;
    const baseHtmlRel = r.base?.html;
    const headHtmlRel = r.head?.html;
    if (!baseHtmlRel || !headHtmlRel) continue;
    try {
      const [b, h] = await Promise.all([
        readFile(join(baseDir, String(baseHtmlRel).replace(/^\.\//, '')), 'utf8'),
        readFile(join(headDir, String(headHtmlRel).replace(/^\.\//, '')), 'utf8'),
      ]);
      const { added, removed } = htmlDiff(b, h);
      r.htmlChanges = { added: added.slice(0, cap), removed: removed.slice(0, cap) };
    } catch (e) {
      console.warn(`[html-diff] snapshot diff skipped for ${r.key}: ${e.message}`);
    }
  }
  return explained;
}
