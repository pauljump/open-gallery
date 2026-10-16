// Read gallery spreadsheets: CSV/TSV (RFC 4180) and XLSX (first sheet, or a named one).
import { readZip } from './zip.mjs';

export function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.slice(0, text.indexOf('\n') >>> 0);
  const delim = (firstLine.match(/\t/g) || []).length > (firstLine.match(/,/g) || []).length ? '\t'
    : (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [], field = '', i = 0, quoted = false;
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"' && field === '') { quoted = true; i++; continue; }
    if (c === delim) { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

const XML_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unxml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return XML_ENT[e] ?? m;
  });
}
function textOf(xml) {
  // Concatenate all <t> runs (handles rich text) — ignore phonetic runs.
  const parts = [];
  xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').replace(/<t\b[^>]*>([\s\S]*?)<\/t>/g, (_, t) => { parts.push(unxml(t)); return ''; });
  return parts.join('');
}
function colIndex(ref) {
  const letters = ref.match(/^[A-Z]+/)[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
// Excel serial dates for columns that are formatted as dates.
function excelDate(serial) {
  const ms = Math.round((serial - 25569) * 86400000);
  return new Date(ms).toISOString().slice(0, 10);
}

export function parseXLSX(buf, sheetName) {
  const zip = readZip(buf);
  const get = (n) => (zip.has(n) ? zip.get(n)().toString('utf8') : null);
  const shared = [];
  const sst = get('xl/sharedStrings.xml');
  if (sst) sst.replace(/<si>([\s\S]*?)<\/si>/g, (_, si) => { shared.push(textOf(si)); return ''; });
  // Date-formatted styles
  const dateStyles = new Set();
  const styles = get('xl/styles.xml');
  if (styles) {
    const custom = new Map();
    styles.replace(/<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g, (_, id, code) => { custom.set(+id, code); return ''; });
    const xfs = (styles.match(/<cellXfs\b[\s\S]*?<\/cellXfs>/) || [''])[0];
    let idx = 0;
    xfs.replace(/<xf\b[^>]*?numFmtId="(\d+)"[^>]*?\/?>/g, (_, id) => {
      const n = +id;
      const code = custom.get(n) || '';
      if ((n >= 14 && n <= 22) || (n >= 45 && n <= 47) || /[dy]/i.test(code.replace(/\[[^\]]*\]|"[^"]*"/g, ''))) dateStyles.add(idx);
      idx++;
      return '';
    });
  }
  const wb = get('xl/workbook.xml') || '';
  const rels = get('xl/_rels/workbook.xml.rels') || '';
  const sheets = [];
  wb.replace(/<sheet\b([^>]*)\/?>/g, (_, attrs) => {
    const name = unxml((attrs.match(/name="([^"]*)"/) || [])[1] || '');
    const rid = (attrs.match(/r:id="([^"]*)"/) || [])[1];
    sheets.push({ name, rid });
    return '';
  });
  let target = 'xl/worksheets/sheet1.xml';
  const chosen = sheetName ? sheets.find((s) => s.name === sheetName) : sheets[0];
  if (chosen?.rid) {
    const m = rels.match(new RegExp(`<Relationship\\b[^>]*Id="${chosen.rid}"[^>]*>`));
    const t = m && (m[0].match(/Target="([^"]*)"/) || [])[1];
    if (t) target = t.startsWith('/') ? t.slice(1) : 'xl/' + t.replace(/^\.\//, '');
  }
  const sheet = get(target);
  if (!sheet) throw new Error('Could not find the first worksheet in this XLSX file.');
  const rows = [];
  sheet.replace(/<row\b[^>]*>([\s\S]*?)<\/row>/g, (_, rowXml) => {
    const row = [];
    rowXml.replace(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, (_m, attrs, inner = '') => {
      const ref = (attrs.match(/r="([A-Z]+\d+)"/) || [])[1];
      const t = (attrs.match(/t="(\w+)"/) || [])[1];
      const s = +((attrs.match(/s="(\d+)"/) || [])[1] ?? -1);
      const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      let val = '';
      if (t === 's') val = shared[+v] ?? '';
      else if (t === 'inlineStr') val = textOf(inner);
      else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
      else if (v != null) {
        val = unxml(v);
        if (t !== 'str' && t !== 'e' && dateStyles.has(s) && /^\d+(\.\d+)?$/.test(val)) val = excelDate(+val);
      }
      const col = ref ? colIndex(ref) : row.length;
      while (row.length < col) row.push('');
      row[col] = val;
      return '';
    });
    rows.push(row);
    return '';
  });
  const width = Math.max(0, ...rows.map((r) => r.length));
  return rows.map((r) => { while (r.length < width) r.push(''); return r; }).filter((r) => r.some((v) => String(v).trim() !== ''));
}

export function readTable(filename, buf) {
  if (/\.xlsx$/i.test(filename)) return parseXLSX(buf);
  if (/\.xls$/i.test(filename)) throw new Error('Old .xls files are not supported. In Excel or Numbers, choose File > Save As > .xlsx or .csv, then import that copy.');
  if (/\.(numbers)$/i.test(filename)) throw new Error('Numbers files are not supported directly. In Numbers, choose File > Export To > CSV or Excel, then import that copy.');
  return parseCSV(buf.toString('utf8'));
}

export function toCSV(rows) {
  return rows.map((r) => r.map((v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\r\n') + '\r\n';
}
