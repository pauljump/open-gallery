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
  db.prepare("INSERT INTO meta(key,value) VALUES ('demo','true') ON CONFLICT(key) DO UPDATE SET value='true'").run();
  audit(db, 'demo.seed', null, null, { works: result.created, images: images.matched });
  return { import: result, images, exhibition: ex.id, published: publishable.length };
}
