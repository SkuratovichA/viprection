/**
 * Shared visual-documentation gallery renderer — the ONE self-contained
 * index.html for a per-branch screen catalog.
 *
 * Vendored from busano's per-project copy
 * (trips-auctions/packages/client/scripts/gallery-template.mjs, itself a mirror
 * of claude-coop/shared/gallery-template.ts). THIS module supersedes every
 * per-project gallery-template copy: it is viewport-aware — a logical screen
 * captured at desktop + mobile renders as ONE <article> with a device toggle,
 * where the old template rendered one viewport-blind <article> per (section,
 * name) and had no concept of viewports at all. New consumers import from here;
 * the per-project templates should be deleted once their publishers switch over.
 *
 * Dependency-free and app-agnostic (inline CSS/JS, no external assets — same
 * ethos as index-pages.mjs). The only imports are the shared schema helpers so
 * viewport identity is derived exactly like every other consumer.
 *
 * Manifest shape (viewport-aware):
 *   { project, generatedAt, viewports?: [{ name, width, height, ... }],
 *     sections: [
 *       { id, title, intro, backendNotes?, screens: [
 *           { name, route, caption, details?, role?, viewport?, png, html?,
 *             status, failureReason? } ] } ] }
 *
 * A logical screen (stable `name` within a section) appears once per viewport in
 * `screens`, each entry carrying its own `viewport` + `png`/`html`. Legacy
 * manifests (no `viewports`, screens with no `viewport` field) render
 * desktop-only with no toggle — old bases keep working with no migration.
 */

import { entryViewport, manifestViewports } from './schema.mjs';

/**
 * Minimal markdown → HTML for the subset the annotations use: paragraphs,
 * `- ` bullet lists, **bold**, `inline code`, and [links](url).
 */
export function miniMarkdown(md) {
  const inline = (s) =>
    escapeHtml(s)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(
        /\[([^\]]+)\]\(([^)\s]+)\)/g,
        '<a href="$2" target="_blank" rel="noreferrer">$1</a>'
      );

  const blocks = md.trim().split(/\n{2,}/);
  return blocks
    .map((block) => {
      const lines = block.split('\n');
      if (lines.every((l) => l.trim().startsWith('- '))) {
        const items = lines.map((l) => `<li>${inline(l.trim().slice(2))}</li>`).join('');
        return `<ul>${items}</ul>`;
      }
      return `<p>${lines.map(inline).join('<br/>')}</p>`;
    })
    .join('\n');
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Device tab/badge label for a viewport name. */
function deviceLabel(vp) {
  if (vp === 'desktop') return 'Desktop';
  if (vp === 'mobile') return 'Mobile';
  return vp;
}

/**
 * Order a logical screen's viewport variants Desktop-first, then by the
 * manifest's declared viewport order; unknown viewports fall to the end.
 * `deviceOrder` is the list of viewport names from manifestViewports().
 */
function orderVariants(variants, deviceOrder) {
  const rank = (vp) => {
    if (vp === 'desktop') return -1;
    const i = deviceOrder.indexOf(vp);
    return i === -1 ? deviceOrder.length : i;
  };
  return [...variants].sort((a, b) => rank(entryViewport(a)) - rank(entryViewport(b)));
}

/**
 * Group a section's flat `screens` (one entry per (name, viewport)) into logical
 * screens keyed by stable `name`. Preserves first-seen order so authored screen
 * order is kept. Returns [{ name, variants: [screen, …] }].
 */
function groupScreens(screens) {
  const groups = new Map(); // name → { name, variants: [] }
  for (const sc of screens) {
    let g = groups.get(sc.name);
    if (!g) {
      g = { name: sc.name, variants: [] };
      groups.set(sc.name, g);
    }
    g.variants.push(sc);
  }
  return [...groups.values()];
}

export function renderGalleryHtml(manifest) {
  // The device order the toggle tabs follow (Desktop-first is applied per
  // screen); legacy manifests get [desktop] via manifestViewports' fallback.
  const deviceOrder = manifestViewports(manifest).map((v) => v.name);

  // Logical-screen groups per section (count what a human sees, not device rows).
  const sections = manifest.sections.map((sec) => ({
    ...sec,
    groups: groupScreens(sec.screens).map((g) => ({
      name: g.name,
      variants: orderVariants(g.variants, deviceOrder),
    })),
  }));

  const totalScreens = sections.reduce((n, s) => n + s.groups.length, 0);

  const sidebar = sections
    .map(
      (sec) => `
      <div class="nav-section" data-section="${sec.id}">
        <div class="nav-title">${escapeHtml(sec.title)} <span class="count">${sec.groups.length}</span></div>
        ${sec.groups
          .map((g) => {
            // Filter text pools every variant so a mobile-only caption still matches.
            const rep = g.variants[0];
            const filterText = `${sec.title} ${g.name} ${g.variants
              .map((v) => `${v.route} ${v.caption} ${v.details ?? ''}`)
              .join(' ')}`.toLowerCase();
            const failed = g.variants.every((v) => v.status === 'failed');
            return `
        <a class="nav-item" href="#${sec.id}--${g.name}" data-filter="${escapeHtml(filterText)}">
          ${failed ? '<span class="badge-failed">✕</span>' : ''}${escapeHtml(rep.name)}
        </a>`;
          })
          .join('')}
      </div>`
    )
    .join('\n');

  const main = sections
    .map(
      (sec) => `
    <section class="area" id="${sec.id}">
      <header class="area-head">
        <h2>${escapeHtml(sec.title)}</h2>
        <div class="area-intro">${miniMarkdown(sec.intro)}</div>
        ${
          sec.backendNotes
            ? `<details class="backend"><summary>⚙️ Behind the scenes (backend)</summary>${miniMarkdown(sec.backendNotes)}</details>`
            : ''
        }
      </header>
      ${sec.groups.map((g) => renderScreen(sec, g)).join('\n')}
    </section>`
    )
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(manifest.project)} — Visual Documentation</title>
<style>
  :root { color-scheme: light; --bg:#fafafa; --panel:#fff; --line:#e5e5ea; --ink:#1c1c21; --mut:#6b6b76; --acc:#7c3aed; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; background:var(--bg); color:var(--ink); }
  .layout { display:grid; grid-template-columns: 280px 1fr; min-height:100vh; }
  nav { border-right:1px solid var(--line); background:var(--panel); padding:16px 12px; position:sticky; top:0; height:100vh; overflow-y:auto; }
  nav h1 { font-size:15px; margin:4px 8px 2px; }
  nav .meta { color:var(--mut); font-size:12px; margin:0 8px 12px; }
  #filter { width:100%; padding:8px 10px; border:1px solid var(--line); border-radius:8px; font-size:13px; margin-bottom:12px; }
  .nav-title { font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--mut); margin:14px 8px 4px; display:flex; justify-content:space-between; }
  .nav-title .count { color:#b3b3bd; }
  .nav-item { display:block; padding:5px 10px; border-radius:6px; color:var(--ink); text-decoration:none; font-size:13px; }
  .nav-item:hover { background:#f1edfc; color:var(--acc); }
  .badge-failed { color:#dc2626; margin-right:6px; }
  main { padding:28px 36px; max-width:1200px; }
  .area { margin-bottom:48px; }
  .area-head h2 { font-size:22px; margin:0 0 6px; }
  .area-intro { color:var(--mut); max-width:75ch; }
  .area-intro p { margin:6px 0; }
  details.backend { margin:10px 0 0; border:1px solid var(--line); border-radius:10px; background:var(--panel); padding:10px 14px; max-width:85ch; }
  details.backend summary { cursor:pointer; font-weight:600; font-size:13px; }
  details.backend ul { margin:8px 0; padding-left:20px; }
  details.backend li, details.backend p { font-size:13px; line-height:1.55; }
  .screen { margin:26px 0 34px; }
  .screen-head { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .screen-head h3 { font-size:16px; margin:0; }
  .route { background:#eef0f4; border-radius:6px; padding:2px 8px; font-size:12px; color:#3b4252; }
  .role { background:#ede9fe; color:#6d28d9; border-radius:6px; padding:2px 8px; font-size:11px; text-transform:uppercase; letter-spacing:.04em; }
  .btn { font-size:12px; border:1px solid var(--line); border-radius:6px; padding:3px 10px; text-decoration:none; color:var(--acc); background:var(--panel); }
  .btn:hover { border-color:var(--acc); }
  .caption { color:var(--mut); margin:6px 0 4px; max-width:80ch; }
  .details { font-size:14px; line-height:1.6; max-width:80ch; }
  .details ul { padding-left:20px; }
  /* Per-viewport device toggle: tabs above the shot, one <img> shown at a time. */
  .devices { display:flex; gap:6px; margin:10px 0 0; flex-wrap:wrap; }
  .device-tab { font-size:12px; border:1px solid var(--line); border-radius:999px; padding:3px 12px; background:var(--panel); color:var(--mut); cursor:pointer; line-height:1.4; }
  .device-tab[aria-selected="true"] { border-color:var(--acc); color:var(--acc); background:#f5f2fe; font-weight:600; }
  .device-tab:hover { border-color:var(--acc); }
  .viewport-panel { display:none; }
  .viewport-panel.active { display:block; }
  .shot { display:block; margin-top:10px; border:1px solid var(--line); border-radius:10px; overflow:hidden; background:#fff; max-width:960px; }
  .shot img { width:100%; height:auto; display:block; }
  .failed-note { color:#dc2626; font-size:13px; border:1px dashed #fca5a5; border-radius:8px; padding:8px 12px; max-width:60ch; margin-top:10px; }
  #lightbox { position:fixed; inset:0; background:rgba(10,10,14,.92); display:none; align-items:flex-start; justify-content:center; overflow:auto; padding:32px; z-index:50; }
  #lightbox.open { display:flex; }
  #lightbox img { max-width:min(1600px, 96vw); height:auto; border-radius:8px; }
  .hidden { display:none !important; }
</style>
</head>
<body>
<div class="layout">
  <nav>
    <h1>${escapeHtml(manifest.project)}</h1>
    <div class="meta">${totalScreens} screens · generated ${escapeHtml(manifest.generatedAt)}</div>
    <input id="filter" type="search" placeholder="Filter screens…" />
    ${sidebar}
  </nav>
  <main>${main}</main>
</div>
<div id="lightbox"><img alt="zoom" /></div>
<script>
  const filter = document.getElementById('filter');
  filter.addEventListener('input', () => {
    const q = filter.value.trim().toLowerCase();
    document.querySelectorAll('.nav-item').forEach((el) => {
      el.classList.toggle('hidden', q !== '' && !el.dataset.filter.includes(q));
    });
    document.querySelectorAll('.nav-section').forEach((sec) => {
      const any = [...sec.querySelectorAll('.nav-item')].some((el) => !el.classList.contains('hidden'));
      sec.classList.toggle('hidden', !any);
    });
  });
  // Device toggle: tabs share a .devices group with sibling .viewport-panel[s].
  document.querySelectorAll('.devices').forEach((tabs) => {
    const article = tabs.closest('.screen');
    const panels = article ? article.querySelectorAll('.viewport-panel') : [];
    tabs.querySelectorAll('.device-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        const vp = tab.dataset.viewport;
        tabs.querySelectorAll('.device-tab').forEach((t) => {
          t.setAttribute('aria-selected', String(t === tab));
        });
        panels.forEach((p) => {
          p.classList.toggle('active', p.dataset.viewport === vp);
        });
      });
    });
  });
  const lb = document.getElementById('lightbox');
  const lbImg = lb.querySelector('img');
  document.querySelectorAll('a.shot').forEach((a) => {
    a.addEventListener('click', (e) => { e.preventDefault(); lbImg.src = a.dataset.lightbox; lb.classList.add('open'); });
  });
  lb.addEventListener('click', () => lb.classList.remove('open'));
  addEventListener('keydown', (e) => { if (e.key === 'Escape') lb.classList.remove('open'); });
</script>
</body>
</html>
`;
}

/**
 * One logical screen = one <article> with a device toggle. `g.variants` is
 * pre-ordered Desktop-first. When there is a single viewport we omit the tab
 * strip entirely (legacy/desktop-only screens look exactly like before).
 */
function renderScreen(sec, g) {
  const rep = g.variants[0];
  const multi = g.variants.length > 1;

  const tabs = multi
    ? `<div class="devices" role="tablist">${g.variants
        .map((v, i) => {
          const vp = entryViewport(v);
          return `<button type="button" class="device-tab" role="tab" data-viewport="${escapeHtml(vp)}" aria-selected="${i === 0 ? 'true' : 'false'}">${escapeHtml(deviceLabel(vp))}</button>`;
        })
        .join('')}</div>`
    : '';

  const panels = g.variants
    .map((v, i) => {
      const vp = entryViewport(v);
      const active = i === 0 ? ' active' : '';
      const shot =
        v.status === 'failed'
          ? `<div class="failed-note">Capture failed for this state${v.failureReason ? `: ${escapeHtml(v.failureReason)}` : ' — see the run log.'}</div>`
          : `<a class="shot" href="${v.png}" data-lightbox="${v.png}"><img loading="lazy" src="${v.png}" alt="${escapeHtml(`${g.name} — ${deviceLabel(vp)}`)}" /></a>`;
      // 'Open HTML preview' is desktop-only (mobile entries have no html).
      const htmlBtn = v.html
        ? `<a class="btn" href="${v.html}" target="_blank" rel="noreferrer">Open HTML preview</a>`
        : '';
      return `<div class="viewport-panel${active}" data-viewport="${escapeHtml(vp)}" role="tabpanel">
          ${htmlBtn ? `<div class="panel-head">${htmlBtn}</div>` : ''}
          ${shot}
        </div>`;
    })
    .join('\n');

  return `
      <article class="screen" id="${sec.id}--${g.name}">
        <div class="screen-head">
          <h3>${escapeHtml(g.name)}</h3>
          <code class="route">${escapeHtml(rep.route)}</code>
          ${rep.role ? `<span class="role">${escapeHtml(rep.role)}</span>` : ''}
        </div>
        <p class="caption">${escapeHtml(rep.caption)}</p>
        ${rep.details ? `<div class="details">${miniMarkdown(rep.details)}</div>` : ''}
        ${tabs}
        ${panels}
      </article>`;
}
