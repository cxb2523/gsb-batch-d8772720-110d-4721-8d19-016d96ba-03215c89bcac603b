// 把微信缓存里的 config_cn 资源包复制到 work/cdn，避免缓存被清掉后配置表失效。
// 用法: node tools/sync-config.mjs
import fs from 'node:fs';
import path from 'node:path';
import { findConfigPack, loadTables, CONFIG_PACK_PATH } from '../src/config.mjs';

const source = process.argv[2] || findConfigPack();
if (!source) {
  console.error('没有找到配置表缓存，先启动一次游戏让它下载 config_cn');
  process.exit(1);
}

const tables = loadTables(source);
const names = Object.keys(tables);
if (names.length < 100) {
  console.error(`配置包看起来不完整，只解析出 ${names.length} 张表`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(CONFIG_PACK_PATH), { recursive: true });
if (path.resolve(source) !== CONFIG_PACK_PATH) {
  const stat = fs.statSync(source);
  fs.copyFileSync(source, CONFIG_PACK_PATH);
  // 保留资源日期，避免重复同步把旧内容标成最新、遮蔽之后下载的缓存。
  fs.utimesSync(CONFIG_PACK_PATH, stat.atime, stat.mtime);
}
const size = (fs.statSync(CONFIG_PACK_PATH).size / 1024 / 1024).toFixed(1);
console.log(`已同步 ${names.length} 张表 (${size} MB)`);
console.log(`  来源 ${source}`);
console.log(`  目标 ${CONFIG_PACK_PATH}`);
for (const key of ['ResourceCfg', 'OfflineCfg', 'OfflineLvRewardCfg']) {
  console.log(`  ${key}: ${tables[key]?.data?.length ?? 0} 行`);
}
