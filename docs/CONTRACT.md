# viprection — the plug-and-play contract (v1.1)

> v1.1 adds the **viewport matrix** (`viewports`, screen-key `@viewport`
> suffixes) and **`publicBaseUrl`** (non-Pages hosting). Both are strictly
> additive: a v1 config + manifest keeps working unchanged (implicit single
> `desktop` viewport, Pages/raw URL resolution).

This is the source of truth for what a project must provide to adopt the action.
Everything app-specific lives in **one file** at the repo root:
`visual-preview.config.json`. The action owns everything else (image-diff, PR
comment, Pages publish, orchestration).

## The two things a project adds

1. **`.github/workflows/visual-preview.yml`** — copy from
   [`templates/visual-preview.yml`](../templates/visual-preview.yml); set the
   tracked branches.
2. **`visual-preview.config.json`** — the command-based contract below.

## `visual-preview.config.json`

```jsonc
{
  "project": "Busano",                 // display name (optional)

  // Lifecycle commands. The action runs: up → (wait healthchecks) → seed →
  // capture → collect outputDir → down (always, even on failure).
  "install": "pnpm install --frozen-lockfile",  // optional; only used to prepare
                                                 // a FRESH base capture in a
                                                 // detached merge-base worktree.
  "up": "docker compose -f docker-compose.preview.yml up -d",
  // `up`/`down` are required non-empty strings. If your stack self-boots inside
  // `capture` (e.g. Testcontainers), use "up": "true" as a no-op (it must be
  // non-empty to pass config validation). The action still waits on
  // healthchecks, so point them at whatever `capture` brings up.
  "seed": "pnpm --filter @app/server seed",        // optional
  "capture": "pnpm --filter @app/client capture:screens",
  "down": "docker compose -f docker-compose.preview.yml down -v",
  // Optional but STRONGLY recommended: print the stack's boot output. Run by
  // the action when a healthcheck times out (head and base lifecycles alike).
  // A self-backgrounding `up` hides its stderr in a file — without this hook a
  // boot failure shows up only as "healthcheck timed out", with no cause.
  "logs": "tail -n 200 \"${RUNNER_TEMP:-/tmp}/visual-preview-stack.log\"",

  // Where `capture` writes manifest.json + PNGs (the action's input contract).
  "outputDir": "viprection/app-screens",

  // Polled until healthy before seed/capture. String = GET + accept 2xx.
  "healthchecks": [
    { "url": "http://localhost:4000/graphql",
      "postJson": "{\"query\":\"{ __typename }\"}",
      "expectContains": "Query", "timeoutSec": 180 },
    "http://localhost:3000"
  ],

  // A PR touching NONE of these is a fast no-op.
  "uiGlobs": ["packages/client/**", "packages/*/schema.graphql"],

  "env": { "ENABLE_DEV_TOOLS": "true" },  // NON-secret only; secrets via workflow

  // Deterministic clock: the action passes CAPTURE_FROZEN_EPOCH_MS to `capture`;
  // the harness must freeze in-page Date.now to it. base & head use the SAME
  // epoch (merge-base commit time) → relative dates are byte-identical.
  "clock": { "freeze": true, "source": "merge-base-commit-time" },

  "diff": {
    "threshold": 0.1,            // pixelmatch per-pixel threshold
    "changedRatioGate": 0.0007,  // min differing-pixel fraction to count as changed
    "ignoreScreens": [],         // never-diffed screens
    "maskSelectors": {},         // screen|"*" → CSS selectors blanked before capture
    "ignoreRegions": []          // rectangles excluded at diff time
  },

  // v1.1 — the capture viewport matrix. The HARNESS iterates this list (read
  // this config file directly; works both under the action and locally).
  // Absent = legacy single desktop 1440x900@2. "desktop" is the reserved
  // default name; its screen keys/files stay unsuffixed.
  "viewports": [
    { "name": "desktop", "width": 1440, "height": 900, "deviceScaleFactor": 2 },
    { "name": "mobile",  "width": 390,  "height": 844, "deviceScaleFactor": 2,
      "isMobile": true, "hasTouch": true }
  ],

  // v1.1 — where the previews branch is publicly served when NOT on GitHub
  // Pages (e.g. an S3/CloudFront mirror). Priority for link/image URLs:
  // publicBaseUrl > Pages detection > raw fallback (each fallback warns).
  // If this URL sits behind auth, PR comments degrade from inline images to
  // links (GitHub's camo proxy fetches anonymously).
  "publicBaseUrl": "https://preview.dev.busano.cz"
}
```

## Screen identity — the key invariant (v1.1)

A screen is `section/name` captured at a **viewport**. Canonical key:

```
section/name                ← the default viewport ("desktop")
section/name@<viewport>     ← every other viewport (e.g. …@mobile)
```

- `@desktop` is **never emitted** — legacy manifests pair with new desktop
  captures without migration; a screen captured only at one viewport shows up
  as added/removed by plain key set-difference.
- Viewport names are slugs (`^[a-z][a-z0-9-]*$`); `desktop` is reserved.
- Files mirror keys: `section/03-users@mobile.png`. Flat (sanitized) names use
  `__` for `/`: `section__03-users@mobile.diff.png`.
- **All** key/filename construction and parsing goes through `src/schema.mjs`
  (`screenKey`, `parseScreenKey`, `screenKeyToFilename`, `parseScreenFile`) —
  never hand-rolled (two ad-hoc sanitizers diverged on '@' once already).
- Per-entry ordering prefixes (`03-`) must be **per screen**, not per file, so
  a second viewport never reindexes existing shots (that would flap every diff).

## Output contract (what `capture` MUST produce)

In `outputDir`:

- **`manifest.json`** — the shared `GalleryManifest`:
  ```ts
  { project, generatedAt,
    viewports?: [{ name, width, height, deviceScaleFactor?,   // v1.1: echo of
                   isMobile?, hasTouch?, userAgent? }],        // config at capture
    sections: [
    { id, title, intro, backendNotes?, screens: [
      { name, route, caption, details?, role?, png, html?, status,
        failureReason?,
        viewport? } ] } ] }                                    // v1.1: default "desktop"
  ```
  One screen entry **per (screen × viewport)**; `viewport` names the matrix
  entry it was captured at (absent = `desktop`, so v1 manifests are valid).
  Renderers get the viewport list from the **head manifest** via
  `manifestViewports()` — pr-diff threads it into the report.
- the **PNG** files each screen references (`png` paths relative to `outputDir`).
- (optional) per-screen self-contained **`.html`** snapshots (Figma import).
  Emit them per **(screen × viewport)** when the gallery should offer the
  HTML preview on every device tab (the mobile DOM genuinely differs —
  drawers, bottom nav). Desktop-only is a valid slimming choice; renderers
  treat `html` as optional per entry either way.

The action additionally reads/writes a **`preview-meta.json`** next to
`manifest.json` (it does NOT modify the gallery renderer): `{ capturedAtSha,
toolVersion, browserVersion }`, used for base-capture reuse (see below).

## Determinism requirements (or every PR shows spurious diffs)

- Freeze animations/transitions during capture (already standard in both harnesses).
- Deterministic seed data.
- Honor `CAPTURE_FROZEN_EPOCH_MS` (clock-freeze) so relative dates are stable.
- Pin the browser via the project's own lockfile; the action pins the runner
  image (`ubuntu-24.04`, not `-latest`) and a fixed `deviceScaleFactor`.
- Mask residual volatile UI via `diff.maskSelectors` / `ignoreRegions`.

## HTML fast pre-filter (speed, no accuracy loss)

If `capture` also emits the self-contained per-screen `.html` snapshots (via each
screen's `html` field), the diff engine uses them as a **skip optimization**:
when a screen's *normalized* HTML is byte-identical between base and head, its
pixel-diff is skipped (marked unchanged, `prefiltered: true`). Pixel-diff remains
the source of visual truth for every screen the pre-filter can't clear.

Why this is safe (never a false "unchanged"):
- `html-equal` → skip; `html-differs`/`html-missing` → fall through to pixel-diff.
- Snapshots inline same-origin images as data-URIs and inline all CSS/`<style>`,
  so an asset swap or CSS-variable change *also* changes the HTML → still diffed.
- Only the injected `<base href>` (volatile dev port) and whitespace-between-tags
  are normalized away; class names and inline styles are kept (they're visual).
- Gap: cross-origin assets can change without changing the HTML — rare; disable
  with `diff.htmlPrefilter: false` if your app depends on them heavily.

## Base-capture reuse (PR mode)

To avoid capturing the whole catalog twice per PR, the published per-branch
gallery is reused as the diff **base** when it is still valid:

1. `preview-meta.capturedAtSha == merge-base` → **reuse**.
2. `capturedAtSha` is an ancestor **or a descendant** of the merge-base **and**
   the `git diff` over the connecting range touches no `uiGlobs` → **reuse**.
   Ancestor covers non-UI commits advancing the branch since the capture;
   descendant covers the base branch moving PAST the merge-base after the PR
   branched (the common case on a busy base branch) — either way the published
   gallery is pixel-identical to what a merge-base capture would produce.
3. `toolVersion` / `browserVersion` mismatch → **fresh** base capture.
4. otherwise → **fresh** base capture (a fallback, not an error).

A **fresh base capture** happens in a `git worktree` pinned at the merge-base:
`install` (if configured) → `up` → healthchecks → `seed` → `capture` → `down`
(always), with the SAME `CAPTURE_FROZEN_EPOCH_MS` the head capture gets. It can
be disabled with the `capture-base-fallback: 'false'` action input — the run
then establishes a new baseline instead of diffing.

⚠️ The worktree is a FRESH checkout: no `node_modules`, no generated clients.
If your `up`/`capture` need dependencies (they almost certainly do), configure
`install` — without it the base stack dies instantly and the healthcheck polls
a dead port until timeout. Playwright browsers in `~/.cache/ms-playwright` are
shared with the head checkout, so `install` normally does NOT need a browser
download — dependencies + codegen (e.g. `prisma generate`) suffice.

## Security model

- **Never** `pull_request_target` — the pipeline runs untrusted PR code
  (`up`/`seed`/`capture`), so a write token there would be RCE.
- same-repo PR → full experience (sticky comment + can push Pages).
- fork PR → `pull_request` (read-only): diff to the job summary + an artifact;
  no comment/Pages push. Optional maintainer label re-runs privileged after review.
