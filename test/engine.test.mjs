// Engine-level checks: the demo seeds offline, transactions roll back cleanly, schema
// upgrades are safe, and a 1,500-work inventory imports and searches quickly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { workspace, tmp, rm, importFile } from './helpers.mjs';
import { openWorkspace, tx, SCHEMA_VERSION } from '../lib/db.mjs';
import { seedDemo } from '../lib/demo-seed.mjs';
import { stats, listArtworks, createArtwork, getArtwork } from '../lib/store.mjs';
import { uploadImport, previewImport, applyImport } from '../lib/importer.mjs';
import { generateDemo } from '../demo/generate.mjs';
import { DatabaseSync } from 'node:sqlite';

test('fresh demo seeds an empty workspace with no network or API key', () => {
  const ws = workspace();
  try {
    assert.equal(process.env.OPEN_GALLERY_API_KEY, undefined);
    const r = seedDemo(ws.db, ws.dir);
    const s = stats(ws.db);
    assert.equal(s.artworks, 59, 'all rows except the one with a missing title');
    assert.equal(s.artists, 12);
    assert.equal(r.import.created, 59);
    assert.equal(r.import.error, 1);
    assert.ok(s.available >= 15 && s.sold >= 5, JSON.stringify(s));
    assert.ok(s.images >= 59 && s.images <= 80, `images ${s.images}`);
    assert.equal(s.withoutImages, 0);
    // Unassigned: 2 orphan scans, the image of the row without a title, and the 3 works that only
    // appear in the later re-export. Nothing is thrown away.
    assert.equal(s.unassignedImages, 2 + 1 + 3);
    assert.equal(r.images.unmatched, 6);
    assert.equal(s.exhibitions, 1);
    assert.equal(s.public, 59);
    assert.equal(s.imports, 1);
    assert.equal(ws.db.prepare("SELECT value FROM meta WHERE key='demo'").get().value, 'true');
    assert.ok(existsSync(join(ws.dir, 'demo-files', 'inventory.csv')));
    assert.ok(readdirSync(join(ws.dir, 'media')).length >= 60);
    assert.equal(ws.db.prepare("SELECT COUNT(*) n FROM exhibition_items").get().n, 10);
  } finally { ws.close(); }
});

test('reopening a workspace keeps its data; a newer schema is refused with a clear error', () => {
  const dir = tmp('og-schema-');
  try {
    let db = openWorkspace(dir);
    createArtwork(db, { artist: 'A', title: 'Kept', stock_number: 'K-1' });
    const wsId = db.prepare("SELECT value FROM meta WHERE key='workspace_id'").get().value;
    db.close();
    db = openWorkspace(dir);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM artworks').get().n, 1);
    assert.equal(db.prepare("SELECT value FROM meta WHERE key='workspace_id'").get().value, wsId);
    assert.equal(Number(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), SCHEMA_VERSION);
    db.prepare("UPDATE meta SET value=? WHERE key='schema_version'").run(String(SCHEMA_VERSION + 1));
    db.close();
    assert.throws(() => openWorkspace(dir), /newer Open Gallery/);
    // Data is untouched by the refusal.
    db = new DatabaseSync(join(dir, 'gallery.db'));
    assert.equal(db.prepare('SELECT COUNT(*) n FROM artworks').get().n, 1);
    db.close();
  } finally { rm(dir); }
});

test('applyImport is transactional: a failure mid-apply leaves no partial writes', () => {
  const ws = workspace();
  try {
    const fx = tmp('og-tx-fixture-');
    generateDemo(fx, { works: 40, seed: 11, images: false });
    const up = uploadImport(ws.db, ws.dir, 'inventory.csv', readFileSync(join(fx, 'inventory.csv')));
    const pv = previewImport(ws.db, ws.dir, up.id);
    const decisions = Object.fromEntries(pv.plan.filter((p) => p.action === 'review').map((p) => [p.row, { match: 'create' }]));
    const victim = pv.plan.filter((p) => p.action === 'create')[20].stock;
    // Something goes wrong on the 21st row (a trigger stands in for a disk or constraint failure).
    ws.db.exec(`CREATE TRIGGER fail_mid BEFORE UPDATE ON artworks WHEN NEW.stock_number='${victim}' BEGIN SELECT RAISE(ABORT, 'simulated failure'); END`);
    assert.throws(() => applyImport(ws.db, ws.dir, up.id, { decisions }), /simulated failure/);
    assert.equal(ws.db.prepare('SELECT COUNT(*) n FROM artworks').get().n, 0);
    assert.equal(ws.db.prepare('SELECT COUNT(*) n FROM artists').get().n, 0);
    assert.equal(ws.db.prepare("SELECT COUNT(*) n FROM audit WHERE action LIKE 'artwork.%'").get().n, 0);
    assert.equal(ws.db.prepare('SELECT status FROM imports WHERE id=?').get(up.id).status, 'uploaded');
    ws.db.exec('DROP TRIGGER fail_mid');
    const ok = applyImport(ws.db, ws.dir, up.id, { decisions });
    assert.ok(ok.created >= 38);
    assert.equal(ws.db.prepare('SELECT COUNT(*) n FROM artworks').get().n, ok.created);
    rm(fx);

    // tx() itself rolls back everything inside.
    const before = ws.db.prepare('SELECT COUNT(*) n FROM artworks').get().n;
    assert.throws(() => tx(ws.db, () => { createArtwork(ws.db, { artist: 'Z', title: 'Rolled back' }); throw new Error('boom'); }), /boom/);
    assert.equal(ws.db.prepare('SELECT COUNT(*) n FROM artworks').get().n, before);
    assert.equal(ws.db.prepare("SELECT COUNT(*) n FROM artists WHERE name='Z'").get().n, 0);
    const id = tx(ws.db, () => createArtwork(ws.db, { artist: 'Z', title: 'Committed' }).id);
    assert.ok(getArtwork(ws.db, id));
  } finally { ws.close(); }
});

test('performance: 1,500-work import and search', () => {
  const ws = workspace();
  const fx = tmp('og-perf-');
  try {
    generateDemo(fx, { works: 1500, seed: 3, images: false });
    const buf = readFileSync(join(fx, 'inventory.csv'));
    const t0 = performance.now();
    const up = uploadImport(ws.db, ws.dir, 'inventory.csv', buf);
    const t1 = performance.now();
    const pv = previewImport(ws.db, ws.dir, up.id);
    const t2 = performance.now();
    const decisions = Object.fromEntries(pv.plan.filter((p) => p.action === 'review').map((p) => [p.row, { match: 'create' }]));
    const r = applyImport(ws.db, ws.dir, up.id, { decisions });
    const t3 = performance.now();
    assert.equal(r.created, 1499);
    const n = ws.db.prepare('SELECT COUNT(*) n FROM artworks').get().n;
    assert.equal(n, 1499);
    const apply = t3 - t2;
    // Second import of the same file (every row compared against an existing work).
    const up2 = uploadImport(ws.db, ws.dir, 'inventory.csv', buf);
    const t4 = performance.now();
    const pv2 = previewImport(ws.db, ws.dir, up2.id);
    const t5 = performance.now();
    assert.equal(pv2.summary.unchanged, 1499);
    const s0 = performance.now();
    const res = listArtworks(ws.db, { q: 'Harbor' });
    const s1 = performance.now();
    const res2 = listArtworks(ws.db, { q: 'Marisol', availability: 'available' });
    const s2 = performance.now();
    const all = listArtworks(ws.db, { limit: 5000 });
    const s3 = performance.now();
    assert.ok(res.total > 0 && res2.total > 0 && all.total === 1499);
    const ms = (x) => Math.round(x);
    const cpu = (() => { try { return execSync('sysctl -n machdep.cpu.brand_string').toString().trim(); } catch { return process.arch; } })();
    console.log(`[perf] ${cpu}, node ${process.version}: 1,500 works — upload ${ms(t1 - t0)} ms, preview ${ms(t2 - t1)} ms, apply ${ms(apply)} ms (preview+apply ${ms(t3 - t1)} ms); repeat preview ${ms(t5 - t4)} ms; search "Harbor" ${ms(s1 - s0)} ms (${res.total} hits), filtered search ${ms(s2 - s1)} ms, list all ${ms(s3 - s2)} ms`);
    assert.ok(apply < 30000, `apply took ${ms(apply)} ms`);
    assert.ok(t3 - t1 < 30000, `preview+apply took ${ms(t3 - t1)} ms`);
    assert.ok(s1 - s0 < 500, `search took ${ms(s1 - s0)} ms`);
    assert.ok(s2 - s1 < 500, `filtered search took ${ms(s2 - s1)} ms`);
  } finally { ws.close(); rm(fx); }
});
