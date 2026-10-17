// Inquiries from the public catalog. They go straight to the gallery's own workspace:
// no marketplace in between and no commission. Private, like everything else operational.
import { newId, now, audit } from './db.mjs';
import { clean } from './normalize.mjs';
import { httpError } from './store.mjs';
import { saveContact } from './ledger.mjs';

export function receiveInquiry(db, { artwork_id, name, email, message, page }) {
  const n = clean(name).slice(0, 120); const e = clean(email).slice(0, 200); const m = String(message || '').trim().slice(0, 4000);
  if (!n || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || m.length < 2) throw httpError(400, 'Please give your name, a valid email and a message.');
  const aw = artwork_id && /^aw_\w+$/.test(artwork_id) ? db.prepare('SELECT id FROM artworks WHERE id=? AND public=1').get(artwork_id) : null;
  const id = newId('iq');
  db.prepare('INSERT INTO inquiries(id,artwork_id,name,email,message,page,created_at) VALUES (?,?,?,?,?,?,?)').run(id, aw?.id || null, n, e, m, clean(page).slice(0, 300) || null, now());
  audit(db, 'inquiry.receive', 'inquiry', id, {});
  return id;
}

export function listInquiries(db, { status = '' } = {}) {
  return db.prepare(`SELECT i.*, w.title, a.name AS artist FROM inquiries i LEFT JOIN artworks w ON w.id=i.artwork_id LEFT JOIN artists a ON a.id=w.artist_id
    ${status ? 'WHERE i.status=?' : ''} ORDER BY i.created_at DESC LIMIT 500`).all(...(status ? [status] : []));
}

export function updateInquiry(db, id, { status, add_contact }) {
  const q = db.prepare('SELECT * FROM inquiries WHERE id=?').get(id);
  if (!q) throw httpError(404, 'Inquiry not found');
  if (status) { if (!['new', 'read', 'archived'].includes(status)) throw httpError(400, 'Unknown status'); db.prepare('UPDATE inquiries SET status=? WHERE id=?').run(status, id); }
  if (add_contact && !q.contact_id) {
    const existing = db.prepare('SELECT id FROM contacts WHERE lower(email)=lower(?)').get(q.email);
    const cid = existing?.id || saveContact(db, null, { display_name: q.name, email: q.email, note: `First inquiry ${q.created_at.slice(0, 10)}` }).id;
    db.prepare('UPDATE inquiries SET contact_id=? WHERE id=?').run(cid, id);
  }
  return db.prepare('SELECT * FROM inquiries WHERE id=?').get(id);
}
