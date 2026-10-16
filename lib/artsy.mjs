// Artsy file exchange. This is NOT an API integration: Open Gallery has no Artsy credentials.
// It prepares a spreadsheet for Artsy's partner bulk import (which you upload yourself in
// Artsy CMS) and a checklist for works already listed there.
//
// Source of the format (checked 2026-10-16): partners.artsy.net/product-updates/bulk-import-launch
// and the bulk-import updates post. Documented: one row per artwork, up to 100 per import,
// .xlsx recommended or .csv; required Artist Name, Artwork Title, Year, Price (numbers only,
// currency from account settings); dimensions are numbers with units from account or batch
// settings; images matched by filenames in an "Image Files" column separated by "," or "|";
// availability and shipping are completed in CMS after import; unique works only.
// Artsy maps columns on screen, so header names below follow the documented field names.
// The current downloadable CMS template could not be checked without a partner login.
import { writeZip } from './zip.mjs';
import { writeXlsx } from './xlsx-write.mjs';
import { toCSV } from './tables.mjs';
import { getArtwork } from './store.mjs';
import { getSettings } from './settings.mjs';
import { now, audit } from './db.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const ARTSY_BATCH_LIMIT = 100;
export const ARTSY_HEADERS = ['Inventory ID', 'Artist Name', 'Artwork Title', 'Year', 'Price', 'Medium', 'Height', 'Width', 'Depth', 'Diameter',
  'Framed Dimensions', 'Signature', 'Artwork Condition', 'Description', 'Exhibition History', 'Bibliography', 'Provenance', 'Image Rights', 'Image Files'];

const convert = (n, from, to) => {
  if (n == null || from === to || !from) return n;
  const cm = from === 'in' ? n * 2.54 : from === 'mm' ? n / 10 : n;
  const out = to === 'in' ? cm / 2.54 : cm;
  return Math.round(out * 100) / 100;
};

function checkWork(aw) {
  const problems = [];
  if (!aw.artist) problems.push('missing artist');
  if (!aw.title) problems.push('missing title');
  if (!aw.year) problems.push('missing year (required by Artsy)');
  if (aw.price == null) problems.push('missing price (required by Artsy)');
  if (aw.links.some((l) => l.channel === 'artsy')) problems.push('already has an Artsy listing; use the reconciliation checklist instead');
  if (aw.availability === 'sold') problems.push('marked sold');
  if (aw.edition && !/unique/i.test(aw.edition)) problems.push('edition works are not supported by Artsy bulk import (unique works only)');
  if (!aw.media.length) problems.push('no image');
  return problems;
}

export function artsyCandidates(db) {
  const rows = db.prepare('SELECT id FROM artworks ORDER BY stock_number').all();
  return rows.map((r) => getArtwork(db, r.id)).map((aw) => ({ id: aw.id, stock_number: aw.stock_number, artist: aw.artist, title: aw.title, year: aw.year, price: aw.price,
    hasArtsyLink: aw.links.some((l) => l.channel === 'artsy'), problems: checkWork(aw) }));
}

/** ids: works the gallery chose. Returns { zip, report }. Nothing is sent anywhere. */
export function buildArtsyPackage(db, dataDir, ids, { unit } = {}) {
  const settings = getSettings(db);
  const targetUnit = unit || settings.catalog.units;
  const ok = []; const skipped = [];
  for (const id of ids) {
    const aw = getArtwork(db, id);
    if (!aw) continue;
    const problems = checkWork(aw);
    if (problems.length) skipped.push({ id, stock: aw.stock_number, title: aw.title, artist: aw.artist, problems }); else ok.push(aw);
  }
  const entries = [];
  const batches = [];
  for (let i = 0; i < ok.length; i += ARTSY_BATCH_LIMIT) batches.push(ok.slice(i, i + ARTSY_BATCH_LIMIT));
  batches.forEach((batch, bi) => {
    const rows = [ARTSY_HEADERS];
    for (const aw of batch) {
      const work = aw.dims.find((d) => d.kind === 'work') || {};
      const framed = aw.dims.find((d) => d.kind === 'framed');
      const base = (aw.stock_number || aw.id).replace(/[^\w.-]+/g, '_');
      const files = aw.media.map((m, j) => {
        const name = `${base}_${j + 1}.${m.ext}`;
        entries.push({ name: `batch-${bi + 1}/images/${name}`, data: readFileSync(join(dataDir, 'media', `${m.sha256}.${m.ext}`)) });
        return name;
      });
      rows.push([aw.stock_number || '', aw.artist, aw.title, aw.year, aw.price_max ? `${aw.price} - ${aw.price_max}` : aw.price, aw.medium || '',
        convert(work.h, work.unit, targetUnit) ?? '', convert(work.w, work.unit, targetUnit) ?? '', convert(work.d, work.unit, targetUnit) ?? '', convert(work.diameter, work.unit, targetUnit) ?? '',
        framed ? [framed.h, framed.w, framed.d].filter((x) => x != null).map((n) => convert(n, framed.unit, targetUnit)).join(' x ') : '',
        aw.signature || '', aw.condition || '', aw.description || '', aw.exhibition_history || '', aw.literature || '', aw.provenance || '', aw.image_credit || '', files.join('|')]);
    }
    entries.push({ name: `batch-${bi + 1}/artsy-bulk-import-${bi + 1}.xlsx`, data: writeXlsx(rows, 'Artworks') });
    entries.push({ name: `batch-${bi + 1}/artsy-bulk-import-${bi + 1}.csv`, data: toCSV(rows) });
  });
  const report = { createdAt: now(), unit: targetUnit, currency: settings.catalog.currency, included: ok.length, batches: batches.length, skipped };
  entries.push({ name: 'README.txt', data: `Artsy bulk-import package prepared by Open Gallery on ${report.createdAt}

Nothing has been sent to Artsy. To use this package:
1. Sign in to Artsy CMS and open Bulk Import (it accepts up to ${ARTSY_BATCH_LIMIT} works per import).
2. Upload one batch spreadsheet (.xlsx recommended, .csv also provided).
3. Check the column mapping Artsy shows you. Headers follow Artsy's documented field names.
4. Set units to ${targetUnit === 'in' ? 'inches' : 'centimetres'} and currency to ${report.currency} in Edit Import Settings. Dimensions here are in ${targetUnit}.
5. Upload the images in that batch's images folder when asked; file names match the Image Files column.
6. After import, complete Availability and Shipping in Artsy CMS. Artsy's import does not take them.
7. When a work is live, paste its Artsy link into the work in Open Gallery so the two stay connected.

Included: ${ok.length} work(s) in ${batches.length} batch(es).
Left out: ${skipped.length} work(s), listed in skipped.csv with the reason.

This package was built from Artsy's public product notes. Compare it with the template in your
own Artsy CMS before relying on it for a large upload.
` });
  entries.push({ name: 'skipped.csv', data: toCSV([['Inventory number', 'Artist', 'Title', 'Reason'], ...skipped.map((s) => [s.stock, s.artist, s.title, s.problems.join('; ')])]) });
  db.prepare(`UPDATE connectors SET state='file_exchange', last_action=?, last_action_at=?, last_success_at=?, unresolved=? WHERE channel='artsy'`)
    .run(`Prepared a bulk-import file for ${ok.length} work(s). Not confirmed in Artsy until you add each listing link.`, report.createdAt, report.createdAt, ok.length);
  audit(db, 'artsy.package', null, null, { included: ok.length, skipped: skipped.length });
  return { zip: writeZip(entries), report };
}

/** Checklist for works that already have Artsy links: compare by hand, since there is no API access. */
export function artsyReconciliation(db) {
  const rows = db.prepare("SELECT DISTINCT artwork_id FROM channel_links WHERE channel='artsy'").all();
  const settings = getSettings(db);
  const items = rows.map((r) => getArtwork(db, r.artwork_id)).filter(Boolean).map((aw) => ({
    id: aw.id, stock: aw.stock_number, artist: aw.artist, title: aw.title, availability: aw.availability,
    price: aw.price, currency: aw.currency || settings.catalog.currency, url: aw.links.find((l) => l.channel === 'artsy').url,
    updated_at: aw.updated_at,
  }));
  const csv = toCSV([['Inventory number', 'Artist', 'Title', 'Availability here', 'Price here', 'Currency', 'Artsy link', 'Updated here', 'Availability matches on Artsy? (yes/no)', 'Price matches on Artsy? (yes/no)', 'Notes'],
    ...items.map((i) => [i.stock, i.artist, i.title, i.availability, i.price ?? '', i.currency, i.url, i.updated_at, '', '', ''])]);
  return { items, csv };
}

export function connectors(db) {
  const links = Object.fromEntries(db.prepare('SELECT channel, COUNT(DISTINCT artwork_id) n FROM channel_links GROUP BY channel').all().map((r) => [r.channel, r.n]));
  return db.prepare('SELECT * FROM connectors ORDER BY channel').all().map((c) => ({ ...c, listings: links[c.channel] || 0 }));
}
