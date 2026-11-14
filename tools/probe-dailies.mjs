// 只读探测：把日常任务可能用到的信息类请求全部发一遍，看服务端实际返回什么。
// 用法: node tools/probe-dailies.mjs
import fs from 'node:fs';
import path from 'node:path';
import { GameClient } from '../src/client.mjs';
import { loadProtocol } from '../src/proto.mjs';

const CREDENTIALS = path.resolve(import.meta.dirname, '../data/credentials.json');
const raw = JSON.parse(fs.readFileSync(CREDENTIALS, 'utf8'));
const protocol = loadProtocol();
const client = new GameClient({ url: raw.url || raw.wsUrl, protocol });
client.on('warn', (message) => console.log(`warn: ${message}`));

const response = await client.connect(raw.login || raw.body);
console.log(`login ok: ${response.playerInfo?.nickname} lv${response.playerInfo?.level}`);

const queries = [
  ['ArenaInfoRequest', {}],
  ['ClickGoldInfoRequest', {}],
  ['DiscountShopRequest', {}],
  ['ShopInfoRequest', { type: 1 }],
  ['TrialRaidInfoRequest', { raidId: 1 }],
  ['MuseumInfoRequest', {}],
  ['AllPirateRequest', {}],
  ['GuildCityInfoRequest', {}],
  ['GuildAidListRequest', { type: 0 }],
  ['LeagueInfoRequest', {}],
  ['LeagueReportListRequest', {}],
  ['TradeGuildRadarRequest', {}],
  ['TradeInfoRequest', {}],
  ['CargoShipsRequest', {}],
  ['PassStageStateRequest', {}],
  ['RecruitInfoRequest', {}],
  ['RadarInfoRequest', {}],
  ['CityFortInfoRequest', {}],
  ['WeekInfoRequest', {}],
];

for (const [name, body] of queries) {
  const responseName = `${name.slice(0, -7)}Response`;
  try {
    const result = await client.request(name, body, responseName, 8000);
    const text = JSON.stringify(result);
    console.log(`\n=== ${name}`);
    console.log(text.length > 1200 ? `${text.slice(0, 1200)}...` : text);
  } catch (error) {
    console.log(`\n=== ${name} 失败: ${error.message}`);
  }
}

client.stop();
