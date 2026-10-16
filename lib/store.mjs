// Catalog records: artists, artworks, images, sales-channel links and exhibitions.
import { createHash } from 'node:crypto';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { newId, now, audit, J, tx } from './db.mjs';
import { normKey, clean, slugify, isHttpUrl } from './normalize.mjs';
import { PRIVATE_KEYS, AVAILABILITY } from './fields.mjs';
import { imageSize } from './png.mjs';

const TEXT_COLS = ['stock_number', 'title', 'year', 'medium', 'category', 'edition', 'signature', 'provenance',
  'exhibition_history', 'literature', 'condition', 'description', 'image_credit', 'currency'];
const AVAIL_KEYS = new Set(AVAILABILITY.map((a) => a.key));
const PRICE_VIS = new Set(['show', 'on_request', 'hidden']);
const CHANNELS = new Set(['artsy', 'artnet', 'website', 'other']);

// ---------- artists ----------
export function findOrCreateArtist(db, name) {
  const n = clean(name);
  if (!n) return null;
  const key = normKey(n);
  const row = db.prepare('SELECT id FROM artists WHERE name_key=?').get(key);
  if (row) return row.id;
  const id = newId('ar');
  db.prepare('INSERT INTO artists(id,name,name_key,created_at,updated_at) VALUES (?,?,?,?,?)').run(id, n, key, now(), now());
  audit(db, 'artist.create', 'artist', id, { name: n });
  return id;
}

export function listArtists(db) {
  return db.prepare(`SELECT a.*, COUNT(w.id) AS works,
      SUM(CASE WHEN w.availability='available' THEN 1 ELSE 0 END) AS available
    FROM artists a LEFT JOIN artworks w ON w.artist_id=a.id GROUP BY a.id ORDER BY a.name_key`).all();
}

export function getArtist(db, id) { return db.prepare('SELECT * FROM artists WHERE id=?').get(id); }

export function updateArtist(db, id, patch) {
  const a = getArtist(db, id);
  if (!a) throw httpError(404, 'Artist not found');
  const next = { ...a };
  for (const k of ['name', 'birth_year', 'nationality', 'bio', 'website']) if (k in patch) next[k] = clean(patch[k]) || null;
  if (!next.name) throw httpError(400, 'An artist needs a name');
  if (next.website && !isHttpUrl(next.website)) throw httpError(400, 'Website must start with https://');
  const key = normKey(next.name);
  const clash = db.prepare('SELECT id FROM artists WHERE name_key=? AND id<>?').get(key, id);
  if (clash) throw httpError(409, 'Another artist already has that name. Merge them instead.');
  db.prepare('UPDATE artists SET name=?, name_key=?, birth_year=?, nationality=?, bio=?, website=?, updated_at=? WHERE id=?')
    .run(next.name, key, next.birth_year, next.nationality, next.bio, next.website, now(), id);
  audit(db, 'artist.update', 'artist', id, { fields: Object.keys(patch) });
  return getArtist(db, id);
}

// ---------- artworks ----------
export function hydrate(db, row) {
  if (!row) return null;
  const artist = row.artist_id ? db.prepare('SELECT id,name FROM artists WHERE id=?').get(row.artist_id) : null;
  return {
    ...row,
    public: !!row.public,
    missing_from_last_import: !!row.missing_from_last_import,
    artist: artist?.name || '',
    dims: J(row.dims, []),
    private: J(row.private),
    custom: J(row.custom),
    extra: J(row.extra),
    origin: J(row.origin),
    links: db.prepare('SELECT id,channel,url,external_id,source,created_at FROM channel_links WHERE artwork_id=? ORDER BY channel').all(row.id),
    media: db.prepare('SELECT * FROM media WHERE artwork_id=? ORDER BY position, created_at').all(row.id).map(mediaOut),
    exhibitions: db.prepare('SELECT e.id,e.title FROM exhibition_items i JOIN exhibitions e ON e.id=i.exhibition_id WHERE i.artwork_id=?').all(row.id),
  };
}

export function mediaOut(m) { return { ...m, public: !!m.public, url: `/media/${m.sha256}.${m.ext}` }; }

export function getArtwork(db, id) { return hydrate(db, db.prepare('SELECT * FROM artworks WHERE id=?').get(id)); }

export function listArtworks(db, { q = '', artist = '', availability = '', visibility = '', exhibition = '', limit = 500, offset = 0 } = {}) {
  const where = [];
  const args = [];
  if (q) {
    const like = `%${q.replace(/[%_]/g, '')}%`;
    where.push(`(w.title LIKE ? OR a.name LIKE ? OR w.stock_number LIKE ? OR w.medium LIKE ? OR w.year LIKE ? OR w.private LIKE ? OR w.custom LIKE ?)`);
    args.push(like, like, like, like, like, like, like);
  }
  if (artist) { where.push('w.artist_id=?'); args.push(artist); }
  if (availability) { where.push('w.availability=?'); args.push(availability); }
  if (visibility === 'public') where.push('w.public=1');
  if (visibility === 'private') where.push('w.public=0');
  if (visibility === 'missing') where.push('w.missing_from_last_import=1');
  if (visibility === 'noimage') where.push('NOT EXISTS (SELECT 1 FROM media m WHERE m.artwork_id=w.id)');
  if (exhibition) { where.push('EXISTS (SELECT 1 FROM exhibition_items i WHERE i.artwork_id=w.id AND i.exhibition_id=?)'); args.push(exhibition); }
  const sql = `SELECT w.id, w.stock_number, w.title, w.year, w.medium, w.price, w.currency, w.price_visibility, w.availability,
      w.public, w.dims, w.private, w.missing_from_last_import, w.updated_at, a.name AS artist, a.id AS artist_id,
      (SELECT sha256 || '.' || ext FROM media m WHERE m.artwork_id=w.id ORDER BY position, created_at LIMIT 1) AS thumb
    FROM artworks w LEFT JOIN artists a ON a.id=w.artist_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY a.name_key, w.year, w.title LIMIT ? OFFSET ?`;
  const total = db.prepare(`SELECT COUNT(*) AS n FROM artworks w LEFT JOIN artists a ON a.id=w.artist_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`).get(...args).n;
  const rows = db.prepare(sql).all(...args, limit, offset).map((r) => {
    const priv = J(r.private);
    return { ...r, public: !!r.public, missing_from_last_import: !!r.missing_from_last_import, dims: J(r.dims, []), location: priv.location || '', private: undefined, thumb: r.thumb ? `/media/${r.thumb}` : null };
  });
  return { total, rows };
}

export function createArtwork(db, input = {}, by = 'staff') {
  const id = newId('aw');
  const t = now();
  const artistId = input.artist_id || findOrCreateArtist(db, input.artist);
  db.prepare(`INSERT INTO artworks(id, artist_id, title, created_at, updated_at, price_visibility, public, availability_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(id, artistId, clean(input.title), t, t, input.price_visibility || 'on_request', input.public ? 1 : 0, t);
  audit(db, 'artwork.create', 'artwork', id, { by });
  const rest = { ...input };
  delete rest.artist; delete rest.artist_id; delete rest.title;
  if (Object.keys(rest).length) updateArtwork(db, id, rest, by === 'staff' ? { by: 'staff' } : by);
  return getArtwork(db, id);
}

/**
 * Apply a patch. `by` is { by: 'staff' } or { by: 'import', batch, imported: {fieldKey: value} }.
 * Origin tracking records, per field, who last set it and the last value an import supplied,
 * which is how re-imports tell a spreadsheet change from a staff edit.
 */
export function updateArtwork(db, id, patch, by = { by: 'staff' }) {
  const row = db.prepare('SELECT * FROM artworks WHERE id=?').get(id);
  if (!row) throw httpError(404, 'Artwork not found');
  const origin = J(row.origin);
  const priv = J(row.private);
  const custom = J(row.custom);
  const extra = J(row.extra);
  let dims = J(row.dims, []);
  const sets = {};
  const touched = [];
  const t = now();
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const mark = (key, value, old) => {
    if (by.by !== 'import' && same(value, old)) return; // unchanged form fields are not staff edits
    const prev = origin[key] || {};
    origin[key] = by.by === 'import'
      ? { by: 'import', at: t, batch: by.batch, imported: by.imported && key in by.imported ? by.imported[key] : value }
      : { ...prev, by: 'staff', at: t };
    touched.push(key);
  };

  for (const k of TEXT_COLS) if (k in patch) {
    let v = patch[k] == null ? null : clean(patch[k]);
    if (k === 'stock_number' && v === '') v = null;
    if (k === 'currency' && v) v = v.toUpperCase().slice(0, 3);
    if (k === 'title') v = v ?? '';
    if (k === 'stock_number' && v) {
      const clash = db.prepare('SELECT id FROM artworks WHERE stock_number=? AND id<>?').get(v, id);
      if (clash) throw httpError(409, `Inventory number ${v} is already used by another work`);
    }
    sets[k] = v; mark(k, v, row[k]);
  }
  if ('artist' in patch || 'artist_id' in patch) {
    const aid = patch.artist_id || findOrCreateArtist(db, patch.artist);
    const oldName = row.artist_id ? db.prepare('SELECT name FROM artists WHERE id=?').get(row.artist_id)?.name : '';
    const newName = db.prepare('SELECT name FROM artists WHERE id=?').get(aid)?.name || '';
    sets.artist_id = aid; mark('artist', newName, oldName);
  }
  if ('price' in patch) {
    const p = patch.price === '' || patch.price == null ? null : Number(patch.price);
    if (p != null && (!Number.isFinite(p) || p < 0)) throw httpError(400, 'Price must be a positive number');
    sets.price = p; mark('price', p, row.price);
  }
  if ('price_max' in patch) sets.price_max = patch.price_max == null || patch.price_max === '' ? null : Number(patch.price_max);
  if ('price_visibility' in patch) {
    if (!PRICE_VIS.has(patch.price_visibility)) throw httpError(400, 'Unknown price visibility');
    sets.price_visibility = patch.price_visibility; mark('price_visibility', patch.price_visibility, row.price_visibility);
  }
  if ('availability' in patch) {
    if (!AVAIL_KEYS.has(patch.availability)) throw httpError(400, 'Unknown availability');
    if (patch.availability !== row.availability) sets.availability_at = t;
    sets.availability = patch.availability; mark('availability', patch.availability, row.availability);
  }
  if ('public' in patch) { sets.public = patch.public ? 1 : 0; touched.push('public'); }
  if ('dims' in patch) {
    if (!Array.isArray(patch.dims)) throw httpError(400, 'Dimensions must be a list');
    dims = patch.dims.filter(Boolean).map((d) => ({
      kind: ['work', 'framed', 'sheet', 'image', 'base'].includes(d.kind) ? d.kind : 'work',
      ...(d.h != null && d.h !== '' ? { h: Number(d.h) } : {}),
      ...(d.w != null && d.w !== '' ? { w: Number(d.w) } : {}),
      ...(d.d != null && d.d !== '' ? { d: Number(d.d) } : {}),
      ...(d.diameter != null && d.diameter !== '' ? { diameter: Number(d.diameter) } : {}),
      unit: ['in', 'cm', 'mm'].includes(d.unit) ? d.unit : 'in',
      ...(d.text ? { text: clean(d.text) } : {}),
    }));
    const oldDims = J(row.dims, []);
    for (const kind of ['work', 'framed']) {
      const before = oldDims.find((d) => d.kind === kind) || null;
      const after = dims.find((d) => d.kind === kind) || null;
      if (by.by === 'import' ? (by.imported && `dims.${kind}` in by.imported) : true) mark(`dims.${kind}`, after, before);
    }
    sets.dims = JSON.stringify(dims);
  }
  if (patch.private && typeof patch.private === 'object') {
    for (const [k, v] of Object.entries(patch.private)) {
      if (!PRIVATE_KEYS.includes(k)) continue;
      const old = priv[k] ?? null;
      if (v === '' || v == null) delete priv[k]; else priv[k] = v;
      mark(`private.${k}`, v === '' ? null : v, old);
    }
    sets.private = JSON.stringify(priv);
  }
  if (patch.custom && typeof patch.custom === 'object') {
    for (const [k, v] of Object.entries(patch.custom)) {
      if (!/^[a-z0-9_]{1,40}$/.test(k)) continue;
      const old = custom[k] ?? null;
      if (v === '' || v == null) delete custom[k]; else custom[k] = String(v).slice(0, 5000);
      mark(`custom.${k}`, v === '' || v == null ? null : String(v).slice(0, 5000), old);
    }
    sets.custom = JSON.stringify(custom);
  }
  if (patch.extra && typeof patch.extra === 'object') {
    // Unmapped spreadsheet columns, kept verbatim so nothing the gallery recorded is lost.
    for (const [k, v] of Object.entries(patch.extra)) { if (v === '' || v == null) delete extra[k]; else extra[k] = String(v); }
    sets.extra = JSON.stringify(extra);
  }
  if ('missing_from_last_import' in patch) sets.missing_from_last_import = patch.missing_from_last_import ? 1 : 0;
  sets.origin = JSON.stringify(origin);
  sets.updated_at = t;
  const cols = Object.keys(sets);
  db.prepare(`UPDATE artworks SET ${cols.map((c) => `${c}=?`).join(', ')} WHERE id=?`).run(...cols.map((c) => sets[c]), id);
  if (patch.links) setLinks(db, id, patch.links, by.by === 'import' ? 'import' : 'staff');
  audit(db, 'artwork.update', 'artwork', id, { by: by.by, batch: by.batch, fields: touched.filter((f) => !f.startsWith('private.')).concat(touched.some((f) => f.startsWith('private.')) ? ['private.*'] : []) });
  return getArtwork(db, id);
}

export function deleteArtwork(db, id) {
  const row = db.prepare('SELECT id, title FROM artworks WHERE id=?').get(id);
  if (!row) throw httpError(404, 'Artwork not found');
  db.prepare('DELETE FROM artworks WHERE id=?').run(id);
  audit(db, 'artwork.delete', 'artwork', id, { title: row.title });
}

// links: [{channel, url, external_id}] — replaces links of the given channels only.
export function setLinks(db, artworkId, links, source = 'staff') {
  for (const l of links) {
    if (!CHANNELS.has(l.channel)) throw httpError(400, `Unknown channel ${l.channel}`);
    if (l.url && !isHttpUrl(l.url)) throw httpError(400, `Link for ${l.channel} must be a web address`);
  }
  const channels = [...new Set(links.map((l) => l.channel))];
  for (const c of channels) db.prepare('DELETE FROM channel_links WHERE artwork_id=? AND channel=?').run(artworkId, c);
  for (const l of links) if (l.url) {
    db.prepare('INSERT OR IGNORE INTO channel_links(id,artwork_id,channel,url,external_id,source,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(newId('ln'), artworkId, l.channel, l.url.trim(), l.external_id || null, source, now());
  }
}

// ---------- media ----------
const EXT = { png: 'png', jpeg: 'jpg', gif: 'gif', webp: 'webp' };
export function storeMedia(db, dataDir, buf, originalName, artworkId = null) {
  const info = imageSize(buf);
  if (!info.type) throw httpError(415, `${originalName} is not a PNG, JPEG, GIF or WebP image`);
  const sha = createHash('sha256').update(buf).digest('hex');
  const ext = EXT[info.type];
  const dir = join(dataDir, 'media');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sha}.${ext}`);
  if (!existsSync(path)) writeFileSync(path, buf);
  const existing = artworkId
    ? db.prepare('SELECT * FROM media WHERE artwork_id=? AND sha256=?').get(artworkId, sha)
    : db.prepare('SELECT * FROM media WHERE artwork_id IS NULL AND sha256=?').get(sha);
  if (existing) return { media: mediaOut(existing), duplicate: true };
  if (artworkId) {
    // The same file was uploaded earlier without a match: move it instead of keeping two copies.
    const orphan = db.prepare('SELECT id FROM media WHERE artwork_id IS NULL AND sha256=?').get(sha);
    if (orphan) {
      const pos = db.prepare('SELECT COALESCE(MAX(position)+1,0) AS p FROM media WHERE artwork_id=?').get(artworkId).p;
      db.prepare('UPDATE media SET artwork_id=?, position=?, original_name=? WHERE id=?').run(artworkId, pos, originalName, orphan.id);
      audit(db, 'media.assign', 'media', orphan.id, { artwork: artworkId });
      return { media: mediaOut(db.prepare('SELECT * FROM media WHERE id=?').get(orphan.id)), duplicate: false };
    }
  }
  const position = artworkId ? db.prepare('SELECT COALESCE(MAX(position)+1,0) AS p FROM media WHERE artwork_id=?').get(artworkId).p : 0;
  const id = newId('md');
  db.prepare(`INSERT INTO media(id,artwork_id,sha256,ext,original_name,bytes,width,height,position,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, artworkId, sha, ext, originalName, buf.length, info.width || null, info.height || null, position, now());
  audit(db, 'media.add', 'media', id, { artwork: artworkId, name: originalName });
  return { media: mediaOut(db.prepare('SELECT * FROM media WHERE id=?').get(id)), duplicate: false };
}

export function updateMedia(db, id, patch) {
  const m = db.prepare('SELECT * FROM media WHERE id=?').get(id);
  if (!m) throw httpError(404, 'Image not found');
  if ('artwork_id' in patch) {
    if (patch.artwork_id && !db.prepare('SELECT 1 FROM artworks WHERE id=?').get(patch.artwork_id)) throw httpError(404, 'Artwork not found');
    const dup = patch.artwork_id && db.prepare('SELECT id FROM media WHERE artwork_id=? AND sha256=? AND id<>?').get(patch.artwork_id, m.sha256, id);
    if (dup) { db.prepare('DELETE FROM media WHERE id=?').run(id); return mediaOut(db.prepare('SELECT * FROM media WHERE id=?').get(dup.id)); }
    const pos = patch.artwork_id ? db.prepare('SELECT COALESCE(MAX(position)+1,0) AS p FROM media WHERE artwork_id=?').get(patch.artwork_id).p : 0;
    db.prepare('UPDATE media SET artwork_id=?, position=? WHERE id=?').run(patch.artwork_id || null, pos, id);
  }
  if ('public' in patch) db.prepare('UPDATE media SET public=? WHERE id=?').run(patch.public ? 1 : 0, id);
  if ('caption' in patch) db.prepare('UPDATE media SET caption=? WHERE id=?').run(clean(patch.caption) || null, id);
  if ('position' in patch && m.artwork_id) {
    // Move to index, renumber siblings.
    const ids = db.prepare('SELECT id FROM media WHERE artwork_id=? ORDER BY position, created_at').all(m.artwork_id).map((r) => r.id).filter((x) => x !== id);
    ids.splice(Math.max(0, Math.min(ids.length, Number(patch.position))), 0, id);
    ids.forEach((mid, i) => db.prepare('UPDATE media SET position=? WHERE id=?').run(i, mid));
  }
  audit(db, 'media.update', 'media', id, { fields: Object.keys(patch) });
  return mediaOut(db.prepare('SELECT * FROM media WHERE id=?').get(id));
}

export function removeMedia(db, id) {
  db.prepare('DELETE FROM media WHERE id=?').run(id);
  audit(db, 'media.remove', 'media', id, {});
  // The original file stays in media/ until a cleanup; other records may share it.
}

export function unassignedMedia(db) {
  return db.prepare('SELECT * FROM media WHERE artwork_id IS NULL ORDER BY created_at DESC').all().map(mediaOut);
}

// ---------- exhibitions ----------
export function listExhibitions(db) {
  return db.prepare(`SELECT e.*, COUNT(i.artwork_id) AS works FROM exhibitions e LEFT JOIN exhibition_items i ON i.exhibition_id=e.id
    GROUP BY e.id ORDER BY e.created_at DESC`).all().map((e) => ({ ...e, published: !!e.published, show_prices: !!e.show_prices }));
}

export function getExhibition(db, id) {
  const e = db.prepare('SELECT * FROM exhibitions WHERE id=? OR slug=?').get(id, id);
  if (!e) return null;
  const items = db.prepare('SELECT artwork_id, position, note FROM exhibition_items WHERE exhibition_id=? ORDER BY position').all(e.id);
  return { ...e, published: !!e.published, show_prices: !!e.show_prices, items: items.map((i) => ({ ...i, artwork: getArtwork(db, i.artwork_id) })) };
}

export function saveExhibition(db, id, input) {
  return tx(db, () => {
    const t = now();
    let e = id ? db.prepare('SELECT * FROM exhibitions WHERE id=?').get(id) : null;
    if (id && !e) throw httpError(404, 'Exhibition not found');
    const title = clean(input.title ?? e?.title);
    if (!title) throw httpError(400, 'An exhibition needs a title');
    let slug = clean(input.slug ?? e?.slug) ? slugify(input.slug ?? e.slug) : slugify(title);
    const clash = db.prepare('SELECT id FROM exhibitions WHERE slug=? AND id<>?').get(slug, id || '');
    if (clash) slug = `${slug}-${Date.now().toString(36).slice(-4)}`;
    const layout = ['grid', 'list', 'salon'].includes(input.layout) ? input.layout : (e?.layout || 'grid');
    const vals = {
      title, slug, subtitle: clean(input.subtitle ?? e?.subtitle) || null, dates: clean(input.dates ?? e?.dates) || null,
      intro: input.intro != null ? String(input.intro).slice(0, 20000) : e?.intro ?? null, layout,
      show_prices: (input.show_prices ?? e?.show_prices ?? 1) ? 1 : 0, published: (input.published ?? e?.published ?? 0) ? 1 : 0,
      cover_media_id: input.cover_media_id ?? e?.cover_media_id ?? null,
    };
    if (!e) {
      id = newId('ex');
      db.prepare(`INSERT INTO exhibitions(id,slug,title,subtitle,dates,intro,layout,show_prices,published,cover_media_id,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, vals.slug, vals.title, vals.subtitle, vals.dates, vals.intro, vals.layout, vals.show_prices, vals.published, vals.cover_media_id, t, t);
      audit(db, 'exhibition.create', 'exhibition', id, { title });
    } else {
      db.prepare(`UPDATE exhibitions SET slug=?,title=?,subtitle=?,dates=?,intro=?,layout=?,show_prices=?,published=?,cover_media_id=?,updated_at=? WHERE id=?`)
        .run(vals.slug, vals.title, vals.subtitle, vals.dates, vals.intro, vals.layout, vals.show_prices, vals.published, vals.cover_media_id, t, id);
      audit(db, 'exhibition.update', 'exhibition', id, { fields: Object.keys(input) });
    }
    if (Array.isArray(input.items)) {
      db.prepare('DELETE FROM exhibition_items WHERE exhibition_id=?').run(id);
      input.items.forEach((it, i) => {
        const aid = typeof it === 'string' ? it : it.artwork_id;
        if (!db.prepare('SELECT 1 FROM artworks WHERE id=?').get(aid)) return;
        db.prepare('INSERT OR IGNORE INTO exhibition_items(exhibition_id,artwork_id,position,note) VALUES (?,?,?,?)').run(id, aid, i, typeof it === 'object' ? clean(it.note) || null : null);
      });
    }
    return getExhibition(db, id);
  });
}

export function deleteExhibition(db, id) {
  db.prepare('DELETE FROM exhibitions WHERE id=?').run(id);
  audit(db, 'exhibition.delete', 'exhibition', id, {});
}

// ---------- custom fields ----------
export function listCustomFields(db) { return db.prepare('SELECT * FROM custom_fields ORDER BY position, label').all(); }
export function saveCustomField(db, { key, label, type = 'text', visibility = 'private' }) {
  const k = key || slugify(label).replace(/-/g, '_').slice(0, 40);
  if (!/^[a-z0-9_]{1,40}$/.test(k) || !clean(label)) throw httpError(400, 'A custom field needs a label');
  if (!['text', 'number', 'date', 'longtext'].includes(type)) throw httpError(400, 'Unknown field type');
  if (!['private', 'public'].includes(visibility)) throw httpError(400, 'Visibility must be private or public');
  const pos = db.prepare('SELECT COALESCE(MAX(position)+1,0) AS p FROM custom_fields').get().p;
  db.prepare(`INSERT INTO custom_fields(key,label,type,visibility,position) VALUES (?,?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET label=excluded.label, type=excluded.type, visibility=excluded.visibility`).run(k, clean(label), type, visibility, pos);
  audit(db, 'custom_field.save', 'custom_field', k, { visibility });
  return db.prepare('SELECT * FROM custom_fields WHERE key=?').get(k);
}

export function stats(db) {
  const q = (s) => db.prepare(s).get().n;
  return {
    artworks: q('SELECT COUNT(*) n FROM artworks'),
    artists: q('SELECT COUNT(*) n FROM artists'),
    available: q("SELECT COUNT(*) n FROM artworks WHERE availability='available'"),
    sold: q("SELECT COUNT(*) n FROM artworks WHERE availability='sold'"),
    public: q('SELECT COUNT(*) n FROM artworks WHERE public=1'),
    images: q('SELECT COUNT(*) n FROM media WHERE artwork_id IS NOT NULL'),
    unassignedImages: q('SELECT COUNT(*) n FROM media WHERE artwork_id IS NULL'),
    withoutImages: q('SELECT COUNT(*) n FROM artworks w WHERE NOT EXISTS (SELECT 1 FROM media m WHERE m.artwork_id=w.id)'),
    exhibitions: q('SELECT COUNT(*) n FROM exhibitions'),
    imports: q("SELECT COUNT(*) n FROM imports WHERE status='applied'"),
    missingFromLastImport: q('SELECT COUNT(*) n FROM artworks WHERE missing_from_last_import=1'),
  };
}

export function httpError(status, message, extra = {}) {
  const e = new Error(message);
  e.status = status;
  Object.assign(e, extra);
  return e;
}
