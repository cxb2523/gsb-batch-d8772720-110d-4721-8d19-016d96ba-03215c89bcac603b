// 游戏素材：图标名 → 图集页上的矩形 → 浏览器能直接裁的 CSS 坐标。
//
// 贴图由 tools/sync-art.mjs 从微信缓存（必要时从 CDN）镜像到 work/cdn/art/，
// 索引 work/cdn/art/index.json 的形状是 { icons: { 名字: {bundle,page,x,y,w,h,rotated} }, pages: [...] }。
// 这里只做两件事：读索引，以及把游戏实体（道具/资源/英雄/建筑）翻译成图标名。
// 查不到就返回 null，界面退回中文文字，不编造。
import fs from 'node:fs';
import path from 'node:path';
import { getConfig, RESOURCE } from './config.mjs';

export const ART_DIR = path.resolve(import.meta.dirname, '../work/cdn/art');
const INDEX_PATH = path.join(ART_DIR, 'index.json');

let cached = null;
let indexMtime;
let nextIndexCheck = 0;

export function iconIndex() {
  const now = Date.now();
  if (cached && now < nextIndexCheck) return cached;
  nextIndexCheck = now + 1000;
  try {
    const mtime = fs.statSync(INDEX_PATH).mtimeMs;
    if (!cached || indexMtime !== mtime) {
      cached = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
      indexMtime = mtime;
    }
  } catch {
    cached ??= { generatedAt: null, icons: {}, pages: [] };
  }
  return cached;
}

// 配置表写的名字和包里存的名字常差一个后缀（hero_head_001 vs hero_head_001_hw），按顺序试。
const SUFFIXES = ['', '_hw', '_s_hw'];

export function iconOf(name, suffixes = SUFFIXES) {
  if (!name) return null;
  const { icons } = iconIndex();
  for (const suffix of suffixes) {
    const key = `${name}${suffix}`;
    if (icons[key]) return { name: key, ...icons[key] };
  }
  return null;
}

export function iconCount() {
  return Object.keys(iconIndex().icons).length;
}

// 页面直接拿这个渲染：<span style="background-image:url(entry.url);background-position:-x -y;width:w;height:h">
export function iconEntry(name) {
  const icon = iconOf(name);
  if (!icon) return null;
  return {
    name: icon.name,
    url: `/api/art/atlas/${icon.bundle}/${encodeURIComponent(icon.page)}`,
    thumb: `/api/art/icon/${encodeURIComponent(icon.name)}.png?v=${[icon.x, icon.y, icon.w, icon.h].join('.')}`,
    x: icon.x,
    y: icon.y,
    w: icon.w,
    h: icon.h,
    rotated: icon.rotated,
  };
}

// 只允许取镜像目录里真实存在的文件，路径里的 .. 与绝对路径一律拒掉。
export function atlasFile(bundle, file) {
  if (!bundle || !file?.endsWith('.png') || /[\\/]/.test(bundle) || /[\\/]/.test(file) || bundle.includes('..') || file.includes('..')) return null;
  const full = path.join(ART_DIR, bundle, file);
  if (!full.startsWith(ART_DIR + path.sep) || !fs.existsSync(full)) return null;
  return full;
}

// ---- 游戏实体 → 图标名 ----------------------------------------------------

function cfg() {
  return getConfig();
}

let maps = null;
function indexes() {
  if (maps) return maps;
  const rows = (name) => cfg().tables[name]?.data ?? [];
  const headImage = new Map();
  for (const row of rows('HeadImageCfg')) if (row.heroId) headImage.set(row.heroId, row.icon);
  const skin = new Map();
  for (const row of rows('HeroSkinCfg')) skin.set(row.heroId, row);
  // 英雄碎片物品的图就是英雄头像，没别的映射时拿它兜底。
  const frag = new Map();
  const heroNames = rows('HeroCfg').map((row) => row.id).sort((a, b) => b.length - a.length);
  for (const row of rows('ItemCfg')) {
    if (!row.pic?.startsWith('hero_head_')) continue;
    const hero = heroNames.find((name) => row.id.startsWith(name));
    if (hero && !frag.has(hero)) frag.set(hero, row.pic);
  }
  maps = {
    item: new Map(rows('ItemCfg').map((row) => [row.id, row])),
    resource: new Map(rows('ResourceCfg').map((row) => [row.id, row])),
    equip: new Map(rows('EquipCfg').map((row) => [row.id, row])),
    building: new Map(rows('BuildingCfg').map((row) => [row.buildingType, row])),
    worker: new Map(rows('WorkerBaseCfg').map((row) => [String(row.id), row])),
    fort: new Map(rows('WorldFortCfg').map((row) => [row.fortId, row])),
    headImage,
    skin,
    frag,
  };
  return maps;
}

export function resetCache() {
  cached = null;
  indexMtime = undefined;
  nextIndexCheck = 0;
  tables = null;
  maps = null;
}

export function itemIcon(itemId) {
  return iconEntry(indexes().item.get(itemId)?.pic);
}

export function resourceIcon(res) {
  const id = cfg().resourceId(res);
  return iconEntry(indexes().resource.get(id)?.pic ?? RESOURCE[id]);
}

export function equipIcon(equipId) {
  return iconEntry(indexes().equip.get(equipId)?.icon);
}

// 生产链上的「材料」既可能是道具也可能是资源（GOLD / EXP / RUBY 这种），两边都试一下。
export function materialIcon(id) {
  return itemIcon(id) ?? iconEntry(indexes().resource.get(id)?.pic);
}

// 建筑在配置表里只有英文资源路径（building/HomeBase），末段正好是 ui_building 里的名字。
export function buildingIcon(buildingType) {
  const resPath = indexes().building.get(buildingType)?.resPath ?? '';
  return iconEntry(resPath.split('/').pop());
}

export function workerIcon(workerId) {
  return iconEntry(indexes().worker.get(String(workerId))?.icon);
}

export function fortIcon(fortId) {
  return iconEntry(indexes().fort.get(fortId)?.icon);
}

export function heroIcon(heroId) {
  const { skin, headImage, frag } = indexes();
  const fromSkin = skin.get(heroId)?.headId;
  if (iconOf(fromSkin)) return iconEntry(fromSkin);
  const fromTable = headImage.get(heroId);
  if (iconOf(fromTable)) return iconEntry(fromTable);
  return iconEntry(frag.get(heroId));
}

// 卡牌和头像是一对：hero_head_043 ↔ hero_card_043，编号对不上就退回头像。
export function heroCard(heroId) {
  const { skin, frag } = indexes();
  const card = skin.get(heroId)?.cardId;
  if (iconOf(card)) return iconEntry(card);
  const head = skin.get(heroId)?.headId ?? indexes().headImage.get(heroId) ?? frag.get(heroId);
  const swapped = head?.replace(/^hero_head_/, 'hero_card_');
  if (iconOf(swapped)) return iconEntry(swapped);
  return heroIcon(heroId);
}

// 自检与文档用：各类实体能查到图标多少、缺多少。
export function iconCoverage() {
  const rows = (name) => cfg().tables[name]?.data ?? [];
  const probe = (label, values, lookup) => {
    const unique = [...new Set(values.filter(Boolean))];
    const hit = unique.filter((value) => lookup(value)).length;
    return { label, total: unique.length, hit, missing: unique.length - hit };
  };
  return [
    probe('道具', rows('ItemCfg').map((row) => row.id), itemIcon),
    probe('资源', rows('ResourceCfg').map((row) => row.id), resourceIcon),
    probe('装备', rows('EquipCfg').map((row) => row.id), equipIcon),
    probe('英雄头像', rows('HeroCfg').map((row) => row.id), heroIcon),
    probe('建筑', rows('BuildingCfg').map((row) => row.buildingType), buildingIcon),
    probe('工人', rows('WorkerBaseCfg').map((row) => row.id), workerIcon),
    probe('联盟工事', rows('WorldFortCfg').map((row) => row.fortId), fortIcon),
  ];
}

// 命令行直接查一个名字，用来肉眼核对：node src/art.mjs 生鱼片
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const name = process.argv[2];
  if (!name) {
    const index = iconIndex();
    console.log(`索引 ${path.relative(process.cwd(), INDEX_PATH)}：${iconCount()} 个图标，${index.pages.length} 张图集页`);
    for (const line of iconCoverage()) console.log(`  ${line.label}: ${line.hit}/${line.total}${line.missing ? `（缺 ${line.missing}）` : ''}`);
  } else {
    const entry = itemIcon(name) ?? heroIcon(name) ?? buildingIcon(name) ?? iconEntry(name);
    console.log(entry ? JSON.stringify(entry) : `没有 ${name} 的图标`);
  }
}
