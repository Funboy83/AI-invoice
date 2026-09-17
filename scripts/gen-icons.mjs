// Generates simple solid-color placeholder PWA icons (no external deps).
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

// Draws a rounded square icon with a simple "IA" monogram using blocky pixels.
function makeIcon(size, bg, fg) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const r = parseInt(bg.slice(1, 3), 16);
  const g = parseInt(bg.slice(3, 5), 16);
  const b = parseInt(bg.slice(5, 7), 16);
  const fr = parseInt(fg.slice(1, 3), 16);
  const fg_ = parseInt(fg.slice(3, 5), 16);
  const fb = parseInt(fg.slice(5, 7), 16);

  const margin = Math.round(size * 0.18);
  const barW = Math.max(2, Math.round(size * 0.1));

  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter byte
    for (let x = 0; x < size; x++) {
      const idx = rowStart + 1 + x * 4;
      let isFg = false;
      // Simple monogram: an "A"-like triangle + dot, made of blocks.
      const cx = x - size / 2;
      const withinBounds = x > margin && x < size - margin && y > margin && y < size - margin;
      if (withinBounds) {
        // left/right diagonal strokes forming an A shape
        const t = (y - margin) / (size - 2 * margin);
        const halfWidth = ((size - 2 * margin) / 2) * (1 - t) * 0.9 + barW * 0.3;
        if (Math.abs(cx) < halfWidth + barW / 2 && Math.abs(cx) > halfWidth - barW) isFg = true;
        // crossbar
        if (t > 0.55 && t < 0.68 && Math.abs(cx) < halfWidth + barW / 2) isFg = true;
      }
      if (isFg) {
        raw[idx] = fr;
        raw[idx + 1] = fg_;
        raw[idx + 2] = fb;
        raw[idx + 3] = 255;
      } else {
        raw[idx] = r;
        raw[idx + 1] = g;
        raw[idx + 2] = b;
        raw[idx + 3] = 255;
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = deflateSync(raw);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync("public/icons", { recursive: true });
const bg = "#4f46e5";
const fg = "#ffffff";
for (const size of [192, 512, 180, 32]) {
  const png = makeIcon(size, bg, fg);
  const name = size === 180 ? "public/icons/apple-touch-icon.png" : `public/icons/icon-${size}.png`;
  writeFileSync(name, png);
  console.log("wrote", name);
}
