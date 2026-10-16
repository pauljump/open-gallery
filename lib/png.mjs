// Zero-dependency PNG encoder plus tiny image-size readers (PNG, JPEG, GIF, WebP).
import { deflateSync, crc32 } from 'node:zlib';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(data, crc32(typeBuf)) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** 8-bit RGB PNG from a w*h*3 byte buffer. Filter 0 on every row. */
export function encodePNG(width, height, rgb) {
  if (rgb.length !== width * height * 3) throw new Error(`encodePNG: expected ${width * height * 3} bytes, got ${rgb.length}`);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 6 });
  return Buffer.concat([PNG_SIG, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

export function readPNGSize(buf) {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('Not a PNG');
  if (buf.toString('latin1', 12, 16) !== 'IHDR') throw new Error('PNG missing IHDR');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Walks JPEG markers until a SOF0..SOF15 (except DHT/JPG/DAC) frame header. */
export function readJPEGSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('Not a JPEG');
  let p = 2;
  while (p + 9 < buf.length) {
    if (buf[p] !== 0xff) { p++; continue; }
    const marker = buf[p + 1];
    if (marker === 0xff) { p++; continue; }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { p += 2; continue; }
    const len = buf.readUInt16BE(p + 2);
    const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF) return { height: buf.readUInt16BE(p + 5), width: buf.readUInt16BE(p + 7) };
    if (marker === 0xd9 || marker === 0xda) break;
    p += 2 + len;
  }
  throw new Error('JPEG has no SOF marker');
}

function readGIFSize(buf) {
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

function readWebPSize(buf) {
  const fmt = buf.toString('latin1', 12, 16);
  if (fmt === 'VP8X') {
    return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  }
  if (fmt === 'VP8L') {
    const b = buf.readUInt32LE(21);
    return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) };
  }
  if (fmt === 'VP8 ') {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  throw new Error('Unknown WebP variant');
}

/** Dispatch on magic bytes. Returns { width, height, type } or { width: null, height: null, type: null }. */
export function imageSize(buf) {
  try {
    if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) return { ...readPNGSize(buf), type: 'png' };
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ...readJPEGSize(buf), type: 'jpeg' };
    if (buf.length >= 10 && buf.toString('latin1', 0, 4) === 'GIF8') return { ...readGIFSize(buf), type: 'gif' };
    if (buf.length >= 30 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return { ...readWebPSize(buf), type: 'webp' };
  } catch {
    // fall through: unreadable header
  }
  return { width: null, height: null, type: null };
}
