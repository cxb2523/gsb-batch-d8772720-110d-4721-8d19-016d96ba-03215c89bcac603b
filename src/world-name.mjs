// 客户端 WorldIdRule：worldId = 大区 × 1e9 + 赛季 × 1e6 + 区服序号。
// 显示名为“大区前缀 + 序号 + 服”，大区 3 是海港、4 是海灯，其余按海岛处理。
const SEQUENCE_NO_SCALE = 1_000_000;
const SEASON_SCALE = 1_000;
const AREA_SCALE = SEASON_SCALE * SEQUENCE_NO_SCALE;
const AREA_PREFIX = new Map([
  [3, '海港'],
  [4, '海灯'],
]);

function worldNumber(value) {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object' && typeof value.low === 'number') {
    return value.high * 4294967296 + (value.low >>> 0);
  }
  return Number(value);
}

export function worldName(value) {
  const worldId = worldNumber(value);
  if (!Number.isSafeInteger(worldId) || worldId <= 0) return null;
  const area = Math.floor(worldId / AREA_SCALE);
  return `${AREA_PREFIX.get(area) ?? '海岛'}${worldId % SEQUENCE_NO_SCALE}服`;
}
