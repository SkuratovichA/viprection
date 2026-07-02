/**
 * W2 — run the project's seed + capture, passing the deterministic clock epoch.
 *
 *   node capture.mjs head     → seed (if configured) + capture into cfg.outputDir
 *   node capture.mjs base     → same, for a fresh base capture (capture-base mode)
 *
 * Clock freeze: when cfg.clock.freeze, we compute one epoch (merge-base commit
 * time by default) and export it as CAPTURE_FROZEN_EPOCH_MS. base & head runs
 * use the SAME epoch, so relative dates ("2 days ago") are byte-identical across
 * the pair. The project's capture harness is responsible for honoring it
 * (freeze in-page Date.now).
 *
 * Env: VP_CONFIG_PATH, VP_MERGE_BASE_SHA (for clock source), GITHUB_SHA.
 */
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { run } from './stack.mjs';

async function loadConfig() {
  const path = process.env.VP_CONFIG_PATH || 'visual-preview.config.json';
  return JSON.parse(await readFile(path, 'utf8'));
}

/** Resolve the frozen epoch (ms) per config, or null when freeze is off. */
export function resolveFrozenEpoch(cfg) {
  const clock = cfg.clock;
  if (!clock?.freeze) return null;
  if (clock.source === 'fixed') return clock.fixedEpochMs ?? null;
  // default: merge-base-commit-time (same for base & head). prepare-base.mjs
  // is the single source of this epoch in PR mode (exported via $GITHUB_ENV);
  // compute it here only when that env is absent (standalone / branch mode).
  const fromEnv = Number(process.env.CAPTURE_FROZEN_EPOCH_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  // Fall back to HEAD when no merge-base is known.
  const sha = process.env.VP_MERGE_BASE_SHA || process.env.GITHUB_SHA;
  if (!sha) return null;
  try {
    // committer date, unix seconds → ms
    const secs = execFileSync('git', ['show', '-s', '--format=%ct', sha], { encoding: 'utf8' }).trim();
    const n = Number(secs);
    return Number.isFinite(n) ? n * 1000 : null;
  } catch {
    return null;
  }
}

export async function capture(kind = 'head') {
  const cfg = await loadConfig();
  const env = { ...(cfg.env ?? {}) };

  const epoch = resolveFrozenEpoch(cfg);
  if (epoch != null) {
    env.CAPTURE_FROZEN_EPOCH_MS = String(epoch);
    console.log(`[capture] clock frozen at ${epoch} (${kind})`);
  }

  if (cfg.seed) {
    console.log(`[capture] seed: ${cfg.seed}`);
    await run(cfg.seed, env);
  }
  console.log(`[capture] capture (${kind}): ${cfg.capture}`);
  await run(cfg.capture, env);
  console.log(`[capture] done → ${cfg.outputDir}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  capture(process.argv[2] || 'head').catch((e) => {
    console.error(`[capture] ${e.message}`);
    process.exit(1);
  });
}
