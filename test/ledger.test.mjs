// Operations layer: consignment splits, holds, sales, payouts, statements, privacy and restore.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { workspace, tmp, rm } from './helpers.mjs';
import { openWorkspace, SCHEMA_VERSION } from '../lib/db.mjs';
import * as L from '../lib/ledger.mjs';
import { createArtwork, getArtwork, updateArtist, updateArtwork } from '../lib/store.mjs';
import { updateSettings } from '../lib/settings.mjs';
import { buildSite } from '../lib/site.mjs';
import { exportBundle, restoreBundle } from '../lib/backup.mjs';
import { parseCSV } from '../lib/tables.mjs';

const day = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const work = (db, extra = {}) => createArtwork(db, { artist: 'Ida Example', title: `Work ${Math.random().toString(36).slice(2, 7)}`, price: 10000, availability: 'available', ...extra });

test('split arithmetic in cents for every discount rule', () => {
  const base = { split_pct: 50, list_cents: 1_000_000, price_cents: 900_000 };
  assert.deepEqual(L.splitSale({ ...base, discount_borne_by: 'shared' }), { consignorGross: 450_000, galleryShare: 450_000, deductions: 0, net: 450_000, discount: 100_000 });
  assert.equal(L.splitSale({ ...base, discount_borne_by: 'gallery' }).consignorGross, 500_000);
  assert.equal(L.splitSale({ ...base, discount_borne_by: 'gallery' }).galleryShare, 400_000);
  assert.equal(L.splitSale({ ...base, discount_borne_by: 'consignor' }).consignorGross, 400_000);
  assert.equal(L.splitSale({ ...base, discount_borne_by: 'consignor' }).galleryShare, 500_000);
  // no list price: discount is zero, all rules agree
  for (const r of ['shared', 'gallery', 'consignor']) assert.equal(L.splitSale({ split_pct: 60, list_cents: null, price_cents: 12_345, discount_borne_by: r }).consignorGross, 7_407);
  // above list: the gallery rule pays on the higher price
  assert.equal(L.splitSale({ split_pct: 50, list_cents: 100_00, price_cents: 120_00, discount_borne_by: 'gallery' }).consignorGross, 60_00);
  // deductions come off the consignor's share; gallery-owned sales owe nothing
  assert.equal(L.splitSale({ ...base, discount_borne_by: 'shared' }, 30_000).net, 420_000);
  assert.deepEqual(L.splitSale({ split_pct: null, price_cents: 5000 }), { consignorGross: 0, galleryShare: 5000, deductions: 0, net: 0, discount: 0 });
});

test('owner of record, one active consignment, default splits', () => {
  const ws = workspace();
  try {
    const aw = work(ws.db);
    assert.equal(L.ownerOfRecord(ws.db, aw.id).kind, 'unknown');
    updateArtist(ws.db, aw.artist_id, { default_split: 60 });
    const k = L.saveConsignment(ws.db, null, { artwork_id: aw.id, from: 'artist' });
    assert.equal(k.split_pct, 60);
    assert.equal(L.ownerOfRecord(ws.db, aw.id).kind, 'artist_consignment');
    assert.throws(() => L.saveConsignment(ws.db, null, { artwork_id: aw.id, from: 'artist' }), /already has an active consignment/);
    assert.throws(() => L.setGalleryOwned(ws.db, aw.id, true), /End the active consignment/);
    assert.throws(() => L.saveConsignment(ws.db, k.id, { start_date: '2026-05-01', end_date: '2026-04-01' }), /before the start/);
    L.saveConsignment(ws.db, k.id, { status: 'returned' });
    const k2 = L.saveConsignment(ws.db, null, { artwork_id: aw.id, from: 'contact', contact: 'Rosa Lender' });
    assert.equal(k2.split_pct, 50, 'falls back to the gallery default');
    assert.equal(L.ownerOfRecord(ws.db, aw.id).name, 'Rosa Lender');
    assert.equal(L.listContacts(ws.db).length, 1);
    updateSettings(ws.db, { 'operations.defaultSplit': 70 });
    const other = work(ws.db, { artist: 'No Default' });
    assert.equal(L.saveConsignment(ws.db, null, { artwork_id: other.id }).split_pct, 70);
  } finally { ws.close(); }
});

test('holds queue, expire and drive availability', () => {
  const ws = workspace();
  try {
    const aw = work(ws.db);
    L.placeHold(ws.db, aw.id, { contact: 'First Buyer', hours: 24 });
    assert.equal(getArtwork(ws.db, aw.id).availability, 'on_hold');
    const two = L.placeHold(ws.db, aw.id, { contact: 'Second Buyer', hours: 0 });
    assert.equal(two.filter((h) => h.status === 'active').length, 2);
    assert.equal(two[0].contact_name, 'First Buyer');
    ws.db.prepare("UPDATE holds SET expires_at='2000-01-01T00:00:00.000Z' WHERE contact_id=(SELECT id FROM contacts WHERE display_name='First Buyer')").run();
    const after = L.listHolds(ws.db, aw.id);
    assert.equal(after.find((h) => h.contact_name === 'First Buyer').status, 'expired');
    assert.equal(getArtwork(ws.db, aw.id).availability, 'on_hold', 'second hold still active');
    L.closeHold(ws.db, after.find((h) => h.contact_name === 'Second Buyer').id);
    assert.equal(getArtwork(ws.db, aw.id).availability, 'available');
    updateArtwork(ws.db, aw.id, { availability: 'sold' });
    assert.throws(() => L.placeHold(ws.db, aw.id, { contact: 'Late' }), /sold/);
  } finally { ws.close(); }
});

test('a consigned sale from hold to payout', () => {
  const ws = workspace();
  try {
    const aw = work(ws.db, { price: 10000 });
    L.saveConsignment(ws.db, null, { artwork_id: aw.id, split_pct: 50, discount_limit_pct: 10 });
    L.placeHold(ws.db, aw.id, { contact: 'Buyer One' });
    L.placeHold(ws.db, aw.id, { contact: 'Buyer Two' });
    assert.throws(() => L.recordSale(ws.db, aw.id, { price: 8000, buyer: 'Buyer One' }), /more than the 10%/);
    const s = L.recordSale(ws.db, aw.id, { price: 9000, buyer: 'Buyer One', deposit: 2250, sale_date: day(-40) });
    assert.equal(getArtwork(ws.db, aw.id).availability, 'sold');
    assert.deepEqual(L.listHolds(ws.db, aw.id).map((h) => h.status).sort(), ['converted', 'released']);
    assert.equal(s.payout_status, 'awaiting_buyer');
    assert.equal(s.paid_cents, 225_000);
    assert.throws(() => L.recordSale(ws.db, aw.id, { price: 1 }), /already has a sale/);
    // Partial payment: the consignor's share of what was received is "held".
    const owed1 = L.owedSummary(ws.db).totals;
    assert.equal(owed1.awaiting, 450_000);
    assert.equal(owed1.held, 112_500);
    L.addDeduction(ws.db, s.id, { description: 'Framing', amount: 300 });
    const paid = L.addPayment(ws.db, s.id, { amount: 6750, paid_on: day(-35) });
    assert.equal(paid.status, 'paid');
    assert.equal(paid.payout_due_on, day(-5));
    assert.equal(paid.payout_status, 'overdue');
    assert.equal(paid.split.net, 420_000);
    assert.throws(() => L.recordPayout(ws.db, { payee_type: 'artist', payee_id: aw.artist_id, sale_ids: [s.id], amount: 4000 }), /should be 4200.00/);
    const po = L.recordPayout(ws.db, { payee_type: 'artist', payee_id: aw.artist_id, sale_ids: [s.id], paid_on: day(0) });
    assert.equal(po.amount_cents, 420_000);
    assert.equal(L.saleDetail(ws.db, s.id).payout_status, 'paid_out');
    assert.throws(() => L.recordPayout(ws.db, { payee_type: 'artist', payee_id: aw.artist_id, sale_ids: [s.id] }), /already paid out/);
    assert.throws(() => L.cancelSale(ws.db, s.id), /already paid/);
    assert.throws(() => L.updateSale(ws.db, s.id, { price: 1 }), /already been paid/);
    const st = L.statement(ws.db, 'artist', aw.artist_id, { from: day(-60), to: day(0) });
    assert.deepEqual(st.totals, { gross: 900_000, consignorGross: 450_000, deductions: 30_000, net: 420_000, paidOut: 420_000 });
    assert.deepEqual(st.owedNow, { payable: 0, overdue: 0, awaitingBuyer: 0 });
    const empty = L.statement(ws.db, 'artist', aw.artist_id, { from: day(-10), to: day(-9) });
    assert.equal(empty.sales.length, 0);
    const rows = parseCSV(L.accountingCSV(ws.db));
    assert.equal(rows[0][0], 'Type');
    assert.equal(rows.find((r) => r[0] === 'Sale')[16], '4200.00');
    assert.equal(rows.find((r) => r[0] === 'Payout')[16], '4200.00');
  } finally { ws.close(); }
});

test('payouts only cover the right payee; cancel restores the work', () => {
  const ws = workspace();
  try {
    const a = work(ws.db); const b = work(ws.db, { artist: 'Other Artist' });
    L.saveConsignment(ws.db, null, { artwork_id: a.id });
    L.saveConsignment(ws.db, null, { artwork_id: b.id, from: 'contact', contact: 'Collector Consignor' });
    const sa = L.recordSale(ws.db, a.id, { price: 1000, deposit: 1000, buyer: 'X' });
    const sb = L.recordSale(ws.db, b.id, { price: 2000, buyer: 'Y' });
    const owed = L.owedSummary(ws.db);
    assert.equal(owed.payees.length, 2);
    assert.equal(owed.payees.find((p) => p.type === 'contact').awaiting_buyer_cents, 100_000);
    assert.throws(() => L.recordPayout(ws.db, { payee_type: 'artist', payee_id: a.artist_id, sale_ids: [sb.id] }), /not owed to this payee/);
    const contactId = owed.payees.find((p) => p.type === 'contact').id;
    assert.throws(() => L.recordPayout(ws.db, { payee_type: 'contact', payee_id: contactId, sale_ids: [sb.id] }), /has not paid in full/);
    assert.equal(L.saleDetail(ws.db, sa.id).payout_status, 'payable');
    L.cancelSale(ws.db, sb.id, { note: 'Buyer withdrew' });
    assert.equal(getArtwork(ws.db, b.id).availability, 'available');
    assert.equal(L.ownerOfRecord(ws.db, b.id).kind, 'collector_consignment');
  } finally { ws.close(); }
});

test('nothing from the operations layer reaches public output', () => {
  const ws = workspace();
  try {
    const aw = work(ws.db, { price: 15000 });
    updateArtwork(ws.db, aw.id, { public: true });
    const held = work(ws.db, { price: 9000 });
    updateArtwork(ws.db, held.id, { public: true });
    L.saveConsignment(ws.db, null, { artwork_id: aw.id, from: 'contact', contact: 'Zebulon Secretconsignor', terms: 'SECRET-TERMS-77', insured_value: 77777 });
    L.saveContact(ws.db, null, { display_name: 'Quincy Hiddenbuyer', email: 'quincy@private.example', note: 'SECRET-NOTE-88' });
    const s = L.recordSale(ws.db, aw.id, { price: 12345.67, buyer: 'Quincy Hiddenbuyer', invoice_number: 'INV-SECRET-99', discount_approved: true });
    L.addDeduction(ws.db, s.id, { description: 'SECRET-DEDUCTION-66', amount: 432.1 });
    L.placeHold(ws.db, held.id, { contact: 'Wilhelmina Holdperson', note: 'SECRET-HOLD-55' });
    const out = tmp('og-site-');
    try {
      buildSite(ws.db, ws.dir, out);
      const secrets = ['Zebulon', 'Secretconsignor', 'SECRET-TERMS-77', '77777', 'Quincy', 'quincy@private.example', 'SECRET-NOTE-88', '12345.67', '12,345', 'INV-SECRET-99', 'SECRET-DEDUCTION-66', '432.1', 'Wilhelmina', 'SECRET-HOLD-55'];
      const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
      for (const f of walk(out).filter((f) => !/\.(png|jpe?g)$/.test(f))) {
        const text = readFileSync(f, 'utf8');
        for (const x of secrets) assert.ok(!text.includes(x), `${x} leaked into ${f}`);
      }
      const feed = JSON.parse(readFileSync(join(out, 'catalog.json'), 'utf8'));
      const sold = feed.works.find((w) => w.id === aw.id);
      assert.equal(sold.availability, 'sold');
      assert.equal(sold.price, null);
      assert.equal(feed.works.find((w) => w.id === held.id).availability, 'on_hold');
    } finally { rm(out); }
  } finally { ws.close(); }
});

test('export and restore carry every operations table', () => {
  const ws = workspace();
  const target = tmp('og-restore-');
  try {
    const aw = work(ws.db);
    L.saveConsignment(ws.db, null, { artwork_id: aw.id });
    const s = L.recordSale(ws.db, aw.id, { price: 5000, deposit: 5000, buyer: 'Restored Buyer' });
    L.addDeduction(ws.db, s.id, { description: 'Crating', amount: 100 });
    L.recordPayout(ws.db, { payee_type: 'artist', payee_id: aw.artist_id, sale_ids: [s.id] });
    const h = work(ws.db); L.placeHold(ws.db, h.id, { contact: 'Holder' });
    const before = L.statement(ws.db, 'artist', aw.artist_id);
    const { zip } = exportBundle(ws.db, ws.dir);
    const r = restoreBundle(zip, target);
    assert.equal(r.ok, true);
    const db2 = openWorkspace(target);
    try {
      for (const t of ['contacts', 'consignments', 'holds', 'sales', 'payments', 'deductions', 'payouts']) {
        assert.deepEqual(db2.prepare(`SELECT * FROM ${t} ORDER BY id`).all(), ws.db.prepare(`SELECT * FROM ${t} ORDER BY id`).all(), t);
      }
      const after = L.statement(db2, 'artist', aw.artist_id);
      assert.deepEqual({ ...after, generatedAt: null }, { ...before, generatedAt: null });
    } finally { db2.close(); }
  } finally { ws.close(); rm(target); }
});

test('a version 0.1 workspace upgrades in place and can record sales', () => {
  const root = new URL('..', import.meta.url).pathname;
  const old = tmp('og-oldapp-'); const data = tmp('og-olddata-'); const home = tmp('og-home-');
  try {
    execFileSync('git', ['clone', '-q', root, old]);
    execFileSync('git', ['-C', old, 'checkout', '-q', 'v0.1.0']);
    execFileSync(process.execPath, [join(old, 'bin/open-gallery.mjs'), 'demo', '--data', data, '--no-start'], { env: { ...process.env, HOME: home }, stdio: 'ignore' });
    const bundle = join(old, 'old-export.zip');
    execFileSync(process.execPath, [join(old, 'bin/open-gallery.mjs'), 'export', '--data', data, '--out', bundle], { env: { ...process.env, HOME: home }, stdio: 'ignore' });
    const db = openWorkspace(data);
    try {
      assert.equal(Number(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), SCHEMA_VERSION);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM artworks').get().n, 59);
      const w = db.prepare("SELECT id FROM artworks WHERE availability='available' LIMIT 1").get();
      L.saveConsignment(db, null, { artwork_id: w.id });
      assert.equal(L.recordSale(db, w.id, { price: 100 }).split_pct, 50);
    } finally { db.close(); }
    // An export made by 0.1.0 restores into this version.
    const fresh = tmp('og-fresh-');
    try { assert.equal(restoreBundle(readFileSync(bundle), fresh).ok, true); } finally { rm(fresh); }
  } finally { rm(old); rm(data); rm(home); }
});
