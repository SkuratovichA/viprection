import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, up } from '../src/stack.mjs';
import { resolveFrozenEpoch } from '../src/capture.mjs';

test('run resolves on success and rejects on non-zero', async () => {
  await run('exit 0'); // resolves
  await assert.rejects(() => run('exit 3'), /exit 3/);
});

test('up waits for a healthcheck that becomes ready', async () => {
  // A server that 404s a few times, then serves the readiness token.
  let hits = 0;
  const server = createServer((_req, res) => {
    hits++;
    if (hits < 2) { res.writeHead(503); res.end('warming'); return; }
    res.writeHead(200); res.end('{"data":{"__typename":"Query"}}');
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const dir = await mkdtemp(join(tmpdir(), 'vipr-stk-'));
  const cfgPath = join(dir, 'cfg.json');
  await writeFile(cfgPath, JSON.stringify({
    up: 'true', capture: 'x', down: 'true', outputDir: dir,
    uiGlobs: ['**'],
    healthchecks: [{ url: `http://localhost:${port}/graphql`, postJson: '{"query":"{__typename}"}', expectContains: 'Query', timeoutSec: 10 }],
  }));
  process.env.VP_CONFIG_PATH = cfgPath;

  await up(); // should not throw
  assert.ok(hits >= 2);
  server.close();
});

test('up fails when a healthcheck never becomes ready', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vipr-stk2-'));
  const cfgPath = join(dir, 'cfg.json');
  await writeFile(cfgPath, JSON.stringify({
    up: 'true', capture: 'x', down: 'true', outputDir: dir, uiGlobs: ['**'],
    healthchecks: [{ url: 'http://127.0.0.1:1/nope', timeoutSec: 1 }],
  }));
  process.env.VP_CONFIG_PATH = cfgPath;
  await assert.rejects(() => up(), /healthcheck timed out/);
});

test('resolveFrozenEpoch: off when freeze not set, fixed when configured', () => {
  assert.equal(resolveFrozenEpoch({ clock: { freeze: false } }), null);
  assert.equal(resolveFrozenEpoch({}), null);
  assert.equal(resolveFrozenEpoch({ clock: { freeze: true, source: 'fixed', fixedEpochMs: 1700000000000 } }), 1700000000000);
});
