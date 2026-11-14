// 单个图标的缩略图。整张图集 2048×2048、最大 5MB，手机上解码一张就占十几兆内存，
// 仓库页会同时用到十来张。这里按需裁出单个图标并缓存到磁盘，页面只下载几 KB。
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ART_DIR, atlasFile, iconIndex } from './art.mjs';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_SIDE = 128;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// 图集全部是 8 位 RGBA、非隔行；其他格式返回错误，由页面退回文字占位。
export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('不是 PNG 文件');
  let width = 0, height = 0;
  const parts = [];
  for (let at = 8; at < buffer.length;) {
    const size = buffer.readUInt32BE(at), type = buffer.toString('latin1', at + 4, at + 8), data = buffer.subarray(at + 8, at + 8 + size);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) throw new Error('只支持 8 位 RGBA 非隔行 PNG');
    } else if (type === 'IDAT') parts.push(data);
    else if (type === 'IEND') break;
    at += size + 12;
  }
  const raw = zlib.inflateSync(Buffer.concat(parts));
  const stride = width * 4, pixels = Buffer.allocUnsafe(stride * height);
  if (raw.length < (stride + 1) * height) throw new Error('PNG 数据不完整');
  for (let y = 0, from = 0, to = 0; y < height; y++) {
    const filter = raw[from++];
    if (filter > 4) throw new Error('PNG 滤波类型异常');
    for (let x = 0; x < stride; x++, from++, to++) {
      const left = x >= 4 ? pixels[to - 4] : 0;
      const up = y > 0 ? pixels[to - stride] : 0;
      const upLeft = x >= 4 && y > 0 ? pixels[to - stride - 4] : 0;
      const predicted = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : paeth(left, up, upLeft);
      pixels[to] = (raw[from] + predicted) & 0xff;
    }
  }
  return { width, height, pixels };
}

export function encodePng({ width, height, pixels }) {
  const stride = width * 4, raw = Buffer.allocUnsafe((stride + 1) * height);
  for (let y = 0, to = 0; y < height; y++) {
    raw[to++] = 1;
    for (let x = 0; x < stride; x++, to++) {
      const at = y * stride + x;
      raw[to] = (pixels[at] - (x >= 4 ? pixels[at - 4] : 0)) & 0xff;
    }
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]), size = Buffer.alloc(4), crc = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([size, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// 旋转打包的贴图在图集里占 h 宽、w 高，逆时针转 90 度摆正，和页面原先的 CSS 裁切结果一致。
export function cropIcon(atlas, { x, y, w, h, rotated }) {
  const pixels = Buffer.allocUnsafe(w * h * 4);
  for (let dy = 0, to = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++, to += 4) {
      const sx = rotated ? x + h - 1 - dy : x + dx, sy = rotated ? y + dx : y + dy;
      if (sx < 0 || sy < 0 || sx >= atlas.width || sy >= atlas.height) { pixels.fill(0, to, to + 4); continue; }
      atlas.pixels.copy(pixels, to, (sy * atlas.width + sx) * 4, (sy * atlas.width + sx) * 4 + 4);
    }
  }
  return { width: w, height: h, pixels };
}

// 按面积平均缩小。颜色先乘 alpha，透明边缘才不会泛黑。
export function shrink(image, maxSide = MAX_SIDE) {
  const { width, height, pixels } = image;
  const scale = maxSide / Math.max(width, height);
  if (scale >= 1) return image;
  const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
  const out = Buffer.allocUnsafe(w * h * 4);
  for (let dy = 0, to = 0; dy < h; dy++) {
    const y0 = Math.floor(dy * height / h), y1 = Math.max(y0 + 1, Math.floor((dy + 1) * height / h));
    for (let dx = 0; dx < w; dx++, to += 4) {
      const x0 = Math.floor(dx * width / w), x1 = Math.max(x0 + 1, Math.floor((dx + 1) * width / w));
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0, at = (sy * width + x0) * 4; sx < x1; sx++, at += 4) {
          const alpha = pixels[at + 3];
          r += pixels[at] * alpha;
          g += pixels[at + 1] * alpha;
          b += pixels[at + 2] * alpha;
          a += alpha;
        }
      }
      const count = (x1 - x0) * (y1 - y0);
      out[to] = a ? Math.round(r / a) : 0;
      out[to + 1] = a ? Math.round(g / a) : 0;
      out[to + 2] = a ? Math.round(b / a) : 0;
      out[to + 3] = Math.round(a / count);
    }
  }
  return { width: w, height: h, pixels: out };
}

const decoded = new Map();
function loadAtlas(file) {
  const hit = decoded.get(file);
  if (hit) return hit;
  const atlas = decodePng(fs.readFileSync(file));
  decoded.set(file, atlas);
  // 一张解码后约 16MB，只留最近两张。
  if (decoded.size > 2) decoded.delete(decoded.keys().next().value);
  return atlas;
}

const inFlight = new Map();
let queue = Promise.resolve();

// 解码在主线程进行：逐个处理并让出事件循环，避免首次打开仓库时连续占用，影响游戏连接。
function generate(icon, cacheFile) {
  const job = queue.then(() => new Promise(resolve => setImmediate(resolve))).then(() => {
    const atlasPath = atlasFile(icon.bundle, icon.page);
    if (!atlasPath) throw new Error('图集文件不存在');
    const png = encodePng(shrink(cropIcon(loadAtlas(atlasPath), icon)));
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, png);
    } catch { /* 缓存写入失败不影响本次显示 */ }
    return png;
  });
  queue = job.catch(() => {});
  return job;
}

// 查不到图标返回 null；名字只用于查索引，不参与拼接路径。
export async function iconThumb(name) {
  const icons = iconIndex().icons;
  const icon = Object.hasOwn(icons, name) ? icons[name] : null;
  if (!icon) return null;
  const key = createHash('sha1').update(JSON.stringify([name, icon.bundle, icon.page, icon.x, icon.y, icon.w, icon.h, icon.rotated, MAX_SIDE])).digest('hex').slice(0, 24);
  if (inFlight.has(key)) return inFlight.get(key);
  const cacheFile = path.join(ART_DIR, '.thumbs', key + '.png');
  try { return fs.readFileSync(cacheFile); } catch { /* 第一次用到这个图标 */ }
  const job = generate(icon, cacheFile).finally(() => inFlight.delete(key));
  inFlight.set(key, job);
  return job;
}
