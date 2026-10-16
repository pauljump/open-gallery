// Public output never carries private data, and withdrawn works are announced in the feed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { workspace, fixture, scenario, sentinels, csvRecords, importFile, byStock, walk, tmp, rm } from './helpers.mjs';
import { seedDemo } from '../lib/demo-seed.mjs';
import { buildSite, publicArtwork } from '../lib/site.mjs';
import { getArtwork, updateArtwork, saveExhibition, saveCustomField, listCustomFields } from '../lib/store.mjs';
import { getSettings, updateSettings } from '../lib/settings.mjs';

const fx = fixture();
const sc = scenario(fx);
const sent = sentinels(fx);

const numericRe = (v) => new RegExp(`(?<![0-9a-f])${v}(?![0-9a-f])`);

function siteText(outDir) {
  const files = walk(outDir).filter((f) => /\.(html|json|css|txt)$/.test(f));
  assert.ok(files.length > 10, 'site has pages');
  return files.map((f) => ({ file: f, text: readFileSync(join(outDir, f), 'utf8') }));
}

function assertNoLeaks(outDir, extraStrings = []) {
  const pages = siteText(outDir);
  const leaks = [];
  for (const { file, text } of pages) {
    for (const v of [...sent.costs, ...sent.insurance]) if (numericRe(v).test(text)) leaks.push(`${file}: number ${v}`);
    for (const v of [...sent.notes, ...sent.consignors]) if (text.includes(v)) leaks.push(`${file}: ${v.slice(0, 40)}`);
    if (text.includes('PRIVATE-NOTE-') || text.includes('PRIVATE-CONSIGNOR-')) leaks.push(`${file}: sentinel prefix`);
    for (const v of extraStrings) if (text.includes(v)) leaks.push(`${file}: ${v}`);
  }
  assert.deepEqual(leaks, []);
}

test('published site and catalog feed contain no private sentinels, locations, extras or unpublished works', () => {
  const ws = workspace();
  const out = join(tmp('og-site-'), 'site');
  try {
    seedDemo(ws.db, ws.dir);
    const { headers, records } = csvRecords(join(fx, 'inventory.csv'));
    const locations = [...new Set(records.map((r) => r['Location']).filter(Boolean))];
    const frameNotes = [...new Set(records.map((r) => r['Frame notes']).filter(Boolean))];
    assert.ok(locations.length > 3 && frameNotes.length > 2);

    // Mix of states: one unpublished work, a hidden price, an on-request price, custom fields.
    const rows = ws.db.prepare("SELECT id, stock_number FROM artworks WHERE availability='available' AND price IS NOT NULL ORDER BY stock_number").all();
    assert.ok(rows.length > 6);
    const [hiddenId, unpubId, onReqId, customId] = rows.map((r) => r.id);
    updateArtwork(ws.db, hiddenId, { price_visibility: 'hidden' });
    updateArtwork(ws.db, unpubId, { public: false, description: 'UNPUBLISHED-WORK-DESCRIPTION' });
    updateArtwork(ws.db, onReqId, { price_visibility: 'on_request' });
    saveCustomField(ws.db, { key: 'framer', label: 'Framer', visibility: 'public' });
    saveCustomField(ws.db, { key: 'vault', label: 'Vault code', visibility: 'private' });
    updateArtwork(ws.db, customId, { custom: { framer: 'PUBLIC-FRAMER-VALUE', vault: 'PRIVATE-VAULT-4471' } });
    // An exhibition that hides prices, containing a work whose price is otherwise shown.
    const pricedId = rows[5].id;
    const priced = getArtwork(ws.db, pricedId);
    assert.equal(priced.price_visibility, 'show');
    saveExhibition(ws.db, null, { title: 'No Prices Here', published: true, show_prices: false, items: [pricedId] });

    const report = buildSite(ws.db, ws.dir, out);
    assert.ok(existsSync(join(out, 'index.html')) && existsSync(join(out, 'catalog.json')) && existsSync(join(out, 'robots.txt')) && existsSync(join(out, 'assets', 'site.css')));
    assert.equal(report.works, ws.db.prepare('SELECT COUNT(*) n FROM artworks WHERE public=1').get().n);
    assertNoLeaks(out, [...locations, ...frameNotes, 'UNPUBLISHED-WORK-DESCRIPTION', 'PRIVATE-VAULT-4471', 'Vault code']);

    const feed = JSON.parse(readFileSync(join(out, 'catalog.json'), 'utf8'));
    const ids = new Set(feed.works.map((w) => w.id));
    assert.ok(!ids.has(unpubId), 'unpublished work not in feed');
    assert.ok(!walk(out).some((f) => f.includes(unpubId.slice(-6))), 'unpublished work has no page');
    for (const w of feed.works) {
      for (const k of ['private', 'extra', 'origin', 'cost', 'location', 'notes', 'consignor', 'stock_number_private']) assert.ok(!(k in w) || w[k] === null, `feed work exposes ${k}`);
      assert.ok(!('Frame notes' in (w.custom || {})));
    }
    const feedById = Object.fromEntries(feed.works.map((w) => [w.id, w]));
    assert.equal(feedById[hiddenId].price, null, 'hidden price is absent');
    assert.deepEqual(feedById[onReqId].price, { display: 'Price on request' });
    assert.equal(feedById[customId].custom.Framer, 'PUBLIC-FRAMER-VALUE');
    assert.ok(!('Vault code' in feedById[customId].custom));
    const pricedPage = readFileSync(join(out, 'works', feedById[pricedId].slug, 'index.html'), 'utf8');
    assert.ok(pricedPage.includes(feedById[pricedId].price.display));
    assert.ok(pricedPage.includes('PUBLIC-FRAMER-VALUE') || customId !== pricedId);
    const customPage = readFileSync(join(out, 'works', feedById[customId].slug, 'index.html'), 'utf8');
    assert.ok(customPage.includes('PUBLIC-FRAMER-VALUE'));
    assert.ok(!customPage.includes('PRIVATE-VAULT-4471'));
    const hiddenPage = readFileSync(join(out, 'works', feedById[hiddenId].slug, 'index.html'), 'utf8');
    const hiddenPrice = getArtwork(ws.db, hiddenId).price;
    assert.ok(!numericRe(String(hiddenPrice)).test(hiddenPage.replace(/aw_\w+/g, '')), 'hidden price not on its page');
    assert.ok(!hiddenPage.includes('Price on request'));
    // Exhibition with show_prices=false: the work's price is absent from that page and print catalog.
    const exPage = readFileSync(join(out, 'exhibitions', 'no-prices-here', 'index.html'), 'utf8');
    const printPage = readFileSync(join(out, 'exhibitions', 'no-prices-here', 'print.html'), 'utf8');
    assert.ok(!exPage.includes(feedById[pricedId].price.display));
    assert.ok(!printPage.includes(feedById[pricedId].price.display));
    assert.ok(exPage.includes(feedById[pricedId].title.replace(/&/g, '&amp;')));
    // Stock numbers stay off the site unless the gallery opts in.
    assert.equal(getSettings(ws.db).catalog.showStockNumbers, false);
    assert.ok(!feed.works.some((w) => w.stock_number));
    assert.ok(!siteText(out).some((p) => /GL-1\d\d\d/.test(p.text)));

    // publicArtwork is the allowlist: a sold work shows no price either way.
    const sold = ws.db.prepare("SELECT id FROM artworks WHERE availability='sold' AND price IS NOT NULL LIMIT 1").get();
    const pub = publicArtwork(getArtwork(ws.db, sold.id), getSettings(ws.db), listCustomFields(ws.db).filter((f) => f.visibility === 'public'));
    assert.equal(pub.price, null);
    assert.equal(pub.availability, 'sold');
  } finally { ws.close(); rm(join(out, '..')); }
});

test('showPrices=never hides every price; mixed header inputs still never leak', () => {
  const ws = workspace();
  const out = join(tmp('og-site2-'), 'site');
  try {
    importFile(ws.db, ws.dir, 'inventory.csv', readFileSync(join(fx, 'inventory.csv')));
    ws.db.prepare('UPDATE artworks SET public=1').run();
    updateSettings(ws.db, { 'catalog.showPrices': 'never' });
    buildSite(ws.db, ws.dir, out);
    const feed = JSON.parse(readFileSync(join(out, 'catalog.json'), 'utf8'));
    assert.ok(feed.works.length > 50);
    assert.ok(feed.works.every((w) => !w.price || w.price.amount == null));
    assertNoLeaks(out);
  } finally { ws.close(); rm(join(out, '..')); }
});

test('withdrawal: unpublishing a work moves it to the feed withdrawn list on the next build', () => {
  const ws = workspace();
  const out = join(tmp('og-site3-'), 'site');
  try {
    seedDemo(ws.db, ws.dir);
    buildSite(ws.db, ws.dir, out);
    const feed1 = JSON.parse(readFileSync(join(out, 'catalog.json'), 'utf8'));
    assert.deepEqual(feed1.withdrawn, []);
    const victim = feed1.works[3];
    updateArtwork(ws.db, victim.id, { public: false });
    const report = buildSite(ws.db, ws.dir, out);
    assert.equal(report.withdrawn, 1);
    const feed2 = JSON.parse(readFileSync(join(out, 'catalog.json'), 'utf8'));
    assert.ok(!feed2.works.some((w) => w.id === victim.id));
    assert.deepEqual(feed2.withdrawn.map((w) => w.id), [victim.id]);
    assert.ok(feed2.withdrawn[0].withdrawn_at);
    assert.ok(!existsSync(join(out, 'works', victim.slug, 'index.html')));
    // first_published_at is stable across builds.
    const other = feed2.works.find((w) => w.id === feed1.works[0].id);
    assert.equal(other.first_published_at, feed1.works[0].first_published_at);
    // Re-publishing removes it from withdrawn again.
    updateArtwork(ws.db, victim.id, { public: true });
    buildSite(ws.db, ws.dir, out);
    const feed3 = JSON.parse(readFileSync(join(out, 'catalog.json'), 'utf8'));
    assert.deepEqual(feed3.withdrawn, []);
    assert.ok(feed3.works.some((w) => w.id === victim.id));
  } finally { ws.close(); rm(join(out, '..')); }
});
