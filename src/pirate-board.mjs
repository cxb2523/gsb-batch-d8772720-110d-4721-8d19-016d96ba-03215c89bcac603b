import { normalize } from './worlds.mjs';
import { displayMaterial } from './config.mjs';
import { pirateTracker, pirateHuntOptions, pirateHuntFlights } from './pirates.mjs';
import { readFleetFormations } from './fleet-formation.mjs';

const RECHECK = 600;
const RANK_TOP = 3;
const clock = client => (Date.now() + (client.serverClockOffsetMs || 0)) / 1000;
const seasonOf = player => Math.floor(normalize(player?.worldId) / 1e6) % 1000;
const assets = (config, rows = []) => rows.map(item => displayMaterial(config, item.id ?? item[0]) + ' ×' + normalize(item.num ?? item[1])).join('、');

export const openRanks = [
  { type: 1, name: '订单冲榜', table: 'OpenRankOrderTaskCfg' },
  { type: 2, name: '闯关冲榜', table: 'OpenRankStageTaskCfg' },
  { type: 3, name: '剿匪冲榜', table: 'OpenRankPirateTaskCfg' },
  { type: 4, name: '战力冲榜', table: 'OpenRankWarTaskCfg' },
];

// Rewards hold assets plus lists of heroes, equipment and so on.
function reportAssets(row) {
  return row.rewards?.assetPackage?.asset ?? [];
}

function hasReward(row) {
  const rewards = row.rewards ?? {};
  return Object.values(rewards).some(value => Array.isArray(value) ? value.length > 0 : (value?.asset?.length ?? 0) > 0);
}

export async function campaignReportState(client, config, player) {
  const reply = normalize(await client.request('CampaignReportsRequest', { pageNo: 0 }, 'CampaignReportsResponse'));
  const reports = reply.reports ?? [];
  const pirateRows = config?.tables?.WorldPirateCfg?.data?.filter(row => Number(row.season) === seasonOf(player)) ?? [];
  const pending = reports.filter(row => !row.received && hasReward(row));
  const pirates = reports.filter(row => row.pirate).slice(0, 5).map(row => ({
    name: (pirateRows.find(cfg => cfg.type === row.pirate.type && cfg.level === row.pirate.level)?.showName ?? '海盗') + ' ' + row.pirate.level + ' 级',
    win: Boolean(row.win), time: row.createTime, received: Boolean(row.received), rewards: assets(config, reportAssets(row)),
  }));
  return { total: reply.total ?? reports.length, pending: pending.length, rewards: assets(config, pending.flatMap(reportAssets)), pirates };
}

// Rewards stay in the battle report until collected, the same as the game's collect-all button.
export async function claimCampaignReports(client, config, player, allowed, report, scheduler = null) {
  const before = await campaignReportState(client, config, player);
  if (before.pending && allowed('campaignReports')) {
    await client.sendWatch('QuickGotCampaignReportRequest', { all: true });
    const after = await campaignReportState(client, config, player);
    if (after.pending >= before.pending) throw new Error('服务端未确认战报奖励已领取');
    report({ label: '战报奖励 · 领取 ' + (before.pending - after.pending) + ' 份' + (before.rewards ? '：' + before.rewards : ''), ok: true });
  }
  scheduler?.defer('campaignReports', scheduler.now() + RECHECK);
}

function rankTasks(config, player, table) {
  const rows = config?.tables?.[table]?.data ?? [];
  if (!rows.some(row => row.season !== undefined)) return rows;
  const season = seasonOf(player);
  const seasons = rows.map(row => row.season);
  const use = seasons.includes(season) ? season : Math.max(...seasons);
  return rows.filter(row => row.season === use);
}

export async function openRankState(client, config, player, rank) {
  let reply;
  try {
    reply = normalize(await client.request('OpenRankInfoRequest', { type: rank.type }, 'OpenRankInfoResponse'));
  } catch (error) {
    // The server refuses ranks that are not open on this world.
    if (!/open rank forbidden/.test(error.message)) throw error;
    return { ...rank, open: false, endTime: 0, progress: 0, ready: [], next: null, got: 0, total: 0, top: [], me: null };
  }
  const progress = reply.progress ?? 0, got = reply.gotRewardId ?? [];
  const tasks = [...rankTasks(config, player, rank.table)].sort((a, b) => a.score - b.score);
  const ready = tasks.filter(task => progress >= task.score && !got.includes(task.score));
  const next = tasks.find(task => progress < task.score);
  const board = reply.leaderBoard ?? {};
  const person = row => ({ rank: row.rank, nickname: row.nickname, value: row.value, power: row.power });
  return { ...rank, open: reply.endTime > clock(client), endTime: reply.endTime, progress, ready, next, got: got.length, total: tasks.length,
    top: (board.item ?? []).slice(0, RANK_TOP).map(person), me: board.myItem ? person(board.myItem) : null };
}

export async function claimOpenRanks(client, config, player, allowed, report, scheduler = null) {
  for (const rank of openRanks) {
    if (!allowed('openRankRewards')) break;
    const state = await openRankState(client, config, player, rank);
    if (!state.open) continue;
    for (const task of state.ready) {
      if (!allowed('openRankRewards')) break;
      await client.sendWatch('GotOpenRankRewardRequest', { type: rank.type, id: task.score });
      report({ label: rank.name + ' · ' + task.score + ' 分奖励：' + assets(config, task.reward), ok: true });
    }
  }
  scheduler?.defer('openRankRewards', scheduler.now() + RECHECK);
}

export async function pirateBoard(client, config, player) {
  const section = work => work().catch(error => ({ error: error.message }));
  const [tracker, hunt, formation, reports, rank] = await Promise.all([
    section(() => pirateTracker(client, config, player)),
    section(() => pirateHuntOptions(client, config, player)),
    section(() => readFleetFormations(client, config, player)),
    section(() => campaignReportState(client, config, player)),
    section(() => openRankState(client, config, player, openRanks[2])),
  ]);
  return { tracker, hunt, formation, reports, rank, flights: pirateHuntFlights(client) };
}
