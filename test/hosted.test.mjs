// Hosted mode: accounts, sessions, isolation between galleries, public catalog, limits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmp, rm } from './helpers.mjs';
import { createHosted } from '../lib/hosted.mjs';
import { request } from 'node:http';

const rawStatus = (base, path, host) => new Promise((ok, fail) => { const u = new URL(base + path); const r = request({ hostname: u.hostname, port: u.port, path, headers: { host } }, (res) => { res.resume(); ok(res.statusCode); }); r.on('error', fail); r.end(); });

async function start(opts = {}) {
  const root = tmp('og-hosted-');
  const h = createHosted({ root, publicOrigin: 'http://localhost', secureCookies: false, ...opts });
  await new Promise((ok) => h.server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${h.server.address().port}`;
  return { h, root, base, stop: () => { h.close(); rm(root); } };
}

function client(base) {
  let cookie = '';
  const call = async (path, { method = 'GET', body, raw, headers = {}, app = true } = {}) => {
    const r = await fetch(base + path, {
      method, redirect: 'manual',
      headers: { ...(app ? { 'x-open-gallery': '1' } : {}), ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    const type = r.headers.get('content-type') || '';
    return { status: r.status, body: type.includes('json') ? await r.json() : await r.text(), headers: r.headers };
  };
  return { call, get cookie() { return cookie; } };
}

test('sign up, work, sign out, sign in', async () => {
  const s = await start();
  try {
    const a = client(s.base);
    assert.equal((await a.call('/api/state')).status, 401);
    assert.match((await a.call('/', { app: false })).body, /Create your gallery/);
    assert.equal((await a.call('/auth/signup', { method: 'POST', body: { gallery: 'North Room', email: 'a@example.com', password: 'short' } })).status, 400);
    const su = await a.call('/auth/signup', { method: 'POST', body: { gallery: 'North Room', email: 'A@Example.com', password: 'correct horse battery' } });
    assert.equal(su.status, 201);
    assert.match(su.headers.get('set-cookie'), /HttpOnly/);
    const st = await a.call('/api/state');
    assert.equal(st.status, 200);
    assert.equal(st.body.settings.gallery.name, 'North Room');
    assert.equal(st.body.dataDir, null, 'server paths are not shown to hosted users');
    assert.equal((await a.call('/auth/signup', { method: 'POST', body: { gallery: 'Again', email: 'a@example.com', password: 'correct horse battery' } })).status, 409);
    await a.call('/auth/logout', { method: 'POST', body: {} });
    assert.equal((await a.call('/api/state')).status, 401);
    assert.equal((await a.call('/auth/login', { method: 'POST', body: { email: 'a@example.com', password: 'wrong password!!' } })).status, 401);
    assert.equal((await a.call('/auth/login', { method: 'POST', body: { email: 'a@example.com', password: 'correct horse battery' } })).status, 200);
    assert.equal((await a.call('/api/state')).status, 200);
  } finally { s.stop(); }
});

test('galleries cannot see each other, and public pages appear only after publishing', async () => {
  const s = await start();
  try {
    const a = client(s.base); const b = client(s.base);
    const sa = await a.call('/auth/signup', { method: 'POST', body: { gallery: 'Alpha', email: 'alpha@example.com', password: 'alpha password 1' } });
    await b.call('/auth/signup', { method: 'POST', body: { gallery: 'Beta', email: 'beta@example.com', password: 'beta password 12' } });
    const w = await a.call('/api/artworks', { method: 'POST', body: { artist: 'Secret Artist', title: 'Alpha Only', price: 5000, public: true, availability: 'available', private: { notes: 'ALPHA-PRIVATE-NOTE' } } });
    assert.equal(w.status, 201);
    assert.equal((await b.call('/api/artworks')).body.total, 0);
    assert.equal((await b.call(`/api/artworks/${w.body.id}`)).status, 404);
    // Public catalog: nothing until Alpha builds it.
    assert.equal((await a.call(`/g/${sa.body.slug}/index.html`, { app: false })).status, 404);
    assert.equal((await a.call('/api/publish', { method: 'POST', body: {} })).status, 200);
    const pub = await client(s.base).call(`/g/${sa.body.slug}/index.html`, { app: false });
    assert.equal(pub.status, 200);
    assert.match(pub.body, /Alpha Only/);
    assert.ok(!pub.body.includes('ALPHA-PRIVATE-NOTE'));
    assert.equal((await client(s.base).call(`/g/${sa.body.slug}/../accounts.db`, { app: false })).status, 404);
    assert.equal((await client(s.base).call(`/g/${sa.body.slug}/..%2F..%2Faccounts.db`, { app: false })).status, 404);
    assert.equal((await client(s.base).call('/g/nobody/index.html', { app: false })).status, 404);
    // Cross-site writes without the app header are refused even with a session.
    assert.equal((await a.call('/api/artworks', { method: 'POST', body: { artist: 'x', title: 'y' }, app: false })).status, 403);
  } finally { s.stop(); }
});

test('unknown hosts, sign-in throttling, storage limit and account deletion', async () => {
  const s = await start({ quotaBytes: 200_000 });
  try {
    const a = client(s.base);
    assert.equal(await rawStatus(s.base, '/api/state', 'evil.example'), 421);
    await a.call('/auth/signup', { method: 'POST', body: { gallery: 'Gamma', email: 'g@example.com', password: 'gamma password 1' } });
    const big = Buffer.alloc(300_000, 1);
    const up = await a.call('/api/media?name=x.png', { method: 'POST', raw: big, headers: { 'content-length': String(big.length) } });
    assert.equal(up.status, 413);
    const acct = (await a.call('/api/account')).body;
    const dir = join(s.root, 'galleries');
    assert.equal((await a.call('/api/account', { method: 'DELETE', body: { password: 'nope nope nope' } })).status, 401);
    assert.equal((await a.call('/api/account', { method: 'DELETE', body: { password: 'gamma password 1' } })).status, 200);
    assert.equal((await a.call('/api/state')).status, 401);
    assert.equal((await client(s.base).call(`/g/${acct.slug}/`, { app: false })).status, 404);
    assert.ok(existsSync(dir));
    const c = client(s.base);
    let last;
    for (let i = 0; i < 22; i++) last = await c.call('/auth/login', { method: 'POST', body: { email: 'x@example.com', password: 'wrong wrong wrong' } });
    assert.equal(last.status, 429);
  } finally { s.stop(); }
});

test('public work pages carry structured data and send inquiries straight to the gallery', async () => {
  const s = await start();
  try {
    const a = client(s.base);
    const su = await a.call('/auth/signup', { method: 'POST', body: { gallery: 'Delta Room', email: 'd@example.com', password: 'delta password 1' } });
    await a.call('/api/settings', { method: 'PATCH', body: { 'catalog.publicBaseUrl': 'https://catalog.example.org/g/delta-room' } });
    const w = (await a.call('/api/artworks', { method: 'POST', body: { artist: 'Ivo Example', title: 'Night Field', year: '2025', medium: 'Oil on linen', price: 6400, price_visibility: 'show', availability: 'available', public: true, dims: [{ kind: 'work', h: 40, w: 30, unit: 'in' }], private: { notes: 'DELTA-SECRET' } } })).body;
    await a.call('/api/publish', { method: 'POST', body: {} });
    const pub = client(s.base);
    const list = await pub.call(`/g/${su.body.slug}/works/index.html`, { app: false });
    const slug = list.body.match(/works\/([^/"]+)\/index\.html/)[1];
    const page = (await pub.call(`/g/${su.body.slug}/works/${slug}/index.html`, { app: false })).body;
    const ld = JSON.parse(page.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
    assert.equal(ld['@type'], 'VisualArtwork');
    assert.equal(ld.creator.name, 'Ivo Example');
    assert.equal(ld.offers.price, 6400);
    assert.equal(ld.offers.availability, 'https://schema.org/InStock');
    assert.match(page, /<link rel="canonical" href="https:\/\/catalog\.example\.org\/g\/delta-room\/works\//);
    assert.match(page, /<form class="inquire" method="post" action="\.\.\/\.\.\/inquire">/);
    assert.ok(!page.includes('DELTA-SECRET'));
    const sitemap = await pub.call(`/g/${su.body.slug}/sitemap.xml`, { app: false });
    assert.match(sitemap.body, /<loc>https:\/\/catalog\.example\.org\/g\/delta-room\/works\//);
    const form = (fields) => pub.call(`/g/${su.body.slug}/inquire`, { method: 'POST', app: false, raw: new URLSearchParams(fields).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    const ok = await form({ artwork_id: w.id, name: 'Ana Collector', email: 'ana@example.net', message: 'Is this still available?', page: 'works/x/' });
    assert.match(ok.body, /sent to the gallery/);
    assert.match((await form({ artwork_id: w.id, name: 'Bot', email: 'bot@example.net', message: 'spam', website: 'http://spam.example' })).body, /Thank you/);
    assert.match((await form({ name: '', email: 'bad', message: '' })).body, /Message not sent/);
    const inbox = (await a.call('/api/inquiries')).body;
    assert.equal(inbox.length, 1, 'honeypot and invalid messages are not stored');
    assert.equal(inbox[0].title, 'Night Field');
    const added = (await a.call(`/api/inquiries/${inbox[0].id}`, { method: 'PATCH', body: { add_contact: true } })).body;
    assert.ok(added.contact_id);
    for (let i = 0; i < 4; i++) await form({ name: 'X', email: 'x@example.net', message: 'again' });
    assert.match((await form({ name: 'X', email: 'x@example.net', message: 'again' })).body, /try again later/);
  } finally { s.stop(); }
});
