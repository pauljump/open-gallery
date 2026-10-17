// Fetch a public web resource on the gallery's behalf (its own images or website), with limits.
// In hosted mode private and local addresses are refused so the server cannot be used to reach
// internal services.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

function privateAddress(ip) {
  if (ip.includes(':')) {
    const v = ip.toLowerCase();
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:127.') || v.startsWith('::ffff:10.') || v.startsWith('::ffff:192.168.');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

export async function safeFetch(url, { allowPrivate = false, maxBytes = 30e6, timeoutMs = 20000, accept = '*/*', redirects = 4 } = {}) {
  let u;
  try { u = new URL(url); } catch { throw new Error(`Not a web address: ${url}`); }
  for (let hop = 0; hop <= redirects; hop++) {
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http and https addresses can be fetched');
    if (!allowPrivate) {
      const host = u.hostname.replace(/^\[|\]$/g, '');
      const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
      if (addrs.some((a) => privateAddress(a.address))) throw new Error('That address points to a private network and cannot be fetched');
    }
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try { res = await fetch(u, { redirect: 'manual', signal: ctl.signal, headers: { accept, 'user-agent': 'OpenGallery-Importer/0.4 (+https://github.com/pauljump/open-gallery)' } }); }
    finally { clearTimeout(t); }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { u = new URL(res.headers.get('location'), u); continue; }
    if (!res.ok) throw new Error(`${u.hostname} answered ${res.status}`);
    const len = Number(res.headers.get('content-length') || 0);
    if (len > maxBytes) throw new Error('File is too large');
    const chunks = []; let n = 0;
    for await (const c of res.body) { n += c.length; if (n > maxBytes) throw new Error('File is too large'); chunks.push(c); }
    return { url: u.href, type: res.headers.get('content-type') || '', buf: Buffer.concat(chunks) };
  }
  throw new Error('Too many redirects');
}
