# Adopting viprection in your project

A practical, battle-tested checklist. Everything here was learned by getting the
action green end-to-end on two real apps (a NestJS+Prisma+PG+Mongo+Redis monorepo
and a Testcontainers-based stack). The [CONTRACT](CONTRACT.md) is the reference;
this is the "do these things, avoid these traps" guide.

## The 2 files you add

1. **`.github/workflows/visual-preview.yml`** — copy
   [`templates/visual-preview.yml`](../templates/visual-preview.yml), set your
   tracked branches, and pin the action to a **full 40-char commit SHA** (see
   Gotcha #2).
2. **`visual-preview.config.json`** at the repo root — the command-based contract
   (`up` → healthchecks → `seed` → `capture` → `down`). See
   [CONTRACT.md](CONTRACT.md) for the schema; an example is in
   [`examples/`](../examples/).

That's it — but the `up`/`capture` commands have to actually work in a clean CI
runner, which is where the checklist below matters.

## Adoption checklist

- [ ] **All boot env, including secrets.** CI runs a *clean* checkout — your app
      likely reads env your `.env` provides locally. Pass everything the server
      needs to boot in the config's `up` (DB URL, plus any JWT/session/etc.
      secrets — **dummy values are fine**, the data is synthetic). Apps without
      boot-time env validation fail *silently mid-boot* on a missing secret, so
      the healthcheck just times out with no obvious cause (see Gotcha #4).
- [ ] **Point service deps at local containers.** If your `.env` points Mongo/
      Redis/etc. at remote hosts, CI will try to reach them. Override to
      `localhost` in `up`, and run the deps as containers (compose or GitHub
      service-containers).
- [ ] **Redis/Mongo may be load-bearing at boot even if "optional."** e.g. an
      eager pub/sub client connects in a module constructor. Run them.
- [ ] **Generate what isn't committed before building.** Prisma client, codegen
      output, a `shared` package — none are in git. The workflow's `build` gate
      must run the *same prep your real build does* (e.g. `prisma generate` +
      build shared) before `pnpm build`, or you get hundreds of "no exported
      member" tsc errors (Gotcha #3).
- [ ] **Install the capture browser explicitly.** `npm/pnpm install` does **not**
      reliably fetch Puppeteer's/Playwright's browser in CI, and the version must
      match what the launcher wants. Use `puppeteer browsers install` (no browser
      arg → the pinned build) or `playwright install chromium`. Put it in `up`
      **and** in `install` (the fresh-base worktree needs it too) — see Gotcha #6.
- [ ] **Capture on `localhost`, not `127.0.0.1`.** A `SameSite=Lax` session
      cookie set against a `localhost` API detaches under `127.0.0.1` (different
      cookie site) → auth silently fails mid-capture.
- [ ] **Freeze ALL time sources for determinism.** The action passes
      `CAPTURE_FROZEN_EPOCH_MS`; your harness must honor it in **both** places:
      the browser clock (so relative dates like "2 days ago" are stable) **and**
      any **server-side data generator** (seed `now`, generated timestamps). If
      only the browser is frozen, data-driven screens flap every PR. Acceptance
      test: run capture twice, each against a **fresh** DB, same epoch → the diff
      must be `changed: 0`. (A shared long-lived DB hides this bug — don't test
      that way.) See Gotcha #7.
- [ ] **Mask residual volatile UI.** Generated IDs, order numbers, anything the
      frozen clock can't fix → `diff.maskSelectors` / `diff.ignoreRegions`.
- [ ] **Deterministic seed.** Same seed → same rows. No `Math.random()` in the
      data the screenshots show.
- [ ] **Private repo? Choose image hosting.** `raw.githubusercontent` URLs do
      **not** render in comments on private repos (GitHub's camo proxy fetches
      anonymously → broken images). Either enable **GitHub Pages** on the previews
      branch (the Pages site is public — fine for synthetic data), or set
      `"imageHosting": "artifact"` to attach images as a run artifact and link to
      it (nothing served publicly). See Gotcha #8.
- [ ] **First run creates the baseline.** Merge the workflow to a tracked branch;
      the first push runs branch-mode and publishes `previews/<branch>`. Only then
      does a PR have a base to diff against. (Branch mode always publishes — it is
      not uiGlob-gated — so adopting the action, a CI-only commit, still creates
      the baseline.)

## The gotchas, in the order you'll hit them

1. **`uses: ${{ ... }}` is rejected.** GitHub doesn't allow expressions in a
   step's `uses:`. Pin the action ref as a literal string.
2. **Short SHA is rejected.** `uses: owner/repo@abc1234` fails at "Set up job"
   ("shortened version of a commit SHA is not supported"). Use the full 40-char
   SHA.
3. **`build` fails with hundreds of tsc errors.** Missing generated code (Prisma
   client / shared build). Mirror your real build prep in the `build` job.
4. **Healthcheck times out, no error.** The app crashed at boot on a missing env
   var (no boot validation → silent). Add a "dump app logs on failure" step
   (`tail` your server log) so the next run shows *why*, and pass the missing env.
5. **`gate` skips everything.** Your PR/commit touched no `uiGlobs` → correct
   no-op. For the *baseline*, branch mode runs regardless (fix in the action).
6. **"Could not find Chrome (ver. …)".** The browser isn't installed, or you
   installed the *latest* instead of the *pinned* version. Install the pinned
   build.
7. **The diff flags screens you didn't touch.** Non-determinism — almost always
   server-side seed time (frozen clock only froze the browser). Anchor the seed
   `now` to `CAPTURE_FROZEN_EPOCH_MS`.
8. **Comment shows broken images (private repo).** Use Pages or artifact hosting
   (checklist above).
9. **Every "silent fallback" costs you a debugging session.** Make each fallback
   `console.warn` its reason. Three of the first live bugs hid behind silent ones.

## A working reference

[`examples/`](../examples/) has a real `visual-preview.config.json`. In practice
the `up` string ends up long — that's expected; it encodes the exact clean-CI
boot of your stack (compose up + install + generate + migrate + build + start
each app with full env). Treat it as "the one place your CI boot lives."
