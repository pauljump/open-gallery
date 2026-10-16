// Turn messy spreadsheet cells into typed values, reporting what could not be understood
// instead of guessing silently.

export function clean(v) {
  if (v == null) return '';
  // Collapse runs of spaces but keep line breaks: notes, provenance and descriptions are
  // multi-line in real sheets, and the public site renders them with white-space: pre-line.
  return String(v).replace(/\r\n?/g, '\n').replace(/ /g, ' ').replace(/[^\S\n]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();
}

/** "12,500" | "$12500.00" | "POA" | "5000 - 7500" -> { amount, onRequest, range, raw, issue } */
export function parsePrice(v, defaultCurrency = 'USD') {
  const raw = clean(v);
  if (!raw) return { amount: null };
  if (/^(poa|p\.o\.a\.?|por|price on (request|application)|on request|inquire|enquire|ask)$/i.test(raw)) return { amount: null, onRequest: true };
  let currency = null;
  const sym = raw.match(/^([$€£¥])|\b(USD|EUR|GBP|CHF|JPY|CAD|AUD|HKD)\b/i);
  if (sym) currency = { '$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY' }[sym[1]] || (sym[2] || '').toUpperCase() || null;
  const nums = raw.replace(/[^\d.,\-–]/g, ' ').split(/\s*[-–]\s*|\s+/).filter(Boolean)
    .map((s) => {
      // "12.500,00" (European) vs "12,500.00"
      if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(s)) return Number(s.replace(/\./g, '').replace(',', '.'));
      return Number(s.replace(/,/g, ''));
    })
    .filter((n) => Number.isFinite(n));
  if (!nums.length) return { amount: null, issue: `Price "${raw}" is not a number` };
  if (nums.length > 1) return { amount: nums[0], rangeMax: nums[1], currency: currency || defaultCurrency };
  return { amount: nums[0], currency: currency || null };
}

const AVAIL = [
  [/^(available|avail|for sale|yes|in stock|active|a)$/i, 'available'],
  [/^(sold|sold out|purchased|s)$/i, 'sold'],
  [/^(on hold|hold|reserved|held|pending|on reserve)$/i, 'on_hold'],
  [/^(nfs|not for sale|n\/a for sale|private collection|collection)$/i, 'nfs'],
  [/^(on loan|loan|consigned out|out on consignment|on approval|out)$/i, 'on_loan'],
];
export function parseAvailability(v) {
  const raw = clean(v);
  if (!raw) return { value: null };
  for (const [re, key] of AVAIL) if (re.test(raw)) return { value: key };
  if (/sold/i.test(raw)) return { value: 'sold' };
  if (/hold|reserv/i.test(raw)) return { value: 'on_hold' };
  return { value: 'unknown', issue: `Status "${raw}" was not recognised; kept as Unknown` };
}

/** "26 x 32" | "61 x 76 cm" | "24 1/2 × 30 in" | "Ø 40 cm" -> { h, w, d, unit, text } */
export function parseDims(v, unitHint = null) {
  const text = clean(v);
  if (!text) return null;
  const unit = /\bcm\b/i.test(text) ? 'cm' : /\bmm\b/i.test(text) ? 'mm' : /\bin\b|inch|"|″/i.test(text) ? 'in' : unitHint;
  const nums = [];
  const re = /(\d+(?:[.,]\d+)?)(?:\s+(\d+)\/(\d+))?|(\d+)\/(\d+)/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[4]) nums.push(+m[4] / +m[5]);
    else nums.push(Number(m[1].replace(',', '.')) + (m[2] ? +m[2] / +m[3] : 0));
  }
  if (!nums.length) return { text, issue: `Dimensions "${text}" could not be read` };
  const out = { text, unit: unit || null };
  if (/ø|diam/i.test(text)) out.diameter = nums[0];
  else { out.h = nums[0]; if (nums[1] != null) out.w = nums[1]; if (nums[2] != null) out.d = nums[2]; }
  if (!unit) out.issue = `No unit in "${text}"; assumed the gallery default`;
  return out;
}

export function parseNumber(v) {
  const raw = clean(v);
  if (!raw) return { value: null };
  const n = Number(raw.replace(/[$€£,\s]/g, ''));
  return Number.isFinite(n) ? { value: n } : { value: null, issue: `"${raw}" is not a number` };
}

export function normKey(s) {
  return clean(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

export function slugify(s) {
  return normKey(s).replace(/\s+/g, '-').slice(0, 60) || 'item';
}

export function isHttpUrl(s) {
  try { const u = new URL(s); return u.protocol === 'https:' || u.protocol === 'http:'; } catch { return false; }
}
