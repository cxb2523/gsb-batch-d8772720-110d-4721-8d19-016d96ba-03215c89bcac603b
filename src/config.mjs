import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { activeResources } from './resource-store.mjs';

// 客户端的配置表不在游戏包里，而是运行时从 CDN 拉取的独立 bundle `config_cn`，
// 整包被 Cocos 打成 JSON。优先读取已验证的远程资源快照，微信缓存作兼容来源。
// 远程资源可用 `npm run sync-resources` 更新，本地缓存可用 `npm run sync-config` 同步。
export const APPID = 'wx2ea52a972ea18e5e';
export const CONFIG_PACK_PATH = path.resolve(import.meta.dirname, '../work/cdn/config_cn_pack.json');

// 资源是服务端数字枚举，数字到字符串 id 的映射只存在于客户端的生成代码里。
export const RESOURCE = { 1: 'EXP', 3: 'GOLD', 4: 'RUBY', 5: 'ARENA_POINT', 6: 'LEAGUE_POINT', 7: 'SNOWBALL_STAMINA' };

function cachedPackCandidates() {
  const users = path.join(os.homedir(), 'AppData', 'Roaming', 'Tencent', 'xwechat', 'radium', 'users');
  if (!fs.existsSync(users)) return [];
  const found = [];
  for (const user of fs.readdirSync(users)) {
    const dir = path.join(users, user, 'applet', 'local', APPID, 'usr', 'gamecaches', 'config_cn');
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (file.endsWith('.json')) found.push(path.join(dir, file));
    }
  }
  return found;
}

// 小文件是 bundle 描述；资源包更新后可能同样大甚至更小，不能用大小判断版本。
// 同步副本仅作可离线保留的来源，不能永久遮蔽游戏刚下载的新缓存。
export function findConfigPack() {
  if (process.env.CW_CONFIG_PACK && fs.existsSync(process.env.CW_CONFIG_PACK)) return process.env.CW_CONFIG_PACK;
  const resources = activeResources();
  if (resources) return resources.configFile;
  const candidates = cachedPackCandidates().filter((file) => fs.statSync(file).size > 1_000_000);
  if (fs.existsSync(CONFIG_PACK_PATH)) candidates.unshift(CONFIG_PACK_PATH);
  if (!candidates.length) return null;
  return candidates.map(file => ({ file, modified: fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.modified - a.modified)[0].file;
}

// 打包格式是嵌套数组，每张表都是 [索引, "表名", {data: [...]}]。递归把带名字的对象捞出来。
export function extractTables(pack) {
  const tables = {};
  const walk = (node) => {
    if (!Array.isArray(node)) return;
    if (
      node.length >= 3 &&
      typeof node[0] === 'number' &&
      typeof node[1] === 'string' &&
      node[2] !== null &&
      typeof node[2] === 'object' &&
      !Array.isArray(node[2])
    ) {
      tables[node[1]] = node[2];
    }
    for (const child of node) walk(child);
  };
  walk(pack);
  return tables;
}

export function loadTables(file = findConfigPack()) {
  if (!file) throw new Error('找不到配置表，请运行 npm run sync-resources；使用微信缓存时请先进入游戏，再运行 npm run sync-config');
  return extractTables(JSON.parse(fs.readFileSync(file, 'utf8')));
}

const rows = (tables, name) => (Array.isArray(tables[name]?.data) ? tables[name].data : []);

export function displayMaterial(config, id) {
  return config?.materialName?.(id) || '未知材料';
}

export function loadConfig({ file, resources = file ? null : activeResources() } = {}) {
  const tables = loadTables(file || resources?.configFile || findConfigPack());
  const resourceCfg = new Map(rows(tables, 'ResourceCfg').map((row) => [row.id, row]));
  const itemCfg = new Map(rows(tables, 'ItemCfg').map(row => [row.id, row]));

  const access = new Map(rows(tables, 'ItemAccessCfg').map(row => [row.id, row.name]));
  const sources = new Map(rows(tables, 'ItemJumpCfg').map(row => [row.id,
    [...new Set((row.accessList ?? []).map(key => access.get(key)).filter(Boolean))]]));
  const config = {
    materialSources(id) { return sources.get(RESOURCE[id] ?? id) ?? []; },
    tables,
    names: Object.keys(tables).sort(),
    materialName(id) {
      const key = RESOURCE[id] ?? id;
      return resourceCfg.get(key)?.show_name || itemCfg.get(key)?.show_name
        || (key === 'SNOWBALL_STAMINA' ? '雪球体力' : '未知材料');
    },
    // 数字枚举先转字符串 id，再从 ResourceCfg 取展示名。
    resourceName(res) {
      const id = typeof res === 'number' ? RESOURCE[res] ?? String(res) : res;
      return resourceCfg.get(id)?.show_name ?? (id === 'SNOWBALL_STAMINA' ? '雪球体力' : `资源 #${res}`);
    },
    resourceId(res) {
      return typeof res === 'number' ? RESOURCE[res] ?? String(res) : res;
    },
    // 挂机等级上限由主线进度决定：取 stage <= mainlineStage-1 的最高等级。
    afkMaxLevel(mainlineStage) {
      let best = 0;
      for (const row of rows(tables, 'OfflineCfg')) {
        if (row.stage <= mainlineStage - 1 && row.level > best) best = row.level;
      }
      return best;
    },
    // 下一个有奖励的挂机等级；reward 为空的等级不产出，客户端会跳过。
    nextAfkRewardLevel(rewardedLevel) {
      for (const row of rows(tables, 'OfflineLvRewardCfg')) {
        if (row.level > rewardedLevel && row.reward.length > 0) return row.level;
      }
      return null;
    },
  };
  Object.defineProperty(config, 'resources', { value: resources });
  return config;
}

let cached = null, cachedSource = '';
export function getConfig() {
  const resources = activeResources(), file = resources?.configFile || findConfigPack();
  const signature = file ? file + ':' + fs.statSync(file).mtimeMs : '';
  if (!cached || cachedSource !== signature) {
    const next = loadConfig({ file, resources });
    cached = next; cachedSource = signature;
  }
  return cached;
}
