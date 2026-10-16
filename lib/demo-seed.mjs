// Fill an empty workspace with a fictional gallery so anyone can try the full workflow
// without their own files, an account or an API key. It uses the same import path a
// gallery's real spreadsheet would.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { generateDemo } from '../demo/generate.mjs';
import { uploadImport, previewImport, applyImport, importImages } from './importer.mjs';
import { updateSettings } from './settings.mjs';
import { saveExhibition, listArtworks, updateArtwork, getArtwork } from './store.mjs';
import { audit } from './db.mjs';
import * as L from './ledger.mjs';

export function seedDemo(db, dataDir) {
  const src = join(dataDir, 'demo-files');
  generateDemo(src, { works: 60, seed: 7 });
  const up = uploadImport(db, dataDir, 'inventory.csv', readFileSync(join(src, 'inventory.csv')));
  const preview = previewImport(db, dataDir, up.id);
  const decisions = {};
  for (const p of preview.plan) if (p.action === 'review') decisions[p.row] = { match: 'create' };
  const result = applyImport(db, dataDir, up.id, { decisions });
  const imgDir = join(src, 'images');
  const files = readdirSync(imgDir).filter((f) => /\.(png|jpe?g)$/i.test(f)).map((name) => ({ name, buf: readFileSync(join(imgDir, name)) }));
  const images = importImages(db, dataDir, files);
  updateSettings(db, {
    'gallery.name': 'Harbor Room Gallery',
    'gallery.tagline': 'A fictional gallery used to demonstrate Open Gallery. Every artist, work and price here is invented.',
    'gallery.email': 'hello@example.com',
    'gallery.address': '12 Example Street, Anytown',
  });
  // Publish the available works that have images; keep everything else private.
  const rows = listArtworks(db, { limit: 5000 }).rows;
  const publishable = rows.filter((r) => r.thumb && r.availability !== 'unknown');
  for (const r of publishable) updateArtwork(db, r.id, { public: true });
  const pick = publishable.filter((r) => r.availability === 'available').slice(0, 9).map((r) => r.id);
  const sold = publishable.find((r) => r.availability === 'sold');
  if (sold) pick.push(sold.id);
  const ex = saveExhibition(db, null, {
    title: 'Quiet Weather',
    subtitle: 'Paintings and works on paper',
    dates: 'November 6 – December 20',
    intro: 'A demonstration exhibition assembled from the sample inventory. Change the title, order, layout and text in Exhibitions.',
    published: true, layout: 'grid', show_prices: true, items: pick,
  });
  // A few months of invented operations so Money, Contacts and statements have something to show.
  const day = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const avail = listArtworks(db, { availability: 'available', limit: 5000 }).rows.filter((r) => r.price);
  avail.forEach((r, i) => L.saveConsignment(db, null, { artwork_id: r.id, from: i % 7 === 6 ? 'contact' : 'artist', contact: 'Example Collector Trust', split_pct: i % 7 === 6 ? 70 : 50, discount_limit_pct: 10, start_date: day(-120), end_date: day(i % 5 === 0 ? 20 : 240) }));
  const sellNow = avail.slice(-4);
  const buyers = ['Example Buyer One', 'Example Buyer Two', 'Example Buyer Three', 'Example Buyer Four'];
  sellNow.forEach((r, i) => {
    const s = L.recordSale(db, r.id, { price: Math.round(r.price * (i === 1 ? 0.92 : 1)), buyer: buyers[i], sale_date: day(-70 + i * 15), deposit: Math.round(r.price * 0.25), invoice_number: `DEMO-${101 + i}`, discount_approved: true });
    if (i < 3) L.addPayment(db, s.id, { amount: (s.total_cents - s.paid_cents) / 100, paid_on: day(-60 + i * 15) });
    if (i === 0) { L.addDeduction(db, s.id, { description: 'Framing', amount: 240 }); }
  });
  const first = L.saleDetail(db, db.prepare('SELECT id FROM sales ORDER BY sale_date LIMIT 1').get().id);
  if (first.payout_status === 'overdue' || first.payout_status === 'payable') L.recordPayout(db, { payee_type: first.consignment.contact_id ? 'contact' : 'artist', payee_id: first.consignment.contact_id || first.consignment.artist_id, sale_ids: [first.id], paid_on: day(-20), method: 'Bank transfer' });
  const holdOn = listArtworks(db, { availability: 'available', limit: 5000 }).rows[0];
  if (holdOn) L.placeHold(db, holdOn.id, { contact: 'Example Buyer Five', hours: 20 });
  db.prepare("INSERT INTO meta(key,value) VALUES ('demo','true') ON CONFLICT(key) DO UPDATE SET value='true'").run();
  audit(db, 'demo.seed', null, null, { works: result.created, images: images.matched });
  return { import: result, images, exhibition: ex.id, published: publishable.length };
}
