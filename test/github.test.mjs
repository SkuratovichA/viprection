import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCommentPoster } from '../src/github.mjs';

// Swap global fetch with a recording stub for the duration of a test.
function withFetch(handler, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = handler;
  return (async () => { try { return await fn(); } finally { globalThis.fetch = orig; } })();
}

const MARKER = '<!-- viprection:visual-diff -->';
const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

test('postComment creates a new comment when none carries the marker', async () => {
  const calls = [];
  await withFetch(
    async (url, opts) => {
      calls.push({ url, method: opts?.method || 'GET' });
      if ((opts?.method || 'GET') === 'GET') return ok([{ id: 1, body: 'unrelated' }]);
      return ok({ id: 2 });
    },
    async () => {
      const post = makeCommentPoster({ repo: 'o/r', prNumber: '7', token: 't' });
      await post(`${MARKER}\nhi`, MARKER);
    }
  );
  const post = calls.find((c) => c.method === 'POST');
  assert.ok(post, 'should POST a new comment');
  assert.match(post.url, /\/repos\/o\/r\/issues\/7\/comments$/);
});

test('postComment patches the existing marker comment', async () => {
  const calls = [];
  await withFetch(
    async (url, opts) => {
      calls.push({ url, method: opts?.method || 'GET' });
      if ((opts?.method || 'GET') === 'GET') return ok([{ id: 42, body: `old\n${MARKER}` }]);
      return ok({ id: 42 });
    },
    async () => {
      const post = makeCommentPoster({ repo: 'o/r', prNumber: '7', token: 't' });
      await post(`${MARKER}\nupdated`, MARKER);
    }
  );
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.ok(patch, 'should PATCH the existing comment');
  assert.match(patch.url, /\/issues\/comments\/42$/);
});
