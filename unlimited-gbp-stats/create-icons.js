/**
 * Creates icon16.png, icon48.png, icon128.png in the icons/ folder.
 * Uses only Node.js built-ins (no npm required).
 * Run: node create-icons.js
 */

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, 'icons');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT);

// ── Minimal PNG encoder ──────────────────────────────────────────────────────
function encodePNG(width, height, getRGBA) {
  // RGBA pixel data
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(width * 4);
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = getRGBA(x, y, width, height);
      row[x * 4]     = r;
      row[x * 4 + 1] = g;
      row[x * 4 + 2] = b;
      row[x * 4 + 3] = a;
    }
    rows.push(row);
  }

  // Filter type 0 (None) for each row
  const rawRows = rows.map(r => Buffer.concat([Buffer.from([0]), r]));
  const raw = Buffer.concat(rawRows);
  const deflated = zlib.deflateSync(raw);

  function crc32(buf) {
    const table = (() => {
      const t = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        t[i] = c;
      }
      return t;
    })();
    let c = 0xFFFFFFFF;
    for (const b of buf) c = table[(c ^ b) & 0xFF] ^ (c >>> 8);
    return ((c ^ 0xFFFFFFFF) >>> 0);
  }

  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const typeB = Buffer.from(type);
    const crcB = Buffer.alloc(4);
    crcB.writeUInt32BE(crc32(Buffer.concat([typeB, data])));
    return Buffer.concat([len, typeB, data, crcB]);
  }

  const sig   = Buffer.from([137,80,78,71,13,10,26,10]);
  const ihdr  = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // bit depth 8, RGBA
  const idat  = deflated;
  const iend  = Buffer.alloc(0);

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', iend)
  ]);
}

// ── Icon pixel renderer ──────────────────────────────────────────────────────
function drawIcon(x, y, w, h) {
  const f = w / 128;
  const r = (x / w) * 128, c_y = (y / h) * 128;

  // Background: dark navy
  const BG = [26, 26, 46];

  // Rounded rect mask (r=16 in 128px space)
  const rx = 16, ry = 16;
  const inRect = (
    r >= rx && r <= 128 - rx && c_y >= 0 && c_y <= 128 ||
    r >= 0  && r <= 128      && c_y >= ry && c_y <= 128 - ry ||
    // corners
    (r < rx && c_y < ry && Math.hypot(r - rx, c_y - ry) <= rx) ||
    (r > 128 - rx && c_y < ry && Math.hypot(r - (128 - rx), c_y - ry) <= rx) ||
    (r < rx && c_y > 128 - ry && Math.hypot(r - rx, c_y - (128 - ry)) <= rx) ||
    (r > 128 - rx && c_y > 128 - ry && Math.hypot(r - (128 - rx), c_y - (128 - ry)) <= rx)
  );
  if (!inRect) return [0, 0, 0, 0]; // transparent outside

  // Chart line: polyline 20,90 → 40,70 → 55,80 → 75,40 → 95,55 → 110,30
  const segments = [
    [20, 90, 40, 70],
    [40, 70, 55, 80],
    [55, 80, 75, 40],
    [75, 40, 95, 55],
    [95, 55, 110, 30],
  ];

  const lineW = Math.max(1.5, 5 * f);
  function distToSeg(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const t = Math.max(0, Math.min(1, ((px-x1)*dx + (py-y1)*dy) / (dx*dx+dy*dy)));
    return Math.hypot(px - (x1 + t*dx), py - (y1 + t*dy));
  }

  let onLine = false;
  for (const [x1,y1,x2,y2] of segments) {
    if (distToSeg(r, c_y, x1, y1, x2, y2) < lineW) { onLine = true; break; }
  }
  if (onLine) return [138, 180, 248, 255]; // #8ab4f8

  // Dots at key points
  const dots = [[75,40],[110,30]];
  for (const [dx,dy] of dots) {
    if (Math.hypot(r - dx, c_y - dy) < Math.max(3, 4 * f)) return [138, 180, 248, 255];
  }

  return [...BG, 255];
}

// ── Generate sizes ──────────────────────────────────────────────────────────
for (const size of [16, 48, 128]) {
  const png = encodePNG(size, size, (x, y, w, h) => drawIcon(x, y, w, h));
  const outPath = path.join(OUT, `icon${size}.png`);
  fs.writeFileSync(outPath, png);
  console.log(`Created: ${outPath} (${png.length} bytes)`);
}

console.log('\nAll icons created successfully!');
