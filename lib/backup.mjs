// Complete export and restore. The bundle is an ordinary ZIP a gallery can open anywhere:
// originals, every record and relationship as JSON, spreadsheets for humans, the original
// import files, custom styles, and a manifest of SHA-256 checksums that restore verifies.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { writeZip, readZip } from './zip.mjs';
import { toCSV } from './tables.mjs';
import { SCHEMA_VERSION, openWorkspace, isEmptyWorkspace, audit, now, J, tx } from './db.mjs';
import { FIELDS } from './fields.mjs';

export const BUNDLE_FORMAT = 'open-gallery-bundle';
export const BUNDLE_VERSION = 1;
const TABLES = ['meta', 'settings', 'artists', 'artworks', 'channel_links', 'media', 'custom_fields', 'exhibitions', 'exhibition_items', 'imports', 'connectors', 'audit'];
const sha = (b) => createHash('sha256').update(b).digest('hex');

function appVersion() {
  try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; } catch { return 'unknown'; }
}

function walk(dir, base = dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base));
    else if (e.isFile()) out.push(p.slice(base.length + 1));
  }
  return out;
}

export function exportBundle(db, dataDir) {
  db.exec('PRAGMA wal_checkpoint(FULL)');
  const tables = {};
  for (const t of TABLES) tables[t] = db.prepare(`SELECT * FROM ${t}`).all();
  tables.meta = tables.meta.filter((m) => m.key !== 'last_site_build');
  const entries = [];
  const files = [];
  const add = (name, data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    entries.push({ name, data: buf });
    files.push({ path: name, sha256: sha(buf), bytes: buf.length });
  };
  // Originals referenced by records, plus anything else in media/ (logos, web copies are regenerable and skipped).
  const mediaFiles = new Set(tables.media.map((m) => `${m.sha256}.${m.ext}`));
  for (const f of readdirSync(join(dataDir, 'media'))) if (/^[0-9a-f]{64}\.\w+$/.test(f)) mediaFiles.add(f);
  for (const f of [...mediaFiles].sort()) {
    const p = join(dataDir, 'media', f);
    if (!existsSync(p)) throw new Error(`Original image ${f} is missing from the workspace. Export stopped so you do not get an incomplete backup.`);
    const buf = readFileSync(p);
    if (sha(buf) !== f.split('.')[0]) throw new Error(`Original image ${f} is damaged (checksum mismatch). Export stopped.`);
    add(`media/originals/${f}`, buf);
  }
  for (const rel of walk(join(dataDir, 'imports')).sort()) add(`imports/${rel}`, readFileSync(join(dataDir, 'imports', rel)));
  for (const rel of walk(join(dataDir, 'custom')).sort()) add(`custom/${rel}`, readFileSync(join(dataDir, 'custom', rel)));
  add('records/workspace.json', JSON.stringify({ schema_version: SCHEMA_VERSION, tables }, null, 1));
  // Human-readable spreadsheets (these include private fields: the bundle is private).
  const artists = new Map(tables.artists.map((a) => [a.id, a.name]));
  const linkBy = (id, ch) => tables.channel_links.filter((l) => l.artwork_id === id && l.channel === ch).map((l) => l.url).join(' | ');
  const imgs = (id) => tables.media.filter((m) => m.artwork_id === id).sort((a, b) => a.position - b.position).map((m) => `media/originals/${m.sha256}.${m.ext}`).join(' | ');
  const customKeys = tables.custom_fields.map((c) => c.key);
  const extraKeys = [...new Set(tables.artworks.flatMap((w) => Object.keys(J(w.extra))))];
  const privKeys = FIELDS.filter((f) => f.visibility === 'private').map((f) => f.key);
  const dim = (w, kind) => { const d = J(w.dims, []).find((x) => x.kind === kind); return d ? [d.h, d.w, d.d].filter((x) => x != null).join(' x ') + (d.diameter != null ? `Ø ${d.diameter}` : '') + (d.unit ? ` ${d.unit}` : '') : ''; };
  const header = ['Open Gallery ID', 'Inventory number', 'Artist', 'Title', 'Year', 'Medium', 'Category', 'Dimensions', 'Framed dimensions', 'Edition', 'Price', 'Currency', 'Price visibility', 'Availability', 'Public',
    'Signature', 'Provenance', 'Exhibition history', 'Literature', 'Condition', 'Description', 'Image credit', 'Artsy link', 'Artnet link', 'Website link', 'Images',
    ...privKeys.map((k) => `Private: ${FIELDS.find((f) => f.key === k).label}`), ...customKeys.map((k) => `Custom: ${k}`), ...extraKeys.map((k) => `Extra: ${k}`), 'Updated'];
  const rows = tables.artworks.map((w) => {
    const p = J(w.private), c = J(w.custom), x = J(w.extra);
    return [w.id, w.stock_number, artists.get(w.artist_id) || '', w.title, w.year, w.medium, w.category, dim(w, 'work'), dim(w, 'framed'), w.edition, w.price, w.currency, w.price_visibility, w.availability, w.public ? 'yes' : 'no',
      w.signature, w.provenance, w.exhibition_history, w.literature, w.condition, w.description, w.image_credit, linkBy(w.id, 'artsy'), linkBy(w.id, 'artnet'), linkBy(w.id, 'website'), imgs(w.id),
      ...privKeys.map((k) => p[k] ?? ''), ...customKeys.map((k) => c[k] ?? ''), ...extraKeys.map((k) => x[k] ?? ''), w.updated_at];
  });
  add('spreadsheets/artworks.csv', toCSV([header, ...rows]));
  add('spreadsheets/artists.csv', toCSV([['Open Gallery ID', 'Name', 'Birth year', 'Nationality', 'Website', 'Bio'], ...tables.artists.map((a) => [a.id, a.name, a.birth_year, a.nationality, a.website, a.bio])]));
  add('spreadsheets/exhibitions.csv', toCSV([['Exhibition', 'Dates', 'Position', 'Open Gallery ID', 'Inventory number', 'Artist', 'Title'], ...tables.exhibition_items.map((i) => {
    const e = tables.exhibitions.find((x) => x.id === i.exhibition_id); const w = tables.artworks.find((x) => x.id === i.artwork_id);
    return [e?.title, e?.dates, i.position + 1, w?.id, w?.stock_number, artists.get(w?.artist_id), w?.title];
  })]));
  add('README.txt', `Open Gallery export
Created ${now()} by Open Gallery ${appVersion()}.

This file is a complete, private backup of the gallery workspace. It contains private fields
(costs, consignors, notes) and should be stored like any confidential business record.

  media/originals/      every original image, named by its SHA-256 checksum
  records/workspace.json every record and relationship (artists, artworks, images, links,
                        exhibitions, custom fields, settings, import history, change log)
  spreadsheets/         the same catalog as CSV files that open in Excel, Numbers or Sheets
  imports/              the exact spreadsheet files you imported, unchanged
  custom/               custom styles and other customization files
  manifest.json         a checksum for every file, verified on restore

To restore: install Open Gallery, then run
  open-gallery restore /path/to/this-file.zip --data /path/to/new/workspace
or use Backup > Restore in the app on a fresh workspace.
The format is documented in docs/BUNDLE-FORMAT.md in the Open Gallery source.
`);
  const counts = Object.fromEntries(TABLES.map((t) => [t, tables[t].length]));
  const manifest = { format: BUNDLE_FORMAT, version: BUNDLE_VERSION, app_version: appVersion(), schema_version: SCHEMA_VERSION, created_at: now(),
    workspace_id: tables.meta.find((m) => m.key === 'workspace_id')?.value, counts, files };
  entries.unshift({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 1)) });
  audit(db, 'export', null, null, { files: files.length, artworks: counts.artworks });
  return { zip: writeZip(entries), manifest };
}

/** Restore a bundle into an empty workspace directory. Verifies every checksum before writing records. */
export function restoreBundle(zipBuf, dataDir) {
  if (!isEmptyWorkspace(dataDir)) throw new Error('Restore only runs into an empty workspace, so nothing existing is overwritten. Choose a new folder.');
  const zip = readZip(zipBuf);
  if (!zip.has('manifest.json')) throw new Error('This is not an Open Gallery export (manifest.json is missing).');
  const manifest = JSON.parse(zip.get('manifest.json')().toString('utf8'));
  if (manifest.format !== BUNDLE_FORMAT) throw new Error('This is not an Open Gallery export.');
  if (manifest.version > BUNDLE_VERSION || manifest.schema_version > SCHEMA_VERSION) throw new Error('This export came from a newer Open Gallery. Update the app first.');
  const contents = new Map();
  for (const f of manifest.files) {
    if (!zip.has(f.path)) throw new Error(`Export is incomplete: ${f.path} is missing.`);
    const buf = zip.get(f.path)();
    if (sha(buf) !== f.sha256 || buf.length !== f.bytes) throw new Error(`Export is damaged: ${f.path} does not match its checksum.`);
    if (f.path.includes('..') || f.path.startsWith('/')) throw new Error(`Unsafe path in export: ${f.path}`);
    contents.set(f.path, buf);
  }
  const { tables } = JSON.parse(contents.get('records/workspace.json').toString('utf8'));
  const db = openWorkspace(dataDir);
  try {
    tx(db, () => {
      // A fresh workspace has its own meta and connector rows; replace them with the gallery's.
      db.exec('DELETE FROM meta; DELETE FROM connectors;');
      for (const t of TABLES) {
        for (const row of tables[t] || []) {
          if (t === 'meta' && row.key === 'schema_version') { db.prepare('INSERT INTO meta(key,value) VALUES (?,?)').run('schema_version', String(SCHEMA_VERSION)); continue; }
          const cols = Object.keys(row);
          db.prepare(`INSERT INTO ${t} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c]));
        }
      }
      if (!db.prepare("SELECT 1 FROM meta WHERE key='schema_version'").get()) db.prepare('INSERT INTO meta(key,value) VALUES (?,?)').run('schema_version', String(SCHEMA_VERSION));
    });
    for (const [path, buf] of contents) {
      let target = null;
      if (path.startsWith('media/originals/')) target = join(dataDir, 'media', path.slice('media/originals/'.length));
      else if (path.startsWith('imports/') || path.startsWith('custom/')) target = join(dataDir, path);
      if (!target) continue;
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, buf);
    }
    audit(db, 'restore', null, null, { from: manifest.workspace_id, created_at: manifest.created_at, files: manifest.files.length });
    const verify = verifyWorkspace(db, dataDir);
    const counts = Object.fromEntries(TABLES.filter((t) => t !== 'audit').map((t) => [t, db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n]));
    const mismatched = Object.entries(counts).filter(([t, n]) => t !== 'meta' && t !== 'connectors' && n !== manifest.counts[t]);
    return { manifest, counts, verify, ok: verify.ok && !mismatched.length, mismatched };
  } finally { db.close(); }
}

/** Check that every image record has its original file with the right checksum. */
export function verifyWorkspace(db, dataDir) {
  const problems = [];
  for (const m of db.prepare('SELECT id, sha256, ext FROM media').all()) {
    const p = join(dataDir, 'media', `${m.sha256}.${m.ext}`);
    if (!existsSync(p)) { problems.push(`Missing original for image ${m.id}`); continue; }
    if (sha(readFileSync(p)) !== m.sha256) problems.push(`Original for image ${m.id} does not match its checksum`);
  }
  const fk = db.prepare('PRAGMA foreign_key_check').all();
  if (fk.length) problems.push(`${fk.length} broken relationship(s)`);
  const integrity = db.prepare('PRAGMA integrity_check').get();
  if (Object.values(integrity)[0] !== 'ok') problems.push('Database integrity check failed');
  return { ok: !problems.length, problems, images: db.prepare('SELECT COUNT(*) n FROM media').get().n };
}

export function dataSize(dataDir) {
  let bytes = 0;
  for (const rel of walk(dataDir)) { try { bytes += statSync(join(dataDir, rel)).size; } catch {} }
  return bytes;
}
