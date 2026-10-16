// Spreadsheet import: upload a copy, map columns, preview every change, then apply.
// Rules that protect the gallery:
//  * the original file is kept, byte for byte, inside the workspace
//  * columns we do not understand are kept as extra fields, never dropped
//  * a staff edit is never overwritten silently; if the sheet also changed, it is a conflict
//  * a sold work is never made available again by an import unless a person says so
//  * possible duplicates must be decided by a person before anything is applied
//  * works missing from a later file are flagged, never deleted
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { newId, now, audit, J, tx } from './db.mjs';
import { readTable } from './tables.mjs';
import { FIELD, FIELDS, suggestTarget, headerUnit, headerCurrency } from './fields.mjs';
import { clean, parsePrice, parseAvailability, parseDims, parseNumber, normKey, isHttpUrl, slugify } from './normalize.mjs';
import { getSettings } from './settings.mjs';
import { createArtwork, updateArtwork, getArtwork, storeMedia, httpError, findOrCreateArtist } from './store.mjs';

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function uploadImport(db, dataDir, filename, buf) {
  const name = basename(String(filename || 'inventory.csv')).replace(/[^\w.\- ()]+/g, '_').slice(0, 120);
  const rows = readTable(name, buf);
  if (rows.length < 2) throw httpError(400, 'This file has a header row but no artwork rows.');
  const headers = rows[0].map((h, i) => clean(h) || `Column ${i + 1}`);
  const id = newId('im');
  const dir = join(dataDir, 'imports', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), buf);
  const sha = createHash('sha256').update(buf).digest('hex');
  const mapping = suggestMapping(db, headers);
  db.prepare('INSERT INTO imports(id,created_at,filename,sha256,stored_as,headers,mapping,status) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, now(), name, sha, `imports/${id}/${name}`, JSON.stringify(headers), JSON.stringify(mapping), 'uploaded');
  const previous = db.prepare("SELECT id, created_at FROM imports WHERE sha256=? AND status='applied' AND id<>? ORDER BY created_at DESC").get(sha, id);
  audit(db, 'import.upload', 'import', id, { filename: name, rows: rows.length - 1 });
  return { id, filename: name, headers, mapping, rowCount: rows.length - 1, sample: rows.slice(1, 6), sameFileAppliedBefore: previous || null };
}

function suggestMapping(db, headers) {
  // Reuse the choices a person made on the last applied import with the same header.
  const last = db.prepare("SELECT headers, mapping FROM imports WHERE status='applied' ORDER BY applied_at DESC LIMIT 1").get();
  const remembered = {};
  if (last) {
    const h = J(last.headers, []);
    const m = J(last.mapping, []);
    h.forEach((name, i) => { if (m[i]) remembered[name] = m[i]; });
  }
  const used = new Set();
  return headers.map((h) => {
    let t = remembered[h] || suggestTarget(h);
    if (t !== 'keep' && t !== 'ignore' && !t.startsWith('custom:') && used.has(t)) t = 'keep';
    used.add(t);
    return t;
  });
}

function loadRows(db, dataDir, imp) {
  const buf = readFileSync(join(dataDir, imp.stored_as));
  return readTable(imp.filename, buf);
}

export function validTargets() {
  return FIELDS.map((f) => ({ key: f.key, label: f.label, visibility: f.visibility, required: !!f.required }));
}

/** Convert one spreadsheet row into a patch plus the per-field "imported values" used for conflict checks. */
function normalizeRow(row, headers, mapping, settings) {
  const patch = { private: {}, custom: {}, extra: {}, links: [] };
  const imported = {};
  const issues = [];
  const work = {}; const framed = {};
  let unitHint = null;
  let workText = null; let framedText = null;
  headers.forEach((h, i) => {
    const target = mapping[i];
    const raw = clean(row[i]);
    if (!target || target === 'ignore') return;
    if (target === 'keep') { if (raw) patch.extra[h] = raw; return; }
    if (target.startsWith('custom:')) { const k = target.slice(7); patch.custom[k] = raw || null; imported[`custom.${k}`] = raw || null; return; }
    const f = FIELD[target];
    if (!f) return;
    if (f.dim === 'work.h' || f.dim === 'work.w' || f.dim === 'work.d') {
      const n = parseNumber(raw);
      if (n.issue) issues.push({ level: 'warn', field: f.key, message: `${h}: ${n.issue}` });
      if (n.value != null) { work[f.dim.slice(5)] = n.value; unitHint = headerUnit(h) || unitHint; }
      return;
    }
    if (f.key === 'dimensions') { workText = raw ? { raw, unit: headerUnit(h) } : null; return; }
    if (f.key === 'framed_dimensions') { framedText = raw ? { raw, unit: headerUnit(h) } : null; return; }
    if (f.key === 'price') {
      const p = parsePrice(raw, settings.catalog.currency);
      if (p.issue) issues.push({ level: 'warn', field: 'price', message: p.issue });
      patch.price = p.amount; imported.price = p.amount;
      if (p.rangeMax) patch.price_max = p.rangeMax;
      if (p.onRequest) patch._onRequest = true;
      if (p.currency) patch._currency = p.currency;
      else if (headerCurrency(h)) patch._currency = headerCurrency(h);
      return;
    }
    if (f.key === 'availability') {
      const a = parseAvailability(raw);
      if (a.issue) issues.push({ level: 'warn', field: 'availability', message: a.issue });
      if (a.value) { patch.availability = a.value; imported.availability = a.value; }
      return;
    }
    if (f.type === 'url') {
      if (raw && !isHttpUrl(raw)) { issues.push({ level: 'warn', field: f.key, message: `${h}: "${raw}" is not a web address; kept as an extra field` }); patch.extra[h] = raw; return; }
      if (raw) { patch.links.push({ channel: f.channel, url: raw }); }
      return;
    }
    if (f.visibility === 'private') {
      let v = raw || null;
      if (v && f.type === 'number') { const n = parseNumber(v); v = n.value ?? v; }
      patch.private[f.key] = v; imported[`private.${f.key}`] = v;
      return;
    }
    if (f.key === 'artist') { patch.artist = raw; imported.artist = raw; return; }
    patch[f.key] = raw || null; imported[f.key] = raw || null;
  });
  // Dimensions: numeric columns win; free text fills in when they are blank.
  const defUnit = settings.catalog.units;
  const dims = [];
  if (Object.keys(work).length) dims.push({ kind: 'work', ...work, unit: unitHint || defUnit });
  else if (workText) {
    const d = parseDims(workText.raw, workText.unit);
    if (d.issue) issues.push({ level: 'warn', field: 'dimensions', message: d.issue });
    const { issue, ...rest } = d;
    dims.push({ kind: 'work', ...rest, unit: rest.unit || defUnit });
  }
  if (framedText) {
    const d = parseDims(framedText.raw, framedText.unit || unitHint);
    if (d.issue && !/assumed/.test(d.issue)) issues.push({ level: 'warn', field: 'framed_dimensions', message: d.issue });
    const { issue, ...rest } = d;
    dims.push({ kind: 'framed', ...rest, unit: rest.unit || unitHint || defUnit });
  }
  const mapsDims = mapping.some((t) => ['height', 'width', 'depth', 'dimensions'].includes(t));
  const mapsFramed = mapping.includes('framed_dimensions');
  if (mapsDims || mapsFramed) {
    patch.dims = dims;
    if (mapsDims) imported['dims.work'] = dims.find((d) => d.kind === 'work') || null;
    if (mapsFramed) imported['dims.framed'] = dims.find((d) => d.kind === 'framed') || null;
  }
  if (patch._currency) { patch.currency = patch._currency; imported.currency = patch._currency; }
  if (!clean(patch.artist)) issues.push({ level: 'error', field: 'artist', message: 'Missing artist' });
  if (!clean(patch.title)) issues.push({ level: 'error', field: 'title', message: 'Missing title' });
  return { patch, imported, issues };
}

function currentValue(aw, key) {
  if (key === 'artist') return aw.artist || null;
  if (key.startsWith('private.')) return aw.private[key.slice(8)] ?? null;
  if (key.startsWith('custom.')) return aw.custom[key.slice(7)] ?? null;
  if (key.startsWith('dims.')) return aw.dims.find((d) => d.kind === key.slice(5)) || null;
  return aw[key] ?? null;
}

function labelFor(key) {
  if (key.startsWith('private.')) return FIELD[key.slice(8)]?.label || key;
  if (key.startsWith('custom.')) return key.slice(7).replace(/_/g, ' ');
  if (key === 'dims.work') return 'Dimensions';
  if (key === 'dims.framed') return 'Framed dimensions';
  return FIELD[key]?.label || key;
}

function looseEqual(key, a, b) {
  if (same(a, b)) return true;
  if (key.startsWith('dims.')) {
    const strip = (d) => d && { h: d.h, w: d.w, d: d.d, diameter: d.diameter, unit: d.unit };
    return same(strip(a), strip(b));
  }
  if (typeof a === 'number' || typeof b === 'number') return a != null && b != null && Number(a) === Number(b);
  if (typeof a === 'string' && typeof b === 'string') return clean(a) === clean(b);
  return false;
}

/** Build the full change plan. Pure read: nothing is written except the chosen mapping. */
export function previewImport(db, dataDir, importId, { mapping, decisions = {} } = {}) {
  const imp = db.prepare('SELECT * FROM imports WHERE id=?').get(importId);
  if (!imp) throw httpError(404, 'Import not found');
  const headers = J(imp.headers, []);
  if (mapping) {
    if (!Array.isArray(mapping) || mapping.length !== headers.length) throw httpError(400, 'Mapping must have one entry per column');
    const seen = new Set();
    for (const t of mapping) {
      if (!(t === 'keep' || t === 'ignore' || /^custom:[a-z0-9_]{1,40}$/.test(t) || FIELD[t])) throw httpError(400, `Unknown target ${t}`);
      if (FIELD[t] && seen.has(t)) throw httpError(400, `Two columns are mapped to ${FIELD[t].label}. Choose one.`);
      seen.add(t);
    }
    if (imp.status !== 'applied') db.prepare('UPDATE imports SET mapping=? WHERE id=?').run(JSON.stringify(mapping), importId);
  } else mapping = J(imp.mapping, []);
  const settings = getSettings(db);
  const rows = loadRows(db, dataDir, imp).slice(1);
  const hasStock = mapping.includes('stock_number');
  const mappedFields = new Set(mapping);
  const missingRequired = FIELDS.filter((f) => f.required && !mappedFields.has(f.key)).map((f) => f.label);

  const byKey = new Map();
  for (const r of db.prepare('SELECT w.id, w.stock_number, w.title, w.year, a.name AS artist FROM artworks w LEFT JOIN artists a ON a.id=w.artist_id').all()) {
    const k = `${normKey(r.artist)}|${normKey(r.title)}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  const seenStock = new Map();
  const seenKey = new Map();
  const plan = [];
  const fileStocks = new Set();

  rows.forEach((row, idx) => {
    const rowNumber = idx + 2; // spreadsheet row, header is row 1
    const { patch, imported, issues } = normalizeRow(row, headers, mapping, settings);
    const stock = clean(patch.stock_number) || null;
    const entry = { row: rowNumber, stock, artist: clean(patch.artist), title: clean(patch.title), year: clean(patch.year), issues, changes: [], action: 'create', artwork_id: null };
    if (stock) {
      if (seenStock.has(stock.toLowerCase())) {
        issues.push({ level: 'error', field: 'stock_number', message: `Inventory number ${stock} also appears on row ${seenStock.get(stock.toLowerCase())}` });
      } else seenStock.set(stock.toLowerCase(), rowNumber);
      fileStocks.add(stock.toLowerCase());
    }
    if (issues.some((i) => i.level === 'error')) { entry.action = 'error'; plan.push(entry); return; }
    const key = `${normKey(patch.artist)}|${normKey(patch.title)}`;
    let existing = stock ? db.prepare('SELECT id FROM artworks WHERE stock_number = ? COLLATE NOCASE').get(stock) : null;
    if (!existing) {
      const candidates = (byKey.get(key) || []).filter((c) => !entry.year || !c.year || normKey(c.year) === normKey(entry.year));
      const inFile = seenKey.get(key);
      if (candidates.length || inFile) {
        entry.action = 'review';
        entry.duplicateOf = candidates.map((c) => ({ id: c.id, stock: c.stock_number, title: c.title, artist: c.artist, year: c.year }));
        if (inFile) entry.duplicateInFile = inFile;
        entry.decision = decisions[rowNumber]?.match || null; // 'create' | 'skip' | 'merge:<id>'
        if (entry.decision?.startsWith('merge:')) {
          existing = { id: entry.decision.slice(6) };
          // Same work under another number: keep the catalog's number, remember the other one.
          if (imported.stock_number) { patch.extra['Other inventory number'] = imported.stock_number; delete imported.stock_number; }
        }
      }
    }
    seenKey.set(key, rowNumber);
    if (!existing) {
      if (entry.action !== 'review' || entry.decision === 'create') {
        entry.patch = patch; entry.imported = imported;
        if (entry.action !== 'review') entry.action = 'create';
      }
      plan.push(entry);
      return;
    }
    const aw = getArtwork(db, existing.id);
    if (!aw) { entry.action = 'error'; issues.push({ level: 'error', message: 'Chosen match no longer exists' }); plan.push(entry); return; }
    entry.artwork_id = aw.id;
    if (entry.action !== 'review') entry.action = 'update';
    const apply = {};
    const applyImported = {};
    for (const [k, v] of Object.entries(imported)) {
      const cur = currentValue(aw, k);
      const o = aw.origin[k] || {};
      if (looseEqual(k, v, cur)) { applyImported[k] = v; continue; }
      const choice = decisions[rowNumber]?.fields?.[k];
      if (k === 'availability' && cur === 'sold' && v !== 'sold') {
        entry.changes.push({ field: k, label: labelFor(k), from: cur, to: v, kind: 'blocked',
          message: `Your catalog says this work is sold. The file says ${v.replace('_', ' ')}. It stays sold unless you choose otherwise.`, choice: choice || 'keep' });
        if (choice === 'take') { apply[k] = v; applyImported[k] = v; }
        continue;
      }
      if (o.by === 'staff') {
        if (looseEqual(k, v, o.imported)) continue; // sheet unchanged since the last import; your edit stands
        entry.changes.push({ field: k, label: labelFor(k), from: cur, to: v, kind: 'conflict',
          message: 'Edited here since the last import, and the file changed too.', choice: choice || 'keep' });
        if (choice === 'take') apply[k] = v;
        applyImported[k] = v; // either way, remember what the sheet said so the same sheet won't ask again
        continue;
      }
      entry.changes.push({ field: k, label: labelFor(k), from: k.startsWith('private.') ? '(private)' : cur, to: k.startsWith('private.') ? '(private)' : v, kind: 'update' });
      apply[k] = v; applyImported[k] = v;
    }
    // Links are added, never removed by an import.
    for (const l of patch.links) {
      if (!aw.links.some((x) => x.channel === l.channel && x.url === l.url)) {
        entry.changes.push({ field: `links.${l.channel}`, label: `${l.channel} link`, from: null, to: l.url, kind: 'update' });
        apply.links = apply.links || [];
        apply.links.push(l);
      }
    }
    const extraChanged = Object.entries(patch.extra).filter(([k, v]) => aw.extra[k] !== v);
    if (extraChanged.length) { entry.changes.push({ field: 'extra', label: 'Other columns', from: null, to: `${extraChanged.length} value(s)`, kind: 'update' }); apply.extra = Object.fromEntries(extraChanged); }
    if (entry.action === 'update' && !entry.changes.length) entry.action = 'unchanged';
    entry.apply = apply; entry.applyImported = applyImported;
    if (entry.action === 'review' && entry.decision?.startsWith('merge:') && !entry.changes.length) entry.mergeNoop = true;
    plan.push(entry);
  });

  const notInFile = hasStock ? db.prepare(`SELECT w.id, w.stock_number, w.title, a.name AS artist, w.availability FROM artworks w LEFT JOIN artists a ON a.id=w.artist_id
    WHERE w.stock_number IS NOT NULL ORDER BY w.stock_number`).all().filter((w) => !fileStocks.has(w.stock_number.toLowerCase())) : [];

  const count = (a) => plan.filter((p) => p.action === a).length;
  const summary = {
    rows: plan.length,
    create: count('create'), update: count('update'), unchanged: count('unchanged'), review: count('review'), error: count('error'),
    undecided: plan.filter((p) => p.action === 'review' && !p.decision).length,
    conflicts: plan.reduce((n, p) => n + p.changes.filter((c) => c.kind === 'conflict').length, 0),
    blocked: plan.reduce((n, p) => n + p.changes.filter((c) => c.kind === 'blocked').length, 0),
    warnings: plan.reduce((n, p) => n + p.issues.filter((i) => i.level === 'warn').length, 0),
    notInFile: notInFile.length,
    extraColumns: headers.filter((_, i) => mapping[i] === 'keep'),
    missingRequired,
  };
  return { id: importId, filename: imp.filename, status: imp.status, headers, mapping, summary, plan, notInFile, targets: validTargets() };
}

export function applyImport(db, dataDir, importId, { decisions = {} } = {}) {
  const imp = db.prepare('SELECT * FROM imports WHERE id=?').get(importId);
  if (!imp) throw httpError(404, 'Import not found');
  if (imp.status === 'applied') throw httpError(409, 'This import was already applied. Upload the file again to re-check it.');
  const preview = previewImport(db, dataDir, importId, { decisions });
  if (preview.summary.missingRequired.length) throw httpError(400, `Map a column to: ${preview.summary.missingRequired.join(', ')}`);
  if (preview.summary.undecided) throw httpError(409, `${preview.summary.undecided} possible duplicate(s) need a decision first`, { undecided: preview.plan.filter((p) => p.action === 'review' && !p.decision).map((p) => p.row) });
  const settings = getSettings(db);
  const by = { by: 'import', batch: importId };
  const result = tx(db, () => {
    let created = 0, updated = 0, skipped = 0;
    for (const p of preview.plan) {
      if (p.action === 'error' || p.action === 'unchanged' || (p.action === 'review' && p.decision === 'skip')) {
        if (p.action === 'unchanged' && p.artwork_id) {
          // Remember the sheet's values so the next import can tell sheet edits from staff edits.
          refreshImported(db, p.artwork_id, p.applyImported, importId);
        }
        if (p.action !== 'unchanged') skipped++;
        continue;
      }
      if (p.patch && !p.artwork_id) {
        const { _onRequest, _currency, ...patch } = p.patch;
        if (!patch.currency) patch.currency = settings.catalog.currency;
        patch.price_visibility = _onRequest || patch.price == null ? 'on_request' : 'show';
        patch.public = settings.privacy.publicByDefault;
        const aw = createArtwork(db, { artist: patch.artist, title: patch.title, public: patch.public, price_visibility: patch.price_visibility }, 'import');
        delete patch.artist; delete patch.title; delete patch.public; delete patch.price_visibility;
        updateArtwork(db, aw.id, patch, { ...by, imported: p.imported });
        refreshImported(db, aw.id, { ...p.imported, artist: p.imported.artist, title: p.imported.title }, importId);
        created++;
        continue;
      }
      if (p.artwork_id) {
        const patch = toPatch(p.apply, getArtwork(db, p.artwork_id));
        if (Object.keys(patch).length) updateArtwork(db, p.artwork_id, patch, { ...by, imported: p.applyImported });
        refreshImported(db, p.artwork_id, p.applyImported, importId);
        updated++;
      }
    }
    // Flag (never delete) works that were absent from this file.
    db.prepare('UPDATE artworks SET missing_from_last_import=0').run();
    for (const w of preview.notInFile) db.prepare('UPDATE artworks SET missing_from_last_import=1 WHERE id=?').run(w.id);
    const summary = { ...preview.summary, created, updated, skipped, appliedAt: now() };
    db.prepare("UPDATE imports SET status='applied', applied_at=?, summary=?, mapping=? WHERE id=?").run(now(), JSON.stringify(summary), JSON.stringify(preview.mapping), importId);
    audit(db, 'import.apply', 'import', importId, { created, updated, skipped, conflicts: summary.conflicts, blocked: summary.blocked });
    return summary;
  });
  return result;
}

function toPatch(apply, aw) {
  const patch = {};
  let dims = null;
  for (const [k, v] of Object.entries(apply)) {
    if (k === 'links' || k === 'extra') patch[k] = v;
    else if (k.startsWith('private.')) (patch.private ||= {})[k.slice(8)] = v;
    else if (k.startsWith('custom.')) (patch.custom ||= {})[k.slice(7)] = v;
    else if (k.startsWith('dims.')) {
      dims ||= [...aw.dims];
      const kind = k.slice(5);
      dims = dims.filter((d) => d.kind !== kind);
      if (v) dims.push({ ...v, kind });
    } else patch[k] = v;
  }
  if (dims) patch.dims = dims;
  return patch;
}

// Record the imported values for fields without changing the staff ownership of other fields.
function refreshImported(db, artworkId, importedMap, batch) {
  if (!importedMap) return;
  const row = db.prepare('SELECT origin FROM artworks WHERE id=?').get(artworkId);
  const origin = J(row.origin);
  for (const [k, v] of Object.entries(importedMap)) {
    const o = origin[k] || {};
    if (o.by === 'staff') origin[k] = { ...o, imported: v };
    else origin[k] = { by: 'import', at: now(), batch, imported: v };
  }
  db.prepare('UPDATE artworks SET origin=? WHERE id=?').run(JSON.stringify(origin), artworkId);
}

export function listImports(db) {
  return db.prepare('SELECT id, created_at, filename, status, summary, applied_at FROM imports ORDER BY created_at DESC LIMIT 50').all()
    .map((r) => ({ ...r, summary: J(r.summary) }));
}

// ---------- images ----------
/** files: [{ name, buf }]. Matches "<inventory number>.jpg", "<n>_2.jpg", "<n>-2.jpg", "<n> (2).jpg". */
export function importImages(db, dataDir, files) {
  const stocks = new Map(db.prepare('SELECT id, stock_number FROM artworks WHERE stock_number IS NOT NULL').all().map((r) => [r.stock_number.toLowerCase(), r.id]));
  const results = [];
  const planned = files.map((f) => {
    const stem = basename(f.name).replace(/\.[^.]+$/, '').trim();
    let artworkId = stocks.get(stem.toLowerCase());
    let view = 1;
    if (!artworkId) {
      const m = stem.match(/^(.*?)(?:[ _-](\d{1,2})| ?\((\d{1,2})\))$/);
      if (m && stocks.get(m[1].toLowerCase())) { artworkId = stocks.get(m[1].toLowerCase()); view = Number(m[2] || m[3]); }
    }
    return { f, artworkId, view };
  }).sort((a, b) => a.view - b.view || a.f.name.localeCompare(b.f.name, undefined, { numeric: true }));
  for (const { f, artworkId, view } of planned) {
    try {
      const { media, duplicate } = storeMedia(db, dataDir, f.buf, basename(f.name), artworkId || null);
      results.push({ name: f.name, matched: !!artworkId, artwork_id: artworkId || null, view, duplicate, media_id: media.id });
    } catch (e) {
      results.push({ name: f.name, matched: false, error: e.message });
    }
  }
  audit(db, 'images.import', null, null, { files: files.length, matched: results.filter((r) => r.matched).length });
  return {
    results,
    matched: results.filter((r) => r.matched && !r.duplicate).length,
    duplicates: results.filter((r) => r.duplicate).length,
    unmatched: results.filter((r) => !r.matched && !r.error).length,
    errors: results.filter((r) => r.error).length,
  };
}

export { slugify, findOrCreateArtist };
