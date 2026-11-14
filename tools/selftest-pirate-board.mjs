// Battle report and open rank claims must match the game and only write when something is due.
import assert from 'node:assert/strict';
import { loadProtocol } from '../src/proto.mjs';
import { campaignReportState, claimCampaignReports, claimOpenRanks, openRankState, openRanks } from '../src/pirate-board.mjs';

const protocol = loadProtocol();
const season = 4;
const player = { worldId: season * 1e6 + 1986 };
const config = { tables: {
  WorldPirateCfg: { data: [{ season: String(season), type: 1, level: 2, showName: '海盗先锋' }] },
  OpenRankOrderTaskCfg: { data: [{ score: 10, reward: [['RUBY', 1]] }] },
  OpenRankStageTaskCfg: { data: [{ score: 10, reward: [['RUBY', 1]] }] },
  OpenRankPirateTaskCfg: { data: [
    { season: 1, score: 500, reward: [['RUBY', 9]] },
    { season, score: 100, reward: [['RUBY', 20]] },
    { season, score: 200, reward: [['RUBY', 30]] },
    { season, score: 900, reward: [['RUBY', 40]] },
  ] },
  OpenRankWarTaskCfg: { data: [{ season: 3, score: 50, reward: [['GOLD', 1]] }] },
} };
const later = Date.now() / 1000 + 1000;

function game(handlers) {
  const calls = [], sent = [];
  return { calls, sent, serverClockOffsetMs: 0,
    async request(name, body, response) {
      assert(protocol[name], name + ' 应存在于真实协议');
      assert(protocol[response], response + ' 应存在于真实协议');
      calls.push(name);
      return handlers[name](body);
    },
    async sendWatch(name, body) {
      assert(protocol[name], name + ' 应存在于真实协议');
      sent.push([name, body]);
      return handlers[name]?.(body) ?? { sent: 1, name };
    },
  };
}
const collect = () => { const rows = []; const report = row => rows.push(row); report.rows = rows; return report; };
const allow = key => key === 'campaignReports' || key === 'openRankRewards';
// Shape copied from a live CampaignReportsResponse.
const reward = (id, num) => ({ heroes: [], equips: [], badge: [], antiques: [], supplies: [], assetPackage: { asset: [{ type: 0, id, num: { low: num, high: 0, unsigned: false } }] } });

// Battle reports.
{
  const reports = [
    { uid: 1, received: false, win: true, createTime: 100, pirate: { type: 1, level: 2 }, rewards: reward('GOLD', 250) },
    { uid: 2, received: true, win: true, createTime: 90, pirate: { type: 1, level: 2 }, rewards: reward('GOLD', 250) },
    { uid: 3, received: false, win: false, createTime: 80, pirate: { type: 1, level: 2 }, rewards: { heroes: [], equips: [], badge: [], antiques: [], supplies: [], assetPackage: { asset: [] } } },
    { uid: 5, received: true, win: false, createTime: 60, pirate: { type: 1, level: 2 } },
    { uid: 4, received: false, win: true, createTime: 70, rewards: reward('RUBY', 5) },
  ];
  const client = game({
    CampaignReportsRequest: body => { assert.equal(body.pageNo, 0, '客户端的页码从 0 开始'); return { reports, total: reports.length }; },
    QuickGotCampaignReportRequest: () => { for (const row of reports) row.received = true; },
  });
  const view = await campaignReportState(client, config, player);
  assert.equal(view.pending, 2, '失败且没有奖励的战报不算待领');
  assert.equal(view.pirates.length, 4, '战况只列海盗战报');
  assert(view.rewards.includes('×250'), '待领奖励要能列出资产和数量');
  assert.equal(view.pirates[0].name, '海盗先锋 2 级');
  const report = collect();
  await claimCampaignReports(client, config, player, allow, report);
  assert.deepEqual(client.sent, [['QuickGotCampaignReportRequest', { all: true }]]);
  assert.equal(report.rows[0].ok, true);
  await claimCampaignReports(client, config, player, allow, report);
  assert.equal(client.sent.length, 1, '没有待领时不发送');
}
{
  const reports = [{ uid: 1, received: false, rewards: reward('GOLD', 1) }];
  const client = game({ CampaignReportsRequest: () => ({ reports }) });
  await assert.rejects(claimCampaignReports(client, config, player, allow, collect()), /未确认/, '发送后状态没变不能当作成功');
}
{
  const client = game({ CampaignReportsRequest: () => ({ reports: [{ uid: 1, received: false, rewards: reward('GOLD', 1) }] }) });
  await claimCampaignReports(client, config, player, () => false, collect());
  assert.equal(client.sent.length, 0, '开关关闭时不领取');
}

// Open ranks. The server refuses a rank that is not open on this world.
const info = rows => body => {
  if (!rows[body.type]) { const error = new Error('server prompt: open rank forbidden:ORA_X'); error.prompt = true; throw error; }
  return rows[body.type];
};
{
  const client = game({ OpenRankInfoRequest: () => { throw new Error('offline'); } });
  await assert.rejects(openRankState(client, config, player, openRanks[0]), /offline/, '其他错误要如实上报');
}
{
  const reward = (id, num) => ({ assetPackage: { asset: [{ id, num }] }, equips: [{ id: '绿武器1' }] });
  const onlyEquip = { received: false, rewards: { equips: [{ id: '绿武器1' }], assetPackage: { asset: [] } } };
  const client = game({ CampaignReportsRequest: () => ({ reports: [onlyEquip, { received: false, rewards: reward('GOLD', 1) }] }) });
  assert.equal((await campaignReportState(client, config, player)).pending, 2, '只有装备的战报也算待领');
}
{
  const client = game({ OpenRankInfoRequest: info({ 3: { endTime: later, progress: 250, gotRewardId: [100], leaderBoard: { item: [{ rank: 1, nickname: '甲', value: 999 }], myItem: { rank: 40, value: 250 } } } }) });
  const state = await openRankState(client, config, player, openRanks[2]);
  assert.deepEqual(state.ready.map(row => row.score), [200], '按当前赛季配置，只算未领且达标的档位');
  assert.equal(state.next.score, 900);
  assert.equal(state.me.rank, 40);
  assert.equal(state.total, 3, '其他赛季的配置不计入');
  const report = collect();
  await claimOpenRanks(client, config, player, allow, report);
  assert.deepEqual(client.sent, [['GotOpenRankRewardRequest', { type: 3, id: 200 }]], '活动 id 用配置的 score，已结束的榜单不领取');
}
{
  const client = game({ OpenRankInfoRequest: info({ 4: { endTime: later, progress: 60, gotRewardId: [] } }) });
  await claimOpenRanks(client, config, player, allow, collect());
  assert.deepEqual(client.sent, [['GotOpenRankRewardRequest', { type: 4, id: 50 }]], '当前赛季没有配置时退回最高赛季，与客户端一致');
}

console.log('pirate board ok: report paging, pending filter, confirmed collect-all, open rank seasons, ended ranks and tier ids');
