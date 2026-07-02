/**
 * Gate step: load + validate the project config, then decide whether the run
 * should proceed based on whether the changed files touch any uiGlob.
 *
 * Emits GitHub Actions outputs:
 *   should-run = true|false
 * Never fails the build for a "nothing to do" — it just short-circuits.
 *
 * Env:
 *   VP_CONFIG_PATH  path to visual-preview.config.json
 *   VP_MODE         branch | pr
 *   GITHUB_OUTPUT   (provided by Actions) — where outputs are written
 *   GITHUB_BASE_REF (pr)  base branch
 *   GITHUB_EVENT_NAME
 */
import { readFile, appendFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { validateConfig } from './config-schema.mjs';
import { globMatch } from './glob.mjs';

async function setOutput(key, value) {
  const out = process.env.GITHUB_OUTPUT;
  const line = `${key}=${value}\n`;
  if (out) await appendFile(out, line);
  else process.stdout.write(line); // local dry-run
}

async function main() {
  const cfgPath = process.env.VP_CONFIG_PATH || 'visual-preview.config.json';
  const mode = process.env.VP_MODE || 'pr';

  let cfg;
  try {
    cfg = JSON.parse(await readFile(cfgPath, 'utf8'));
  } catch (e) {
    console.error(`visual-preview: cannot read config at ${cfgPath}: ${e.message}`);
    process.exit(1);
  }
  const errs = validateConfig(cfg);
  if (errs.length) {
    console.error('visual-preview: invalid config:\n  - ' + errs.join('\n  - '));
    process.exit(1);
  }

  // Determine the changed file set.
  let changed = [];
  try {
    if (mode === 'pr') {
      const base = process.env.GITHUB_BASE_REF;
      // origin/<base>...HEAD — the PR's changes relative to the merge base.
      const range = base ? `origin/${base}...HEAD` : 'HEAD~1...HEAD';
      changed = execFileSync('git', ['diff', '--name-only', range], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean);
    } else {
      // branch push: compare against the previous commit; if unavailable, run.
      changed = execFileSync('git', ['diff', '--name-only', 'HEAD~1...HEAD'], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean);
    }
  } catch {
    // No diff computable (shallow clone / first commit) → run to be safe.
    console.log('visual-preview: could not compute diff; running.');
    await setOutput('should-run', 'true');
    return;
  }

  const touches = changed.some((f) => cfg.uiGlobs.some((g) => globMatch(g, f)));
  console.log(
    `visual-preview: ${changed.length} changed file(s), touches UI globs: ${touches}`
  );
  if (!touches) {
    console.log('visual-preview: no UI-affecting changes → skipping.');
  }
  await setOutput('should-run', String(touches));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
