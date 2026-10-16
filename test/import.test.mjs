// Spreadsheet import: mapping, validation, repeat imports, re-imports with changes, and
// preservation of what staff did in between.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { workspace, fixture, scenario, csvRecords, importFile, byStock } from './helpers.mjs';
import { uploadImport, previewImport, applyImport } from '../lib/importer.mjs';
import { getArtwork, updateArtwork, saveExhibition, getExhibition, listArtworks } from '../lib/store.mjs';
import { updateSettings, getSettings } from '../lib/settings.mjs';
import { parsePrice } from '../lib/normalize.mjs';
import { toCSV } from '../lib/tables.mjs';

const fx = fixture();
const sc = scenario(fx);
const inv = () => readFileSync(join(fx, 'inventory.csv'));

function snapshot(db) {
  return db.prepare('SELECT w.stock_number, w.title, w.year, w.medium, w.price, w.price_max, w.currency, w.price_visibility, w.availability, w.dims, w.private, w.extra, w.edition, w.signature, w.provenance, a.name AS artist FROM artworks w LEFT JOIN artists a ON a.id=w.artist_id ORDER BY w.stock_number').all()
    .map((r) => ({ ...r, dims: JSON.parse(r.dims), private: JSON.parse(r.private), extra: JSON.parse(r.extra) }));
}

test('CSV and XLSX of the same inventory import to equivalent artworks', () => {
  const a = workspace(); const b = workspace();
  try {
    const ra = importFile(a.db, a.dir, 'inventory.csv', inv());
    const rb = importFile(b.db, b.dir, 'inventory.xlsx', readFileSync(join(fx, 'inventory.xlsx')));
    assert.equal(ra.summary.created, 59);
    assert.equal(rb.summary.created, 59);
    assert.equal(ra.summary.error, 1);
    const sa = snapshot(a.db); const sb = snapshot(b.db);
    assert.equal(sa.length, sb.length);
    assert.deepEqual(sa.map((r) => r.stock_number), sb.map((r) => r.stock_number));
    assert.deepEqual(sa, sb);
    const links = (db) => db.prepare('SELECT w.stock_number, l.channel, l.url FROM channel_links l JOIN artworks w ON w.id=l.artwork_id ORDER BY 1,2,3').all();
    assert.deepEqual(links(a.db), links(b.db));
    assert.ok(links(a.db).length > 0, 'fixture has listing links');
  } finally { a.close(); b.close(); }
});

test('mapping suggestions, extra columns and byte-identical original file', () => {
  const ws = workspace();
  try {
    const buf = inv();
    const up = uploadImport(ws.db, ws.dir, 'inventory.csv', buf);
    const map = Object.fromEntries(up.headers.map((h, i) => [h, up.mapping[i]]));
    assert.equal(map['Stock No.'], 'stock_number');
    assert.equal(map['Price (USD)'], 'price');
    assert.equal(map['Cost'], 'cost');
    assert.equal(map['Notes'], 'notes');
    assert.equal(map['Frame notes'], 'keep');
    assert.equal(map['Status'], 'availability');
    assert.equal(map['Framed H x W (in)'], 'framed_dimensions');
    assert.equal(map['Artsy URL'], 'artsy_url');
    assert.equal(map['Insurance value'], 'insurance_value');
    assert.equal(map['Consignor'], 'consignor');
    assert.equal(map['Location'], 'location');
    const stored = join(ws.dir, 'imports', up.id, 'inventory.csv');
    assert.ok(existsSync(stored));
    assert.ok(readFileSync(stored).equals(buf), 'stored original is byte-identical');
    const row = ws.db.prepare('SELECT * FROM imports WHERE id=?').get(up.id);
    assert.equal(row.stored_as, `imports/${up.id}/inventory.csv`);
    assert.equal(row.status, 'uploaded');

    applyImport(ws.db, ws.dir, up.id, { decisions: Object.fromEntries(previewImport(ws.db, ws.dir, up.id).plan.filter((p) => p.action === 'review').map((p) => [p.row, { match: 'create' }])) });
    const { records } = csvRecords(join(fx, 'inventory.csv'));
    const withFrame = records.filter((r) => r['Frame notes'] && r['Title']);
    assert.ok(withFrame.length > 3);
    for (const r of withFrame) {
      const aw = getArtwork(ws.db, byStock(ws.db, r['Stock No.']));
      assert.equal(aw.extra['Frame notes'], r['Frame notes']);
      assert.equal(aw.private.cost, Number(r['Cost']));
      assert.equal(aw.private.notes, r['Notes']);
      assert.equal(aw.private.location, r['Location']);
    }
    assert.ok(records.some((r) => /,/.test(r['Price (USD)'])), 'fixture has comma-formatted prices');
  } finally { ws.close(); }
});

test('validation: missing title, POA, cm dimensions, messy prices', () => {
  const ws = workspace();
  try {
    const { preview, summary } = importFile(ws.db, ws.dir, 'inventory.csv', inv());
    const errRow = preview.plan.find((p) => p.stock === sc.missingTitleStock);
    assert.equal(errRow.action, 'error');
    assert.ok(errRow.issues.some((i) => i.level === 'error' && /title/i.test(i.message)));
    assert.equal(byStock(ws.db, sc.missingTitleStock), null, 'row with missing title is not created');
    assert.equal(summary.error, 1);

    const poa = getArtwork(ws.db, byStock(ws.db, sc.poaStock));
    assert.equal(poa.price, null);
    assert.equal(poa.price_visibility, 'on_request');
    for (const s of sc.blankPriceStocks) {
      const aw = getArtwork(ws.db, byStock(ws.db, s));
      assert.equal(aw.price, null);
      assert.equal(aw.price_visibility, 'on_request');
    }

    const { records } = csvRecords(join(fx, 'inventory.csv'));
    const rec = Object.fromEntries(records.map((r) => [r['Stock No.'], r]));
    for (const s of sc.cmStocks) {
      const aw = getArtwork(ws.db, byStock(ws.db, s));
      const work = aw.dims.find((d) => d.kind === 'work');
      const m = rec[s]['Dimensions'].match(/^(\d+) x (\d+) cm$/);
      assert.ok(work, `cm work ${s} has dims`);
      assert.equal(work.unit, 'cm');
      assert.equal(work.h, Number(m[1]));
      assert.equal(work.w, Number(m[2]));
    }
    // Messy prices: every comma-formatted price in the sheet lands as a plain number.
    const commaRows = records.filter((r) => /^\d{1,3}(,\d{3})+$/.test(r['Price (USD)']) && r['Title']);
    assert.ok(commaRows.length > 0);
    for (const r of commaRows) {
      const aw = getArtwork(ws.db, byStock(ws.db, r['Stock No.']));
      assert.equal(aw.price, Number(r['Price (USD)'].replace(/,/g, '')));
      assert.equal(aw.price_visibility, 'show');
      assert.equal(aw.currency, 'USD');
    }
    assert.equal(parsePrice('35,500').amount, 35500);
    assert.equal(parsePrice('$12,500.00').amount, 12500);
    assert.equal(parsePrice('12.500,00').amount, 12500);
    assert.equal(parsePrice('POA').onRequest, true);
    // Messy status cells were normalised.
    const statusRows = records.filter((r) => r['Title'] && /^\s|\s$/.test(r['Status']));
    assert.ok(statusRows.length >= 2);
    for (const r of statusRows) assert.equal(getArtwork(ws.db, byStock(ws.db, r['Stock No.'])).availability, 'available');
    const sold = records.find((r) => r['Status'] === 'SOLD');
    assert.equal(getArtwork(ws.db, byStock(ws.db, sold['Stock No.'])).availability, 'sold');
    // Artist with trailing spaces did not create a second artist.
    assert.equal(ws.db.prepare('SELECT COUNT(*) n FROM artists').get().n, sc.artists.length);
  } finally { ws.close(); }
});

test('repeat import of the identical file changes nothing; re-import applies the scenario', () => {
  const ws = workspace();
  try {
    const first = importFile(ws.db, ws.dir, 'inventory.csv', inv());
    assert.equal(first.summary.created, 59);
    const countBefore = ws.db.prepare('SELECT COUNT(*) n FROM artworks').get().n;
    const before = snapshot(ws.db);

    const again = uploadImport(ws.db, ws.dir, 'inventory.csv', inv());
    assert.equal(again.sameFileAppliedBefore?.id, first.id);
    const pv = previewImport(ws.db, ws.dir, again.id);
    assert.equal(pv.summary.create, 0);
    assert.equal(pv.summary.update, 0);
    assert.equal(pv.summary.review, 0);
    assert.equal(pv.summary.conflicts, 0);
    assert.equal(pv.summary.unchanged, 59);
    assert.equal(pv.summary.error, 1);
    const ap = applyImport(ws.db, ws.dir, again.id);
    assert.equal(ap.created, 0);
    assert.equal(ap.updated, 0);
    assert.equal(ws.db.prepare('SELECT COUNT(*) n FROM artworks').get().n, countBefore, 'no duplicates');
    assert.deepEqual(snapshot(ws.db), before);

    // A week later.
    const re = uploadImport(ws.db, ws.dir, 'reimport.csv', readFileSync(join(fx, 'reimport.csv')));
    assert.equal(re.mapping[re.headers.indexOf('Shipping crate')], 'keep');
    const pv2 = previewImport(ws.db, ws.dir, re.id);
    const row = (stock) => pv2.plan.find((p) => p.stock === stock);
    for (const d of sc.priceChangedDetail) {
      const ch = row(d.stock).changes.find((c) => c.field === 'price');
      assert.ok(ch, `price change for ${d.stock}`);
      assert.equal(ch.kind, 'update'); assert.equal(ch.from, d.from); assert.equal(ch.to, d.to);
      assert.equal(row(d.stock).action, 'update');
    }
    for (const s of sc.newlySold) {
      const ch = row(s).changes.find((c) => c.field === 'availability');
      assert.deepEqual([ch.kind, ch.from, ch.to], ['update', 'available', 'sold']);
    }
    const stale = row(sc.staleResurrection).changes.find((c) => c.field === 'availability');
    assert.equal(stale.kind, 'blocked');
    assert.equal(stale.choice, 'keep');
    const dup = row(sc.nearDuplicate.newStock);
    assert.equal(dup.action, 'review');
    assert.equal(dup.duplicateOf[0].stock, sc.nearDuplicate.matchesStock);
    assert.equal(pv2.summary.undecided, 1);
    for (const s of sc.added) assert.equal(row(s).action, 'create');
    assert.deepEqual(pv2.notInFile.map((w) => w.stock_number), [sc.removed]);

    // Applying with the duplicate undecided is refused with a 409 and writes nothing.
    const err = assert.throws(() => applyImport(ws.db, ws.dir, re.id), (e) => e.status === 409 && Array.isArray(e.undecided) && e.undecided.includes(dup.row));
    assert.equal(ws.db.prepare('SELECT COUNT(*) n FROM artworks').get().n, countBefore);
    assert.equal(ws.db.prepare('SELECT status FROM imports WHERE id=?').get(re.id).status, 'uploaded');

    const removedId = byStock(ws.db, sc.removed);
    const staleId = byStock(ws.db, sc.staleResurrection);
    const matchedId = byStock(ws.db, sc.nearDuplicate.matchesStock);
    const frameBefore = ws.db.prepare("SELECT id, extra FROM artworks").all().filter((r) => JSON.parse(r.extra)['Frame notes']).map((r) => [r.id, JSON.parse(r.extra)['Frame notes']]);
    assert.ok(frameBefore.length > 3);

    const ap2 = applyImport(ws.db, ws.dir, re.id, { decisions: { [dup.row]: { match: 'skip' } } });
    assert.equal(ap2.created, sc.added.length);
    assert.equal(byStock(ws.db, sc.nearDuplicate.newStock), null, 'skipped duplicate is not created');
    for (const d of sc.priceChangedDetail) assert.equal(getArtwork(ws.db, byStock(ws.db, d.stock)).price, d.to);
    for (const s of sc.newlySold) assert.equal(getArtwork(ws.db, byStock(ws.db, s)).availability, 'sold');
    assert.equal(getArtwork(ws.db, staleId).availability, 'sold', 'sold work stays sold');
    for (const s of sc.added) assert.ok(byStock(ws.db, s));
    const removed = getArtwork(ws.db, removedId);
    assert.ok(removed, 'removed work is not deleted');
    assert.equal(removed.missing_from_last_import, true);
    assert.equal(ws.db.prepare('SELECT COUNT(*) n FROM artworks WHERE missing_from_last_import=1').get().n, 1);
    assert.equal(ws.db.prepare('SELECT COUNT(*) n FROM artworks').get().n, countBefore + sc.added.length);
    // Dropped column: values already stored stay. Added column: kept as extra.
    for (const [id, v] of frameBefore) assert.equal(getArtwork(ws.db, id).extra['Frame notes'], v);
    const { records: reRecs } = csvRecords(join(fx, 'reimport.csv'));
    const crated = reRecs.filter((r) => r['Shipping crate'] && r['Title'] && r['Stock No.'] !== sc.nearDuplicate.newStock);
    assert.ok(crated.length > 0);
    for (const r of crated) assert.equal(getArtwork(ws.db, byStock(ws.db, r['Stock No.'])).extra['Shipping crate'], r['Shipping crate']);
    // Audit trail recorded the blocked change count.
    const applied = JSON.parse(ws.db.prepare('SELECT summary FROM imports WHERE id=?').get(re.id).summary);
    assert.equal(applied.blocked, 1);

    // Merge decision in a second workspace: the matched work is updated, nothing new is created.
    const ws2 = workspace();
    try {
      importFile(ws2.db, ws2.dir, 'inventory.csv', inv());
      const re2 = uploadImport(ws2.db, ws2.dir, 'reimport.csv', readFileSync(join(fx, 'reimport.csv')));
      const matched2 = byStock(ws2.db, sc.nearDuplicate.matchesStock);
      const p2 = previewImport(ws2.db, ws2.dir, re2.id);
      const dupRow = p2.plan.find((p) => p.stock === sc.nearDuplicate.newStock).row;
      const p3 = previewImport(ws2.db, ws2.dir, re2.id, { decisions: { [dupRow]: { match: `merge:${matched2}` } } });
      const mergeEntry = p3.plan.find((p) => p.row === dupRow);
      assert.equal(mergeEntry.artwork_id, matched2);
      assert.ok(mergeEntry.changes.some((c) => c.field === 'private.notes'));
      const n0 = ws2.db.prepare('SELECT COUNT(*) n FROM artworks').get().n;
      const ap3 = applyImport(ws2.db, ws2.dir, re2.id, { decisions: { [dupRow]: { match: `merge:${matched2}` } } });
      assert.equal(ap3.created, sc.added.length);
      assert.equal(ws2.db.prepare('SELECT COUNT(*) n FROM artworks').get().n, n0 + sc.added.length);
      const merged = getArtwork(ws2.db, matched2);
      assert.ok(merged.private.notes.includes(`PRIVATE-NOTE-${sc.nearDuplicate.newStock.slice(-4)}`), 'matched work took the merged row');
      assert.equal(merged.stock_number, sc.nearDuplicate.matchesStock, 'merge keeps the catalog inventory number');
      assert.equal(merged.extra['Other inventory number'], sc.nearDuplicate.newStock, 'merge records the other number');
    } finally { ws2.close(); }
  } finally { ws.close(); }
});

test('staff customizations survive a re-import; sheet-vs-staff conflicts are explicit', () => {
  const ws = workspace();
  try {
    const first = importFile(ws.db, ws.dir, 'inventory.csv', inv());
    const stock = sc.priceChanged[0];
    const id = byStock(ws.db, stock);
    const original = getArtwork(ws.db, id);
    updateArtwork(ws.db, id, { title: 'Staff Title', description: 'Written by staff.', public: true });
    const other = byStock(ws.db, sc.priceChanged[1]);
    const ex = saveExhibition(ws.db, null, { title: 'Spring', published: true, items: [id, other] });
    updateSettings(ws.db, { 'theme.colorAccent': '#123456', 'gallery.name': 'Test Gallery' });
    mkdirSync(join(ws.dir, 'custom'), { recursive: true });
    writeFileSync(join(ws.dir, 'custom', 'site.css'), 'body{color:red}');

    // Same original file again: nothing staff did is touched, and no conflict is raised.
    const again = uploadImport(ws.db, ws.dir, 'inventory.csv', inv());
    const pv = previewImport(ws.db, ws.dir, again.id);
    assert.equal(pv.summary.conflicts, 0);
    assert.equal(pv.plan.find((p) => p.stock === stock).action, 'unchanged');
    applyImport(ws.db, ws.dir, again.id);
    let aw = getArtwork(ws.db, id);
    assert.equal(aw.title, 'Staff Title');
    assert.equal(aw.description, 'Written by staff.');
    assert.equal(aw.public, true);
    assert.deepEqual(getExhibition(ws.db, ex.id).items.map((i) => i.artwork_id), [id, other]);
    assert.equal(getSettings(ws.db).theme.colorAccent, '#123456');
    assert.equal(getSettings(ws.db).gallery.name, 'Test Gallery');
    assert.equal(readFileSync(join(ws.dir, 'custom', 'site.css'), 'utf8'), 'body{color:red}');

    // The sheet now changes the same title: conflict, staff value kept by default.
    const { headers, records } = csvRecords(join(fx, 'inventory.csv'));
    const changed = records.map((r) => (r['Stock No.'] === stock ? { ...r, Title: 'Sheet Title' } : r));
    const changedCsv = Buffer.from(toCSV([headers, ...changed.map((r) => headers.map((h) => r[h]))]));
    const c1 = uploadImport(ws.db, ws.dir, 'inventory.csv', changedCsv);
    const pc = previewImport(ws.db, ws.dir, c1.id);
    const entry = pc.plan.find((p) => p.stock === stock);
    const conflict = entry.changes.find((c) => c.field === 'title');
    assert.equal(conflict.kind, 'conflict');
    assert.equal(conflict.from, 'Staff Title');
    assert.equal(conflict.to, 'Sheet Title');
    assert.equal(conflict.choice, 'keep');
    assert.equal(pc.summary.conflicts, 1);
    applyImport(ws.db, ws.dir, c1.id);
    assert.equal(getArtwork(ws.db, id).title, 'Staff Title');
    assert.equal(getArtwork(ws.db, id).description, 'Written by staff.');

    // Re-uploading the same changed sheet does not ask again.
    const c2 = uploadImport(ws.db, ws.dir, 'inventory.csv', changedCsv);
    const pc2 = previewImport(ws.db, ws.dir, c2.id);
    assert.equal(pc2.summary.conflicts, 0);
    assert.equal(pc2.plan.find((p) => p.stock === stock).action, 'unchanged');
    applyImport(ws.db, ws.dir, c2.id);
    assert.equal(getArtwork(ws.db, id).title, 'Staff Title');

    // Choosing the sheet value applies it; staff description is still untouched.
    const changed2 = records.map((r) => (r['Stock No.'] === stock ? { ...r, Title: 'Sheet Title Two' } : r));
    const c3 = uploadImport(ws.db, ws.dir, 'inventory.csv', Buffer.from(toCSV([headers, ...changed2.map((r) => headers.map((h) => r[h]))])));
    const pc3 = previewImport(ws.db, ws.dir, c3.id, { decisions: { [entry.row]: { fields: { title: 'take' } } } });
    const take = pc3.plan.find((p) => p.stock === stock).changes.find((c) => c.field === 'title');
    assert.equal(take.kind, 'conflict'); assert.equal(take.choice, 'take');
    applyImport(ws.db, ws.dir, c3.id, { decisions: { [entry.row]: { fields: { title: 'take' } } } });
    aw = getArtwork(ws.db, id);
    assert.equal(aw.title, 'Sheet Title Two');
    assert.equal(aw.description, 'Written by staff.');
    assert.equal(aw.public, true);
    assert.equal(aw.origin.title.by, 'import');
    assert.equal(original.price, aw.price);
  } finally { ws.close(); }
});
