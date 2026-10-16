// Public output: a static website, printable catalogs and an open catalog feed.
// Everything public is produced from publicArtwork(), an explicit allowlist. Private fields,
// unmapped spreadsheet columns, import history and internal notes are never read here.
import { mkdirSync, writeFileSync, copyFileSync, existsSync, rmSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { getSettings, FONT_STACKS } from './settings.mjs';
import { getArtwork, listCustomFields } from './store.mjs';
import { slugify } from './normalize.mjs';
import { J, now, audit } from './db.mjs';

export const CATALOG_FORMAT = 'open-gallery-catalog/0.1';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const PUBLIC_AVAIL = { available: 'Available', on_hold: 'Reserved', sold: 'Sold', nfs: 'Not for sale', on_loan: 'Not currently available' };

export function formatDims(dims) {
  const fmt = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));
  return dims.filter((d) => d.kind === 'work' || d.kind === 'framed').sort((a) => (a.kind === 'work' ? -1 : 1)).map((d) => {
    let core = d.diameter != null ? `Ø ${fmt(d.diameter)}` : [d.h, d.w, d.d].filter((x) => x != null).map(fmt).join(' × ');
    if (!core) core = d.text || '';
    if (!core) return '';
    const unit = d.unit || '';
    let other = '';
    const nums = d.diameter != null ? [d.diameter] : [d.h, d.w, d.d].filter((x) => x != null);
    if (nums.length && (unit === 'in' || unit === 'cm')) {
      const conv = nums.map((n) => (unit === 'in' ? n * 2.54 : n / 2.54)).map((n) => (unit === 'in' ? Math.round(n * 10) / 10 : Math.round(n * 8) / 8));
      other = ` (${d.diameter != null ? 'Ø ' : ''}${conv.map(fmt).join(' × ')} ${unit === 'in' ? 'cm' : 'in'})`;
    }
    return `${d.kind === 'framed' ? 'Framed: ' : ''}${core}${unit ? ' ' + unit : ''}${other}`;
  }).filter(Boolean);
}

export function formatPrice(amount, currency, max) {
  try {
    const f = new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD', maximumFractionDigits: 0 });
    return max ? `${f.format(amount)}–${f.format(max)}` : f.format(amount);
  } catch { return `${currency || ''} ${amount}`; }
}

export function workSlug(aw) { return `${slugify(`${aw.artist} ${aw.title}`)}-${aw.id.slice(-6)}`; }

/** The only function that decides what an artwork looks like in public. */
export function publicArtwork(aw, settings, publicCustom, { showPrices = true } = {}) {
  const avail = aw.availability;
  const allowPrice = showPrices && settings.catalog.showPrices === 'per-work' && aw.price_visibility === 'show' && avail === 'available' && aw.price != null;
  let price = null;
  if (allowPrice) price = { amount: aw.price, max: aw.price_max ?? undefined, currency: aw.currency || settings.catalog.currency, display: formatPrice(aw.price, aw.currency || settings.catalog.currency, aw.price_max) };
  else if (avail === 'available' && aw.price_visibility !== 'hidden') price = { display: 'Price on request' };
  const custom = {};
  for (const f of publicCustom) if (aw.custom[f.key] != null && aw.custom[f.key] !== '') custom[f.label] = String(aw.custom[f.key]);
  return {
    id: aw.id,
    slug: workSlug(aw),
    stock_number: settings.catalog.showStockNumbers ? aw.stock_number || null : null,
    artist: { id: aw.artist_id, name: aw.artist },
    title: aw.title || 'Untitled',
    year: aw.year || null,
    medium: aw.medium || null,
    category: aw.category || null,
    edition: aw.edition || null,
    dimensions: aw.dims.filter((d) => d.kind === 'work' || d.kind === 'framed').map(({ kind, h, w, d, diameter, unit }) => ({ kind, h, w, d, diameter, unit })),
    dimensions_display: formatDims(aw.dims),
    availability: PUBLIC_AVAIL[avail] ? avail : null,
    availability_display: PUBLIC_AVAIL[avail] || null,
    price,
    signature: aw.signature || null,
    provenance: aw.provenance || null,
    exhibition_history: aw.exhibition_history || null,
    literature: aw.literature || null,
    description: aw.description || null,
    image_credit: aw.image_credit || null,
    custom,
    images: aw.media.filter((m) => m.public).map((m) => ({ sha256: m.sha256, ext: m.ext, width: m.width, height: m.height, caption: m.caption || null })),
    links: aw.links.filter((l) => ['artsy', 'artnet', 'website'].includes(l.channel)).map((l) => ({ channel: l.channel, url: l.url })),
    updated_at: aw.updated_at,
  };
}

export function themeCSS(settings, customCss = '') {
  const t = settings.theme;
  const pad = t.density === 'compact' ? 1 : 1.6;
  return `:root{--bg:${t.colorBackground};--text:${t.colorText};--muted:${t.colorMuted};--accent:${t.colorAccent};--line:${t.colorLine};
--font-head:${FONT_STACKS[t.headingFont].css};--font-body:${FONT_STACKS[t.bodyFont].css};--gap:${pad}rem;--radius:${t.corner}px;--fit:${t.imageFit}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 var(--font-body)}
a{color:inherit;text-underline-offset:.18em;text-decoration-thickness:1px}a:hover{color:var(--accent)}
a:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.skip{position:absolute;left:-999px}.skip:focus{left:1rem;top:1rem;background:var(--bg);padding:.5rem;z-index:9}
header.site{display:flex;flex-wrap:wrap;gap:.5rem 2rem;align-items:baseline;justify-content:space-between;padding:1.5rem clamp(1rem,4vw,3rem);border-bottom:1px solid var(--line)}
header.site .name{font:500 1.35rem/1.2 var(--font-head);text-decoration:none;letter-spacing:.01em}
header.site img.logo{max-height:44px;width:auto;display:block}
header.site nav{display:flex;gap:1.25rem;font-size:.95rem}header.site nav a{text-decoration:none;color:var(--muted)}header.site nav a[aria-current]{color:var(--text)}
main{padding:clamp(1.25rem,4vw,3rem);max-width:1320px;margin:0 auto}
h1,h2,h3{font-family:var(--font-head);font-weight:500;line-height:1.15;margin:0 0 .5rem}
h1{font-size:clamp(1.8rem,4vw,2.8rem)}h2{font-size:1.5rem;margin-top:2.5rem}
.lede{color:var(--muted);max-width:46rem;margin:0 0 2rem}.prose{max-width:42rem;white-space:pre-line}
.works{display:grid;gap:calc(var(--gap)*1.6) var(--gap);grid-template-columns:repeat(auto-fill,minmax(${t.density === 'compact' ? 200 : 260}px,1fr));margin:2rem 0;padding:0;list-style:none}
.layout-list .works{grid-template-columns:1fr}.layout-list .works li{display:grid;grid-template-columns:minmax(140px,280px) 1fr;gap:var(--gap);align-items:start}
.layout-salon .works{display:block;columns:${t.density === 'compact' ? '16rem' : '20rem'};column-gap:var(--gap)}.layout-salon .works li{break-inside:avoid;margin-bottom:calc(var(--gap)*1.6)}
.works a{text-decoration:none;display:block}
.frame{background:color-mix(in srgb,var(--line) 35%,var(--bg));aspect-ratio:${t.imageFit === 'cover' ? '4/5' : '1/1'};display:flex;align-items:center;justify-content:center;border-radius:var(--radius);overflow:hidden}
.layout-salon .frame{aspect-ratio:auto;background:none}
.frame img{width:100%;height:100%;object-fit:var(--fit);display:block}.layout-salon .frame img{height:auto}
.frame .noimg{color:var(--muted);font-size:.85rem}
.cap{margin-top:.7rem;font-size:.95rem}.cap .artist{display:block}.cap .title{font-style:italic}.cap .meta{display:block;color:var(--muted);font-size:.88rem}
.badge{display:inline-block;font-size:.78rem;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}
.badge.sold::before{content:'';display:inline-block;width:.55em;height:.55em;border-radius:50%;background:#b3261e;margin-right:.4em;vertical-align:.05em}
.detail{display:grid;gap:clamp(1.5rem,4vw,3.5rem);grid-template-columns:minmax(0,3fr) minmax(16rem,2fr);align-items:start}
.detail .images img{width:100%;height:auto;display:block;margin-bottom:1rem;border-radius:var(--radius)}
.facts{margin:1.25rem 0;display:grid;grid-template-columns:auto 1fr;gap:.35rem 1rem;font-size:.95rem}.facts dt{color:var(--muted)}.facts dd{margin:0;white-space:pre-line}
.actions{display:flex;flex-direction:column;gap:.6rem;margin:1.5rem 0}
.btn{display:inline-block;padding:.75rem 1rem;border:1px solid var(--text);text-decoration:none;text-align:center;border-radius:max(2px,calc(var(--radius)/2))}
.btn.primary{background:var(--text);color:var(--bg)}.btn.primary:hover{background:var(--accent);border-color:var(--accent);color:var(--bg)}
.note{font-size:.85rem;color:var(--muted)}
footer.site{border-top:1px solid var(--line);margin-top:4rem;padding:2rem clamp(1rem,4vw,3rem);color:var(--muted);font-size:.85rem;display:flex;flex-wrap:wrap;gap:1rem 2rem;justify-content:space-between}
.ex-list{list-style:none;padding:0;display:grid;gap:2rem;grid-template-columns:repeat(auto-fill,minmax(300px,1fr))}.ex-list a{text-decoration:none}.ex-list .dates{color:var(--muted);display:block}
@media (max-width:760px){.detail{grid-template-columns:1fr}.layout-list .works li{grid-template-columns:1fr}}
@media print{header.site nav,.actions,.skip,footer.site .gen{display:none}body{background:#fff}}
${customCss}`;
}

function pageShell({ settings, title, body, depth = 0, current = '', description = '', logo = null }) {
  const up = depth ? '../'.repeat(depth) : './';
  const g = settings.gallery;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}${title === g.name ? '' : ' · ' + esc(g.name)}</title>
${description ? `<meta name="description" content="${esc(description)}">` : ''}
<meta name="generator" content="Open Gallery">
<link rel="stylesheet" href="${up}assets/site.css">
<link rel="alternate" type="application/json" href="${up}catalog.json" title="Open catalog feed">
</head><body class="layout-${esc(settings.theme.layout)}"><a class="skip" href="#main">Skip to content</a>
<header class="site"><a class="name" href="${up}index.html">${logo ? `<img class="logo" src="${up}${logo}" alt="${esc(g.name)}">` : esc(g.name)}</a>
<nav aria-label="Site"><a href="${up}exhibitions/index.html"${current === 'ex' ? ' aria-current="page"' : ''}>Exhibitions</a><a href="${up}works/index.html"${current === 'works' ? ' aria-current="page"' : ''}>Works</a><a href="${up}artists/index.html"${current === 'artists' ? ' aria-current="page"' : ''}>Artists</a>${g.website ? `<a href="${esc(g.website)}">Main site</a>` : ''}</nav></header>
<main id="main">${body}</main>
<footer class="site"><div>${esc(g.name)}${g.address ? ' · ' + esc(g.address) : ''}${g.email ? ` · <a href="mailto:${esc(g.email)}">${esc(g.email)}</a>` : ''}${g.phone ? ' · ' + esc(g.phone) : ''}${settings.theme.footer ? `<br>${esc(settings.theme.footer)}` : ''}</div>
<div class="gen">${esc(settings.catalog.rightsStatement)}</div></footer></body></html>`;
}

function imgSrc(img, up, webAvailable) {
  return webAvailable.has(img.sha256) ? `${up}media/${img.sha256}.jpg` : `${up}media/${img.sha256}.${img.ext}`;
}

function workCard(w, up, webAvailable, { showMeta = true } = {}) {
  const img = w.images[0];
  return `<li><a href="${up}works/${w.slug}/index.html"><div class="frame">${img ? `<img src="${imgSrc(img, up, webAvailable)}" alt="${esc(`${w.artist.name}, ${w.title}`)}" loading="lazy"${img.width ? ` width="${img.width}" height="${img.height}"` : ''}>` : '<span class="noimg">Image to follow</span>'}</div>
<div class="cap"><span class="artist">${esc(w.artist.name)}</span><span class="title">${esc(w.title)}</span>${w.year ? `, ${esc(w.year)}` : ''}
${showMeta ? `<span class="meta">${w.availability === 'sold' ? '<span class="badge sold">Sold</span>' : w.price?.amount != null ? esc(w.price.display) : w.availability_display && w.availability !== 'available' ? `<span class="badge">${esc(w.availability_display)}</span>` : ''}</span>` : ''}</div></a></li>`;
}

function inquiryHref(w, settings) {
  const g = settings.gallery;
  if (!g.email || settings.catalog.inquiryMode !== 'email') return null;
  const subject = `Inquiry: ${w.artist.name}, ${w.title}${w.year ? ` (${w.year})` : ''}`;
  const body = `Hello,\n\nI would like to know more about ${w.artist.name}, ${w.title}.\n\n`;
  return `mailto:${g.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

const CHANNEL_LABEL = { artsy: 'Artsy', artnet: 'Artnet', website: 'our website' };

function workPage(w, settings, builtAt, webAvailable, logo) {
  const up = '../../';
  const facts = [
    ['Medium', w.medium], ['Dimensions', w.dimensions_display.join('\n')], ['Edition', w.edition], ['Signature', w.signature],
    ...Object.entries(w.custom), ['Inventory', w.stock_number],
  ].filter(([, v]) => v);
  const inquiry = inquiryHref(w, settings);
  const actions = [];
  if (w.availability !== 'sold' && w.availability !== 'nfs') {
    if (inquiry) actions.push(`<a class="btn primary" href="${esc(inquiry)}">Email the gallery about this work</a><span class="note">Opens a draft in your email app. Nothing is sent until you send it.</span>`);
    for (const l of w.links) actions.push(`<a class="btn" href="${esc(l.url)}" rel="noopener">View on ${esc(CHANNEL_LABEL[l.channel])}</a>`);
    if (w.links.some((l) => l.channel !== 'website')) actions.push('<span class="note">Offers and purchases made on those sites follow their own terms.</span>');
  }
  const date = new Date(builtAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const body = `<article class="detail"><div class="images">${w.images.length ? w.images.map((img, i) => `<img src="${imgSrc(img, up, webAvailable)}" alt="${esc(i === 0 ? `${w.artist.name}, ${w.title}` : img.caption || `${w.title}, view ${i + 1}`)}"${img.width ? ` width="${img.width}" height="${img.height}"` : ''}${i ? ' loading="lazy"' : ''}>`).join('') : '<div class="frame"><span class="noimg">Image to follow</span></div>'}
${w.image_credit ? `<p class="note">${esc(w.image_credit)}</p>` : ''}</div>
<div><h1><span style="display:block;font-size:.55em;margin-bottom:.4rem"><a href="${up}artists/${slugify(w.artist.name)}/index.html">${esc(w.artist.name)}</a></span><i>${esc(w.title)}</i>${w.year ? `, ${esc(w.year)}` : ''}</h1>
<p>${w.availability === 'sold' ? '<span class="badge sold">Sold</span>' : w.price ? esc(w.price.display) : ''}${w.availability && w.availability !== 'available' && w.availability !== 'sold' ? ` <span class="badge">${esc(w.availability_display)}</span>` : ''}</p>
<dl class="facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
${w.description ? `<div class="prose">${esc(w.description)}</div>` : ''}
<div class="actions">${actions.join('')}</div>
<p class="note">Availability as of ${esc(date)}.</p>
${w.provenance ? `<h2>Provenance</h2><div class="prose">${esc(w.provenance)}</div>` : ''}
${w.exhibition_history ? `<h2>Exhibition history</h2><div class="prose">${esc(w.exhibition_history)}</div>` : ''}
${w.literature ? `<h2>Literature</h2><div class="prose">${esc(w.literature)}</div>` : ''}
</div></article>`;
  return pageShell({ settings, title: `${w.artist.name}, ${w.title}`, body, depth: 2, current: 'works', description: `${w.artist.name}, ${w.title}${w.year ? ', ' + w.year : ''}. ${w.medium || ''}`, logo });
}

export function printCatalogHTML(ex, works, settings, { assetBase = '../../', webAvailable = new Set(), builtAt = now() } = {}) {
  const g = settings.gallery;
  const t = settings.theme;
  const items = works.map((w, i) => `<section class="plate"><div class="pimg">${w.images[0] ? `<img src="${imgSrc(w.images[0], assetBase, webAvailable)}" alt="${esc(`${w.artist.name}, ${w.title}`)}">` : ''}</div>
<div class="pcap"><span class="num">${i + 1}</span><strong>${esc(w.artist.name)}</strong><br><i>${esc(w.title)}</i>${w.year ? `, ${esc(w.year)}` : ''}<br>${esc(w.medium || '')}${w.dimensions_display.length ? `<br>${w.dimensions_display.map(esc).join('<br>')}` : ''}${w.edition ? `<br>${esc(w.edition)}` : ''}
${w.availability === 'sold' ? '<br><span class="sm">Sold</span>' : w.price?.amount != null ? `<br>${esc(w.price.display)}` : ''}</div></section>`).join('');
  const date = new Date(builtAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(ex.title)} · ${esc(g.name)} (print catalog)</title>
<style>@page{size:letter;margin:.6in}
body{margin:0;font:11pt/1.5 ${FONT_STACKS[t.bodyFont].css};color:#111;background:#fff}
h1,h2,.cover .g{font-family:${FONT_STACKS[t.headingFont].css};font-weight:500}
.cover{min-height:9.3in;display:flex;flex-direction:column;justify-content:space-between;page-break-after:always;padding:.2in 0}
.cover h1{font-size:34pt;line-height:1.1;margin:0}.cover .sub{font-size:14pt;color:#444;margin-top:.15in}.cover .g{font-size:14pt}
.intro{page-break-after:always;max-width:5.6in;white-space:pre-line}
.plate{page-break-inside:avoid;break-inside:avoid;display:grid;grid-template-rows:6.6in auto;gap:.18in;page-break-after:always;padding-top:.1in}
.pimg{display:flex;align-items:center;justify-content:center;height:6.6in}.pimg img{max-width:100%;max-height:6.6in;object-fit:contain}
.pcap{font-size:10.5pt;max-width:5in}.num{display:inline-block;min-width:1.6em;color:#888}.sm{color:#666;font-size:9.5pt}
.colophon{font-size:9pt;color:#555;max-width:5.6in}
.screen-note{font:14px/1.4 system-ui,sans-serif;background:#f3f1ec;padding:12px 16px;border-bottom:1px solid #ddd}
@media print{.screen-note{display:none}}
@media screen{body{max-width:8.5in;margin:0 auto;padding:0 .4in}.plate,.cover{border-bottom:1px dashed #ccc;margin-bottom:.4in}}
</style></head><body>
<p class="screen-note">Printable catalog. Use your browser's Print command and choose "Save as PDF" to make a PDF. Prices appear only for works whose price you chose to show.</p>
<section class="cover"><div><div class="g">${esc(g.name)}</div></div><div><h1>${esc(ex.title)}</h1>${ex.subtitle ? `<div class="sub">${esc(ex.subtitle)}</div>` : ''}${ex.dates ? `<div class="sub">${esc(ex.dates)}</div>` : ''}</div><div class="sm">${esc([g.address, g.email, g.website].filter(Boolean).join(' · '))}</div></section>
${ex.intro ? `<section class="intro">${esc(ex.intro)}</section>` : ''}
${items}
<section class="colophon"><p>${esc(g.name)}. ${esc(settings.catalog.rightsStatement)}</p><p>Availability and prices as of ${esc(date)} and subject to change.</p></section>
</body></html>`;
}

/**
 * Build the public site into outDir. Returns a report listing what was published and why
 * anything was left out. Writes to a temporary folder first, then swaps it in.
 */
export function buildSite(db, dataDir, outDir) {
  const settings = getSettings(db);
  const builtAt = now();
  const publicCustom = listCustomFields(db).filter((f) => f.visibility === 'public');
  const tmp = `${outDir}.building`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(join(tmp, 'assets'), { recursive: true });
  mkdirSync(join(tmp, 'media'), { recursive: true });
  const warnings = [];
  const webAvailable = new Set();
  const copied = new Set();
  const copyImage = (img) => {
    if (copied.has(img.sha256)) return;
    copied.add(img.sha256);
    const web = join(dataDir, 'media', 'web', `${img.sha256}.jpg`);
    if (existsSync(web)) { copyFileSync(web, join(tmp, 'media', `${img.sha256}.jpg`)); webAvailable.add(img.sha256); return; }
    copyFileSync(join(dataDir, 'media', `${img.sha256}.${img.ext}`), join(tmp, 'media', `${img.sha256}.${img.ext}`));
    if (img.ext === 'jpg') warnings.push({ code: 'original-image', message: `A full-size original JPEG was published because no web copy exists yet (${img.sha256.slice(0, 8)}). Open Publish in the app to make web copies, which also removes camera metadata.` });
  };
  let logo = null;
  if (settings.theme.logoMediaId) {
    const m = db.prepare('SELECT * FROM media WHERE id=?').get(settings.theme.logoMediaId);
    if (m) { copyImage(m); logo = `media/${webAvailable.has(m.sha256) ? m.sha256 + '.jpg' : m.sha256 + '.' + m.ext}`; }
  }
  const rows = db.prepare('SELECT id FROM artworks WHERE public=1').all();
  const works = rows.map((r) => publicArtwork(getArtwork(db, r.id), settings, publicCustom)).sort((a, b) => a.artist.name.localeCompare(b.artist.name) || a.title.localeCompare(b.title));
  for (const w of works) for (const img of w.images) copyImage(img);
  const byId = new Map(works.map((w) => [w.id, w]));
  const exhibitions = db.prepare('SELECT * FROM exhibitions WHERE published=1 ORDER BY created_at DESC').all();
  const exOut = [];
  for (const ex of exhibitions) {
    const items = db.prepare('SELECT artwork_id FROM exhibition_items WHERE exhibition_id=? ORDER BY position').all(ex.id);
    const hidden = items.filter((i) => !byId.has(i.artwork_id)).length;
    if (hidden) warnings.push({ code: 'private-in-exhibition', message: `${hidden} work(s) in "${ex.title}" are private and were left out. Publish them on their artwork page to include them.` });
    const exWorks = items.filter((i) => byId.has(i.artwork_id)).map((i) => {
      const aw = getArtwork(db, i.artwork_id);
      return publicArtwork(aw, settings, publicCustom, { showPrices: !!ex.show_prices });
    });
    exOut.push({ ...ex, works: exWorks });
  }

  const write = (rel, content) => { const p = join(tmp, rel); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, content); };
  const customCss = existsSync(join(dataDir, 'custom', 'site.css')) ? readFileSync(join(dataDir, 'custom', 'site.css'), 'utf8') : '';
  write('assets/site.css', themeCSS(settings, customCss));
  const g = settings.gallery;
  const available = works.filter((w) => w.availability === 'available');
  write('index.html', pageShell({ settings, logo, title: g.name, description: g.tagline || `${g.name}: exhibitions and available works.`, body:
    `<h1>${esc(g.name)}</h1>${g.tagline ? `<p class="lede">${esc(g.tagline)}</p>` : ''}
${exOut.length ? `<h2>Exhibitions</h2><ul class="ex-list">${exOut.map((ex) => `<li><a href="exhibitions/${ex.slug}/index.html"><div class="frame">${ex.works[0]?.images[0] ? `<img src="${imgSrc(ex.works[0].images[0], './', webAvailable)}" alt="" loading="lazy">` : ''}</div><div class="cap"><strong>${esc(ex.title)}</strong>${ex.dates ? `<span class="dates">${esc(ex.dates)}</span>` : ''}</div></a></li>`).join('')}</ul>` : ''}
<h2>Available works</h2>${available.length ? `<ul class="works">${available.slice(0, 24).map((w) => workCard(w, './', webAvailable)).join('')}</ul>${available.length > 24 ? '<p><a href="works/index.html">All works</a></p>' : ''}` : '<p class="lede">No works are published yet.</p>'}` }));
  write('works/index.html', pageShell({ settings, logo, title: 'Works', depth: 1, current: 'works', body: `<h1>Works</h1><ul class="works">${works.map((w) => workCard(w, '../', webAvailable)).join('')}</ul>` }));
  for (const w of works) write(`works/${w.slug}/index.html`, workPage(w, settings, builtAt, webAvailable, logo));
  const artists = new Map();
  for (const w of works) { if (!artists.has(w.artist.name)) artists.set(w.artist.name, []); artists.get(w.artist.name).push(w); }
  write('artists/index.html', pageShell({ settings, logo, title: 'Artists', depth: 1, current: 'artists', body: `<h1>Artists</h1><ul class="ex-list">${[...artists.keys()].map((n) => `<li><a href="${slugify(n)}/index.html"><strong>${esc(n)}</strong><span class="dates">${artists.get(n).length} work${artists.get(n).length === 1 ? '' : 's'}</span></a></li>`).join('')}</ul>` }));
  for (const [n, ws] of artists) {
    const a = db.prepare('SELECT bio, nationality, birth_year FROM artists WHERE id=?').get(ws[0].artist.id) || {};
    write(`artists/${slugify(n)}/index.html`, pageShell({ settings, logo, title: n, depth: 2, current: 'artists', body: `<h1>${esc(n)}</h1>${a.nationality || a.birth_year ? `<p class="lede">${esc([a.nationality, a.birth_year ? `b. ${a.birth_year}` : ''].filter(Boolean).join(', '))}</p>` : ''}${a.bio ? `<div class="prose">${esc(a.bio)}</div>` : ''}<ul class="works">${ws.map((w) => workCard(w, '../../', webAvailable)).join('')}</ul>` }));
  }
  write('exhibitions/index.html', pageShell({ settings, logo, title: 'Exhibitions', depth: 1, current: 'ex', body: `<h1>Exhibitions</h1>${exOut.length ? `<ul class="ex-list">${exOut.map((ex) => `<li><a href="${ex.slug}/index.html"><div class="frame">${ex.works[0]?.images[0] ? `<img src="${imgSrc(ex.works[0].images[0], '../', webAvailable)}" alt="" loading="lazy">` : ''}</div><div class="cap"><strong>${esc(ex.title)}</strong>${ex.dates ? `<span class="dates">${esc(ex.dates)}</span>` : ''}</div></a></li>`).join('')}</ul>` : '<p class="lede">No exhibitions are published yet.</p>'}` }));
  for (const ex of exOut) {
    const layoutClass = ex.layout !== settings.theme.layout ? `<style>body{}</style>` : '';
    const body = `<div class="layout-${esc(ex.layout)}"><h1>${esc(ex.title)}</h1>${ex.subtitle ? `<p class="lede" style="margin-bottom:.25rem">${esc(ex.subtitle)}</p>` : ''}${ex.dates ? `<p class="lede">${esc(ex.dates)}</p>` : ''}
${ex.intro ? `<div class="prose">${esc(ex.intro)}</div>` : ''}<p><a href="print.html">Printable catalog</a></p>
<ul class="works">${ex.works.map((w) => workCard(w, '../../', webAvailable)).join('')}</ul></div>${layoutClass}`;
    write(`exhibitions/${ex.slug}/index.html`, pageShell({ settings, logo, title: ex.title, depth: 2, current: 'ex', body, description: ex.subtitle || ex.title }).replace(`<body class="layout-${settings.theme.layout}">`, `<body class="layout-${esc(ex.layout)}">`));
    write(`exhibitions/${ex.slug}/print.html`, printCatalogHTML(ex, ex.works, settings, { assetBase: '../../', webAvailable, builtAt }));
  }

  // Open catalog feed, including withdrawals so aggregators can remove unpublished works.
  const prevRow = db.prepare("SELECT value FROM meta WHERE key='published_ids'").get();
  const prev = J(prevRow?.value, { ids: {}, withdrawn: {} });
  const ids = {};
  for (const w of works) ids[w.id] = prev.ids[w.id] || builtAt;
  const withdrawn = { ...prev.withdrawn };
  for (const id of Object.keys(prev.ids)) if (!ids[id] && !withdrawn[id]) withdrawn[id] = builtAt;
  for (const id of Object.keys(ids)) delete withdrawn[id];
  db.prepare("INSERT INTO meta(key,value) VALUES ('published_ids', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({ ids, withdrawn }));
  const base = settings.catalog.publicBaseUrl.replace(/\/$/, '');
  const abs = (rel) => (base ? `${base}/${rel}` : rel);
  const feed = {
    format: CATALOG_FORMAT,
    generated_at: builtAt,
    generator: 'Open Gallery',
    publisher: { name: g.name, website: g.website || null, email: settings.catalog.inquiryMode === 'email' ? g.email || null : null },
    rights: { statement: settings.catalog.rightsStatement, note: 'Artwork copyright remains with the artists or other rights holders. Inclusion in this feed is not a license to reproduce images.' },
    availability_as_of: builtAt,
    works: works.map((w) => ({
      ...w,
      url: abs(`works/${w.slug}/index.html`),
      images: w.images.map((img) => ({ url: abs(imgSrc(img, '', webAvailable)), sha256_original: img.sha256, width: img.width, height: img.height, caption: img.caption })),
      first_published_at: ids[w.id],
    })),
    exhibitions: exOut.map((ex) => ({ id: ex.id, slug: ex.slug, title: ex.title, subtitle: ex.subtitle, dates: ex.dates, url: abs(`exhibitions/${ex.slug}/index.html`), works: ex.works.map((w) => w.id) })),
    withdrawn: Object.entries(withdrawn).map(([id, at]) => ({ id, withdrawn_at: at })),
  };
  write('catalog.json', JSON.stringify(feed, null, 2));
  write('robots.txt', 'User-agent: *\nAllow: /\n');
  rmSync(outDir, { recursive: true, force: true });
  renameSync(tmp, outDir);
  const report = { builtAt, outDir, works: works.length, exhibitions: exOut.length, images: copied.size, webImages: webAvailable.size, withdrawn: feed.withdrawn.length, warnings };
  audit(db, 'site.build', null, null, { works: works.length, exhibitions: exOut.length, warnings: warnings.length });
  db.prepare("INSERT INTO meta(key,value) VALUES ('last_site_build', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(report));
  return report;
}
