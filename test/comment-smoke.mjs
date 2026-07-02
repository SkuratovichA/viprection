// End-to-end W4: real diff report → explain → comment markdown.
import { join } from 'node:path';
import { compareGalleries } from '../src/image-diff.mjs';
import { explainReport } from '../src/explain.mjs';
import { renderComment } from '../src/comment.mjs';

const T = process.env.DIFF_TEST_DIR;
if (!T) throw new Error('set DIFF_TEST_DIR');

const report = await compareGalleries({
  baseDir: join(T, 'base'),
  headDir: join(T, 'head'),
  diffDir: join(T, 'diff'),
  diffOptions: { threshold: 0.1, changedRatioGate: 0.001 },
});

// Pretend the PR changed the login route file.
const changedFiles = ['packages/client/src/routes/login.tsx', 'packages/server/src/auth/token.ts'];
const explained = explainReport(report, changedFiles);

const md = renderComment({
  report,
  explained,
  urlFor: (p) => `https://example.test/${p}`,
  galleryUrl: 'https://example.test/previews/dev/',
  headSha: 'abcdef1234567',
});

console.log('--- rendered comment ---');
console.log(md);
console.log('--- checks ---');
const ok =
  md.includes('viprection:visual-diff') &&
  md.includes('1 changed') &&
  md.includes('01-public/login') &&
  md.includes('% of pixels differ') &&
  md.includes('Before') && md.includes('After') && md.includes('Diff') &&
  md.includes('Full gallery');
// login change should relate to the login.tsx file, not the server token file.
const loginExpl = explained.find((r) => r.key === '01-public/login').explanation;
const relatesToLogin = loginExpl.includes('login.tsx');
console.log('has all sections:', ok, '| relates to login.tsx:', relatesToLogin);
console.log(ok && relatesToLogin ? 'COMMENT SMOKE OK' : 'COMMENT SMOKE FAIL');
process.exit(ok && relatesToLogin ? 0 : 1);
