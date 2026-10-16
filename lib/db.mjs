// Workspace storage: one SQLite file plus an originals folder, all inside one data directory.
// Schema changes are numbered migrations applied at startup, inside a transaction, so an
// upgrade never needs a manual step and never touches the gallery's files or settings.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const SCHEMA_VERSION = 2;

const MIGRATIONS = [
  // 1: initial schema
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE artists (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL, birth_year TEXT, nationality TEXT,
    bio TEXT, website TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE INDEX artists_key ON artists(name_key);
  CREATE TABLE artworks (
    id TEXT PRIMARY KEY, stock_number TEXT UNIQUE, artist_id TEXT REFERENCES artists(id),
    title TEXT NOT NULL DEFAULT '', year TEXT, medium TEXT, category TEXT, edition TEXT,
    dims TEXT NOT NULL DEFAULT '[]',
    price REAL, price_max REAL, currency TEXT, price_visibility TEXT NOT NULL DEFAULT 'on_request',
    availability TEXT NOT NULL DEFAULT 'unknown', availability_at TEXT,
    signature TEXT, provenance TEXT, exhibition_history TEXT, literature TEXT, condition TEXT,
    description TEXT, image_credit TEXT,
    public INTEGER NOT NULL DEFAULT 0,
    private TEXT NOT NULL DEFAULT '{}', custom TEXT NOT NULL DEFAULT '{}', extra TEXT NOT NULL DEFAULT '{}',
    origin TEXT NOT NULL DEFAULT '{}',
    missing_from_last_import INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE INDEX artworks_artist ON artworks(artist_id);
  CREATE TABLE channel_links (
    id TEXT PRIMARY KEY, artwork_id TEXT NOT NULL REFERENCES artworks(id) ON DELETE CASCADE,
    channel TEXT NOT NULL, url TEXT NOT NULL, external_id TEXT, source TEXT NOT NULL DEFAULT 'staff',
    created_at TEXT NOT NULL, UNIQUE(artwork_id, channel, url));
  CREATE TABLE media (
    id TEXT PRIMARY KEY, artwork_id TEXT REFERENCES artworks(id) ON DELETE SET NULL,
    sha256 TEXT NOT NULL, ext TEXT NOT NULL, original_name TEXT NOT NULL, bytes INTEGER NOT NULL,
    width INTEGER, height INTEGER, position INTEGER NOT NULL DEFAULT 0, caption TEXT, public INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL, UNIQUE(artwork_id, sha256));
  CREATE TABLE custom_fields (
    key TEXT PRIMARY KEY, label TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'text',
    visibility TEXT NOT NULL DEFAULT 'private', position INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE exhibitions (
    id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL, subtitle TEXT, dates TEXT,
    intro TEXT, layout TEXT NOT NULL DEFAULT 'grid', show_prices INTEGER NOT NULL DEFAULT 1,
    published INTEGER NOT NULL DEFAULT 0, cover_media_id TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE exhibition_items (
    exhibition_id TEXT NOT NULL REFERENCES exhibitions(id) ON DELETE CASCADE,
    artwork_id TEXT NOT NULL REFERENCES artworks(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0, note TEXT, PRIMARY KEY (exhibition_id, artwork_id));
  CREATE TABLE imports (
    id TEXT PRIMARY KEY, created_at TEXT NOT NULL, filename TEXT NOT NULL, sha256 TEXT NOT NULL,
    stored_as TEXT NOT NULL, headers TEXT NOT NULL, mapping TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'uploaded', summary TEXT NOT NULL DEFAULT '{}', applied_at TEXT);
  CREATE TABLE audit (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, action TEXT NOT NULL,
    entity TEXT, entity_id TEXT, detail TEXT NOT NULL DEFAULT '{}');
  CREATE TABLE connectors (
    channel TEXT PRIMARY KEY, state TEXT NOT NULL, last_action TEXT, last_action_at TEXT,
    last_success_at TEXT, unresolved INTEGER NOT NULL DEFAULT 0, note TEXT);
  `,
  // 2: operations layer. Money is stored as integer minor units (cents) so ledgers add up exactly.
  `
  CREATE TABLE contacts (
    id TEXT PRIMARY KEY, display_name TEXT NOT NULL, sort_name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'person',
    email TEXT, phone TEXT, address TEXT, note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE INDEX contacts_sort ON contacts(sort_name);
  ALTER TABLE artists ADD COLUMN default_split REAL;
  ALTER TABLE artists ADD COLUMN payee_note TEXT;
  ALTER TABLE artworks ADD COLUMN gallery_owned INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE consignments (
    id TEXT PRIMARY KEY, artwork_id TEXT NOT NULL REFERENCES artworks(id) ON DELETE CASCADE,
    direction TEXT NOT NULL DEFAULT 'in', artist_id TEXT REFERENCES artists(id), contact_id TEXT REFERENCES contacts(id),
    start_date TEXT, end_date TEXT, split_pct REAL NOT NULL DEFAULT 50, discount_limit_pct REAL,
    discount_borne_by TEXT NOT NULL DEFAULT 'shared', insured_value INTEGER, insured_by TEXT, terms TEXT,
    status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE INDEX consignments_artwork ON consignments(artwork_id);
  CREATE TABLE holds (
    id TEXT PRIMARY KEY, artwork_id TEXT NOT NULL REFERENCES artworks(id) ON DELETE CASCADE,
    contact_id TEXT REFERENCES contacts(id), placed_at TEXT NOT NULL, expires_at TEXT, status TEXT NOT NULL DEFAULT 'active',
    note TEXT, closed_at TEXT);
  CREATE INDEX holds_artwork ON holds(artwork_id);
  CREATE TABLE sales (
    id TEXT PRIMARY KEY, artwork_id TEXT NOT NULL REFERENCES artworks(id), contact_id TEXT REFERENCES contacts(id),
    consignment_id TEXT REFERENCES consignments(id), sale_date TEXT NOT NULL, currency TEXT NOT NULL,
    list_cents INTEGER, price_cents INTEGER NOT NULL, tax_cents INTEGER NOT NULL DEFAULT 0, shipping_cents INTEGER NOT NULL DEFAULT 0,
    split_pct REAL, discount_borne_by TEXT, invoice_number TEXT, channel TEXT, status TEXT NOT NULL DEFAULT 'open',
    note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE INDEX sales_artwork ON sales(artwork_id);
  CREATE TABLE payments (
    id TEXT PRIMARY KEY, sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE CASCADE, paid_on TEXT NOT NULL,
    amount_cents INTEGER NOT NULL, method TEXT, note TEXT, created_at TEXT NOT NULL);
  CREATE TABLE deductions (
    id TEXT PRIMARY KEY, sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE CASCADE, description TEXT NOT NULL,
    amount_cents INTEGER NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE payouts (
    id TEXT PRIMARY KEY, artist_id TEXT REFERENCES artists(id), contact_id TEXT REFERENCES contacts(id),
    paid_on TEXT NOT NULL, amount_cents INTEGER NOT NULL, currency TEXT NOT NULL, method TEXT, reference TEXT,
    sale_ids TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL);
  `,
];

export function newId(prefix) {
  // Time-ordered, collision-resistant, URL-safe.
  return `${prefix}_${Date.now().toString(36)}${randomBytes(6).toString('hex')}`;
}

export const now = () => new Date().toISOString();

export function openWorkspace(dir) {
  mkdirSync(join(dir, 'media'), { recursive: true });
  mkdirSync(join(dir, 'imports'), { recursive: true });
  mkdirSync(join(dir, 'custom'), { recursive: true });
  const db = new DatabaseSync(join(dir, 'gallery.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const hasMeta = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get();
  let version = hasMeta ? Number(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value || 0) : 0;
  if (version > SCHEMA_VERSION) {
    throw new Error(`This workspace was created by a newer Open Gallery (schema ${version}). Update the app, or restore an export into a fresh workspace.`);
  }
  while (version < SCHEMA_VERSION) {
    const sql = MIGRATIONS[version];
    db.exec('BEGIN');
    try {
      db.exec(sql);
      if (version === 0) {
        db.prepare("INSERT INTO meta(key,value) VALUES ('workspace_id', ?), ('created_at', ?)").run(newId('ws'), now());
        db.prepare("INSERT INTO meta(key,value) VALUES ('schema_version', '0')").run();
        for (const [channel, note] of [
          ['artsy', 'No API connection. Listing links are kept; new works can be prepared as a bulk-import file for you to upload in Artsy CMS.'],
          ['artnet', 'No API connection. Listing links are kept. No verified Artnet upload format yet.'],
        ]) db.prepare('INSERT INTO connectors(channel,state,note) VALUES (?,?,?)').run(channel, 'not_connected', note);
      }
      version += 1;
      db.prepare("UPDATE meta SET value=? WHERE key='schema_version'").run(String(version));
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return db;
}

export function isEmptyWorkspace(dir) {
  if (!existsSync(join(dir, 'gallery.db'))) return true;
  const db = new DatabaseSync(join(dir, 'gallery.db'));
  try {
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='artworks'").get();
    if (!t) return true;
    const n = db.prepare('SELECT (SELECT COUNT(*) FROM artworks) + (SELECT COUNT(*) FROM artists) + (SELECT COUNT(*) FROM media) + (SELECT COUNT(*) FROM exhibitions) AS n').get().n;
    return n === 0 && readdirSync(join(dir, 'media')).length === 0;
  } finally { db.close(); }
}

export function audit(db, action, entity, entityId, detail = {}) {
  db.prepare('INSERT INTO audit(at,action,entity,entity_id,detail) VALUES (?,?,?,?,?)').run(now(), action, entity ?? null, entityId ?? null, JSON.stringify(detail));
}

export function tx(db, fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export const J = (s, d = {}) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
