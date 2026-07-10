// The vendored gallery renderer: viewport-aware grouping + device toggle.
// Pure (no I/O): builds manifests and asserts the emitted index.html structure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderGalleryHtml, miniMarkdown, escapeHtml } from '../src/gallery.mjs';

// A viewport-aware manifest: one section, one logical screen (`home`) captured
// at desktop AND mobile — each variant carries its own viewport + png.
function multiViewportManifest() {
  return {
    project: 'Acme',
    generatedAt: '2026-07-10',
    viewports: [
      { name: 'desktop', width: 1440, height: 900 },
      { name: 'mobile', width: 390, height: 844 },
    ],
    sections: [
      {
        id: 'auth',
        title: 'Auth',
        intro: 'Sign-in flows.',
        screens: [
          {
            name: 'home',
            route: '/home',
            caption: 'The landing page',
            viewport: 'desktop',
            png: 'auth/home.png',
            html: 'auth/home.html',
            status: 'ok',
          },
          {
            name: 'home',
            route: '/home',
            caption: 'The landing page',
            viewport: 'mobile',
            png: 'auth/home@mobile.png',
            status: 'ok',
          },
        ],
      },
    ],
  };
}

// A LEGACY manifest: no `viewports`, screens with no `viewport` field.
function legacyManifest() {
  return {
    project: 'Legacy',
    generatedAt: '2026-01-01',
    sections: [
      {
        id: 'main',
        title: 'Main',
        intro: 'Old capture.',
        screens: [
          { name: 'dash', route: '/dash', caption: 'Dashboard', png: 'main/dash.png', html: 'main/dash.html', status: 'ok' },
        ],
      },
    ],
  };
}

test('a screen at desktop+mobile renders ONE <article> with a device toggle', () => {
  const html = renderGalleryHtml(multiViewportManifest());

  // Exactly one logical screen → one <article>, not one per viewport.
  const articleCount = (html.match(/<article class="screen"/g) || []).length;
  assert.equal(articleCount, 1, 'desktop+mobile of one screen collapse into ONE <article>');
  assert.match(html, /id="auth--home"/, 'article keyed by logical screen name');

  // A device toggle with BOTH a Desktop and a Mobile control.
  assert.match(html, /class="device-tab"[^>]*data-viewport="desktop"[^>]*>Desktop</);
  assert.match(html, /class="device-tab"[^>]*data-viewport="mobile"[^>]*>Mobile</);

  // Both PNG srcs are present.
  assert.ok(html.includes('src="auth/home.png"'), 'desktop png present');
  assert.ok(html.includes('src="auth/home@mobile.png"'), 'mobile png present (@ survives)');

  // Desktop tab is selected first.
  assert.match(html, /data-viewport="desktop" aria-selected="true"/, 'desktop tab selected first');
});

test('device tabs order Desktop first even when mobile is authored first', () => {
  const m = multiViewportManifest();
  // Swap so mobile is the first-seen variant.
  m.sections[0].screens.reverse();
  const html = renderGalleryHtml(m);
  const desktopTab = html.indexOf('data-viewport="desktop"');
  const mobileTab = html.indexOf('data-viewport="mobile"');
  assert.ok(desktopTab !== -1 && mobileTab !== -1);
  assert.ok(desktopTab < mobileTab, 'Desktop tab precedes Mobile regardless of authored order');
});

test('sidebar count reflects LOGICAL screens, not device variants', () => {
  const html = renderGalleryHtml(multiViewportManifest());
  // The section has 2 device variants of ONE screen → count must read 1.
  assert.match(html, /Auth <span class="count">1<\/span>/, 'section count is logical-screen count');
  assert.match(html, /1 screens · generated/, 'header total counts logical screens');
});

test('desktop-only HTML preview link renders; mobile panel has none', () => {
  const html = renderGalleryHtml(multiViewportManifest());
  const links = (html.match(/Open HTML preview/g) || []).length;
  assert.equal(links, 1, 'only the desktop variant (which has html) gets a preview link');
  assert.ok(html.includes('href="auth/home.html"'), 'the html link points at the desktop preview');
});

test('legacy manifest (no viewports, no viewport field) renders desktop-only with NO toggle', () => {
  const html = renderGalleryHtml(legacyManifest());

  const articleCount = (html.match(/<article class="screen"/g) || []).length;
  assert.equal(articleCount, 1, 'one screen → one article');
  assert.ok(!html.includes('class="devices"'), 'no device toggle strip for a single-viewport screen');
  assert.ok(!html.includes('class="device-tab"'), 'no device tabs');
  assert.ok(html.includes('src="main/dash.png"'), 'the desktop png renders');
  assert.match(html, /Main <span class="count">1<\/span>/, 'count is 1');
  // The single panel is active so the shot is visible by default.
  assert.match(html, /class="viewport-panel active"/, 'the sole panel is active');
});

test('a failed capture at one viewport shows a failure note, not an <img>', () => {
  const m = multiViewportManifest();
  m.sections[0].screens[1].status = 'failed';
  m.sections[0].screens[1].failureReason = 'timeout';
  const html = renderGalleryHtml(m);
  assert.ok(html.includes('Capture failed for this state: timeout'), 'failure reason shown');
  // Desktop still renders its shot; both tabs still present.
  assert.ok(html.includes('src="auth/home.png"'), 'the healthy desktop shot still renders');
  assert.match(html, /data-viewport="mobile"/, 'the failed viewport still gets a tab');
});

test('FIX 1: a mobile shot carries a phone-width class and .shot is height-capped with a fade', () => {
  const html = renderGalleryHtml(multiViewportManifest());
  // The mobile variant's shot is marked so CSS can size it to a phone width.
  assert.match(
    html,
    /<a class="shot shot--mobile"[^>]*data-lightbox="auth\/home@mobile\.png"/,
    'the mobile shot gets the shot--mobile class'
  );
  // The desktop shot is NOT phone-constrained.
  assert.match(html, /<a class="shot"[^>]*data-lightbox="auth\/home\.png"/, 'desktop shot stays the wide .shot');
  // The phone-width constraint is present in CSS.
  assert.match(html, /\.shot--mobile\s*\{[^}]*max-width:\s*390px/, 'shot--mobile caps at phone width');
  // The on-page shot height is capped (lightbox still shows the full image).
  assert.match(html, /\.shot\s*\{[^}]*max-height:\s*70vh/, '.shot caps its displayed height');
  assert.match(html, /\.shot::after\s*\{[^}]*linear-gradient/, 'a bottom fade hints there is more');
  // The lightbox keeps its own scroll so the FULL untruncated image is viewable.
  assert.match(html, /#lightbox\s*\{[^}]*overflow:\s*auto/, 'lightbox scrolls the full image');
});

test('FIX 2: device tabs are grouped separately from the HTML preview button', () => {
  const html = renderGalleryHtml(multiViewportManifest());
  // A .shot-toolbar wraps the two so they share one flex row without colliding.
  assert.ok(html.includes('class="shot-toolbar"'), 'a shot-toolbar row exists');
  // The device tabs live in their own .device-tabs group…
  assert.match(html, /<div class="device-tabs"><div class="devices"/, 'tabs are inside a .device-tabs group');
  // …distinct from the .html-buttons group that carries the .btn.
  assert.match(
    html,
    /<div class="html-buttons">.*class="btn"[^>]*>Open HTML preview/s,
    'the HTML button is in its own .html-buttons group'
  );
  // The .btn is not nested inside the .device-tabs group (they are separated).
  assert.doesNotMatch(html, /<div class="device-tabs">[^]*?class="btn"[^]*?<\/div><div class="html-buttons">/,
    'the button is not inside the device-tabs group');
});

test('FIX 3: sections are collapsible <details> with a persisted + collapse/expand-all control', () => {
  const html = renderGalleryHtml(multiViewportManifest());
  // Each section is a collapsible <details class="area"> with a <summary> head.
  assert.match(html, /<details class="area" id="auth">/, 'section is a collapsible <details>');
  assert.match(html, /<summary class="area-head">/, 'the section header is a <summary>');
  // A Collapse all / Expand all control exists near the filter.
  assert.match(html, /id="expand-all"[^>]*>Expand all</, 'Expand all control present');
  assert.match(html, /id="collapse-all"[^>]*>Collapse all</, 'Collapse all control present');
  // The inline script persists per-section state in localStorage.
  assert.ok(html.includes('localStorage'), 'section state is persisted via localStorage');
  assert.ok(html.includes('gallery.section.'), 'localStorage keys are namespaced per section');
});

test('escapeHtml and miniMarkdown are re-exported and behave', () => {
  assert.equal(escapeHtml('<a & "b">'), '&lt;a &amp; &quot;b&quot;&gt;');
  const md = miniMarkdown('**bold** and `code`\n\n- one\n- two');
  assert.ok(md.includes('<strong>bold</strong>'));
  assert.ok(md.includes('<code>code</code>'));
  assert.ok(md.includes('<ul><li>one</li><li>two</li></ul>'));
});
