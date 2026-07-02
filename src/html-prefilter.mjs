/**
 * HTML fast pre-filter for the image-diff.
 *
 * The capture already emits a self-contained `.html` snapshot per screen. If a
 * screen's NORMALIZED html is byte-identical between base and head, its rendered
 * pixels are almost certainly identical too — so we skip the (expensive)
 * pixelmatch for it. Pixel-diff remains the source of truth for everything the
 * pre-filter can't clear.
 *
 * IMPORTANT — this is a skip-optimization, never a "changed" signal:
 *   html-equal  → confidently skip pixel-diff (mark unchanged)
 *   html-differs→ fall through to pixel-diff (HTML churn ≠ visual change)
 *   html-missing→ fall through to pixel-diff (can't pre-filter)
 * This is why it can't produce false "unchanged": a real visual change with
 * unchanged HTML (CSS var / asset swap) would ALSO have equal html only if the
 * inlined asset bytes are equal — and our snapshots inline same-origin images as
 * data-URIs, so an asset swap changes the html too. Fonts/CSS-vars that live in
 * inlined <style> also change the html. Cross-origin assets are the only gap;
 * we accept that (rare) and note it.
 */

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

/**
 * Normalize an HTML snapshot so cosmetic-but-non-visual churn doesn't defeat the
 * skip. We DON'T strip class names or inline styles (those ARE visual). We only
 * remove things that never affect rendering:
 *   - the <base href="http://localhost:PORT/"> the capture injects (port varies)
 *   - leading/trailing whitespace runs collapsed
 * Deliberately conservative: when in doubt, DON'T normalize (fall through to
 * pixel-diff), never over-normalize (which could hide a real change).
 */
export function normalizeHtml(html) {
  return html
    // The injected <base> carries a volatile dev-server origin/port.
    .replace(/<base\s+href="[^"]*"\s*\/?>/gi, '<base>')
    // Collapse runs of whitespace between tags (rendering-neutral).
    .replace(/>\s+</g, '><')
    .trim();
}

export function hashHtml(html) {
  return createHash('sha1').update(normalizeHtml(html)).digest('hex');
}

/**
 * Decide whether the pixel-diff can be skipped for a screen.
 * @returns {Promise<'skip'|'diff'>} 'skip' only when both html files exist and
 * their normalized hashes match.
 */
export async function htmlPrefilter(baseHtmlPath, headHtmlPath) {
  if (!baseHtmlPath || !headHtmlPath) return 'diff';
  try {
    const [b, h] = await Promise.all([readFile(baseHtmlPath, 'utf8'), readFile(headHtmlPath, 'utf8')]);
    return hashHtml(b) === hashHtml(h) ? 'skip' : 'diff';
  } catch {
    // Missing/unreadable snapshot → can't pre-filter; pixel-diff to be safe.
    return 'diff';
  }
}
