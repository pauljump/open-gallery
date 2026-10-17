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

  // Public catalog of one gallery: the files its last Publish built, nothing else.
  function publicSite(req, res, url) {
    const [, , slug, ...rest] = url.pathname.split('/');
    const g = accounts.prepare('SELECT id FROM galleries WHERE slug=?').get(slug);
    if (!g) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
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
      if (url.pathname.startsWith('/g/')) return publicSite(req, res, url);
      if (url.pathname === '/healthz') return send(res, 200, { ok: true });
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
      return await appFor(gallery).handle(req, res);
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      return send(res, status, { error: status === 500 ? 'Something went wrong. Please try again.' : e.message });
    }
  };
  const server = createServer(handle);
  return { server, handle, accounts, close: () => { server.close(); for (const a of apps.values()) a.db.close(); accounts.close(); } };
}
