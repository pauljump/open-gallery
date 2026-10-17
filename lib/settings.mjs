// Gallery settings and presentation tokens. Everything a gallery customises lives here (and in
// data/custom/), never in the application code, so upgrading the app keeps every choice.
import { now, audit } from './db.mjs';

export const FONT_STACKS = {
  'classic-serif': { label: 'Classic serif', css: "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif" },
  'modern-serif': { label: 'Modern serif', css: "Charter, 'Bitstream Charter', 'Sitka Text', Cambria, serif" },
  'neo-grotesque': { label: 'Neo-grotesque', css: "'Helvetica Neue', Helvetica, Arial, sans-serif" },
  'humanist': { label: 'Humanist sans', css: "Seravek, 'Gill Sans Nova', Ubuntu, Calibri, 'DejaVu Sans', source-sans-pro, sans-serif" },
  'system': { label: 'System sans', css: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" },
  'mono': { label: 'Monospace', css: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace" },
};

export const DEFAULTS = {
  gallery: {
    name: 'My Gallery',
    tagline: '',
    email: '',
    phone: '',
    address: '',
    website: '',
    instagram: '',
  },
  catalog: {
    currency: 'USD',
    units: 'in',              // default unit when a sheet omits one
    showPrices: 'per-work',   // 'per-work' | 'never'
    showStockNumbers: false,
    inquiryMode: 'email',     // 'email' | 'links-only'
    publicBaseUrl: '',        // where the static site will live, used for feed URLs
    rightsStatement: 'Images are reproduced with permission for viewing. Artwork copyright remains with the artists. No reuse without written permission.',
  },
  theme: {
    headingFont: 'classic-serif',
    bodyFont: 'neo-grotesque',
    colorBackground: '#faf9f6',
    colorText: '#1c1b19',
    colorMuted: '#6b6760',
    colorAccent: '#7a3e2b',
    colorLine: '#e4e0d8',
    layout: 'grid',           // 'grid' | 'list' | 'salon'
    density: 'airy',          // 'airy' | 'compact'
    imageFit: 'contain',      // 'contain' | 'cover'
    corner: 0,                // px radius on images
    logoMediaId: '',
    footer: '',
  },
  privacy: {
    publicByDefault: false,   // new imports stay private until a person publishes them
    listInOpenCatalog: false, // hosted: include published works in the shared open catalog
    allowAITraining: false,   // published public fields only; never private data or collector identities
  },
  operations: {
    payoutDays: 30,           // consignor is due this many days after the buyer pays in full
    holdHours: 48,            // default length of a hold
    defaultSplit: 50,         // consignor's share (%) when an artist has no default of their own
  },
};

const HEX = /^#[0-9a-f]{6}$/i;
const VALIDATORS = {
  'theme.headingFont': (v) => v in FONT_STACKS,
  'theme.bodyFont': (v) => v in FONT_STACKS,
  'theme.colorBackground': (v) => HEX.test(v),
  'theme.colorText': (v) => HEX.test(v),
  'theme.colorMuted': (v) => HEX.test(v),
  'theme.colorAccent': (v) => HEX.test(v),
  'theme.colorLine': (v) => HEX.test(v),
  'theme.layout': (v) => ['grid', 'list', 'salon'].includes(v),
  'theme.density': (v) => ['airy', 'compact'].includes(v),
  'theme.imageFit': (v) => ['contain', 'cover'].includes(v),
  'theme.corner': (v) => Number.isInteger(v) && v >= 0 && v <= 24,
  'catalog.currency': (v) => /^[A-Z]{3}$/.test(v),
  'catalog.units': (v) => ['in', 'cm'].includes(v),
  'catalog.showPrices': (v) => ['per-work', 'never'].includes(v),
  'catalog.showStockNumbers': (v) => typeof v === 'boolean',
  'catalog.inquiryMode': (v) => ['email', 'links-only'].includes(v),
  'catalog.publicBaseUrl': (v) => v === '' || /^https:\/\/[^\s?#]+$/.test(v),
  'gallery.email': (v) => v === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
  'gallery.website': (v) => v === '' || /^https?:\/\/\S+$/.test(v),
  'privacy.publicByDefault': (v) => typeof v === 'boolean',
  'privacy.listInOpenCatalog': (v) => typeof v === 'boolean',
  'privacy.allowAITraining': (v) => typeof v === 'boolean',
  'operations.payoutDays': (v) => Number.isInteger(v) && v >= 0 && v <= 365,
  'operations.holdHours': (v) => Number.isInteger(v) && v >= 0 && v <= 24 * 60,
  'operations.defaultSplit': (v) => typeof v === 'number' && v >= 0 && v <= 100,
};

export function getSettings(db) {
  const out = structuredClone(DEFAULTS);
  for (const { key, value } of db.prepare('SELECT key, value FROM settings').all()) {
    const [group, name] = key.split('.');
    if (out[group] && name in out[group]) {
      try { out[group][name] = JSON.parse(value); } catch { /* keep default */ }
    }
  }
  return out;
}

/** patch: { 'theme.colorAccent': '#123456', ... } or nested object. Returns { settings, errors }. */
export function updateSettings(db, patch) {
  const flat = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k2, v2] of Object.entries(v)) flat[`${k}.${k2}`] = v2;
    else flat[k] = v;
  }
  const errors = {};
  const accepted = {};
  for (const [k, v] of Object.entries(flat)) {
    const [group, name] = k.split('.');
    if (!(group in DEFAULTS) || !(name in DEFAULTS[group])) { errors[k] = 'Unknown setting'; continue; }
    const val = typeof DEFAULTS[group][name] === 'string' ? String(v ?? '').slice(0, 2000) : v;
    if (VALIDATORS[k] && !VALIDATORS[k](val)) { errors[k] = 'Invalid value'; continue; }
    accepted[k] = val;
  }
  if (!Object.keys(errors).length) {
    const stmt = db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    for (const [k, v] of Object.entries(accepted)) stmt.run(k, JSON.stringify(v));
    if (Object.keys(accepted).length) audit(db, 'settings.update', 'settings', null, { keys: Object.keys(accepted), at: now() });
  }
  return { settings: getSettings(db), errors };
}
