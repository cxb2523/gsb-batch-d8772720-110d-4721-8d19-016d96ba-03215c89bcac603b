// 藏品养成夹具：虚构藏品、套装和库存，所有请求和响应经过当前游戏协议编解码。
import { loadProtocol } from '../../src/proto.mjs';
import { defaultSettings } from '../../src/automation-settings.mjs';

const table = data => ({ data });
const protocol = loadProtocol();

export function antiqueConfig() {
  return { tables: {
    ModuleOpenCfg: table([{ moduleId: '藏品', playerLevel: 1 }]),
    AntiqueBaseCfg: table([
      { antiqueId: '蓝藏1', isAntique: false, suitId: 1001, color: 'BLUE', colorIndex: 1, showName: '蓝藏一', activeFrag: 10, universalItemId: '蓝藏万能碎片' },
      { antiqueId: '蓝藏2', isAntique: false, suitId: 1001, color: 'BLUE', colorIndex: 1, showName: '蓝藏二', activeFrag: 10, universalItemId: '蓝藏万能碎片' },
      { antiqueId: '红藏1', isAntique: true, suitId: 4001, color: 'RED', colorIndex: 4, showName: '红藏一', activeFrag: 50, universalItemId: '红藏万能碎片' },
      { antiqueId: '红藏2', isAntique: true, suitId: 4001, color: 'RED', colorIndex: 4, showName: '红藏二', activeFrag: 50, universalItemId: '红藏万能碎片' },
    ]),
    AntiqueStarCfg: table([1, 2, 3].map(star => ({ star, stage: 4, starNum: star,
      consumeBlue: star * 2, consumePur: star * 2, consumeOra: star * 2, consumeRed: 10 }))),
    AntiqueSuitCfg: table([
      { suitId: 1001, suitName: '怀旧时光', color: 'BLUE', colorIndex: 1 },
      { suitId: 4001, suitName: '红色套装', color: 'RED', colorIndex: 4 },
    ]),
    AntiqueSuitLvCfg: table([
      { color: 'BLUE', colorIndex: 1, maxLevel: 2, costArr: [['GOLD', 50], ['蓝藏品经验', 10]] },
      { color: 'BLUE', colorIndex: 1, maxLevel: 3, costArr: [['GOLD', 60], ['蓝藏品经验', 20]] },
      { color: 'RED', colorIndex: 4, maxLevel: 2, costArr: [['GOLD', 100], ['红藏品经验', 10]] },
    ]),
    AntiqueMasterLvCfg: table([
      { level: 1, totalStarNum: 0, maxSuitLv: 10, costArr: [] },
      { level: 2, totalStarNum: 2, maxSuitLv: 20, costArr: ['藏品大师经验', 5] },
      { level: 3, totalStarNum: 4, maxSuitLv: 30, costArr: ['藏品大师经验', 10] },
    ]),
  } };
}

export function antiqueSettings() {
  const s = defaultSettings();
  for (const key of Object.keys(s.schedule)) s.schedule[key] = false;
  Object.assign(s.loop, { world: false, tasks: false, dailies: false, heroes: false });
  s.resident.rewards = s.dailies.enabled = false;
  Object.assign(s.antique, { enabled: true, activate: true, activateQualities: ['BLUE', 'RED'], star: true,
    starQualities: ['BLUE', 'RED'], targetStar: 0, universal: false, master: true, targetMasterLevel: 0,
    suit: true, suitQualities: ['BLUE', 'RED'], goldReserve: 0, dailyGoldLimit: 0, maxActions: 20, checkEverySeconds: 60 });
  return s;
}

export function antiqueFixture(config = antiqueConfig()) {
  const state = { antiques: [], suits: [], masterLv: 1, items: new Map(), gold: 1000 };
  const client = { connected: true, writes: [], reads: [], unknown: false, reject: false, state };
  const encode = (name, value) => {
    const type = protocol[name];
    if (!type) throw new Error('夹具缺少响应协议：' + name);
    return type.decode(type.encode(value).finish());
  };
  const amount = id => state.items.get(id) ?? 0;
  const spend = (costs) => {
    for (const cost of costs) {
      if (cost.id === 'GOLD') { if (state.gold < cost.num) throw Object.assign(new Error('金币不足'), { prompt: { prompt: 1 } }); }
      else if (amount(cost.id) < cost.num) throw Object.assign(new Error('材料不足'), { prompt: { prompt: 1 } });
    }
    for (const cost of costs) {
      if (cost.id === 'GOLD') state.gold -= cost.num;
      else state.items.set(cost.id, amount(cost.id) - cost.num);
    }
  };
  const base = id => config.tables.AntiqueBaseCfg.data.find(row => row.antiqueId === id);
  const starCfg = star => config.tables.AntiqueStarCfg.data.find(row => row.star === star);
  const colorField = { BLUE: 'consumeBlue', PURPLE: 'consumePur', ORANGE: 'consumeOra', RED: 'consumeRed' };
  client.request = async (name, body = {}, responseName, timeout) => {
    client.reads.push({ name, body: structuredClone(body) });
    if (protocol[name]) protocol[name].decode(protocol[name].encode(body).finish());
    if (name === 'AllAntiqueRequest') return encode(responseName, { antiques: state.antiques, suits: state.suits, masterLv: state.masterLv });
    if (name === 'AllItemRequest') return encode(responseName, { items: [...state.items].map(([itemId, num]) => ({ itemId, num })) });
    if (name === 'AllResourceRequest') return encode(responseName, { list: [{ res: 3, amount: state.gold }] });
    if (name === 'AntiqueMasterLevelUpRequest') {
      if (client.reject) throw Object.assign(new Error('模拟拒绝'), { prompt: { prompt: 1 }, request: name });
      if (!client.unknown) {
        const next = config.tables.AntiqueMasterLvCfg.data.find(row => row.level === state.masterLv + 1);
        const costs = next ? (next.costArr.length ? [{ id: next.costArr[0], num: next.costArr[1] }] : []) : [];
        if (!next) throw Object.assign(new Error('大师等级已满'), { prompt: { prompt: 1 }, request: name });
        spend(costs);
        state.masterLv = next.level;
      }
      return encode(responseName, { masterLv: state.masterLv });
    }
    throw new Error('夹具不允许读取：' + name);
  };
  client.sendWatch = async (name, body = {}) => {
    client.writes.push({ name, body: structuredClone(body) });
    if (protocol[name]) protocol[name].decode(protocol[name].encode(body).finish());
    if (client.reject) throw Object.assign(new Error('模拟拒绝'), { prompt: { prompt: 1 }, request: name });
    if (client.unknown) return { sent: client.writes.length };
    if (name === 'ActivateAntiqueRequest') {
      const cfg = base(body.id);
      if (!cfg || state.antiques.some(row => row.id === body.id)) throw Object.assign(new Error('藏品已激活或不存在'), { prompt: { prompt: 1 }, request: name });
      spend([{ id: body.id + '碎片', num: cfg.activeFrag }]);
      state.antiques.push({ id: body.id, star: 0 });
      return { sent: client.writes.length };
    }
    if (name === 'AntiqueStarUpRequest') {
      const row = state.antiques.find(item => item.id === body.id), cfg = base(body.id);
      if (!row || !cfg) throw Object.assign(new Error('藏品不存在'), { prompt: { prompt: 1 }, request: name });
      const next = starCfg(row.star + 1);
      if (!next) throw Object.assign(new Error('星级已满'), { prompt: { prompt: 1 }, request: name });
      const need = next[colorField[cfg.color]];
      const specific = amount(body.id + '碎片'), universal = body.universal ? amount(cfg.universalItemId) : 0;
      if (specific + universal < need) throw Object.assign(new Error('碎片不足'), { prompt: { prompt: 1 }, request: name });
      const fromSpecific = Math.min(specific, need), fromUniversal = need - fromSpecific;
      if (fromSpecific) state.items.set(body.id + '碎片', specific - fromSpecific);
      if (fromUniversal) state.items.set(cfg.universalItemId, amount(cfg.universalItemId) - fromUniversal);
      row.star += 1;
      return { sent: client.writes.length };
    }
    if (name === 'AntiqueSuitLevelUpRequest') {
      const suitCfg = config.tables.AntiqueSuitCfg.data.find(row => row.suitId === body.id);
      const current = state.suits.find(row => row.id === body.id);
      if (!suitCfg) throw Object.assign(new Error('套装不存在'), { prompt: { prompt: 1 }, request: name });
      if (!current) {
        const cfgRows = config.tables.AntiqueBaseCfg.data.filter(row => row.suitId === body.id);
        const activated = cfgRows.filter(row => state.antiques.some(item => item.id === row.antiqueId)).length;
        const needed = Number(suitCfg.colorIndex) >= 4 ? 2 : cfgRows.length;
        if (activated < needed) throw Object.assign(new Error('套装藏品不足'), { prompt: { prompt: 1 }, request: name });
        state.suits.push({ id: body.id, level: 1 });
        return { sent: client.writes.length };
      }
      const target = current.level + 1;
      const cost = config.tables.AntiqueSuitLvCfg.data.find(row => row.color === suitCfg.color && row.maxLevel >= target);
      if (!cost) throw Object.assign(new Error('套装等级已满'), { prompt: { prompt: 1 }, request: name });
      spend(cost.costArr.map(item => ({ id: item[0], num: item[1] })));
      current.level = target;
      return { sent: client.writes.length };
    }
    throw new Error('夹具不允许发送：' + name);
  };
  client.setItem = (id, num) => { if (num <= 0) state.items.delete(id); else state.items.set(id, num); };
  return { client, protocol, config, state };
}
