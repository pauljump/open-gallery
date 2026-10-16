// Open Gallery browser app. Plain JavaScript, no build step.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const view = $('#view');
let STATE = null;

async function api(path, { method = 'GET', body, raw, headers = {} } = {}) {
  const opts = { method, headers: { 'x-open-gallery': '1', ...headers } };
  if (raw !== undefined) opts.body = raw;
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['content-type'] = 'application/json'; }
  const res = await fetch(`/api${path}`, opts);
  const type = res.headers.get('content-type') || '';
  if (!res.ok) {
    const err = type.includes('json') ? await res.json() : { error: await res.text() };
    const e = new Error(err.error || `Request failed (${res.status})`);
    Object.assign(e, err, { status: res.status });
    throw e;
  }
  return type.includes('json') ? res.json() : res;
}

function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `show${bad ? ' bad' : ''}`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { t.className = ''; }, bad ? 6000 : 3000);
}
const fail = (e) => { console.error(e); toast(e.message || String(e), true); };

async function refreshState() {
  STATE = await api('/state');
  $('#gallery-name').textContent = STATE.settings.gallery.name || 'Open Gallery';
  $('#version').textContent = `Open Gallery ${STATE.version}`;
  return STATE;
}

const availLabel = (k) => STATE.availability.find((a) => a.key === k)?.label || k;
const money = (n, cur) => n == null ? '' : new Intl.NumberFormat('en-US', { style: 'currency', currency: cur || STATE.settings.catalog.currency || 'USD', maximumFractionDigits: 0 }).format(n);
const dimsText = (dims) => dims.filter((d) => d.kind === 'work').map((d) => (d.diameter != null ? `Ø ${d.diameter}` : [d.h, d.w, d.d].filter((x) => x != null).join(' × ') || d.text || '') + (d.unit ? ` ${d.unit}` : '')).join('');
const when = (iso) => iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never';

function setTitle(t) { document.title = `${t} · Open Gallery`; }
function focusView() { const h = $('h1', view); if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); } window.scrollTo(0, 0); }

// ---------------------------------------------------------------- router
const routes = [
  [/^\/?$/, home], [/^\/works$/, works], [/^\/works\/new$/, () => workEdit(null)], [/^\/works\/(aw_\w+)$/, (m) => workEdit(m[1])],
  [/^\/artists$/, artists], [/^\/exhibitions$/, exhibitions], [/^\/exhibitions\/(ex_\w+)$/, (m) => exhibitionEdit(m[1])],
  [/^\/import$/, importView], [/^\/publish$/, publish], [/^\/settings$/, settingsView], [/^\/backup$/, backup],
];
let dirty = false;
window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
async function route() {
  const hash = location.hash.slice(1) || '/';
  const [path, qs] = hash.split('?');
  const nav = path.split('/')[1] || 'home';
  $$('#nav a').forEach((a) => { if (a.dataset.nav === nav) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  $('#nav').classList.remove('open'); $('#menu-btn').setAttribute('aria-expanded', 'false');
  dirty = false;
  for (const [re, fn] of routes) {
    const m = path.match(re);
    if (m) {
      try { await refreshState(); await fn(m, new URLSearchParams(qs || '')); focusView(); } catch (e) { view.innerHTML = `<h1>Something went wrong</h1><p class="notice bad">${esc(e.message)}</p>`; }
      return;
    }
  }
  view.innerHTML = '<h1>Not found</h1><p><a href="#/">Back to overview</a></p>';
}
window.addEventListener('hashchange', route);
$('#menu-btn').addEventListener('click', () => { const open = $('#nav').classList.toggle('open'); $('#menu-btn').setAttribute('aria-expanded', String(open)); });
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { const q = $('#q'); if (q) { e.preventDefault(); q.focus(); } }
});

// ---------------------------------------------------------------- overview
async function home() {
  setTitle('Overview');
  const s = STATE.stats;
  const demo = STATE.demo;
  if (STATE.empty) {
    view.innerHTML = `<h1>Welcome to Open Gallery</h1>
<p class="sub">Your catalog lives on this computer, in a folder you control. Nothing here changes your website, Artsy, Artnet or anything else until you choose to publish.</p>
<div class="grid2">
<div class="card"><h2>Bring in your inventory</h2><p>Import a <strong>copy</strong> of your inventory spreadsheet (CSV or Excel) and your image folder. You will see every change before anything is saved.</p><a class="btn primary" href="#/import">Import a spreadsheet</a></div>
<div class="card"><h2>Or look around first</h2><p>Load a fictional sample gallery with 60 works and generated images. You can start fresh later in a new folder.</p><button id="load-demo">Load the sample gallery</button></div>
<div class="card"><h2>Coming from another workspace?</h2><p>Restore a complete Open Gallery export into this empty workspace.</p><a class="btn" href="#/backup">Restore an export</a></div>
</div>
<p class="muted small" style="margin-top:24px">Workspace folder: <code>${esc(STATE.dataDir)}</code></p>`;
    $('#load-demo').onclick = async (ev) => {
      ev.target.disabled = true; ev.target.textContent = 'Creating sample gallery…';
      try { const r = await api('/demo', { method: 'POST' }); toast(`Sample gallery created: ${r.import.created} works`); route(); } catch (e) { fail(e); ev.target.disabled = false; ev.target.textContent = 'Load the sample gallery'; }
    };
    return;
  }
  const last = STATE.lastBuild;
  const audit = await api('/audit?limit=60');
  view.innerHTML = `<h1>${esc(STATE.settings.gallery.name)}</h1>
<p class="sub">${demo ? 'This is the fictional sample gallery. Every artist, work and price is invented. ' : ''}Private workspace on this computer.</p>
<div class="stats">
${[['Works', s.artworks, '#/works'], ['Available', s.available, '#/works?availability=available'], ['Sold', s.sold, '#/works?availability=sold'], ['Published', s.public, '#/works?visibility=public'], ['Artists', s.artists, '#/artists'], ['Exhibitions', s.exhibitions, '#/exhibitions']]
    .map(([l, n, h]) => `<a class="card" href="${h}" style="text-decoration:none"><div class="stat">${n}</div><div class="stat-label">${l}</div></a>`).join('')}
</div>
${s.withoutImages || s.unassignedImages || s.missingFromLastImport ? `<div class="notice warn">${[
    s.withoutImages ? `<a href="#/works?visibility=noimage">${s.withoutImages} work${s.withoutImages === 1 ? '' : 's'} without images</a>` : '',
    s.unassignedImages ? `<a href="#/import">${s.unassignedImages} image${s.unassignedImages === 1 ? '' : 's'} not matched to a work</a>` : '',
    s.missingFromLastImport ? `<a href="#/works?visibility=missing">${s.missingFromLastImport} work${s.missingFromLastImport === 1 ? ' was' : 's were'} not in your last spreadsheet</a> (kept, not deleted)` : '',
  ].filter(Boolean).join(' · ')}</div>` : ''}
<div class="grid2">
<div class="card"><h2>Sales channels</h2>${STATE.connectors.map(connCard).join('')}
<p class="small muted">Open Gallery has no access to your Artsy or Artnet accounts. It keeps your listing links and prepares files you upload yourself.</p></div>
<div class="card"><h2>Public catalog</h2>${last ? `<p>Last built ${esc(when(last.builtAt))}: ${last.works} works, ${last.exhibitions} exhibition${last.exhibitions === 1 ? '' : 's'}.</p><p class="small muted">The build is a folder of files on this computer. It is not online until you upload it somewhere.</p><a class="btn" href="/site/index.html" target="_blank" rel="noopener">Preview it</a>` : '<p>Not built yet.</p>'} <a class="btn" href="#/publish">Publish</a></div>
<div class="card"><h2>Recent changes</h2><ul class="list small">${groupAudit(audit).map((a) => `<li><span class="grow">${esc(describe(a))}${a.n > 1 ? ` <span class="muted">×${a.n}</span>` : ''}</span><span class="muted">${esc(when(a.at))}</span></li>`).join('')}</ul></div>
</div>`;
}

function connCard(c) {
  const label = { not_connected: 'Not connected', file_exchange: 'File exchange', api_connected: 'Connected', attention: 'Needs attention' }[c.state] || c.state;
  return `<div class="conn" style="margin-bottom:12px"><div><strong>${c.channel === 'artsy' ? 'Artsy' : 'Artnet'}</strong> <span class="pill">${esc(label)}</span>
<div class="small muted">${c.listings} work${c.listings === 1 ? '' : 's'} with a listing link${c.last_action ? `. Last action ${esc(when(c.last_action_at))}: ${esc(c.last_action)}` : ''}</div>
${c.unresolved ? `<div class="small" style="color:var(--warn)">${c.unresolved} not yet confirmed on ${c.channel === 'artsy' ? 'Artsy' : 'Artnet'}</div>` : ''}</div></div>`;
}

function groupAudit(list) {
  const out = [];
  for (const a of list) {
    const last = out[out.length - 1];
    if (last && describe(last) === describe(a)) last.n++; else out.push({ ...a, n: 1 });
  }
  return out.slice(0, 8);
}

function describe(a) {
  const d = a.detail || {};
  switch (a.action) {
    case 'import.apply': return `Import applied: ${d.created} new, ${d.updated} updated${d.conflicts ? `, ${d.conflicts} conflicts kept` : ''}`;
    case 'import.upload': return `Spreadsheet uploaded: ${d.filename}`;
    case 'artwork.update': return `Work updated${d.by === 'import' ? ' by import' : ''}: ${(d.fields || []).join(', ')}`;
    case 'artwork.create': return 'Work added';
    case 'site.build': return `Public catalog built: ${d.works} works`;
    case 'export': return `Export saved: ${d.artworks} works`;
    case 'restore': return 'Workspace restored from an export';
    case 'images.import': return `Images imported: ${d.matched} matched of ${d.files}`;
    case 'artsy.package': return `Artsy upload file prepared: ${d.included} works`;
    case 'settings.update': return 'Settings changed';
    case 'demo.seed': return 'Sample gallery created';
    case 'exhibition.create': return 'Exhibition created';
    case 'exhibition.update': return 'Exhibition updated';
    case 'media.add': return 'Image added';
    default: return a.action.replace('.', ' ');
  }
}

// ---------------------------------------------------------------- works
async function works(_m, qs) {
  setTitle('Works');
  const artistsList = await api('/artists');
  const f = { q: qs.get('q') || '', artist: qs.get('artist') || '', availability: qs.get('availability') || '', visibility: qs.get('visibility') || '' };
  view.innerHTML = `<div class="spread"><div><h1>Works</h1><p class="sub" style="margin:0">Press <span class="kbd">/</span> to search.</p></div><a class="btn primary" href="#/works/new">Add a work</a></div>
<form class="filters" id="filters" role="search">
<div class="q"><label for="q">Search</label><input id="q" name="q" value="${esc(f.q)}" placeholder="Title, artist, inventory number, location…" autocomplete="off"></div>
<div><label for="f-artist">Artist</label><select id="f-artist" name="artist"><option value="">All artists</option>${artistsList.map((a) => `<option value="${a.id}"${a.id === f.artist ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}</select></div>
<div><label for="f-av">Availability</label><select id="f-av" name="availability"><option value="">Any</option>${STATE.availability.map((a) => `<option value="${a.key}"${a.key === f.availability ? ' selected' : ''}>${a.label}</option>`).join('')}</select></div>
<div><label for="f-vis">Show</label><select id="f-vis" name="visibility">${[['', 'All works'], ['public', 'Published'], ['private', 'Private only'], ['noimage', 'Without images'], ['missing', 'Not in last import']].map(([k, l]) => `<option value="${k}"${k === f.visibility ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
</form>
<div class="row" id="bulk" style="margin-bottom:10px" hidden><span id="bulk-n"></span>
<button class="small" data-bulk="publish">Publish</button><button class="small" data-bulk="unpublish">Make private</button>
<label class="sr" for="bulk-av">Set availability</label><select id="bulk-av" style="width:auto;min-height:28px;padding:2px 6px"><option value="">Set availability…</option>${STATE.availability.map((a) => `<option value="${a.key}">${a.label}</option>`).join('')}</select></div>
<div id="results"></div>`;
  const load = async () => {
    const params = new URLSearchParams(Object.entries(f).filter(([, v]) => v));
    history.replaceState(null, '', `#/works${params.toString() ? '?' + params : ''}`);
    const { rows, total } = await api(`/artworks?${params}`);
    $('#results').innerHTML = rows.length ? `<p class="small muted" aria-live="polite">${total} work${total === 1 ? '' : 's'}${total > rows.length ? `, showing ${rows.length}` : ''}</p>
<div class="tablewrap"><table><thead><tr><th><input type="checkbox" id="all" aria-label="Select all"></th><th></th><th>Work</th><th class="hide-sm">Inventory</th><th class="hide-sm">Dimensions</th><th class="hide-sm">Price</th><th>Status</th><th class="hide-sm">Location</th></tr></thead><tbody>
${rows.map((r) => `<tr class="clickable" data-id="${r.id}"><td><input type="checkbox" class="sel" value="${r.id}" aria-label="Select ${esc(r.title)}"></td>
<td>${r.thumb ? `<img class="thumb" src="${r.thumb}" alt="" loading="lazy">` : '<div class="thumb"></div>'}</td>
<td><a href="#/works/${r.id}"><strong>${esc(r.artist)}</strong><br><i>${esc(r.title || 'Untitled')}</i>${r.year ? `, ${esc(r.year)}` : ''}</a><div class="show-sm small">${r.price != null ? esc(money(r.price, r.currency)) : ''}</div></td>
<td class="hide-sm">${esc(r.stock_number || '')}</td><td class="hide-sm small">${esc(dimsText(r.dims))}</td>
<td class="hide-sm">${r.price != null ? esc(money(r.price, r.currency)) : '<span class="muted">—</span>'}${r.price_visibility === 'show' ? '' : `<div class="small muted">${r.price_visibility === 'hidden' ? 'hidden' : 'on request'}</div>`}</td>
<td><span class="pill ${r.availability}">${esc(availLabel(r.availability))}</span>${r.public ? ' <span class="pill public">Published</span>' : ''}${r.missing_from_last_import ? ' <span class="pill warn" title="Not in your last spreadsheet">Not in last import</span>' : ''}</td>
<td class="hide-sm small">${esc(r.location)}</td></tr>`).join('')}</tbody></table></div>` : `<div class="notice">No works match. ${STATE.empty ? '<a href="#/import">Import your inventory</a> to get started.' : ''}</div>`;
    const bulk = $('#bulk');
    const update = () => { const n = $$('.sel:checked').length; bulk.hidden = !n; $('#bulk-n').textContent = `${n} selected`; };
    $$('.sel').forEach((c) => { c.onclick = (e) => e.stopPropagation(); c.onchange = update; });
    const all = $('#all'); if (all) all.onchange = () => { $$('.sel').forEach((c) => { c.checked = all.checked; }); update(); };
    $$('tr.clickable').forEach((tr) => { tr.onclick = (e) => { if (e.target.closest('a,input')) return; location.hash = `#/works/${tr.dataset.id}`; }; });
  };
  let timer;
  $('#filters').addEventListener('input', (e) => { f[e.target.name] = e.target.value; clearTimeout(timer); timer = setTimeout(() => load().catch(fail), e.target.name === 'q' ? 200 : 0); });
  $('#filters').addEventListener('submit', (e) => e.preventDefault());
  const bulkDo = async (patch) => { const ids = $$('.sel:checked').map((c) => c.value); await api('/artworks/bulk', { method: 'POST', body: { ids, patch } }); toast(`Updated ${ids.length} work${ids.length === 1 ? '' : 's'}`); load(); };
  $$('[data-bulk]').forEach((b) => { b.onclick = () => bulkDo({ public: b.dataset.bulk === 'publish' }).catch(fail); });
  $('#bulk-av').onchange = (e) => { if (e.target.value) bulkDo({ availability: e.target.value }).catch(fail); };
  await load();
}

function inputRow(name, label, value, { type = 'text', wide = false, help = '', attrs = '' } = {}) {
  const id = `f-${name.replace(/\W/g, '-')}`;
  const control = type === 'textarea' ? `<textarea id="${id}" name="${name}" ${attrs}>${esc(value)}</textarea>` : `<input id="${id}" name="${name}" type="${type}" value="${esc(value)}" ${attrs}>`;
  return `<div class="field${wide ? ' wide' : ''}"><label for="${id}">${label}</label>${control}${help ? `<div class="small muted">${help}</div>` : ''}</div>`;
}
function selectRow(name, label, value, options) {
  const id = `f-${name.replace(/\W/g, '-')}`;
  return `<div class="field"><label for="${id}">${label}</label><select id="${id}" name="${name}">${options.map(([k, l]) => `<option value="${esc(k)}"${String(k) === String(value) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></div>`;
}

async function workEdit(id) {
  const aw = id ? await api(`/artworks/${id}`) : { title: '', artist: '', dims: [], private: {}, custom: {}, extra: {}, links: [], media: [], exhibitions: [], availability: 'available', price_visibility: 'show', public: false, currency: STATE.settings.catalog.currency };
  setTitle(id ? `${aw.artist}, ${aw.title}` : 'Add a work');
  const work = aw.dims.find((d) => d.kind === 'work') || { unit: STATE.settings.catalog.units };
  const framed = aw.dims.find((d) => d.kind === 'framed') || { unit: work.unit || STATE.settings.catalog.units };
  const link = (c) => aw.links.find((l) => l.channel === c)?.url || '';
  const priv = (k) => aw.private[k] ?? '';
  const pub = id ? await api(`/artworks/${id}/public-preview`) : null;
  const units = [['in', 'in'], ['cm', 'cm'], ['mm', 'mm']];
  view.innerHTML = `<p class="small"><a href="#/works">← Works</a></p>
<h1>${id ? `${esc(aw.artist)}, <i>${esc(aw.title || 'Untitled')}</i>` : 'Add a work'}</h1>
${aw.missing_from_last_import ? '<p class="notice warn">This work was not in your last imported spreadsheet. It has been kept. Delete it below if it should go.</p>' : ''}
<div class="layout2"><form id="work-form" novalidate>
<fieldset><legend>Catalog details</legend><div class="formgrid">
${inputRow('artist', 'Artist', aw.artist, { attrs: 'required list="artist-list" autocomplete="off"' })}
${inputRow('title', 'Title', aw.title, { attrs: 'required' })}
${inputRow('year', 'Year', aw.year)}
${inputRow('stock_number', 'Inventory number', aw.stock_number)}
${inputRow('medium', 'Medium', aw.medium, { wide: true })}
${inputRow('category', 'Category', aw.category)}
${inputRow('edition', 'Edition', aw.edition, { help: 'e.g. Unique, or 3/10' })}
</div>
<h3>Dimensions</h3><div class="formgrid">
${inputRow('wh', 'Height', work.h ?? '', { type: 'number', attrs: 'step="any" min="0"' })}${inputRow('ww', 'Width', work.w ?? '', { type: 'number', attrs: 'step="any" min="0"' })}${inputRow('wd', 'Depth', work.d ?? '', { type: 'number', attrs: 'step="any" min="0"' })}${selectRow('wu', 'Unit', work.unit || 'in', units)}
${inputRow('fh', 'Framed height', framed.h ?? '', { type: 'number', attrs: 'step="any" min="0"' })}${inputRow('fw', 'Framed width', framed.w ?? '', { type: 'number', attrs: 'step="any" min="0"' })}${inputRow('fd', 'Framed depth', framed.d ?? '', { type: 'number', attrs: 'step="any" min="0"' })}${selectRow('fu', 'Unit', framed.unit || 'in', units)}
</div>
<div class="formgrid">
${inputRow('signature', 'Signature', aw.signature, { wide: true })}
${inputRow('description', 'Public description', aw.description, { type: 'textarea', wide: true })}
${inputRow('provenance', 'Provenance', aw.provenance, { type: 'textarea', wide: true })}
${inputRow('exhibition_history', 'Exhibition history', aw.exhibition_history, { type: 'textarea', wide: true })}
${inputRow('literature', 'Literature', aw.literature, { type: 'textarea', wide: true })}
${inputRow('condition', 'Condition', aw.condition, { type: 'textarea', wide: true, help: 'Not shown publicly unless you add it to the description.' })}
${inputRow('image_credit', 'Image credit and rights', aw.image_credit, { wide: true, help: 'Shown under the image, e.g. "Photo: Jane Doe. © the artist."' })}
</div></fieldset>
<fieldset><legend>Sales</legend><div class="formgrid">
${selectRow('availability', 'Availability', aw.availability, STATE.availability.map((a) => [a.key, a.label]))}
${inputRow('price', 'Price', aw.price ?? '', { type: 'number', attrs: 'step="any" min="0"' })}
${inputRow('currency', 'Currency', aw.currency || STATE.settings.catalog.currency, { attrs: 'maxlength="3"' })}
${selectRow('price_visibility', 'Public price', aw.price_visibility, [['show', 'Show the price'], ['on_request', 'Price on request'], ['hidden', 'Hide price entirely']])}
${inputRow('link_artsy', 'Artsy listing link', link('artsy'), { type: 'url', wide: true })}
${inputRow('link_artnet', 'Artnet listing link', link('artnet'), { type: 'url', wide: true })}
${inputRow('link_website', 'Your website listing link', link('website'), { type: 'url', wide: true })}
</div><p class="small muted">Links stay exactly as they are. Buyers who click them buy or make offers on that site, under its terms.</p></fieldset>
<fieldset class="private"><legend>Private</legend><div class="formgrid">
${inputRow('p_location', 'Location', priv('location'))}
${inputRow('p_cost', 'Acquisition cost', priv('cost'))}
${inputRow('p_consignor', 'Consignor or owner', priv('consignor'))}
${inputRow('p_insurance_value', 'Insurance value', priv('insurance_value'))}
${inputRow('p_collector', 'Buyer or collector', priv('collector'))}
${inputRow('p_consignment_terms', 'Consignment terms', priv('consignment_terms'), { type: 'textarea', wide: true })}
${inputRow('p_notes', 'Private notes', priv('notes'), { type: 'textarea', wide: true })}
</div></fieldset>
${STATE.customFields.length ? `<fieldset><legend>Your fields</legend><div class="formgrid">${STATE.customFields.map((cf) => inputRow(`c_${cf.key}`, `${esc(cf.label)}${cf.visibility === 'private' ? ' (private)' : ' (public)'}`, aw.custom[cf.key] ?? '', { type: cf.type === 'number' ? 'number' : cf.type === 'date' ? 'date' : cf.type === 'longtext' ? 'textarea' : 'text' })).join('')}</div></fieldset>` : ''}
${Object.keys(aw.extra).length ? `<fieldset class="private"><legend>Other columns from your spreadsheet</legend><dl class="preview-box">${Object.entries(aw.extra).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl><p class="small muted">Kept exactly as imported. Map them to a field on your next import, or add a custom field in Settings.</p></fieldset>` : ''}
<div class="row" style="position:sticky;bottom:0;background:var(--bg);padding:12px 0;border-top:1px solid var(--line)">
<button class="primary" type="submit">${id ? 'Save changes' : 'Add work'}</button>
<label class="check"><input type="checkbox" name="public" ${aw.public ? 'checked' : ''}> Publish this work</label>
<span id="save-state" class="small muted" aria-live="polite"></span>
${id ? '<button type="button" class="danger" id="del" style="margin-left:auto">Delete…</button>' : ''}
</div></form>
<aside class="sticky">
${id ? `<div class="card"><h3>Images</h3><div class="media-grid" id="media">${aw.media.map((m, i) => `<div class="media-item"><img src="${m.url}" alt="${esc(`${aw.title}, image ${i + 1}`)}">
<div class="row"><button class="small" data-mv="${m.id}" data-pos="${i - 1}" ${i === 0 ? 'disabled' : ''} aria-label="Move image ${i + 1} earlier">←</button><button class="small" data-mv="${m.id}" data-pos="${i + 1}" ${i === aw.media.length - 1 ? 'disabled' : ''} aria-label="Move image ${i + 1} later">→</button>
<button class="small" data-rm="${m.id}" aria-label="Remove image ${i + 1}">Remove</button></div>
<label class="check small"><input type="checkbox" data-pubimg="${m.id}" ${m.public ? 'checked' : ''}> Public</label></div>`).join('')}</div>
<div class="drop" id="drop" style="margin-top:10px"><label for="img-in" style="margin:0;color:inherit;cursor:pointer">Drop images here or <u>choose files</u></label><input id="img-in" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple class="sr"></div></div>
<div class="card" style="margin-top:14px"><h3>What the public sees</h3>${aw.public ? '' : '<p class="notice">Private. This work does not appear in any public page or feed.</p>'}
<dl class="preview-box"><dt>Caption</dt><dd>${esc(pub.artist.name)}, <i>${esc(pub.title)}</i>${pub.year ? `, ${esc(pub.year)}` : ''}</dd>
${pub.medium ? `<dt>Medium</dt><dd>${esc(pub.medium)}</dd>` : ''}${pub.dimensions_display.length ? `<dt>Dimensions</dt><dd>${pub.dimensions_display.map(esc).join('<br>')}</dd>` : ''}
<dt>Price</dt><dd>${pub.price ? esc(pub.price.display) : esc(pub.availability_display || 'Not shown')}</dd>
<dt>Buttons</dt><dd>${pub.availability === 'sold' || pub.availability === 'nfs' ? 'None (not for sale)' : [STATE.settings.gallery.email && STATE.settings.catalog.inquiryMode === 'email' ? 'Email the gallery' : '', ...pub.links.map((l) => `View on ${l.channel === 'website' ? 'your website' : l.channel[0].toUpperCase() + l.channel.slice(1)}`)].filter(Boolean).join(', ') || 'None'}</dd>
<dt>Never shown</dt><dd>Location, cost, consignor, insurance value, buyer, terms, notes and other spreadsheet columns.</dd></dl></div>
${aw.exhibitions.length ? `<div class="card" style="margin-top:14px"><h3>In exhibitions</h3>${aw.exhibitions.map((e) => `<a href="#/exhibitions/${e.id}">${esc(e.title)}</a>`).join('<br>')}</div>` : ''}` : '<div class="card"><p>Add images after saving the work.</p></div>'}
</aside></div>
<datalist id="artist-list">${(await api('/artists')).map((a) => `<option value="${esc(a.name)}">`).join('')}</datalist>`;
  const form = $('#work-form');
  form.addEventListener('input', () => { dirty = true; $('#save-state').textContent = 'Unsaved changes'; });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const g = (k) => (fd.get(k) ?? '').toString().trim();
    if (!g('artist') || !g('title')) { toast('A work needs an artist and a title', true); (g('artist') ? $('#f-title') : $('#f-artist')).focus(); return; }
    const num = (k) => (g(k) === '' ? undefined : Number(g(k)));
    const dims = [];
    if (g('wh') || g('ww') || g('wd')) dims.push({ kind: 'work', h: num('wh'), w: num('ww'), d: num('wd'), unit: g('wu') });
    if (g('fh') || g('fw') || g('fd')) dims.push({ kind: 'framed', h: num('fh'), w: num('fw'), d: num('fd'), unit: g('fu') });
    for (const d of aw.dims) if (!['work', 'framed'].includes(d.kind)) dims.push(d);
    const patch = {
      artist: g('artist'), title: g('title'), year: g('year'), stock_number: g('stock_number'), medium: g('medium'), category: g('category'), edition: g('edition'),
      signature: g('signature'), description: g('description'), provenance: g('provenance'), exhibition_history: g('exhibition_history'), literature: g('literature'),
      condition: g('condition'), image_credit: g('image_credit'), availability: g('availability'), price: g('price') === '' ? null : Number(g('price')),
      currency: g('currency').toUpperCase(), price_visibility: g('price_visibility'), public: fd.get('public') === 'on', dims,
      links: ['artsy', 'artnet', 'website'].map((c) => ({ channel: c, url: g(`link_${c}`) })),
      private: Object.fromEntries(['location', 'cost', 'consignor', 'insurance_value', 'collector', 'consignment_terms', 'notes'].map((k) => [k, g(`p_${k}`)])),
      custom: Object.fromEntries(STATE.customFields.map((cf) => [cf.key, g(`c_${cf.key}`)])),
    };
    try {
      const saved = id ? await api(`/artworks/${id}`, { method: 'PATCH', body: patch }) : await api('/artworks', { method: 'POST', body: patch });
      dirty = false;
      toast('Saved');
      if (!id) location.hash = `#/works/${saved.id}`; else workEdit(id).then(() => $('#save-state') && ($('#save-state').textContent = 'Saved'));
    } catch (err) { fail(err); }
  });
  if (!id) return;
  $('#del').onclick = async () => {
    if (!confirmInline($('#del'), 'Delete permanently? Click again to confirm.')) return;
    await api(`/artworks/${id}`, { method: 'DELETE' }).catch(fail); toast('Deleted'); location.hash = '#/works';
  };
  const upload = async (files) => {
    for (const file of files) { try { await api(`/media?artwork=${id}&name=${encodeURIComponent(file.name)}`, { method: 'POST', raw: file }); } catch (e) { fail(e); } }
    toast(`${files.length} image${files.length === 1 ? '' : 's'} added`); workEdit(id);
  };
  $('#img-in').onchange = (e) => upload([...e.target.files]);
  dropZone($('#drop'), upload);
  $$('[data-mv]').forEach((b) => { b.onclick = async () => { await api(`/media/${b.dataset.mv}`, { method: 'PATCH', body: { position: Number(b.dataset.pos) } }).catch(fail); await workEdit(id); $(`[data-mv="${b.dataset.mv}"]`)?.focus(); }; });
  $$('[data-rm]').forEach((b) => { b.onclick = async () => { if (!confirmInline(b, 'Sure?')) return; await api(`/media/${b.dataset.rm}`, { method: 'DELETE' }).catch(fail); workEdit(id); }; });
  $$('[data-pubimg]').forEach((c) => { c.onchange = () => api(`/media/${c.dataset.pubimg}`, { method: 'PATCH', body: { public: c.checked } }).then(() => toast(c.checked ? 'Image will be public' : 'Image kept private')).catch(fail); });
}

function confirmInline(btn, msg) {
  if (btn.dataset.armed) return true;
  btn.dataset.armed = '1'; const old = btn.textContent; btn.textContent = msg;
  setTimeout(() => { delete btn.dataset.armed; btn.textContent = old; }, 4000);
  return false;
}

function dropZone(el, onFiles) {
  el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('over'); });
  el.addEventListener('dragleave', () => el.classList.remove('over'));
  el.addEventListener('drop', (e) => { e.preventDefault(); el.classList.remove('over'); const files = [...e.dataTransfer.files]; if (files.length) onFiles(files); });
}

// ---------------------------------------------------------------- artists
async function artists() {
  setTitle('Artists');
  const list = await api('/artists');
  view.innerHTML = `<h1>Artists</h1><p class="sub">Artists are created from your works. Add a short bio and it appears on the public artist page.</p>
<div class="tablewrap"><table><thead><tr><th>Artist</th><th>Works</th><th>Available</th><th></th></tr></thead><tbody>
${list.map((a) => `<tr><td><strong>${esc(a.name)}</strong>${a.nationality || a.birth_year ? `<div class="small muted">${esc([a.nationality, a.birth_year && `b. ${a.birth_year}`].filter(Boolean).join(', '))}</div>` : ''}</td>
<td><a href="#/works?artist=${a.id}">${a.works}</a></td><td>${a.available || 0}</td><td><button class="small" data-edit="${a.id}">Edit</button></td></tr>
<tr id="edit-${a.id}" hidden><td colspan="4"><form data-form="${a.id}" class="formgrid">${inputRow('name', 'Name', a.name)}${inputRow('nationality', 'Nationality', a.nationality)}${inputRow('birth_year', 'Born', a.birth_year)}${inputRow('website', 'Website', a.website, { type: 'url' })}${inputRow('bio', 'Bio', a.bio, { type: 'textarea', wide: true })}<div class="row wide"><button class="primary" type="submit">Save</button></div></form></td></tr>`).join('')}
</tbody></table></div>`;
  $$('[data-edit]').forEach((b) => { b.onclick = () => { const r = $(`#edit-${b.dataset.edit}`); r.hidden = !r.hidden; if (!r.hidden) $('input', r).focus(); }; });
  $$('[data-form]').forEach((f) => { f.onsubmit = async (e) => { e.preventDefault(); try { await api(`/artists/${f.dataset.form}`, { method: 'PATCH', body: Object.fromEntries(new FormData(f)) }); toast('Saved'); artists(); } catch (err) { fail(err); } }; });
}

// ---------------------------------------------------------------- exhibitions
async function exhibitions() {
  setTitle('Exhibitions');
  const list = await api('/exhibitions');
  view.innerHTML = `<div class="spread"><div><h1>Exhibitions</h1><p class="sub" style="margin:0">Group works into a show, viewing room or art fair selection. Each one gets a public page and a printable catalog.</p></div>
<form id="new-ex" class="row"><label class="sr" for="ex-title">New exhibition title</label><input id="ex-title" name="title" placeholder="New exhibition title" style="width:240px" required><button class="primary">Create</button></form></div>
<ul class="list" style="margin-top:18px">${list.map((e) => `<li><div class="grow"><a href="#/exhibitions/${e.id}"><strong>${esc(e.title)}</strong></a><div class="small muted">${esc(e.dates || '')} · ${e.works} work${e.works === 1 ? '' : 's'}</div></div>${e.published ? '<span class="pill public">Published</span>' : '<span class="pill">Draft</span>'}</li>`).join('') || '<li class="muted">No exhibitions yet.</li>'}</ul>`;
  $('#new-ex').onsubmit = async (e) => { e.preventDefault(); try { const ex = await api('/exhibitions', { method: 'POST', body: { title: $('#ex-title').value } }); location.hash = `#/exhibitions/${ex.id}`; } catch (err) { fail(err); } };
}

async function exhibitionEdit(id) {
  const ex = await api(`/exhibitions/${id}`);
  setTitle(ex.title);
  let items = ex.items.filter((i) => i.artwork).map((i) => i.artwork);
  view.innerHTML = `<p class="small"><a href="#/exhibitions">← Exhibitions</a></p><h1>${esc(ex.title)}</h1>
<div class="layout2"><div>
<form id="ex-form"><fieldset><legend>Details</legend><div class="formgrid">
${inputRow('title', 'Title', ex.title)}${inputRow('subtitle', 'Subtitle', ex.subtitle)}${inputRow('dates', 'Dates', ex.dates, { help: 'Written as you want it shown' })}
${selectRow('layout', 'Layout', ex.layout, [['grid', 'Grid'], ['list', 'List with large images'], ['salon', 'Salon (natural proportions)']])}
${inputRow('intro', 'Introduction', ex.intro, { type: 'textarea', wide: true })}
<label class="check wide"><input type="checkbox" name="show_prices" ${ex.show_prices ? 'checked' : ''}> Show prices (only for works set to show a price)</label>
<label class="check wide" style="margin:8px 0 12px"><input type="checkbox" name="published" ${ex.published ? 'checked' : ''}> Include on the public site</label>
</div><div class="row"><button class="primary" type="submit">Save</button><a class="btn" href="/print/exhibitions/${ex.id}" target="_blank" rel="noopener">Printable catalog</a><button type="button" class="danger" id="del-ex" style="margin-left:auto">Delete…</button></div></fieldset></form>
<h2>Works in this exhibition</h2><p class="small muted">The order here is the order on the page and in the catalog. Private works stay off the public page until you publish them.</p>
<ol class="list" id="ex-items"></ol></div>
<aside class="sticky card"><h3>Add works</h3><label for="ex-q" class="sr">Search works</label><input id="ex-q" placeholder="Search your works"><ul class="list small" id="ex-found" style="max-height:60vh;overflow:auto"></ul></aside></div>`;
  const renderItems = () => {
    $('#ex-items').innerHTML = items.map((w, i) => `<li><img class="thumb" src="${w.media[0]?.url || ''}" alt=""><div class="grow"><strong>${esc(w.artist)}</strong>, <i>${esc(w.title)}</i>${w.public ? '' : ' <span class="pill warn">Private</span>'} <span class="pill ${w.availability}">${esc(availLabel(w.availability))}</span></div>
<button class="small" data-up="${i}" ${i ? '' : 'disabled'} aria-label="Move ${esc(w.title)} up">↑</button><button class="small" data-down="${i}" ${i < items.length - 1 ? '' : 'disabled'} aria-label="Move ${esc(w.title)} down">↓</button><button class="small" data-x="${i}" aria-label="Remove ${esc(w.title)}">Remove</button></li>`).join('') || '<li class="muted">No works yet. Search on the right to add some.</li>';
    $$('[data-up]').forEach((b) => { b.onclick = () => { const i = +b.dataset.up; [items[i - 1], items[i]] = [items[i], items[i - 1]]; saveItems(`[data-up="${i - 1}"]`); }; });
    $$('[data-down]').forEach((b) => { b.onclick = () => { const i = +b.dataset.down; [items[i + 1], items[i]] = [items[i], items[i + 1]]; saveItems(`[data-down="${i + 1}"]`); }; });
    $$('[data-x]').forEach((b) => { b.onclick = () => { items.splice(+b.dataset.x, 1); saveItems(); }; });
  };
  const saveItems = async (focusSel) => { try { await api(`/exhibitions/${id}`, { method: 'PATCH', body: { items: items.map((w) => w.id) } }); renderItems(); if (focusSel) $(focusSel)?.focus(); search(); } catch (e) { fail(e); } };
  const search = async () => {
    const { rows } = await api(`/artworks?limit=60&q=${encodeURIComponent($('#ex-q').value)}`);
    const have = new Set(items.map((w) => w.id));
    $('#ex-found').innerHTML = rows.filter((r) => !have.has(r.id)).map((r) => `<li>${r.thumb ? `<img class="thumb" src="${r.thumb}" alt="">` : '<div class="thumb"></div>'}<div class="grow">${esc(r.artist)}, <i>${esc(r.title)}</i></div><button class="small" data-add="${r.id}" aria-label="Add ${esc(r.title)}">Add</button></li>`).join('');
    $$('[data-add]').forEach((b) => { b.onclick = async () => { items.push(await api(`/artworks/${b.dataset.add}`)); saveItems(); }; });
  };
  let t; $('#ex-q').oninput = () => { clearTimeout(t); t = setTimeout(search, 200); };
  $('#ex-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try { await api(`/exhibitions/${id}`, { method: 'PATCH', body: { title: fd.get('title'), subtitle: fd.get('subtitle'), dates: fd.get('dates'), intro: fd.get('intro'), layout: fd.get('layout'), show_prices: fd.get('show_prices') === 'on', published: fd.get('published') === 'on' } }); toast('Saved. Publish again to update the public site.'); } catch (err) { fail(err); }
  };
  $('#del-ex').onclick = async (e) => { if (!confirmInline(e.target, 'Delete exhibition? Click again.')) return; await api(`/exhibitions/${id}`, { method: 'DELETE' }); location.hash = '#/exhibitions'; };
  renderItems(); search();
}

// ---------------------------------------------------------------- import
async function importView() {
  setTitle('Import');
  const [history, unassigned] = await Promise.all([api('/imports'), api('/media/unassigned')]);
  view.innerHTML = `<h1>Import</h1>
<p class="sub">Use a <strong>copy</strong> of your inventory spreadsheet. Open Gallery keeps the original file, shows every change before saving, never deletes works that are missing from a file, and never marks a sold work available without asking.</p>
<div class="grid2">
<div class="card"><h2>1. Spreadsheet</h2><p class="small muted">CSV or Excel (.xlsx). One row per work, with a header row. From Numbers or older Excel, export to CSV or .xlsx first.</p>
<div class="drop" id="sheet-drop"><label for="sheet-in" style="margin:0;color:inherit;cursor:pointer">Drop a spreadsheet here or <u>choose a file</u></label><input id="sheet-in" type="file" accept=".csv,.tsv,.txt,.xlsx" class="sr"></div></div>
<div class="card"><h2>2. Images</h2><p class="small muted">Name images by inventory number: <code>GL-1001.jpg</code>, extra views <code>GL-1001_2.jpg</code>. Import the spreadsheet first so they can be matched.</p>
<div class="drop" id="img-drop"><label for="imgs-in" style="margin:0;color:inherit;cursor:pointer">Drop images or a folder here or <u>choose files</u></label><input id="imgs-in" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple class="sr"></div>
<div id="img-progress"></div></div></div>
<div id="import-work"></div>
${unassigned.length ? `<h2>Images not matched to a work (${unassigned.length})</h2><p class="small muted">Their file names did not match an inventory number. Assign each one, or leave them here.</p><div class="media-grid">${unassigned.map((m) => `<div class="media-item"><img src="${m.url}" alt="${esc(m.original_name)}"><div class="small">${esc(m.original_name)}</div><label class="sr" for="as-${m.id}">Assign ${esc(m.original_name)} to work</label><input id="as-${m.id}" data-assign="${m.id}" placeholder="Inventory number" style="margin-top:4px"></div>`).join('')}</div>` : ''}
<h2>Past imports</h2><ul class="list small">${history.map((h) => `<li><span class="grow">${esc(h.filename)}</span><span class="pill ${h.status === 'applied' ? 'ok' : ''}">${h.status === 'applied' ? `Applied: ${h.summary.created ?? 0} new, ${h.summary.updated ?? 0} updated` : 'Not applied'}</span><span class="muted">${esc(when(h.created_at))}</span></li>`).join('') || '<li class="muted">None yet.</li>'}</ul>`;
  const sheet = async (file) => {
    try {
      const up = await api(`/imports?name=${encodeURIComponent(file.name)}`, { method: 'POST', raw: file });
      importReview(up);
    } catch (e) { fail(e); }
  };
  $('#sheet-in').onchange = (e) => e.target.files[0] && sheet(e.target.files[0]);
  dropZone($('#sheet-drop'), (files) => sheet(files[0]));
  const images = async (files) => {
    files = files.filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f.name));
    const box = $('#img-progress');
    box.innerHTML = `<div class="progress" role="progressbar" aria-label="Uploading images" aria-valuemin="0" aria-valuemax="${files.length}"><div></div></div><p class="small" aria-live="polite" id="img-status"></p>`;
    let matched = 0, unmatched = 0, dup = 0, errs = 0;
    for (let i = 0; i < files.length; i++) {
      try { const r = await api(`/images?name=${encodeURIComponent(files[i].name)}`, { method: 'POST', raw: files[i] }); matched += r.matched; unmatched += r.unmatched; dup += r.duplicates; errs += r.errors; } catch { errs++; }
      $('.progress>div', box).style.width = `${((i + 1) / files.length) * 100}%`; $('.progress', box).setAttribute('aria-valuenow', i + 1);
      $('#img-status').textContent = `${i + 1} of ${files.length}`;
    }
    $('#img-status').textContent = `${matched} matched, ${dup} already there, ${unmatched} not matched, ${errs} could not be read.`;
    toast(`${matched} images matched`);
    if (unmatched) setTimeout(importView, 1500);
  };
  $('#imgs-in').onchange = (e) => images([...e.target.files]);
  dropZone($('#img-drop'), images);
  $$('[data-assign]').forEach((inp) => {
    inp.onchange = async () => {
      const { rows } = await api(`/artworks?q=${encodeURIComponent(inp.value.trim())}&limit=5`);
      const hit = rows.find((r) => (r.stock_number || '').toLowerCase() === inp.value.trim().toLowerCase()) || (rows.length === 1 ? rows[0] : null);
      if (!hit) return toast('No single work matches that inventory number', true);
      await api(`/media/${inp.dataset.assign}`, { method: 'PATCH', body: { artwork_id: hit.id } }); toast(`Assigned to ${hit.title}`); importView();
    };
  });
}

async function importReview(up) {
  const box = $('#import-work');
  let decisions = {};
  let mapping = up.mapping;
  const targets = (await api(`/imports/${up.id}/preview`, { method: 'POST', body: {} })).targets;
  const render = async () => {
    let pv;
    try { pv = await api(`/imports/${up.id}/preview`, { method: 'POST', body: { mapping, decisions } }); } catch (e) { fail(e); return; }
    const s = pv.summary;
    const samples = (i) => up.sample.map((r) => r[i]).filter(Boolean).slice(0, 3).join(' · ');
    const opt = (t, cur) => `<option value="${t}"${t === cur ? ' selected' : ''}>`;
    box.innerHTML = `<h2>Review: ${esc(up.filename)}</h2>
${up.sameFileAppliedBefore ? `<p class="notice">This exact file was imported on ${esc(when(up.sameFileAppliedBefore.created_at))}. Applying it again changes nothing unless you edited works since.</p>` : ''}
<details ${s.missingRequired.length || !pv.headers.length ? 'open' : ''} class="card"><summary><strong>Columns</strong> · ${pv.headers.length} found, ${s.extraColumns.length} kept as extra fields</summary>
<div class="tablewrap" style="margin-top:10px"><table><thead><tr><th>Your column</th><th>Examples</th><th>Goes to</th></tr></thead><tbody>
${pv.headers.map((h, i) => `<tr><td>${esc(h)}</td><td class="small muted">${esc(samples(i))}</td><td><label class="sr" for="map-${i}">Map ${esc(h)}</label><select id="map-${i}" data-map="${i}">
${opt('keep', mapping[i])}Keep as an extra field (private)</option>${opt('ignore', mapping[i])}Ignore this column</option>
<optgroup label="Public when published">${targets.filter((t) => t.visibility === 'public').map((t) => `${opt(t.key, mapping[i])}${esc(t.label)}${t.required ? ' (required)' : ''}</option>`).join('')}</optgroup>
<optgroup label="Private, never published">${targets.filter((t) => t.visibility === 'private').map((t) => `${opt(t.key, mapping[i])}${esc(t.label)}</option>`).join('')}</optgroup>
</select></td></tr>`).join('')}</tbody></table></div></details>
${s.missingRequired.length ? `<p class="notice bad">Choose a column for: ${s.missingRequired.map(esc).join(', ')}.</p>` : ''}
<div class="stats">${[['New', s.create], ['Updated', s.update], ['Unchanged', s.unchanged], ['Need a decision', s.review], ['Conflicts', s.conflicts], ['Kept as sold', s.blocked], ['Rows with errors', s.error]].map(([l, n]) => `<div class="card"><div class="stat">${n}</div><div class="stat-label">${l}</div></div>`).join('')}</div>
${s.notInFile ? `<p class="notice">${s.notInFile} work${s.notInFile === 1 ? ' is' : 's are'} in your catalog but not in this file. ${s.notInFile === 1 ? 'It' : 'They'} will be kept and flagged, not deleted.</p>` : ''}
<div class="tabs" role="group" aria-label="Filter rows">${[['attention', 'Needs attention'], ['changes', 'All changes'], ['all', 'All rows']].map(([k, l]) => `<button type="button" data-tab="${k}" aria-pressed="${render.tab === k}">${l}</button>`).join('')}</div>
<ul class="list" id="plan">${planRows(pv.plan, render.tab)}</ul>
<div class="row" style="position:sticky;bottom:0;background:var(--bg);padding:12px 0;border-top:1px solid var(--line)">
<button class="primary" id="apply" ${s.undecided || s.missingRequired.length ? 'disabled' : ''}>Apply ${s.create + s.update + pv.plan.filter((p) => p.action === 'review' && p.decision && p.decision !== 'skip').length} change${s.create + s.update === 1 ? '' : 's'}</button>
<span class="small muted">${s.undecided ? `Decide the ${s.undecided} possible duplicate${s.undecided === 1 ? '' : 's'} first.` : 'Nothing is saved until you apply.'}</span></div>`;
    $$('[data-map]').forEach((sel) => { sel.onchange = () => { mapping = [...mapping]; mapping[+sel.dataset.map] = sel.value; render(); }; });
    $$('[data-tab]').forEach((b) => { b.onclick = () => { render.tab = b.dataset.tab; render(); }; });
    $$('[data-dec]').forEach((sel) => { sel.onchange = () => { const row = sel.dataset.dec; decisions[row] = { ...(decisions[row] || {}), match: sel.value || undefined }; render(); }; });
    $$('[data-field]').forEach((sel) => { sel.onchange = () => { const [row, field] = sel.dataset.field.split('|'); decisions[row] = { ...(decisions[row] || {}), fields: { ...(decisions[row]?.fields || {}), [field]: sel.value } }; render(); }; });
    $('#apply').onclick = async () => {
      $('#apply').disabled = true;
      try { const r = await api(`/imports/${up.id}/apply`, { method: 'POST', body: { decisions } }); toast(`Applied: ${r.created} new, ${r.updated} updated`); box.innerHTML = `<p class="notice ok">Import applied: ${r.created} new, ${r.updated} updated, ${r.skipped} skipped. ${r.notInFile ? `${r.notInFile} work(s) not in the file were flagged, not deleted.` : ''} <a href="#/works">See your works</a></p>`; }
      catch (e) { fail(e); $('#apply').disabled = false; }
    };
  };
  render.tab = 'attention';
  await render();
  box.scrollIntoView({ behavior: 'smooth' });
}

function planRows(plan, tab) {
  const rows = plan.filter((p) => tab === 'all' || (tab === 'changes' ? p.action !== 'unchanged' : p.action === 'review' || p.action === 'error' || p.changes.some((c) => c.kind !== 'update') || p.issues.length));
  if (!rows.length) return `<li class="muted">${tab === 'attention' ? 'Nothing needs your attention.' : 'No rows.'}</li>`;
  const fmt = (v) => v == null || v === '' ? '(empty)' : typeof v === 'object' ? [v.h, v.w, v.d].filter((x) => x != null).join(' × ') + (v.unit ? ` ${v.unit}` : '') : String(v);
  return rows.slice(0, 400).map((p) => `<li style="align-items:flex-start"><div class="grow"><div><span class="pill ${p.action === 'error' ? 'bad' : p.action === 'review' ? 'warn' : p.action === 'create' ? 'ok' : ''}">${{ create: 'New', update: 'Update', unchanged: 'Unchanged', review: 'Decide', error: 'Error' }[p.action]}</span>
Row ${p.row}: <strong>${esc(p.artist || '?')}</strong>, <i>${esc(p.title || '(no title)')}</i>${p.stock ? ` · ${esc(p.stock)}` : ''}</div>
${p.issues.map((i) => `<div class="small" style="color:var(--${i.level === 'error' ? 'bad' : 'warn'})">${esc(i.message)}</div>`).join('')}
${p.action === 'review' ? `<div class="small" style="margin-top:6px">${p.duplicateOf?.length ? `Looks like ${p.duplicateOf.map((d) => `<strong>${esc(d.artist)}, ${esc(d.title)}</strong>${d.stock ? ` (${esc(d.stock)})` : ''}`).join(' or ')} already in your catalog.` : `Same artist and title as row ${p.duplicateInFile} in this file.`}
<label class="sr" for="dec-${p.row}">Decision for row ${p.row}</label><select id="dec-${p.row}" data-dec="${p.row}" style="width:auto;margin-left:6px"><option value="">Choose…</option>${(p.duplicateOf || []).map((d) => `<option value="merge:${d.id}"${p.decision === `merge:${d.id}` ? ' selected' : ''}>Same work: update ${esc(d.stock || d.title)}</option>`).join('')}<option value="create"${p.decision === 'create' ? ' selected' : ''}>Different work: add it</option><option value="skip"${p.decision === 'skip' ? ' selected' : ''}>Skip this row</option></select></div>` : ''}
${p.changes.map((c) => `<div class="change">${esc(c.label)}: <del>${esc(fmt(c.from))}</del> → <ins>${esc(fmt(c.to))}</ins>${c.kind !== 'update' ? ` <span class="pill ${c.kind === 'blocked' ? 'bad' : 'warn'}">${c.kind === 'blocked' ? 'Kept as sold' : 'Conflict'}</span> <span class="muted">${esc(c.message)}</span>
<label class="sr" for="fc-${p.row}-${c.field}">Choice for ${esc(c.label)}</label><select id="fc-${p.row}-${c.field}" data-field="${p.row}|${c.field}" style="width:auto;min-height:28px;padding:2px 6px"><option value="keep"${c.choice === 'keep' ? ' selected' : ''}>Keep current</option><option value="take"${c.choice === 'take' ? ' selected' : ''}>Use the file's value</option></select>` : ''}</div>`).join('')}
</div></li>`).join('') + (rows.length > 400 ? `<li class="muted">${rows.length - 400} more rows not shown.</li>` : '');
}

// ---------------------------------------------------------------- publish
async function publish() {
  setTitle('Publish');
  const [cands, recon] = await Promise.all([api('/artsy/candidates'), api('/artsy/reconciliation')]);
  const last = STATE.lastBuild;
  const ready = cands.filter((c) => !c.problems.length);
  view.innerHTML = `<h1>Publish</h1><p class="sub">Only works you publish, and only their public fields, leave this workspace. Private fields are never written to any public file.</p>
<div class="card"><h2>Public catalog website</h2>
<p>${STATE.stats.public} published work${STATE.stats.public === 1 ? '' : 's'}. Building creates a folder of plain web pages, images, a printable catalog per exhibition, and an open <code>catalog.json</code> feed.</p>
<div class="row"><button class="primary" id="build">Build the public catalog</button>${last ? `<a class="btn" href="/site/index.html" target="_blank" rel="noopener">Preview the last build</a>` : ''}</div>
<div id="build-out" aria-live="polite">${last ? `<p class="small muted">Last built ${esc(when(last.builtAt))} into <code>${esc(last.outDir)}</code>.</p>` : ''}</div>
<details style="margin-top:10px"><summary>How to put it online</summary><div class="small">
<p>The build is a folder on this computer. It is not online yet. To publish it, upload that folder to any static host. Options:</p>
<ul><li><strong>Your existing website host</strong>: upload it to a sub-folder such as <code>/catalog</code>. Usually no extra cost.</li>
<li><strong>A free static host</strong> such as Cloudflare Pages, Netlify or GitHub Pages. Free tiers exist; a custom domain costs roughly $10–20 a year from a registrar.</li>
<li><strong>Keep it local</strong> and use the printable catalog only.</li></ul>
<p>The public site keeps working when this computer is off. It shows availability as of the last build, and says so on every work.</p></div></details></div>

<div class="card" style="margin-top:16px"><h2>Artsy</h2>
<p class="small">Open Gallery is <strong>not connected</strong> to Artsy and has no access to your account. It can prepare a spreadsheet for Artsy's bulk import (up to 100 works per file), which you upload yourself in Artsy CMS.</p>
<h3>New listings</h3><p class="small muted">${ready.length} work${ready.length === 1 ? '' : 's'} ready. Works already on Artsy, sold works, editions, and works without price, year or image are left out.</p>
<details><summary>Choose works (${ready.length} ready, ${cands.length - ready.length} not eligible)</summary>
<ul class="list small" style="max-height:340px;overflow:auto">${cands.map((c) => `<li><label class="check" style="font-size:13px"><input type="checkbox" class="artsy-sel" value="${c.id}" ${c.problems.length ? 'disabled' : ''}> ${esc(c.artist)}, <i>${esc(c.title)}</i></label><span class="grow"></span><span class="muted">${esc(c.problems.join('; '))}</span></li>`).join('')}</ul>
<div class="row" style="margin-top:8px"><button class="small" id="artsy-all">Select all ready</button><button class="primary" id="artsy-go" disabled>Download upload file</button></div></details>
<h3>Existing listings</h3><p class="small">${recon.length} work${recon.length === 1 ? ' has' : 's have'} an Artsy link. Without API access, Open Gallery cannot see what Artsy currently shows, so it gives you a checklist to compare price and availability by hand.</p>
${recon.length ? '<a class="btn small" href="/api/artsy/reconciliation.csv">Download the checklist (CSV)</a>' : ''}</div>

<div class="card" style="margin-top:16px"><h2>Artnet</h2><p class="small">Not connected. Artnet listing links are kept on each work and shown on its public page. Open Gallery does not yet produce an Artnet upload file, because no public upload format was verified.</p></div>`;
  $('#build').onclick = async () => {
    const out = $('#build-out');
    $('#build').disabled = true;
    try {
      const need = await api('/publish/needs-web');
      if (need.length) {
        out.innerHTML = `<p class="small">Making web-sized copies of ${need.length} image${need.length === 1 ? '' : 's'} (this also removes camera metadata)…</p><div class="progress"><div></div></div>`;
        for (let i = 0; i < need.length; i++) {
          try { await makeWebCopy(need[i]); } catch (e) { console.warn('web copy failed', e); }
          $('.progress>div', out).style.width = `${((i + 1) / need.length) * 100}%`;
        }
      }
      const r = await api('/publish', { method: 'POST' });
      out.innerHTML = `<p class="notice ok">Built ${r.works} work pages, ${r.exhibitions} exhibition${r.exhibitions === 1 ? '' : 's'} and ${r.images} image${r.images === 1 ? '' : 's'}${r.withdrawn ? `; ${r.withdrawn} withdrawn work${r.withdrawn === 1 ? '' : 's'} listed in the feed` : ''}. Folder: <code>${esc(r.outDir)}</code></p>
${r.warnings.map((w) => `<p class="notice warn small">${esc(w.message)}</p>`).join('')}<a class="btn" href="/site/index.html" target="_blank" rel="noopener">Open the preview</a>`;
      refreshState();
    } catch (e) { fail(e); }
    $('#build').disabled = false;
  };
  const sel = () => { const n = $$('.artsy-sel:checked').length; $('#artsy-go').disabled = !n; $('#artsy-go').textContent = n ? `Download upload file (${n})` : 'Download upload file'; };
  $$('.artsy-sel').forEach((c) => { c.onchange = sel; });
  $('#artsy-all').onclick = () => { $$('.artsy-sel:not(:disabled)').forEach((c) => { c.checked = true; }); sel(); };
  $('#artsy-go').onclick = async () => {
    try {
      const res = await api('/artsy/package', { method: 'POST', body: { ids: $$('.artsy-sel:checked').map((c) => c.value) } });
      const rep = JSON.parse(decodeURIComponent(res.headers.get('x-report') || '%7B%7D'));
      downloadBlob(await res.blob(), res.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] || 'artsy.zip');
      toast(`Prepared ${rep.included} works in ${rep.batches} file${rep.batches === 1 ? '' : 's'}. Nothing was sent to Artsy.`);
    } catch (e) { fail(e); }
  };
}

async function makeWebCopy(m) {
  const img = await createImageBitmap(await (await fetch(m.url)).blob());
  const max = 1600;
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const blob = await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.86));
  await api(`/media/${m.id}/web`, { method: 'PUT', raw: blob });
}

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// ---------------------------------------------------------------- settings
async function settingsView() {
  setTitle('Look & settings');
  const s = STATE.settings;
  const css = (await api('/custom-css')).css;
  const fonts = Object.entries(STATE.fonts);
  view.innerHTML = `<h1>Look &amp; settings</h1><p class="sub">These choices are stored in your workspace, not in the app, so updating Open Gallery keeps them.</p>
<form id="settings-form"><div class="layout2"><div>
<fieldset><legend>Gallery</legend><div class="formgrid">
${inputRow('gallery.name', 'Gallery name', s.gallery.name)}${inputRow('gallery.email', 'Inquiry email', s.gallery.email, { type: 'email', help: 'Used for "Email the gallery" buttons. It opens a draft in the visitor\'s email app.' })}
${inputRow('gallery.phone', 'Phone', s.gallery.phone)}${inputRow('gallery.website', 'Main website', s.gallery.website, { type: 'url' })}
${inputRow('gallery.address', 'Address', s.gallery.address, { wide: true })}${inputRow('gallery.tagline', 'Short introduction', s.gallery.tagline, { type: 'textarea', wide: true })}
</div></fieldset>
<fieldset><legend>Look</legend><div class="formgrid">
${selectRow('theme.headingFont', 'Heading type', s.theme.headingFont, fonts)}${selectRow('theme.bodyFont', 'Body type', s.theme.bodyFont, fonts)}
${selectRow('theme.layout', 'Default layout', s.theme.layout, [['grid', 'Grid'], ['list', 'List'], ['salon', 'Salon']])}${selectRow('theme.density', 'Spacing', s.theme.density, [['airy', 'Airy'], ['compact', 'Compact']])}
${selectRow('theme.imageFit', 'Thumbnails', s.theme.imageFit, [['contain', 'Show whole work'], ['cover', 'Crop to fill']])}${inputRow('theme.corner', 'Image corners (px)', s.theme.corner, { type: 'number', attrs: 'min="0" max="24" step="1"' })}
${[['colorBackground', 'Background'], ['colorText', 'Text'], ['colorMuted', 'Secondary text'], ['colorAccent', 'Accent'], ['colorLine', 'Lines']].map(([k, l]) => inputRow(`theme.${k}`, l, s.theme[k], { type: 'color' })).join('')}
${inputRow('theme.footer', 'Footer note', s.theme.footer, { wide: true })}
</div>
<div class="field"><label for="logo-in">Logo (optional)</label><input id="logo-in" type="file" accept="image/png,image/jpeg,image/webp">${s.theme.logoMediaId ? '<button type="button" class="small link" id="logo-rm">Remove logo</button>' : ''}</div>
<p id="contrast" class="small" aria-live="polite"></p></fieldset>
<fieldset><legend>Catalog</legend><div class="formgrid">
${inputRow('catalog.currency', 'Default currency', s.catalog.currency, { attrs: 'maxlength="3"' })}${selectRow('catalog.units', 'Default unit', s.catalog.units, [['in', 'Inches'], ['cm', 'Centimetres']])}
${selectRow('catalog.showPrices', 'Public prices', s.catalog.showPrices, [['per-work', 'Per work (as set on each work)'], ['never', 'Never show prices']])}${selectRow('catalog.inquiryMode', 'Inquiries', s.catalog.inquiryMode, [['email', 'Email the gallery'], ['links-only', 'Listing links only']])}
${inputRow('catalog.publicBaseUrl', 'Public address of the catalog', s.catalog.publicBaseUrl, { type: 'url', wide: true, help: 'Where you will upload the public site, e.g. https://example.com/catalog. Used for links in the open feed.' })}
${inputRow('catalog.rightsStatement', 'Image rights statement', s.catalog.rightsStatement, { type: 'textarea', wide: true })}
<label class="check wide"><input type="checkbox" name="catalog.showStockNumbers" ${s.catalog.showStockNumbers ? 'checked' : ''}> Show inventory numbers publicly</label>
<label class="check wide" style="margin:8px 0 12px"><input type="checkbox" name="privacy.publicByDefault" ${s.privacy.publicByDefault ? 'checked' : ''}> Publish newly imported works automatically (off is safer)</label>
</div></fieldset>
<div class="row"><button class="primary" type="submit">Save settings</button><span class="small muted">Build the public catalog again to see changes online.</span></div>
</div><aside class="sticky"><div class="card"><h3>Preview</h3><div class="swatch-preview" id="swatch"></div></div></aside></div></form>
<h2>Your own fields</h2><p class="sub">Add fields your gallery tracks, like "Crate number" or "Series". Choose whether each one can be published.</p>
<ul class="list">${STATE.customFields.map((f) => `<li><span class="grow">${esc(f.label)} <span class="muted small">${f.type}</span></span><span class="pill ${f.visibility === 'public' ? 'public' : ''}">${f.visibility === 'public' ? 'Can be published' : 'Private'}</span></li>`).join('') || '<li class="muted">None yet.</li>'}</ul>
<form id="cf-form" class="row" style="margin-top:10px"><div style="flex:2;min-width:180px"><label for="cf-label">Field name</label><input id="cf-label" name="label" required></div>
<div style="flex:1;min-width:120px"><label for="cf-type">Type</label><select id="cf-type" name="type"><option value="text">Short text</option><option value="longtext">Long text</option><option value="number">Number</option><option value="date">Date</option></select></div>
<div style="flex:1;min-width:150px"><label for="cf-vis">Visibility</label><select id="cf-vis" name="visibility"><option value="private">Private</option><option value="public">Can be published</option></select></div>
<button style="align-self:flex-end">Add field</button></form>
<h2>Advanced: custom CSS</h2><p class="sub">For anything the options above do not cover. Saved in your workspace's <code>custom/site.css</code> and kept across updates. You can ask an assistant to write it for you.</p>
<form id="css-form"><label for="css" class="sr">Custom CSS</label><textarea id="css" style="font:13px ui-monospace,Menlo,monospace;min-height:140px">${esc(css)}</textarea><div class="row" style="margin-top:8px"><button>Save CSS</button></div></form>`;
  const form = $('#settings-form');
  const fontCss = { 'classic-serif': "'Iowan Old Style',Palatino,Georgia,serif", 'modern-serif': 'Charter,Cambria,serif', 'neo-grotesque': "'Helvetica Neue',Helvetica,Arial,sans-serif", humanist: 'Seravek,Calibri,sans-serif', system: 'system-ui,sans-serif', mono: 'ui-monospace,Menlo,monospace' };
  const preview = () => {
    const v = (k) => form.elements[k].value;
    const sw = $('#swatch');
    sw.style.background = v('theme.colorBackground'); sw.style.color = v('theme.colorText');
    sw.innerHTML = `<div style="font:500 22px/1.2 ${fontCss[v('theme.headingFont')]}">${esc(v('gallery.name'))}</div><div style="height:90px;margin:12px 0;border-radius:${v('theme.corner')}px;background:${v('theme.colorLine')}"></div>
<div style="font:15px/1.4 ${fontCss[v('theme.bodyFont')]}">Artist Name<br><i>Title of the work</i>, 2024<br><span style="color:${v('theme.colorMuted')}">Oil on canvas</span><br><span style="color:${v('theme.colorAccent')};text-decoration:underline">Email the gallery</span></div>`;
    const ratio = contrast(v('theme.colorText'), v('theme.colorBackground'));
    const ratio2 = contrast(v('theme.colorMuted'), v('theme.colorBackground'));
    $('#contrast').innerHTML = `Text contrast ${ratio.toFixed(1)}:1${ratio < 4.5 ? ' <strong style="color:var(--bad)">too low to read comfortably (aim for 4.5:1)</strong>' : ''} · Secondary text ${ratio2.toFixed(1)}:1${ratio2 < 4.5 ? ' <strong style="color:var(--warn)">below 4.5:1</strong>' : ''}`;
  };
  form.addEventListener('input', preview); preview();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const patch = {};
    for (const el of form.elements) {
      if (!el.name || !el.name.includes('.')) continue;
      patch[el.name] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
    }
    patch['catalog.currency'] = String(patch['catalog.currency']).toUpperCase();
    try { await api('/settings', { method: 'PATCH', body: patch }); toast('Settings saved'); refreshState(); }
    catch (err) { fail(err.errors ? new Error(`Check: ${Object.keys(err.errors).join(', ')}`) : err); }
  };
  $('#logo-in').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { const { media } = await api(`/media?name=${encodeURIComponent(f.name)}`, { method: 'POST', raw: f }); await api('/settings', { method: 'PATCH', body: { 'theme.logoMediaId': media.id } }); toast('Logo saved'); } catch (err) { fail(err); }
  };
  if ($('#logo-rm')) $('#logo-rm').onclick = async () => { await api('/settings', { method: 'PATCH', body: { 'theme.logoMediaId': '' } }); toast('Logo removed'); settingsView(); };
  $('#cf-form').onsubmit = async (e) => { e.preventDefault(); try { await api('/custom-fields', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); toast('Field added'); settingsView(); } catch (err) { fail(err); } };
  $('#css-form').onsubmit = async (e) => { e.preventDefault(); try { await api('/custom-css', { method: 'PUT', body: { css: $('#css').value } }); toast('CSS saved'); } catch (err) { fail(err); } };
}

function contrast(a, b) {
  const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

// ---------------------------------------------------------------- backup
async function backup() {
  setTitle('Backup');
  view.innerHTML = `<h1>Backup</h1><p class="sub">Your whole gallery workspace can leave with you at any time, in formats that open without Open Gallery.</p>
<div class="grid2"><div class="card"><h2>Export everything</h2><p>One .zip file with every original image, every record and relationship, your settings and custom styles, the spreadsheets you imported, and spreadsheet copies of your catalog. Each file has a checksum.</p>
<p class="small muted">The export includes private fields. Keep it somewhere safe, like an external drive or a private cloud folder.</p>
<a class="btn primary" href="/api/export" download>Download export</a></div>
<div class="card"><h2>Check this workspace</h2><p>Confirms every image file is present and undamaged and every relationship is intact.</p><button id="verify">Run check</button><div id="verify-out" aria-live="polite"></div></div>
<div class="card"><h2>Restore</h2>${STATE.empty ? `<p>This workspace is empty, so you can restore an export into it.</p><div class="drop" id="restore-drop"><label for="restore-in" style="margin:0;color:inherit;cursor:pointer">Drop an export .zip or <u>choose a file</u></label><input id="restore-in" type="file" accept=".zip" class="sr"></div><div id="restore-out" aria-live="polite"></div>`
    : `<p>Restore only runs into an <strong>empty</strong> workspace, so it can never overwrite your current catalog. To restore, start Open Gallery with a new folder:</p><pre class="small" style="white-space:pre-wrap">open-gallery start --data "~/Open Gallery Restored"</pre><p class="small muted">or ask your assistant to "restore my Open Gallery export into a new workspace".</p>`}</div></div>
<p class="small muted" style="margin-top:20px">Workspace folder: <code>${esc(STATE.dataDir)}</code>. Copying this folder while the app is stopped is also a complete backup.</p>`;
  $('#verify').onclick = async () => {
    const r = await api('/verify');
    $('#verify-out').innerHTML = r.ok ? `<p class="notice ok">All ${r.images} images and all relationships check out. Workspace size ${(r.bytes / 1e6).toFixed(1)} MB.</p>` : `<p class="notice bad">${r.problems.map(esc).join('<br>')}</p>`;
  };
  const restore = async (file) => {
    $('#restore-out').innerHTML = '<p class="small">Checking every file and restoring…</p>';
    try { const r = await api('/restore', { method: 'POST', raw: file }); $('#restore-out').innerHTML = r.ok ? `<p class="notice ok">Restored ${r.counts.artworks} works and ${r.counts.media} images. Every checksum matched.</p>` : `<p class="notice bad">Restored with problems: ${esc([...r.verify.problems, ...r.mismatched.map((m) => m.join(': '))].join('; '))}</p>`; refreshState(); }
    catch (e) { $('#restore-out').innerHTML = `<p class="notice bad">${esc(e.message)}</p>`; }
  };
  if ($('#restore-in')) { $('#restore-in').onchange = (e) => restore(e.target.files[0]); dropZone($('#restore-drop'), (f) => restore(f[0])); }
}

route();
