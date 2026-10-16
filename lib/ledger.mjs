// Operations: contacts, consignments (owner of record), holds, sales, payments, deductions,
// payouts to artists and consignors, and artist statements. All private: nothing here is
// ever read by the public site builder.
//
// Money is integer minor units (cents). Splits are the consignor's share in percent.
import { newId, now, audit, tx, J } from './db.mjs';
import { clean, normKey } from './normalize.mjs';
import { getSettings } from './settings.mjs';
import { updateArtwork, httpError } from './store.mjs';
import { toCSV } from './tables.mjs';

const today = () => new Date().toISOString().slice(0, 10);
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
export const toCents = (v) => {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(/[$€£,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0) throw httpError(400, `"${v}" is not an amount`);
  return Math.round(n * 100);
};
const pct = (v, fallback) => {
  if (v === '' || v == null) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw httpError(400, 'Percentages must be between 0 and 100');
  return n;
};
const BORNE = new Set(['shared', 'gallery', 'consignor']);

// ---------------------------------------------------------------- contacts
export function listContacts(db, { q = '' } = {}) {
  const like = `%${q.replace(/[%_]/g, '')}%`;
  return db.prepare(`SELECT c.*,
      (SELECT COUNT(*) FROM sales s WHERE s.contact_id=c.id AND s.status<>'cancelled') AS purchases,
      (SELECT COUNT(*) FROM holds h WHERE h.contact_id=c.id AND h.status='active') AS holds,
      (SELECT COUNT(*) FROM consignments k WHERE k.contact_id=c.id AND k.status='active') AS consignments
    FROM contacts c WHERE c.display_name LIKE ? OR c.email LIKE ? ORDER BY c.sort_name LIMIT 500`).all(like, like);
}

export function getContact(db, id) {
  const c = db.prepare('SELECT * FROM contacts WHERE id=?').get(id);
  if (!c) return null;
  return {
    ...c,
    sales: db.prepare(`SELECT s.*, w.title, a.name AS artist FROM sales s JOIN artworks w ON w.id=s.artwork_id LEFT JOIN artists a ON a.id=w.artist_id
      WHERE s.contact_id=? ORDER BY s.sale_date DESC`).all(id),
    holds: db.prepare(`SELECT h.*, w.title, a.name AS artist FROM holds h JOIN artworks w ON w.id=h.artwork_id LEFT JOIN artists a ON a.id=w.artist_id
      WHERE h.contact_id=? ORDER BY h.placed_at DESC`).all(id),
    consignments: db.prepare(`SELECT k.*, w.title, a.name AS artist FROM consignments k JOIN artworks w ON w.id=k.artwork_id LEFT JOIN artists a ON a.id=w.artist_id
      WHERE k.contact_id=? ORDER BY k.created_at DESC`).all(id),
  };
}

export function saveContact(db, id, input) {
  const t = now();
  const cur = id ? db.prepare('SELECT * FROM contacts WHERE id=?').get(id) : null;
  if (id && !cur) throw httpError(404, 'Contact not found');
  const display = clean(input.display_name ?? cur?.display_name);
  if (!display) throw httpError(400, 'A contact needs a name');
  const v = {
    display_name: display,
    sort_name: clean(input.sort_name) ? normKey(input.sort_name) : (cur && input.display_name === undefined ? cur.sort_name : sortName(display)),
    kind: ['person', 'organization'].includes(input.kind) ? input.kind : cur?.kind || 'person',
    email: clean(input.email ?? cur?.email) || null,
    phone: clean(input.phone ?? cur?.phone) || null,
    address: input.address != null ? String(input.address).slice(0, 1000) : cur?.address ?? null,
    note: input.note != null ? String(input.note).slice(0, 4000) : cur?.note ?? null,
  };
  if (v.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) throw httpError(400, 'That email address does not look right');
  if (!cur) {
    id = newId('ct');
    db.prepare('INSERT INTO contacts(id,display_name,sort_name,kind,email,phone,address,note,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, v.display_name, v.sort_name, v.kind, v.email, v.phone, v.address, v.note, t, t);
    audit(db, 'contact.create', 'contact', id, {});
  } else {
    db.prepare('UPDATE contacts SET display_name=?,sort_name=?,kind=?,email=?,phone=?,address=?,note=?,updated_at=? WHERE id=?')
      .run(v.display_name, v.sort_name, v.kind, v.email, v.phone, v.address, v.note, t, id);
    audit(db, 'contact.update', 'contact', id, {});
  }
  return getContact(db, id);
}

function sortName(name) {
  const parts = name.trim().split(/\s+/);
  return normKey(parts.length > 1 ? `${parts[parts.length - 1]} ${parts.slice(0, -1).join(' ')}` : name);
}

/** Accept a contact id, or a name to find-or-create (so forms can type a new buyer inline). */
export function resolveContact(db, idOrName) {
  if (!idOrName) return null;
  if (/^ct_\w+$/.test(idOrName)) {
    if (!db.prepare('SELECT 1 FROM contacts WHERE id=?').get(idOrName)) throw httpError(404, 'Contact not found');
    return idOrName;
  }
  const name = clean(idOrName);
  const hit = db.prepare('SELECT id FROM contacts WHERE lower(display_name)=lower(?)').get(name);
  return hit ? hit.id : saveContact(db, null, { display_name: name }).id;
}

// ---------------------------------------------------------------- consignments (owner of record)
export function saveConsignment(db, id, input) {
  const t = now();
  const cur = id ? db.prepare('SELECT * FROM consignments WHERE id=?').get(id) : null;
  if (id && !cur) throw httpError(404, 'Consignment not found');
  const artworkId = cur?.artwork_id || input.artwork_id;
  const aw = db.prepare('SELECT id, artist_id FROM artworks WHERE id=?').get(artworkId);
  if (!aw) throw httpError(404, 'Artwork not found');
  const from = input.from ?? (cur ? (cur.contact_id ? 'contact' : 'artist') : 'artist');
  const contactId = from === 'contact' ? resolveContact(db, input.contact ?? cur?.contact_id) : null;
  if (from === 'contact' && !contactId) throw httpError(400, 'Choose who consigned the work');
  const artist = from === 'artist' ? db.prepare('SELECT default_split FROM artists WHERE id=?').get(aw.artist_id) : null;
  const v = {
    direction: input.direction === 'out' ? 'out' : (cur?.direction || 'in'),
    artist_id: from === 'artist' ? aw.artist_id : null,
    contact_id: contactId,
    start_date: input.start_date !== undefined ? (input.start_date || null) : cur?.start_date ?? today(),
    end_date: input.end_date !== undefined ? (input.end_date || null) : cur?.end_date ?? null,
    split_pct: pct(input.split_pct, cur?.split_pct ?? artist?.default_split ?? getSettings(db).operations.defaultSplit),
    discount_limit_pct: input.discount_limit_pct !== undefined ? pct(input.discount_limit_pct, null) : cur?.discount_limit_pct ?? null,
    discount_borne_by: BORNE.has(input.discount_borne_by) ? input.discount_borne_by : cur?.discount_borne_by || 'shared',
    insured_value: input.insured_value !== undefined ? toCents(input.insured_value) : cur?.insured_value ?? null,
    insured_by: input.insured_by !== undefined ? clean(input.insured_by) || null : cur?.insured_by ?? null,
    terms: input.terms !== undefined ? String(input.terms || '').slice(0, 4000) || null : cur?.terms ?? null,
    status: ['active', 'returned', 'sold', 'ended'].includes(input.status) ? input.status : cur?.status || 'active',
  };
  for (const d of ['start_date', 'end_date']) if (v[d] && !isDate(v[d])) throw httpError(400, 'Dates must look like 2026-10-16');
  if (v.start_date && v.end_date && v.end_date < v.start_date) throw httpError(400, 'The end date is before the start date');
  return tx(db, () => {
    if (v.status === 'active' && v.direction === 'in') {
      const other = db.prepare("SELECT id FROM consignments WHERE artwork_id=? AND status='active' AND direction='in' AND id<>?").get(artworkId, id || '');
      if (other) throw httpError(409, 'This work already has an active consignment. End or edit that one first.');
    }
    if (!cur) {
      id = newId('cn');
      db.prepare(`INSERT INTO consignments(id,artwork_id,direction,artist_id,contact_id,start_date,end_date,split_pct,discount_limit_pct,discount_borne_by,insured_value,insured_by,terms,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, artworkId, v.direction, v.artist_id, v.contact_id, v.start_date, v.end_date, v.split_pct, v.discount_limit_pct, v.discount_borne_by, v.insured_value, v.insured_by, v.terms, v.status, t, t);
      db.prepare('UPDATE artworks SET gallery_owned=0 WHERE id=?').run(artworkId);
      audit(db, 'consignment.create', 'artwork', artworkId, { consignment: id });
    } else {
      db.prepare(`UPDATE consignments SET direction=?,artist_id=?,contact_id=?,start_date=?,end_date=?,split_pct=?,discount_limit_pct=?,discount_borne_by=?,insured_value=?,insured_by=?,terms=?,status=?,updated_at=? WHERE id=?`)
        .run(v.direction, v.artist_id, v.contact_id, v.start_date, v.end_date, v.split_pct, v.discount_limit_pct, v.discount_borne_by, v.insured_value, v.insured_by, v.terms, v.status, t, id);
      audit(db, 'consignment.update', 'artwork', artworkId, { consignment: id, status: v.status });
    }
    return db.prepare('SELECT * FROM consignments WHERE id=?').get(id);
  });
}

export function setGalleryOwned(db, artworkId, owned) {
  if (owned && db.prepare("SELECT 1 FROM consignments WHERE artwork_id=? AND status='active' AND direction='in'").get(artworkId)) {
    throw httpError(409, 'End the active consignment before marking the work as gallery stock');
  }
  db.prepare('UPDATE artworks SET gallery_owned=? WHERE id=?').run(owned ? 1 : 0, artworkId);
  audit(db, 'artwork.ownership', 'artwork', artworkId, { gallery_owned: !!owned });
}

/** Who owns the work right now, in words a person can act on. */
export function ownerOfRecord(db, artworkId) {
  const aw = db.prepare('SELECT gallery_owned, artist_id FROM artworks WHERE id=?').get(artworkId);
  const k = db.prepare("SELECT k.*, a.name AS artist_name, c.display_name AS contact_name FROM consignments k LEFT JOIN artists a ON a.id=k.artist_id LEFT JOIN contacts c ON c.id=k.contact_id WHERE k.artwork_id=? AND k.status IN ('active','sold') ORDER BY CASE k.status WHEN 'active' THEN 0 ELSE 1 END, k.created_at DESC LIMIT 1").get(artworkId);
  if (k && k.status === 'active') return { kind: k.contact_id ? 'collector_consignment' : 'artist_consignment', name: k.contact_name || k.artist_name, consignment: k };
  if (aw?.gallery_owned) return { kind: 'gallery', name: 'Gallery stock' };
  return { kind: 'unknown', name: null, lastConsignment: k || null };
}

// ---------------------------------------------------------------- holds
function expireHolds(db, artworkId) {
  const t = now();
  const rows = db.prepare(`SELECT id, artwork_id FROM holds WHERE status='active' AND expires_at IS NOT NULL AND expires_at < ? ${artworkId ? 'AND artwork_id=?' : ''}`).all(...(artworkId ? [t, artworkId] : [t]));
  for (const h of rows) {
    db.prepare("UPDATE holds SET status='expired', closed_at=? WHERE id=?").run(t, h.id);
    audit(db, 'hold.expire', 'artwork', h.artwork_id, { hold: h.id });
  }
  for (const a of new Set(rows.map((r) => r.artwork_id))) syncHoldAvailability(db, a);
}

function syncHoldAvailability(db, artworkId) {
  const aw = db.prepare('SELECT availability FROM artworks WHERE id=?').get(artworkId);
  if (!aw || !['available', 'on_hold'].includes(aw.availability)) return;
  const active = db.prepare("SELECT COUNT(*) n FROM holds WHERE artwork_id=? AND status='active'").get(artworkId).n;
  const want = active ? 'on_hold' : 'available';
  if (aw.availability !== want) updateArtwork(db, artworkId, { availability: want });
}

export function listHolds(db, artworkId) {
  expireHolds(db, artworkId);
  return db.prepare(`SELECT h.*, c.display_name AS contact_name FROM holds h LEFT JOIN contacts c ON c.id=h.contact_id
    WHERE h.artwork_id=? ORDER BY CASE h.status WHEN 'active' THEN 0 ELSE 1 END, h.placed_at`).all(artworkId);
}

export function placeHold(db, artworkId, { contact, hours, expires_at, note } = {}) {
  return tx(db, () => {
    expireHolds(db, artworkId);
    const aw = db.prepare('SELECT availability FROM artworks WHERE id=?').get(artworkId);
    if (!aw) throw httpError(404, 'Artwork not found');
    if (['sold', 'nfs'].includes(aw.availability)) throw httpError(409, `This work is ${aw.availability === 'sold' ? 'sold' : 'not for sale'}; it cannot be held`);
    const contactId = resolveContact(db, contact);
    const settings = getSettings(db);
    const h = hours === '' || hours == null ? settings.operations.holdHours : Number(hours);
    let exp = expires_at || (h > 0 ? new Date(Date.now() + h * 3600e3).toISOString() : null);
    if (exp && Number.isNaN(Date.parse(exp))) throw httpError(400, 'Hold expiry is not a valid time');
    if (exp) exp = new Date(exp).toISOString();
    const id = newId('hd');
    db.prepare('INSERT INTO holds(id,artwork_id,contact_id,placed_at,expires_at,note) VALUES (?,?,?,?,?,?)').run(id, artworkId, contactId, now(), exp, clean(note) || null);
    audit(db, 'hold.place', 'artwork', artworkId, { hold: id });
    syncHoldAvailability(db, artworkId);
    return listHolds(db, artworkId);
  });
}

export function closeHold(db, holdId, status = 'released') {
  const h = db.prepare('SELECT * FROM holds WHERE id=?').get(holdId);
  if (!h) throw httpError(404, 'Hold not found');
  if (h.status !== 'active') return listHolds(db, h.artwork_id);
  db.prepare('UPDATE holds SET status=?, closed_at=? WHERE id=?').run(status, now(), holdId);
  audit(db, `hold.${status}`, 'artwork', h.artwork_id, { hold: holdId });
  syncHoldAvailability(db, h.artwork_id);
  return listHolds(db, h.artwork_id);
}

export function holdsExpiringSoon(db, withinHours = 24) {
  expireHolds(db);
  const until = new Date(Date.now() + withinHours * 3600e3).toISOString();
  return db.prepare(`SELECT h.*, c.display_name AS contact_name, w.title, a.name AS artist FROM holds h JOIN artworks w ON w.id=h.artwork_id
    LEFT JOIN artists a ON a.id=w.artist_id LEFT JOIN contacts c ON c.id=h.contact_id
    WHERE h.status='active' AND h.expires_at IS NOT NULL AND h.expires_at <= ? ORDER BY h.expires_at`).all(until);
}

// ---------------------------------------------------------------- sales
/**
 * The split arithmetic, in cents.
 *  shared:    consignor gets split% of the price actually paid (discount shared pro rata)
 *  gallery:   consignor gets split% of the list price; the gallery absorbs the discount
 *  consignor: gallery keeps its share of the list price; the consignor absorbs the discount
 * Deductions (framing, shipping charged back, etc.) come off the consignor's share.
 */
export function splitSale(sale, deductionsCents = 0) {
  if (sale.split_pct == null) return { consignorGross: 0, galleryShare: sale.price_cents, deductions: 0, net: 0, discount: 0 };
  const price = sale.price_cents;
  const list = sale.list_cents ?? price;
  const s = sale.split_pct / 100;
  let consignorGross;
  if (sale.discount_borne_by === 'gallery') consignorGross = Math.round(Math.max(list, price) * s);
  else if (sale.discount_borne_by === 'consignor') consignorGross = price - Math.round(list * (1 - s));
  else consignorGross = Math.round(price * s);
  consignorGross = Math.max(0, consignorGross);
  return {
    consignorGross,
    galleryShare: price - consignorGross,
    deductions: deductionsCents,
    net: consignorGross - deductionsCents,
    discount: Math.max(0, list - price),
  };
}

function saleRow(db, id) { return db.prepare('SELECT * FROM sales WHERE id=?').get(id); }

/** Full picture of a sale: payments, deductions, split, what is owed and when. */
export function saleDetail(db, id) {
  const s = saleRow(db, id);
  if (!s) return null;
  const settings = getSettings(db);
  const payments = db.prepare('SELECT * FROM payments WHERE sale_id=? ORDER BY paid_on, created_at').all(id);
  const deductions = db.prepare('SELECT * FROM deductions WHERE sale_id=? ORDER BY created_at').all(id);
  const k = s.consignment_id ? db.prepare('SELECT k.*, a.name AS artist_name, c.display_name AS contact_name FROM consignments k LEFT JOIN artists a ON a.id=k.artist_id LEFT JOIN contacts c ON c.id=k.contact_id WHERE k.id=?').get(s.consignment_id) : null;
  const total = s.price_cents + s.tax_cents + s.shipping_cents;
  const paid = payments.reduce((n, p) => n + p.amount_cents, 0);
  const split = splitSale(s, deductions.reduce((n, d) => n + d.amount_cents, 0));
  let paidInFullOn = null;
  if (paid >= total && payments.length) paidInFullOn = payments[payments.length - 1].paid_on;
  const payout = k ? db.prepare("SELECT * FROM payouts WHERE EXISTS (SELECT 1 FROM json_each(payouts.sale_ids) WHERE value=?) ORDER BY paid_on").all(id) : [];
  const dueOn = k && paidInFullOn ? addDays(paidInFullOn, settings.operations.payoutDays) : null;
  let payoutStatus = 'none';
  if (k && s.status !== 'cancelled') {
    if (payout.length) payoutStatus = 'paid_out';
    else if (!paidInFullOn) payoutStatus = 'awaiting_buyer';
    else payoutStatus = dueOn < today() ? 'overdue' : 'payable';
  }
  const buyer = s.contact_id ? db.prepare('SELECT id, display_name FROM contacts WHERE id=?').get(s.contact_id) : null;
  const art = db.prepare('SELECT w.title, w.stock_number, a.name AS artist FROM artworks w LEFT JOIN artists a ON a.id=w.artist_id WHERE w.id=?').get(s.artwork_id);
  return {
    ...s, ...art, buyer, payments, deductions, consignment: k, payee: k ? (k.contact_name || k.artist_name) : null,
    total_cents: total, paid_cents: paid, balance_cents: Math.max(0, total - paid),
    split, paid_in_full_on: paidInFullOn, payout_due_on: dueOn, payout_status: payoutStatus, payouts: payout,
  };
}

export function recordSale(db, artworkId, input) {
  return tx(db, () => {
    const aw = db.prepare('SELECT * FROM artworks WHERE id=?').get(artworkId);
    if (!aw) throw httpError(404, 'Artwork not found');
    if (db.prepare("SELECT 1 FROM sales WHERE artwork_id=? AND status<>'cancelled'").get(artworkId)) throw httpError(409, 'This work already has a sale recorded. Cancel it first to record a different one.');
    const settings = getSettings(db);
    const price = toCents(input.price);
    if (price == null) throw httpError(400, 'Enter the sale price');
    const saleDate = input.sale_date || today();
    if (!isDate(saleDate)) throw httpError(400, 'Sale date must look like 2026-10-16');
    const k = db.prepare("SELECT * FROM consignments WHERE artwork_id=? AND status='active' AND direction='in'").get(artworkId);
    const list = input.list_price !== undefined && input.list_price !== '' ? toCents(input.list_price) : aw.price != null ? Math.round(aw.price * 100) : null;
    if (k && k.discount_limit_pct != null && list && price < list * (1 - k.discount_limit_pct / 100) && !input.discount_approved) {
      throw httpError(409, `This discount is more than the ${k.discount_limit_pct}% the consignment allows without approval. Tick "consignor approved the discount" to record it.`, { needsApproval: true });
    }
    const id = newId('sl');
    const t = now();
    db.prepare(`INSERT INTO sales(id,artwork_id,contact_id,consignment_id,sale_date,currency,list_cents,price_cents,tax_cents,shipping_cents,split_pct,discount_borne_by,invoice_number,channel,status,note,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, artworkId, resolveContact(db, input.buyer), k?.id || null, saleDate,
      (input.currency || aw.currency || settings.catalog.currency).toUpperCase().slice(0, 3), list, price, toCents(input.tax) || 0, toCents(input.shipping) || 0,
      k ? k.split_pct : null, k ? (input.discount_borne_by && BORNE.has(input.discount_borne_by) ? input.discount_borne_by : k.discount_borne_by) : null,
      clean(input.invoice_number) || null, clean(input.channel) || null, 'open', clean(input.note) || null, t, t);
    const deposit = toCents(input.deposit);
    if (deposit) db.prepare('INSERT INTO payments(id,sale_id,paid_on,amount_cents,method,note,created_at) VALUES (?,?,?,?,?,?,?)').run(newId('py'), id, saleDate, deposit, clean(input.deposit_method) || null, 'Deposit', t);
    if (k) db.prepare("UPDATE consignments SET status='sold', updated_at=? WHERE id=?").run(t, k.id);
    // Holds: the buyer's own hold becomes the sale; everyone else's is released.
    for (const h of db.prepare("SELECT id, contact_id FROM holds WHERE artwork_id=? AND status='active'").all(artworkId)) {
      db.prepare('UPDATE holds SET status=?, closed_at=? WHERE id=?').run(h.contact_id && h.contact_id === resolveContactOrNull(db, input.buyer) ? 'converted' : 'released', t, h.id);
    }
    updateArtwork(db, artworkId, { availability: 'sold' });
    audit(db, 'sale.record', 'artwork', artworkId, { sale: id });
    return saleDetail(db, id);
  });
}

function resolveContactOrNull(db, v) {
  if (!v) return null;
  if (/^ct_\w+$/.test(v)) return v;
  return db.prepare('SELECT id FROM contacts WHERE lower(display_name)=lower(?)').get(clean(v))?.id || null;
}

export function updateSale(db, id, input) {
  const s = saleRow(db, id);
  if (!s) throw httpError(404, 'Sale not found');
  if (s.status === 'cancelled') throw httpError(409, 'This sale was cancelled');
  const sets = {};
  if (input.price !== undefined) sets.price_cents = toCents(input.price);
  if (input.list_price !== undefined) sets.list_cents = toCents(input.list_price);
  if (input.tax !== undefined) sets.tax_cents = toCents(input.tax) || 0;
  if (input.shipping !== undefined) sets.shipping_cents = toCents(input.shipping) || 0;
  if (input.invoice_number !== undefined) sets.invoice_number = clean(input.invoice_number) || null;
  if (input.sale_date !== undefined) { if (!isDate(input.sale_date)) throw httpError(400, 'Sale date must look like 2026-10-16'); sets.sale_date = input.sale_date; }
  if (input.buyer !== undefined) sets.contact_id = resolveContact(db, input.buyer);
  if (input.note !== undefined) sets.note = clean(input.note) || null;
  if (input.discount_borne_by !== undefined && s.consignment_id) { if (!BORNE.has(input.discount_borne_by)) throw httpError(400, 'Unknown discount rule'); sets.discount_borne_by = input.discount_borne_by; }
  if (sets.price_cents === null) throw httpError(400, 'A sale needs a price');
  if (db.prepare("SELECT 1 FROM payouts WHERE EXISTS (SELECT 1 FROM json_each(payouts.sale_ids) WHERE value=?)").get(id) && ['price_cents', 'list_cents', 'discount_borne_by'].some((k) => k in sets)) {
    throw httpError(409, 'The consignor has already been paid for this sale. Record an adjustment instead of changing the price.');
  }
  sets.updated_at = now();
  const cols = Object.keys(sets);
  db.prepare(`UPDATE sales SET ${cols.map((c) => `${c}=?`).join(',')} WHERE id=?`).run(...cols.map((c) => sets[c]), id);
  audit(db, 'sale.update', 'artwork', s.artwork_id, { sale: id, fields: cols });
  return saleDetail(db, id);
}

export function cancelSale(db, id, { note } = {}) {
  return tx(db, () => {
    const s = saleRow(db, id);
    if (!s) throw httpError(404, 'Sale not found');
    if (db.prepare("SELECT 1 FROM payouts WHERE EXISTS (SELECT 1 FROM json_each(payouts.sale_ids) WHERE value=?)").get(id)) throw httpError(409, 'The consignor was already paid for this sale; cancelling it needs a manual adjustment.');
    db.prepare("UPDATE sales SET status='cancelled', note=COALESCE(?, note), updated_at=? WHERE id=?").run(clean(note) || null, now(), id);
    if (s.consignment_id) db.prepare("UPDATE consignments SET status='active', updated_at=? WHERE id=?").run(now(), s.consignment_id);
    updateArtwork(db, s.artwork_id, { availability: 'available' });
    audit(db, 'sale.cancel', 'artwork', s.artwork_id, { sale: id });
    return saleDetail(db, id);
  });
}

export function addPayment(db, saleId, { amount, paid_on, method, note }) {
  const s = saleRow(db, saleId);
  if (!s) throw httpError(404, 'Sale not found');
  if (s.status === 'cancelled') throw httpError(409, 'This sale was cancelled');
  const cents = toCents(amount);
  if (!cents) throw httpError(400, 'Enter the amount received');
  const d = paid_on || today();
  if (!isDate(d)) throw httpError(400, 'Payment date must look like 2026-10-16');
  db.prepare('INSERT INTO payments(id,sale_id,paid_on,amount_cents,method,note,created_at) VALUES (?,?,?,?,?,?,?)').run(newId('py'), saleId, d, cents, clean(method) || null, clean(note) || null, now());
  const detail = saleDetail(db, saleId);
  if (detail.balance_cents === 0 && s.status !== 'paid') db.prepare("UPDATE sales SET status='paid', updated_at=? WHERE id=?").run(now(), saleId);
  audit(db, 'sale.payment', 'artwork', s.artwork_id, { sale: saleId });
  return saleDetail(db, saleId);
}

export function addDeduction(db, saleId, { description, amount }) {
  const s = saleRow(db, saleId);
  if (!s) throw httpError(404, 'Sale not found');
  if (!s.consignment_id) throw httpError(400, 'Deductions apply to consigned works only');
  if (!clean(description)) throw httpError(400, 'Say what the deduction is for');
  const cents = toCents(amount);
  if (!cents) throw httpError(400, 'Enter the deduction amount');
  db.prepare('INSERT INTO deductions(id,sale_id,description,amount_cents,created_at) VALUES (?,?,?,?,?)').run(newId('dd'), saleId, clean(description), cents, now());
  audit(db, 'sale.deduction', 'artwork', s.artwork_id, { sale: saleId });
  return saleDetail(db, saleId);
}

export function salesForArtwork(db, artworkId) {
  return db.prepare('SELECT id FROM sales WHERE artwork_id=? ORDER BY created_at DESC').all(artworkId).map((r) => saleDetail(db, r.id));
}

// ---------------------------------------------------------------- payees, payouts, statements
function payeeKey(k) { return k.contact_id ? `contact:${k.contact_id}` : `artist:${k.artist_id}`; }

/** Every consigned sale with what is owed, grouped by who is owed. */
export function owedSummary(db) {
  const rows = db.prepare("SELECT id FROM sales WHERE consignment_id IS NOT NULL AND status<>'cancelled'").all().map((r) => saleDetail(db, r.id));
  const yearStart = `${today().slice(0, 4)}-01-01`;
  const by = new Map();
  for (const s of rows) {
    const key = payeeKey(s.consignment);
    if (!by.has(key)) by.set(key, { key, type: s.consignment.contact_id ? 'contact' : 'artist', id: s.consignment.contact_id || s.consignment.artist_id, name: s.payee, currency: s.currency,
      awaiting_buyer_cents: 0, payable_cents: 0, overdue_cents: 0, held_cents: 0, sales: [] });
    const p = by.get(key);
    p.sales.push(s);
    if (s.payout_status === 'awaiting_buyer') {
      p.awaiting_buyer_cents += s.split.net;
      // Money already received from the buyer that will belong to the consignor (pro rata).
      if (s.total_cents) p.held_cents += Math.round(s.split.net * Math.min(1, s.paid_cents / s.total_cents));
    }
    if (s.payout_status === 'payable') { p.payable_cents += s.split.net; p.held_cents += s.split.net; }
    if (s.payout_status === 'overdue') { p.overdue_cents += s.split.net; p.held_cents += s.split.net; }
  }
  for (const p of by.values()) {
    p.paid_ytd_cents = db.prepare(`SELECT COALESCE(SUM(amount_cents),0) n FROM payouts WHERE ${p.type === 'contact' ? 'contact_id' : 'artist_id'}=? AND paid_on>=?`).get(p.id, yearStart).n;
  }
  const payees = [...by.values()].sort((a, b) => (b.overdue_cents - a.overdue_cents) || (b.payable_cents - a.payable_cents) || a.name.localeCompare(b.name));
  return {
    payees,
    totals: payees.reduce((t, p) => ({ held: t.held + p.held_cents, payable: t.payable + p.payable_cents, overdue: t.overdue + p.overdue_cents, awaiting: t.awaiting + p.awaiting_buyer_cents }), { held: 0, payable: 0, overdue: 0, awaiting: 0 }),
  };
}

export function recordPayout(db, { payee_type, payee_id, sale_ids = [], amount, paid_on, method, reference }) {
  return tx(db, () => {
    if (!['artist', 'contact'].includes(payee_type)) throw httpError(400, 'Unknown payee');
    if (!sale_ids.length) throw httpError(400, 'Choose the sales this payment covers');
    let total = 0; let currency = null;
    for (const sid of sale_ids) {
      const s = saleDetail(db, sid);
      if (!s || !s.consignment) throw httpError(404, 'One of the sales was not found or is not consigned');
      const k = s.consignment;
      if ((payee_type === 'artist' && k.artist_id !== payee_id) || (payee_type === 'contact' && k.contact_id !== payee_id)) throw httpError(400, `${s.title} is not owed to this payee`);
      if (s.payout_status === 'paid_out') throw httpError(409, `${s.title} was already paid out`);
      if (s.payout_status === 'awaiting_buyer') throw httpError(409, `The buyer has not paid in full for ${s.title} yet`);
      total += s.split.net; currency = s.currency;
    }
    const cents = amount === undefined || amount === '' ? total : toCents(amount);
    if (cents !== total) throw httpError(400, `The payout should be ${(total / 100).toFixed(2)} for the sales chosen. Record partial payments as separate payouts per sale.`);
    const d = paid_on || today();
    if (!isDate(d)) throw httpError(400, 'Payout date must look like 2026-10-16');
    const id = newId('po');
    db.prepare('INSERT INTO payouts(id,artist_id,contact_id,paid_on,amount_cents,currency,method,reference,sale_ids,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, payee_type === 'artist' ? payee_id : null, payee_type === 'contact' ? payee_id : null, d, cents, currency, clean(method) || null, clean(reference) || null, JSON.stringify(sale_ids), now());
    audit(db, 'payout.record', payee_type, payee_id, { payout: id, sales: sale_ids.length });
    return db.prepare('SELECT * FROM payouts WHERE id=?').get(id);
  });
}

/** An artist (or consignor) statement for a period: consigned works, sales, payouts, balance. */
export function statement(db, payeeType, payeeId, { from, to } = {}) {
  const f = from && isDate(from) ? from : `${today().slice(0, 4)}-01-01`;
  const t2 = to && isDate(to) ? to : today();
  const col = payeeType === 'contact' ? 'contact_id' : 'artist_id';
  const payee = payeeType === 'contact' ? db.prepare('SELECT id, display_name AS name, email, address FROM contacts WHERE id=?').get(payeeId) : db.prepare('SELECT id, name, payee_note FROM artists WHERE id=?').get(payeeId);
  if (!payee) throw httpError(404, 'Payee not found');
  const consigned = db.prepare(`SELECT k.*, w.title, w.year, w.stock_number, w.price, w.currency, w.availability FROM consignments k JOIN artworks w ON w.id=k.artwork_id
    WHERE k.${col}=? AND k.direction='in' AND k.status='active' ORDER BY w.title`).all(payeeId);
  const sales = db.prepare(`SELECT s.id FROM sales s JOIN consignments k ON k.id=s.consignment_id WHERE k.${col}=? AND s.status<>'cancelled' AND s.sale_date BETWEEN ? AND ? ORDER BY s.sale_date`).all(payeeId, f, t2).map((r) => saleDetail(db, r.id));
  const payouts = db.prepare(`SELECT * FROM payouts WHERE ${col}=? AND paid_on BETWEEN ? AND ? ORDER BY paid_on`).all(payeeId, f, t2);
  const owed = owedSummary(db).payees.find((p) => p.type === payeeType && p.id === payeeId) || null;
  return {
    payee, type: payeeType, from: f, to: t2, consigned, sales, payouts,
    totals: {
      gross: sales.reduce((n, s) => n + s.price_cents, 0),
      consignorGross: sales.reduce((n, s) => n + s.split.consignorGross, 0),
      deductions: sales.reduce((n, s) => n + s.split.deductions, 0),
      net: sales.reduce((n, s) => n + s.split.net, 0),
      paidOut: payouts.reduce((n, p) => n + p.amount_cents, 0),
    },
    owedNow: owed ? { payable: owed.payable_cents, overdue: owed.overdue_cents, awaitingBuyer: owed.awaiting_buyer_cents } : { payable: 0, overdue: 0, awaitingBuyer: 0 },
    generatedAt: now(),
  };
}

export function consignmentsEndingSoon(db, withinDays = 30) {
  const until = addDays(today(), withinDays);
  return db.prepare(`SELECT k.*, w.title, a.name AS artist, COALESCE(c.display_name, a.name) AS contact_name FROM consignments k JOIN artworks w ON w.id=k.artwork_id
    LEFT JOIN artists a ON a.id=w.artist_id LEFT JOIN contacts c ON c.id=k.contact_id
    WHERE k.status='active' AND k.end_date IS NOT NULL AND k.end_date <= ? ORDER BY k.end_date`).all(until);
}

/** CSV for an accountant: one row per sale and one per payout. */
export function accountingCSV(db, { from, to } = {}) {
  const f = from && isDate(from) ? from : '0000-01-01';
  const t2 = to && isDate(to) ? to : '9999-12-31';
  const m = (c) => (c == null ? '' : (c / 100).toFixed(2));
  const rows = [['Type', 'Date', 'Reference', 'Inventory number', 'Artist', 'Title', 'Buyer or payee', 'Currency', 'List price', 'Sale price', 'Tax', 'Shipping', 'Total invoiced', 'Received', 'Consignor share', 'Deductions', 'Net to consignor', 'Gallery share', 'Status']];
  for (const r of db.prepare("SELECT id FROM sales WHERE sale_date BETWEEN ? AND ? ORDER BY sale_date").all(f, t2)) {
    const s = saleDetail(db, r.id);
    rows.push(['Sale', s.sale_date, s.invoice_number || s.id, s.stock_number || '', s.artist || '', s.title || '', s.buyer?.display_name || '', s.currency, m(s.list_cents), m(s.price_cents), m(s.tax_cents), m(s.shipping_cents), m(s.total_cents), m(s.paid_cents),
      s.consignment ? m(s.split.consignorGross) : '', s.consignment ? m(s.split.deductions) : '', s.consignment ? m(s.split.net) : '', m(s.split.galleryShare), s.status]);
  }
  for (const p of db.prepare('SELECT p.*, a.name AS artist_name, c.display_name AS contact_name FROM payouts p LEFT JOIN artists a ON a.id=p.artist_id LEFT JOIN contacts c ON c.id=p.contact_id WHERE p.paid_on BETWEEN ? AND ? ORDER BY p.paid_on').all(f, t2)) {
    rows.push(['Payout', p.paid_on, p.reference || p.id, '', p.artist_name || '', `${J(p.sale_ids, []).length} sale(s)`, p.contact_name || p.artist_name || '', p.currency, '', '', '', '', '', '', '', '', m(p.amount_cents), '', p.method || '']);
  }
  return toCSV(rows);
}
