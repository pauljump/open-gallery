// Shared helpers for the engine tests: temp workspaces, demo fixtures and a one-call import.
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWorkspace } from '../lib/db.mjs';
import { generateDemo } from '../demo/generate.mjs';
import { uploadImport, previewImport, applyImport } from '../lib/importer.mjs';
import { parseCSV } from '../lib/tables.mjs';

export function tmp(prefix = 'og-test-') { return mkdtempSync(join(tmpdir(), prefix)); }
export function rm(dir) { rmSync(dir, { recursive: true, force: true }); }

/** A fresh empty workspace in its own temp dir. */
export function workspace(prefix = 'og-ws-') {
  const dir = tmp(prefix);
  const db = openWorkspace(dir);
  return { dir, db, close() { try { db.close(); } catch {} rm(dir); } };
}

let cachedFixture = null;
/** The 60-work demo fixture (with images), generated once per test process. */
export function fixture() {
  if (cachedFixture && existsSync(join(cachedFixture, 'inventory.csv'))) return cachedFixture;
  const dir = tmp('og-fixture-');
  generateDemo(dir, { works: 60, seed: 7 });
  cachedFixture = dir;
  process.on('exit', () => rm(dir));
  return dir;
}

export function scenario(fx = fixture()) { return JSON.parse(readFileSync(join(fx, 'scenario.json'), 'utf8')); }
export function sentinels(fx = fixture()) { return JSON.parse(readFileSync(join(fx, 'private-sentinels.json'), 'utf8')); }

/** Rows of a CSV as objects keyed by header. */
export function csvRecords(path) {
  const rows = parseCSV(readFileSync(path, 'utf8'));
  const headers = rows[0];
  return { headers, records: rows.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? '']))) };
}

/**
 * Upload, preview and apply one file. Review rows (possible duplicates) that the caller did not
 * decide are created, which is what a person would choose for a genuinely new work.
 */
export function importFile(db, dir, name, buf, { decisions = {}, mapping, autoCreate = true } = {}) {
  const up = uploadImport(db, dir, name, buf);
  let preview = previewImport(db, dir, up.id, { mapping, decisions });
  if (autoCreate) {
    for (const p of preview.plan) if (p.action === 'review' && !p.decision) decisions[p.row] = { ...(decisions[p.row] || {}), match: 'create' };
    preview = previewImport(db, dir, up.id, { decisions });
  }
  const summary = applyImport(db, dir, up.id, { decisions });
  return { id: up.id, upload: up, preview, summary };
}

export function byStock(db, stock) {
  return db.prepare('SELECT id FROM artworks WHERE stock_number=?').get(stock)?.id || null;
}

/** Every file under dir, as relative paths. */
export function walk(dir, base = dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base));
    else out.push(p.slice(base.length + 1));
  }
  return out;
}
