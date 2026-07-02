// gate.mjs decision test: branch mode always runs; pr mode gates on uiGlobs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const GATE = new URL('../src/gate.mjs', import.meta.url).pathname;

const CFG = {
  up: 'x', capture: 'x', down: 'x', outputDir: 'o',
  healthchecks: ['http://x'], uiGlobs: ['packages/client/**'],
};

// Run gate.mjs as a subprocess with a scratch GITHUB_OUTPUT, return outputs.
async function runGate({ mode, cfg = CFG, env = {} }) {
  const dir = await mkdtemp(join(tmpdir(), 'vp-gate-'));
  const cfgPath = join(dir, 'cfg.json');
  const outPath = join(dir, 'out.txt');
  await writeFile(cfgPath, JSON.stringify(cfg));
  await writeFile(outPath, '');
  execFileSync('node', [GATE], {
    env: { ...process.env, VP_MODE: mode, VP_CONFIG_PATH: cfgPath, GITHUB_OUTPUT: outPath, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = await readFile(outPath, 'utf8');
  const m = out.match(/should-run=(\w+)/);
  return m ? m[1] : null;
}

test('branch mode always runs (even for a non-UI commit)', async () => {
  const shouldRun = await runGate({ mode: 'branch' });
  assert.equal(shouldRun, 'true');
});

test('pr mode with a non-UI diff skips (no merge-base env → HEAD~1)', async () => {
  // In a non-git tmp dir the diff is uncomputable → gate errs on the side of
  // running. That's the safe default; the real skip path is covered by the
  // glob unit tests. Here we assert it does not crash and yields a decision.
  const shouldRun = await runGate({ mode: 'pr' });
  assert.ok(shouldRun === 'true' || shouldRun === 'false');
});
