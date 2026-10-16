import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodePNG, imageSize, readPNGSize } from '../lib/png.mjs';
import { writeXlsx } from '../lib/xlsx-write.mjs';
import { readZip } from '../lib/zip.mjs';
import { generateDemo } from '../demo/generate.mjs';

// Small quote-aware CSV parser (CRLF or LF) for checking generator output.
function parseCSV(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  const headers = rows[0];
  return { headers, records: rows.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? '']))) };
}

test('PNG encode round-trips dimensions through imageSize', () => {
  const w = 37, h = 21;
  const rgb = new Uint8Array(w * h * 3).map((_, i) => (i * 7) & 255);
  const png = encodePNG(w, h, rgb);
  assert.equal(png.readUInt32BE(0), 0x89504e47);
  assert.deepEqual(readPNGSize(png), { width: w, height: h });
  assert.deepEqual(imageSize(png), { width: w, height: h, type: 'png' });
  assert.deepEqual(imageSize(Buffer.from('not an image')), { width: null, height: null, type: null });
});

test('imageSize reads a minimal JPEG SOF0 header', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, // APP0 with 2 data bytes
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x01, 0x2c, 0x02, 0x58, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]);
  assert.deepEqual(imageSize(jpeg), { width: 600, height: 300, type: 'jpeg' });
});

test('writeXlsx produces a zip with a sheet containing the header', () => {
  const buf = writeXlsx([['Stock No.', 'Price & "Notes"'], ['A-1', 1200], ['B<2', 'hello, world']]);
  const zip = readZip(buf);
  for (const name of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']) {
    assert.ok(zip.has(name), `missing ${name}`);
  }
  const sheet = zip.get('xl/worksheets/sheet1.xml')().toString();
  assert.match(sheet, /<t xml:space="preserve">Stock No\.<\/t>/);
  assert.match(sheet, /Price &amp; &quot;Notes&quot;/);
  assert.match(sheet, /<c r="B2"><v>1200<\/v><\/c>/);
  assert.match(sheet, /B&lt;2/);
  assert.match(zip.get('xl/workbook.xml')().toString(), /name="Inventory"/);
});

test('generateDemo writes a consistent fixture set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'og-demo-'));
  try {
    const r = generateDemo(dir, { works: 60, seed: 7 });
    for (const f of ['inventory.csv', 'inventory.xlsx', 'reimport.csv', 'scenario.json', 'private-sentinels.json', 'images/LICENSE.txt']) {
      assert.ok(existsSync(join(dir, f)), `missing ${f}`);
    }
    const scenario = JSON.parse(readFileSync(join(dir, 'scenario.json'), 'utf8'));
    assert.deepEqual(scenario, r.scenario);
    const inv = parseCSV(readFileSync(join(dir, 'inventory.csv'), 'utf8'));
    const re = parseCSV(readFileSync(join(dir, 'reimport.csv'), 'utf8'));
    assert.equal(inv.records.length, 60);
    assert.deepEqual(inv.headers, scenario.headers);
    assert.ok(!re.headers.includes(scenario.droppedColumn));
    assert.ok(re.headers.includes(scenario.addedColumn));

    const byStock = (p) => new Map(p.records.map((x) => [x['Stock No.'], x]));
    const a = byStock(inv), b = byStock(re);
    assert.equal(a.get(scenario.missingTitleStock)['Title'], '');
    assert.equal(a.get(scenario.poaStock)['Price (USD)'], 'POA');
    for (const s of scenario.cmStocks) { assert.match(a.get(s)['Dimensions'], /cm$/); assert.equal(a.get(s)['Height (in)'], ''); }
    for (const s of scenario.priceChanged) assert.notEqual(a.get(s)['Price (USD)'], b.get(s)['Price (USD)']);
    for (const s of scenario.newlySold) { assert.equal(a.get(s)['Status'], 'Available'); assert.equal(b.get(s)['Status'], 'Sold'); }
    assert.equal(a.get(scenario.staleResurrection)['Status'], 'Sold');
    assert.equal(b.get(scenario.staleResurrection)['Status'], 'Available');
    assert.ok(a.has(scenario.removed) && !b.has(scenario.removed));
    for (const s of scenario.added) assert.ok(!a.has(s) && b.has(s));
    const { newStock, matchesStock } = scenario.nearDuplicate;
    assert.ok(!a.has(newStock) && b.has(newStock));
    assert.equal(b.get(newStock)['Title'].replace(/\s+/g, ' ').trim().toLowerCase(), a.get(matchesStock)['Title'].toLowerCase());
    assert.equal(b.get(newStock)['Artist'], a.get(matchesStock)['Artist']);
    assert.equal(re.records.length, 60 - 1 + 1 + 3);

    const images = readdirSync(join(dir, 'images'));
    for (const s of [...a.keys(), ...scenario.added]) assert.ok(images.includes(`${s}.png`), `image for ${s}`);
    for (const s of scenario.secondViews) assert.ok(images.includes(`${s}_2.png`));
    for (const f of scenario.unmatchedImages) assert.ok(images.includes(f));
    const first = readFileSync(join(dir, 'images', `${scenario.cmStocks[0]}.png`));
    const dims = imageSize(first);
    assert.equal(dims.type, 'png');
    assert.equal(Math.max(dims.width, dims.height), 900);

    const sentinels = JSON.parse(readFileSync(join(dir, 'private-sentinels.json'), 'utf8'));
    assert.ok(sentinels.all.length > 60);
    assert.ok(sentinels.notes.every((n) => n.includes('PRIVATE-NOTE-')));
    assert.ok(sentinels.consignors.length > 0 && sentinels.consignors.every((n) => n.includes('PRIVATE-CONSIGNOR-')));
    const publicText = inv.records.map((x) => inv.headers.filter((h) => !scenario.privateColumns.includes(h)).map((h) => x[h]).join('\n')).join('\n');
    const leaks = sentinels.all.filter((v) => publicText.includes(v));
    assert.deepEqual(leaks, []);

    // Deterministic: a second run with the same seed is byte-identical.
    const dir2 = mkdtempSync(join(tmpdir(), 'og-demo-'));
    generateDemo(dir2, { works: 60, seed: 7 });
    assert.ok(readFileSync(join(dir, 'inventory.csv')).equals(readFileSync(join(dir2, 'inventory.csv'))));
    assert.ok(readFileSync(join(dir, 'images', `${scenario.added[0]}.png`)).equals(readFileSync(join(dir2, 'images', `${scenario.added[0]}.png`))));
    rmSync(dir2, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('generateDemo large fixture without images', () => {
  const dir = mkdtempSync(join(tmpdir(), 'og-demo-large-'));
  try {
    generateDemo(dir, { works: 1500, images: false });
    const inv = parseCSV(readFileSync(join(dir, 'inventory.csv'), 'utf8'));
    assert.equal(inv.records.length, 1500);
    assert.ok(!existsSync(join(dir, 'images')));
    assert.ok(!existsSync(join(dir, 'reimport.csv')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
