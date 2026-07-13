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
 *   VP_MODE         branch | pr | gate
 *   GITHUB_OUTPUT   (provided by Actions) — where outputs are written
 *   GITHUB_BASE_REF (pr)  base branch
 *   GITHUB_EVENT_NAME
 *
 * `gate` is the standalone cheap-probe mode: a consumer runs the action with
 * mode: gate in a tiny job (checkout + this script, no pnpm/Playwright/stack)
 * and conditions its heavy job on the `should-run` output — so a docs-only PR
 * never pays for browser downloads or dependency installs. The decision is
 * derived from the event: pull_request → the same uiGlobs diff-gate as `pr`;
 * anything else (push) → always run, same as `branch`.
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

  // In standalone gate mode the pr-vs-branch semantics follow the event.
  const effectiveMode =
    mode === 'gate' ? (process.env.GITHUB_EVENT_NAME === 'pull_request' ? 'pr' : 'branch') : mode;

  // Branch mode ALWAYS runs: the per-branch gallery is the source-of-truth
  // baseline (and the PR diff base). Gating it on "this commit touched UI" would
  // let the baseline go stale — or, worse, never get created (a CI-only commit
  // like adopting the workflow wouldn't publish, so no baseline ever exists).
  // The uiGlob gate exists to skip pointless PR *diffs*, not branch publishes.
  if (effectiveMode !== 'pr') {
    console.log('visual-preview: branch mode → always publishing the gallery.');
    await setOutput('should-run', 'true');
    return;
  }

  // PR mode: skip when the PR touches no UI-affecting files.
  let changed = [];
  try {
    const base = process.env.GITHUB_BASE_REF;
    const range = base ? `origin/${base}...HEAD` : 'HEAD~1...HEAD';
    changed = execFileSync('git', ['diff', '--name-only', range], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch (e) {
    // No diff computable (shallow clone / first commit) → run to be safe.
    console.log(`visual-preview: could not compute diff (${e.message.split('\n')[0]}); running.`);
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
