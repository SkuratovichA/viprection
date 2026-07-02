/**
 * Version fingerprints for base-capture reuse: if the tool or the browser that
 * produced the published base differs from what would produce the head, the
 * pixel diff is untrustworthy → force a fresh base capture.
 *
 * Kept intentionally coarse and dependency-free.
 */
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

/**
 * A fingerprint of the CAPTURE tooling. We don't know the project's exact
 * capture stack, so we combine: the action's own version (this repo's package
 * version) + whatever the project pins for its capture (its lockfile hash slice
 * is overkill; instead we take the project package.json version if present).
 * The action version is the part that matters most (diff algo / normalization).
 */
export async function toolVersion(cfg) {
  let actionVersion = '0';
  try {
    const pkg = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8')
    );
    actionVersion = pkg.version ?? '0';
  } catch {
    /* ignore */
  }
  const projectTag = cfg?.project ? String(cfg.project) : 'project';
  return `viprection@${actionVersion}/${projectTag}`;
}

/** The Chromium/Chrome the runner will use, best-effort. */
export async function browserVersion() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    'google-chrome',
    'chromium',
    'chromium-browser',
  ].filter(Boolean);
  for (const bin of candidates) {
    try {
      const v = execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim();
      if (v) return v;
    } catch {
      /* try next candidate */
    }
  }
  // Not silently: 'unknown' feeds the base-reuse version guard — surface it so a
  // spurious capture-base (or a masked mismatch) is diagnosable.
  console.warn('[versions] no browser found for version fingerprint; using "unknown"');
  return 'unknown';
}
