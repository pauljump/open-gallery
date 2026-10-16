// The artwork field registry. One place decides what a field is called, how imports
// recognise it, and — most importantly — whether it may ever leave the private workspace.
//
// visibility:
//   'public'  may appear in public output when the work is published (still subject to settings)
//   'private' never written to any public page, feed, search index or image metadata

export const FIELDS = [
  { key: 'stock_number', label: 'Inventory number', visibility: 'public', type: 'text',
    synonyms: ['stock no', 'stock number', 'stock', 'inventory number', 'inventory no', 'inv no', 'inventory id', 'id', 'sku', 'object number', 'catalog number', 'ref', 'reference', 'artwork id', 'stock code'] },
  { key: 'artist', label: 'Artist', visibility: 'public', type: 'text', required: true,
    synonyms: ['artist', 'artist name', 'artists', 'maker', 'creator'] },
  { key: 'title', label: 'Title', visibility: 'public', type: 'text', required: true,
    synonyms: ['title', 'artwork title', 'work title', 'name', 'artwork'] },
  { key: 'year', label: 'Year', visibility: 'public', type: 'text',
    synonyms: ['year', 'date', 'year created', 'creation date', 'date created', 'circa'] },
  { key: 'medium', label: 'Medium', visibility: 'public', type: 'text',
    synonyms: ['medium', 'materials', 'medium and materials', 'media', 'technique', 'medium/materials'] },
  { key: 'category', label: 'Category', visibility: 'public', type: 'text',
    synonyms: ['category', 'type', 'object type', 'classification', 'artwork type'] },
  { key: 'height', label: 'Height', visibility: 'public', type: 'number', dim: 'work.h',
    synonyms: ['height', 'height (in)', 'height in', 'h', 'h (in)', 'height (cm)', 'h (cm)', 'height cm'] },
  { key: 'width', label: 'Width', visibility: 'public', type: 'number', dim: 'work.w',
    synonyms: ['width', 'width (in)', 'width in', 'w', 'w (in)', 'width (cm)', 'w (cm)', 'width cm'] },
  { key: 'depth', label: 'Depth', visibility: 'public', type: 'number', dim: 'work.d',
    synonyms: ['depth', 'depth (in)', 'depth in', 'd', 'd (in)', 'depth (cm)', 'd (cm)', 'depth cm'] },
  { key: 'dimensions', label: 'Dimensions (text)', visibility: 'public', type: 'dims', dim: 'work',
    synonyms: ['dimensions', 'size', 'dims', 'dimensions (text)', 'measurements', 'artwork dimensions'] },
  { key: 'framed_dimensions', label: 'Framed dimensions', visibility: 'public', type: 'dims', dim: 'framed',
    synonyms: ['framed dimensions', 'framed size', 'framed h x w', 'framed h x w (in)', 'framed h x w (cm)', 'frame size', 'framed', 'dimensions framed', 'framed dims'] },
  { key: 'edition', label: 'Edition', visibility: 'public', type: 'text',
    synonyms: ['edition', 'edition number', 'edition info', 'ed', 'edition size', 'edition details'] },
  { key: 'price', label: 'Price', visibility: 'public', type: 'price',
    synonyms: ['price', 'price (usd)', 'retail price', 'list price', 'asking price', 'price usd', 'retail', 'sale price', 'price (eur)', 'price (gbp)'] },
  { key: 'currency', label: 'Currency', visibility: 'public', type: 'text',
    synonyms: ['currency', 'price currency'] },
  { key: 'availability', label: 'Availability', visibility: 'public', type: 'availability',
    synonyms: ['status', 'availability', 'sale status', 'available', 'inventory status', 'state'] },
  { key: 'signature', label: 'Signature', visibility: 'public', type: 'text',
    synonyms: ['signed', 'signature', 'signature details', 'inscription', 'signed/inscribed'] },
  { key: 'provenance', label: 'Provenance', visibility: 'public', type: 'longtext',
    synonyms: ['provenance'] },
  { key: 'exhibition_history', label: 'Exhibition history', visibility: 'public', type: 'longtext',
    synonyms: ['exhibition history', 'exhibitions', 'exhibited'] },
  { key: 'literature', label: 'Literature', visibility: 'public', type: 'longtext',
    synonyms: ['literature', 'bibliography', 'publications', 'literature/bibliography'] },
  { key: 'condition', label: 'Condition', visibility: 'public', type: 'longtext',
    synonyms: ['condition', 'condition report', 'condition notes'] },
  { key: 'description', label: 'Public description', visibility: 'public', type: 'longtext',
    synonyms: ['description', 'public description', 'about the work', 'catalogue note', 'catalog note', 'text'] },
  { key: 'image_credit', label: 'Image credit / rights', visibility: 'public', type: 'text',
    synonyms: ['image rights', 'image credit', 'photo credit', 'copyright', 'credit line', 'photography credit'] },
  { key: 'artsy_url', label: 'Artsy listing link', visibility: 'public', type: 'url', channel: 'artsy',
    synonyms: ['artsy url', 'artsy link', 'artsy', 'artsy listing'] },
  { key: 'artnet_url', label: 'Artnet listing link', visibility: 'public', type: 'url', channel: 'artnet',
    synonyms: ['artnet url', 'artnet link', 'artnet', 'artnet listing'] },
  { key: 'website_url', label: 'Website listing link', visibility: 'public', type: 'url', channel: 'website',
    synonyms: ['website url', 'web url', 'url', 'link', 'website link', 'shop url'] },
  // Private fields. These never appear in public output.
  { key: 'location', label: 'Location', visibility: 'private', type: 'text',
    synonyms: ['location', 'current location', 'storage location', 'where', 'rack'] },
  { key: 'cost', label: 'Acquisition cost', visibility: 'private', type: 'number',
    synonyms: ['cost', 'acquisition cost', 'purchase price', 'cost price', 'net', 'cost (usd)', 'artist net', 'net to artist'] },
  { key: 'consignor', label: 'Consignor / owner', visibility: 'private', type: 'text',
    synonyms: ['consignor', 'owner', 'consigned by', 'lender', 'source'] },
  { key: 'consignment_terms', label: 'Consignment terms', visibility: 'private', type: 'longtext',
    synonyms: ['consignment terms', 'terms', 'split', 'commission'] },
  { key: 'insurance_value', label: 'Insurance value', visibility: 'private', type: 'number',
    synonyms: ['insurance value', 'insured value', 'insurance', 'valuation'] },
  { key: 'collector', label: 'Buyer / collector', visibility: 'private', type: 'text',
    synonyms: ['buyer', 'collector', 'sold to', 'purchaser', 'client', 'customer'] },
  { key: 'notes', label: 'Private notes', visibility: 'private', type: 'longtext',
    synonyms: ['notes', 'private notes', 'internal notes', 'comments', 'remarks', 'memo'] },
];

export const FIELD = Object.fromEntries(FIELDS.map((f) => [f.key, f]));
export const PRIVATE_KEYS = FIELDS.filter((f) => f.visibility === 'private').map((f) => f.key);

// Columns stored directly on the artworks table.
export const ARTWORK_COLUMNS = ['stock_number', 'title', 'year', 'medium', 'category', 'edition', 'price', 'currency',
  'availability', 'signature', 'provenance', 'exhibition_history', 'literature', 'condition', 'description', 'image_credit'];

export const AVAILABILITY = [
  { key: 'available', label: 'Available' },
  { key: 'on_hold', label: 'On hold' },
  { key: 'sold', label: 'Sold' },
  { key: 'nfs', label: 'Not for sale' },
  { key: 'on_loan', label: 'On loan / out' },
  { key: 'unknown', label: 'Unknown' },
];

export function normHeader(h) {
  return String(h).toLowerCase().replace(/[–—]/g, '-').replace(/[._]/g, ' ').replace(/\s+/g, ' ').trim();
}

const SYN = new Map();
for (const f of FIELDS) for (const s of f.synonyms) SYN.set(normHeader(s), f.key);

/** Suggest a target for a spreadsheet header: a field key, or 'keep' (preserve as an extra column). */
export function suggestTarget(header) {
  const n = normHeader(header);
  if (SYN.has(n)) return SYN.get(n);
  const stripped = n.replace(/\s*\((in|cm|usd|eur|gbp|inches|mm)\)\s*$/, '').trim();
  if (SYN.has(stripped)) return SYN.get(stripped);
  return 'keep';
}

/** Unit hint from a header, e.g. "Height (cm)". */
export function headerUnit(header) {
  const n = normHeader(header);
  if (/\bcm\b|centimet/.test(n)) return 'cm';
  if (/\bmm\b/.test(n)) return 'mm';
  if (/\bin\b|inch|"/.test(n)) return 'in';
  return null;
}

export function headerCurrency(header) {
  const m = normHeader(header).match(/\b(usd|eur|gbp|chf|jpy|cad|aud|hkd|cny)\b/);
  return m ? m[1].toUpperCase() : null;
}
