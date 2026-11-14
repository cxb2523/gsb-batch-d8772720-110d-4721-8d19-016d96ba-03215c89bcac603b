// 漫剧、擂台赛每日礼包和赛季宝箱。协议与条件依据客户端 ComicDramaPanel、TournamentUtil、SeasonChestPanel。
import { claimOnce } from './extra-free-rewards.mjs';
import { exactAutomationId } from './automation-policy.mjs';
import { gameplayOpenDay, worldOpenDays } from './extra-rewards.mjs';
import { checkedAction, clock, dayOf, hasReward, moduleOpen, positive, read, table, waiting } from './activity-actions.mjs';

const RECHECK_SECONDS = 1800;
const nextDayStart = (time) => (dayOf(time) + 1) * 86400 - 28800;

const TOURNAMENT_TASK = 'tournamentDailyGift';
const TOURNAMENT_LABEL = '擂台赛每日礼包';
// TournamentStage：1 预选，2-6 正赛，7 公示，8 结束。礼包入口只在预选之后、结束之前可见。
const STAGE_PRELIMINARY = 1;
const STAGE_END = 8;
const tournamentRunning = (state) => state?.stageId > STAGE_PRELIMINARY && state.stageId < STAGE_END;

// 擂台赛状态只在登录和阶段变化时推送，没有读取请求，需要记在连接上。
export function rememberTournament(client, name, body) {
  if (name === 'SCTournamentOpen') {
    client.tournament = {
      stageId: body?.state?.currentStageId ?? 0,
      lastClaimDailyGiftTime: body?.lastClaimDailyGiftTime ?? 0
    };
  } else if (name === 'SCTournamentUpdate' && client.tournament && body?.state) {
    client.tournament.stageId = body.state.currentStageId ?? client.tournament.stageId;
  }
}

export async function claimTournamentDaily(client, config, { player, enabled, ledger, report, scheduler }) {
  const now = clock(client);
  const today = dayOf(now);
  const tomorrow = nextDayStart(now);
  const skip = (reason, until) => {
    report({ label: TOURNAMENT_LABEL, skipped: true, reason });
    scheduler?.defer(TOURNAMENT_TASK, until);
  };
  if (!moduleOpen(config, player, '巅峰擂台赛')) return skip('账号等级未达到擂台赛开放条件', tomorrow);
  const state = client.tournament;
  if (!tournamentRunning(state)) return skip('当前不在擂台赛进行阶段', now + RECHECK_SECONDS);
  if (dayOf(state.lastClaimDailyGiftTime) === today) return skip('今日礼包已领取', tomorrow);
  const key = 'tournament-daily:' + today;
  const reply = await claimOnce(client, {
    ledger,
    key,
    title: TOURNAMENT_LABEL,
    request: 'TournamentClaimDailyGiftRequest',
    response: 'GotRewardResponse',
    enabled: () => enabled() && dayOf(clock(client)) === today && tournamentRunning(client.tournament),
    verify: hasReward,
    report
  });
  if (reply) state.lastClaimDailyGiftTime = clock(client);
  // 结果未知时记录留到当天结束；明确被拒或未发送则稍后再试。
  scheduler?.defer(TOURNAMENT_TASK, reply || ledger?.hasKey(key) ? tomorrow : now + RECHECK_SECONDS);
}

const COMIC_TASK = 'comicDrama';
const COMIC_LABEL = '漫剧奖励';
export const COMIC_ROUND_LIMIT = 10;
const comicUnlockTime = (row) => Date.parse(row.unlockTime + 'T' + row.unlockHours + '+08:00') / 1000;

export async function claimComicDrama(client, config, { player, enabled, ledger, report, scheduler }) {
  const now = clock(client);
  const today = dayOf(now);
  const tomorrow = nextDayStart(now);
  const episodes = table(config, 'ComicDramaCfg');
  const skip = (reason, until) => {
    report({ label: COMIC_LABEL, skipped: true, reason });
    scheduler?.defer(COMIC_TASK, until);
  };
  if (!episodes.length || !moduleOpen(config, player, '漫剧')) return skip('账号等级未达到漫剧开放条件', tomorrow);
  const drama = (await read(client, 'MainTaskInfo')).comicDrama;
  if (!drama || !Array.isArray(drama.comics)) return skip('服务器未返回漫剧进度', now + RECHECK_SECONDS);

  const claimed = new Map(drama.comics.map((row) => [row.comicId, row.state === true]));
  const unlocked = episodes.filter((row) => player.level >= row.unlockLevel && now >= comicUnlockTime(row));
  const episodeKey = (row) => 'comic-drama:' + row.id + ':' + today;

  // 协议没有专属回包，客户端也不读取内容，回包类型按同类请求取 OkResponse；等不到时以回读为准。
  const watch = async (row) => {
    if (!enabled()) return false;
    const request = 'ComicDramaReadRequest';
    try {
      await client.request(request, { comicId: row.id }, 'OkResponse');
    } catch (error) {
      const refused = Boolean(error.prompt && error.request === request);
      const fresh = refused ? null : (await read(client, 'MainTaskInfo')).comicDrama;
      if (!fresh?.isRead || !fresh.comics?.some((item) => item.comicId === row.id)) {
        report({ label: '观看漫剧《' + row.title + '》', ok: false, status: refused ? 'rejected' : 'unknown', error: error.message });
        return false;
      }
    }
    if (!claimed.has(row.id)) claimed.set(row.id, false);
    drama.isRead = true;
    return true;
  };

  let failed = false;
  let handled = 0;
  for (const row of unlocked) {
    if (handled >= COMIC_ROUND_LIMIT || !enabled()) break;
    if (claimed.get(row.id) === true || ledger?.hasKey(episodeKey(row))) continue;
    handled++;
    if (!claimed.has(row.id) && !(await watch(row))) {
      failed = true;
      break;
    }
    const reply = await claimOnce(client, {
      ledger,
      key: episodeKey(row),
      title: '漫剧《' + row.title + '》奖励',
      request: 'ComicDramaGotRewardRequest',
      response: 'GotRewardResponse',
      body: { comicId: row.id },
      enabled,
      verify: hasReward,
      report
    });
    if (!reply) {
      failed = true;
      break;
    }
    claimed.set(row.id, true);
  }

  // 每日奖励要求当天看过任意一集；没有新集时重看最后一集，客户端同样允许重播。
  const dailyKey = 'comic-drama-daily:' + today;
  if (!failed && enabled() && unlocked.length && !drama.gotDaily && !ledger?.hasKey(dailyKey)) {
    if (!drama.isRead && !(await watch(unlocked.at(-1)))) failed = true;
    else if (
      !(await claimOnce(client, {
        ledger,
        key: dailyKey,
        title: '漫剧每日奖励',
        request: 'ComicDramaGotDailyRequest',
        response: 'GotRewardResponse',
        enabled,
        verify: hasReward,
        report
      }))
    )
      failed = true;
  }

  if (failed) return scheduler?.defer(COMIC_TASK, now + RECHECK_SECONDS);
  const more = unlocked.some((row) => claimed.get(row.id) !== true && !ledger?.hasKey(episodeKey(row)));
  if (more) return;
  scheduler?.defer(COMIC_TASK, Math.min(tomorrow, ...episodes.map(comicUnlockTime).filter((time) => time > now)));
}

export const CHEST_ROUND_LIMIT = 5;
const CHEST_KEY_RECHECK_SECONDS = 3600;
// 超过这个时长服务器仍停在同一阶段，说明结果未知的那次开箱没有生效。
const CHEST_QUIET_SECONDS = 600;

export function seasonChestAccess(config, player, now) {
  const world = exactAutomationId(player?.worldId);
  const season = world ? Number((BigInt(world) / 1000000n) % 1000n) : 0;
  if (!positive(season)) return { reason: '无法确认当前赛季' };
  const required = gameplayOpenDay(config, player, '赛季交换宝箱');
  if (!positive(required)) return { reason: '当前赛季未开放赛季宝箱' };
  const opened = worldOpenDays(player, now);
  if (opened === null) return { reason: '无法确认开服时间' };
  if (opened < required) return { reason: '未到赛季宝箱开放日' };
  return { season };
}

// 每个宝箱消耗服务器指定的 3 把钥匙，开启后进入下一阶段并循环；钥匙在换赛季时清零。
export async function openSeasonChests(client, config, ctx) {
  const defer = (seconds) => ctx.scheduler?.defer(ctx.key, clock(client) + seconds);
  const access = seasonChestAccess(config, ctx.player, clock(client));
  if (access.reason) {
    ctx.scheduler?.defer(ctx.key, nextDayStart(clock(client)));
    return waiting(ctx, access.reason);
  }
  if (!ctx.ledger) return waiting(ctx, '账号执行记录不可用');
  const keyIds = new Set(table(config, 'SeasonChestKeyLibCfg').map((row) => row.key));
  const items = new Map(table(config, 'ItemCfg').map((row) => [row.id, row.show_name || row.id]));
  const chests = table(config, 'SeasonExchangeChestCfg');
  const scope = 'season-chest:' + access.season;
  const view = async () => (await read(client, 'SeasonChestInfo')).flow;

  for (let opened = 0; opened < CHEST_ROUND_LIMIT; opened++) {
    if (!ctx.enabled()) return;
    const flow = await view();
    if (!positive(flow?.stage) || !Array.isArray(flow.costItemId) || !flow.costItemId.length) {
      defer(RECHECK_SECONDS);
      return waiting(ctx, '赛季宝箱进度未同步');
    }
    if (flow.costItemId.some((id) => !keyIds.has(id))) {
      defer(CHEST_KEY_RECHECK_SECONDS);
      return waiting(ctx, '开箱消耗包含钥匙以外的道具，已跳过');
    }
    for (const record of Object.values(ctx.ledger.keyRecords())) {
      const expected = record.details?.expected;
      if (record.confirmed || record.details?.scope !== scope) continue;
      if (expected?.stage === flow.stage && clock(client) - expected.start >= CHEST_QUIET_SECONDS) ctx.ledger.cancel({ id: record.id });
    }

    const bag = await read(client, 'AllItem');
    if (!Array.isArray(bag.items)) throw Error('库存未同步');
    const need = new Map();
    for (const id of flow.costItemId) need.set(id, (need.get(id) ?? 0) + 1);
    const stock = {};
    for (const id of need.keys()) stock[id] = bag.items.filter((item) => item.itemId === id).reduce((sum, item) => sum + (item.num ?? 0), 0);
    const short = [...need].filter(([id, num]) => stock[id] < num);
    if (short.length) {
      defer(CHEST_KEY_RECHECK_SECONDS);
      return waiting(ctx, '钥匙不足：' + short.map(([id, num]) => (items.get(id) ?? id) + ' 需要 ' + num + ' 现有 ' + stock[id]).join('、'));
    }

    const chest = chests.find((row) => row.stage === flow.stage)?.name ?? '第 ' + flow.stage + ' 阶段宝箱';
    let outcome = null;
    await checkedAction(
      { ...ctx, report: (entry) => { outcome = entry; ctx.report(entry); } },
      {
        scope,
        before: { stage: flow.stage, cost: flow.costItemId, stock },
        expected: { request: 'SeasonChestOpenRequest', stage: flow.stage, cost: flow.costItemId, start: clock(client) },
        label: '赛季宝箱 · ' + chest + ' · 消耗 ' + flow.costItemId.map((id) => items.get(id) ?? id).join('、'),
        allowed: () => !seasonChestAccess(config, ctx.player, clock(client)).reason,
        send: () => client.request('SeasonChestOpenRequest', {}, 'SeasonChestOpenResponse'),
        inspect: async () => ({ stage: (await view()).stage }),
        matches: (expected, after) => after.stage !== expected.stage,
        accept: hasReward
      }
    );
    if (!outcome?.ok || outcome.status !== 'confirmed') return defer(RECHECK_SECONDS);
  }
}
