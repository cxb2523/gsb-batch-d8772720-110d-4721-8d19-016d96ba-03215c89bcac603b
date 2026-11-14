// FairyGUI 包解析：把 UI bundle 里那个 FGUI 二进制的矩形表读出来。
//
// 格式不是猜的，是从游戏自己的 FairyGUI 实现里逐行抄的
// （work/extracted/_subpackages_main_/subpackages/main/game.js 里的 UIPackage.loadPackage）：
//   magic uint32 = 1179080009 ("FGUI")
//   version int32 -> v2 = version >= 2
//   bool, string id, string name, skip(20)
//   索引表起点 l，之后所有区块都用 seek(l, k) 跳过去
//     0 = 依赖  1 = 物品  2 = 图集矩形  3 = 点击测试  4 = 字符串表  5 = 字符串表补充
//   物品: int32 结束位置(相对) / uint8 类型 / S id / S 名字 / S 丢弃 / S file / bool / int32 宽 / int32 高 / 按类型附加
//   图集矩形: int16 结束位置(相对) / S 键 / S 物品 id / int32 x,y,w,h / bool 旋转 / [v2] bool / 可选偏移与原始尺寸
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const MAGIC = 1179080009;
export const ITEM_TYPE = { IMAGE: 0, MOVIE_CLIP: 1, SOUND: 2, COMPONENT: 3, ATLAS: 4, FONT: 5, SWF: 6, MISC: 7, UNKNOWN: 8, SPINE: 9, DRAGON_BONES: 10 };

class ByteBuffer {
  constructor(bytes) {
    this.buf = bytes;
    this.pos = 0;
    this.stringTable = [];
  }

  skip(n) {
    this.pos += n;
  }

  readByte() {
    return this.buf[this.pos++];
  }

  readUshort() {
    const value = this.buf.readUInt16BE(this.pos);
    this.pos += 2;
    return value;
  }

  readShort() {
    const value = this.buf.readInt16BE(this.pos);
    this.pos += 2;
    return value;
  }

  readUint() {
    const value = this.buf.readUInt32BE(this.pos);
    this.pos += 4;
    return value;
  }

  readInt() {
    const value = this.buf.readInt32BE(this.pos);
    this.pos += 4;
    return value;
  }

  readFloat() {
    const value = this.buf.readFloatBE(this.pos);
    this.pos += 4;
    return value;
  }

  readBool() {
    return this.readByte() === 1;
  }

  readString(len) {
    const size = len === undefined ? this.readUshort() : len;
    const text = this.buf.toString('utf8', this.pos, this.pos + size);
    this.pos += size;
    return text;
  }

  // FairyGUI 的内联字符串：前两字节是字符串表下标，65534/65533 是两个特殊值。
  readS() {
    const index = this.readUshort();
    if (index === 65534) return null;
    if (index === 65533) return '';
    return this.stringTable[index];
  }

  // 复刻 ByteBuffer.seek：位置表放在 offset 处，先字节数、再一字节宽度标志（1=uint16，其余=uint32）。
  seek(offset, index) {
    const old = this.pos;
    this.pos = offset;
    let value = 0;
    if (index < this.readByte()) {
      if (this.readByte() === 1) {
        this.pos += 2 * index;
        value = this.readUshort();
      } else {
        this.pos += 4 * index;
        value = this.readUint();
      }
      if (value > 0) {
        this.pos = offset + value;
        return true;
      }
    }
    this.pos = old;
    return false;
  }
}

function mainFileName(file) {
  const at = file.lastIndexOf('/');
  const base = at >= 0 ? file.slice(at + 1) : file;
  const dot = base.lastIndexOf('.');
  return `${dot >= 0 ? base.slice(0, dot) : base}.png`;
}

export function parsePackage(bytes, resourcePath = '') {
  const b = new ByteBuffer(bytes);
  const magic = b.readUint();
  if (magic !== MAGIC) throw new Error(`不是 FairyGUI 包（magic=${magic}）`);
  const version = b.readInt();
  const v2 = version >= 2;
  b.readBool();
  const id = b.readString();
  const name = b.readString();
  b.skip(20);
  const index = b.pos;

  // 字符串表要先建好，后面的 readS 才有得查。
  b.seek(index, 4);
  const tableSize = b.readInt();
  for (let i = 0; i < tableSize; i++) b.stringTable[i] = b.readString();
  if (b.seek(index, 5)) {
    const extra = b.readInt();
    for (let i = 0; i < extra; i++) {
      const slot = b.readUshort();
      const len = b.readInt();
      b.stringTable[slot] = b.readString(len);
    }
  }

  const dependencies = [];
  if (b.seek(index, 0)) {
    const count = b.readShort();
    for (let i = 0; i < count; i++) dependencies.push({ id: b.readS(), name: b.readS() });
  }

  const branches = [];
  if (v2) {
    const count = b.readShort();
    for (let i = 0; i < count; i++) branches.push(b.readS());
  }

  const items = [];
  const itemsById = new Map();
  if (b.seek(index, 1)) {
    const atlasPrefix = `${resourcePath}_`;
    const fileDir = resourcePath.slice(0, resourcePath.lastIndexOf('/') + 1);
    const count = b.readShort();
    for (let i = 0; i < count; i++) {
      const end = b.readInt() + b.pos;
      const item = { type: b.readByte(), id: b.readS(), name: b.readS(), file: null, width: 0, height: 0, exported: false };
      b.readS();
      item.file = b.readS();
      // 图集页在二进制里写的是 atlas0.png 这种裸名，前缀是运行时才拼上去的，两边都留着。
      item.rawFile = item.file;
      item.exported = b.readBool();
      item.width = b.readInt();
      item.height = b.readInt();
      switch (item.type) {
        case ITEM_TYPE.IMAGE: {
          const scale = b.readByte();
          if (scale === 1) {
            item.scale9Grid = { x: b.readInt(), y: b.readInt(), width: b.readInt(), height: b.readInt() };
            item.tileGridIndice = b.readInt();
          } else if (scale === 2) {
            item.scaleByTile = true;
          }
          item.smoothing = b.readBool();
          break;
        }
        case ITEM_TYPE.MOVIE_CLIP:
          item.smoothing = b.readBool();
          b.skip(b.readInt());
          break;
        case ITEM_TYPE.FONT:
          b.skip(b.readInt());
          break;
        case ITEM_TYPE.COMPONENT: {
          const objectType = b.readByte();
          item.objectType = objectType > 0 ? objectType : 3;
          b.skip(b.readInt());
          break;
        }
        case ITEM_TYPE.ATLAS:
        case ITEM_TYPE.SOUND:
        case ITEM_TYPE.MISC:
          item.file = `${atlasPrefix}${mainFileName(item.file ?? '')}`;
          break;
        case ITEM_TYPE.SPINE:
        case ITEM_TYPE.DRAGON_BONES:
          item.file = `${fileDir}${mainFileName(item.file ?? '')}`;
          item.skeletonAnchor = { x: b.readFloat(), y: b.readFloat() };
          break;
        default:
          break;
      }
      if (v2) {
        const group = b.readS();
        if (group) item.name = `${group}/${item.name}`;
        const branchCount = b.readByte();
        if (branchCount > 0) {
          item.branches = [];
          for (let n = 0; n < branchCount; n++) item.branches.push(b.readS());
        }
        const resCount = b.readByte();
        if (resCount > 0) {
          item.highResolution = [];
          for (let n = 0; n < resCount; n++) item.highResolution.push(b.readS());
        }
      }
      items.push(item);
      itemsById.set(item.id, item);
      b.pos = end;
    }
  }

  // 图集矩形：sprite 键 -> { 图集页, 矩形, 是否旋转 }
  const sprites = new Map();
  if (b.seek(index, 2)) {
    const count = b.readShort();
    for (let i = 0; i < count; i++) {
      const end = b.readShort() + b.pos;
      const key = b.readS();
      const item = itemsById.get(b.readS());
      const rect = { x: b.readInt(), y: b.readInt(), width: b.readInt(), height: b.readInt() };
      const sprite = { key, atlas: item ?? null, rect, rotated: b.readBool(), offset: { x: 0, y: 0 }, originalSize: { width: rect.width, height: rect.height } };
      if (v2) {
        if (b.readBool()) {
          sprite.offset = { x: b.readInt(), y: b.readInt() };
          sprite.originalSize = { width: b.readInt(), height: b.readInt() };
        }
      }
      sprites.set(key, sprite);
      b.pos = end;
    }
  }

  return { id, name, version, items, sprites, dependencies, branches };
}

export function parsePackageFile(file, resourcePath = '') {
  return parsePackage(fs.readFileSync(file), resourcePath);
}

// PNG 的 IHDR 里就有尺寸，用来跟图集页对账，不需要任何图像库。
export function pngSize(file) {
  const head = Buffer.alloc(24);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, head, 0, 24, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (head.toString('latin1', 1, 4) !== 'PNG') return null;
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

// 直接把一个包里的名字和矩形打出来，用来肉眼核对解析结果。
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const file = process.argv[2];
  if (!file) {
    console.error('用法: node src/fgui.mjs <FGUI包.bin> [名字过滤]');
    process.exit(1);
  }
  const pkg = parsePackageFile(file, process.argv[4] ?? '');
  const filter = process.argv[3] ?? '';
  console.log(`包名 ${pkg.name} id=${pkg.id} version=${pkg.version} 物品 ${pkg.items.length} 矩形 ${pkg.sprites.size}`);
  const byType = new Map();
  for (const item of pkg.items) byType.set(item.type, (byType.get(item.type) ?? 0) + 1);
  console.log('类型分布:', [...byType].map(([t, n]) => `${Object.keys(ITEM_TYPE).find((k) => ITEM_TYPE[k] === t) ?? t}=${n}`).join(' '));
  for (const item of pkg.items) {
    if (item.type === ITEM_TYPE.ATLAS) console.log(`  图集页 ${item.name} file=${item.file} ${item.width}x${item.height}`);
  }
  let shown = 0;
  for (const [key, sprite] of pkg.sprites) {
    const name = sprite.atlas?.name ?? '?';
    if (filter && !name.includes(filter)) continue;
    if (shown++ > 40) break;
    console.log(`  ${sprite.atlas?.file ?? '?'}  ${JSON.stringify(sprite.rect)} rot=${sprite.rotated} name=${name} key=${key}`);
  }
}
