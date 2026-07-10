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
    <details class="area" id="${sec.id}">
      <summary class="area-head">
        <span class="caret" aria-hidden="true">▶</span>
        <h2>${escapeHtml(sec.title)}</h2>
        <div class="area-intro">${miniMarkdown(sec.intro)}</div>
      </summary>
      ${
        sec.backendNotes
          ? `<details class="backend"><summary>⚙️ Behind the scenes (backend)</summary>${miniMarkdown(sec.backendNotes)}</details>`
          : ''
      }
      ${sec.groups.map((g) => renderScreen(sec, g)).join('\n')}
    </details>`
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
  /* Collapsible section: <details> is SSR-safe + no-JS-degradable. The header
     row (h2 + intro) lives in <summary>; the screens are the body. */
  .area > summary.area-head { list-style:none; cursor:pointer; }
  .area > summary.area-head::-webkit-details-marker { display:none; }
  .area-head { display:block; position:relative; padding-left:26px; }
  .area-head .caret { position:absolute; left:0; top:2px; color:var(--mut); font-size:14px; transition:transform .15s ease; user-select:none; }
  .area[open] > .area-head .caret { transform:rotate(90deg); }
  .area-head h2 { font-size:22px; margin:0 0 6px; display:inline-block; }
  .area-intro { color:var(--mut); max-width:75ch; }
  .area-intro p { margin:6px 0; }
  .gallery-controls { display:flex; gap:8px; margin:0 8px 12px; }
  .gallery-controls button { flex:1; font-size:12px; border:1px solid var(--line); border-radius:6px; padding:5px 8px; background:var(--panel); color:var(--mut); cursor:pointer; }
  .gallery-controls button:hover { border-color:var(--acc); color:var(--acc); }
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
  /* Per-viewport device toggle: tabs above the shot, one <img> shown at a time.
     The toolbar keeps the device tabs (left) and the HTML button (right) on one
     flex row with a gap; row-gap keeps them apart if they wrap on a narrow view
     instead of the two touching lines they used to collapse into. */
  .shot-toolbar { display:flex; align-items:center; justify-content:space-between; gap:12px 16px; flex-wrap:wrap; margin:12px 0 0; }
  .device-tabs { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .devices { display:flex; gap:6px; margin:0; flex-wrap:wrap; }
  /* Per-viewport HTML-button slots: only the active viewport's button shows,
     kept in sync with the device tabs by the toggle script. */
  .html-buttons { display:flex; gap:8px; }
  .html-btn-slot { display:none; }
  .html-btn-slot.active { display:inline-flex; }
  .device-tab { font-size:12px; border:1px solid var(--line); border-radius:999px; padding:3px 12px; background:var(--panel); color:var(--mut); cursor:pointer; line-height:1.4; }
  .device-tab[aria-selected="true"] { border-color:var(--acc); color:var(--acc); background:#f5f2fe; font-weight:600; }
  .device-tab:hover { border-color:var(--acc); }
  .viewport-panel { display:none; }
  .viewport-panel.active { display:block; }
  /* Shots are FULL-PAGE (very tall). Clip the on-page display height and hint
     'there's more' with a bottom fade; click opens the untruncated image in the
     lightbox (which scrolls). Desktop caps at ~960px wide; a mobile shot is a
     retina PNG (~780px natural) shown at its LOGICAL phone width so it reads as
     a phone, not a giant column. */
  .shot { position:relative; display:block; margin-top:10px; border:1px solid var(--line); border-radius:10px; overflow:hidden; background:#fff; max-width:960px; max-height:70vh; }
  .shot img { width:100%; height:auto; display:block; }
  .shot::after { content:""; position:absolute; left:0; right:0; bottom:0; height:56px; pointer-events:none; background:linear-gradient(to bottom, rgba(255,255,255,0), var(--panel)); }
  .shot--mobile { max-width:390px; }
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
    <div class="gallery-controls">
      <button type="button" id="expand-all">Expand all</button>
      <button type="button" id="collapse-all">Collapse all</button>
    </div>
    ${sidebar}
  </nav>
  <main>${main}</main>
</div>
<div id="lightbox"><img alt="zoom" /></div>
<script>
  // ---- Collapsible sections (persisted in localStorage) ------------------
  // Each <details class="area" id="…"> remembers its open/closed state under a
  // key derived from the section id. Default (nothing stored): first section
  // expanded, the rest collapsed — best for a 40+ screen catalog where an
  // all-open page is an endless scroll.
  const LS_PREFIX = 'gallery.section.';
  const areas = [...document.querySelectorAll('details.area')];
  const lsKey = (id) => LS_PREFIX + id;
  function readStored(id) {
    try { return localStorage.getItem(lsKey(id)); } catch { return null; }
  }
  function writeStored(id, open) {
    try { localStorage.setItem(lsKey(id), open ? 'open' : 'closed'); } catch { /* private mode */ }
  }
  // Apply persisted (or default) state on load, then keep storage in sync when
  // the user toggles a section directly.
  areas.forEach((area, i) => {
    const stored = readStored(area.id);
    area.open = stored ? stored === 'open' : i === 0;
    area.addEventListener('toggle', () => {
      // Ignore toggles the filter drives (it sets .dataset.filterForced).
      if (area.dataset.filterForced) return;
      writeStored(area.id, area.open);
    });
  });

  const expandAllBtn = document.getElementById('expand-all');
  const collapseAllBtn = document.getElementById('collapse-all');
  function setAll(open) {
    areas.forEach((area) => {
      delete area.dataset.filterForced;
      area.open = open;
      writeStored(area.id, open);
    });
  }
  if (expandAllBtn) expandAllBtn.addEventListener('click', () => setAll(true));
  if (collapseAllBtn) collapseAllBtn.addEventListener('click', () => setAll(false));

  // ---- Live filter -------------------------------------------------------
  // While filtering, a section's open state is driven by whether it has a
  // match (so matches are never hidden inside a collapsed section). When the
  // filter clears we restore each section's persisted/default state.
  const filter = document.getElementById('filter');
  // Map section id → its main <details> for cross-linking sidebar ↔ main.
  const areaById = new Map(areas.map((a) => [a.id, a]));
  function restoreStoredOpen() {
    areas.forEach((area, i) => {
      delete area.dataset.filterForced;
      const stored = readStored(area.id);
      area.open = stored ? stored === 'open' : i === 0;
    });
  }
  filter.addEventListener('input', () => {
    const q = filter.value.trim().toLowerCase();
    document.querySelectorAll('.nav-item').forEach((el) => {
      el.classList.toggle('hidden', q !== '' && !el.dataset.filter.includes(q));
    });
    document.querySelectorAll('.nav-section').forEach((sec) => {
      const any = [...sec.querySelectorAll('.nav-item')].some((el) => !el.classList.contains('hidden'));
      sec.classList.toggle('hidden', !any);
      // Drive the matching main-column section open so matches are reachable.
      const area = areaById.get(sec.dataset.section);
      if (!area) return;
      if (q === '') return; // restored below in one shot
      area.dataset.filterForced = '1';
      area.open = any;
    });
    if (q === '') restoreStoredOpen();
  });
  // Device toggle: the .devices tab strip drives the sibling .viewport-panel[s]
  // AND the per-viewport .html-btn-slot in the same .screen, so switching device
  // swaps both the shot and its (viewport-specific) HTML-preview button.
  document.querySelectorAll('.devices').forEach((tabs) => {
    const article = tabs.closest('.screen');
    const panels = article ? article.querySelectorAll('.viewport-panel') : [];
    const btnSlots = article ? article.querySelectorAll('.html-btn-slot') : [];
    tabs.querySelectorAll('.device-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        const vp = tab.dataset.viewport;
        tabs.querySelectorAll('.device-tab').forEach((t) => {
          t.setAttribute('aria-selected', String(t === tab));
        });
        panels.forEach((p) => {
          p.classList.toggle('active', p.dataset.viewport === vp);
        });
        btnSlots.forEach((s) => {
          s.classList.toggle('active', s.dataset.viewport === vp);
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

  // The HTML preview button is per-variant (only variants with `v.html` get
  // one — desktop-only today, per-viewport soon). Each lives in its own
  // per-viewport wrapper so it shows/hides in lock-step with the active shot,
  // sitting on the RIGHT of the toolbar while the device tabs sit on the LEFT —
  // the two never collide (they used to wrap into two touching lines).
  const htmlButtons = g.variants
    .map((v, i) => {
      const vp = entryViewport(v);
      if (!v.html) return '';
      const active = i === 0 ? ' active' : '';
      return `<span class="html-btn-slot${active}" data-viewport="${escapeHtml(vp)}"><a class="btn" href="${v.html}" target="_blank" rel="noreferrer">Open HTML preview</a></span>`;
    })
    .join('');

  // Toolbar renders when there's anything to put in it (tabs and/or a button).
  const toolbar =
    tabs || htmlButtons
      ? `<div class="shot-toolbar">
          <div class="device-tabs">${tabs}</div>
          <div class="html-buttons">${htmlButtons}</div>
        </div>`
      : '';

  const panels = g.variants
    .map((v, i) => {
      const vp = entryViewport(v);
      const active = i === 0 ? ' active' : '';
      const shotClass = vp === 'mobile' ? 'shot shot--mobile' : 'shot';
      const shot =
        v.status === 'failed'
          ? `<div class="failed-note">Capture failed for this state${v.failureReason ? `: ${escapeHtml(v.failureReason)}` : ' — see the run log.'}</div>`
          : `<a class="${shotClass}" href="${v.png}" data-lightbox="${v.png}"><img loading="lazy" src="${v.png}" alt="${escapeHtml(`${g.name} — ${deviceLabel(vp)}`)}" /></a>`;
      return `<div class="viewport-panel${active}" data-viewport="${escapeHtml(vp)}" role="tabpanel">
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
        ${toolbar}
        ${panels}
      </article>`;
}
