# viprection

**Visual preview + PR visual-diff for web apps, as a plug-and-play GitHub Action.**

Adopt it in a project with **two files**, and every PR automatically gets a
comment showing *only the screens that visually changed* — with before/after and
an explanation — while each tracked branch keeps an always-current screenshot
gallery published to GitHub Pages.

## What it does

- **Per-branch gallery.** On every push to a tracked branch (`dev`, `main`, …)
  whose changes touch the UI, it boots your app in CI, captures a screenshot
  catalog of every page/state, and publishes an always-current gallery to a
  `previews/<branch>` Pages branch.
- **PR visual diff.** On a PR (whose build passes) it captures the catalog on the
  PR head, image-diffs it against the branch's published gallery, and posts a
  **single sticky comment** with only the screens that actually changed —
  before/after/overlay + a short "what changed" note.
- **Plug-and-play.** All app-specifics live in one `visual-preview.config.json`.
  The action never needs to know your framework.

## Adopt in 2 files

1. Copy [`templates/visual-preview.yml`](templates/visual-preview.yml) to
   `.github/workflows/visual-preview.yml` and set your tracked branches.
2. Add a `visual-preview.config.json` at the repo root — see
   **[docs/CONTRACT.md](docs/CONTRACT.md)** for the full schema and an example.

That's it. Your `capture` command must write a `manifest.json` +
PNGs to `outputDir` (the shared `GalleryManifest` format) — most Playwright/
Puppeteer catalog scripts already do, or need a tiny adapter.

New to it? **[docs/ADOPTING.md](docs/ADOPTING.md)** is the step-by-step
checklist — every clean-CI gotcha (env/secrets, browser install, determinism,
private-repo image hosting) we hit getting this green on real apps.

## Why this design

- **Full stack in CI (command-based).** The action runs your `up → seed →
  capture → down` commands; docker-compose is just one way to implement `up`. No
  dependency on a deployed environment; works for PRs including forks.
- **Capture-all + image-diff.** Every screen is captured on both sides and
  pixel-diffed; only real changes surface. No brittle "which file maps to which
  screen" config to maintain.
- **Deterministic by construction.** Frozen animations, seeded data, and a frozen
  clock (relative dates become byte-stable) keep diffs signal-only.
- **Safe on forks.** Never uses `pull_request_target`; fork PRs get a read-only
  job-summary report instead of a privileged comment.

## Status

Contract v1 is frozen ([docs/CONTRACT.md](docs/CONTRACT.md)). All the moving
parts are implemented and unit-tested (27 tests): config schema + validation,
change-gating, image-diff (with the HTML pre-filter), base-gallery resolution
with the staleness guard, the "what changed" explanation, PR sticky-comment
rendering + GitHub upsert, stack orchestration (up/healthchecks/seed/capture/
down), the frozen clock, and per-branch Pages publishing. Next: a real end-to-end
run on a live repo + adoption docs.

## Layout

| Path | What |
|---|---|
| `action.yml` | Composite action entry point |
| `templates/visual-preview.yml` | The workflow projects drop in |
| `src/config-schema.mjs` | The `visual-preview.config.json` schema + validation |
| `src/image-diff.mjs` | Base↔head gallery diff engine |
| `src/gate.mjs`, `src/glob.mjs` | UI-glob change gating |
| `docs/CONTRACT.md` | The plug-and-play contract (source of truth) |
| `docs/ADOPTING.md` | Step-by-step adoption guide + clean-CI gotcha checklist |
| `examples/` | Real project configs |
