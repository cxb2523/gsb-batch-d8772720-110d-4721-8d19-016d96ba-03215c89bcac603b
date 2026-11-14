import fs from 'node:fs';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { GameClient } from './client.mjs';
import { loadProtocol } from './proto.mjs';
import { createConsole, openBrowser } from './server.mjs';
import { loadStore, saveStore, pickAccount, removeAccount, setActive, describeAccount, revealAccount, upsertAccount, ACCOUNTS_PATH, LEGACY_CREDENTIALS_PATH } from './accounts.mjs';
import { listWorlds, listGroup, enterWorld, describeRole } from './worlds.mjs';
import { collectState, summarize, formatState } from './game.mjs';
import { ACTIONS, listActions, runAction, assertAllowed, buildBody } from './actions.mjs';
import { normalize } from './worlds.mjs';
import { getConfig } from './config.mjs';
import { planHeroes, runHeroPlan, formatHeroPlan } from './heroes.mjs';
import { surveyDailies, runDailies, formatSurvey, planChests, planDailyGift } from './dailies.mjs';
import { surveyTasks, runTasks, formatTaskPlan } from './tasks.mjs';
import { surveyWorld, planWorld, runWorld, runWorldRound, formatWorldPlan, formatFieldReport, loadMapAsset, planFieldOccupy, planFieldGiveUp, SPEED_UP_ITEM, makeTypeResolver as resolveBuildingType, upgradeRow } from './world.mjs';
import { runLoop, formatLoopRound, formatLoopStep } from './loop.mjs';
import { runStages, stageFailureLimit } from './stages.mjs';
import { createPhoneLogin } from './phone-login.mjs';
import { worldName } from './world-name.mjs';
import { createConsoleOutput } from './console-output.mjs';
import { createResourceUpdater } from './resource-updater.mjs';

let consoleOutput = null;

const READ_ONLY_PROBES = [
  'AllResourceRequest',
  'AllItemRequest',
  'AfkInfoRequest',
  'DailyTaskInfoRequest',
  'ArenaInfoRequest',
  'GuildInfoRequest',
];

// --account <id|昵称|序号> 或 CW_ACCOUNT 指定用哪个号；都不给就用当前选中的那个。
function accountSelector() {
  const at = process.argv.indexOf('--account');
  if (at >= 0 && process.argv[at + 1]) return process.argv[at + 1];
  return process.env.CW_ACCOUNT ?? null;
}

function loadCredentials(selector = accountSelector()) {
  const store = loadStore();
  if (!store.accounts.length) {
    throw new Error('还没有账号。打开本地控制台，在「账号」页选择「从电脑微信添加」或「从电脑抖音添加」，再从对应客户端重新进入游戏。');
  }
  const account = pickAccount(store, selector);
  if (!account) throw new Error('选不出账号，用 --account <id|昵称|序号> 指定一个');
  // 有多个号、或用户明确指定了账号时才提示，免得单账号时每行输出都多一句。
  if (store.accounts.length > 1 || selector) {
    console.log(`账号: ${describeAccount(account).title} (${account.id.slice(0, 8)}…)`);
  }
  return { url: account.url, login: account.login, account };
}

// 配置表缓存可能不存在，缺了只是少点名字，不该让整条命令失败。
function loadConfigSafe() {
  try {
    return getConfig();
  } catch (error) {
    console.log(`warn: 未加载配置表 (${error.message})`);
    return null;
  }
}

async function headless({ seconds = 60, probes = true }) {
  const { url, login } = loadCredentials();
  const protocol = loadProtocol();
  const client = new GameClient({ url, protocol });

  client.on('state', ({ state, detail }) => console.log(`state: ${state}${detail ? ` (${detail})` : ''}`));
  client.on('pong', ({ latencyMs, offsetMs }) => console.log(`pong: ${latencyMs}ms offset=${offsetMs}ms`));
  client.on('message', ({ name, seq, body }) => {
    const text = JSON.stringify(body);
    console.log(`recv [${name}] seq=${seq} ${text.length > 600 ? `${text.slice(0, 600)}...` : text}`);
  });
  client.on('warn', (message) => console.log(`warn: ${message}`));
  client.on('fatal', (info) => console.log(`fatal: ${JSON.stringify(info)}`));

  const response = await client.connect(login);
  console.log('login ok:', JSON.stringify({
    result: response.result,
    initSeqNo: response.initSeqNo,
    nickname: response.playerInfo?.nickname,
    level: response.playerInfo?.level,
    power: response.playerInfo?.power,
  }));

  if (probes) {
    for (const name of READ_ONLY_PROBES) {
      const responseName = `${name.slice(0, -7)}Response`;
      try {
        const body = await client.request(name, {}, responseName, 8000);
        const text = JSON.stringify(body);
        console.log(`probe [${name}] ok ${text.length > 400 ? `${text.slice(0, 400)}...` : text}`);
      } catch (error) {
        console.log(`probe [${name}] failed: ${error.message}`);
      }
    }
  }

  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  client.stop();
}

// Read-only: list the worlds this account has roles on, plus the user info for the
// world the account currently sits in. Passing a worldId adds a second connection that
// enters that world and prints its user info (see the newRole warning below).
async function worlds({ worldId = null, group = false, seconds = 0 }) {
  const { url, login } = loadCredentials();
  const protocol = loadProtocol();
  const client = new GameClient({ url, protocol });
  client.on('warn', (message) => console.log(`warn: ${message}`));
  client.on('fatal', (info) => console.log(`fatal: ${JSON.stringify(info)}`));

  const response = await client.connect(login);
  console.log(`current world (login worldId=0), user info:`);
  console.log(JSON.stringify(describeRole(response.playerInfo), null, 2));

  const worlds = await listWorlds(client);
  console.log(`\nworlds on this account (latestGroupId=${worlds.latestGroupId}, count=${worlds.recentWorlds.length}):`);
  for (const world of worlds.recentWorlds) {
    const role = world.role || {};
    const moved = role.worldId && role.worldId !== world.worldId ? ` -> ${role.worldName ?? role.worldId}（${role.worldId}）` : '';
    console.log(`  ${world.worldName ?? '未知区服'}（worldId=${world.worldId}）${moved} tag=${world.tag} ${role.nickname ?? ''} lv=${role.level ?? ''} power=${role.power ?? ''} lastLogin=${role.lastLoginTime ?? ''}`);
  }

  if (group && worlds.latestGroupId) {
    const all = await listGroup(client, worlds.latestGroupId);
    console.log(`\nworlds in group ${worlds.latestGroupId} (count=${all.length}):`);
    for (const world of all) console.log(`  ${world.worldName ?? '未知区服'}（worldId=${world.worldId}） tag=${world.tag}`);
  }

  const worldIds = new Set(worlds.recentWorlds.map((world) => world.worldId));
  client.stop();

  if (worldId !== null) {
    const entered = await enterWorld({ url, login, protocol }, worldId);
    const player = entered.player || {};
    console.log(`\nentered ${worldName(player.worldId) ?? '未知区服'}（worldId=${player.worldId}，requested ${worldId}）, user info:`);
    console.log(JSON.stringify(describeRole(player), null, 2));
    if (!worldIds.has(worldId)) console.log(`note: worldId=${worldId} was not in the account's world list`);
    if (player.newRole) console.log('warning: newRole=true — this login created a role in that world');
    if (seconds > 0) await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    entered.client.stop();
  }
}

// Read-only: fire the whole post-login query set and dump what the game state is.
async function state({ raw = false, out = null }) {
  const { url, login } = loadCredentials();
  const protocol = loadProtocol();
  const client = new GameClient({ url, protocol });
  client.on('warn', (message) => console.log(`warn: ${message}`));
  client.on('fatal', (info) => console.log(`fatal: ${JSON.stringify(info)}`));

  const response = await client.connect(login);
  const loginRole = describeRole(response.playerInfo);
  console.log(`login ok: ${loginRole?.nickname} world=${loginRole?.worldName ?? loginRole?.worldId}`);

  const started = Date.now();
  const { ok, failed } = await collectState(client, protocol, {
    onResult: (name, body, error) => {
      const size = error ? `failed: ${error.message}` : `${JSON.stringify(body).length}B`;
      console.log(`  ${error ? 'x' : '.'} ${name} ${size}`);
    },
  });
  console.log(`collected ${Object.keys(ok).length} responses, ${Object.keys(failed).length} failed in ${Date.now() - started}ms`);
  for (const [name, message] of Object.entries(failed)) console.log(`  failed ${name}: ${message}`);

  if (out) {
    fs.writeFileSync(out, `${JSON.stringify({ login: loginRole, ok, failed }, null, 1)}\n`);
    console.log(`state written to ${out}`);
  }
  if (raw) {
    for (const [name, body] of Object.entries(ok)) {
      const text = JSON.stringify(body);
      console.log(`\n=== ${name} ${text.length}B ===`);
      console.log(text.length > 2000 ? `${text.slice(0, 2000)}...` : text);
    }
  } else {
    console.log(`\n${formatState(summarize({ ok }, { config: loadConfigSafe() }))}`);
  }
  client.stop();
}


const asArray = (value) => (Array.isArray(value) ? value : []);

// 一键领取：先采集状态判定哪些能领，再逐个执行，最后重新采集做前后对比。
// 只包含领取类动作，不改动任何需要消耗资源的东西。
function planLoot(ok, now, config = null, level = 1) {
  const plan = [];
  const claimable = (list) => asArray(list).filter((task) => task.progress >= task.targetProgress && !task.rewardClaimed);

  plan.push({ id: 'emailQuickGet', params: {}, why: '邮件一键领取' });

  const daily = ok.DailyTaskInfoRequest;
  for (const task of claimable(daily?.dailyTask)) plan.push({ id: 'dailyTaskDraw', params: { id: task.id }, why: `每日任务 ${task.id}` });

  // 活跃度宝箱排在任务奖励之后：任务奖励本身会加活跃度，顺序反了会白跑一轮。
  for (const action of planChests(daily, config).actions) {
    plan.push({
      id: action.request === 'DrawWeeklyRewardRequest' ? 'weeklyRewardDraw' : 'dailyRewardDraw',
      params: { index: action.body.index },
      why: action.note,
    });
  }

  // 每日精选那档免费赠礼，和活跃度宝箱无关，单独看 DailyGiftPackResponse.drawnPack。
  for (const action of planDailyGift(ok.DailyGiftPackResponse).actions) {
    plan.push({ id: 'freeDailyPackDraw', params: { packId: action.body.packId }, why: action.note });
  }

  const achievement = ok.AchievementInfoRequest;
  for (const task of claimable(achievement?.task)) plan.push({ id: 'achievementDraw', params: { id: task.id }, why: `成就 ${task.id}` });

  const afk = ok.AfkInfoRequest?.afkInfo;
  if (afk && afk.afkFinishTime > 0 && now >= afk.afkFinishTime) {
    plan.push({ id: 'afkDraw', params: {}, why: '挂机本段收益' });
  }
  // 等级奖励的可领等级由 OfflineLvRewardCfg 决定，不是 rewardedLevel+1，也不能超过当前挂机等级。
  if (afk && config) {
    const level = config.nextAfkRewardLevel(afk.rewardedLevel ?? 0);
    if (level !== null && level <= (afk.level ?? 0)) {
      plan.push({ id: 'afkLevelDraw', params: { level }, why: `挂机等级 ${level} 奖励` });
    }
  }

  for (const building of asArray(ok.OnWaterRequest?.building)) {
    // 竣工与建造只能二选一：同一轮先竣工再建造，竣工后它已不是 level 0，建造必被拒。
    const finishing = building.buildFinishTime > 0 && now >= building.buildFinishTime;
    if (finishing) {
      plan.push({ id: 'buildingFinish', params: { buildingId: building.buildingId }, why: `${building.buildingId} 竣工` });
    }
    if (asArray(building.factory?.finishedProducts).length > 0) {
      plan.push({ id: 'factoryGain', params: { buildingId: building.buildingId }, why: `${building.buildingId} 工厂成品` });
    }
    if (asArray(building.product?.asset).length > 0) {
      plan.push({ id: 'buildingCollect', params: { buildingId: building.buildingId }, why: `${building.buildingId} 建筑产物` });
    }
    // level=0 是想盖还没盖的空位，够等级就顺手盖掉（level 1 行的消耗与耗时都是空的）。
    if (building.level === 0 && !finishing && config) {
      const type = resolveBuildingType(config)(building.buildingId);
      const row = type ? upgradeRow(config, type, 1) : null;
      if (row && asArray(row.condition).length === 0 && row.playerLevel <= level) {
        plan.push({ id: 'buildBuilding', params: { buildingId: building.buildingId }, why: `建造 ${building.buildingId}（需等级 ${row.playerLevel}）` });
      }
    }
  }
  return plan;
}

const KEY_FIELDS = (ok) => {
  const afk = ok.AfkInfoRequest?.afkInfo;
  const daily = ok.DailyTaskInfoRequest;
  const heroes = asArray(ok.AllHeroRequest?.heroes);
  const items = asArray(ok.AllItemRequest?.items);
  return {
    挂机等级: afk ? `${afk.level} 已领${afk.rewardedLevel} 封顶至${afk.afkFinishTime}` : '-',
    每日任务已完成: daily ? `${asArray(daily.dailyTask).filter((t) => t.progress >= t.targetProgress).length} 个` : '-',
    邮件未领: ok.EmailBoxRequest ? asArray(ok.EmailBoxRequest.email).filter((m) => !m.got).length : '-',
    道具总数: items.length,
    装备数: asArray(ok.EquipsRequest?.equip).length,
    英雄战力: heroes.reduce((sum, hero) => sum + hero.power, 0),
  };
};

// 领取类动作：先判定后执行，最后重新采集对比。即发即弃的请求在断开前留出排空时间。
async function loot({ allowMutate, dryRun = false }) {
  const { url, login } = loadCredentials();
  const protocol = loadProtocol();
  const client = new GameClient({ url, protocol });
  client.on('warn', (message) => console.log(`warn: ${message}`));
  client.on('fatal', (info) => console.log(`fatal: ${JSON.stringify(info)}`));

  const response = await client.connect(login);
  const loginRole = describeRole(response.playerInfo);
  console.log(`login ok: ${loginRole?.nickname} world=${loginRole?.worldName ?? loginRole?.worldId}`);
  const config = loadConfigSafe();
  try {
    const before = (await collectState(client, protocol)).ok;
    const now = Date.now() / 1000;
    const plan = planLoot(before, now, config, loginRole?.level ?? 1);

    console.log(`\n可领取 ${plan.length} 项:`);
    for (const step of plan) console.log(`  ${step.id} ${JSON.stringify(step.params)} — ${step.why}`);

    if (dryRun) {
      console.log('\n--dry：只列出计划，未执行任何动作');
      return;
    }

    console.log('\n执行:');
    let failed = 0;
    for (const step of plan) {
      try {
        assertAllowed(step.id, { allowMutate });
        const result = await runAction(client, protocol, step.id, step.params, { allowMutate });
        const detail = result.body ? ` ${JSON.stringify(normalize(result.body)).slice(0, 200)}` : ' 即发即弃';
        console.log(`  . ${result.sent} ${JSON.stringify(step.params)}${detail}`);
      } catch (error) {
        failed += 1;
        console.log(`  x ${step.id} ${JSON.stringify(step.params)} 失败: ${error.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    await new Promise((resolve) => setTimeout(resolve, 1500));
    const after = (await collectState(client, protocol)).ok;
    console.log(`\n执行 ${plan.length - failed} 项成功，${failed} 项失败`);
    console.log('\n前后对比:');
    const a = KEY_FIELDS(before);
    const b = KEY_FIELDS(after);
    for (const key of Object.keys(a)) {
      const changed = String(a[key]) !== String(b[key]);
      console.log(`  ${changed ? '变' : '  '} ${key}: ${a[key]} -> ${b[key]}`);
    }
  } finally {
    client.stop();
  }
}

// One protocol call. Mutating actions need CW_ALLOW_MUTATE=1; without it the run stops
// before anything leaves the socket.
async function act({ id, params, allowMutate }) {
  assertAllowed(id, { allowMutate });
  buildBody(ACTIONS[id], params);
  const { url, login } = loadCredentials();
  const protocol = loadProtocol();
  const client = new GameClient({ url, protocol });
  client.on('warn', (message) => console.log(`warn: ${message}`));
  client.on('fatal', (info) => console.log(`fatal: ${JSON.stringify(info)}`));

  await client.connect(login);
  try {
    const result = await runAction(client, protocol, id, params, { allowMutate });
    console.log(`${result.sent}${result.response ? ` -> ${result.response}` : ' (无响应，回包走推送或 OkResponse)'}`);
    if (result.body) console.log(JSON.stringify(normalize(result.body), null, 2));
  } finally {
    client.stop();
  }
}

// 英雄养成：先按客户端红点条件算计划，--dry 只打印，--yes 才真发请求。
async function heroes({ allowMutate, dryRun, allowUniversal }) {
  const { url, login } = loadCredentials();
  const protocol = loadProtocol();
  const client = new GameClient({ url, protocol });
  client.on('warn', (message) => console.log(`warn: ${message}`));
  client.on('fatal', (info) => console.log(`fatal: ${JSON.stringify(info)}`));

  const response = await client.connect(login);
  const config = loadConfigSafe();
  try {
    const heroList = await client.request('AllHeroRequest', {}, 'AllHeroResponse', 15000);
    const itemList = await client.request('AllItemRequest', {}, 'AllItemResponse', 15000);
    const counts = new Map();
    for (const item of itemList.items ?? []) {
      const id = item.itemId ?? item.id;
      counts.set(id, (counts.get(id) ?? 0) + Number(item.num ?? item.count ?? 0));
    }
    const itemNum = (id) => counts.get(id) ?? 0;
    const playerLevel = describeRole(response.playerInfo).level;
    const plan = planHeroes({ config, heroes: heroList.heroes ?? [], itemNum, playerLevel, allowUniversal });
    console.log(`玩家等级 ${playerLevel}，英雄等级上限 ${plan.maxLevel}，星级上限 ${plan.maxStar}`);
    console.log(formatHeroPlan(plan));
    const requests = plan.steps.reduce((sum, step) => sum + (step.kind === 'level' ? step.count : 1), 0);
    console.log(`\n共 ${plan.steps.length} 个步骤 / ${requests} 个请求`);

    if (dryRun) {
      console.log('\n--dry：只列计划，未执行');
      return;
    }
    await runHeroPlan(client, protocol, plan, {
      allowMutate,
      timeout: 8000,
      onStep: (entry) => {
        const step = entry.step;
        const label = step.kind === 'level' ? `${step.heroId} 目标 lv${entry.targetLevel}` : step.kind === 'star' ? `${step.heroId} ${step.to}星` : `${step.heroId} 技能${step.slot + 1}`;
        if (entry.skipped) console.log(`  - ${label} 已跳过：${entry.error}`);
        else console.log(entry.ok ? `  . ${label}` : `  x ${label} 失败: ${entry.error}`);
      },
    });
    const after = await client.request('AllHeroRequest', {}, 'AllHeroResponse', 15000);
    console.log('\n养成后:');
    for (const hero of after.heroes ?? []) console.log(`  ${hero.heroId} lv${hero.level} ${hero.star}星 战力${hero.power} 技能${JSON.stringify(hero.skillLevels)}`);
  } finally {
    client.stop();
  }
}

// 日常：先只读探一遍（--dry 到这里就够），--yes 才执行，--paid 才允许花钻石的动作。
async function dailies({ allowMutate, dryRun, allowPaid }) {
  const { url, login } = loadCredentials();
  const protocol = loadProtocol();
  const client = new GameClient({ url, protocol });
  client.on('warn', (message) => console.log(`warn: ${message}`));
  client.on('fatal', (info) => console.log(`fatal: ${JSON.stringify(info)}`));

  const response = await client.connect(login);
  const config = loadConfigSafe();
  try {
    const loginRole = describeRole(response.playerInfo);
    console.log(`login ok: ${loginRole?.nickname} world=${loginRole?.worldName ?? loginRole?.worldId}`);
    const survey = await surveyDailies(client, protocol, { config, player: response.playerInfo });
    console.log(`\n${formatSurvey(survey)}\n`);
    for (const entry of survey.tasks) {
      for (const action of entry.actions ?? []) console.log(`  ${entry.task.id} ${action.request} ${JSON.stringify(action.body)} — ${action.note} (${action.cost})`);
    }

    if (dryRun) {
      console.log('\n--dry：只列计划，未执行');
      return;
    }

    console.log('\n执行:');
    await runDailies(client, protocol, survey, {
      allowMutate,
      allowPaid,
      onStep: (entry) => {
        if (entry.skipped) console.log(`  - ${entry.title} 跳过: ${entry.reason}`);
        else console.log(entry.ok ? `  . ${entry.title} ${entry.note}` : `  x ${entry.title} ${entry.note} 失败: ${entry.error}`);
      },
    });

    // 完成数变化只认服务端回包，重新拉一次对照。
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const after = await surveyDailies(client, protocol, { config, player: response.playerInfo });
    console.log('\n任务进度对比:');
    const before = new Map(survey.tasks.map((entry) => [entry.task.id, entry.task]));
    for (const entry of after.tasks) {
      const was = before.get(entry.task.id);
      const a = `${was?.progress ?? 0}/${was?.targetProgress ?? 0}`;
      const b = `${entry.task.progress}/${entry.task.targetProgress}`;
      console.log(`  ${a !== b ? '变' : '  '} ${entry.task.title}: ${a} -> ${b}`);
    }
    // runDailies 已经把任务奖励、活跃度宝箱与每日赠礼收尾了，这里只把剩下的状态摆出来。
    console.log(`\n${formatSurvey(after).split('\n').filter((line) => line.startsWith('活跃奖励') || line.startsWith('每日赠礼')).join('\n')}`);
    if (after.ruby !== survey.ruby) console.log(`\n钻石 ${survey.ruby} -> ${after.ruby}`);
  } finally {
    client.stop();
  }
}

// 任务领取：主线 / 支线 / 成就 / 每日订单档位。--dry 只列判定，--yes 才真领。
async function tasks({ allowMutate, dryRun }) {
  const { url, login } = loadCredentials();
  const protocol = loadProtocol();
  const client = new GameClient({ url, protocol });
  client.on('warn', (message) => console.log(`warn: ${message}`));
  client.on('fatal', (info) => console.log(`fatal: ${JSON.stringify(info)}`));

  const response = await client.connect(login);
  const config = loadConfigSafe();
  try {
    console.log(`login ok: ${describeRole(response.playerInfo)?.nickname} lv${describeRole(response.playerInfo)?.level}`);
    const survey = await surveyTasks(client, protocol, { config, player: response.playerInfo });
    console.log(`\n${formatTaskPlan(survey)}\n`);
    for (const step of survey.plan) {
      const reward = step.reward ? ` 奖励 ${step.reward.map(([id, num]) => `${id}x${num}`).join(',')}` : '';
      console.log(`  ${step.request} ${JSON.stringify(step.body)} — ${step.label}${reward}`);
    }
    console.log(`\n共 ${survey.plan.length} 条可领`);

    if (dryRun) {
      console.log('--dry：只列判定，未领取');
      return;
    }

    console.log('\n领取:');
    await runTasks(client, protocol, survey, {
      allowMutate,
      onStep: (entry) => {
        if (entry.skipped) console.log(`  - ${entry.step.label} 跳过: ${entry.error}`);
        else console.log(entry.ok ? `  . ${entry.step.label}` : `  x ${entry.step.label} 失败: ${entry.error}`);
      },
    });

    // 领没领到只认服务端回包，重新探一遍对照。
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const after = await surveyTasks(client, protocol, { config, player: response.playerInfo });
    console.log(`\n领取后剩余可领 ${after.plan.length} 条:`);
    for (const step of after.plan) console.log(`  ${step.label}`);
  } finally {
    client.stop();
  }
}

// 海面世界：收成品 / 竣工 / 交单 / 排产 / 余料升级建筑。--dry 只列计划，--yes 才真发请求。
// --speed-up 才允许花「加速器」（钻石永远不碰）；--reroll 才允许拒绝材料不齐的订单。
async function world({ allowMutate, dryRun, allowSpeedUp, allowReroll }) {
  const { url, login } = loadCredentials();
  const protocol = loadProtocol();
  const client = new GameClient({ url, protocol });
  client.on('warn', (message) => console.log(`warn: ${message}`));
  client.on('fatal', (info) => console.log(`fatal: ${JSON.stringify(info)}`));

  const response = await client.connect(login);
  const config = loadConfigSafe();
  try {
    console.log(`login ok: ${describeRole(response.playerInfo)?.nickname} lv${describeRole(response.playerInfo)?.level}`);
    const survey = await surveyWorld(client, protocol, { config, player: response.playerInfo });
    const plan = planWorld(survey, { config, allowSpeedUp, allowReroll });
    console.log(`\n${formatWorldPlan(survey, plan)}\n`);
    console.log(`共 ${plan.actions.length} 个动作${allowSpeedUp ? '' : '（未开 --speed-up，不会花' + SPEED_UP_ITEM + '）'}`);

    if (dryRun) {
      console.log('--dry：只列计划，未执行');
      return;
    }

    console.log('\n执行:');
    const { rejected } = await runWorldRound(client, protocol, plan, {
      config, player: response.playerInfo, allowMutate,
      onStep: (entry) => {
        if (entry.skipped) console.log(`  - ${entry.step.label} 跳过: ${entry.error}`);
        else console.log(entry.ok ? `  . ${entry.step.label}` : `  x ${entry.step.label} 失败: ${entry.error}`);
      },
    });
    if (rejected.size) console.log(`本轮被拒 ${rejected.size} 条`);

    // 前面对照只认重新探测的结果。
    await new Promise((resolve) => setTimeout(resolve, 1200));
    let after;
    try { after = await surveyWorld(client, protocol, { config, player: response.playerInfo }); }
    catch (error) { console.error('海面操作已结束，刷新状态失败：' + error.message); return; }
    console.log(`\n对照: 人口 ${survey.population}/${survey.maxPopulation} -> ${after.population}/${after.maxPopulation}`);
    console.log(`  库存种类 ${survey.stock.size} -> ${after.stock.size}，订单 ${survey.orders.length} -> ${after.orders.length}`);
    const changed = survey.buildings.filter((b) => {
      const now = after.buildings.find((x) => x.buildingId === b.buildingId);
      return now && now.level !== b.level;
    });
    for (const b of changed) {
      const now = after.buildings.find((x) => x.buildingId === b.buildingId);
      console.log(`  变 ${b.buildingId} lv${b.level} -> lv${now.level}`);
    }
    for (const key of ['建筑蓝图', 'GOLD', SPEED_UP_ITEM, '木材', '玻璃', '塑料', '碎布', '金属', '海藻']) {
      const a = survey.have(key);
      const b = after.have(key);
      if (a !== b) console.log(`  变 ${key} ${a} -> ${b}`);
    }
  } finally {
    client.stop();
  }
}

// 资源田：默认只读报告；occupy / giveup 需要显式 gridIdx 与 --yes。
// 占田要求「该田所属城是我方城 + 有闲置且耐久>0 的舰队」，条件不满足就直接拒绝，不发请求。
async function field({ sub, gridIdx, fleets, allowMutate }) {
  const { url, login } = loadCredentials();
  const protocol = loadProtocol();
  const client = new GameClient({ url, protocol });
  client.on('warn', (message) => console.log(`warn: ${message}`));
  client.on('fatal', (info) => console.log(`fatal: ${JSON.stringify(info)}`));

  const response = await client.connect(login);
  const config = loadConfigSafe();
  try {
    const player = response.playerInfo;
    let map = null;
    try {
      map = await loadMapAsset(Number(player?.scenarioId ?? 0), config?.resources ?? null);
    } catch (error) {
      console.log(`warn: 地图资源读取失败 (${error.message})`);
    }
    const survey = await surveyWorld(client, protocol, { config, player });
    console.log(formatFieldReport(survey, map));

    if (!sub) return;
    const grid = Number(gridIdx);
    if (!Number.isFinite(grid)) throw new Error('usage: node src/app.mjs field [occupy|giveup <gridIdx>] [--fleets a,b]');
    const fleetIds = (fleets ?? '').split(',').map((s) => s.trim()).filter(Boolean);

    let planned;
    if (sub === 'occupy') {
      const at = map?.fieldAt(grid);
      if (map && !at) throw new Error(`gridIdx=${grid} 在地图上不是资源田`);
      if (at) console.log(`地图: gridIdx=${grid} 属于城 ${at.cityId}，类型 ${at.resType}`);
      planned = planFieldOccupy(survey, grid, { fleetBuildingIds: fleetIds });
    } else if (sub === 'giveup') {
      planned = planFieldGiveUp(survey, grid);
    } else {
      throw new Error(`未知子命令 ${sub}`);
    }
    if (planned.error) throw new Error(planned.error);

    console.log(`${planned.action.label} -> ${planned.action.request} ${JSON.stringify(planned.action.body)}`);
    if (!allowMutate) {
      console.log('未加 --yes，只打印计划，未发送');
      return;
    }
    const { rejected } = await runWorld(client, protocol, { actions: [planned.action], notes: [] }, {
      allowMutate,
      onStep: (entry) => console.log(entry.ok ? '  . 已发送' : `  x ${entry.error}`),
    });
    if (rejected.size) console.log('被服务端拒绝（PromptResponse），未生效');
  } finally {
    client.stop();
  }
}

// 自动循环：任务 → 日常 → 海面，每轮之间睡 --every 秒。必须显式开，Ctrl-C 收尾后退出。
async function loopCli({ allowMutate, rounds, everySeconds, allowSpeedUp, allowReroll, allowPaid }) {
  const { url, login } = loadCredentials();
  const protocol = loadProtocol();
  const client = new GameClient({ url, protocol });
  client.on('warn', (message) => console.log(`warn: ${message}`));
  client.on('fatal', (info) => console.log(`fatal: ${JSON.stringify(info)}`));

  const stop = { aborted: false };
  const onSigint = () => {
    stop.aborted = true;
    console.log('\n收到 Ctrl-C：本轮结束后退出');
  };
  const resources = createResourceUpdater({ onEvent: ({ message }) => console.log(message) });
  process.on('SIGINT', onSigint);
  try {
    await resources.start();
    if (stop.aborted) return;
    const response = await client.connect(login);
    const config = loadConfigSafe();
    const player = response.playerInfo;
    console.log(`login ok: ${describeRole(player)?.nickname} lv${describeRole(player)?.level}，${rounds > 0 ? `共 ${rounds} 轮` : '一直跑（Ctrl-C 停）'}，间隔 ${everySeconds}s`);
    console.log(`开关: 加速=${allowSpeedUp ? '开(只花' + SPEED_UP_ITEM + ')' : '关'} 拒绝重刷=${allowReroll ? '开' : '关'}`);
    await runLoop(client, protocol, {
      config,
      refreshConfig: loadConfigSafe,
      player,
      rounds,
      everyMs: everySeconds * 1000,
      allowMutate,
      allowPaid,
      allowSpeedUp,
      allowReroll,
      stop,
      onRound: (summary) => console.log(`\n${formatLoopRound(summary)}`),
      onStep: entry => console.log('  ' + formatLoopStep(entry)),
    });
  } finally {
    await resources.stop();
    process.off('SIGINT', onSigint);
    client.stop();
  }
}

// 交互式输入密码时不回显；管道或非 TTY 环境直接读一行。
function readSecret(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(prompt, (answer) => { rl.close(); resolve(answer); });
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let muted = true;
    rl._writeToOutput = function writeToOutput(text) {
      if (!muted || text === '\r\n' || text === '\n') this.output.write(text);
    };
    rl.question(prompt, (answer) => {
      muted = false;
      rl.close();
      resolve(answer);
    });
  });
}

function maskedPhone(value) {
  const text = String(value ?? '');
  if (/^1\d{10}$/.test(text)) return `${text.slice(0, 3)}****${text.slice(-4)}`;
  return text;
}

// 账号管理：列、改名、切换、删除、看凭证。抓包走 tools/capture-credentials.mjs
// 或网页控制台；手机号登录走下面的 accounts login-phone。
async function accountsCli(args) {
  const sub = args.find((arg) => !arg.startsWith('--')) ?? 'list';
  const rest = args.filter((arg) => !arg.startsWith('--') && arg !== sub);
  const store = loadStore();

  if (sub === 'login-phone') {
    const { values } = parseArgs({
      args: args.slice(1),
      allowPositionals: false,
      options: {
        phone: { type: 'string' },
        password: { type: 'string' },
        code: { type: 'string' },
        label: { type: 'string' },
        probe: { type: 'boolean' },
        save: { type: 'boolean' },
        yes: { type: 'boolean' },
        connect: { type: 'boolean' },
        help: { type: 'boolean' },
      },
    });
    if (values.help) {
      console.log(`node src/app.mjs accounts login-phone --phone <手机号或账号> [--password 密码 | --code 短信验证码]
  可选: --label 备注  --probe  --save  --yes  --connect
默认只打印结果，不加 --save 不写入；新 openId 需要 --yes 才写入。也可用 CW_PHONE / CW_PHONE_PASSWORD / CW_PHONE_CODE。`);
      return;
    }
    const phone = values.phone ?? process.env.CW_PHONE;
    if (!phone) throw new Error('缺少 --phone（手机号或账号），也可设置 CW_PHONE');
    let password = values.password ?? process.env.CW_PHONE_PASSWORD;
    const code = values.code ?? process.env.CW_PHONE_CODE;
    if (!password && !code) password = await readSecret('登录密码（留空则改用已获取的短信验证码）: ');
    if (!password && !code) code = await readSecret('短信验证码: ');
    if (!password && !code) throw new Error('密码和短信验证码至少填一个');

    const client = createPhoneLogin();
    const result = password
      ? await client.loginWithPassword(phone, password)
      : await client.loginWithSms(phone, code);

    if (values.probe) {
      const keys = Object.keys(result.session ?? {}).sort();
      console.log('益世界账号登录成功');
      console.log(`响应字段: ${keys.join(', ') || '（空）'}`);
      console.log(`候选游戏 uid: ${client.candidateUids(result).join(', ') || '（无）'}`);
      console.log(`openId=${result.ewan?.openId ?? '无'}  token=${result.ewan?.token ? client.mask(result.ewan.token) : '无'}  sign=${result.ewan?.sign ? client.mask(result.ewan.sign) : '无'}`);
      return;
    }

    const game = await client.gameLogin(result);
    const credential = client.credential(game, { account: phone });
    const params = credential.login.eworldParams;
    console.log('益世界账号登录成功');
    if (result.ewan?.userName) console.log(`账号: ${result.ewan.userName}  手机: ${maskedPhone(phone)}`);
    console.log(`游戏 uid=${game.uid}`);
    console.log(`openId=${params.openId}  token=${client.mask(params.token)}  sign=${client.mask(params.sign)}`);

    const existing = store.accounts.find((account) => account.id === params.openId);
    if (!values.save) {
      console.log('未加 --save，未写入账号');
      return;
    }
    if (!existing && !values.yes) {
      console.log('这个 openId 还不是已保存账号；确认要新建账号再加 --yes');
      return;
    }
    const { account, created } = upsertAccount(store, credential, {
      label: values.label ?? existing?.label ?? maskedPhone(phone),
    });
    setActive(store, account.id);
    saveStore(store);
    console.log(`${created ? '已新增' : '已更新'}账号 ${describeAccount(account).title}，当前账号已切换`);

    if (values.connect) {
      if (!values.yes) {
        console.log('连接验证会用新凭证登录并可能让现有会话掉线；确认后加 --yes');
        return;
      }
      const protocol = loadProtocol();
      const gameClient = new GameClient({ url: account.url, protocol });
      gameClient.on('warn', (message) => console.log(`warn: ${message}`));
      try {
        const response = await gameClient.connect(account.login);
        const player = response.playerInfo ?? {};
        console.log(`连接成功：${player.nickname ?? '未知昵称'} lv${player.level ?? '?'} 区服${worldName(player.worldId) ?? '?'}`);
      } finally {
        gameClient.stop();
      }
    }
    return;
  }

  const mutate = () => {
    saveStore(store);
    console.log(`已写入 ${ACCOUNTS_PATH}`);
  };

  if (sub === 'list') {
    if (!store.accounts.length) {
      console.log(`还没有任何账号。抓一份凭证：node tools/capture-credentials.mjs`);
      if (fs.existsSync(LEGACY_CREDENTIALS_PATH)) console.log(`（${LEGACY_CREDENTIALS_PATH} 也没读出来）`);
      return;
    }
    for (const [index, account] of store.accounts.entries()) {
      const info = describeAccount(account, { active: account.id === store.activeId });
      const seen = info.lastSeen;
      const tail = seen
        ? `lv${seen.level ?? '?'} 战力${seen.power ?? '?'} 区服${seen.worldName ?? seen.worldId ?? '?'}`
        : '（还没连上过）';
      console.log(`${info.active ? '*' : ' '} ${index + 1}. ${info.title}  ${tail}`);
      console.log(`     openId ${info.id}  凭证抓于 ${info.capturedAt ?? '未知'}`);
    }
    return;
  }

  if (sub === 'use') {
    const account = pickAccount(store, rest[0]);
    if (!account) throw new Error('用法: node src/app.mjs accounts use <id|昵称|序号>');
    setActive(store, account.id);
    mutate();
    console.log(`当前账号: ${describeAccount(account).title}`);
    return;
  }

  if (sub === 'label') {
    const account = pickAccount(store, rest[0]);
    if (!account || !rest[1]) throw new Error('用法: node src/app.mjs accounts label <id|昵称|序号> <新名字>');
    account.label = rest[1];
    mutate();
    return;
  }

  if (sub === 'remove' || sub === 'rm') {
    const account = pickAccount(store, rest[0]);
    if (!account) throw new Error('用法: node src/app.mjs accounts remove <id|昵称|序号>');
    removeAccount(store, account.id);
    mutate();
    console.log(`已删除 ${describeAccount(account).title}（原文件里的凭证会一起没掉）`);
    return;
  }

  if (sub === 'show') {
    const account = pickAccount(store, rest[0]);
    if (!account) throw new Error('用法: node src/app.mjs accounts show <id|昵称|序号>');
    console.log(JSON.stringify(revealAccount(account), null, 2));
    return;
  }

  throw new Error(`未知子命令 ${sub}。可用: list / use / label / remove / show`);
}

async function main() {
  const mode = process.argv[2] || 'console';

  if (mode === 'selftest') {
    await import('./selftest.mjs');
    return;
  }

  if (mode === 'accounts') {
    await accountsCli(process.argv.slice(3));
    return;
  }

  if (mode === 'connect') {
    await headless({ seconds: Number(process.argv[3] ?? 60) });
    return;
  }

  if (mode === 'probe') {
    await headless({ seconds: 0 });
    return;
  }

  if (mode === 'actions') {
    for (const action of listActions()) {
      const params = action.params.length ? ` <${action.params.join('> <')}>` : '';
      console.log(`${action.mutate ? '改状态' : '只读'}  ${action.id}${params}`);
      console.log(`        ${action.request} — ${action.desc}`);
    }
    return;
  }

  if (mode === 'act') {
    const id = process.argv[3];
    if (!id) throw new Error('usage: node src/app.mjs act <actionId> [k=v ...]');
    const params = {};
    for (const token of process.argv.slice(4).filter((arg) => !arg.startsWith('--'))) {
      const at = token.indexOf('=');
      if (at < 0) throw new Error(`parameter must be k=v, got: ${token}`);
      params[token.slice(0, at)] = token.slice(at + 1);
    }
    await act({
      id,
      params,
      allowMutate: process.env.CW_ALLOW_MUTATE === '1' || process.argv.includes('--yes'),
    });
    return;
  }

  if (mode === 'config') {
    const config = getConfig();
    const name = process.argv[3];
    if (!name) {
      console.log(`本地配置表 ${config.names.length} 张:`);
      console.log(config.names.join(', '));
      return;
    }
    const table = config.tables[name];
    if (!table) throw new Error(`没有配置表 ${name}`);
    console.log(JSON.stringify(table, null, 1));
    return;
  }

  if (mode === 'loot') {
    await loot({
      dryRun: process.argv.includes('--dry'),
      allowMutate: process.env.CW_ALLOW_MUTATE === '1' || process.argv.includes('--yes'),
    });
    return;
  }

  if (mode === 'heroes') {
    await heroes({
      dryRun: process.argv.includes('--dry'),
      allowUniversal: !process.argv.includes('--no-universal'),
      allowMutate: process.env.CW_ALLOW_MUTATE === '1' || process.argv.includes('--yes'),
    });
    return;
  }

  if (mode === 'stages') {
    const { values } = parseArgs({ args: process.argv.slice(3), options: {
      'max-failures': { type: 'string' }, account: { type: 'string' }, yes: { type: 'boolean' },
      dry: { type: 'boolean' }, help: { type: 'boolean' },
    } });
    if (values.help) {
      console.log('node src/app.mjs stages [--account 账号] [--max-failures 次数] [--dry] [--yes]\n默认预览，同一关连续失败 3 次停止，过关后清零。');
      return;
    }
    const maxFailures = stageFailureLimit(values['max-failures']);
    const { url, login } = loadCredentials(values.account ?? process.env.CW_ACCOUNT ?? null);
    const config = getConfig();
    const client = new GameClient({ url, protocol: loadProtocol() });
    const controller = new AbortController();
    client.on('fatal', ({ reason }) => controller.abort(new Error(`连接中断：${reason}`)));
    client.on('close', () => controller.abort(new Error('游戏连接已断开')));
    client.on('error', (error) => controller.abort(error));
    try {
      const { playerInfo } = await client.connect(login);
      const result = await runStages(client, playerInfo, config, {
        maxFailures, signal: controller.signal,
        allowMutate: !values.dry && (values.yes || process.env.CW_ALLOW_MUTATE === '1'),
        onBattle: ({ stage, won, failures }) => console.log(won ? `主线第 ${stage} 关胜利` : `第 ${stage} 关连续失败 ${failures} 次`),
      });
      console.log(`本次通过 ${result.wins} 关。${result.reason}`);
    } finally {
      client.stop();
    }
    return;
  }

  if (mode === 'dailies') {
    await dailies({
      dryRun: process.argv.includes('--dry'),
      allowPaid: process.argv.includes('--paid'),
      allowMutate: process.env.CW_ALLOW_MUTATE === '1' || process.argv.includes('--yes'),
    });
    return;
  }

  if (mode === 'loop') {
    const at = (name, fallback) => {
      const i = process.argv.indexOf(name);
      return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
    };
    await loopCli({
      rounds: at('--rounds', 1),
      everySeconds: at('--every', 60),
      allowSpeedUp: process.argv.includes('--speed-up'),
      allowReroll: process.argv.includes('--reroll'),
      allowPaid: process.argv.includes('--paid'),
      allowMutate: process.env.CW_ALLOW_MUTATE === '1' || process.argv.includes('--yes'),
    });
    return;
  }

  if (mode === 'field') {
    const args = process.argv.slice(3).filter((arg) => !arg.startsWith('--'));
    const fleetsAt = process.argv.findIndex((arg) => arg === '--fleets');
    await field({
      sub: args[0] ?? null,
      gridIdx: args[1] ?? null,
      fleets: fleetsAt >= 0 ? process.argv[fleetsAt + 1] : null,
      allowMutate: process.env.CW_ALLOW_MUTATE === '1' || process.argv.includes('--yes'),
    });
    return;
  }

  if (mode === 'world') {
    await world({
      dryRun: process.argv.includes('--dry'),
      allowSpeedUp: process.argv.includes('--speed-up'),
      allowReroll: process.argv.includes('--reroll'),
      allowMutate: process.env.CW_ALLOW_MUTATE === '1' || process.argv.includes('--yes'),
    });
    return;
  }

  if (mode === 'tasks') {
    await tasks({
      dryRun: process.argv.includes('--dry'),
      allowMutate: process.env.CW_ALLOW_MUTATE === '1' || process.argv.includes('--yes'),
    });
    return;
  }

  if (mode === 'state') {
    await state({
      raw: process.argv.includes('--raw'),
      out: process.env.CW_STATE_OUT ?? (process.argv.includes('--out') ? 'data/state.json' : null),
    });
    return;
  }

  if (mode === 'worlds') {
    const arg = process.argv[3];
    await worlds({
      worldId: arg && arg !== 'all' ? Number(arg) : null,
      group: process.argv.includes('--group'),
      seconds: Number(process.env.CW_WORLD_HOLD ?? 0),
    });
    return;
  }

  const port = Number(process.env.CW_PORT ?? 17321);
  const output = consoleOutput = createConsoleOutput();
  const restoreOutput = () => output.restore();
  process.once('exit', restoreOutput);
  const console_ = createConsole({ port, onLog: entry => output.log(entry), resourceUpdates: true });
  const url = await console_.listen();
  output.start(url);
  let shuttingDown = false;
  const shutdown = async signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { await console_.close(); }
    catch (error) { output.write('关闭控制台失败：' + error.message); }
    finally { await output.close(); process.exit(signal === 'SIGINT' ? 130 : 0); }
  };
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  if (process.platform === 'win32') process.once('SIGBREAK', () => { void shutdown('SIGBREAK'); });
  const browser = process.env.CW_NO_BROWSER ? null : openBrowser(url);
  if (!process.env.CW_QUIET_START) {
    if (browser) output.write('已打开浏览器：' + browser);
    const store = loadStore();
    if (!store.accounts.length) {
      output.write(`还没有账号：打开 ${url}，在「账号」页选择「从电脑微信添加」或「从电脑抖音添加」，再从对应客户端重新进入游戏。`);
    } else {
      output.write(`账号 ${store.accounts.length} 个，当前: ${describeAccount(pickAccount(store, null)).title}`);
    }
  }
}

main().catch(async (error) => {
  await consoleOutput?.close();
  console.error(process.env.CW_DEBUG ? error : error.message);
  process.exitCode = 1;
});
