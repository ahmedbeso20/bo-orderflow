'use strict';
// مولّد QR Code قياسي (ISO/IEC 18004 — Byte Mode, ECC Level L, Versions 1..10) بدون أي مكتبات خارجية

// GF(256) with primitive polynomial 0x11d
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

function rsGeneratorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    const factor = EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], factor);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data, ecCount) {
  const gen = rsGeneratorPoly(ecCount);
  const rem = new Array(ecCount).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem.shift();
    rem.push(0);
    if (factor !== 0) {
      for (let i = 0; i < ecCount; i++) {
        rem[i] ^= gfMul(gen[i + 1], factor);
      }
    }
  }
  return rem;
}

// Level L specs for versions 1..10: [totalCodewords, ecPerBlock, numBlocks, alignPositions]
const VERSION_SPECS = [
  null,
  { total: 26, ec: 7, blocks: [[1, 19]], align: [] },
  { total: 44, ec: 10, blocks: [[1, 34]], align: [6, 18] },
  { total: 70, ec: 15, blocks: [[1, 55]], align: [6, 22] },
  { total: 100, ec: 20, blocks: [[1, 80]], align: [6, 26] },
  { total: 134, ec: 26, blocks: [[1, 108]], align: [6, 30] },
  { total: 172, ec: 18, blocks: [[2, 68]], align: [6, 34] },
  { total: 196, ec: 20, blocks: [[2, 78]], align: [6, 22, 38] },
  { total: 242, ec: 24, blocks: [[2, 97]], align: [6, 24, 42] },
  { total: 292, ec: 30, blocks: [[2, 116]], align: [6, 26, 46] },
  { total: 346, ec: 18, blocks: [[2, 68], [2, 69]], align: [6, 28, 50] }
];

// Format info bits for ECC Level L (01) and mask 0..7 (precomputed BCH + XOR 0x5412)
const FORMAT_BITS_L = [0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976];
// Version info bits for versions 7..10
const VERSION_BITS = { 7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3 };

function chooseVersion(byteLen) {
  for (let v = 1; v <= 10; v++) {
    const spec = VERSION_SPECS[v];
    const dataCw = spec.blocks.reduce((s, [cnt, len]) => s + cnt * len, 0);
    const headerBits = 4 + (v <= 9 ? 8 : 16);
    const maxBytes = Math.floor((dataCw * 8 - headerBits) / 8);
    if (byteLen <= maxBytes) return v;
  }
  return 10;
}

function encodeData(bytes, version) {
  const spec = VERSION_SPECS[version];
  const dataCw = spec.blocks.reduce((s, [cnt, len]) => s + cnt * len, 0);
  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  pushBits(0b0100, 4); // Byte mode
  const countBits = version <= 9 ? 8 : 16;
  const maxBytes = Math.floor((dataCw * 8 - 4 - countBits) / 8);
  const sliced = bytes.subarray(0, maxBytes);
  pushBits(sliced.length, countBits);
  for (const b of sliced) pushBits(b, 8);
  const term = Math.min(4, dataCw * 8 - bits.length);
  for (let i = 0; i < term; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  const cw = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    cw.push(b);
  }
  let pad = 0;
  while (cw.length < dataCw) cw.push(pad++ % 2 === 0 ? 0xec : 0x11);

  // Split into RS blocks & interleave
  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (const [count, len] of spec.blocks) {
    for (let i = 0; i < count; i++) {
      const blk = cw.slice(offset, offset + len);
      offset += len;
      dataBlocks.push(blk);
      ecBlocks.push(rsRemainder(blk, spec.ec));
    }
  }
  const out = [];
  const maxDataLen = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxDataLen; i++) {
    for (const b of dataBlocks) if (i < b.length) out.push(b[i]);
  }
  for (let i = 0; i < spec.ec; i++) {
    for (const b of ecBlocks) out.push(b[i]);
  }
  return out;
}

function buildMatrix(text) {
  const bytes = Buffer.from(String(text || ''), 'utf8');
  const version = chooseVersion(bytes.length);
  const size = version * 4 + 17;
  const spec = VERSION_SPECS[version];
  const mat = Array.from({ length: size }, () => new Int8Array(size));
  const reserved = Array.from({ length: size }, () => new Uint8Array(size));

  const setMod = (r, c, val) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    mat[r][c] = val ? 1 : 0;
    reserved[r][c] = 1;
  };

  const drawFinder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r;
        const cc = c0 + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const dark = inside && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        setMod(rr, cc, dark ? 1 : 0);
      }
    }
  };

  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Alignment patterns
  const pos = spec.align;
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < pos.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) continue;
      const r0 = pos[i];
      const c0 = pos[j];
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          setMod(r0 + dr, c0 + dc, dark ? 1 : 0);
        }
      }
    }
  }

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    if (!reserved[6][i]) setMod(6, i, i % 2 === 0 ? 1 : 0);
    if (!reserved[i][6]) setMod(i, 6, i % 2 === 0 ? 1 : 0);
  }

  // Dark module & reserve format info areas
  setMod(size - 8, 8, 1);
  for (let i = 0; i < 9; i++) {
    if (!reserved[8][i]) reserved[8][i] = 1;
    if (!reserved[i][8]) reserved[i][8] = 1;
  }
  for (let i = 0; i < 8; i++) {
    reserved[8][size - 1 - i] = 1;
    reserved[size - 1 - i][8] = 1;
  }
  if (version >= 7) {
    const vBits = VERSION_BITS[version];
    for (let i = 0; i < 18; i++) {
      const bit = (vBits >>> i) & 1;
      const r = Math.floor(i / 3);
      const c = size - 11 + (i % 3);
      setMod(r, c, bit);
      setMod(c, r, bit);
    }
  }

  // Place data bits in zigzag
  const codewords = encodeData(bytes, version);
  const allBits = [];
  for (const cw of codewords) {
    for (let i = 7; i >= 0; i--) allBits.push((cw >>> i) & 1);
  }

  let bitIdx = 0;
  let upward = true;
  for (let col = size - 1; col >= 1; col -= 2) {
    if (col === 6) col--;
    for (let step = 0; step < size; step++) {
      const r = upward ? size - 1 - step : step;
      for (const dc of [0, -1]) {
        const c = col + dc;
        if (!reserved[r][c]) {
          mat[r][c] = bitIdx < allBits.length ? allBits[bitIdx++] : 0;
        }
      }
    }
    upward = !upward;
  }

  // Apply mask 0 ((r + c) % 2 === 0) and write format info
  const mask = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!reserved[r][c] && (r + c) % 2 === 0) mat[r][c] ^= 1;
    }
  }

  const fmt = FORMAT_BITS_L[mask];
  for (let i = 0; i < 15; i++) {
    const bit = (fmt >>> i) & 1;
    // Vertical around top-left & bottom-left
    if (i < 6) mat[i][8] = bit;
    else if (i < 8) mat[i + 1][8] = bit;
    else mat[size - 15 + i][8] = bit;
    // Horizontal around top-right & top-left
    if (i < 8) mat[8][size - 1 - i] = bit;
    else if (i < 9) mat[8][15 - i] = bit;
    else mat[8][14 - i] = bit;
  }

  return { size, mat };
}

function generateQrSvg(text, { pixelSize = 180, margin = 4, darkColor = '#091736', lightColor = '#ffffff' } = {}) {
  const { size, mat } = buildMatrix(text);
  const total = size + margin * 2;
  let paths = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (mat[r][c]) {
        paths += `M${c + margin},${r + margin}h1v1h-1z`;
      }
    }
  }
  return `<svg width="${pixelSize}" height="${pixelSize}" viewBox="0 0 ${total} ${total}" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges" role="img" aria-label="QR Code"><rect width="${total}" height="${total}" fill="${lightColor}"/><path d="${paths}" fill="${darkColor}"/></svg>`;
}

module.exports = { buildMatrix, generateQrSvg };
