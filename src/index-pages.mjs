/**
 * Landing pages for the previews branch: the cross-branch root index and a
 * per-PR gallery page.
 *
 * The previews branch mixes two kinds of top-level directories:
 *   <branch>/  — always-current branch galleries (publish.mjs), each shipping
 *                its own index.html
 *   pr-<n>/    — visual-diff images for one pull request (github.mjs uploader)
 *
 * The original root index listed every directory as a "tracked branch" and
 * linked ./pr-<n>/index.html, which never existed — 404s, and merged PRs
 * presented as branches. This module renders both pages properly: the root
 * groups branch galleries and pull requests by state (open / merged / closed,
 * resolved via the GitHub API at publish time), and every pr-<n>/ directory
 * gets a real gallery page built from the images it hosts.
 *
 * No timestamps anywhere in the output: both writers run on every publish, and
 * a changing "generated at" line would turn no-op publishes into commits.
 */
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gh } from './github.mjs';
import { parseScreenFile, parseScreenKey, stripOrderPrefix } from './schema.mjs';

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Escaped prose with `backticked` spans rendered as <code>. */
const prose = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');

const BADGE_CSS = {
  open: 'background:#dcfce7;color:#166534',
  draft: 'background:#fef9c3;color:#854d0e',
  merged: 'background:#ede9fe;color:#5b21b6',
  closed: 'background:#f3f4f6;color:#4b5563',
  changed: 'background:#fee2e2;color:#991b1b',
  added: 'background:#dcfce7;color:#166534',
  removed: 'background:#f3f4f6;color:#4b5563',
  desktop: 'background:#e0e7ff;color:#3730a3',
  mobile: 'background:#f5f2fe;color:#6d28d9',
};

const badge = (label) =>
  `<span class="badge" style="${BADGE_CSS[label] ?? BADGE_CSS.closed}">${esc(label)}</span>`;

const PAGE_CSS = `
  *{box-sizing:border-box}
  body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#fafafa;color:#18181b}
  main{max-width:840px;margin:0 auto;padding:44px 24px 64px}
  h1{font-size:21px;margin:0 0 4px}
  .sub{color:#71717a;margin:0 0 8px}
  h2{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#71717a;margin:36px 0 10px}
  .card{background:#fff;border:1px solid #e4e4e7;border-radius:12px;overflow:hidden}
  .row{display:flex;align-items:center;gap:12px;padding:12px 16px}
  .row+.row{border-top:1px solid #f0f0f2}
  .badge{font-size:11px;font-weight:600;padding:2px 9px;border-radius:999px;flex:none}
  a{color:inherit;text-decoration:none}
  a.title{font-weight:550;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  a.title:hover{text-decoration:underline}
  .num{color:#71717a;font-variant-numeric:tabular-nums;flex:none}
  a.ext{color:#a1a1aa;font-size:13px;flex:none}
  a.ext:hover{color:#52525b}
  code{background:#f4f4f5;padding:1px 6px;border-radius:5px;font-size:13px}
  footer{margin-top:48px;color:#a1a1aa;font-size:13px}
  footer a{text-decoration:underline}
`;

/** Split top-level directory names into branch galleries and PR numbers. */
export function classifyEntries(names) {
  const branches = [];
  const prs = [];
  for (const name of names) {
    const m = /^pr-(\d+)$/.exec(name);
    if (m) prs.push(Number(m[1]));
    else branches.push(name);
  }
  branches.sort();
  prs.sort((a, b) => b - a);
  return { branches, prs };
}

/**
 * Resolve state/title per PR number → Map<number, {state, title} | null>.
 * state ∈ open | draft | merged | closed. A failed lookup yields null (the
 * page then shows the PR without a state) — warned, never silent.
 */
export async function fetchPrStates(repo, numbers, { token, api = gh } = {}) {
  const states = new Map();
  for (const n of numbers) {
    if (!token) {
      states.set(n, null);
      continue;
    }
    try {
      const pr = await api(`/repos/${repo}/pulls/${n}`, { token });
      const state = pr.merged_at ? 'merged' : pr.state !== 'open' ? 'closed' : pr.draft ? 'draft' : 'open';
      states.set(n, { state, title: pr.title ?? '' });
    } catch (e) {
      console.warn(`[index-pages] PR #${n} state lookup failed (${e.message}); listing it without a state`);
      states.set(n, null);
    }
  }
  if (!token && numbers.length) {
    console.warn('[index-pages] no GitHub token — PR states unavailable, grouping all PRs together');
  }
  return states;
}

const prRow = (repo, n, info) => {
  const title = info?.title ? esc(info.title) : '';
  return `<div class="row">${info ? badge(info.state) : badge('PR')}<span class="num">#${n}</span><a class="title" href="./pr-${n}/index.html">${title || `visual diff for pull request #${n}`}</a><a class="ext" href="https://github.com/${esc(repo)}/pull/${n}">GitHub ↗</a></div>`;
};

const section = (heading, rows) =>
  rows.length ? `<h2>${esc(heading)}</h2>\n<div class="card">\n${rows.join('\n')}\n</div>` : '';

/** The cross-branch landing page (pure; no I/O). */
export function buildRootIndexHtml({ repo, branches, prs, states }) {
  const branchRows = branches.map(
    (b) =>
      `<div class="row"><a class="title" href="./${esc(b)}/index.html"><code>${esc(b)}</code></a><a class="ext" href="https://github.com/${esc(repo)}/tree/${esc(b)}">branch ↗</a></div>`,
  );
  const byState = { open: [], merged: [], closed: [], unknown: [] };
  for (const n of prs) {
    const info = states.get(n) ?? null;
    const bucket = info ? (info.state === 'draft' ? 'open' : info.state) : 'unknown';
    byState[bucket].push(prRow(repo, n, info));
  }
  const body = [
    `<h1>Visual previews — ${esc(repo)}</h1>`,
    `<p class="sub">Screenshot galleries per tracked branch, and before/after image sets per pull request.</p>`,
    section('Branch galleries', branchRows),
    section('Open pull requests', byState.open),
    section('Merged pull requests', byState.merged),
    section('Closed without merging', byState.closed),
    section('Pull requests', byState.unknown),
    `<footer>Generated by <a href="https://github.com/SkuratovichA/viprection">viprection</a>. Branch galleries track the latest push; PR pages keep the diff images referenced by each PR's visual-diff comment.</footer>`,
  ]
    .filter(Boolean)
    .join('\n');
  return `<!doctype html><meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>${esc(repo)} — visual previews</title>\n<style>${PAGE_CSS}</style>\n<main>\n${body}\n</main>`;
}

/** Uploader results → page entries (paths relative to the pr-<n>/ dir). */
export function entriesFromExplained(explained) {
  const strip = (p) => String(p).replace(/^\.\//, '');
  return explained.map((r) => {
    // Viewport is authoritative on the diff RESULT object, not by parsing r.key
    // (the writer already stamped '@mobile' onto the png/diff/annotated paths).
    const viewport = r.head?.viewport ?? r.base?.viewport ?? 'desktop';
    const { section, name } = parseScreenKey(r.key);
    return {
      key: r.key,
      baseKey: `${section}/${name}`,
      viewport,
      status: r.status,
      explanation: r.explanation,
      basePng: r.base?.png ? `base/${strip(r.base.png)}` : undefined,
      headPng: r.head?.png ? `head/${strip(r.head.png)}` : undefined,
      diffPng: r.diffPngName ? `diff/${r.diffPngName}` : undefined,
      annotatedPng: r.annotatedPngName ? `annotated/${r.annotatedPngName}` : undefined,
    };
  });
}

/**
 * Reconstruct page entries by scanning an existing pr-<n>/ directory —
 * for backfilling PR dirs uploaded before this module existed. The numeric
 * `NN-` gallery prefix in base/head file names is not part of the screen key.
 *
 * Files are parsed with parseScreenFile, so a screen captured at two viewports
 * ('dashboard/01-populated.png' + 'dashboard/01-populated@mobile.png') collapses
 * to ONE logical entry (base key 'dashboard/populated') with two viewport
 * variants — status is inferred PER viewport. Each returned entry is a flat
 * per-viewport record (baseKey + viewport + png paths + status), the same shape
 * entriesFromExplained yields, so buildPrIndexHtml groups both sources alike.
 */
export async function entriesFromScan(prDir) {
  const tryList = async (sub) => {
    try {
      return await readdir(join(prDir, sub), { recursive: true, withFileTypes: true });
    } catch {
      return [];
    }
  };
  // Keyed by baseKey + '\x00' + viewport → one variant per (logical screen, vp).
  const variants = new Map();
  const variant = (baseKey, name, viewport) => {
    const k = `${baseKey}\x00${viewport}`;
    if (!variants.has(k)) variants.set(k, { baseKey, name, viewport });
    return variants.get(k);
  };
  const record = (d, sub, field) => {
    if (!d.isFile()) return;
    const rel = d.parentPath ? `${d.parentPath.split('/').pop()}/${d.name}` : d.name;
    const { section, name, viewport } = parseScreenFile(rel);
    if (!name) return;
    const display = stripOrderPrefix(name);
    const baseKey = section ? `${section}/${display}` : display;
    variant(baseKey, display, viewport)[field] = `${sub}/${
      d.parentPath && d.parentPath.split('/').pop() !== sub
        ? `${d.parentPath.split('/').pop()}/`
        : ''
    }${d.name}`;
  };
  for (const d of await tryList('annotated')) {
    if (d.isFile() && d.name.endsWith('.png')) record(d, 'annotated', 'annotatedPng');
  }
  for (const d of await tryList('diff')) {
    if (d.isFile() && d.name.endsWith('.png')) record(d, 'diff', 'diffPng');
  }
  for (const sub of ['base', 'head']) {
    for (const d of await tryList(sub)) {
      if (d.isFile() && d.name.endsWith('.png')) record(d, sub, `${sub}Png`);
    }
  }
  for (const v of variants.values()) {
    v.status =
      v.diffPng || v.annotatedPng
        ? 'changed'
        : v.headPng && !v.basePng
          ? 'added'
          : v.basePng && !v.headPng
            ? 'removed'
            : 'changed';
  }
  return [...variants.values()].sort(
    (a, b) => a.baseKey.localeCompare(b.baseKey) || a.viewport.localeCompare(b.viewport),
  );
}

const figure = (label, png, emptyNote) =>
  `<figure><figcaption>${esc(label)}</figcaption>${
    png
      ? `<a href="./${esc(png)}"><img loading="lazy" src="./${esc(png)}" alt="${esc(label)}"></a>`
      : `<div class="empty">${esc(emptyNote)}</div>`
  }</figure>`;

const deviceLabel = (vp) => (vp === 'desktop' ? '🖥 Desktop' : vp === 'mobile' ? '📱 Mobile' : vp);

/**
 * Order a screen's viewport variants Desktop-first, then alphabetically by
 * viewport name (config order isn't available on a scanned/uploaded pr dir).
 */
const orderVariants = (vs) =>
  [...vs].sort((a, b) => {
    const rank = (vp) => (vp === 'desktop' ? '' : vp || 'desktop');
    return rank(a.viewport).localeCompare(rank(b.viewport));
  });

/**
 * Group flat per-viewport entries into logical screens keyed by baseKey.
 * Preserves first-seen order of base keys. Legacy entries with no baseKey
 * fall back to their `key` (desktop-only, no toggle).
 */
function groupByScreen(entries) {
  const groups = new Map(); // baseKey → { baseKey, variants: [] }
  for (const e of entries) {
    const baseKey = e.baseKey ?? e.key;
    let g = groups.get(baseKey);
    if (!g) {
      g = { baseKey, variants: [] };
      groups.set(baseKey, g);
    }
    g.variants.push({ ...e, viewport: e.viewport ?? 'desktop' });
  }
  return [...groups.values()].map((g) => ({ ...g, variants: orderVariants(g.variants) }));
}

/** One viewport variant → the Before/After pair + its raw-diff links. */
function renderVariant(e, active) {
  const links = [
    e.diffPng ? `<a href="./${esc(e.diffPng)}">raw pixel diff</a>` : '',
    e.annotatedPng && e.headPng ? `<a href="./${esc(e.headPng)}">after, without the box</a>` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return `<div class="viewport-panel${active ? ' active' : ''}" data-viewport="${esc(e.viewport)}">
${e.explanation ? `<p class="what">${prose(e.explanation)}</p>` : ''}
<div class="pair">
${figure('Before', e.basePng, 'New screen — no previous version')}
${figure('After (changes boxed)', e.annotatedPng ?? e.headPng, 'Screen removed')}
</div>
${links ? `<p class="links">${links}</p>` : ''}
</div>`;
}

/** The per-PR gallery page (pure; no I/O). */
export function buildPrIndexHtml({ repo, prNumber, info, entries }) {
  const groups = groupByScreen(entries);
  const screens = groups
    .map((g) => {
      const multi = g.variants.length > 1;
      const tabs = multi
        ? `<div class="devices" role="tablist">${g.variants
            .map(
              (v, i) =>
                `<button type="button" class="device-tab" data-viewport="${esc(v.viewport)}" aria-selected="${i === 0 ? 'true' : 'false'}">${esc(deviceLabel(v.viewport))}</button>`,
            )
            .join('')}</div>`
        : '';
      // The header badge summarizes the screen: its first variant's status, plus
      // a device badge per viewport present so the mix is visible at a glance.
      const deviceBadges = g.variants.map((v) => badge(v.viewport)).join(' ');
      const panels = g.variants.map((v, i) => renderVariant(v, i === 0)).join('\n');
      return `<section class="screen">
<h3>${badge(g.variants[0].status ?? 'changed')} <code>${esc(g.baseKey)}</code> ${deviceBadges}</h3>
${tabs}
${panels}
</section>`;
    })
    .join('\n');
  const extraCss = `
  section{margin:28px 0;padding:20px;background:#fff;border:1px solid #e4e4e7;border-radius:12px}
  h3{font-size:15px;margin:0 0 8px;display:flex;align-items:center;gap:8px}
  .what{color:#52525b;font-size:14px;margin:0 0 14px}
  .pair{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  @media (max-width:720px){.pair{grid-template-columns:1fr}}
  figure{margin:0;min-width:0}
  figcaption{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#71717a;margin-bottom:6px}
  img{max-width:100%;height:auto;border:1px solid #e4e4e7;border-radius:8px;display:block}
  .empty{border:1px dashed #d4d4d8;border-radius:8px;padding:32px 12px;color:#a1a1aa;text-align:center;font-size:13px}
  .links{font-size:13px;margin:12px 0 0}
  .links a{text-decoration:underline;color:#52525b}
  .crumbs{font-size:13px;color:#71717a;margin:0 0 20px}
  .crumbs a{text-decoration:underline}
  /* Per-screen device toggle: tabs switch which viewport-panel .pair is shown. */
  .devices{display:flex;gap:6px;margin:0 0 14px;flex-wrap:wrap}
  .device-tab{font-size:12px;border:1px solid #e4e4e7;border-radius:999px;padding:3px 12px;background:#fff;color:#71717a;cursor:pointer;line-height:1.4}
  .device-tab[aria-selected="true"]{border-color:#6d28d9;color:#6d28d9;background:#f5f2fe;font-weight:600}
  .device-tab:hover{border-color:#6d28d9}
  .viewport-panel{display:none}
  .viewport-panel.active{display:block}
`;
  // The toggle: each .devices tab strip switches its sibling .viewport-panel[s].
  const toggleJs = `
  document.querySelectorAll('.devices').forEach((tabs) => {
    const screen = tabs.closest('.screen');
    const panels = screen ? screen.querySelectorAll('.viewport-panel') : [];
    tabs.querySelectorAll('.device-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        const vp = tab.dataset.viewport;
        tabs.querySelectorAll('.device-tab').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
        panels.forEach((p) => p.classList.toggle('active', p.dataset.viewport === vp));
      });
    });
  });`;
  // Count LOGICAL screens (base keys), not per-viewport device rows.
  const screenCount = groups.length;
  return `<!doctype html><meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>PR #${prNumber} visual diff — ${esc(repo)}</title>\n<style>${PAGE_CSS}${extraCss}</style>\n<main>\n<p class="crumbs"><a href="../index.html">← all previews</a></p>\n<h1>${info ? badge(info.state) : ''} PR #${prNumber}${info?.title ? ` — ${esc(info.title)}` : ''}</h1>\n<p class="sub">${screenCount} screen${screenCount === 1 ? '' : 's'} · <a class="ext" href="https://github.com/${esc(repo)}/pull/${prNumber}" style="text-decoration:underline">view the pull request on GitHub ↗</a></p>\n${screens || '<p class="sub">No images in this PR folder.</p>'}\n<footer>Image set behind PR #${prNumber}'s visual-diff comment. Generated by <a href="https://github.com/SkuratovichA/viprection">viprection</a>.</footer>\n${screens ? `<script>${toggleJs}</script>` : ''}\n</main>`;
}

/** Write pr-<n>/index.html into an uploaded PR image directory. */
export async function writePrIndexHtml(prDirAbs, { repo, prNumber, info, entries }) {
  await writeFile(join(prDirAbs, 'index.html'), buildPrIndexHtml({ repo, prNumber, info, entries }));
}

/**
 * (Re)write the root index.html of a previews-branch worktree. Called by both
 * writers of the branch (the branch-gallery publisher and the PR-image
 * uploader) so the landing page refreshes whichever path commits first.
 * `statesByPr` overrides the API lookup (tests, offline backfills).
 */
export async function writeRootIndex(wt, repo, { token, statesByPr } = {}) {
  const dirents = await readdir(wt, { withFileTypes: true });
  const names = dirents.filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name);
  const { branches, prs } = classifyEntries(names);
  const states = statesByPr ?? (await fetchPrStates(repo, prs, { token }));
  await writeFile(join(wt, 'index.html'), buildRootIndexHtml({ repo, branches, prs, states }));
}
