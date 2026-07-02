/**
 * The plug-and-play project manifest for visual-preview-action.
 *
 * A project adopting the action provides ONE of these (as
 * `visual-preview.config.json` at the repo root). It abstracts
 * "bring the app up → seed → capture → tear down" as COMMANDS, so the action
 * never needs to know app internals. docker-compose is just one implementation
 * of `up`/`down` — the contract is command-based (agreed with salon-reach, whose
 * stack has no full app compose file; PG+Mongo service-containers + pnpm procs).
 *
 * The `capture` command MUST produce, in `outputDir`:
 *   - a `manifest.json` matching the shared GalleryManifest schema, and
 *   - the PNG files it references (paths relative to `outputDir`).
 * That manifest+PNGs pair is the action's entire input contract.
 *
 * @typedef {Object} VisualPreviewConfig
 * @property {string} [project]      Display name (defaults to repo name).
 * @property {string} [install]      Optional: install dependencies. Used when the
 *                                   action prepares a FRESH base capture in a
 *                                   detached worktree of the merge-base (which has
 *                                   no node_modules). Skipped when absent. e.g.
 *                                   "pnpm install --frozen-lockfile".
 * @property {string} up             Command that boots the full stack (may start
 *                                   service-containers, servers, client). Runs
 *                                   detached; the action does not wait on it —
 *                                   it waits on `healthchecks`.
 * @property {string} [seed]         Optional: seed data once healthy.
 * @property {string} capture        Command writing outputDir/manifest.json + PNGs.
 * @property {string} down           Teardown; ALWAYS run (even on failure).
 * @property {string} outputDir      Where capture writes (repo-relative).
 * @property {(string|HealthCheck)[]} healthchecks  URLs polled until healthy
 *                                   before seed/capture. A bare string = GET that
 *                                   URL and accept any 2xx.
 * @property {string[]} uiGlobs      Globs whose changes trigger a preview/diff.
 *                                   PR touching none of these → the action no-ops.
 * @property {Record<string,string>} [env]  Non-secret env for all steps. Secrets
 *                                   come from the workflow (never in this file).
 * @property {string} [nodeVersion]  Node for the runner (default "22").
 * @property {DiffOptions} [diff]    Volatile-region handling for stable diffs.
 * @property {ClockOptions} [clock]  Deterministic clock (freeze Date.now).
 */

/**
 * @typedef {Object} HealthCheck
 * @property {string} url
 * @property {number} [timeoutSec]      default 120
 * @property {string} [postJson]        POST body → readiness probe (e.g. a query)
 * @property {string} [expectContains]  substring the response must contain
 */

/**
 * Deterministic clock. When enabled, the action passes a fixed epoch to the
 * capture step (via env CAPTURE_FROZEN_EPOCH_MS) which the capture harness uses
 * to freeze the in-page `Date.now`. base & head use the SAME epoch (merge-base
 * commit time), so relative dates ("2 days ago") are byte-identical across the
 * pair — no masking needed. (salon-reach's insight.)
 *
 * @typedef {Object} ClockOptions
 * @property {boolean} freeze
 * @property {'merge-base-commit-time'|'fixed'} [source]  default merge-base time
 * @property {number} [fixedEpochMs]    used when source=fixed
 */

/**
 * @typedef {Object} DiffOptions
 * @property {number} [threshold]          pixelmatch per-pixel threshold (0.1)
 * @property {number} [changedRatioGate]   min differing-pixel fraction to count as
 *                                         "changed" (default 0.0007) — kills AA noise
 * @property {Record<string,string[]>} [maskSelectors]  screenName|"*" → CSS selectors
 *                                         blanked BEFORE capture (relative dates,
 *                                         generated IDs). A capture-time concern the
 *                                         harness applies; listed here for portability.
 * @property {IgnoreRegion[]} [ignoreRegions]  rectangles excluded at diff time
 * @property {string[]} [ignoreScreens]    screens excluded from diffing entirely
 */

/**
 * @typedef {Object} IgnoreRegion
 * @property {string} screen  screen name or "*"
 * @property {number} x @property {number} y @property {number} w @property {number} h
 */

export const CONFIG_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['up', 'capture', 'down', 'outputDir', 'healthchecks', 'uiGlobs'],
  additionalProperties: false,
  properties: {
    project: { type: 'string' },
    install: { type: 'string' },
    up: { type: 'string' },
    seed: { type: 'string' },
    capture: { type: 'string' },
    down: { type: 'string' },
    outputDir: { type: 'string' },
    nodeVersion: { type: 'string' },
    uiGlobs: { type: 'array', items: { type: 'string' }, minItems: 1 },
    env: { type: 'object', additionalProperties: { type: 'string' } },
    healthchecks: {
      type: 'array',
      minItems: 1,
      items: {
        oneOf: [
          { type: 'string' },
          {
            type: 'object',
            required: ['url'],
            additionalProperties: false,
            properties: {
              url: { type: 'string' },
              timeoutSec: { type: 'number' },
              postJson: { type: 'string' },
              expectContains: { type: 'string' },
            },
          },
        ],
      },
    },
    clock: {
      type: 'object',
      additionalProperties: false,
      properties: {
        freeze: { type: 'boolean' },
        source: { enum: ['merge-base-commit-time', 'fixed'] },
        fixedEpochMs: { type: 'number' },
      },
    },
    diff: {
      type: 'object',
      additionalProperties: false,
      properties: {
        threshold: { type: 'number' },
        changedRatioGate: { type: 'number' },
        htmlPrefilter: { type: 'boolean' },
        ignoreScreens: { type: 'array', items: { type: 'string' } },
        maskSelectors: {
          type: 'object',
          additionalProperties: { type: 'array', items: { type: 'string' } },
        },
        ignoreRegions: {
          type: 'array',
          items: {
            type: 'object',
            required: ['screen', 'x', 'y', 'w', 'h'],
            additionalProperties: false,
            properties: {
              screen: { type: 'string' },
              x: { type: 'number' },
              y: { type: 'number' },
              w: { type: 'number' },
              h: { type: 'number' },
            },
          },
        },
      },
    },
  },
};

/** Normalize a healthcheck (string → object). */
export function normalizeHealthcheck(hc) {
  return typeof hc === 'string' ? { url: hc, timeoutSec: 120 } : { timeoutSec: 120, ...hc };
}

/**
 * Dependency-free validation. Returns string[] of problems (empty = valid).
 */
export function validateConfig(cfg) {
  const errs = [];
  if (!cfg || typeof cfg !== 'object') return ['config must be an object'];
  for (const key of ['up', 'capture', 'down', 'outputDir']) {
    if (typeof cfg[key] !== 'string' || !cfg[key]) errs.push(`${key} is required (string)`);
  }
  if (!Array.isArray(cfg.uiGlobs) || cfg.uiGlobs.length === 0)
    errs.push('uiGlobs must be a non-empty array');
  if (!Array.isArray(cfg.healthchecks) || cfg.healthchecks.length === 0)
    errs.push('healthchecks must be a non-empty array');
  else
    for (const [i, hc] of cfg.healthchecks.entries()) {
      const u = typeof hc === 'string' ? hc : hc?.url;
      if (typeof u !== 'string' || !u) errs.push(`healthchecks[${i}] must have a url`);
    }
  if (cfg.clock?.source === 'fixed' && typeof cfg.clock.fixedEpochMs !== 'number')
    errs.push('clock.fixedEpochMs required when clock.source=fixed');
  return errs;
}
