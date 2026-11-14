// 四条页面批注的隔离夹具。所有角色、进度和物资均为虚构，响应经过当前游戏协议编解码。
import { EventEmitter } from 'node:events';
import { loadProtocol } from '../../src/proto.mjs';
import { automationWireId } from '../../src/automation-policy.mjs';
const protocol = loadProtocol();

export function commentsFixture() {
  const now = Math.floor(Date.now() / 1000);
  const player = { level: 36, nickname: '页面模拟角色', playerId: automationWireId('9007199254740995'), guildId: automationWireId('9007199254740993'), scenarioId: 1.5 };
  const helper = { playerId: automationWireId('9007199254740997'), nickname: '同行者甲', avatar: {} };
  const state = {
    dailyTask: [{ id: 1001, progress: 1, targetProgress: 1, rewardClaimed: false }, { id: 1004, progress: 0, targetProgress: 1, rewardClaimed: false },
      { id: 1007, progress: 0, targetProgress: 1, rewardClaimed: false }, { id: 1014, progress: 0, targetProgress: 1, rewardClaimed: false }],
    price: 16, ruby: 1000, shopBought: false, dailyResetTime: now + 86400, unknownDaily: false, unknownAid: false, aidReadError: false,
    aids: [
      { reqId: automationWireId('9007199254741995'), reqItemId: '木材', endTime: now + 600, helper },
      { reqId: automationWireId('9007199254741997'), reqItemId: '木材', endTime: now - 10, helper },
      { reqId: automationWireId('9007199254741999'), reqItemId: '小麦', endTime: now + 600 },
    ],
    writes: [], reads: [], beforeRead: null,
  };
  const client = new EventEmitter();
  client.connected = true;
  client.snapshot = () => ({ state: 'READY', connected: true });
  client.stop = () => { client.connected = false; };
  const write = (name, body) => {
    state.writes.push({ name, body: structuredClone(body) });
    if (name === 'GotMyGuildAidRequest') { if (!state.unknownAid) state.aids = state.aids.filter(row => !row.helper); return {}; }
    if (name === 'DrawDailyTaskRewardRequest') {
      if (!state.unknownDaily) state.dailyTask.find(row => row.id === body.id).rewardClaimed = true;
      return { activity: 10 };
    }
    const id = name === 'DrawAfkRewardRequest' ? 1004 : name === 'DiscountShopBuyRequest' ? 1007 : 0;
    if (!id) throw new Error('夹具禁止未声明写入：' + name);
    if (!state.unknownDaily) state.dailyTask.find(row => row.id === id).progress++;
    if (id === 1007) { state.ruby -= state.price; state.shopBought = true; }
    return {};
  };
  client.sendWatch = async (name, body) => { write(name, body); };
  client.request = async (name, body, responseName = name.replace(/Request$/, 'Response')) => {
    let value;
    if (['DrawAfkRewardRequest', 'DrawDailyTaskRewardRequest'].includes(name)) value = write(name, body);
    else {
      state.reads.push(name);
      if (state.beforeRead) await state.beforeRead(name);
      switch (name) {
        case 'DailyTaskInfoRequest': value = { dailyTask: state.dailyTask, dailyActivity: 40, weeklyActivity: 160, dailyResetTime: state.dailyResetTime }; break;
        case 'AllItemRequest': value = { items: [{ itemId: '木材', num: 20 }] }; break;
        case 'AllResourceRequest': value = { list: [{ res: 4, amount: state.ruby }, { res: 3, amount: 10000 }] }; break;
        case 'AfkInfoRequest': value = { afkInfo: { level: 1, afkStartTime: now - 600, afkFinishTime: now - 1, rewardedLevel: 0 } }; break;
        case 'DiscountShopRequest': value = { shopItem: [{ id: 1, price: state.price, discount: 1, isBuy: state.shopBought }] }; break;
        case 'DailyGiftPackRequest': value = { drawnPack: [], resetTime: now + 86400 }; break;
        case 'GuildInfoRequest': value = { guild: { guildId: player.guildId, name: '模拟验证联盟', level: 3, memberCount: 18, welfarePack: [], gotWelfareTime: now } }; break;
        case 'GuildAidListRequest': value = { lastReadAskTime: now, askItems: [1, 2].map(i => ({ asker: helper, reqId: automationWireId(String(100 + i)), reqItemId: i === 1 ? '木材' : '小麦', endTime: now + 900, askTime: now - 10 })) }; break;
        case 'MyGuildAidRequest': if (state.aidReadError) throw new Error('模拟网络读取失败'); value = { aids: state.aids }; break;
        case 'OnWaterRequest': value = { building: [], workerOrder: [] }; break;
        case 'AllHeroRequest': value = { heroes: [] }; break;
        case 'EmailBoxRequest': case 'AchievementInfoRequest': case 'MainTaskInfoRequest': case 'MonthCardRequest': case 'MyResFieldsRequest': case 'MyFleetsRequest': value = {}; break;
        default: throw new Error('夹具未声明只读请求：' + name);
      }
    }
    const type = protocol[responseName];
    if (!type) throw new Error('协议不存在：' + responseName);
    return type.decode(type.encode(value).finish());
  };
  return { client, player, state, protocol };
}
