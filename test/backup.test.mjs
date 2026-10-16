// Export and restore: a bundle restores to an identical workspace, damage is detected before
// anything is written, and a damaged workspace refuses to produce a partial backup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { workspace, tmp, rm } from './helpers.mjs';
import { seedDemo } from '../lib/demo-seed.mjs';
import { exportBundle, restoreBundle, verifyWorkspace } from '../lib/backup.mjs';
import { readZip, writeZip } from '../lib/zip.mjs';
import { openWorkspace, isEmptyWorkspace } from '../lib/db.mjs';
import { updateArtwork, getArtwork } from '../lib/store.mjs';
import { updateSettings } from '../lib/settings.mjs';
import { DatabaseSync } from 'node:sqlite';

const TABLES = ['meta', 'settings', 'artists', 'artworks', 'channel_links', 'media', 'custom_fields', 'exhibitions', 'exhibition_items', 'imports', 'connectors'];
const sha = (b) => createHash('sha256').update(b).digest('hex');
const KEY_COLS = 'id, stock_number, artist_id, title, year, medium, dims, price, currency, price_visibility, availability, public, private, custom, extra, origin, description, provenance, missing_from_last_import, created_at, updated_at';

test('export then restore into an empty folder reproduces the workspace', () => {
  const ws = workspace();
  const target = tmp('og-restore-');
  try {
    seedDemo(ws.db, ws.dir);
    const some = ws.db.prepare('SELECT id FROM artworks LIMIT 1').get().id;
    updateArtwork(ws.db, some, { title: 'Edited before export', description: 'Line one\nLine two' });
    updateSettings(ws.db, { 'theme.colorAccent': '#abcdef', 'gallery.name': 'Export Gallery' });
    writeFileSync(join(ws.dir, 'custom', 'site.css'), '.custom{display:block}');
    const { zip, manifest } = exportBundle(ws.db, ws.dir);
    assert.equal(manifest.format, 'open-gallery-bundle');
    assert.ok(manifest.counts.artworks === 59 && manifest.counts.media > 60);
    const z = readZip(zip);
    assert.ok(z.has('README.txt') && z.has('records/workspace.json') && z.has('spreadsheets/artworks.csv') && z.has('custom/site.css'));
    for (const f of manifest.files) assert.equal(sha(z.get(f.path)()), f.sha256, `manifest checksum ${f.path}`);
    const importFiles = manifest.files.filter((f) => f.path.startsWith('imports/'));
    assert.ok(importFiles.length >= 1);

    const r = restoreBundle(zip, target);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.mismatched, []);
    const db2 = openWorkspace(target);
    try {
      for (const t of TABLES) assert.equal(db2.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n, ws.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n, `count ${t}`);
      assert.equal(db2.prepare('SELECT COUNT(*) n FROM audit').get().n, ws.db.prepare('SELECT COUNT(*) n FROM audit').get().n + 1 - 1, 'audit rows carried over (export row on source, restore row on target)');
      for (const m of db2.prepare('SELECT sha256, ext FROM media').all()) {
        const p = join(target, 'media', `${m.sha256}.${m.ext}`);
        assert.ok(existsSync(p), `media ${m.sha256}`);
        assert.equal(sha(readFileSync(p)), m.sha256);
      }
      const rows = (db) => db.prepare(`SELECT ${KEY_COLS} FROM artworks ORDER BY id`).all().map((r) => JSON.stringify(r));
      assert.deepEqual(rows(db2), rows(ws.db));
      assert.equal(getArtwork(db2, some).description, 'Line one\nLine two');
      const items = (db) => db.prepare('SELECT exhibition_id, artwork_id, position FROM exhibition_items ORDER BY 1,3').all();
      assert.deepEqual(items(db2), items(ws.db));
      assert.ok(items(db2).length >= 10);
      const settings = (db) => db.prepare('SELECT key, value FROM settings ORDER BY key').all();
      assert.deepEqual(settings(db2), settings(ws.db));
      assert.equal(readFileSync(join(target, 'custom', 'site.css'), 'utf8'), '.custom{display:block}');
      for (const imp of ws.db.prepare('SELECT stored_as FROM imports').all()) {
        assert.ok(readFileSync(join(target, imp.stored_as)).equals(readFileSync(join(ws.dir, imp.stored_as))), `import original ${imp.stored_as}`);
      }
      assert.equal(db2.prepare("SELECT value FROM meta WHERE key='workspace_id'").get().value, manifest.workspace_id);
      assert.equal(verifyWorkspace(db2, target).ok, true);
      assert.equal(db2.prepare("SELECT state FROM connectors WHERE channel='artsy'").get().state, ws.db.prepare("SELECT state FROM connectors WHERE channel='artsy'").get().state);
    } finally { db2.close(); }

    // Restore refuses a workspace that already holds anything.
    assert.throws(() => restoreBundle(zip, ws.dir), /empty workspace/);
    assert.throws(() => restoreBundle(zip, target), /empty workspace/);
    assert.equal(ws.db.prepare('SELECT COUNT(*) n FROM artworks').get().n, 59);
  } finally { ws.close(); rm(target); }
});

test('a tampered bundle is rejected before any record is written', () => {
  const ws = workspace();
  const target = tmp('og-restore-bad-');
  try {
    seedDemo(ws.db, ws.dir);
    const { zip } = exportBundle(ws.db, ws.dir);
    const z = readZip(zip);
    const names = [...z.keys()];
    const mediaName = names.find((n) => n.startsWith('media/originals/'));
    const entries = names.map((name) => {
      const data = Buffer.from(z.get(name)());
      if (name === mediaName) data[data.length - 1] ^= 0xff; // flip one byte of one original
      return { name, data };
    });
    const bad = writeZip(entries);
    assert.throws(() => restoreBundle(bad, target), /damaged|checksum/i);
    assert.equal(isEmptyWorkspace(target), true);
    if (existsSync(join(target, 'gallery.db'))) {
      const db = new DatabaseSync(join(target, 'gallery.db'));
      assert.equal(db.prepare('SELECT COUNT(*) n FROM artworks').get().n, 0);
      db.close();
    }
    assert.ok(!existsSync(join(target, 'media')) || readdirSync(join(target, 'media')).length === 0, 'no media written');
    // A missing file is also refused.
    const missing = writeZip(entries.filter((e) => e.name !== mediaName).map((e) => (e.name === mediaName ? e : { name: e.name, data: Buffer.from(z.get(e.name)()) })));
    assert.throws(() => restoreBundle(missing, target), /incomplete|missing/i);
    assert.throws(() => restoreBundle(Buffer.from('not a zip at all'), target), /ZIP/);
    assert.equal(isEmptyWorkspace(target), true);
  } finally { ws.close(); rm(target); }
});

test('a damaged workspace refuses to export a partial backup and verify reports it', () => {
  const ws = workspace();
  try {
    seedDemo(ws.db, ws.dir);
    assert.equal(verifyWorkspace(ws.db, ws.dir).ok, true);
    const m = ws.db.prepare('SELECT id, sha256, ext FROM media WHERE artwork_id IS NOT NULL LIMIT 1').get();
    const path = join(ws.dir, 'media', `${m.sha256}.${m.ext}`);
    const original = readFileSync(path);
    // Corrupted original
    writeFileSync(path, Buffer.concat([original.subarray(0, original.length - 10), Buffer.from('0123456789')]));
    assert.throws(() => exportBundle(ws.db, ws.dir), /damaged|checksum/i);
    let v = verifyWorkspace(ws.db, ws.dir);
    assert.equal(v.ok, false);
    assert.ok(v.problems.some((p) => p.includes(m.id) && /checksum/.test(p)));
    // Missing original
    unlinkSync(path);
    assert.throws(() => exportBundle(ws.db, ws.dir), /missing/i);
    v = verifyWorkspace(ws.db, ws.dir);
    assert.equal(v.ok, false);
    assert.ok(v.problems.some((p) => p.includes(m.id) && /Missing/.test(p)));
    // Put it back: export works again.
    writeFileSync(path, original);
    assert.equal(verifyWorkspace(ws.db, ws.dir).ok, true);
    assert.ok(exportBundle(ws.db, ws.dir).zip.length > 1000);
  } finally { ws.close(); }
});
