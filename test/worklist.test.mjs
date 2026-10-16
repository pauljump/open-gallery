// Daily-task speedups: filtering by price and size, sorting, and bulk repricing with undo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workspace } from './helpers.mjs';
import { createArtwork, listArtworks, bulkReprice, setPrices, getArtwork, updateArtwork } from '../lib/store.mjs';

function seed(db) {
  return [
    createArtwork(db, { artist: 'Ann A', title: 'Small', price: 4000, dims: [{ kind: 'work', h: 20, w: 30, unit: 'in' }] }),
    createArtwork(db, { artist: 'Ann A', title: 'Wide cm', price: 9000, dims: [{ kind: 'work', h: 50, w: 120, unit: 'cm' }] }),
    createArtwork(db, { artist: 'Ann A', title: 'Big', price: 25000, dims: [{ kind: 'work', h: 60, w: 80, unit: 'in' }] }),
    createArtwork(db, { artist: 'Bo B', title: 'Unpriced', dims: [{ kind: 'work', h: 10, w: 10, unit: 'in' }] }),
  ];
}

test('filters answer "available by artist under a price and width"', () => {
  const ws = workspace();
  try {
    const [small, wide, big] = seed(ws.db);
    const titles = (o) => listArtworks(ws.db, o).rows.map((r) => r.title).sort();
    assert.deepEqual(titles({ maxPrice: 10000 }), ['Small', 'Wide cm']);
    assert.deepEqual(titles({ minPrice: 5000 }), ['Big', 'Wide cm']);
    // 120 cm is 47.2 in, so a 40 in wall excludes it
    assert.deepEqual(titles({ maxWidth: 40 }), ['Small', 'Unpriced']);
    assert.deepEqual(titles({ maxWidth: 48, maxPrice: 10000, artist: small.artist_id }), ['Small', 'Wide cm']);
    assert.deepEqual(listArtworks(ws.db, { sort: 'price_desc' }).rows.map((r) => r.title), ['Big', 'Wide cm', 'Small', 'Unpriced']);
    assert.deepEqual(listArtworks(ws.db, { sort: 'price' }).rows.map((r) => r.title), ['Small', 'Wide cm', 'Big', 'Unpriced']);
    void wide; void big;
  } finally { ws.close(); }
});

test('bulk repricing previews, applies, skips sold and unpriced, and undoes exactly', () => {
  const ws = workspace();
  try {
    const works = seed(ws.db);
    updateArtwork(ws.db, works[2].id, { availability: 'sold' });
    const ids = works.map((w) => w.id);
    const pv = bulkReprice(ws.db, ids, { mode: 'percent', value: 15, round: 100 });
    assert.equal(pv.applied, false);
    assert.deepEqual(pv.changes.map((c) => [c.title, c.from, c.to]), [['Small', 4000, 4600], ['Wide cm', 9000, 10400]]);
    assert.deepEqual(pv.skipped.map((s) => s.reason).sort(), ['no price yet', 'sold']);
    assert.equal(getArtwork(ws.db, works[0].id).price, 4000, 'preview writes nothing');
    const done = bulkReprice(ws.db, ids, { mode: 'percent', value: 15, round: 100, dryRun: false });
    assert.equal(getArtwork(ws.db, works[1].id).price, 10400);
    setPrices(ws.db, done.changes.map((c) => ({ id: c.id, price: c.from })));
    assert.equal(getArtwork(ws.db, works[0].id).price, 4000);
    assert.equal(getArtwork(ws.db, works[1].id).price, 9000);
    assert.equal(bulkReprice(ws.db, [works[3].id], { mode: 'set', value: 1234, round: 10, dryRun: false }).changes[0].to, 1230);
    assert.throws(() => bulkReprice(ws.db, ids, { mode: 'amount', value: -100000 }), /negative/);
    // A bulk reprice counts as a staff edit, so a re-import will ask before overwriting it.
    assert.equal(getArtwork(ws.db, works[3].id).origin.price.by, 'staff');
  } finally { ws.close(); }
});
