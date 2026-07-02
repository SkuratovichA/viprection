# viprection — the plug-and-play contract (v1, frozen)

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
  "up": "docker compose -f docker-compose.preview.yml up -d",
  "seed": "pnpm --filter @app/server seed",        // optional
  "capture": "pnpm --filter @app/client capture:screens",
  "down": "docker compose -f docker-compose.preview.yml down -v",

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
  }
}
```

## Output contract (what `capture` MUST produce)

In `outputDir`:

- **`manifest.json`** — the shared `GalleryManifest`:
  ```ts
  { project, generatedAt, sections: [
    { id, title, intro, backendNotes?, screens: [
      { name, route, caption, details?, role?, png, html?, status,
        failureReason? } ] } ] }
  ```
- the **PNG** files each screen references (`png` paths relative to `outputDir`).
- (optional) per-screen self-contained **`.html`** snapshots (Figma import).

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
2. `capturedAtSha` is an ancestor of merge-base **and**
   `git diff capturedAtSha..merge-base` touches no `uiGlobs` → **reuse**
   (covers the common case where non-UI commits advanced the branch).
3. `toolVersion` / `browserVersion` mismatch → **fresh** base capture.
4. otherwise → **fresh** base capture (a fallback, not an error).

## Security model

- **Never** `pull_request_target` — the pipeline runs untrusted PR code
  (`up`/`seed`/`capture`), so a write token there would be RCE.
- same-repo PR → full experience (sticky comment + can push Pages).
- fork PR → `pull_request` (read-only): diff to the job summary + an artifact;
  no comment/Pages push. Optional maintainer label re-runs privileged after review.
