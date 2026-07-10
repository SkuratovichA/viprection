/**
 * Shared screen-identity + viewport schema helpers (the "key invariant").
 *
 * A screen is identified by `section/name` captured at a VIEWPORT. The
 * canonical string key is:
 *
 *   section/name              ← the DEFAULT viewport ("desktop")
 *   section/name@<viewport>   ← any other viewport
 *
 * `@desktop` is NEVER emitted: legacy manifests (no viewport concept) keep
 * producing `section/name`, so old bases pair with new desktop heads with no
 * migration. A screen present only at one viewport simply has no counterpart
 * key — added/removed semantics fall out of plain key set-difference.
 *
 * Every consumer (diff pairing, comment, gallery, coverage, file naming, disk
 * scans) MUST go through these helpers. No hand-rolled `${section}/${name}`,
 * no regex literals on '@' or '__' anywhere else.
 */

export const DEFAULT_VIEWPORT = 'desktop';

/** Viewport names are slugs; "desktop" is reserved for the default. */
export const VIEWPORT_NAME_RE = /^[a-z][a-z0-9-]*$/;

/** Legacy behavior of both harnesses before the viewport matrix existed. */
export const DEFAULT_VIEWPORTS = Object.freeze([
  Object.freeze({ name: 'desktop', width: 1440, height: 900, deviceScaleFactor: 2 }),
]);

/** The viewport a manifest entry was captured at (legacy entries → desktop). */
export function entryViewport(entry) {
  const vp = entry?.viewport;
  return typeof vp === 'string' && vp ? vp : DEFAULT_VIEWPORT;
}

/**
 * Canonical key for a screen entry: `section/name[@viewport]`.
 * `entry.section` is the section id (as flattened by indexManifest).
 */
export function screenKey(entry) {
  if (!entry || typeof entry.section !== 'string' || !entry.section) {
    throw new Error('screenKey: entry.section (section id) is required');
  }
  if (typeof entry.name !== 'string' || !entry.name) {
    throw new Error('screenKey: entry.name is required');
  }
  const vp = entryViewport(entry);
  const suffix = vp === DEFAULT_VIEWPORT ? '' : `@${vp}`;
  return `${entry.section}/${entry.name}${suffix}`;
}

/**
 * Parse a canonical key back into { section, name, viewport }.
 * The viewport suffix is recognized only when the token after the LAST '@'
 * is a valid viewport slug — otherwise the '@' is treated as part of the name.
 */
export function parseScreenKey(key) {
  const s = String(key);
  const slash = s.indexOf('/');
  const section = slash === -1 ? '' : s.slice(0, slash);
  let name = slash === -1 ? s : s.slice(slash + 1);
  let viewport = DEFAULT_VIEWPORT;
  const at = name.lastIndexOf('@');
  if (at > 0) {
    const candidate = name.slice(at + 1);
    if (VIEWPORT_NAME_RE.test(candidate) && candidate !== DEFAULT_VIEWPORT) {
      viewport = candidate;
      name = name.slice(0, at);
    } else if (candidate === DEFAULT_VIEWPORT) {
      // Tolerate a non-canonical `@desktop` on input, normalize it away.
      name = name.slice(0, at);
    }
  }
  return { section, name, viewport };
}

/**
 * Canonical key → safe flat filename stem (no extension).
 * '/' → '__'; '@' is KEPT (legal in URL paths per RFC 3986 pchar); any other
 * character outside [a-zA-Z0-9._@-] → '__'; runs collapse to one '__'.
 * This is THE sanitizer — image-diff diff names, pr-diff annotated names and
 * any future writer must all call it (two ad-hoc sanitizers already diverged
 * on '@' once; that class of bug ends here).
 */
export function screenKeyToFilename(key) {
  return String(key)
    .replace(/\//g, '__')
    .replace(/[^a-zA-Z0-9._@-]+/g, '__')
    .replace(/_{3,}/g, '__');
}

/**
 * Parse a gallery/diff FILE back into screen identity.
 * Accepts either a repo-style relative path (`section/03-users@mobile.png`)
 * or a sanitized flat name (`section__03-users@mobile.diff.png`).
 *
 * Returns { section, name, viewport, kind, ext } where kind is
 * 'diff' | 'annotated' | 'plain'. `section` is '' when not derivable.
 * NOTE: in flat names only the FIRST '__' is treated as the section split —
 * later '__' runs may come from sanitized characters and stay in `name`
 * (same ambiguity the previous scanners had; harmless for display).
 */
export function parseScreenFile(file) {
  let s = String(file).replace(/\\/g, '/');
  s = s.slice(s.lastIndexOf('/') + 1); // basename; path dirs may be base/diff/etc.

  let kind = 'plain';
  let ext = '';
  const extMatch = s.match(/\.(png|html|webp|jpg|jpeg)$/i);
  if (extMatch) {
    ext = extMatch[1].toLowerCase();
    s = s.slice(0, -(extMatch[0].length));
  }
  if (s.endsWith('.diff')) {
    kind = 'diff';
    s = s.slice(0, -'.diff'.length);
  } else if (s.endsWith('.annotated')) {
    kind = 'annotated';
    s = s.slice(0, -'.annotated'.length);
  }

  // Path form keeps the real section in the dirname — recover it when the
  // caller passed a relative path whose dir is not a pr-diff bucket dir.
  const full = String(file).replace(/\\/g, '/');
  const dir = full.includes('/') ? full.slice(0, full.lastIndexOf('/')) : '';
  const bucketDirs = new Set(['base', 'head', 'diff', 'annotated']);
  let section = dir && !bucketDirs.has(dir.split('/').pop()) ? dir.split('/').pop() : '';

  let name = s;
  if (!section) {
    const sep = s.indexOf('__');
    if (sep > 0) {
      section = s.slice(0, sep);
      name = s.slice(sep + 2);
    }
  }

  let viewport = DEFAULT_VIEWPORT;
  const at = name.lastIndexOf('@');
  if (at > 0) {
    const candidate = name.slice(at + 1);
    if (VIEWPORT_NAME_RE.test(candidate)) {
      if (candidate !== DEFAULT_VIEWPORT) viewport = candidate;
      name = name.slice(0, at);
    }
  }
  return { section, name, viewport, kind, ext };
}

/** Strip a harness ordering prefix ("03-users" → "users"). Display-only. */
export function stripOrderPrefix(name) {
  return String(name).replace(/^\d{2,}-/, '');
}

/**
 * Validate + normalize a viewports array (from config or a manifest echo).
 * Returns a new array; throws on structural problems (bad name, duplicate,
 * missing width/height) — these are authoring errors, not runtime conditions.
 */
export function normalizeViewports(list) {
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('viewports must be a non-empty array');
  }
  const seen = new Set();
  return list.map((vp, i) => {
    if (!vp || typeof vp !== 'object') throw new Error(`viewports[${i}] must be an object`);
    const { name, width, height } = vp;
    if (typeof name !== 'string' || !VIEWPORT_NAME_RE.test(name)) {
      throw new Error(`viewports[${i}].name must match ${VIEWPORT_NAME_RE}`);
    }
    if (seen.has(name)) throw new Error(`viewports: duplicate name "${name}"`);
    seen.add(name);
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      throw new Error(`viewports[${i}] ("${name}") needs numeric width and height`);
    }
    return {
      name,
      width,
      height,
      deviceScaleFactor: Number.isFinite(vp.deviceScaleFactor) ? vp.deviceScaleFactor : 2,
      ...(vp.isMobile !== undefined ? { isMobile: !!vp.isMobile } : {}),
      ...(vp.hasTouch !== undefined ? { hasTouch: !!vp.hasTouch } : {}),
      ...(typeof vp.userAgent === 'string' ? { userAgent: vp.userAgent } : {}),
    };
  });
}

/**
 * The viewports a manifest was captured with. Canonical source for renderers:
 * pr-diff reads this off the HEAD manifest and threads it into the report;
 * renderers read ONLY the report. Legacy manifests (no `viewports` field) get
 * the desktop default, with a warn (our no-silent-fallback rule).
 */
export function manifestViewports(manifest) {
  const raw = manifest?.viewports;
  if (raw === undefined) {
    console.warn(
      '[schema] manifest has no `viewports` — legacy capture, assuming desktop 1440x900@2'
    );
    return [...DEFAULT_VIEWPORTS];
  }
  return normalizeViewports(raw);
}
