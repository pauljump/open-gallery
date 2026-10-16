// Artsy file exchange: nothing is sent, the connector says so, batches respect Artsy's limit,
// and ineligible works are left out with a reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workspace } from './helpers.mjs';
import { createArtwork, storeMedia, setLinks } from '../lib/store.mjs';
import { buildArtsyPackage, artsyReconciliation, artsyCandidates, connectors, ARTSY_BATCH_LIMIT } from '../lib/artsy.mjs';
import { readZip } from '../lib/zip.mjs';
import { parseXLSX, parseCSV } from '../lib/tables.mjs';
import { encodePNG } from '../lib/png.mjs';

test('Artsy package: file_exchange state, 100-row batches, README says nothing was sent, skips with reasons', () => {
  const ws = workspace();
  try {
    const png = encodePNG(4, 4, new Uint8Array(4 * 4 * 3).fill(120));
    const ids = [];
    for (let i = 0; i < 150; i++) {
      const aw = createArtwork(ws.db, { artist: `Artist ${i % 7}`, title: `Work ${i}`, stock_number: `AR-${1000 + i}`, year: '2024', price: 1000 + i, currency: 'USD',
        availability: 'available', dims: [{ kind: 'work', h: 10, w: 8, unit: 'in' }], medium: 'Oil on canvas' });
      storeMedia(ws.db, ws.dir, png, `AR-${1000 + i}.png`, aw.id);
      ids.push(aw.id);
    }
    // Ineligible works, each for one documented reason.
    const mk = (patch) => { const aw = createArtwork(ws.db, { artist: 'Artist X', title: `Skip ${Object.keys(patch).join(',')}`, year: '2023', price: 500, availability: 'available', ...patch }); storeMedia(ws.db, ws.dir, png, 'x.png', aw.id); return aw.id; };
    const soldId = mk({ availability: 'sold' });
    const noPriceId = mk({ price: null });
    const noYearId = mk({ year: null });
    const linkedId = mk({});
    setLinks(ws.db, linkedId, [{ channel: 'artsy', url: 'https://www.artsy.net/artwork/already-there' }]);
    const editionId = mk({ edition: '3/25' });
    const all = [...ids, soldId, noPriceId, noYearId, linkedId, editionId];

    assert.equal(connectors(ws.db).find((c) => c.channel === 'artsy').state, 'not_connected');
    const cands = artsyCandidates(ws.db);
    assert.equal(cands.filter((c) => !c.problems.length).length, 150);

    const { zip, report } = buildArtsyPackage(ws.db, ws.dir, all);
    assert.equal(report.included, 150);
    assert.equal(report.batches, 2);
    assert.equal(report.skipped.length, 5);
    const reason = (id) => report.skipped.find((s) => s.id === id).problems.join('; ');
    assert.match(reason(soldId), /sold/);
    assert.match(reason(noPriceId), /price/);
    assert.match(reason(noYearId), /year/);
    assert.match(reason(linkedId), /already has an Artsy listing/);
    assert.match(reason(editionId), /edition/);

    const z = readZip(zip);
    const readme = z.get('README.txt')().toString('utf8');
    assert.match(readme, /Nothing has been sent to Artsy/);
    assert.match(readme, /Included: 150 work\(s\) in 2 batch\(es\)/);
    const xlsxNames = [...z.keys()].filter((n) => /artsy-bulk-import-\d+\.xlsx$/.test(n)).sort();
    assert.deepEqual(xlsxNames, ['batch-1/artsy-bulk-import-1.xlsx', 'batch-2/artsy-bulk-import-2.xlsx']);
    let total = 0;
    for (const n of xlsxNames) {
      const rows = parseXLSX(z.get(n)());
      assert.equal(rows[0][0], 'Inventory ID');
      assert.equal(rows[0][1], 'Artist Name');
      assert.ok(rows.length - 1 <= ARTSY_BATCH_LIMIT, `${n} has ${rows.length - 1} rows`);
      assert.ok(rows.length - 1 > 0);
      total += rows.length - 1;
      const csv = parseCSV(z.get(n.replace(/\.xlsx$/, '.csv'))().toString('utf8'));
      assert.equal(csv.length, rows.length);
      // Every image named in the sheet is in the batch's images folder.
      const imgCol = rows[0].indexOf('Image Files');
      for (const r of rows.slice(1)) for (const f of String(r[imgCol]).split('|').filter(Boolean)) assert.ok(z.has(`${n.split('/')[0]}/images/${f}`), `image ${f}`);
    }
    assert.equal(total, 150);
    const skippedCsv = parseCSV(z.get('skipped.csv')().toString('utf8'));
    assert.equal(skippedCsv.length - 1, 5);

    const c = connectors(ws.db).find((x) => x.channel === 'artsy');
    assert.equal(c.state, 'file_exchange');
    assert.notEqual(c.state, 'api_connected');
    assert.equal(c.unresolved, 150);
    assert.match(c.last_action, /Not confirmed in Artsy/);
    assert.equal(c.listings, 1);
    // No connector row ever claims an API connection.
    assert.ok(connectors(ws.db).every((x) => ['not_connected', 'file_exchange'].includes(x.state)));

    const rec = artsyReconciliation(ws.db);
    assert.equal(rec.items.length, 1);
    assert.equal(rec.items[0].id, linkedId);
    assert.match(rec.csv, /already-there/);
  } finally { ws.close(); }
});
