// Minimal ZIP reader/writer with no dependencies.
// Writer stores entries uncompressed (images are already compressed) or deflated for text.
// Reader supports stored and deflated entries, which covers XLSX files and our own bundles.
import { deflateRawSync, inflateRawSync, crc32 } from 'node:zlib';

const DOS_EPOCH = { time: 0, date: (1 << 5) | 1 }; // 1980-01-01, deterministic output

function dosTime(d) {
  if (!d) return DOS_EPOCH;
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** entries: [{ name, data: Buffer|string, compress?: boolean, date?: Date }] */
export function writeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '', 'utf8');
    const compress = e.compress ?? !/\.(png|jpe?g|gif|webp|zip|pdf|heic|tiff?)$/i.test(e.name);
    const body = compress ? deflateRawSync(raw) : raw;
    const method = compress ? 8 : 0;
    const crc = crc32(raw) >>> 0;
    const { time, date } = dosTime(e.date);
    if (raw.length > 0xfffffffe || offset > 0xfffffffe) throw new Error('Bundle exceeds 4 GB; split the export (ZIP64 not supported yet).');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** Returns Map<name, () => Buffer> (lazy extraction). */
export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a ZIP file (no end-of-directory record).');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt ZIP central directory.');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    out.set(name, () => {
      const lnlen = buf.readUInt16LE(lho + 26);
      const lxlen = buf.readUInt16LE(lho + 28);
      const start = lho + 30 + lnlen + lxlen;
      const body = buf.subarray(start, start + csize);
      let data;
      if (method === 0) data = Buffer.from(body);
      else if (method === 8) data = inflateRawSync(body);
      else throw new Error(`Unsupported ZIP compression method ${method} for ${name}.`);
      if ((crc32(data) >>> 0) !== crc) throw new Error(`Checksum mismatch inside ZIP for ${name}.`);
      return data;
    });
  }
  return out;
}
