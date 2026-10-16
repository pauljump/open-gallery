// Local server: answers only this computer, requires the app header on writes, and never
// serves files outside the folders it publishes.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp, rm } from './helpers.mjs';
import { createApp } from '../server.mjs';

function raw(port, { method = 'GET', path = '/', headers = {}, body = null } = {}) {
  return new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => ok({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', fail);
    if (body) req.write(body);
    req.end();
  });
}

const dataDir = tmp('og-server-');
const app = createApp({ dataDir });
await new Promise((ok) => app.server.listen(0, '127.0.0.1', ok));
const port = app.server.address().port;
after(() => { app.close(); rm(dataDir); });

test('GET /api/state answers on localhost', async () => {
  const r = await raw(port, { path: '/api/state' });
  assert.equal(r.status, 200);
  const state = JSON.parse(r.text);
  assert.equal(state.empty, true);
  assert.equal(state.stats.artworks, 0);
  assert.ok(state.connectors.every((c) => c.state === 'not_connected'));
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  const f = await fetch(`http://127.0.0.1:${port}/api/state`);
  assert.equal(f.status, 200);
});

test('writes without the app header are refused', async () => {
  const r = await raw(port, { method: 'POST', path: '/api/publish' });
  assert.equal(r.status, 403);
  assert.match(r.text, /header/);
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM audit WHERE action='site.build'").get().n, 0);
  const patch = await raw(port, { method: 'PATCH', path: '/api/settings', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ 'gallery.name': 'Nope' }) });
  assert.equal(patch.status, 403);
  const ok = await raw(port, { method: 'PATCH', path: '/api/settings', headers: { 'content-type': 'application/json', 'x-open-gallery': '1' }, body: JSON.stringify({ 'gallery.name': 'Yes' }) });
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.text).gallery.name, 'Yes');
});

test('a foreign Host header is refused (DNS rebinding)', async () => {
  for (const host of ['evil.example', 'evil.example:80', '10.0.0.5']) {
    const r = await raw(port, { path: '/api/state', headers: { host } });
    assert.equal(r.status, 403, host);
  }
  const r = await raw(port, { path: '/api/state', headers: { host: `localhost:${port}` } });
  assert.equal(r.status, 200);
});

test('path traversal out of media/ and site/ is refused', async () => {
  writeFileSync(join(dataDir, 'secret.txt'), 'top secret');
  const db = readFileSync(join(dataDir, 'gallery.db')).subarray(0, 16).toString('latin1');
  assert.ok(db.startsWith('SQLite format'));
  // Encoded dots are the only way a ".." segment survives URL parsing; they must be refused.
  for (const p of ['/media/..%2Fgallery.db', '/media/..%2Fsecret.txt', '/site/..%2Fgallery.db', '/site/..%2F..%2Fsecret.txt', '/media/web/..%2F..%2Fsecret.txt']) {
    const r = await raw(port, { path: p });
    assert.equal(r.status, 404, p);
    assert.ok(!r.text.includes('top secret') && !r.text.includes('SQLite format'), p);
  }
  // Literal ".." (and %2e%2e) is collapsed by the URL parser before routing ("/media/../gallery.db" is "/gallery.db"),
  // so it can only ever reach the app shell or a 404, never a workspace file.
  for (const p of ['/media/../gallery.db', '/site/../gallery.db', '/site/../../etc/passwd', '/media/web/../../secret.txt', '/site/%2e%2e/gallery.db', '/gallery.db']) {
    const r = await raw(port, { path: p });
    assert.ok(r.status === 404 || (r.status === 200 && /^text\/html/.test(r.headers['content-type'])), `${p} -> ${r.status} ${r.headers['content-type']}`);
    assert.ok(!r.text.includes('top secret') && !r.text.includes('SQLite format') && !r.text.includes('root:'), p);
    if (r.status === 200) assert.equal(r.text, (await raw(port, { path: '/nothing-here' })).text, `${p} is the same app shell as any unknown route`);
  }
  // Unknown media names (not a sha256) are 404 too.
  assert.equal((await raw(port, { path: '/media/gallery.db' })).status, 404);
  assert.equal((await raw(port, { path: '/api/nope' })).status, 404);
});
