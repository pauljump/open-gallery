// Hosted mode: many galleries on one server, each in its own workspace folder with its own
// database and originals, exactly like a local install. The account layer only decides which
// workspace a request belongs to; nothing is shared between galleries.
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, rmSync, readFileSync, statSync, createReadStream } from 'node:fs';
import { join, normalize, sep, extname } from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { createApp } from '../server.mjs';
import { updateSettings } from './settings.mjs';
import { slugify } from './normalize.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const SESSION_DAYS = 30;
const RESERVED = new Set(['www', 'api', 'app', 'admin', 'login', 'signup', 'auth', 'g', 'static', 'assets', 'help', 'support', 'open-gallery', 'demo']);
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8' };

const hashToken = (t) => createHash('sha256').update(t).digest('hex');
function hashPassword(pw) {
  const salt = randomBytes(16);
  const key = scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [, salt, key] = String(stored).split('$');
  if (!salt || !key) return false;
  const got = scryptSync(pw, Buffer.from(salt, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(got, Buffer.from(key, 'hex'));
}

export function openAccounts(root) {
  mkdirSync(join(root, 'galleries'), { recursive: true });
  const db = new DatabaseSync(join(root, 'accounts.db'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS galleries (id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL, created_at TEXT NOT NULL);`);
  return db;
}

export function createHosted({ root, publicOrigin = '', quotaBytes = 2e9, secureCookies = true, allowedHosts = [] } = {}) {
  const accounts = openAccounts(root);
  const apps = new Map(); // gallery id -> createApp instance
  const attempts = new Map(); // ip -> [timestamps] for sign-in rate limiting
  const hostSet = new Set(['127.0.0.1', 'localhost', ...allowedHosts]);

  const appFor = (g) => {
    if (!apps.has(g.id)) {
      if (apps.size >= 50) { const [oldId, old] = apps.entries().next().value; old.db.close(); apps.delete(oldId); }
      apps.set(g.id, createApp({ dataDir: join(root, 'galleries', g.id), hosted: true, quotaBytes }));
    }
    return apps.get(g.id);
  };

  const send = (res, status, body, type = 'application/json', headers = {}) => {
    const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    res.writeHead(status, { 'content-type': type, 'content-length': buf.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', ...headers });
    res.end(buf);
  };
  const readJSON = (req) => new Promise((ok, fail) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > 64 * 1024) { fail(Object.assign(new Error('Too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { ok(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { fail(Object.assign(new Error('Invalid request'), { status: 400 })); } });
  });
  const cookie = (req, name) => (req.headers.cookie || '').split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === name)?.[1];
  const sessionCookie = (token, maxAge) => `og_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookies ? '; Secure' : ''}`;

  function currentUser(req) {
    const t = cookie(req, 'og_session');
    if (!t || !/^[a-f0-9]{64}$/.test(t)) return null;
    const s = accounts.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash=?').get(hashToken(t));
    if (!s || s.expires_at < new Date().toISOString()) return null;
    return accounts.prepare('SELECT id, email FROM users WHERE id=?').get(s.user_id);
  }
  function startSession(res, userId) {
    const token = randomBytes(32).toString('hex');
    const exp = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
    accounts.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)').run(hashToken(token), userId, exp, new Date().toISOString());
    return sessionCookie(token, SESSION_DAYS * 86400);
  }
  function limited(req) {
    const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '?';
    const now = Date.now();
    const list = (attempts.get(ip) || []).filter((t) => now - t < 15 * 60e3);
    list.push(now); attempts.set(ip, list);
    return list.length > 20;
  }
  const uniqueSlug = (name) => {
    let base = slugify(name).slice(0, 40) || 'gallery';
    if (RESERVED.has(base)) base = `${base}-gallery`;
    let slug = base; let i = 2;
    while (accounts.prepare('SELECT 1 FROM galleries WHERE slug=?').get(slug)) slug = `${base}-${i++}`;
    return slug;
  };

  async function auth(req, res, path) {
    if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
    if (req.headers['x-open-gallery'] !== '1') return send(res, 403, { error: 'Missing app header' });
    const b = await readJSON(req);
    if (path === '/auth/logout') {
      const t = cookie(req, 'og_session');
      if (t) accounts.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(t));
      return send(res, 200, { ok: true }, 'application/json', { 'set-cookie': sessionCookie('', 0) });
    }
    if (limited(req)) return send(res, 429, { error: 'Too many attempts. Wait a few minutes and try again.' });
    const email = String(b.email || '').trim().toLowerCase();
    const password = String(b.password || '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return send(res, 400, { error: 'Enter a valid email address' });
    if (path === '/auth/signup') {
      const name = String(b.gallery || '').trim().slice(0, 120);
      if (!name) return send(res, 400, { error: 'Enter your gallery name' });
      if (password.length < 10) return send(res, 400, { error: 'Use a password of at least 10 characters' });
      if (accounts.prepare('SELECT 1 FROM users WHERE email=?').get(email)) return send(res, 409, { error: 'An account with that email already exists. Sign in instead.' });
      const uid = `us_${randomBytes(9).toString('hex')}`;
      const gid = `gl_${randomBytes(9).toString('hex')}`;
      const slug = uniqueSlug(name);
      const t = new Date().toISOString();
      accounts.prepare('INSERT INTO users(id,email,password,created_at) VALUES (?,?,?,?)').run(uid, email, hashPassword(password), t);
      accounts.prepare('INSERT INTO galleries(id,slug,name,owner_id,created_at) VALUES (?,?,?,?,?)').run(gid, slug, name, uid, t);
      const app = appFor({ id: gid });
      updateSettings(app.db, { 'gallery.name': name, 'gallery.email': email });
      if (publicOrigin.startsWith('https://')) updateSettings(app.db, { 'catalog.publicBaseUrl': `${publicOrigin}/g/${slug}` });
      return send(res, 201, { ok: true, slug }, 'application/json', { 'set-cookie': startSession(res, uid) });
    }
    if (path === '/auth/login') {
      const u = accounts.prepare('SELECT id, password FROM users WHERE email=?').get(email);
      if (!u || !checkPassword(password, u.password)) return send(res, 401, { error: 'Email or password is not right' });
      return send(res, 200, { ok: true }, 'application/json', { 'set-cookie': startSession(res, u.id) });
    }
    return send(res, 404, { error: 'Not found' });
  }

  async function deleteAccount(req, res, user, gallery) {
    const b = await readJSON(req);
    const u = accounts.prepare('SELECT password FROM users WHERE id=?').get(user.id);
    if (!checkPassword(String(b.password || ''), u.password)) return send(res, 401, { error: 'Password is not right' });
    const app = apps.get(gallery.id);
    if (app) { app.db.close(); apps.delete(gallery.id); }
    rmSync(join(root, 'galleries', gallery.id), { recursive: true, force: true });
    accounts.prepare('DELETE FROM users WHERE id=?').run(user.id);
    return send(res, 200, { ok: true }, 'application/json', { 'set-cookie': sessionCookie('', 0) });
  }

  // Open catalog: published works from galleries that opted in, read from each gallery's own
  // last published feed, so unpublishing or opting out removes works on the next refresh.
  let index = { at: 0, works: [], galleries: 0 };
  function openIndex() {
    if (Date.now() - index.at < 60e3) return index;
    const works = []; let galleries = 0;
    for (const g of accounts.prepare('SELECT id, slug, name FROM galleries').all()) {
      const dir = join(root, 'galleries', g.id);
      const feedPath = join(dir, 'site', 'catalog.json');
      if (!existsSync(feedPath) || !existsSync(join(dir, 'gallery.db'))) continue;
      let opted = false;
      try { const d = new DatabaseSync(join(dir, 'gallery.db'), { readOnly: true }); opted = d.prepare("SELECT value FROM settings WHERE key='privacy.listInOpenCatalog'").get()?.value === 'true'; d.close(); } catch { opted = false; }
      if (!opted) continue;
      let feed; try { feed = JSON.parse(readFileSync(feedPath, 'utf8')); } catch { continue; }
      galleries++;
      const abs = (u) => (/^https?:\/\//.test(u) ? u : `/g/${g.slug}/${u}`);
      for (const w of feed.works || []) {
        works.push({ id: w.id, gallery: { name: feed.publisher?.name || g.name, slug: g.slug }, artist: w.artist?.name || '', title: w.title, year: w.year, medium: w.medium,
          dimensions: w.dimensions_display || [], availability: w.availability, price: w.price || null, image: w.images?.[0] ? abs(w.images[0].url) : null,
          url: abs(`works/${w.slug}/`), updated_at: w.updated_at, ai_training_permitted: !!feed.rights?.ai_training_permitted });
      }
    }
    works.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    index = { at: Date.now(), works, galleries };
    return index;
  }
  const escH = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function catalogPage(req, res, url) {
    const ix = openIndex();
    if (url.pathname === '/catalog/feed.json') return send(res, 200, { format: 'open-gallery-catalog-index/0.1', generated_at: new Date(ix.at).toISOString(), galleries: ix.galleries, note: 'Works published by participating galleries. Copyright remains with the artists; inquiries go to each gallery.', works: ix.works }, 'application/json', { 'cache-control': 'public, max-age=60' });
    const q = (url.searchParams.get('q') || '').trim().toLowerCase().slice(0, 100);
    const avail = url.searchParams.get('availability') ?? 'available';
    const max = Number(url.searchParams.get('max') || 0);
    const page = Math.max(1, Number(url.searchParams.get('page') || 1));
    let list = ix.works.filter((w) => (!avail || w.availability === avail) && (!max || (w.price?.amount != null && w.price.amount <= max))
      && (!q || `${w.artist} ${w.title} ${w.medium || ''} ${w.gallery.name}`.toLowerCase().includes(q)));
    const total = list.length; const per = 60;
    list = list.slice((page - 1) * per, page * per);
    const qs = (p) => `?${new URLSearchParams({ ...(q ? { q } : {}), availability: avail, ...(max ? { max } : {}), page: p })}`;
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Open catalog · Open Gallery</title>
<meta name="description" content="Browse works from independent galleries. Every inquiry goes directly to the gallery."><link rel="stylesheet" href="/hosted.css"><link rel="alternate" type="application/json" href="/catalog/feed.json">
<style>.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:24px 18px;list-style:none;padding:0;margin:24px 0}.grid a{text-decoration:none;display:block}.frame{aspect-ratio:1/1;background:var(--line);display:flex;align-items:center;justify-content:center;border-radius:4px;overflow:hidden}.frame img{width:100%;height:100%;object-fit:contain}.cap{margin-top:8px;font-size:14px}.cap .t{font-style:italic}.cap .m{color:var(--muted);display:block;font-size:13px}form.f{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end}form.f label{margin:0}form.f input,form.f select{width:auto}.pager{display:flex;gap:16px}</style></head>
<body><main><header><a href="/" style="text-decoration:none;display:flex;gap:10px;align-items:center;color:inherit"><span class="mark" aria-hidden="true"></span> Open Gallery</a></header>
<h1>Open catalog</h1><p class="lede">${ix.galleries ? `Works from ${ix.galleries} participating galler${ix.galleries === 1 ? 'y' : 'ies'}. Each work links to the gallery's own page, and inquiries go straight to the gallery.` : 'The open catalog is new. Galleries that choose to list their published works will appear here, each linking to the gallery\'s own page.'}</p>
<form class="f" role="search"><div><label for="q">Search</label><input id="q" name="q" value="${escH(q)}" placeholder="Artist, title, medium, gallery"></div>
<div><label for="av">Show</label><select id="av" name="availability"><option value="available"${avail === 'available' ? ' selected' : ''}>Available</option><option value=""${!avail ? ' selected' : ''}>All published</option></select></div>
<div><label for="mx">Up to (price)</label><input id="mx" name="max" type="number" min="0" value="${max || ''}" style="width:120px"></div><button type="submit">Search</button></form>
<p class="small">${total} work${total === 1 ? '' : 's'}</p>
<ul class="grid">${list.map((w) => `<li><a href="${escH(w.url)}"><div class="frame">${w.image ? `<img src="${escH(w.image)}" alt="${escH(`${w.artist}, ${w.title}`)}" loading="lazy">` : ''}</div><div class="cap"><strong>${escH(w.artist)}</strong><br><span class="t">${escH(w.title)}</span>${w.year ? `, ${escH(w.year)}` : ''}<span class="m">${escH(w.gallery.name)}${w.price?.display ? ` · ${escH(w.price.display)}` : ''}</span></div></a></li>`).join('')}</ul>
<p class="pager">${page > 1 ? `<a href="${qs(page - 1)}">Previous</a>` : ''}${page * per < total ? `<a href="${qs(page + 1)}">Next</a>` : ''}</p>
<p class="small">Galleries choose to appear here and can leave at any time. Images and artworks remain the copyright of the artists. <a href="/">Run your gallery on Open Gallery</a>, free.</p></main></body></html>`;
    return send(res, 200, html, 'text/html; charset=utf-8', { 'cache-control': 'public, max-age=60' });
  }

  // Public catalog of one gallery: the files its last Publish built, nothing else.
  const inquiryHits = new Map();
  async function inquire(req, res, g, slug) {
    const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '?';
    const now = Date.now();
    const hits = (inquiryHits.get(ip) || []).filter((t) => now - t < 3600e3);
    hits.push(now); inquiryHits.set(ip, hits);
    const page = (title, msg) => send(res, 200, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><link rel="stylesheet" href="/g/${slug}/assets/site.css"></head><body><main><h1>${title}</h1><p class="lede">${msg}</p><p><a href="/g/${slug}/">Back to the catalog</a></p></main></body></html>`, 'text/html; charset=utf-8');
    if (hits.length > 5) return page('Please try again later', 'Too many messages were sent from this connection in the last hour.');
    const raw = await new Promise((ok, fail) => { let n = 0; const c = []; req.on('data', (d) => { n += d.length; if (n > 16e3) { fail(Object.assign(new Error('Too large'), { status: 413 })); req.destroy(); } else c.push(d); }); req.on('end', () => ok(Buffer.concat(c).toString('utf8'))); });
    const f = Object.fromEntries(new URLSearchParams(raw));
    if (f.website) return page('Thank you', 'Your message was sent.'); // honeypot: pretend success
    try { appFor(g).receiveInquiry(f); } catch (e) { return page('Message not sent', e.status === 400 ? e.message : 'Something went wrong. Please try again.'); }
    return page('Thank you', 'Your message was sent to the gallery. They will reply to the email address you gave.');
  }

  function publicSite(req, res, url) {
    const [, , slug, ...rest] = url.pathname.split('/');
    const g = accounts.prepare('SELECT id FROM galleries WHERE slug=?').get(slug);
    if (!g) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    if (rest.length === 1 && rest[0] === 'inquire' && req.method === 'POST') return inquire(req, res, g, slug);
    if (rest.length === 0) { res.writeHead(301, { location: `/g/${slug}/` }); return res.end(); }
    let rel = decodeURIComponent(rest.join('/')) || 'index.html';
    if (rel.endsWith('/')) rel += 'index.html';
    const base = join(root, 'galleries', g.id, 'site');
    const p = normalize(join(base, rel));
    if (!p.startsWith(base + sep) || !existsSync(p) || !statSync(p).isFile()) return send(res, 404, 'This page is not published.', 'text/plain; charset=utf-8');
    res.writeHead(200, { 'content-type': TYPES[extname(p).toLowerCase()] || 'application/octet-stream', 'content-length': statSync(p).size, 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff' });
    createReadStream(p).pipe(res);
  }

  const handle = async (req, res) => {
    const url = new URL(req.url, 'http://hosted');
    try {
      const hostName = (req.headers.host || '').replace(/:\d+$/, '');
      if (!hostSet.has(hostName)) return send(res, 421, { error: 'Unknown host' });
      if (url.pathname.startsWith('/auth/')) return await auth(req, res, url.pathname);
      if (url.pathname.startsWith('/g/')) return await publicSite(req, res, url);
      if (url.pathname === '/healthz') return send(res, 200, { ok: true });
      if (url.pathname === '/catalog' || url.pathname === '/catalog/' || url.pathname === '/catalog/feed.json') return catalogPage(req, res, url);
      const user = currentUser(req);
      if (!user) {
        if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/') || url.pathname.startsWith('/site/') || url.pathname.startsWith('/print/')) return send(res, 401, { error: 'Sign in first' });
        const page = join(ROOT, 'public', url.pathname === '/hosted.css' ? 'hosted.css' : 'hosted.html');
        return send(res, 200, readFileSync(page, 'utf8'), url.pathname === '/hosted.css' ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8');
      }
      const gallery = accounts.prepare('SELECT * FROM galleries WHERE owner_id=?').get(user.id);
      if (!gallery) return send(res, 404, { error: 'No gallery for this account' });
      if (url.pathname === '/api/account') {
        if (req.method === 'GET') return send(res, 200, { email: user.email, slug: gallery.slug, publicUrl: `${publicOrigin}/g/${gallery.slug}/`, quotaBytes });
        if (req.method === 'DELETE' && req.headers['x-open-gallery'] === '1') return await deleteAccount(req, res, user, gallery);
      }
      const result = await appFor(gallery).handle(req, res);
      if (req.method !== 'GET' && (url.pathname === '/api/publish' || url.pathname === '/api/settings')) index.at = 0;
      return result;
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      return send(res, status, { error: status === 500 ? 'Something went wrong. Please try again.' : e.message });
    }
  };
  const server = createServer(handle);
  return { server, handle, accounts, refreshIndex: () => { index.at = 0; }, close: () => { server.close(); for (const a of apps.values()) a.db.close(); accounts.close(); } };
}
