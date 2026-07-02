/**
 * W2 v1 — bring the project's stack up in CI, wait for health, and tear it down.
 *
 * Command-based contract (see docs/CONTRACT.md): the action shells out to the
 * project's own `up` / `seed` / `capture` / `down`. This module knows nothing
 * app-specific — docker-compose is just one way a project implements `up`.
 *
 *   node stack.mjs up     → run `up`, then poll every healthcheck until ready.
 *   node stack.mjs down   → run `down` (best-effort; never fails the job).
 *
 * `up` is run detached (a stack typically backgrounds itself, or is a
 * `docker compose up -d`); we do NOT wait on the process — we wait on the
 * healthchecks. If `up` exits non-zero synchronously, that's a hard failure.
 *
 * NOTE: capture is a separate step (capture.mjs) so the frozen-clock epoch and
 * the head/base distinction live there.
 *
 * Env: VP_CONFIG_PATH. Non-secret env from config.env is exported to children;
 * secrets are already in the workflow env and inherited as-is.
 */
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { normalizeHealthcheck } from './config-schema.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadConfig() {
  const path = process.env.VP_CONFIG_PATH || 'visual-preview.config.json';
  return JSON.parse(await readFile(path, 'utf8'));
}

/** Run a shell command, inheriting stdio, with the config env merged in. Rejects on non-zero. */
export function run(command, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      stdio: 'inherit',
      env: { ...process.env, ...extraEnv },
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`command failed (exit ${code}): ${command}`))
    );
  });
}

/** Poll one healthcheck until ready or timeout. */
async function waitForHealth(hcRaw) {
  const hc = normalizeHealthcheck(hcRaw);
  const deadline = Date.now() + (hc.timeoutSec ?? 120) * 1000;
  const opts = hc.postJson
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: hc.postJson }
    : { method: 'GET' };
  let lastErr = 'no attempt';
  // Date.now() is fine here — this is a CI script, not a resumable workflow.
  while (Date.now() < deadline) {
    try {
      const res = await fetch(hc.url, opts);
      if (res.ok) {
        if (!hc.expectContains) return;
        const body = await res.text();
        if (body.includes(hc.expectContains)) return;
        lastErr = `200 but missing "${hc.expectContains}"`;
      } else {
        lastErr = `HTTP ${res.status}`;
      }
    } catch (e) {
      lastErr = e.message.split('\n')[0];
    }
    await sleep(2000);
  }
  throw new Error(`healthcheck timed out: ${hc.url} (${lastErr})`);
}

export async function up() {
  const cfg = await loadConfig();
  const env = cfg.env ?? {};
  console.log(`[stack] up: ${cfg.up}`);
  await run(cfg.up, env);

  const checks = cfg.healthchecks ?? [];
  console.log(`[stack] waiting for ${checks.length} healthcheck(s)…`);
  // Poll all in parallel; fail fast if any times out.
  await Promise.all(
    checks.map(async (hc) => {
      const n = normalizeHealthcheck(hc);
      await waitForHealth(hc);
      console.log(`[stack] healthy: ${n.url}`);
    })
  );
  console.log('[stack] all healthchecks green.');
}

export async function down() {
  const cfg = await loadConfig().catch(() => null);
  if (!cfg?.down) {
    console.log('[stack] no down command; nothing to tear down.');
    return;
  }
  console.log(`[stack] down: ${cfg.down}`);
  // Never fail the job on teardown — log and move on.
  await run(cfg.down, cfg.env ?? {}).catch((e) => console.warn(`[stack] down failed: ${e.message}`));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const action = process.argv[2];
  const fn = action === 'up' ? up : action === 'down' ? down : null;
  if (!fn) {
    console.error('usage: stack.mjs up|down');
    process.exit(2);
  }
  fn().catch((e) => {
    console.error(`[stack] ${e.message}`);
    process.exit(1);
  });
}
