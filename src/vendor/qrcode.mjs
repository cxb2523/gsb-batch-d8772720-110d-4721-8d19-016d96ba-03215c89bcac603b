// 最小的二维码编码器，只做一件事：把一段文本（我们的游戏跳转链接）画成 SVG。
//
// 只实现字节模式 + 纠错等级 M + 版本 1..15 自动选择，够 132 字节的链接用（落在版本 8）。
// 算法照 ISO/IEC 18004 走，关键步骤都标了出处里的标准名，方便对照。
// 不引第三方依赖：项目其它地方也没有，多一个包就多一份要维护的东西。

// 版本 -> [每块纠错码字数, [块数, 每块数据码字数], ...]
const BLOCKS = {
  1: [10, [1, 16]],
  2: [16, [1, 28]],
  3: [26, [1, 44]],
  4: [18, [2, 32]],
  5: [24, [2, 43]],
  6: [16, [4, 27]],
  7: [18, [4, 31]],
  8: [22, [2, 38], [2, 39]],
  9: [22, [3, 36], [2, 37]],
  10: [26, [4, 43], [1, 44]],
  11: [30, [1, 50], [4, 51]],
  12: [22, [6, 36], [2, 37]],
  13: [22, [8, 37], [1, 38]],
  14: [24, [4, 40], [5, 41]],
  15: [24, [5, 41], [5, 42]],
};

const ALIGN = {
  2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  11: [6, 30, 54], 12: [6, 32, 58], 13: [6, 34, 62],
  14: [6, 26, 46, 66], 15: [6, 26, 48, 70],
};

// GF(256)，本原多项式 0x11D
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
}
const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

// g(x) = (x-α^0)(x-α^1)...(x-α^{n-1})，系数按降幂排列
function generator(n) {
  let g = [1];
  for (let i = 0; i < n; i += 1) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j += 1) {
      next[j] ^= g[j];
      next[j + 1] ^= gfMul(g[j], EXP[i]);
    }
    g = next;
  }
  return g;
}

function eccBytes(data, ecLen) {
  const gen = generator(ecLen);
  const work = new Uint8Array(data.length + ecLen);
  work.set(data);
  for (let i = 0; i < data.length; i += 1) {
    const coef = work[i];
    if (coef === 0) continue;
    for (let j = 0; j < gen.length; j += 1) work[i + j] ^= gfMul(gen[j], coef);
  }
  return work.subarray(data.length);
}

function dataCodewords(version) {
  const [, ...groups] = BLOCKS[version];
  return groups.reduce((sum, [count, len]) => sum + count * len, 0);
}

function blockPlan(version) {
  const [ecLen, ...groups] = BLOCKS[version];
  const blocks = [];
  for (const [count, len] of groups) for (let i = 0; i < count; i += 1) blocks.push(len);
  return { ecLen, blocks };
}

function pickVersion(length) {
  for (const version of Object.keys(BLOCKS).map(Number)) {
    const countBits = version <= 9 ? 8 : 16;
    if (4 + countBits + 8 * length <= dataCodewords(version) * 8) return version;
  }
  throw new Error(`文本太长，${length} 字节超出了版本 15 的容量`);
}

// 比特流：模式指示符 0100 + 字符计数 + 数据 + 终止符 + 补齐到字节 + 填充字节
function buildCodewords(bytes, version) {
  const countBits = version <= 9 ? 8 : 16;
  const capacity = dataCodewords(version) * 8;
  const bits = [];
  const push = (value, count) => {
    for (let i = count - 1; i >= 0; i -= 1) bits.push((value >> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, countBits);
  for (const byte of bytes) push(byte, 8);
  for (let i = 0; i < 4 && bits.length < capacity; i += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j];
    out.push(byte);
  }
  for (let pad = 0xec; out.length < capacity / 8; pad = pad === 0xec ? 0x11 : 0xec) out.push(pad);
  return out;
}

// 按块算纠错码再交错：先逐列取各块的数据码字，再逐列取各块的纠错码字
function interleave(codewords, version) {
  const { ecLen, blocks } = blockPlan(version);
  let at = 0;
  const parts = blocks.map((len) => {
    const data = codewords.slice(at, at + len);
    at += len;
    return { data, ecc: Array.from(eccBytes(Uint8Array.from(data), ecLen)) };
  });
  const out = [];
  const longest = Math.max(...blocks);
  for (let i = 0; i < longest; i += 1) {
    for (const part of parts) if (i < part.data.length) out.push(part.data[i]);
  }
  for (let i = 0; i < ecLen; i += 1) {
    for (const part of parts) out.push(part.ecc[i]);
  }
  return out;
}

// 15 位格式信息：5 位数据 + BCH(15,5)，再异或固定掩码
function formatBits(mask) {
  const data = 0b00 << 3 | mask; // 纠错等级 M = 00
  let bch = data << 10;
  for (let i = 14; i >= 10; i -= 1) if ((bch >> i) & 1) bch ^= 0x537 << (i - 10);
  return ((data << 10) | bch) ^ 0x5412;
}

// 18 位版本信息：6 位版本 + BCH(18,6)，版本 7 以上才有
function versionBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

const maskFn = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function buildMatrix(codewords, version) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (col, row, dark) => {
    modules[row][col] = dark;
    reserved[row][col] = true;
  };

  // 定位图形（9x9，含分隔带）：距离中心 0/1 为黑，2 为白，3 为黑，4 是分隔带
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const col = cx + dx;
        const row = cy + dy;
        if (col < 0 || col >= size || row < 0 || row >= size) continue;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        set(col, row, dist !== 2 && dist !== 4);
      }
    }
  };
  // 定时图形
  for (let i = 0; i < size; i += 1) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  // 校正图形：除与定位图形重叠的四个位置外都要放
  const centers = ALIGN[version] ?? [];
  for (const cy of centers) {
    for (const cx of centers) {
      const nearFinder = (cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6);
      if (nearFinder) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }
  // 格式信息与版本信息占位（先标记为功能区，稍后填真值）。第 6 行第 6 列是
  // 定时图形，不是格式信息，跳过。
  for (let i = 0; i <= 8; i += 1) {
    if (i === 6) continue;
    set(i, 8, false);
    set(8, i, false);
  }
  for (let i = 0; i < 8; i += 1) {
    set(size - 1 - i, 8, false);
    set(8, size - 1 - i, false);
  }
  if (version >= 7) {
    for (let i = 0; i < 18; i += 1) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, false);
      set(b, a, false);
    }
  }

  // 数据区：从右下角起，两列一组蛇形往上/往下填，跳过第 6 列（纵向定时图形）
  const bits = [];
  for (const byte of codewords) for (let i = 7; i >= 0; i -= 1) bits.push((byte >> i) & 1);
  let index = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const col = right - j;
        const upward = ((right + 1) & 2) === 0;
        const row = upward ? size - 1 - vert : vert;
        if (reserved[row][col] || index >= bits.length) continue;
        modules[row][col] = bits[index] === 1;
        index += 1;
      }
    }
  }
  return { size, modules, reserved };
}

// 掩码后按四条规则打分，分低的更像二维码
function penalty(modules, size) {
  let score = 0;
  const at = (x, y) => (x < 0 || y < 0 || x >= size || y >= size ? false : modules[y][x]);
  for (let y = 0; y < size; y += 1) {
    for (const horizontal of [true, false]) {
      let run = 1;
      for (let i = 1; i < size; i += 1) {
        const same = horizontal ? at(i, y) === at(i - 1, y) : at(y, i) === at(y, i - 1);
        if (same) run += 1;
        else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  }
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const color = at(x, y);
      if (color === at(x + 1, y) && color === at(x, y + 1) && color === at(x + 1, y + 1)) score += 3;
    }
  }
  // 定位图形本身（1011101）一边挨着 4 个浅色，看起来像多了一个定位图案，扣分
  const pattern = [true, false, true, true, true, false, true];
  const finderLike = (get) => {
    for (let i = 0; i + 7 <= size; i += 1) {
      let match = true;
      for (let j = 0; j < 7; j += 1) if (get(i + j) !== pattern[j]) { match = false; break; }
      if (!match) continue;
      const before = i >= 4;
      let light = before;
      for (let j = 1; j <= 4 && before; j += 1) if (get(i - j)) { light = false; break; }
      let after = i + 11 <= size;
      for (let j = 7; j < 11 && after; j += 1) if (get(i + j)) { after = false; break; }
      if (light || after) score += 40;
    }
  };
  for (let y = 0; y < size; y += 1) {
    finderLike((i) => at(i, y));
    finderLike((i) => at(y, i));
  }
  let dark = 0;
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) if (modules[y][x]) dark += 1;
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  return score + k * 10;
}

function drawFormat(modules, reserved, size, mask, version) {
  const set = (col, row, dark) => {
    modules[row][col] = dark;
    reserved[row][col] = true;
  };
  const bits = formatBits(mask);
  const bit = (i) => ((bits >> i) & 1) === 1;
  for (let i = 0; i <= 5; i += 1) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i += 1) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i += 1) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i += 1) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true); // 固定黑模块
  if (version >= 7) {
    const vbits = versionBits(version);
    for (let i = 0; i < 18; i += 1) {
      const dark = ((vbits >> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }
}

export function encodeMatrix(text) {
  const bytes = Array.from(Buffer.from(String(text), 'utf8'));
  const version = pickVersion(bytes.length);
  const codewords = interleave(buildCodewords(bytes, version), version);
  const base = buildMatrix(codewords, version);
  let best = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const modules = base.modules.map((row) => row.slice());
    for (let y = 0; y < base.size; y += 1) {
      for (let x = 0; x < base.size; x += 1) {
        if (!base.reserved[y][x] && maskFn[mask](x, y)) modules[y][x] = !modules[y][x];
      }
    }
    const reserved = base.reserved.map((row) => row.slice());
    drawFormat(modules, reserved, base.size, mask, version);
    const score = penalty(modules, base.size);
    if (!best || score < best.score) best = { version, mask, size: base.size, modules, score };
  }
  return best;
}

// 画成 SVG：静区留 4 个模块，深色模块合成一条 path，省得几百个 rect。
export function toSvg(matrix, { scale = 4, quiet = 4, light = '#fff', dark = '#000' } = {}) {
  const side = matrix.size + quiet * 2;
  const parts = [];
  for (let y = 0; y < matrix.size; y += 1) {
    for (let x = 0; x < matrix.size; x += 1) {
      if (matrix.modules[y][x]) parts.push(`M${x + quiet} ${y + quiet}h1v1h-1z`);
    }
  }
  const px = side * scale;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges">`
    + `<rect width="${side}" height="${side}" fill="${light}"/>`
    + `<path d="${parts.join('')}" fill="${dark}"/></svg>`;
}

export function qrSvg(text, options) {
  return toSvg(encodeMatrix(text), options);
}

if (process.argv[1] && process.argv[1].endsWith('qrcode.mjs') && process.argv[2]) {
  const matrix = encodeMatrix(process.argv[2]);
  console.log(`版本 ${matrix.version} 掩码 ${matrix.mask} 尺寸 ${matrix.size}x${matrix.size} 评分 ${matrix.score} 字节 ${Buffer.byteLength(process.argv[2])}`);
  for (let y = 0; y < matrix.size; y += 1) {
    console.log(matrix.modules[y].map((dark) => (dark ? '##' : '  ')).join(''));
  }
}
