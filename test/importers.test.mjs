// Importers: other systems' spreadsheet layouts, image file names and links, and a gallery's own website.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { workspace } from './helpers.mjs';
import { uploadImport, previewImport, applyImport, importImages, fetchImportImages } from '../lib/importer.mjs';
import { listArtworks, getArtwork } from '../lib/store.mjs';
import { crawlSite, worksToCSV } from '../lib/siteimport.mjs';
import { encodePNG } from '../lib/png.mjs';
import { safeFetch } from '../lib/fetchsafe.mjs';

const png = (shade) => encodePNG(6, 4, new Uint8Array(72).fill(shade));

test('an Artsy-style bulk sheet maps itself and matches images by file name', () => {
  const ws = workspace();
  try {
    const csv = 'Inventory ID (OPTIONAL),Artist name (REQUIRED) ,Title (REQUIRED) ,Year (REQUIRED) ,Price (REQUIRED),Height (OPTIONAL),Width (OPTIONAL),Image Files\nAX-1,Rhea Example,Tide,2024,4500,20,16,tide_front.png|tide_back.png\n';
    const up = uploadImport(ws.db, ws.dir, 'artsy.csv', Buffer.from(csv));
    assert.deepEqual(up.mapping, ['stock_number', 'artist', 'title', 'year', 'price', 'height', 'width', 'image_files']);
    applyImport(ws.db, ws.dir, up.id);
    const r = importImages(ws.db, ws.dir, [{ name: 'TIDE_BACK.png', buf: png(30) }, { name: 'tide_front.png', buf: png(200) }]);
    assert.equal(r.matched, 2);
    const aw = getArtwork(ws.db, listArtworks(ws.db).rows[0].id);
    assert.deepEqual(aw.media.map((m) => m.original_name.toLowerCase()), ['tide_front.png', 'tide_back.png'], 'order follows the sheet');
  } finally { ws.close(); }
});

test('a unit column sets centimetres for numeric dimensions', () => {
  const ws = workspace();
  try {
    const csv = 'Inventory Number,Artist Name,Title,Year Created,Height,Width,Unit,Retail Price,Status\nAC-9,Lio Example,Fold,2023,120,90,cm,"8,000",Available\n';
    const up = uploadImport(ws.db, ws.dir, 'artcloud.csv', Buffer.from(csv));
    assert.ok(up.mapping.includes('dim_unit'));
    applyImport(ws.db, ws.dir, up.id);
    const aw = getArtwork(ws.db, listArtworks(ws.db).rows[0].id);
    assert.deepEqual(aw.dims[0], { kind: 'work', h: 120, w: 90, unit: 'cm' });
    assert.equal(aw.price, 8000);
  } finally { ws.close(); }
});

function fixtureSite() {
  const pages = {
    '/': '<html><body><a href="/artworks/tide">Tide</a> <a href="/works/fold-study/">Fold</a> <a href="/about">About</a> <a href="/private/secret">x</a> <a href="https://elsewhere.example/">out</a></body></html>',
    '/artworks/tide': `<html><head><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'VisualArtwork', name: 'Tide', creator: { '@type': 'Person', name: 'Rhea Example' }, dateCreated: '2024', artMedium: 'Oil on linen', height: { '@type': 'QuantitativeValue', value: 50, unitText: 'cm' }, width: { '@type': 'QuantitativeValue', value: 40, unitText: 'cm' }, image: '/img/tide.png', offers: { '@type': 'Offer', price: 4500, priceCurrency: 'EUR', availability: 'https://schema.org/InStock' } })}</script></head><body><h1>Tide</h1></body></html>`,
    '/works/fold-study/': '<html><head><meta property="og:title" content="Lio Example, Fold Study, 2023"><meta property="og:image" content="/img/fold.png"></head><body><h1>Fold Study</h1><p>Acrylic on canvas</p><p>36 x 48 in</p><p>$12,000</p></body></html>',
    '/about': '<html><head><meta property="og:image" content="/img/logo.png"></head><body><h1>About us</h1><p>We are a gallery.</p></body></html>',
    '/private/secret': '<html><head><meta property="og:image" content="/img/x.png"></head><body>Oil on canvas 10 x 10 in</body></html>',
    '/robots.txt': 'User-agent: *\nDisallow: /private\n',
  };
  const server = createServer((req, res) => {
    const path = req.url.split('?')[0];
    if (path.startsWith('/img/')) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(png(path.length * 7)); }
    if (!(path in pages)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': path.endsWith('.txt') ? 'text/plain' : 'text/html; charset=utf-8' });
    res.end(pages[path]);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

test('importing from the gallery website finds artwork pages, respects robots.txt and fetches images', async () => {
  const { server, base } = await fixtureSite();
  const ws = workspace();
  try {
    const crawl = await crawlSite(`${base}/`, { allowPrivate: true });
    assert.equal(crawl.works.length, 2);
    assert.ok(crawl.pages >= 4 && crawl.pages <= 5, `pages ${crawl.pages}`);
    const tide = crawl.works.find((w) => w.title === 'Tide');
    assert.equal(tide.artist, 'Rhea Example');
    assert.equal(tide.dimensions, '50 x 40 cm');
    assert.equal(tide.currency, 'EUR');
    const fold = crawl.works.find((w) => w.title === 'Fold Study');
    assert.equal(fold.artist, 'Lio Example');
    assert.equal(fold.year, '2023');
    assert.equal(fold.dimensions, '36 x 48 in');
    assert.equal(fold.price, '12,000');
    assert.ok(!crawl.works.some((w) => /secret/.test(w.url)), 'robots.txt Disallow is respected');
    const up = uploadImport(ws.db, ws.dir, 'website.csv', Buffer.from(worksToCSV(crawl.works)));
    assert.ok(up.mapping.includes('image_urls') && up.mapping.includes('website_url'));
    applyImport(ws.db, ws.dir, up.id);
    const blocked = await fetchImportImages(ws.db, ws.dir, up.id, { allowPrivate: false });
    assert.equal(blocked.added, 0);
    assert.match(blocked.failed[0].error, /private network/);
    const f = await fetchImportImages(ws.db, ws.dir, up.id, { allowPrivate: true });
    assert.equal(f.added, 2);
    const again = await fetchImportImages(ws.db, ws.dir, up.id, { allowPrivate: true });
    assert.equal(again.duplicates, 2, 'running it twice adds nothing');
    const rows = listArtworks(ws.db).rows;
    assert.ok(rows.every((r) => r.thumb));
    assert.equal(getArtwork(ws.db, rows.find((r) => r.title === 'Tide').id).links[0].channel, 'website');
  } finally { ws.close(); server.close(); }
});

test('safe fetch refuses private addresses and non-web schemes', async () => {
  await assert.rejects(safeFetch('http://127.0.0.1:1/'), /private network/);
  await assert.rejects(safeFetch('http://10.0.0.5/x'), /private network/);
  await assert.rejects(safeFetch('file:///etc/passwd'), /Only http/);
  await assert.rejects(safeFetch('http://[::1]/'), /private network/);
});
