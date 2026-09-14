// QR code generator, no dependencies.
// Byte mode, error correction level M, versions 1 to 10 (up to 216 data
// codewords, which covers any board URL by a wide margin). Enough for what the
// platform needs: a printable code that opens a company's board.
// Returns a module matrix, or an SVG string ready to serve or embed.

// ---- GF(256), primitive polynomial 0x11d ----------------------------------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

// generator polynomial for n error correction codewords, high order first
function genPoly(n) {
  let p = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(p.length + 1).fill(0);
    for (let j = 0; j < p.length; j++) { next[j] ^= p[j]; next[j + 1] ^= mul(p[j], EXP[i]); }
    p = next;
  }
  return p;
}

function eccFor(data, n) {
  const g = genPoly(n);
  const res = data.concat(new Array(n).fill(0));
  for (let i = 0; i < data.length; i++) {
    const f = res[i];
    if (f === 0) continue;
    for (let j = 0; j < g.length; j++) res[i + j] ^= mul(g[j], f);
  }
  return res.slice(data.length);
}

// ---- version tables, error correction level M ------------------------------
// [ec codewords per block, blocks in group 1, data codewords in group 1,
//  blocks in group 2, data codewords in group 2]
const VERSIONS = {
  1: [10, 1, 16, 0, 0], 2: [16, 1, 28, 0, 0], 3: [26, 1, 44, 0, 0],
  4: [18, 2, 32, 0, 0], 5: [24, 2, 43, 0, 0], 6: [16, 4, 27, 0, 0],
  7: [18, 4, 31, 0, 0], 8: [22, 2, 38, 2, 39], 9: [22, 3, 36, 2, 37],
  10: [26, 4, 43, 1, 44],
};
const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};
const dataCodewords = (v) => { const [, b1, d1, b2, d2] = VERSIONS[v]; return b1 * d1 + b2 * d2; };

function pickVersion(byteLen) {
  for (let v = 1; v <= 10; v++) {
    const countBits = v < 10 ? 8 : 16;
    if (dataCodewords(v) * 8 >= 4 + countBits + byteLen * 8) return v;
  }
  throw new Error("text too long for a version 10 QR code");
}

// ---- bit stream ------------------------------------------------------------
function codewords(bytes, version) {
  const bits = [];
  const push = (value, n) => { for (let i = n - 1; i >= 0; i--) bits.push((value >> i) & 1); };
  push(0b0100, 4);                              // byte mode
  push(bytes.length, version < 10 ? 8 : 16);    // character count
  for (const b of bytes) push(b, 8);
  const capacity = dataCodewords(version) * 8;
  for (let i = 0; i < 4 && bits.length < capacity; i++) bits.push(0);  // terminator
  while (bits.length % 8) bits.push(0);
  const words = [];
  for (let i = 0; i < bits.length; i += 8) words.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  const PAD = [0xec, 0x11];
  for (let i = 0; words.length < dataCodewords(version); i++) words.push(PAD[i % 2]);
  return words;
}

// data plus error correction, interleaved in the order the spec places them
function finalCodewords(bytes, version) {
  const [ecLen, b1, d1, b2, d2] = VERSIONS[version];
  const words = codewords(bytes, version);
  const blocks = [];
  let at = 0;
  for (let i = 0; i < b1; i++) { blocks.push(words.slice(at, at + d1)); at += d1; }
  for (let i = 0; i < b2; i++) { blocks.push(words.slice(at, at + d2)); at += d2; }
  const eccs = blocks.map((b) => eccFor(b, ecLen));
  const out = [];
  const maxData = Math.max(d1, d2);
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < ecLen; i++) for (const e of eccs) out.push(e[i]);
  return out;
}

// ---- matrix ----------------------------------------------------------------
function blank(size) {
  return { m: Array.from({ length: size }, () => new Array(size).fill(0)),
           r: Array.from({ length: size }, () => new Array(size).fill(false)) };
}

function placeFunctionPatterns(g, version, size) {
  const set = (row, col, v) => { g.m[row][col] = v; g.r[row][col] = true; };
  const finder = (row, col) => {
    for (let i = -1; i <= 7; i++) for (let j = -1; j <= 7; j++) {
      const rr = row + i, cc = col + j;
      if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
      const inner = i >= 0 && i <= 6 && j >= 0 && j <= 6 &&
        (i === 0 || i === 6 || j === 0 || j === 6 || (i >= 2 && i <= 4 && j >= 2 && j <= 4));
      set(rr, cc, inner ? 1 : 0);
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
  for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0 ? 1 : 0); set(i, 6, i % 2 === 0 ? 1 : 0); }
  const centers = ALIGN[version];
  for (const r of centers) for (const c of centers) {
    if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue;
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
      set(r + i, c + j, Math.max(Math.abs(i), Math.abs(j)) !== 1 ? 1 : 0);
    }
  }
  set(size - 8, 8, 1);                                        // always dark
  for (let i = 0; i < 9; i++) {                               // format info areas
    if (!g.r[8][i]) set(8, i, 0);
    if (!g.r[i][8]) set(i, 8, 0);
  }
  for (let i = 0; i < 8; i++) { if (!g.r[8][size - 1 - i]) set(8, size - 1 - i, 0); if (!g.r[size - 1 - i][8]) set(size - 1 - i, 8, 0); }
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = (bits >> i) & 1, row = Math.floor(i / 3), col = size - 11 + (i % 3);
      set(row, col, bit); set(col, row, bit);
    }
  }
}

function versionBits(version) {
  let rem = version << 12;
  for (let i = 5; i >= 0; i--) if (rem & (1 << (i + 12))) rem ^= 0x1f25 << i;
  return (version << 12) | (rem & 0xfff);
}

function formatBits(mask) {
  const data = (0b00 << 3) | mask;             // 00 = error correction level M
  let rem = data << 10;
  for (let i = 4; i >= 0; i--) if (rem & (1 << (i + 10))) rem ^= 0x537 << i;
  return ((data << 10) | (rem & 0x3ff)) ^ 0x5412;
}

function placeFormat(g, size, mask) {
  const bits = formatBits(mask);
  const bit = (i) => (bits >> i) & 1;
  for (let i = 0; i <= 5; i++) g.m[i][8] = bit(i);            // down the left of the top-left finder
  g.m[7][8] = bit(6); g.m[8][8] = bit(7); g.m[8][7] = bit(8);
  for (let i = 9; i <= 14; i++) g.m[8][14 - i] = bit(i);
  for (let i = 0; i <= 7; i++) g.m[8][size - 1 - i] = bit(i);  // along row 8 under the top-right finder
  for (let i = 8; i <= 14; i++) g.m[size - 15 + i][8] = bit(i);
  g.m[size - 8][8] = 1;
}

const MASKS = [
  (i, j) => (i + j) % 2 === 0,
  (i) => i % 2 === 0,
  (i, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => ((((i * j) % 2) + ((i * j) % 3)) % 2) === 0,
  (i, j) => ((((i + j) % 2) + ((i * j) % 3)) % 2) === 0,
];

function placeData(g, size, words, mask) {
  const bits = [];
  for (const w of words) for (let i = 7; i >= 0; i--) bits.push((w >> i) & 1);
  let at = 0, upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;                                // the timing column is skipped
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (g.r[row][col]) continue;
        let bit = at < bits.length ? bits[at++] : 0;
        if (MASKS[mask](row, col)) bit ^= 1;
        g.m[row][col] = bit;
      }
    }
    upward = !upward;
  }
}

function penalty(m, size) {
  let score = 0;
  const run = (get) => {
    for (let a = 0; a < size; a++) {
      let last = -1, len = 0;
      for (let b = 0; b < size; b++) {
        const v = get(a, b);
        if (v === last) { len++; if (len === 5) score += 3; else if (len > 5) score += 1; }
        else { last = v; len = 1; }
      }
    }
  };
  run((a, b) => m[a][b]); run((a, b) => m[b][a]);
  for (let i = 0; i < size - 1; i++) for (let j = 0; j < size - 1; j++) {
    const v = m[i][j];
    if (v === m[i][j + 1] && v === m[i + 1][j] && v === m[i + 1][j + 1]) score += 3;
  }
  const PAT = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const PAT2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const match = (get, a, b, pat) => pat.every((p, k) => get(a, b + k) === p);
  for (let a = 0; a < size; a++) for (let b = 0; b + 11 <= size; b++) {
    if (match((x, y) => m[x][y], a, b, PAT) || match((x, y) => m[x][y], a, b, PAT2)) score += 40;
    if (match((x, y) => m[y][x], a, b, PAT) || match((x, y) => m[y][x], a, b, PAT2)) score += 40;
  }
  let dark = 0;
  for (let i = 0; i < size; i++) for (let j = 0; j < size; j++) dark += m[i][j];
  score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
  return score;
}

// ---- public ----------------------------------------------------------------
// matrix(text) -> { size, modules } where modules[row][col] is 1 for dark
function matrix(text, forceMask) {
  const bytes = Array.from(Buffer.from(String(text), "utf8"));
  const version = pickVersion(bytes.length);
  const size = version * 4 + 17;
  const words = finalCodewords(bytes, version);
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    if (forceMask != null && mask !== forceMask) continue;
    const g = blank(size);
    placeFunctionPatterns(g, version, size);
    placeData(g, size, words, mask);
    placeFormat(g, size, mask);
    const p = penalty(g.m, size);
    if (!best || p < best.p) best = { p, m: g.m, mask };
  }
  return { size, modules: best.m, version, mask: best.mask, penalty: best.p };
}

// svg(text, { size, quiet, dark, light }) -> a square SVG string
function svg(text, opts = {}) {
  const { size: px = 240, quiet = 4, dark = "#1c242e", light = "#ffffff" } = opts;
  const { size, modules } = matrix(text);
  const total = size + quiet * 2;
  let path = "";
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
    if (modules[r][c]) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img" aria-label="QR code">` +
    `<rect width="${total}" height="${total}" fill="${light}"/><path d="${path}" fill="${dark}"/></svg>`;
}

module.exports = { matrix, svg };
