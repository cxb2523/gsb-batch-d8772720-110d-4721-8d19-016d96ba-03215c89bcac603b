import fs from 'node:fs';
import path from 'node:path';

export const RESOURCE_SERVER = 'https://dhyaoj-cdn.khlgamen.com/HotUpdateRes/wx/';
export const DEFAULT_RESOURCE_APP_VERSION = '1.14.5';
export const resourceDirectory = () => path.resolve(process.env.CW_RESOURCE_DIR || path.join(import.meta.dirname, '../work/cdn/resources'));

// active.json 只指向已完整验证的不可变目录。持有旧快照的任务可以继续读旧地图。
export function activeResources({ root = resourceDirectory(), honorOverride = true } = {}) {
  if (honorOverride && process.env.CW_CONFIG_PACK) return null;
  try {
    const data = JSON.parse(fs.readFileSync(path.join(root, 'active.json'), 'utf8'));
    if (!/^[a-f0-9]{16}-[a-f0-9-]{36}$/.test(data.generation) || !Array.isArray(data.scenarios) || !data.scenarios.length
      || data.scenarios.some(id => !Number.isSafeInteger(id) || id < 1 || id > 100)) return null;
    const directory = path.join(root, data.generation);
    const configFile = path.join(directory, 'config.json');
    const mapFiles = Object.fromEntries(data.scenarios.map(id => [id, path.join(directory, 'world_map' + id + '.json')]));
    if (![configFile, ...Object.values(mapFiles)].every(file => fs.statSync(file).isFile())) return null;
    return Object.freeze({ ...data, directory, configFile, mapFiles: Object.freeze(mapFiles) });
  } catch { return null; }
}

export function resourceUpdatePolicy(env = process.env) {
  const intervalMinutes = Number(env.CW_RESOURCE_UPDATE_MINUTES ?? 30);
  const appVersion = env.CW_RESOURCE_APP_VERSION || DEFAULT_RESOURCE_APP_VERSION;
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440)
    throw new Error('CW_RESOURCE_UPDATE_MINUTES 必须为 1–1440 的整数（分钟）');
  if (!/^\d+\.\d+\.\d+$/.test(appVersion)) throw new Error('CW_RESOURCE_APP_VERSION 必须为客户端版本号，例如 1.14.5');
  return { intervalMinutes, appVersion, enabled: env.CW_RESOURCE_AUTO_UPDATE !== '0' && !env.CW_CONFIG_PACK,
    disabledReason: env.CW_CONFIG_PACK ? '已显式指定 CW_CONFIG_PACK' : env.CW_RESOURCE_AUTO_UPDATE === '0' ? '已关闭自动更新' : '' };
}
