/**
 * axuse — baseline JPEG encoder (Linux desktop driver screenshots).
 *
 * The Windows driver gets JPEG from GDI+ and macOS from sips; Node ships no
 * image encoder, so this is a compact baseline-sequential encoder written
 * against the JPEG spec: standard Annex K quantization tables scaled by the
 * IJG quality curve, standard Huffman tables, 4:2:0 chroma subsampling,
 * BT.601 full-range RGB→YCbCr. Plain Buffer math, zero dependencies.
 */

import {
  STD_LUM_Q,
  STD_CHROMA_Q,
  ZIGZAG,
  DC_LUM_LENGTHS,
  DC_LUM_SYMBOLS,
  DC_CHROMA_LENGTHS,
  DC_CHROMA_SYMBOLS,
  AC_LUM_LENGTHS,
  AC_LUM_SYMBOLS,
  AC_CHROMA_LENGTHS,
  AC_CHROMA_SYMBOLS,
} from "./jpeg-tables.js";

/** IJG quality scaling for the quantization tables (quality 1-100). */
function scaledQuantTable(std, quality) {
  const q = Math.max(1, Math.min(100, Math.round(quality)));
  const scale = q < 50 ? Math.floor(5000 / q) : 200 - q * 2;
  return std.map((v) => Math.max(1, Math.min(255, Math.floor((v * scale + 50) / 100))));
}

/** symbol → {code, length} from a [lengths, symbols] table. */
function buildHuffmanCodes(lengths, symbols) {
  const total = lengths.reduce((a, b) => a + b, 0);
  if (total !== symbols.length) {
    throw new Error(`Huffman table mismatch: lengths sum ${total} ≠ ${symbols.length} symbols`);
  }
  const codes = new Map();
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < lengths[len - 1]; i++) {
      codes.set(symbols[k], { code, length: len });
      code++;
      k++;
    }
    code <<= 1;
  }
  return codes;
}

function dhtSegment(tableClass, tableId, lengths, symbols) {
  const body = Buffer.alloc(1 + 16 + symbols.length);
  body.writeUInt8((tableClass << 4) | tableId, 0);
  for (let i = 0; i < 16; i++) body.writeUInt8(lengths[i], 1 + i);
  Buffer.from(symbols).copy(body, 17);
  return Buffer.concat([Buffer.from([0xff, 0xc4, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body]);
}

class BitWriter {
  constructor() {
    this.buf = Buffer.alloc(256 * 1024);
    this.len = 0;
    this.bitBuf = 0;
    this.bitCount = 0;
  }
  ensure(n) {
    if (this.len + n + 2 > this.buf.length) {
      let size = this.buf.length * 2;
      while (size < this.len + n + 2) size *= 2;
      const next = Buffer.alloc(size);
      this.buf.copy(next, 0, 0, this.len);
      this.buf = next;
    }
  }
  writeBits(value, length) {
    if (length <= 0) return;
    this.bitBuf = (this.bitBuf << length) | (value & ((1 << length) - 1));
    this.bitCount += length;
    while (this.bitCount >= 8) {
      this.bitCount -= 8;
      const byte = (this.bitBuf >>> this.bitCount) & 0xff;
      this.ensure(2);
      this.buf[this.len++] = byte;
      if (byte === 0xff) this.buf[this.len++] = 0; // byte stuffing
    }
    this.bitBuf &= (1 << this.bitCount) - 1;
  }
  /** Pad the final byte with 1-bits (JPEG spec) and return the bytes. */
  flush() {
    if (this.bitCount > 0) {
      const padBits = 8 - this.bitCount;
      this.writeBits((1 << padBits) - 1, padBits);
    }
    return this.buf.subarray(0, this.len);
  }
}

const COS = (() => {
  const t = new Float64Array(8 * 8);
  for (let u = 0; u < 8; u++) {
    for (let x = 0; x < 8; x++) t[u * 8 + x] = Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  }
  return t;
})();

/** Separable forward DCT; input/output in natural (row-major) order. */
function fdct(block) {
  const tmp = new Float64Array(64);
  const out = new Float64Array(64);
  for (let u = 0; u < 8; u++) {
    const cu = u === 0 ? Math.SQRT1_2 / 2 : 0.5;
    for (let x = 0; x < 8; x++) {
      let s = 0;
      for (let y = 0; y < 8; y++) s += block[y * 8 + x] * COS[u * 8 + y];
      tmp[u * 8 + x] = s * cu;
    }
  }
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      const cv = v === 0 ? Math.SQRT1_2 / 2 : 0.5;
      let s = 0;
      for (let x = 0; x < 8; x++) s += tmp[u * 8 + x] * COS[v * 8 + x];
      out[u * 8 + v] = s * cv;
    }
  }
  return out;
}

/** Bit size category of a DC/AC value (JPEG additional-bits convention). */
function category(value) {
  let v = Math.abs(value);
  let n = 0;
  while (v) { n++; v >>= 1; }
  return n;
}

/** Encode one 8x8 block; returns the new DC predictor. Quant table is in
 *  NATURAL order, as are the DCT coefficients; the RLE walks zigzag. */
function encodeBlock(coeffs, quant, dcCodes, acCodes, w, lastDC) {
  let dc = 0;
  {
    let v = coeffs[0] / quant[0];
    dc = v > 0 ? Math.round(v) : -Math.round(-v);
  }
  const diff = dc - lastDC;
  const cat = category(diff);
  const dcH = dcCodes.get(cat);
  if (!dcH) throw new Error(`no DC code for category ${cat}`);
  w.writeBits(dcH.code, dcH.length);
  if (cat > 0) {
    const bits = diff < 0 ? diff + (1 << cat) - 1 : diff;
    w.writeBits(bits, cat);
  }
  // Quantize in natural order, then RLE in zigzag order.
  const q = new Map();
  let lastNonZeroZ = 0;
  for (let i = 1; i < 64; i++) {
    const z = ZIGZAG[i];
    let v = coeffs[z] / quant[z];
    v = v > 0 ? Math.round(v) : -Math.round(-v);
    if (v !== 0) {
      q.set(i, v);
      lastNonZeroZ = i;
    }
  }
  let run = 0;
  for (let i = 1; i <= lastNonZeroZ; i++) {
    const v = q.get(i) ?? 0;
    if (v === 0) { run++; continue; }
    while (run > 15) {
      const zrl = acCodes.get(0xf0);
      w.writeBits(zrl.code, zrl.length);
      run -= 16;
    }
    const vcat = category(v);
    const sym = (run << 4) | vcat;
    const ac = acCodes.get(sym);
    if (!ac) throw new Error(`missing AC Huffman code for symbol 0x${sym.toString(16)}`);
    w.writeBits(ac.code, ac.length);
    const bits = v < 0 ? v + (1 << vcat) - 1 : v;
    w.writeBits(bits, vcat);
    run = 0;
  }
  if (lastNonZeroZ < 63) {
    const eob = acCodes.get(0x00);
    w.writeBits(eob.code, eob.length);
  }
  return dc;
}

function segment(markerByte, body) {
  return Buffer.concat([Buffer.from([0xff, markerByte, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body]);
}

/**
 * Encode interleaved RGB rows as baseline JPEG (4:2:0, JFIF).
 * @param {Uint8Array|Buffer} rgb
 * @param {number} width
 * @param {number} height
 * @param {number} [stride] bytes per row (default width*3)
 * @param {number} [quality] 1-100
 * @returns {Buffer}
 */
export function encodeJPEG(rgb, width, height, stride = width * 3, quality = 80) {
  const lumQuant = scaledQuantTable(STD_LUM_Q, quality);
  const chromaQuant = scaledQuantTable(STD_CHROMA_Q, quality);
  const dcLumCodes = buildHuffmanCodes(DC_LUM_LENGTHS, DC_LUM_SYMBOLS);
  const acLumCodes = buildHuffmanCodes(AC_LUM_LENGTHS, AC_LUM_SYMBOLS);
  const dcChromaCodes = buildHuffmanCodes(DC_CHROMA_LENGTHS, DC_CHROMA_SYMBOLS);
  const acChromaCodes = buildHuffmanCodes(AC_CHROMA_LENGTHS, AC_CHROMA_SYMBOLS);

  const mcusX = Math.ceil(width / 16);
  const mcusY = Math.ceil(height / 16);
  const yW = mcusX * 16, yH = mcusY * 16;
  const cW = mcusX * 8, cH = mcusY * 8;
  const yPlane = new Float64Array(yW * yH);
  const cbAccum = new Float64Array(cW * cH);
  const crAccum = new Float64Array(cW * cH);
  const chromaCount = new Uint16Array(cW * cH);

  // RGB → YCbCr (BT.601 full range); chroma box-averaged 2x2.
  for (let row = 0; row < height; row++) {
    const src = row * stride;
    const yRow = row * yW;
    const cRow = (row >> 1) * cW;
    for (let col = 0; col < width; col++) {
      const o = src + col * 3;
      const r = rgb[o], g = rgb[o + 1], b = rgb[o + 2];
      yPlane[yRow + col] = 0.299 * r + 0.587 * g + 0.114 * b;
      const co = cRow + (col >> 1);
      cbAccum[co] += 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
      crAccum[co] += 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
      chromaCount[co]++;
    }
  }
  const cbPlane = new Float64Array(cW * cH);
  const crPlane = new Float64Array(cW * cH);
  for (let i = 0; i < cbAccum.length; i++) {
    const n = Math.max(1, chromaCount[i]);
    cbPlane[i] = cbAccum[i] / n;
    crPlane[i] = crAccum[i] / n;
  }

  const w = new BitWriter();
  let lastY = 0, lastCB = 0, lastCR = 0;
  const block = new Float64Array(64);

  function encodePlaneBlock(plane, planeW, bx, by, quant, dcCodes, acCodes, lastDC) {
    const baseY = by * 8;
    const baseX = bx * 8;
    for (let y = 0; y < 8; y++) {
      const src = (baseY + y) * planeW + baseX;
      for (let x = 0; x < 8; x++) block[y * 8 + x] = plane[src + x] - 128;
    }
    return encodeBlock(fdct(block), quant, dcCodes, acCodes, w, lastDC);
  }

  for (let my = 0; my < mcusY; my++) {
    for (let mx = 0; mx < mcusX; mx++) {
      for (let i = 0; i < 4; i++) {
        lastY = encodePlaneBlock(yPlane, yW, mx * 2 + (i % 2), my * 2 + (i >> 1), lumQuant, dcLumCodes, acLumCodes, lastY);
      }
      lastCB = encodePlaneBlock(cbPlane, cW, mx, my, chromaQuant, dcChromaCodes, acChromaCodes, lastCB);
      lastCR = encodePlaneBlock(crPlane, cW, mx, my, chromaQuant, dcChromaCodes, acChromaCodes, lastCR);
    }
  }
  const scan = w.flush();

  const app0 = segment(0xe0, Buffer.from([0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0, 1, 0, 1, 0, 0]));
  // DQT payloads carry values in ZIGZAG order (the tables here are natural).
  const zig = (table) => Buffer.from(ZIGZAG.map((z) => table[z]));
  const dqt = Buffer.concat([
    segment(0xdb, Buffer.concat([Buffer.from([0x00]), zig(lumQuant)])),
    segment(0xdb, Buffer.concat([Buffer.from([0x01]), zig(chromaQuant)])),
  ]);
  const sof0Body = Buffer.alloc(15); // 1+2+2+1 + 3×3-byte component entries
  sof0Body.writeUInt8(8, 0);
  sof0Body.writeUInt16BE(height, 1);
  sof0Body.writeUInt16BE(width, 3);
  sof0Body.writeUInt8(3, 5);
  sof0Body.writeUInt8(1, 6); sof0Body.writeUInt8(0x22, 7); sof0Body.writeUInt8(0, 8);
  sof0Body.writeUInt8(2, 9); sof0Body.writeUInt8(0x11, 10); sof0Body.writeUInt8(1, 11);
  sof0Body.writeUInt8(3, 12); sof0Body.writeUInt8(0x11, 13); sof0Body.writeUInt8(1, 14);
  const sof0 = segment(0xc0, sof0Body);
  const dht = Buffer.concat([
    dhtSegment(0, 0, DC_LUM_LENGTHS, DC_LUM_SYMBOLS),
    dhtSegment(1, 0, AC_LUM_LENGTHS, AC_LUM_SYMBOLS),
    dhtSegment(0, 1, DC_CHROMA_LENGTHS, DC_CHROMA_SYMBOLS),
    dhtSegment(1, 1, AC_CHROMA_LENGTHS, AC_CHROMA_SYMBOLS),
  ]);
  const sosBody = Buffer.alloc(10);
  sosBody.writeUInt8(3, 0);
  sosBody.writeUInt8(1, 1); sosBody.writeUInt8(0x00, 2);
  sosBody.writeUInt8(2, 3); sosBody.writeUInt8(0x11, 4);
  sosBody.writeUInt8(3, 5); sosBody.writeUInt8(0x11, 6);
  sosBody.writeUInt8(0, 7); sosBody.writeUInt8(63, 8); sosBody.writeUInt8(0, 9);
  const sos = segment(0xda, sosBody);

  return Buffer.concat([
    Buffer.from([0xff, 0xd8]), app0, dqt, sof0, dht, sos, scan, Buffer.from([0xff, 0xd9]),
  ]);
}
