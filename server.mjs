// Open Gallery local server. Listens on this computer only (127.0.0.1) by default.
import { createServer } from 'node:http';
import { readFileSync, existsSync, createReadStream, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, extname, resolve, normalize, sep } from 'node:path';
import { openWorkspace, isEmptyWorkspace, J, audit } from './lib/db.mjs';
import * as store from './lib/store.mjs';
import { uploadImport, previewImport, applyImport, listImports, importImages } from './lib/importer.mjs';
import { getSettings, updateSettings, FONT_STACKS } from './lib/settings.mjs';
import { buildSite, printCatalogHTML, publicArtwork } from './lib/site.mjs';
import { exportBundle, restoreBundle, verifyWorkspace, dataSize } from './lib/backup.mjs';
import { artsyCandidates, buildArtsyPackage, artsyReconciliation, connectors } from './lib/artsy.mjs';
import { FIELDS, AVAILABILITY } from './lib/fields.mjs';
import { seedDemo } from './lib/demo-seed.mjs';

const ROOT = new URL('.', import.meta.url).pathname;
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.ico': 'image/x-icon' };

export function createApp({ dataDir, host = '127.0.0.1' }) {
  dataDir = resolve(dataDir);
  let db = openWorkspace(dataDir);
  const siteDir = join(dataDir, 'site');

  const send = (res, status, body, type = 'application/json') => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    res.writeHead(status, { 'content-type': type, 'content-length': buf.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
    res.end(buf);
  };
  const sendFile = (res, path, cache = 'no-cache') => {
    if (!existsSync(path) || !statSync(path).isFile()) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'content-type': TYPES[extname(path).toLowerCase()] || 'application/octet-stream', 'content-length': statSync(path).size, 'cache-control': cache, 'x-content-type-options': 'nosniff' });
    createReadStream(path).pipe(res);
  };
  const within = (base, rel) => {
    const p = normalize(join(base, rel));
    return p.startsWith(base + sep) || p === base ? p : null;
  };
  const body = (req, limit = 512 * 1024 * 1024) => new Promise((ok, fail) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { fail(store.httpError(413, 'File too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', fail);
  });
  const json = async (req) => { const b = await body(req, 20 * 1024 * 1024); if (!b.length) return {}; try { return JSON.parse(b.toString('utf8')); } catch { throw store.httpError(400, 'Invalid JSON'); } };

  function state() {
    const lastBuild = J(db.prepare("SELECT value FROM meta WHERE key='last_site_build'").get()?.value, null);
    return {
      version: VERSION, dataDir, stats: store.stats(db), settings: getSettings(db), connectors: connectors(db), lastBuild,
      workspaceId: db.prepare("SELECT value FROM meta WHERE key='workspace_id'").get()?.value,
      fonts: Object.fromEntries(Object.entries(FONT_STACKS).map(([k, v]) => [k, v.label])), availability: AVAILABILITY,
      fields: FIELDS.map(({ key, label, visibility, type }) => ({ key, label, visibility, type })), customFields: store.listCustomFields(db),
      empty: store.stats(db).artworks === 0,
      demo: db.prepare("SELECT value FROM meta WHERE key='demo'").get()?.value === 'true',
    };
  }

  async function api(req, res, url) {
    const p = url.pathname.replace(/^\/api/, '');
    const m = (re) => p.match(re);
    const q = Object.fromEntries(url.searchParams);
    const method = req.method;
    let r;
    if (method === 'GET' && p === '/state') return send(res, 200, state());
    if (method === 'GET' && p === '/artworks') return send(res, 200, store.listArtworks(db, { ...q, limit: Math.min(Number(q.limit) || 500, 5000), offset: Number(q.offset) || 0 }));
    if (method === 'POST' && p === '/artworks') return send(res, 201, store.createArtwork(db, await json(req)));
    if (method === 'POST' && p === '/artworks/bulk') {
      const { ids = [], patch = {} } = await json(req);
      const allowed = {};
      if ('public' in patch) allowed.public = !!patch.public;
      if ('availability' in patch) allowed.availability = patch.availability;
      if ('price_visibility' in patch) allowed.price_visibility = patch.price_visibility;
      db.exec('BEGIN');
      try { for (const id of ids) store.updateArtwork(db, id, allowed); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
      return send(res, 200, { updated: ids.length });
    }
    if ((r = m(/^\/artworks\/(aw_\w+)$/))) {
      if (method === 'GET') { const aw = store.getArtwork(db, r[1]); return aw ? send(res, 200, aw) : send(res, 404, { error: 'Artwork not found' }); }
      if (method === 'PATCH') return send(res, 200, store.updateArtwork(db, r[1], await json(req)));
      if (method === 'DELETE') { store.deleteArtwork(db, r[1]); return send(res, 200, { deleted: r[1] }); }
    }
    if ((r = m(/^\/artworks\/(aw_\w+)\/public-preview$/)) && method === 'GET') {
      const aw = store.getArtwork(db, r[1]);
      return send(res, 200, publicArtwork(aw, getSettings(db), store.listCustomFields(db).filter((f) => f.visibility === 'public')));
    }
    if (method === 'GET' && p === '/artists') return send(res, 200, store.listArtists(db));
    if ((r = m(/^\/artists\/(ar_\w+)$/)) && method === 'PATCH') return send(res, 200, store.updateArtist(db, r[1], await json(req)));
    if (method === 'POST' && p === '/media') return send(res, 201, store.storeMedia(db, dataDir, await body(req, 200 * 1024 * 1024), q.name || 'image', q.artwork || null));
    if (method === 'GET' && p === '/media/unassigned') return send(res, 200, store.unassignedMedia(db));
    if ((r = m(/^\/media\/(md_\w+)$/))) {
      if (method === 'PATCH') return send(res, 200, store.updateMedia(db, r[1], await json(req)));
      if (method === 'DELETE') { store.removeMedia(db, r[1]); return send(res, 200, { deleted: r[1] }); }
    }
    if ((r = m(/^\/media\/(md_\w+)\/web$/)) && method === 'PUT') {
      // A browser-made web copy (resized, re-encoded JPEG, which drops camera metadata).
      const md = db.prepare('SELECT sha256 FROM media WHERE id=?').get(r[1]);
      if (!md) throw store.httpError(404, 'Image not found');
      const buf = await body(req, 20 * 1024 * 1024);
      if (buf[0] !== 0xff || buf[1] !== 0xd8) throw store.httpError(415, 'Web copy must be a JPEG');
      mkdirSync(join(dataDir, 'media', 'web'), { recursive: true });
      writeFileSync(join(dataDir, 'media', 'web', `${md.sha256}.jpg`), buf);
      return send(res, 200, { ok: true });
    }
    if (method === 'GET' && p === '/publish/needs-web') {
      const rows = db.prepare(`SELECT DISTINCT m.id, m.sha256, m.ext FROM media m JOIN artworks w ON w.id=m.artwork_id WHERE w.public=1 AND m.public=1`).all();
      const logo = getSettings(db).theme.logoMediaId;
      if (logo) { const l = db.prepare('SELECT id, sha256, ext FROM media WHERE id=?').get(logo); if (l) rows.push(l); }
      return send(res, 200, rows.filter((m) => !existsSync(join(dataDir, 'media', 'web', `${m.sha256}.jpg`))).map((m) => ({ ...m, url: `/media/${m.sha256}.${m.ext}` })));
    }
    if (method === 'POST' && p === '/imports') return send(res, 201, uploadImport(db, dataDir, q.name, await body(req, 100 * 1024 * 1024)));
    if (method === 'GET' && p === '/imports') return send(res, 200, listImports(db));
    if ((r = m(/^\/imports\/(im_\w+)\/preview$/)) && method === 'POST') return send(res, 200, previewImport(db, dataDir, r[1], await json(req)));
    if ((r = m(/^\/imports\/(im_\w+)\/apply$/)) && method === 'POST') return send(res, 200, applyImport(db, dataDir, r[1], await json(req)));
    if (method === 'POST' && p === '/images') return send(res, 200, importImages(db, dataDir, [{ name: q.name || 'image', buf: await body(req, 200 * 1024 * 1024) }]));
    if (method === 'GET' && p === '/exhibitions') return send(res, 200, store.listExhibitions(db));
    if (method === 'POST' && p === '/exhibitions') return send(res, 201, store.saveExhibition(db, null, await json(req)));
    if ((r = m(/^\/exhibitions\/(ex_\w+)$/))) {
      if (method === 'GET') { const e = store.getExhibition(db, r[1]); return e ? send(res, 200, e) : send(res, 404, { error: 'Exhibition not found' }); }
      if (method === 'PUT' || method === 'PATCH') return send(res, 200, store.saveExhibition(db, r[1], await json(req)));
      if (method === 'DELETE') { store.deleteExhibition(db, r[1]); return send(res, 200, { deleted: r[1] }); }
    }
    if (method === 'GET' && p === '/settings') return send(res, 200, getSettings(db));
    if (method === 'PATCH' && p === '/settings') {
      const out = updateSettings(db, await json(req));
      return send(res, Object.keys(out.errors).length ? 400 : 200, Object.keys(out.errors).length ? { error: 'Some settings were not valid', errors: out.errors } : out.settings);
    }
    if (method === 'GET' && p === '/custom-css') return send(res, 200, { css: existsSync(join(dataDir, 'custom', 'site.css')) ? readFileSync(join(dataDir, 'custom', 'site.css'), 'utf8') : '' });
    if (method === 'PUT' && p === '/custom-css') {
      const { css = '' } = await json(req);
      if (/<\/?(script|style)/i.test(css)) throw store.httpError(400, 'Custom CSS cannot contain HTML tags');
      writeFileSync(join(dataDir, 'custom', 'site.css'), String(css).slice(0, 200000));
      audit(db, 'custom_css.save', null, null, { bytes: css.length });
      return send(res, 200, { ok: true });
    }
    if (method === 'POST' && p === '/custom-fields') return send(res, 201, store.saveCustomField(db, await json(req)));
    if (method === 'POST' && p === '/publish') return send(res, 200, buildSite(db, dataDir, siteDir));
    if (method === 'GET' && p === '/export') {
      const { zip, manifest } = exportBundle(db, dataDir);
      const name = `open-gallery-export-${manifest.created_at.slice(0, 19).replace(/[:T]/g, '-')}.zip`;
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': zip.length, 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store' });
      return res.end(zip);
    }
    if (method === 'GET' && p === '/verify') return send(res, 200, { ...verifyWorkspace(db, dataDir), bytes: dataSize(dataDir) });
    if (method === 'POST' && p === '/restore') {
      const buf = await body(req);
      if (!isEmptyWorkspace(dataDir)) throw store.httpError(409, 'Restore only runs into an empty workspace. Start Open Gallery with a new data folder, then restore there.');
      db.close();
      try { return send(res, 200, restoreBundle(buf, dataDir)); } finally { db = openWorkspace(dataDir); }
    }
    if (method === 'POST' && p === '/demo') {
      if (!isEmptyWorkspace(dataDir)) throw store.httpError(409, 'The sample gallery can only be loaded into an empty workspace.');
      return send(res, 201, seedDemo(db, dataDir));
    }
    if (method === 'GET' && p === '/artsy/candidates') return send(res, 200, artsyCandidates(db));
    if (method === 'POST' && p === '/artsy/package') {
      const { ids = [], unit } = await json(req);
      const { zip, report } = buildArtsyPackage(db, dataDir, ids, { unit });
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': zip.length, 'content-disposition': `attachment; filename="artsy-bulk-import-${report.createdAt.slice(0, 10)}.zip"`, 'x-report': encodeURIComponent(JSON.stringify({ included: report.included, skipped: report.skipped.length, batches: report.batches })), 'cache-control': 'no-store' });
      return res.end(zip);
    }
    if (method === 'GET' && p === '/artsy/reconciliation') return send(res, 200, artsyReconciliation(db).items);
    if (method === 'GET' && p === '/artsy/reconciliation.csv') {
      const { csv } = artsyReconciliation(db);
      res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="artsy-reconciliation.csv"' });
      return res.end(csv);
    }
    if (method === 'GET' && p === '/audit') return send(res, 200, db.prepare('SELECT * FROM audit ORDER BY seq DESC LIMIT ?').all(Math.min(Number(q.limit) || 100, 1000)).map((a) => ({ ...a, detail: J(a.detail) })));
    return send(res, 404, { error: 'Unknown endpoint' });
  }

  const allowedHosts = new Set([`127.0.0.1`, 'localhost', '[::1]', host]);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    try {
      // Block DNS-rebinding and cross-site requests: the app is for this computer.
      const hostName = (req.headers.host || '').replace(/:\d+$/, '');
      if (!allowedHosts.has(hostName)) return send(res, 403, { error: 'Open Gallery only answers on this computer.' });
      if (url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.headers['x-open-gallery'] !== '1') return send(res, 403, { error: 'Missing app header' });
        return await api(req, res, url);
      }
      if (url.pathname.startsWith('/media/')) {
        const rel = decodeURIComponent(url.pathname.slice(7));
        if (!/^(web\/)?[0-9a-f]{64}\.\w+$/.test(rel)) return send(res, 404, { error: 'Not found' });
        return sendFile(res, join(dataDir, 'media', rel), 'private, max-age=31536000, immutable');
      }
      if (url.pathname.startsWith('/site/')) {
        // Preview of the last published build, exactly as it would be uploaded.
        let rel = decodeURIComponent(url.pathname.slice(6)) || 'index.html';
        if (rel.endsWith('/')) rel += 'index.html';
        const pth = within(siteDir, rel);
        return pth ? sendFile(res, pth) : send(res, 404, { error: 'Not found' });
      }
      if (url.pathname.startsWith('/print/exhibitions/')) {
        const ex = store.getExhibition(db, url.pathname.split('/')[3]);
        if (!ex) return send(res, 404, 'Exhibition not found', 'text/plain');
        const settings = getSettings(db);
        const pc = store.listCustomFields(db).filter((f) => f.visibility === 'public');
        const works = ex.items.filter((i) => i.artwork).map((i) => publicArtwork(i.artwork, settings, pc, { showPrices: ex.show_prices }));
        return send(res, 200, printCatalogHTML(ex, works, settings, { assetBase: '/' }), 'text/html; charset=utf-8');
      }
      let rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const pth = within(join(ROOT, 'public'), rel);
      if (pth && existsSync(pth) && statSync(pth).isFile()) return sendFile(res, pth);
      return sendFile(res, join(ROOT, 'public', 'index.html'));
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      return send(res, status, { error: status === 500 ? `Something went wrong: ${e.message}` : e.message, ...(e.undecided ? { undecided: e.undecided } : {}) });
    }
  });
  return { server, get db() { return db; }, close: () => { server.close(); db.close(); } };
}
