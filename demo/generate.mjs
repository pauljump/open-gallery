#!/usr/bin/env node
// Demo fixture generator: a fictional small gallery's messy inventory export, synthetic artwork
// images, an XLSX copy, a "one week later" re-export with known differences, and a scenario file
// describing those differences so tests can check import, diff, and privacy behaviour.
//
//   node demo/generate.mjs <outDir> [--works N] [--seed N] [--no-images]
//
// Everything is deterministic for a given seed. All artists and works are invented.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePNG } from '../lib/png.mjs';
import { writeXlsx } from '../lib/xlsx-write.mjs';

// ---------------------------------------------------------------- PRNG

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const int = (rng, lo, hi) => { lo = Math.ceil(lo); hi = Math.floor(hi); return lo + Math.floor(rng() * (hi - lo + 1)); };
const chance = (rng, p) => rng() < p;
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// ---------------------------------------------------------------- Fictional artists

const ARTISTS = [
  { name: 'Marisol Okonkwo-Vane', slug: 'marisol-okonkwo-vane', style: 'field', grain: true,
    palette: ['#d9482b', '#f2b134', '#8c2f1b', '#f6e7c1', '#3b2a22'], media: ['Oil on canvas', 'Oil on linen', 'oil on canvas'] },
  { name: 'Teodor Lindqvist-Abara', slug: 'teodor-lindqvist-abara', style: 'stripes', grain: false,
    palette: ['#1b3a5c', '#5e8fb8', '#cfe0ee', '#e8e3d6', '#13202c'], media: ['Acrylic on canvas', 'Acrylic on panel'] },
  { name: 'Hana Petrosyan', slug: 'hana-petrosyan', style: 'circles', grain: false,
    palette: ['#f7c8d0', '#c9dff2', '#fdf1c7', '#d5eacb', '#f3ede6'], media: ['Gouache on paper', 'Watercolour and gouache on paper'] },
  { name: 'Ruben Castellane', slug: 'ruben-castellane', style: 'gradient', grain: true,
    palette: ['#6b4e2e', '#a67c52', '#d9c3a3', '#3f2f1f', '#8a9a7b'], media: ['Oil and wax on panel', 'Encaustic on panel'] },
  { name: 'Ingrid Vossberg', slug: 'ingrid-vossberg', style: 'blocks', grain: false,
    palette: ['#1d1d1b', '#f4f3ef', '#9d9b94', '#c8c5bb', '#d94b2b'], media: ['Acrylic and graphite on canvas', 'Screenprint on paper'] },
  { name: 'Dario Mbeki-Ferrante', slug: 'dario-mbeki-ferrante', style: 'diagonal', grain: false,
    palette: ['#101010', '#f5f500', '#f2f2f2', '#2b2bd6', '#e01f3d'], media: ['Enamel on aluminium', 'Vinyl paint on canvas'] },
  { name: 'Yuki Halvorsen', slug: 'yuki-halvorsen', style: 'rings', grain: true,
    palette: ['#22262b', '#5a6670', '#aab4bd', '#e9ecee', '#8c1c3a'], media: ['Sumi ink on washi', 'Ink and acrylic on paper'] },
  { name: 'Priya Oyelaran', slug: 'priya-oyelaran', style: 'horizon', grain: true,
    palette: ['#b7a98f', '#7d8b7a', '#d8d0c0', '#4e5a52', '#e4b073'], media: ['Oil on linen', 'Oil on canvas'] },
  { name: 'Casimir Dulac-Whitt', slug: 'casimir-dulac-whitt', style: 'dusk', grain: true,
    palette: ['#2a1f44', '#6b3d7a', '#d2667a', '#f2a65a', '#f9e3b0'], media: ['Pigment print on cotton rag', 'Archival pigment print'] },
  { name: 'Lena Achterberg', slug: 'lena-achterberg', style: 'scatter', grain: false,
    palette: ['#ffffff', '#ff5c8a', '#20c4b0', '#ffc700', '#3a3dff'], media: ['Acrylic on canvas', 'Flashe on panel'] },
  { name: 'Ousmane Brightwater', slug: 'ousmane-brightwater', style: 'bands', grain: false,
    palette: ['#0f4c5c', '#e36414', '#9a031e', '#fb8b24', '#5f0f40'], media: ['Oil on canvas', 'Dyed cotton on stretcher'] },
  { name: 'Fenna Kowalczyk', slug: 'fenna-kowalczyk', style: 'blobs', grain: true,
    palette: ['#e8eef2', '#9fc5e8', '#f4a9c8', '#c7e9c0', '#ffe2a8'], media: ['Oil on canvas', 'Soft pastel on paper'] },
];

const ADJ = ['Blue', 'Quiet', 'Late', 'Northern', 'Second', 'Broken', 'Salt', 'Winter', 'Low', 'Paper', 'Night', 'Open', 'Copper',
  'Slow', 'Long', 'Burnt', 'Empty', 'Hollow', 'Small', 'Red', 'Grey', 'Double', 'First', 'Harbor', 'Field', 'Glass', 'Early', 'Still'];
const NOUN = ['Harbor', 'Window', 'Hour', 'Tide', 'Signal', 'Room', 'Garden', 'Interval', 'Weather', 'Passage', 'Orchard', 'Letter',
  'Threshold', 'Station', 'Morning', 'Shore', 'Light', 'Map', 'Field', 'Archive', 'Echo', 'Meridian', 'Harvest', 'Crossing'];
const LOCATIONS = ['On view', 'Back room rack B', 'Back room rack A', 'Storage – Queens', 'Storage – Queens, bay 3', 'Office', 'Flat file 2',
  'Viewing room', 'Rack C (lower)', 'On loan – Hudson'];
const STATUSES = ['Available', 'Available', 'Available', 'Available', 'Sold', 'Sold', 'On Hold', 'NFS', 'Consigned out'];
const FRAME_NOTES = ['', '', 'Natural oak float frame', 'Unframed', 'White painted tray frame', 'Museum glass, black maple', 'Artist frame, do not replace', ''];
const PROVENANCE = ['Artist\'s studio', 'Artist\'s studio', 'Private collection, Hudson NY', 'Estate of the artist\'s family', '', '', 'Acquired directly from the artist, 2021', 'Previously with a Berlin gallery'];
const SIGNED = ['Yes', 'Signed verso', 'Signed and dated lower right', 'No', '', 'Yes', 'Signed on stretcher'];
const CONSIGNOR_NAMES = ['Harriet Blume', 'the Dellacroix Family Trust', 'M. Oyinlola', 'J. & P. Rask', 'Sunfield Partners LLC', 'Gideon Marsh'];
const NOTE_TEXTS = [
  'Client in Greenwich asked for first refusal',
  'Do not discount below 15%, artist is sensitive about this one',
  'Small scuff lower left corner, touched up by studio',
  'Artist prefers this not be shown next to earlier work',
  'Reserved verbally for the Tanakas, follow up Monday',
  'Collector owes balance from last fair',
  'Came back from the art fair with crate damage, frame replaced',
  'Promised to museum curator "for consideration", no paperwork yet',
];

// ---------------------------------------------------------------- Rows

function hex(c) { return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]; }
function slugify(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
const fmtPriceComma = (n) => n.toLocaleString('en-US');

function makeTitle(rng, i) {
  const base = `${pick(rng, ADJ)} ${pick(rng, NOUN)}`;
  const r = rng();
  if (r < 0.1) return `Untitled (${base.toLowerCase()})`;
  if (r < 0.2) return `${base} No. ${int(rng, 1, 40)}`;
  if (r < 0.25) return `${base}, ${pick(rng, ['Study', 'Second Version', 'After Rain'])}`;
  if (r < 0.28) return `"${base}"`;
  if (r < 0.32) return `${base} ${pick(rng, ['II', 'III', 'IV'])}`;
  if (i > 400) return `${base} ${i}`; // keep titles unique-ish on large fixtures
  return base;
}

function makeWork(rng, i, stock, artist) {
  const isPaper = /paper|washi|print|rag/i.test(artist.media[0]);
  const h = pick(rng, isPaper ? [11, 14, 18, 22, 24, 30] : [20, 24, 30, 36, 40, 48, 60, 72]);
  const w = Math.max(8, Math.round(h * pick(rng, [0.75, 0.8, 1, 1, 1.25, 1.33, 1.5, 0.66]) * 2) / 2);
  const price = isPaper ? int(rng, 8, 60) * 100 : int(rng, 18, 420) * 100;
  const status = pick(rng, STATUSES);
  const cost = int(rng, 1000, 29999);
  const insurance = int(rng, 1000, 59999);
  const consigned = chance(rng, 0.4);
  return {
    stock, artist, title: makeTitle(rng, i), year: int(rng, 2017, 2026),
    medium: pick(rng, artist.media), h, w, depth: isPaper ? '' : pick(rng, [0.75, 1.5, 1.5, 2]),
    framed: chance(rng, 0.5) ? `${h + 2} x ${w + 2}` : '', cm: false,
    edition: isPaper && chance(rng, 0.5) ? `${int(rng, 1, 12)}/${pick(rng, [12, 20, 25])}` : '',
    price, status, location: pick(rng, LOCATIONS), cost,
    consignor: consigned ? `PRIVATE-CONSIGNOR-${stock.slice(-4)} ${pick(rng, CONSIGNOR_NAMES)}` : '',
    note: `${pick(rng, NOTE_TEXTS)}, PRIVATE-NOTE-${stock.slice(-4)}`,
    signed: pick(rng, SIGNED), provenance: pick(rng, PROVENANCE),
    artsy: '', artnet: '', frameNotes: pick(rng, FRAME_NOTES), insurance,
  };
}

const HEADERS = ['Stock No.', 'Artist', 'Title', 'Year', 'Medium', 'Height (in)', 'Width (in)', 'Depth (in)', 'Dimensions',
  'Framed H x W (in)', 'Edition', 'Price (USD)', 'Status', 'Location', 'Cost', 'Consignor', 'Notes', 'Signed', 'Provenance',
  'Artsy URL', 'Artnet URL', 'Frame notes', 'Insurance value'];
const PRIVATE_HEADERS = new Set(['Cost', 'Consignor', 'Notes', 'Insurance value']);

function priceCell(rng, w) {
  if (w.price === 'POA') return 'POA';
  if (w.price === '') return '';
  return chance(rng, 0.5) ? fmtPriceComma(w.price) : String(w.price);
}

function toRecord(rng, w) {
  const cmH = Math.round(w.h * 2.54), cmW = Math.round(w.w * 2.54);
  return {
    'Stock No.': w.stock,
    'Artist': w.artistCell ?? w.artist.name,
    'Title': w.titleCell ?? w.title,
    'Year': w.yearCell ?? String(w.year),
    'Medium': w.medium,
    'Height (in)': w.cm ? '' : String(w.h),
    'Width (in)': w.cm ? '' : String(w.w),
    'Depth (in)': w.cm ? '' : String(w.depth),
    'Dimensions': w.cm ? `${cmH} x ${cmW} cm` : '',
    'Framed H x W (in)': w.framed,
    'Edition': w.edition,
    'Price (USD)': priceCell(rng, w),
    'Status': w.statusCell ?? w.status,
    'Location': w.location,
    'Cost': String(w.cost),
    'Consignor': w.consignor,
    'Notes': w.note,
    'Signed': w.signed,
    'Provenance': w.provenance,
    'Artsy URL': w.artsy,
    'Artnet URL': w.artnet,
    'Frame notes': w.frameNotes,
    'Insurance value': String(w.insurance),
  };
}

// ---------------------------------------------------------------- CSV (RFC 4180)

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function toCSV(headers, records) {
  const lines = [headers.map(csvCell).join(',')];
  for (const r of records) lines.push(headers.map((h) => csvCell(r[h])).join(','));
  return lines.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------- Painting

function paint(artist, w, h, seed) {
  const rng = mulberry32(seed);
  const pal = artist.palette.map(hex);
  const img = new Uint8Array(w * h * 3);
  const set = (i, c) => { img[i] = c[0]; img[i + 1] = c[1]; img[i + 2] = c[2]; };
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const fillRect = (x0, y0, x1, y1, c) => {
    for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) set((y * w + x) * 3, c);
  };
  const circle = (cx, cy, r, c) => {
    for (let y = Math.max(0, cy - r); y < Math.min(h, cy + r + 1); y++) {
      const dy = y - cy, half = Math.sqrt(Math.max(0, r * r - dy * dy));
      for (let x = Math.max(0, Math.ceil(cx - half)); x < Math.min(w, cx + half); x++) set((y * w + x) * 3, c);
    }
  };
  const gradient = (a, b, angle) => {
    const ca = Math.cos(angle), sa = Math.sin(angle);
    const span = Math.abs(ca) * w + Math.abs(sa) * h;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let t = (x * ca + y * sa) / span; if (ca < 0) t += Math.abs(ca) * w / span; if (sa < 0) t += Math.abs(sa) * h / span;
      set((y * w + x) * 3, lerp(a, b, Math.min(1, Math.max(0, t))));
    }
  };
  const shuffled = () => pal.slice().sort(() => rng() - 0.5);
  const p = shuffled();

  switch (artist.style) {
    case 'field': {
      gradient(p[0], p[1], (rng() - 0.5) * 0.3 + Math.PI / 2);
      const m = int(rng, 40, 120);
      fillRect(m, m, w - m, h - int(rng, 40, 200), p[2]);
      if (chance(rng, 0.6)) fillRect(m, h - int(rng, 60, 200), w - m, h - m, p[3]);
      break;
    }
    case 'stripes': { // horizontal
      let y = 0;
      while (y < h) { const sh = int(rng, 8, 90); fillRect(0, y, w, y + sh, pick(rng, pal)); y += sh; }
      break;
    }
    case 'bands': { // vertical
      let x = 0;
      while (x < w) { const sw = int(rng, 20, 140); fillRect(x, 0, x + sw, h, pick(rng, pal)); x += sw; }
      break;
    }
    case 'diagonal': {
      const period = int(rng, 40, 110), colors = [p[0], p[1], p[2]];
      const slope = pick(rng, [1, -1, 0.5, 2]);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const k = Math.floor(((x + y * slope) % (period * 3) + period * 3) / period) % 3;
        set((y * w + x) * 3, colors[k]);
      }
      break;
    }
    case 'circles': {
      fillRect(0, 0, w, h, p[0]);
      for (let i = 0; i < int(rng, 4, 9); i++) circle(int(rng, 0, w), int(rng, 0, h), int(rng, 60, Math.min(w, h) / 2), pick(rng, pal));
      break;
    }
    case 'scatter': {
      fillRect(0, 0, w, h, p[0]);
      for (let i = 0; i < int(rng, 40, 120); i++) circle(int(rng, 0, w), int(rng, 0, h), int(rng, 6, 40), pick(rng, pal.slice(1)));
      break;
    }
    case 'rings': {
      fillRect(0, 0, w, h, p[0]);
      const cx = int(rng, w * 0.3, w * 0.7), cy = int(rng, h * 0.3, h * 0.7), step = int(rng, 18, 50);
      const rmax = Math.hypot(w, h);
      for (let r = rmax, k = 0; r > 0; r -= step, k++) circle(cx, cy, Math.round(r), pal[1 + (k % (pal.length - 1))]);
      break;
    }
    case 'blocks': {
      fillRect(0, 0, w, h, p[0]);
      const cols = int(rng, 3, 7), rows = int(rng, 3, 8), gap = int(rng, 4, 16);
      const cw = (w - gap) / cols, ch = (h - gap) / rows;
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        if (chance(rng, 0.25)) continue;
        fillRect(Math.round(gap + c * cw), Math.round(gap + r * ch), Math.round((c + 1) * cw), Math.round((r + 1) * ch), pick(rng, pal));
      }
      break;
    }
    case 'horizon': {
      const hy = int(rng, h * 0.35, h * 0.7);
      gradient(p[0], p[1], Math.PI / 2);
      fillRect(0, hy, w, h, p[2]);
      fillRect(0, hy - 3, w, hy + 3, p[3]);
      break;
    }
    case 'dusk': {
      const mid = int(rng, h * 0.3, h * 0.7);
      for (let y = 0; y < h; y++) {
        const c = y < mid ? lerp(p[0], p[1], y / mid) : lerp(p[1], p[2], (y - mid) / (h - mid));
        for (let x = 0; x < w; x++) set((y * w + x) * 3, c);
      }
      fillRect(0, h - int(rng, 30, 120), w, h, p[3]);
      break;
    }
    case 'blobs': {
      fillRect(0, 0, w, h, p[0]);
      const blobs = Array.from({ length: int(rng, 3, 6) }, () => ({ x: rng() * w, y: rng() * h, r: int(rng, 120, 400), c: pick(rng, pal.slice(1)) }));
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let c = p[0];
        for (const b of blobs) { const d = ((x - b.x) ** 2 + (y - b.y) ** 2) / (b.r * b.r); if (d < 1) c = lerp(c, b.c, (1 - d) ** 2); }
        set((y * w + x) * 3, c);
      }
      break;
    }
    default: { // 'gradient'
      gradient(p[0], p[1], rng() * Math.PI * 2);
      if (chance(rng, 0.5)) circle(int(rng, 0, w), int(rng, 0, h), int(rng, 80, 300), p[2]);
    }
  }

  if (artist.grain) { // tiled low-amplitude grain: stays compressible, reads as canvas texture
    const T = 64, amp = 6, tile = new Int8Array(T * T);
    for (let i = 0; i < tile.length; i++) tile[i] = Math.round((rng() - 0.5) * 2 * amp);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const n = tile[(y % T) * T + (x % T)], i = (y * w + x) * 3;
      img[i] = Math.min(255, Math.max(0, img[i] + n)); img[i + 1] = Math.min(255, Math.max(0, img[i + 1] + n)); img[i + 2] = Math.min(255, Math.max(0, img[i + 2] + n));
    }
  }
  return img;
}

function imageDims(h, w, longest = 900) {
  const ratio = h / w;
  return ratio >= 1 ? { width: Math.max(200, Math.round(longest / ratio)), height: longest } : { width: longest, height: Math.max(200, Math.round(longest * ratio)) };
}

function paintWork(work, suffix = '') {
  const { width, height } = imageDims(work.h, work.w);
  return encodePNG(width, height, paint(work.artist, width, height, hashStr(work.stock + suffix)));
}

// ---------------------------------------------------------------- Generator

export function generateDemo(outDir, { works = 60, seed = 7, images = true } = {}) {
  const rng = mulberry32(seed);
  outDir = resolve(outDir);
  mkdirSync(outDir, { recursive: true });

  // Stock numbers with gaps, like a real ledger.
  const stocks = [];
  for (let n = 1001, i = 0; i < works + 8; i++) { stocks.push(`GL-${n}`); n += int(rng, 1, 3); }
  const list = [];
  for (let i = 0; i < works; i++) list.push(makeWork(rng, i, stocks[i], ARTISTS[(i + int(rng, 0, 2)) % ARTISTS.length]));

  // Deliberate messiness, applied to distinct rows.
  const candidates = list.slice(); // rows not yet used for a special case
  const take = () => candidates.splice(int(rng, 0, candidates.length - 1), 1)[0];
  const missingTitle = take(); missingTitle.titleCell = '';
  const poa = take(); poa.price = 'POA';
  const cmWorks = [take(), take(), take(), take()]; cmWorks.forEach((x) => { x.cm = true; x.framed = ''; });
  const blankPrice = [take(), take(), take()]; blankPrice.forEach((x) => { x.price = ''; });
  take().statusCell = ' Available'; take().statusCell = 'available '; take().statusCell = 'SOLD';
  const ws = take(); ws.artistCell = `${ws.artist.name}  `; // double trailing space
  take().yearCell = 'c. 2020'; take().yearCell = '2021-22';
  take().note += '\nSecond line of note, keep it quiet'; // multi-line field
  for (const x of list.filter((x) => x.statusCell === 'SOLD')) x.status = 'Sold';
  for (const x of list.filter((x) => x.statusCell && x.statusCell.trim().toLowerCase() === 'available')) x.status = 'Available';

  // Public listing URLs for a subset.
  const artsyWorks = list.filter(() => chance(rng, 20 / works));
  for (const x of artsyWorks) x.artsy = `https://www.artsy.net/artwork/${x.artist.slug}-${slugify(x.title || 'untitled')}-${x.stock.slice(-4)}`;
  for (const x of list.filter(() => chance(rng, 8 / works))) x.artnet = `https://www.artnet.com/artists/${x.artist.slug}/${slugify(x.title || 'untitled')}-${int(rng, 100, 999)}`;

  // Second views for ~15 works and the second export's new works.
  const secondViews = images ? list.filter(() => chance(rng, 15 / works)).map((x) => x.stock) : [];
  const addedWorks = [0, 1, 2].map((k) => makeWork(rng, works + k, stocks[works + 1 + k], ARTISTS[k * 4 % ARTISTS.length]));
  for (const x of addedWorks) x.status = 'Available';

  // Private sentinels must never appear in public columns; nudge any colliding number.
  const publicText = () => list.concat(addedWorks).map((x) => HEADERS.filter((hd) => !PRIVATE_HEADERS.has(hd)).map((hd) => toRecord(mulberry32(1), x)[hd]).join('\n')).join('\n');
  const prices = new Set(list.concat(addedWorks).map((x) => String(x.price)));
  const pub = publicText();
  const used = new Set();
  for (const x of list.concat(addedWorks)) {
    for (const key of ['cost', 'insurance']) {
      let v = x[key];
      while (used.has(v) || prices.has(String(v)) || pub.includes(String(v)) || v % 10 === 0) v += 7;
      used.add(v); x[key] = v;
    }
  }

  const records = list.map((x) => toRecord(rng, x));
  writeFileSync(join(outDir, 'inventory.csv'), toCSV(HEADERS, records));

  const sentinels = { costs: [], consignors: [], notes: [], insurance: [], all: [] };
  for (const x of list.concat(addedWorks)) {
    sentinels.costs.push(String(x.cost)); sentinels.insurance.push(String(x.insurance)); sentinels.notes.push(x.note);
    if (x.consignor) sentinels.consignors.push(x.consignor);
  }
  sentinels.all = [...sentinels.costs, ...sentinels.insurance, ...sentinels.notes, ...sentinels.consignors];
  writeFileSync(join(outDir, 'private-sentinels.json'), JSON.stringify(sentinels, null, 2));

  const scenario = {
    seed, works, artists: ARTISTS.map((a) => a.name), headers: HEADERS,
    missingTitleStock: missingTitle.stock, poaStock: poa.stock, blankPriceStocks: blankPrice.map((x) => x.stock),
    cmStocks: cmWorks.map((x) => x.stock), privateColumns: [...PRIVATE_HEADERS],
    secondViews, unmatchedImages: images ? ['scan_0042.png', 'IMG_1188.png'] : [],
    priceChanged: [], newlySold: [], staleResurrection: null, nearDuplicate: null, added: [], removed: null,
    droppedColumn: null, addedColumn: null,
  };

  if (!images) { // performance fixture: inventory.csv only
    writeFileSync(join(outDir, 'scenario.json'), JSON.stringify(scenario, null, 2));
    return { outDir, works: list.length, files: ['inventory.csv', 'private-sentinels.json', 'scenario.json'], scenario };
  }

  writeFileSync(join(outDir, 'inventory.xlsx'), writeXlsx([HEADERS, ...records.map((r) => HEADERS.map((hd) => (/^\d+(\.\d+)?$/.test(r[hd]) ? Number(r[hd]) : r[hd])))]));

  // ---- Reimport: a week later. Choose special rows from the ones not already used above.
  const plain = (x) => typeof x.price === 'number' && x.titleCell === undefined && !x.statusCell && !x.cm && x.status === 'Available';
  const pool = candidates.filter(plain);
  const takeP = () => pool.splice(int(rng, 0, pool.length - 1), 1)[0];
  const priceChanged = [takeP(), takeP(), takeP()];
  const newlySold = [takeP(), takeP()];
  const removed = takeP();
  const dupSource = takeP();
  const soldPool = candidates.filter((x) => x.status === 'Sold' && !x.statusCell);
  const stale = soldPool.length ? soldPool[int(rng, 0, soldPool.length - 1)] : takeP();

  const re = new Map(records.map((r) => [r['Stock No.'], { ...r }]));
  const priceDetail = [];
  for (const x of priceChanged) {
    const to = Math.round(x.price * pick(rng, [1.1, 1.15, 0.9, 1.25]) / 100) * 100;
    priceDetail.push({ stock: x.stock, from: x.price, to });
    re.get(x.stock)['Price (USD)'] = chance(rng, 0.5) ? fmtPriceComma(to) : String(to);
  }
  for (const x of newlySold) re.get(x.stock)['Status'] = 'Sold';
  re.get(stale.stock)['Status'] = 'Available';
  re.delete(removed.stock);
  const dupStock = stocks[works];
  const dupRec = { ...re.get(dupSource.stock), 'Stock No.': dupStock };
  dupRec['Title'] = dupSource.title.toLowerCase().replace(/ /, '  ') + ' ';
  dupRec['Notes'] = `Possible duplicate entry, check with registrar, PRIVATE-NOTE-${dupStock.slice(-4)}`;
  sentinels.notes.push(dupRec['Notes']); sentinels.all.push(dupRec['Notes']);
  re.set(dupStock, dupRec);
  for (const x of addedWorks) re.set(x.stock, toRecord(rng, x));

  const REHEADERS = HEADERS.filter((hd) => hd !== 'Frame notes').concat('Shipping crate');
  const reRecords = [...re.values()].map((r) => ({ ...r, 'Shipping crate': chance(rng, 0.3) ? `Crate ${int(rng, 1, 40)}` : '' }));
  writeFileSync(join(outDir, 'reimport.csv'), toCSV(REHEADERS, reRecords));
  writeFileSync(join(outDir, 'private-sentinels.json'), JSON.stringify(sentinels, null, 2));

  Object.assign(scenario, {
    priceChanged: priceChanged.map((x) => x.stock), priceChangedDetail: priceDetail,
    newlySold: newlySold.map((x) => x.stock),
    staleResurrection: stale.stock,
    nearDuplicate: { newStock: dupStock, matchesStock: dupSource.stock },
    added: addedWorks.map((x) => x.stock), removed: removed.stock,
    droppedColumn: 'Frame notes', addedColumn: 'Shipping crate', reimportHeaders: REHEADERS,
  });
  writeFileSync(join(outDir, 'scenario.json'), JSON.stringify(scenario, null, 2));

  // ---- Images
  const imgDir = join(outDir, 'images');
  mkdirSync(imgDir, { recursive: true });
  for (const x of list.concat(addedWorks)) writeFileSync(join(imgDir, `${x.stock}.png`), paintWork(x));
  for (const stock of secondViews) writeFileSync(join(imgDir, `${stock}_2.png`), paintWork(list.find((x) => x.stock === stock), '_2'));
  const orphanA = { ...list[3], stock: 'scan_0042' }, orphanB = { ...list[9], stock: 'IMG_1188' };
  writeFileSync(join(imgDir, 'scan_0042.png'), paintWork(orphanA));
  writeFileSync(join(imgDir, 'IMG_1188.png'), paintWork(orphanB));
  writeFileSync(join(imgDir, 'LICENSE.txt'),
    'These images were generated by the Open Gallery demo generator (demo/generate.mjs).\n' +
    'They are fully synthetic abstract renderings of fictional artworks by fictional artists.\n' +
    'Released under CC0 1.0 Universal (public domain dedication). No rights reserved.\n');

  return {
    outDir, works: list.length, scenario,
    files: ['inventory.csv', 'inventory.xlsx', 'reimport.csv', 'scenario.json', 'private-sentinels.json', 'images/'],
  };
}

// ---------------------------------------------------------------- CLI

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const outDir = args.find((a) => !a.startsWith('--'));
  if (!outDir) { console.error('usage: node demo/generate.mjs <outDir> [--works N] [--seed N] [--no-images]'); process.exit(2); }
  const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : dflt; };
  const t0 = performance.now();
  const r = generateDemo(outDir, { works: opt('--works', 60), seed: opt('--seed', 7), images: !args.includes('--no-images') });
  console.log(`wrote ${r.works} works to ${r.outDir} (${r.files.join(', ')}) in ${Math.round(performance.now() - t0)} ms`);
  if (!existsSync(join(r.outDir, 'inventory.csv'))) process.exit(1);
}
