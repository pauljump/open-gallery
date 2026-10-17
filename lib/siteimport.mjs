// Import from a gallery's own website. Reads public pages on that one site (respecting
// robots.txt), finds artwork pages from structured data or page conventions, and turns them
// into an ordinary spreadsheet that goes through the normal reviewed import.
import { safeFetch } from './fetchsafe.mjs';
import { toCSV } from './tables.mjs';

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', times: '×', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', eacute: 'é' };
const decode = (s) => String(s || '').replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()] ?? m));
const text = (html) => decode(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
const meta = (html, prop) => {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, 'i');
  const tag = html.match(re)?.[0];
  return tag ? decode(tag.match(/content=["']([^"']*)["']/i)?.[1] || '') : '';
};

const ART_TYPES = new Set(['visualartwork', 'painting', 'sculpture', 'photograph', 'drawing', 'creativework', 'product', 'artwork']);
const MEDIUM_RE = /\b((?:oil|acrylic|watercolou?r|gouache|ink|graphite|charcoal|pastel|tempera|encaustic|mixed media|pigment print|archival pigment print|gelatin silver print|c-print|chromogenic print|inkjet print|silkscreen|screenprint|lithograph|etching|woodcut|bronze|ceramic|stoneware|porcelain|marble|wood|steel|aluminium|aluminum|glass|textile|collage)\b[^\n<]{0,60})/i;
const DIMS_RE = /(\d+(?:[.,]\d+)?(?:\s+\d\/\d)?\s*[x×]\s*\d+(?:[.,]\d+)?(?:\s+\d\/\d)?(?:\s*[x×]\s*\d+(?:[.,]\d+)?)?\s*(?:cm|in\b|inches|mm|"))/i;
const PRICE_RE = /([$€£])\s?(\d{1,3}(?:[,.]\d{3})+|\d{3,})(?:\.\d{2})?/;
const YEAR_RE = /\b(1[89]\d\d|20[0-4]\d)(?:\s*[-–]\s*\d{2,4})?\b/;
const ART_PATH = /\/(artworks?|works?|inventory|catalogu?e|viewing-rooms?|available-works|pieces?|art)\//i;

function jsonLd(html) {
  const out = [];
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1].trim());
      const stack = Array.isArray(data) ? [...data] : [data];
      while (stack.length) {
        const n = stack.shift();
        if (!n || typeof n !== 'object') continue;
        if (Array.isArray(n['@graph'])) stack.push(...n['@graph']);
        const types = [].concat(n['@type'] || []).map((t) => String(t).toLowerCase());
        if (types.some((t) => ART_TYPES.has(t))) out.push(n);
      }
    } catch { /* ignore broken blocks */ }
  }
  return out;
}

const nameOf = (v) => (typeof v === 'string' ? v : Array.isArray(v) ? v.map(nameOf).filter(Boolean).join(', ') : v?.name || '');
const qty = (v) => (v == null ? '' : typeof v === 'object' ? `${v.value ?? ''}${v.unitText ? ' ' + v.unitText : v.unitCode ? ' ' + ({ CMT: 'cm', INH: 'in', MMT: 'mm' }[v.unitCode] || v.unitCode) : ''}`.trim() : String(v));

function fromStructured(n, pageUrl) {
  const offer = [].concat(n.offers || [])[0] || {};
  const img = [].concat(n.image || []).map((i) => (typeof i === 'string' ? i : i?.url || i?.contentUrl)).filter(Boolean);
  const h = qty(n.height); const w = qty(n.width); const d = qty(n.depth);
  const unit = /cm/.test(h + w) ? 'cm' : /in/.test(h + w) ? 'in' : '';
  const num = (s) => String(s).replace(/[^\d.,]/g, '');
  return {
    artist: nameOf(n.creator || n.author || n.artist || n.brand),
    title: decode(n.name || ''),
    year: String(n.dateCreated || '').slice(0, 9),
    medium: nameOf(n.artMedium || n.material || n.artform),
    dimensions: h && w ? `${num(h)} x ${num(w)}${d ? ' x ' + num(d) : ''}${unit ? ' ' + unit : ''}` : '',
    price: offer.price != null ? String(offer.price) : '',
    currency: offer.priceCurrency || '',
    availability: /soldout|outofstock/i.test(offer.availability || '') ? 'Sold' : /instock|available/i.test(offer.availability || '') ? 'Available' : '',
    stock: String(n.sku || n.identifier || '').slice(0, 60),
    url: n.url ? new URL(n.url, pageUrl).href : pageUrl,
    images: img.map((u) => new URL(u, pageUrl).href),
  };
}

function fromConventions(html, pageUrl) {
  const ogImage = meta(html, 'og:image');
  if (!ogImage || !ART_PATH.test(new URL(pageUrl).pathname)) return null;
  const body = text(html);
  const heading = decode((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  const title = meta(html, 'og:title') || heading || decode(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || '');
  const dims = body.match(DIMS_RE)?.[1] || '';
  if (!dims && !MEDIUM_RE.test(body)) return null; // probably not an artwork page
  // "Artist, Title, 2021" or "Artist - Title" or "Title by Artist"
  let artist = ''; let t = title.replace(/\s*[|–—-]\s*[^|–—-]*$/, (m) => (m.length < 40 ? '' : m)).trim();
  let m;
  if ((m = t.match(/^(.+?),\s*(.+?)(?:,\s*(\d{4}(?:\s*[-–]\s*\d{2,4})?))?$/))) { artist = m[1]; t = m[2]; }
  else if ((m = t.match(/^(.+?)\s+[–—-]\s+(.+)$/))) { artist = m[1]; t = m[2]; }
  else if ((m = t.match(/^(.+?)\s+by\s+(.+)$/i))) { t = m[1]; artist = m[2]; }
  if (heading && heading !== title && !artist) artist = heading;
  const price = body.match(PRICE_RE);
  return {
    artist: artist.trim(), title: t.replace(/,\s*\d{4}$/, '').trim(), year: (title.match(YEAR_RE) || body.slice(0, 600).match(YEAR_RE) || [''])[0],
    medium: (body.match(MEDIUM_RE)?.[1] || '').replace(/\s+\d.*$/, '').trim(), dimensions: dims,
    price: price ? price[2] : '', currency: price ? { $: 'USD', '€': 'EUR', '£': 'GBP' }[price[1]] : '',
    availability: /\bsold\b/i.test(body.slice(0, 2000)) && !/\bavailable\b/i.test(body.slice(0, 2000)) ? 'Sold' : '',
    stock: '', url: pageUrl, images: [new URL(ogImage, pageUrl).href],
  };
}

async function robotsRules(origin, opts) {
  try {
    const { buf } = await safeFetch(`${origin}/robots.txt`, { ...opts, maxBytes: 200e3, accept: 'text/plain' });
    const rules = []; let applies = false;
    for (const line of buf.toString('utf8').split(/\r?\n/)) {
      const [k, ...v] = line.split(':'); const val = v.join(':').trim();
      if (/^user-agent$/i.test(k.trim())) applies = val === '*' || /opengallery/i.test(val);
      else if (applies && /^disallow$/i.test(k.trim()) && val) rules.push(val);
    }
    return rules;
  } catch { return []; }
}

/** Crawl one site. onProgress({pages, found}) is called as pages are read. */
export async function crawlSite(startUrl, { maxPages = 300, allowPrivate = false, onProgress = () => {} } = {}) {
  const start = new URL(startUrl);
  if (!['http:', 'https:'].includes(start.protocol)) throw new Error('Enter a website address starting with https://');
  const opts = { allowPrivate, timeoutMs: 15000 };
  const disallow = await robotsRules(start.origin, opts);
  const allowed = (u) => u.origin === start.origin && !disallow.some((d) => u.pathname.startsWith(d)) && !/\.(jpe?g|png|gif|webp|pdf|zip|mp4|mov|css|js|svg|ico|xml)$/i.test(u.pathname);
  const queue = [start.href]; const seen = new Set(queue); const works = new Map(); let pages = 0; const errors = [];
  while (queue.length && pages < maxPages) {
    const batch = queue.splice(0, 4);
    await Promise.all(batch.map(async (href) => {
      try {
        const { buf, type, url } = await safeFetch(href, { ...opts, maxBytes: 5e6, accept: 'text/html' });
        if (!/html/i.test(type)) return;
        pages++;
        const html = buf.toString('utf8');
        const found = jsonLd(html).map((n) => fromStructured(n, url)).filter((w) => w.title);
        if (!found.length) { const c = fromConventions(html, url); if (c && c.title) found.push(c); }
        for (const w of found) if (!works.has(w.url + '|' + w.title)) works.set(w.url + '|' + w.title, w);
        for (const m of html.matchAll(/<a\s[^>]*href=["']([^"'#]+)["']/gi)) {
          try { const u = new URL(decode(m[1]), url); u.hash = ''; if (allowed(u) && !seen.has(u.href)) { seen.add(u.href); queue.push(u.href); } } catch {}
        }
      } catch (e) { errors.push({ url: href, error: e.message }); }
    }));
    onProgress({ pages, found: works.size });
  }
  return { pages, works: [...works.values()], errors: errors.slice(0, 20), truncated: queue.length > 0 };
}

export function worksToCSV(works) {
  return toCSV([['Inventory number', 'Artist', 'Title', 'Year', 'Medium', 'Dimensions', 'Price', 'Currency', 'Availability', 'Website URL', 'Image URL'],
    ...works.map((w) => [w.stock, w.artist, w.title, w.year, w.medium, w.dimensions, w.price, w.currency, w.availability, w.url, w.images.join(' ')])]);
}
