import test from 'node:test';
import assert from 'node:assert/strict';
import { globMatch } from '../src/glob.mjs';

test('** matches nested paths', () => {
  assert.ok(globMatch('packages/client/**', 'packages/client/src/routes/register.tsx'));
  assert.ok(globMatch('packages/client/**', 'packages/client/scripts/capture-screens.mjs'));
  assert.ok(!globMatch('packages/client/**', 'packages/server/src/main.ts'));
});

test('* is single-segment', () => {
  assert.ok(globMatch('packages/*/schema.graphql', 'packages/client/schema.graphql'));
  assert.ok(globMatch('packages/*/schema.graphql', 'packages/admin/schema.graphql'));
  assert.ok(!globMatch('packages/*/schema.graphql', 'packages/client/nested/schema.graphql'));
});

test('a/**/b matches with and without middle', () => {
  assert.ok(globMatch('packages/server/src/modules/**/dto/**', 'packages/server/src/modules/order/dto/order.type.ts'));
  assert.ok(globMatch('packages/server/src/modules/**/dto/**', 'packages/server/src/modules/a/b/dto/x.ts'));
  assert.ok(!globMatch('packages/server/src/modules/**/dto/**', 'packages/server/src/modules/order/order.service.ts'));
});

test('locales glob', () => {
  assert.ok(globMatch('packages/client/src/locales/**', 'packages/client/src/locales/en/translation.json'));
});

test('non-UI change does not match any client glob', () => {
  const uiGlobs = ['packages/client/**', 'packages/admin/**', 'packages/*/schema.graphql'];
  const f = 'packages/server/src/modules/auth/auth.service.ts';
  assert.ok(!uiGlobs.some((g) => globMatch(g, f)));
});
