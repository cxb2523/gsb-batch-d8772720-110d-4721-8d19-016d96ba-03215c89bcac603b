import {checkFleetSettlement} from './fleet-settlement.mjs';
import { militaryRewards, riverActivity, edictPassActivity, compassActivity, beautyActivity } from './seasonal-activities.mjs';
import { claimComicDrama, claimTournamentDaily, openSeasonChests } from './side-rewards.mjs';
import { merchantActivity } from './merchant-activity.mjs';
import { runAllianceAutomation } from './alliance-automation.mjs';
import { serviceGuildShips, watchGuildShipPushes } from './guild-ships.mjs';
import { serviceGuildForts } from './guild-forts.mjs';
import { runSiliconMining, watchSiliconMining, siliconInterval } from './silicon-mining.mjs';
import { runHeroRaidAutomation } from './hero-raid-automation.mjs';
import { merchantMonitorSeconds, watchMerchant } from './merchant-monitor.mjs';
import {runPirateSweeps} from './pirate-sweeps.mjs';
import {claimGuildTitleReward} from './guild-title-rewards.mjs';
import {runWorldBoss,claimWorldBossDamage} from './world-boss.mjs';
import { claimOpenRank, claimFestivalActive, claimReportRewards, claimLeagueCollect, claimLeaguePass, claimWeekSupply } from './missing-rewards.mjs';
import { dispatchOrder, reserveDispatch, dispatchReservationReason, bridgeFleetReservations, legacyFleetReservationReason } from './fleet-availability.mjs';
import { runAllianceRadar } from './alliance-radar.mjs';
import { claimVipDaily, claimLimitedFree, claimWeekHeroStar, claimLinkageFree, recruitWithSkipAds } from './extra-free-rewards.mjs';
import { collectAntiqueFloaters } from './antique-floaters.mjs';
// 自动循环：每轮依次跑 任务领取 → 日常（含任务奖励与活跃度宝箱） → 海面（收成品/竣工/建造/交单/排产/升级）。
//
// 循环是显式开的：必须同时给 --loop 与 --yes，且每轮都是「先只读探测，再算计划，再执行」，
// 所以第二轮起没有可做的事时计划自然为空，不会重复发同样的请求。
// 被服务端拒过的具体动作记在 rejected 里跨轮传递（runTasks / runWorld 各自维护）。

import { claimCollection, collectFloaters } from './collections.mjs';
import { serviceCargo } from './cargo.mjs';
import { serviceBoats } from './boats.mjs';
import { sweepTrials } from './trials.mjs';
import { claimGuildWelfare } from './guild.mjs';
import { claimWorldOnlineReward } from './world-online-rewards.mjs';
import { runExtraTrialSweeps } from './trial-sweeps.mjs';
import { fishOnce } from './fishing.mjs';
import { upgradeFishingOnce } from './fishing-upgrade.mjs';
import { serviceHeroRecruitRewards } from './hero-recruit-rewards.mjs';
import { serviceAntiqueRecruit } from './antique-recruit.mjs';
import { claimAdShop, beginAdRound } from './ad-shop.mjs';
import { claimAfkAd, claimAdSpeedUps } from './ad-rewards.mjs';
import { rewardSchedule } from './reward-schedule.mjs';
import { normalize } from './worlds.mjs';
import { surveyTasks, runTasks } from './tasks.mjs';
import { surveyDailies, runDailies } from './dailies.mjs';
import { surveyWorld, planWorld, runWorldRound, displayBuilding } from './world.mjs';
import { createActionGuard, nativePreferenceEnabled, needsCargoDemand, exactAutomationId } from './automation-policy.mjs';
import { surveyBaseAutomation, planBaseAutomation, runBaseAutomation, baseDemands } from './base-automation.mjs';
import { hasBaseWork } from './automation-settings.mjs';
import { treasureAutomationEnabled, runTreasureLoot } from './treasure-loot.mjs';
import {watchTreasureTravel,matchesFollowDeparture} from './treasure-follow.mjs';
import {watchFleetMaintenance,fleetMaintenanceEnabled,fleetMaintenanceInterval,runFleetMaintenance} from './fleet-maintenance.mjs';
import { cityWarEnabled, cityWarReservedFleets, runCityWar } from './city-war.mjs';
import { forgeEnabled, runEquipmentForge } from './equipment-forge.mjs';
import { antiqueEnabled, runAntiqueUpgrade } from './antique-upgrade.mjs';
import { planHeroes, runHeroPlan } from './heroes.mjs';
import { serviceGuildOrders } from './guild-orders.mjs';
import { serviceRadar } from './radar.mjs';
import { serviceEquipmentCrafting } from './equipment-automation.mjs';
import { serviceMuseum } from './museum.mjs';
import { servicePetBreeding } from './pet-breeding.mjs';
import { serviceGuildAid } from './guild-aid.mjs';
import { serviceHeroGrowth, serviceStageAuto } from './progress-automation.mjs';
import { createChallengeRun, runChallengeRound } from './challenge-automation.mjs';
import { serviceTreasureLoot } from './treasure-loot.mjs';
import { claimFestivalRewards, claimWeeklyRewards, claimVipDaily as claimLegacyVipDaily, festivalRewardKeys, weeklyRewardKeys } from './free-rewards.mjs';
import { claimOpenRanks } from './pirate-board.mjs';
import { claimExtraRewards, extraRewardKeys } from './extra-rewards.mjs';

import { setTimeout as pause } from 'node:timers/promises';
import { claimRewards } from './claim-rewards.mjs';
import { claimWeekly, runLinkage, weekSchedule, readWeekOrder, runWeekOrder, activityView } from './activities.mjs';
import { automationTasks, dailyTaskKey, defaultFishingGoldReserve, defaultCompassSpinCount, worldTaskKey } from './automation.mjs';
import { isActivityTaskAvailable } from './activity-availability.mjs';

const defaultSleep = (ms, signal) => pause(ms, undefined, { signal });
const dailyActionKeys = {
  1002: ['freeRecruit', 'ticketRecruit'], 1005: ['arena'], 1006: ['freeGold', 'paidGold'],
  1007: ['shop'], 1010: ['pirate'],
};

function nextFactoryCheck(buildings, offset, collect) {
  const now = Date.now();
  let next = now + 30_000;
  for (const { factory } of buildings ?? []) {
    if (!factory) continue;
    if (collect && factory.finishedProducts?.length) next = now;
    for (const job of factory.factoryQ ?? []) {
      if (job.finishTime > 0) next = Math.min(next, job.finishTime * 1000 - offset + 250);
    }
  }
  return Math.max(now + 3000, next);
}

export async function runLoop(client, protocol, {
  config = null,
  refreshConfig = null,
  player = null,
  adChannel = {},
  rounds = 1,
  everyMs = 60_000,
  allowMutate = false,
  allowPaid = false,
  allowSpeedUp = false,
  allowReroll = false,
  sleep = defaultSleep,
  stop = { aborted: false },
  isEnabled,
  getFishingGoldReserve = () => defaultFishingGoldReserve,
  getCompassSpinCount = () => defaultCompassSpinCount,
  isStageBusy = () => false,
  isTrialBusy = () => false, isPirateBusy = () => false,
  challengeRun = createChallengeRun(),
  getSettings = () => null, onFishBookComplete,
  usageLedger = null,
  getEveryMs = () => everyMs,
  schedule = work => work(),
  onRound,
  onStep,
  onMaintenance,
} = {}) {
  if (!allowMutate) throw new Error('循环会持续改变账号状态，需要 --yes');
  const rejected = { tasks: new Set(), world: new Set() };
  const history = [];
  const rewards = isEnabled ? rewardSchedule(client) : null;
  bridgeFleetReservations(client, getSettings, usageLedger, exactAutomationId(player?.worldId));
  let lastRecruitWait;
  const dailyWaitReasons = new Map();
  const serviceWait = new Map();
  let lastFishWait;
  let lastFishUpgradeWait;
  let lastGuildWait;
  let merchantRoundSeconds = 0;
  const antiqueWait = new Map();
  let residentWait = new Map();
  let treasureAt = 0;
  let lastTreasureNotes = '';
  let radarAt=0;
  let siliconAt = 0, siliconPreference = null, extendedAt = 0, extendedPreference = null;
  const siliconNext = () => getSettings()?.silicon?.enabled ?
    (siliconPreference === getSettings().silicon ? siliconAt : 0) : Infinity;
  const extendedEnabled = () => getSettings()?.alliance?.enabled || getSettings()?.heroRaid?.enabled;
  const extendedNext = () => extendedEnabled() ? (extendedPreference === getSettings() ? extendedAt : 0) : Infinity;
  let cityWarAt = 0, forgeAt = 0, antiqueAt = 0, lastCityWarNotes = '', lastForgeNotes = '', lastAntiqueNotes = '';
  let cityWarState = null, cityWarPreference = null, forgePreference = null, antiquePreference = null, cityFuelCeiling = null;
  // rounds <= 0 表示一直跑，靠 stop.aborted（Ctrl-C 或网页停止按钮）退出。
  const total = rounds > 0 ? rounds : Infinity;
  const travel=watchTreasureTravel(client);
  const merchantMonitor = watchMerchant(client);
  const merchantIdentity = JSON.stringify([player?.playerId, player?.worldId, player?.guildId]);
  const merchantActive = () => Boolean(isEnabled && !stop.aborted && client.connected !== false
    && JSON.stringify([player?.playerId, player?.worldId, player?.guildId]) === merchantIdentity
    && isActivityTaskAvailable('merchantTrade', client) && nativePreferenceEnabled(getSettings(), 'merchantTrade')
    && isEnabled('merchantTrade'));
  const merchantNow = () => Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
  let merchantPending = false, merchantRunAfter = 0;
  const merchantNext = () => merchantActive()
    ? Math.max(merchantRunAfter, merchantMonitor.nextCheckAt * 1000 - (client.serverClockOffsetMs || 0)) : Infinity;
  let followWake=null,followPending=false,followVersion=0;
  let maintenanceAt=0,maintenancePending=false,maintenanceVersion=0;
  let siliconPending = false, siliconVersion = 0;
  const unsubscribeSilicon = watchSiliconMining(client).subscribe(() => {
    if (stop.aborted || !getSettings()?.silicon?.enabled) return;
    siliconAt = 0; siliconPending = true; siliconVersion++; followWake?.();
  });
  const settingsWake = () => { siliconAt = 0; extendedAt = 0; siliconVersion++; siliconPending = true;
    rewards?.clearTask('guildShip'); rewards?.clearTask('guildFort'); followWake?.(); };
  const extendedPush = ({ name }) => {
    if (/^SCGuildShip|^SCFort|^SCHeroRaid/.test(name) || ['SCAllActivity','SCGuildOrder','SCNewGuildAidAsk','SCGuildAidHelp','SCGuildAidRemove','SCNewGuildWelfarePack'].includes(name)) {
      extendedAt = 0; siliconPending = true; followWake?.();
    }
  };
  client.on?.('automationSettingsChanged', settingsWake); client.on?.('message', extendedPush);
  watchGuildShipPushes(client, rewards);
  const unsubscribeFollow=travel.subscribe(fleet=>{
    const preferences=getSettings()?.treasure;
    if(stop.aborted||!client.connected||!treasureAutomationEnabled(getSettings())||!matchesFollowDeparture(fleet,preferences,exactAutomationId(player?.playerId),travel.current()))return;
    treasureAt=0;followPending=true;followVersion++;followWake?.();
  });
  const unsubscribeMaintenance=watchFleetMaintenance(client).subscribe(()=>{
    if(stop.aborted||!client.connected||!fleetMaintenanceEnabled(getSettings()))return;
    maintenanceAt=0;maintenancePending=true;maintenanceVersion++;followWake?.();
  });
  const unsubscribeMerchant = merchantMonitor.subscribe(() => {
    if (!merchantActive()) return;
    merchantPending = true;
    followWake?.();
  });
  // 出发推送只唤醒现有调度，不在消息回调中并发发协议或绕过舰队优先级。
  async function waitWithFollow(ms,signal){
    if(followPending||maintenancePending||merchantPending||siliconPending){followPending=false;maintenancePending=false;merchantPending=false;siliconPending=false;return true;}
    const controller=new AbortController(),abort=()=>controller.abort(signal?.reason);
    if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
    let wake;const changed=new Promise(resolve=>{wake=()=>resolve(true);followWake=wake;});
    try{return await Promise.race([Promise.resolve(sleep(ms,controller.signal)).then(()=>false),changed]);}
    finally{if(followWake===wake)followWake=null;controller.abort();signal?.removeEventListener('abort',abort);}
  }
  try{
  for (let round = 1; round <= total; round += 1) {
    if (stop.aborted) break;
    // 配置对象和配套地图均为不可变版本快照；只在下一轮开始时采用新发布。
    if (refreshConfig) config = refreshConfig();
    const roundStartedMs = Date.now();
    let mainRoundFinished = false;
    const empty = () => ({ planned: 0, results: [] });
    const summary = { round, startedAt: Math.floor(Date.now() / 1000), tasks: empty(), dailies: empty(), world: empty() };
    const settings = getSettings();
    const enabled = key => !stop.aborted && isActivityTaskAvailable(key, client) && nativePreferenceEnabled(getSettings(), key) && (!isEnabled || (isEnabled(key) && rewards.due(key)));
    const guard = createActionGuard(client, getSettings, usageLedger, { player, enabled: () => !stop.aborted && client.connected });
    const usage = () => usageLedger?.snapshot() ?? { counters: {} };
    let extraDemand = [];
    let diveCompleted = false;
    const groupEnabled = group => automationTasks.some(task => task.group === group && enabled(task.key));
    const stepLog = phase => entry => {
      const key=entry.taskKey||entry.key||entry.step?.setting||(entry.step?.kind?worldTaskKey(entry.step.kind):null);
      if (entry.skipped && entry.reason) {
        const waitKey = phase + ':' + (key || entry.id || entry.title || entry.label || 'unknown');
        if (dailyWaitReasons.get(waitKey) === entry.reason) return;
        dailyWaitReasons.set(waitKey, entry.reason);
      } else if (key) {
        dailyWaitReasons.delete(phase + ':' + key);
      }
      if(key){rewards?.observe(key,entry.reason||entry.error||entry.note||(entry.ok?'执行成功 · '+(entry.title||entry.label||'本次动作'):entry.title||entry.label||'已检查'),entry.status==='unknown'||entry.status==='pending'?'pending':entry.skipped?'waiting':entry.ok?'ok':'error');rewards?.expect(key,rewards.now()+Math.ceil(getEveryMs()/1000));}
      onStep?.({ round, phase, ...entry,taskKey:key||entry.taskKey });
    };
    async function observed(keys,work){
      const active=keys.filter(enabled),before=new Map(active.map(k=>[k,rewards?.status(k)]));
      try {const value=await work();for(const key of active){if(rewards?.status(key)===before.get(key))rewards?.observe(key,'已检查，当前没有新增可执行动作');rewards?.expect(key,rewards.now()+Math.ceil(getEveryMs()/1000));}return value;}
      catch(error){for(const key of active)rewards?.observe(key,error.message,'error');throw error;}
    }
    let afkDeadline;
    let factoryDeadline;
    const rememberDeadline = time => { afkDeadline = time; };
    const logReward = (entry, category = '领奖') => stepLog('tasks')({ title: entry.label, ...entry, taskKey:entry.taskKey||entry.key, category });
    const allowDaily = (id, action) => !(getSettings() && action.request === 'ClickGoldRequest' && !action.body.free) && enabled(dailyTaskKey(id, action));
    const allowWorld = kind => enabled(worldTaskKey(kind));
    const active = key => !stop.aborted && isActivityTaskAvailable(key, client) && nativePreferenceEnabled(getSettings(), key) && Boolean(isEnabled?.(key));
    const aliases = { vipDailyGift:['vipDaily'], worldOnlineRewards:['worldOnline'],
      festivalActiveRewards:['festivalActive'], battleReportRewards:['campaignReports'],
      weekSupplyFree:['weekChipFree','weekUniqueFree'], worldBossRewards:['worldBossDamage'],
      merchantRewards:['tradeTasks'], festivalFreeGift:['festivalGifts'],
      riverScore:['snowballFree'], riverHelp:['snowballFree'],
      pirateRankRewards:['openRankRewards'], warRankRewards:['openRankRewards'] };
    // 战报旧开关在未保存详细设置时也走统一账本，与手动和推送领奖共享未知结果保护。
    const serviceEnabled = key => isActivityTaskAvailable(key, client) && (enabled(key) || Boolean((getSettings() || key === 'battleReportRewards') && aliases[key]?.some(enabled)));
    const serviceActive = key => isActivityTaskAvailable(key, client) && (active(key) || Boolean((getSettings() || key === 'battleReportRewards') && aliases[key]?.some(active)));
    const takeoverReason = key => {
      const s = getSettings();
      if (s?.radar?.enabled && ['radarAuto','radarRepair'].includes(key)) return '联盟情报';
      if (s?.forge?.enabled && ['equipmentCollect','equipmentCraft'].includes(key)) return '装备锻造';
      if (s?.loop?.world && s.museum?.enabled && ['museumCollect','museumExplore','museumAchievements'].includes(key)) return '博物馆';
      if (s?.loop?.world && s.pet?.enabled && ['petCollect','petBreed'].includes(key)) return '海兽';
      if (s?.treasure?.enabled && key === 'treasureLoot') return '巨轮';
      if (s?.loop?.heroes && s.heroes?.enabled && key === 'heroGrowth') return '英雄成长';
      return null;
    };
    const legacyActive = key => active(key) && !takeoverReason(key);
    const legacyEnabled = key => enabled(key) && !takeoverReason(key);
    const attemptedOrders = new Set();
    const harvestOptions = { config, player, attemptedOrders, cargoEnabled: () => (!!isEnabled && enabled('cargo')) || needsCargoDemand(getSettings()),
      finishEnabled: () => allowWorld('finishOrder'), getSettings, getUsage: usage,
      beforeStep: guard.before, afterStep: guard.after, cancelStep: guard.cancel };
    function phaseFailure(phase, title, error) {
      if (!client.connected) throw error;
      const entry = { title,taskKey:({'万吨巨轮检查':'万吨巨轮','城战接续检查':'城战接续','装备锻造检查':'装备锻造','联盟情报':'联盟情报','世界Boss首战':'worldBoss','钓具养成':'fishEnhance','自动钓鱼':'autoFish','贸易港':'cargo'})[title], ok: false, ...(error.code === 'AUTOMATION_SKIP' ? { skipped: true, reason: error.message } : {}), error: error.message };
      summary[phase].results.push(entry);
      stepLog(phase)(entry);
    }
    async function checkMerchant() {
      if (!merchantActive() || !merchantMonitor.due() || Date.now() < merchantRunAfter) return;
      merchantPending = false;
      // 先推进下次检查，读取失败也不能在同一毫秒不断重新排队。
      merchantMonitor.defer(merchantNow() + merchantMonitorSeconds(getSettings()));
      const label = automationTasks.find(task => task.key === 'merchantTrade').label;
      const workSeconds = Math.max(merchantRoundSeconds,
        mainRoundFinished ? 0 : Math.ceil((Date.now() - roundStartedMs) / 1000));
      let reported = false;
      const report = entry => {
        reported = true;
        const result = { ...entry, taskKey: 'merchantTrade' };
        summary.tasks.results.push(result);
        if (!entry.skipped) summary.tasks.planned++;
        logReward(result, '活动');
      };
      try {
        await merchantActivity(client, config, { ...adChannel, player, key: 'merchantTrade', label,
          ledger: usageLedger, scheduler: rewards, settings: getSettings,
          get everyMs() { return getEveryMs() + workSeconds * 1000; },
          get merchantCadenceSeconds() {
            return Math.min(Math.ceil(getEveryMs() / 1000), merchantMonitorSeconds(getSettings())) + workSeconds;
          },
          enabled: merchantActive, report });
        if (!reported) report({ label, skipped: true, reason: '已检查，等待下一次海商王状态变化' });
      } catch (error) { report({ label, ok: false, error: error.message }); }
      finally {
        merchantRunAfter = Date.now() + 10_000;
        if (merchantMonitor.nextCheckAt <= merchantNow()) merchantMonitor.defer(merchantNow() + 10);
        rewards?.expect('merchantTrade', merchantMonitor.nextCheckAt);
      }
    }
    const serviceReport = (phase, category) => entry => {
      summary[phase].results.push(entry);
      if (!entry.skipped) summary[phase].planned++;
      const key = entry.key || entry.taskKey || category;
      if (!entry.skipped || serviceWait.get(key) !== entry.reason) stepLog(phase)({ ...entry, category, taskKey: key });
      if (entry.skipped) serviceWait.set(key, entry.reason); else serviceWait.delete(key);
    };
    let pirateChecked = false;
    const challengeOptions = { player, getSettings, state: challengeRun, ledger: usageLedger,
      enabled: () => !stop.aborted && client.connected !== false, isStageBusy, isTrialBusy, isPirateBusy,
      wait: (ms, _value, { signal } = {}) => sleep(ms, signal),
      signal: typeof stop.throwIfAborted === 'function' ? stop : undefined };
    async function checkDispatch() {
      if(stop.aborted)return;
      if(usageLedger)await checkFleetSettlement(client,player,usageLedger);
      await checkMaintenance();
      // 城战时间窗先核实；其余任务按配置检查，空闲且无预留的舰队可共享。
      if(getSettings()?.cityWar.reserveDuringWar)await checkCityWar();
      for (const task of dispatchOrder(getSettings())) {
        if (task === 'pirateHunt' && !pirateChecked) {
          pirateChecked = true;
          await runChallengeRound(client, config, { ...challengeOptions, mode: 'pirate', report: serviceReport('world', '海盗讨伐') });
        }
        if (task === 'cityWar') await checkCityWar();
        if (task === 'radar') await checkRadar();
        if (task === (getSettings()?.treasure.follow?'follow':'treasure')) await checkTreasure();
        if (task === 'worldBoss'&&getSettings()?.worldBoss.enabled) await checkBoss();
        if (task === 'silicon') await checkSilicon();
      }
    }
    async function checkSilicon() {
      if (stop.aborted || siliconNext() > Date.now()) return;
      siliconPreference = getSettings()?.silicon; const version = siliconVersion;
      try { await runSiliconMining(client, protocol, config, player, { getSettings, ledger: usageLedger, guard,
        enabled: () => !stop.aborted && client.connected !== false && getSettings()?.silicon?.enabled,
        report: entry => serviceReport('world', '硅矿')({ ...entry, taskKey: 'silicon.enabled' }) }); }
      catch (error) { phaseFailure('world', '硅矿检查', error); }
      finally { siliconAt = version === siliconVersion ? Date.now() + siliconInterval(getSettings()) : 0; }
    }
    async function checkExtended() {
      if (stop.aborted || extendedNext() > Date.now()) return;
      extendedPreference = getSettings();
      const active = () => !stop.aborted && client.connected !== false;
      const report = key => entry => serviceReport('world', key)({ ...entry, taskKey: key });
      try {
        if (getSettings()?.alliance?.enabled) {
          await runAllianceAutomation(client, protocol, config, player, { getSettings, ledger: usageLedger, enabled: active, report: report('alliance.enabled') });
          const options = { player, getSettings, ledger: usageLedger, scheduler: rewards,
            enabled: () => active() && getSettings()?.alliance?.enabled };
          if (getSettings()?.guildShip?.enabled) await serviceGuildShips(client, protocol, config, { ...options, report: report('guildShip.enabled') });
          if (getSettings()?.guildFort?.enabled) await serviceGuildForts(client, protocol, config, { ...options, report: report('guildFort.enabled') });
        }
        if (getSettings()?.heroRaid?.enabled) await runHeroRaidAutomation(client, protocol, config, player,
          { getSettings, ledger: usageLedger, enabled: active, report: report('heroRaid.enabled') });
      } catch (error) { phaseFailure('world', '联盟与活动自动化', error); }
      finally { extendedAt = Date.now() + 60000; }
    }
    async function checkMaintenance(){
      if(stop.aborted||!fleetMaintenanceEnabled(getSettings())){watchFleetMaintenance(client).hold([]);onMaintenance?.({enabled:false,rows:[],reason:'现有自动维修未开启'});return;}
      if(Date.now()<maintenanceAt)return;
      const version=maintenanceVersion;maintenancePending=false;
      try{await runFleetMaintenance(client,player,{getSettings,ledger:usageLedger,enabled:()=>!stop.aborted&&client.connected&&fleetMaintenanceEnabled(getSettings()),
        onView:onMaintenance,onStep:entry=>{summary.world.planned++;summary.world.results.push(entry);stepLog('world')({...entry,category:'战后维修',taskKey:'舰队战后维修'});}});}
      catch(error){onMaintenance?.({enabled:true,rows:[],reason:error.message});phaseFailure('world','战后维修',error);}
      finally{maintenanceAt=version!==maintenanceVersion?0:Date.now()+fleetMaintenanceInterval(getSettings());}
    }
    async function checkBoss(){
      if(stop.aborted||!getSettings()?.worldBoss.enabled||!rewards?.due('worldBoss'))return;
      try{await runWorldBoss(client,config,player,{getSettings,ledger:usageLedger,enabled:()=>!stop.aborted&&client.connected&&getSettings().worldBoss.enabled,report:entry=>{summary.world.results.push(entry);stepLog('world')({...entry,title:entry.label,taskKey:'worldBoss'});}});}
      catch(error){phaseFailure('world','世界Boss首战',error);}
      finally{rewards?.defer('worldBoss',rewards.now()+Math.ceil(getEveryMs()/1000));}
    }
    async function checkTreasure() {
      if (stop.aborted || !treasureAutomationEnabled(getSettings()) || Date.now() < treasureAt) return;
      const checkedFollowVersion=followVersion;followPending=false;
      if(getSettings()?.cityWar.reserveDuringWar)await checkCityWar();
      try {
        await runTreasureLoot(client, protocol, config, player, { getSettings, ledger: usageLedger,
          reservedFleetIds: cityWarReservedFleets(cityWarState,getSettings(),(Date.now()+(client.serverClockOffsetMs||0))/1000), petrolCeiling: cityFuelCeiling,
          canUseFleet: id => {
            if (dispatchReservationReason(client,getSettings(),getSettings()?.treasure.follow?'follow':'treasure',id)) return false;
            const current = getSettings(), pref = current?.cityWar;
            if (pref?.enabled && pref.reserveDuringWar && pref.fleetIds.includes(id) && cityWarPreference !== pref) return false;
            return !cityWarReservedFleets(cityWarState, current, (Date.now() + (client.serverClockOffsetMs || 0)) / 1000).includes(id);
          },
          enabled: () => !stop.aborted && client.connected && treasureAutomationEnabled(getSettings()),
          onStep(entry) { summary.world.planned++; summary.world.results.push(entry); stepLog('world')({ ...entry, category: '万吨巨轮',taskKey:'万吨巨轮' }); },
          onNotes(notes) {
            const text = notes.join('；');rewards?.observe('万吨巨轮',text||'本次已核对，没有待执行的巨轮动作');
            if (text && text !== lastTreasureNotes) stepLog('world')({ title: '巨轮检查', category: '万吨巨轮', skipped: true, reason: text });
            lastTreasureNotes = text;
          },
        });
      } catch (error) { phaseFailure('world', '万吨巨轮检查', error); }
      finally { rewards?.expect('万吨巨轮',rewards.now()+(getSettings()?.treasure?.checkEverySeconds??15));treasureAt = followVersion!==checkedFollowVersion?0:Date.now() + (getSettings()?.treasure?.checkEverySeconds ?? 15) * 1000; cityFuelCeiling = null; }
    }

    async function checkCityWar() {
      if (stop.aborted || !cityWarEnabled(getSettings())) { cityWarState = null; reserveDispatch(client,'cityWar',[]); return; }
      if (Date.now() < cityWarAt && cityWarPreference === getSettings().cityWar) return;
      cityWarPreference = getSettings().cityWar;
      try {
        cityWarState = await runCityWar(client, protocol, config, player, { getSettings, ledger: usageLedger,canUseFleet:id=>!watchFleetMaintenance(client).held().includes(id)&&!legacyFleetReservationReason(client,id)&&(getSettings().cityWar.reserveDuringWar||!dispatchReservationReason(client,getSettings(),'cityWar',id)),
          enabled: () => !stop.aborted && client.connected && cityWarEnabled(getSettings()),
          onStep(entry) { summary.world.planned++; summary.world.results.push(entry); stepLog('world')({ ...entry, category: '城战接续' }); },
        });
        cityFuelCeiling = cityWarState.remainingFuel;
        reserveDispatch(client,'cityWar',cityWarState.reason ? getSettings().cityWar.fleetIds : cityWarState.reservedFleetIds ?? [], Date.now()+Math.max(60000,getSettings().cityWar.checkEverySeconds*2000));
        const text = (cityWarState.notes ?? []).join('；');rewards?.observe('城战接续',text||'本次已核对，城战动作结果见日志');
        if (text && text !== lastCityWarNotes) stepLog('world')({ title: '城战接续检查', category: '城战接续', skipped: true, reason: text });
        lastCityWarNotes = text;
      } catch (error) { phaseFailure('world', '城战接续检查', error); cityWarState = { reservedFleetIds: [...getSettings().cityWar.fleetIds] }; reserveDispatch(client,'cityWar',getSettings().cityWar.fleetIds); }
      finally {
        rewards?.expect('城战接续',rewards.now()+(getSettings()?.cityWar?.checkEverySeconds??15));
        cityWarAt = Date.now() + (getSettings()?.cityWar?.checkEverySeconds ?? 15) * 1000;
        const opening = (cityWarState?.startTime ?? 0) * 1000 - (client.serverClockOffsetMs || 0);
        if (opening > Date.now()) cityWarAt = Math.min(cityWarAt, opening);
      }
    }

    async function checkRadar(){
      if(stop.aborted || !getSettings()?.radar.enabled || Date.now()<radarAt)return;
      try{await runAllianceRadar(client,config,player,{getSettings,ledger:usageLedger,canUseFleet:id=>!dispatchReservationReason(client,getSettings(),'radar',id),enabled:()=>!stop.aborted&&client.connected,report(entry){summary.world.results.push(entry);if(!entry.skipped)summary.world.planned++;stepLog('world')({...entry,title:entry.label,category:'联盟情报'});}});}
      catch(error){phaseFailure('world','联盟情报',error);}
      finally{rewards?.expect('联盟情报',rewards.now()+(getSettings()?.radar.checkEverySeconds??30));radarAt=Date.now()+(getSettings()?.radar.checkEverySeconds??30)*1000;}
    }
    async function checkForge() {
      if (stop.aborted || !forgeEnabled(getSettings()) || (Date.now() < forgeAt && forgePreference === getSettings().forge)) return;
      forgePreference = getSettings().forge;
      try {
        const result = await runEquipmentForge(client, protocol, config, player, { getSettings, ledger: usageLedger,
          enabled: () => !stop.aborted && client.connected && forgeEnabled(getSettings()),
          onStep(entry) { summary.world.planned++; summary.world.results.push(entry); stepLog('world')({ ...entry, category: '装备锻造' }); },
        });
        const text = (result.notes ?? []).join('；');rewards?.observe('装备锻造',text||'本次已核对，锻造动作结果见日志');
        if (text && text !== lastForgeNotes) stepLog('world')({ title: '装备锻造检查', category: '装备锻造', skipped: true, reason: text });
        lastForgeNotes = text;
      } catch (error) { phaseFailure('world', '装备锻造检查', error); }
      finally { rewards?.expect('装备锻造',rewards.now()+(getSettings()?.forge?.checkEverySeconds??30));forgeAt = Date.now() + (getSettings()?.forge?.checkEverySeconds ?? 30) * 1000; }
    }
    async function checkAntique() {
      if (stop.aborted || !antiqueEnabled(getSettings()) || (Date.now() < antiqueAt && antiquePreference === getSettings().antique)) return;
      antiquePreference = getSettings().antique;
      try {
        const result = await runAntiqueUpgrade(client, protocol, config, player, { getSettings, ledger: usageLedger,
          enabled: () => !stop.aborted && client.connected && antiqueEnabled(getSettings()),
          onStep(entry) { summary.world.planned++; summary.world.results.push(entry); stepLog('world')({ ...entry, category: '藏品养成', title: entry.step?.label ?? '藏品养成' }); },
        });
        const text = (result.notes ?? []).join('；');rewards?.observe('藏品养成',text||'本次已核对，藏品养成动作结果见日志');
        if (text && text !== lastAntiqueNotes) stepLog('world')({ title: '藏品养成检查', category: '藏品养成', skipped: true, reason: text });
        lastAntiqueNotes = text;
      } catch (error) { phaseFailure('world', '藏品养成检查', error); }
      finally { rewards?.expect('藏品养成',rewards.now()+(getSettings()?.antique?.checkEverySeconds??60));antiqueAt = Date.now() + (getSettings()?.antique?.checkEverySeconds ?? 60) * 1000; }
    }

    const adContext = { ...adChannel, player, getSettings, enabled, ledger: usageLedger, scheduler: rewards };
    const claimAfkAdNow = () => isEnabled && enabled('afkAd') && observed(['afkAd'], () => claimAfkAd(client, config, { ...adContext, report(entry) {
      summary.tasks.results.push(entry);
      if (!entry.skipped) summary.tasks.planned++;
      logReward(entry, '领奖');
    } }));
    await schedule(async () => {
      if (stop.aborted) return;
      beginAdRound(client);
      if (!isEnabled && enabled('tasks')) {
        try {
          const survey = await surveyTasks(client, protocol, { config, player });
          summary.tasks.planned = survey.plan.length;
          summary.tasks.results = await runTasks(client, protocol, survey, {
            allowMutate, enabled: () => enabled('tasks'), onStep: stepLog('tasks'), settings,
          });
        } catch (error) { phaseFailure('tasks', '任务检查', error); }
      }
      if (groupEnabled('日常')) {
        try {
           const includeTask = id => id === 1010 && settings
             ? false : !isEnabled || dailyActionKeys[id]?.some(enabled);
          const survey = await surveyDailies(client, protocol, { config, player, includeTask, probeGift: !isEnabled, idle: !!isEnabled, settings });
          for (const entry of survey.tasks) for (const key of dailyActionKeys[entry.task.id]??[]) rewards?.observe(key, entry.reason || (Number.isFinite(entry.task.progress)&&Number.isFinite(entry.task.targetProgress)?entry.task.progress+'/'+entry.task.targetProgress+(entry.task.progress>=entry.task.targetProgress?' · 今日目标已完成':' · 等待执行'):'已读取任务状态'));
           const recruit = survey.tasks.find(entry => entry.task.id === 1002 && entry.status === 'waiting');
           if (recruit && recruit.reason !== lastRecruitWait) stepLog('dailies')({ title: recruit.task.title, skipped: true, reason: recruit.reason, taskKey: 'freeRecruit' });
           lastRecruitWait = recruit?.reason;
           for (const entry of survey.tasks) {
             const keys = dailyActionKeys[entry.task.id] ?? [];
             if (['waiting', 'blocked'].includes(entry.status) && entry.reason && keys.some(enabled)) {
               stepLog('dailies')({ title: entry.task.title, skipped: true, reason: entry.reason, taskKey: keys[0] });
             }
           }
          summary.dailies.planned = survey.tasks.reduce((n, entry) =>
            n + (entry.actions ?? []).filter(action => allowDaily(entry.task.id, action)).length, 0);
          if (!isEnabled) summary.dailies.planned += (survey.chests?.actions.length ?? 0) + (survey.gift?.actions.length ?? 0);
          if (summary.dailies.planned) {
            summary.dailies.results = await runDailies(client, protocol, survey, {
              allowMutate, allowPaid: isEnabled ? true : allowPaid, claimRewards: !isEnabled, config,
              allowAction: allowDaily, onStep: stepLog('dailies'),
              settings, beforeAction: guard.before, afterAction: guard.after, cancelAction: guard.cancel,
            });
          }
          if (recruit) summary.dailies.results.push({ id: 1002, skipped: true, reason: recruit.reason });
          if (rewards) {
            for (const { task } of survey.tasks) {
              if (!(task.targetProgress > 0 && task.progress >= task.targetProgress)) continue;
              for (const key of dailyActionKeys[task.id] ?? []) rewards.defer(key, survey.daily.dailyResetTime);
            }
            rewards.defer('freeRecruit', survey.freeRecruitAt);
            rewards.defer('freeGold', survey.freeGoldAt);
            for (const entry of summary.dailies.results) {
              if (entry.ok && entry.request === 'RecruitStartRequest') {
                rewards.clear('heroRecruitRewards');
                rewards.defer('freeRecruit', entry.body?.recruitData?.freeEndTimeSeconds);
              }
            }
          }
        } catch (error) { phaseFailure('dailies', '日常检查', error); }
      }
      if(isEnabled&&settings&&enabled('pirate')){
        try{await runPirateSweeps(client,config,player,{getSettings,ledger:usageLedger,enabled:()=>enabled('pirate'),scheduler:rewards,report:entry=>{summary.dailies.results.push(entry);if(!entry.skipped)summary.dailies.planned++;stepLog('dailies')({...entry,title:entry.label,taskKey:'pirate'});}});}
        catch(error){const entry={title:'海盗日常扫荡',taskKey:'pirate',ok:false,error:error.message};summary.dailies.results.push(entry);stepLog('dailies')(entry);}
      }
      if (isEnabled && groupEnabled('领奖')) {
        const results = await observed(['tasks','dailyRewards','chests','gift','mail','afk'],()=>claimRewards(client, protocol, config, logReward, enabled, rememberDeadline, rewards, player, { settings }));
        summary.tasks = { planned: results.length, results };
        try { await claimAfkAdNow(); } catch (error) { phaseFailure('tasks', '闯关挂机广告收益', error); }
      }
      if (isEnabled && enabled('adShop')) {
        await observed(['adShop'],()=>claimAdShop(client, config, { ...adChannel, player, getSettings, enabled: () => enabled('adShop'),
          schedule: rewards, report(entry) {
            summary.tasks.results.push(entry);
            if (!entry.skipped) summary.tasks.planned++;
            logReward({...entry,taskKey:'adShop'}, '领奖');
          } }));
      }
      if (isEnabled && enabled('trialSweep')) {
        await sweepTrials(client, config, player?.level ?? 0, () => enabled('trialSweep'), entry => {
          summary.dailies.planned++;
          summary.dailies.results.push(entry);
          stepLog('dailies')({ ...entry, taskKey:'trialSweep', category: '试炼' });
        }, rewards);
      }
      if (isEnabled && enabled('guildWelfare')) {
        // 联盟福利仍按原设置独立检查。
        try {
          const entry = await claimGuildWelfare(client, config, { player, enabled: () => enabled('guildWelfare'), scheduler: rewards });
          summary.tasks.results.push(entry);
          if (!entry.skipped) summary.tasks.planned++;
          if (!entry.skipped || lastGuildWait !== entry.reason) logReward({...entry,taskKey:'guildWelfare'}, '联盟');
          rewards?.observe('guildWelfare',entry.reason||entry.error||entry.label||'已检查',entry.ok?'ok':entry.skipped?'waiting':'error');rewards?.expect('guildWelfare',rewards.now()+Math.ceil(getEveryMs()/1000));
          lastGuildWait = entry.reason;
        } catch (error) { phaseFailure('tasks', '联盟福利礼包', error); }
      } else if (!isEnabled?.('guildWelfare')) lastGuildWait = undefined;
      if (isEnabled && (enabled('trialPaidSweep') || enabled('trialAdSweep'))) {
        await runExtraTrialSweeps(client, protocol, config, player, { getSettings, ledger: usageLedger, channel: adChannel,
          enabled: mode => enabled(mode === 'paid' ? 'trialPaidSweep' : 'trialAdSweep'), report(entry) {
            summary.dailies.results.push(entry); if (!entry.skipped) summary.dailies.planned++; stepLog('dailies')({ ...entry, category: '试炼' });
          } });
      }
      if (isEnabled && serviceEnabled('worldOnlineRewards')) {
        try {
          const entry = await claimWorldOnlineReward(client, config, player, { ledger: usageLedger, enabled: () => serviceActive('worldOnlineRewards'), scheduler: rewards });
          summary.tasks.results.push(entry);
          if (!entry.skipped) summary.tasks.planned++;
          logReward({...entry,taskKey:'worldOnlineRewards'}, '联盟/城战');
        } catch (error) { phaseFailure('tasks', '城战在线奖励', error); }
      }
      if (isEnabled) {
        const extraReport=entry=>{summary.tasks.results.push(entry);if(!entry.skipped)summary.tasks.planned++;logReward(entry,'免费领奖');};
        for(const [key,service] of [['vipDailyGift',claimVipDaily],['guildTitleReward',claimGuildTitleReward],['limitedFreeGifts',claimLimitedFree],['weekHeroStar',claimWeekHeroStar],['pirateRankRewards',(c,f,o)=>claimOpenRank(c,f,o,3)],['warRankRewards',(c,f,o)=>claimOpenRank(c,f,o,4)],['festivalActiveRewards',claimFestivalActive],['battleReportRewards',claimReportRewards],['leagueCollect',claimLeagueCollect],['leaguePassRewards',claimLeaguePass],['weekSupplyFree',claimWeekSupply],['worldBossRewards',claimWorldBossDamage],['comicDrama',claimComicDrama],['tournamentDailyGift',claimTournamentDaily]]) {
          if (!settings && key === 'weekHeroStar') continue;
          if(serviceEnabled(key))try{let reports=0;await service(client,config,{player,allLevels:active('vipDaily'),enabled:()=>serviceActive(key),ledger:usageLedger,scheduler:rewards,report:entry=>{reports++;extraReport({...entry,taskKey:key});}});if(!reports)extraReport({taskKey:key,label:automationTasks.find(t=>t.key===key).label,skipped:true,reason:'已检查，当前没有新增可执行的领取动作'});}catch(error){extraReport({taskKey:key,label:automationTasks.find(t=>t.key===key).label,ok:false,error:error.message});}
        }
        const activityServices = { armsRaceRewards:militaryRewards, riverScore:riverActivity, riverPass:riverActivity, edictPass:edictPassActivity, seasonChest:openSeasonChests,
          riverHelp:riverActivity, compassDaily:compassActivity, compassAdGift:compassActivity, compassSpin:compassActivity, compassReward:compassActivity,
          merchantTrade:merchantActivity, merchantRewards:merchantActivity, beautyVotes:beautyActivity, beautyGift:beautyActivity };
        for (const [key,service] of Object.entries(activityServices)) {
          if (!settings && (key === 'compassSpin' || key === 'seasonChest')) continue;
          if (key === 'merchantTrade') { await checkMerchant(); continue; }
          if (!serviceEnabled(key)) continue;
          const label=automationTasks.find(task=>task.key===key).label;
          let reported=false;
          const report=entry=>{
            reported=true;
            const result={...entry,taskKey:key};
            summary.tasks.results.push(result);
            if (!entry.skipped) summary.tasks.planned++;
            logReward(result,'活动');
          };
          try {
            // 海商王每轮仅一步，截止余量计入轮间等待和已观察的整轮耗时。
            const workSeconds = Math.max(merchantRoundSeconds, Math.ceil((Date.now() - roundStartedMs) / 1000));
            await service(client,config,{...adChannel,player,key,label,ledger:usageLedger,scheduler:rewards,settings:getSettings,
              get everyMs() { return getEveryMs() + workSeconds * 1000; },
              freeOnly:key==='riverHelp'&&!active(key),enabled:()=>serviceActive(key),report});
            if (!reported) report({label,skipped:true,reason:'已检查，当前没有可领取的新增奖励'});
          } catch(error) {report({label,ok:false,error:error.message});}
        }
        if(enabled('festivalSign')||serviceEnabled('festivalFreeGift'))try{await observed(['festivalSign','festivalFreeGift'],()=>claimLinkageFree(client,config,{player,enabled:serviceActive,ledger:usageLedger,report:extraReport}));}catch(error){phaseFailure('tasks','酆都免费奖励',error);}
        if(enabled('heroAdRecruit')||enabled('antiqueAdRecruit'))try{await observed(['heroAdRecruit','antiqueAdRecruit'],()=>recruitWithSkipAds(client,config,{...adChannel,player,getSettings,enabled,ledger:usageLedger,report:extraReport,scheduler:rewards}));}catch(error){phaseFailure('tasks','免广告招募',error);}
      }
      if (isEnabled && enabled('heroRecruitRewards')) {
        await serviceHeroRecruitRewards(client, config, { player, enabled, scheduler: rewards, report(entry) {
          summary.tasks.results.push(entry);
          if (!entry.skipped) summary.tasks.planned++;
          logReward({...entry,taskKey:'heroRecruitRewards'}, '英雄招募');
        } });
      }
      if (isEnabled) {
        // 保存的旧开关仍可用；有详细配置时，重叠协议统一走新账本，防止跨入口重发。
        const report = serviceReport('tasks', '兼容领奖');
        const mapped = new Set(['worldOnline','tradeTasks','worldBossDamage','vipDaily','campaignReports','weekChipFree','weekUniqueFree','festivalActive','snowballFree']);
        const rewardActive = key => legacyActive(key) &&
          !['guildTitleReward','heroRecruitRewards'].includes(key) &&
          !(getSettings() && (mapped.has(key) || ['festivalSign','compassSpin','weekHeroStar','weekOrderSubmit'].includes(key)));
        const rewardEnabled = key => rewardActive(key) && rewards.due(key);
        const festivalDue = new Set(festivalRewardKeys.filter(rewardEnabled));
        const weeklyDue = new Set(weeklyRewardKeys.filter(rewardEnabled));
        if (festivalDue.size) {
          try { await claimFestivalRewards(client, config, key=>festivalDue.has(key)&&rewardActive(key), report, rewards,
            (row, type) => !getSettings() || type !== 6, {spinCount:getCompassSpinCount()}); }
          catch(error) { phaseFailure('tasks','活动免费奖励',error); }
        }
        if (weeklyDue.size) {
          try { await claimWeeklyRewards(client, config, await weekSchedule(client), key=>weeklyDue.has(key)&&rewardActive(key), report, {scheduler:rewards,readOrder:readWeekOrder,player}); }
          catch(error) { phaseFailure('tasks','周活动免费奖励',error); }
        }
        if (!settings && rewardEnabled('vipDaily')) {
          try { await claimLegacyVipDaily(client,config,player,rewardActive,report,rewards); }
          catch(error) { phaseFailure('tasks','VIP免费奖励',error); }
        }
        if (enabled('openRankRewards')) {
          try {
            if (!settings) await claimOpenRanks(client,config,player,active,report,rewards);
            else for (const type of [1,2]) await claimOpenRank(client,config,{player,enabled:()=>active('openRankRewards'),ledger:usageLedger,report:entry=>report({...entry,key:'openRankRewards'})},type);
          } catch(error) { phaseFailure('tasks','开服冲榜奖励',error); }
        }
        if (extraRewardKeys.some(rewardEnabled)) await claimExtraRewards(client,config,player,rewardEnabled,report,rewards,rewardActive);
        if (settings && enabled('weekOrderSubmit')) {
          try {
            const view = (await activityView(client,client.festivals,config)).order;
            if (view?.ready) {
              const result = await runWeekOrder(client,config,getSettings(),usageLedger,()=>active('weekOrderSubmit'),'submit',{orderKey:view.orderKey},{player});
              report({key:'weekOrderSubmit',label:'周订单提交',ok:true,note:result.message});
            } else report({key:'weekOrderSubmit',label:'周订单提交',skipped:true,reason:'当前订单未开放或材料未齐，等待备料'});
          } catch(error) { report({key:'weekOrderSubmit',label:'周订单提交',ok:false,error:error.message}); }
        }
      }
      for (const key of ['radarAuto','radarRepair','equipmentCollect','equipmentCraft','museumCollect','museumExplore','museumAchievements','petCollect','petBreed','treasureLoot','heroGrowth']) {
        const reason = takeoverReason(key);
        if (enabled(key) && reason) serviceReport('dailies', reason)({key, skipped:true, reason:'由游戏配置中的' + reason + '接管'});
      }
      // 兼容主分支原有的联盟、装备、博物馆、海兽、成长和巨轮服务。
      // 新版调度服务与这些入口共享同一个账号队列；只有显式开启旧开关时才执行，避免重复请求。
      if (isEnabled && legacyEnabled('guildOrders')) {
        try { await serviceGuildOrders(client, protocol, config, { player, enabled: () => legacyActive('guildOrders'), scheduler: rewards, report: serviceReport('dailies', '联盟订单') }); }
        catch (error) { phaseFailure('dailies', '联盟订单检查', error); }
      }
      if (isEnabled && legacyEnabled('guildAidHelp')) {
        try { await serviceGuildAid(client, protocol, config, { player, enabled: () => legacyActive('guildAidHelp'), scheduler: rewards, report: serviceReport('dailies', '联盟互助') }); }
        catch (error) { phaseFailure('dailies', '联盟互助检查', error); }
      }
      if (isEnabled && ['equipmentCollect', 'equipmentCraft'].some(legacyEnabled)) {
        try { await serviceEquipmentCrafting(client, config, { player, enabled: legacyActive, scheduler: rewards, report: serviceReport('world', '装备制造') }); }
        catch (error) { phaseFailure('world', '装备厂检查', error); }
      }
      if (isEnabled && ['radarAuto', 'radarRepair'].some(legacyEnabled)) {
        try { await serviceRadar(client, protocol, config, { player, enabled: legacyActive, scheduler: rewards, report: serviceReport('dailies', '联盟情报') }); }
        catch (error) { phaseFailure('dailies', '联盟情报检查', error); }
      }
      if (isEnabled && legacyEnabled('treasureLoot')) {
        try { await serviceTreasureLoot(client, config, { player, protocol, getSettings, enabled: () => legacyActive('treasureLoot'), scheduler: rewards, report: serviceReport('dailies', '世界宝藏') }); }
        catch (error) { phaseFailure('dailies', '世界宝藏检查', error); }
      }
      if (isEnabled && ['museumCollect', 'museumExplore'].some(legacyEnabled)) {
        try { await serviceMuseum(client, protocol, config, { player, enabled: legacyActive, scheduler: rewards, report: serviceReport('dailies', '博物馆') }); }
        catch (error) { phaseFailure('dailies', '博物馆探险检查', error); }
      }
      if (isEnabled && ['petCollect', 'petBreed'].some(legacyEnabled)) {
        try { await servicePetBreeding(client, protocol, config, { player, enabled: legacyActive, scheduler: rewards, report: serviceReport('world', '海兽培育') }); }
        catch (error) { phaseFailure('world', '海兽培育检查', error); }
      }
      if (isEnabled && legacyEnabled('heroGrowth')) {
        try { await serviceHeroGrowth(client, protocol, config, { player, enabled: () => legacyActive('heroGrowth'), scheduler: rewards, report: serviceReport('dailies', '成长') }); }
        catch (error) { phaseFailure('dailies', '英雄成长检查', error); }
      }
      await runChallengeRound(client, config, { ...challengeOptions, mode: 'progression', report: serviceReport('dailies', '推关与试炼') });
      if (!getSettings()?.progression && isEnabled && legacyEnabled('stageAuto')) {
        try { await serviceStageAuto(client, config, { player, enabled: () => legacyActive('stageAuto'), scheduler: rewards, isBusy: isStageBusy, report: serviceReport('dailies', '成长') }); }
        catch (error) { phaseFailure('dailies', '主线推关检查', error); }
      }
      if (isEnabled && groupEnabled('藏品')) {
        try {
          await observed(['freeAntiqueRecruit','antiqueRecruitRewards'],()=>serviceAntiqueRecruit(client, config, { player, enabled, scheduler: rewards, report(entry) {
            summary.tasks.results.push(entry);
            if (!entry.skipped) summary.tasks.planned++;
            if (!entry.skipped || antiqueWait.get(entry.key) !== entry.reason) logReward(entry, '藏品');
            if (entry.skipped) antiqueWait.set(entry.key, entry.reason);
            else antiqueWait.delete(entry.key);
          } }));
        } catch (error) { phaseFailure('tasks', '藏品招募检查', error); }
      }
      for (const key of antiqueWait.keys()) if (!isEnabled(key)) antiqueWait.delete(key);
      if (isEnabled && enabled('fishEnhance')) {
        try {
          const reserve = getFishingGoldReserve();
          const entry = await upgradeFishingOnce(client, config, {
            playerLevel: player?.level, reserveGold: reserve,
            enabled: () => enabled('fishEnhance') && reserve === getFishingGoldReserve(),
            targetLevel: settings?.gather.targetLevel ?? Infinity,
            beforeAction: guard.before, afterAction: guard.after, cancelAction: guard.cancel,
          });
          summary.tasks.results.push(entry);
          if (!entry.skipped) summary.tasks.planned++;
          if (!entry.skipped || entry.reason !== lastFishUpgradeWait) logReward({...entry,taskKey:'fishEnhance'}, '钓鱼');
          rewards?.observe('fishEnhance',entry.reason||entry.error||entry.label||'已检查',entry.ok?'ok':entry.skipped?'waiting':'error');rewards?.expect('fishEnhance',rewards.now()+Math.ceil(getEveryMs()/1000));
          lastFishUpgradeWait = entry.reason;
        } catch (error) { phaseFailure('tasks', '钓具养成', error); }
      } else lastFishUpgradeWait = undefined;
      if (isEnabled && enabled('autoFish')) {
        try {
          const bookMode = !!getSettings()?.gather.fishBook;
          const entry = await fishOnce(client, config, () => enabled('autoFish') && (!bookMode || getSettings()?.gather.fishBook), {fishBook:bookMode,onBookComplete:onFishBookComplete});
          summary.tasks.results.push(entry);
          if (!entry.skipped) summary.tasks.planned++;
          if (!entry.skipped || entry.reason !== lastFishWait) logReward({...entry,taskKey:'autoFish'}, '钓鱼');
          rewards?.observe('autoFish',entry.reason||entry.error||entry.label||'已检查',entry.ok?'ok':entry.skipped?'waiting':'error');rewards?.expect('autoFish',rewards.now()+Math.ceil(getEveryMs()/1000));
          lastFishWait = entry.reason;
        } catch (error) { phaseFailure('tasks', '自动钓鱼', error); }
      } else lastFishWait = undefined;
      for (const [key, label] of [['fishBook', '钓鱼图鉴'], ['newbieLogin', '新手七日登录']]) {
        if (!isEnabled || !enabled(key)) continue;
        try {
          await observed([key],()=>claimCollection(client, config, key, enabled, entry => {
            summary.tasks.planned++;
            summary.tasks.results.push(entry);
            logReward({...entry,taskKey:key}, key === 'newbieLogin' ? '活动' : '领奖');
          }, rewards));
        } catch (error) { phaseFailure('tasks', label, error); }
      }
      if (isEnabled && ['evilExpel', 'edict'].some(enabled)) {
        await observed(['evilExpel','edict'],()=>runLinkage(client, config, key=>key!=='compassReward'&&enabled(key), entry => {
          if (!entry.skipped) summary.tasks.planned++;
          summary.tasks.results.push(entry);
          logReward(entry, '活动');
        }));
      }
      if (isEnabled && groupEnabled('船只')) {
        try {
          await observed(['autoDive','diveEnhance','autoSalvage','salvageEnhance'],()=>serviceBoats(client, config, enabled, entry => {
            if (entry.key === 'autoDive' && entry.ok) diveCompleted = true;
            if (!entry.skipped) summary.tasks.planned++;
            summary.tasks.results.push(entry);
            logReward(entry, '船只');
          }, { settings, beforeAction: guard.before, afterAction: guard.after, cancelAction: guard.cancel }));
        } catch (error) { phaseFailure('tasks', '船只检查', error); }
      }
      if (isEnabled && ['weekPass', 'weekGift', 'weekTimes'].some(enabled)) {
        try {
          await observed(['weekPass','weekGift','weekTimes'],()=>claimWeekly(client, config, enabled, entry => {
            if (!entry.skipped) summary.tasks.planned++;
            summary.tasks.results.push(entry);
            logReward(entry, '周期活动');
          }, player?.level, rewards));
        } catch (error) { phaseFailure('tasks', '周活动检查', error); }
      }
      if (groupEnabled('海面')) {
        const adSpeedUpResults = [];
        const adSpeedUpKeys = ['adSpeedUpProduce', 'adSpeedUpBuilding', 'adSpeedUpMuseum'];
        if (isEnabled && adSpeedUpKeys.some(enabled)) {
          try {
            await observed(adSpeedUpKeys, () => claimAdSpeedUps(client, config, { ...adContext, report(entry) {
              adSpeedUpResults.push(entry);
              stepLog('world')({ ...entry, title: entry.label });
            } }));
          } catch (error) { phaseFailure('world', '广告加速', error); }
        }
        const usesOrders = allowWorld('finishOrder') || allowWorld('denyOrder');
        const survey = await surveyWorld(client, protocol, { config, player,
          includeCargo: needsCargoDemand(settings) || (!!isEnabled && enabled('cargo') && (allowWorld('startProduce') || usesOrders)),
          includeWeekOrder: needsCargoDemand(settings) || usesOrders || allowWorld('startProduce') || allowWorld('weekFactory') || allowWorld('farm') || allowWorld('upgrade') });
        if (settings && ((allowWorld('startProduce') && (settings.factory.demandFirst || settings.alliance?.enabled &&
          (settings.alliance.recruit && settings.alliance.recruitProduction || settings.guildShip?.enabled && settings.guildShip.produceMissing))) || settings.factory.speedUpSources.length > 0)) {
          const extra = await surveyBaseAutomation(client, protocol, config, player, settings, survey, { ledger: usageLedger, enabled: () => !stop.aborted && client.connected !== false });
          extraDemand = baseDemands(extra, config, settings);
        }
        if (isEnabled && (enabled('collect') || enabled('startProduce')))
          factoryDeadline = nextFactoryCheck(survey.factories, client.serverClockOffsetMs || 0, enabled('collect'));
        const plan = planWorld(survey, { config, enabled: allowWorld,
          settings, usage: usage(), extraDemand,
          allowSpeedUp: isEnabled ? enabled('speedUp') : allowSpeedUp,
          allowReroll: isEnabled ? enabled('denyOrder') : allowReroll,
          minOrderExp: settings ? settings.resident.minExp : isEnabled && enabled('denyOrder') ? null : 0,
        });
        for(const key of ['collect','finishUpgrade','build','buildSupply','upgrade','finishOrder','startProduce','weekFactory','farm','speedUp','denyOrder'])if(enabled(key)){
          const actions=plan.actions.filter(a=>worldTaskKey(a.kind)===key);
          rewards?.observe(key,actions.length?'本次计划 '+actions.length+' 项，执行结果见日志':'已读取基地状态，当前无符合设置的可执行动作');
          rewards?.expect(key,rewards.now()+Math.ceil(getEveryMs()/1000));
        }
        summary.world = { planned: plan.actions.length + adSpeedUpResults.filter(entry => !entry.skipped).length, population: survey.population + '/' + survey.maxPopulation,
          notes: [...survey.notes, ...plan.notes], results: adSpeedUpResults };
        const nextWait = new Map();
        if (isEnabled && allowWorld('finishOrder')) {
          for (const decision of plan.orderDecisions) {
            if (decision.status !== 'reserved' && decision.status !== 'unknown') continue;
            const order = survey.orders.find(o => o.index === decision.index);
            const title = (order?.workerName || '未知居民') + '的订单 #' + decision.index;
            const message = title + ' · ' + decision.reason;
            nextWait.set(decision.index, message);
            if (residentWait.get(decision.index) !== message) stepLog('world')({ title, skipped: true, reason: decision.reason });
          }
        }
        residentWait = nextWait;
        if (isEnabled && enabled('upgrade') && plan.upgradeReasons.length)
          stepLog('world')({ taskKey:'upgrade',title:'建筑升级检查',reason:plan.upgradeReasons.join('；'),skipped:true });
        if (isEnabled && enabled('antiqueFloaters')) {
          try {
            await collectAntiqueFloaters(client,config,{enabled:()=>enabled('antiqueFloaters'),ledger:usageLedger,report(entry){
              summary.world.results.push(entry);if(!entry.skipped)summary.world.planned++;stepLog('world')({...entry,title:entry.label});
            }});
          } catch(error){phaseFailure('world','海面藏品宝箱打捞',error);}
        }
        if (isEnabled && enabled('floaters')) {
          try {
            await observed(['floaters'],()=>collectFloaters(client, config, survey.floaters, enabled, entry => {
              summary.world.planned++;
              summary.world.results.push(entry);
              stepLog('world')({ ...entry,taskKey:'floaters', title: entry.label });
            }, { settings }));
          } catch (error) { phaseFailure('world', '漂浮物拾取', error); }
        }
        if (plan.actions.length) {
          const result = await runWorldRound(client, protocol, plan, { ...harvestOptions,
            allowMutate, enabled: allowWorld, rejected: rejected.world, onStep: stepLog('world'),
          });
          summary.world.planned += result.followupCount;
          summary.world.results.push(...result.results);
        }
        if (isEnabled && (allowWorld('startProduce') || enabled('upgrade') || enabled('weekFactory'))) {
          try {
            const after = normalize(await client.request('OnWaterRequest', {}));
            if (enabled('upgrade') || enabled('weekFactory')) {
              summary.world.upgrades = [];
              for (const entry of summary.world.results) {
                if (!['finishUpgrade', 'upgrade', 'weekFactory'].includes(entry.step?.kind)) continue;
                const id = entry.step.body.buildingId;
                const before = survey.buildings.find(b => b.buildingId === id);
                const current = after.building?.find(b => b.buildingId === id);
                const detail = !entry.ok ? entry.error : !current ? '未返回建筑状态' :
                  current.level > before.level ? '已升至 ' + current.level + ' 级' :
                  current.buildStartTime || current.buildFinishTime ? '已开工，当前 ' + before.level + ' 级' :
                  '服务器未确认升级，当前 ' + current.level + ' 级';
                const title = displayBuilding(config, before) + '：' + detail;
                summary.world.upgrades.push(title);
                if (entry.ok) stepLog('world')({ title, ok: true });
              }
            }
            if (allowWorld('startProduce')) {
              factoryDeadline = nextFactoryCheck(after.building, client.serverClockOffsetMs || 0, enabled('collect'));
              summary.world.factories = [];
              for (const b of survey.factories) {
                const factory = after.building?.find(row => row.buildingId === b.buildingId)?.factory;
                const before = b.factory.factoryQ?.length ?? 0;
                const count = factory ? factory.factoryQ?.length ?? 0 : null;
                const reasons = [];
                if (count !== survey.factorySlots) {
                  for (const entry of summary.world.results) {
                    if (!entry.ok && entry.step?.kind === 'startProduce' && entry.step.body.buildingId === b.buildingId)
                      reasons.push(entry.error);
                  }
                  if (plan.factoryReasons.has(b.buildingId)) reasons.push(plan.factoryReasons.get(b.buildingId));
                  const collected = summary.world.results.some(e => e.ok && e.step?.kind === 'gainFactory' && e.step.body.buildingId === b.buildingId);
                  const finished = f => (f?.finishedProducts ?? []).reduce((n, item) => n + Number(item.num), 0);
                  const newlyFinished = finished(factory) - (collected ? 0 : finished(b.factory));
                  if (newlyFinished > 0) reasons.push('核对时已有 ' + newlyFinished + ' 件在本轮完工，腾出了生产格');
                  if (!reasons.length) reasons.push(factory ? '排产后队列数量与计划不一致，下轮重新核对' : '服务端未返回工厂状态');
                }
                const queue = count === null ? '未能核对生产格' : count === survey.factorySlots
                  ? '已排满 ' + count + ' 个生产格'
                  : '正在生产 ' + count + ' 格，空闲 ' + Math.max(0, survey.factorySlots - count) + ' 格';
                const title = displayBuilding(config, b) + '：' + queue + (reasons.length ? '。' + [...new Set(reasons)].join('；') : '');
                summary.world.factories.push(title);
                if (count !== before || count !== survey.factorySlots) stepLog('world')({ title,taskKey:'startProduce',skipped:true,reason:title });
              }
            }
          } catch (error) { phaseFailure('world', '核对海面建筑状态', error); }
        }
        if (isEnabled && enabled('cargo') && player?.level >= (config?.tables?.CargoUnlockCfg?.data[0]?.playerLevel ?? 9)) {
          try {
            await serviceCargo(client, config, { enabled: () => enabled('cargo'), getSettings, ledger: usageLedger,
              beforeAction: guard.before, afterAction: guard.after, cancelAction: guard.cancel, log(title, details) {
              const entry = { title, ok: !details?.skipped, ...details };
              summary.world.planned++;
              summary.world.results.push(entry);
              stepLog('world')(entry);
            } });
          } catch (error) { phaseFailure('world', '贸易港', error); }
        }
      }
      const latest = getSettings();
      if (hasBaseWork(latest)) {
        try {
          const survey = await surveyWorld(client, protocol, { config, player, includeWeekOrder: false });
          const extra = await surveyBaseAutomation(client, protocol, config, player, latest, survey, { ledger: usageLedger, enabled: () => !stop.aborted && client.connected !== false });
          const plan = planBaseAutomation(extra, config, latest, usage(), { diveCompleted });
          for(const [group,fields]of Object.entries(latest))for(const [field,value]of Object.entries(fields??{})){
            const key=group+'.'+field;if(value!==true||!['pet','museum','events','gold'].includes(group))continue;
            const actions=plan.actions.filter(a=>a.setting===key);
            rewards?.observe(key,actions.length?'本次计划 '+actions.length+' 项':'已核对，当前无符合条件的动作'+(plan.notes.length?'：'+plan.notes.join('；'):''));rewards?.expect(key,rewards.now()+Math.ceil(getEveryMs()/1000));
          }
          const results = await runBaseAutomation(client, protocol, config, plan, { player, getSettings, ledger: usageLedger,
            enabled: () => !stop.aborted && client.connected, onStep: stepLog('world') });
          summary.world.planned += plan.actions.length;
          summary.world.results.push(...results);
          summary.world.notes = [...(summary.world.notes ?? []), ...plan.notes];
        } catch (error) { phaseFailure('world', '基地设置执行', error); }
      }
      if (getSettings()?.loop.heroes && getSettings().heroes.enabled && !stop.aborted) {
        try {
          const list = normalize(await client.request('AllHeroRequest', {}, 'AllHeroResponse'));
          const bag = normalize(await client.request('AllItemRequest', {}, 'AllItemResponse'));
          const inventory = new Map((bag.items ?? []).map(item => [item.itemId, Number(item.num)]));
          rewards?.observe('loop.heroes','已读取英雄与库存，检查养成条件');rewards?.expect('loop.heroes',rewards.now()+Math.ceil(getEveryMs()/1000));
          const plan = planHeroes({ config, heroes: list.heroes ?? [], itemNum: id => inventory.get(id) ?? 0, playerLevel: player?.level ?? 1, settings: getSettings() });
          const results = await runHeroPlan(client, protocol, plan, { allowMutate, getSettings, beforeAction: guard.before, afterAction: guard.after, cancelAction: guard.cancel,
            enabled: () => !stop.aborted && client.connected && getSettings()?.loop.heroes,
            onStep: entry => stepLog('tasks')({ ...entry, category: '英雄', title: `${entry.step.heroId} ${entry.step.kind === 'level' ? '升级' : entry.step.kind === 'star' ? '升星' : '技能升级'}` }) });
          summary.tasks.planned += results.length;
          summary.tasks.results.push(...results);
        } catch (error) { phaseFailure('tasks', '自动英雄养成', error); }
      }
      await checkForge();
      await checkAntique();
      await checkExtended();
      await checkDispatch();
    });
    mainRoundFinished = true;
    if (stop.aborted) break;

    merchantRoundSeconds = Math.max(merchantRoundSeconds, Math.ceil((Date.now() - roundStartedMs) / 1000));
    history.push(summary);
    if (!Number.isFinite(total) && history.length > 50) history.shift();
    onRound?.(summary);
    if (round < total && !stop.aborted) {
      try {
        const signal = typeof stop.addEventListener === 'function' ? stop : undefined;
        const nextRound = Date.now() + getEveryMs();
        let upgradeAt = Date.now() + 30_000;
        while (isEnabled && !stop.aborted) {
          const afkAt = enabled('afk') ? (afkDeadline ?? Date.now() + 60_000) : Infinity;
          const factoryAt = enabled('collect') || enabled('startProduce') ? factoryDeadline ?? Infinity : Infinity;
          const treasureNext = treasureAutomationEnabled(getSettings()) ? treasureAt : Infinity;
          const cityNext = cityWarEnabled(getSettings()) ? cityWarAt : Infinity;
          const forgeNext = forgeEnabled(getSettings()) ? forgeAt : Infinity;
          const antiqueNext = antiqueEnabled(getSettings()) ? antiqueAt : Infinity;
          const radarNext=getSettings()?.radar.enabled?radarAt:Infinity;
          const maintenanceNext=fleetMaintenanceEnabled(getSettings())?maintenanceAt:Infinity;
          const merchantAt = merchantNext();
          const wakeAt = Math.min(siliconNext(), extendedNext(), merchantAt,maintenanceNext,radarNext,afkAt, factoryAt, enabled('upgrade') ? upgradeAt : Infinity, treasureNext, cityNext, forgeNext, antiqueNext);
          if (wakeAt >= nextRound) break;
          await waitWithFollow(Math.max(0, wakeAt - Date.now()), signal);
          if (Date.now() >= nextRound) break;
          if (merchantNext() <= Date.now()) await schedule(checkMerchant);
          if (extendedNext() <= Date.now()) await schedule(checkExtended);
          if (siliconNext() <= Date.now()) await schedule(checkDispatch);
          if (Math.min(maintenanceNext,fleetMaintenanceEnabled(getSettings())?maintenanceAt:Infinity,radarNext,cityNext,treasureNext,treasureAutomationEnabled(getSettings())?treasureAt:Infinity)<=Date.now()) await schedule(checkDispatch);
          if (forgeNext <= Date.now() && forgeEnabled(getSettings())) await schedule(checkForge);
          if (antiqueNext <= Date.now() && antiqueEnabled(getSettings())) await schedule(checkAntique);

          if (afkAt <= Date.now() && enabled('afk')) {
            afkDeadline = undefined;
            await schedule(async () => {
              if (!enabled('afk')) return;
              await claimRewards(client, protocol, config, logReward, key => key === 'afk' && enabled(key), rememberDeadline, rewards, player, { settings: getSettings() });
              try { await claimAfkAdNow(); } catch (error) { phaseFailure('tasks', '闯关挂机广告收益', error); }
            });
            if (!afkDeadline || afkDeadline <= Date.now()) afkDeadline = Date.now() + 60_000;
          }
          const checkUpgrade = enabled('upgrade') && upgradeAt <= Date.now();
          if ((factoryAt <= Date.now() || checkUpgrade) && Date.now() < nextRound) {
            await schedule(async () => {
              if (!enabled('collect') && !enabled('startProduce') && !enabled('upgrade')) return;
              try {
                const holdForOrders = enabled('startProduce') || enabled('finishOrder') || checkUpgrade;
                const survey = await surveyWorld(client, protocol, { config, player, includeWeekOrder: holdForOrders || needsCargoDemand(getSettings()),
                  includeCargo: (enabled('cargo') && holdForOrders) || needsCargoDemand(getSettings()) });
                // 主轮后募兵/上船可能已消耗需求或达到日限；定时补产不能沿用旧需求。
                if (getSettings() && enabled('startProduce')) {
                  const currentSettings = getSettings();
                  const extra = await surveyBaseAutomation(client, protocol, config, player, currentSettings, survey,
                    { ledger: usageLedger, enabled: () => !stop.aborted && client.connected !== false });
                  extraDemand = currentSettings === getSettings() ? baseDemands(extra, config, currentSettings) : [];
                }
                const orderRead = !survey.notes.some(note => note.startsWith('本轮未能读取周订单'));
                const allow = kind => {
                  if (kind === 'gainFactory') return enabled('collect');
                  if (kind === 'finishUpgrade') return checkUpgrade && enabled('finishUpgrade');
                  if (kind === 'upgrade') return checkUpgrade && enabled('upgrade') && orderRead;
                  return kind === 'startProduce' && enabled('startProduce') && orderRead;
                };
                const plan = planWorld(survey, { config, enabled: allow, settings: getSettings(), usage: usage(), extraDemand });
                const freshGuard = createActionGuard(client, getSettings, usageLedger, { player, enabled: () => !stop.aborted && client.connected });
                const result = await runWorldRound(client, protocol, plan, { ...harvestOptions, allowMutate, enabled: allow, onStep: stepLog('world'),
                  beforeStep: freshGuard.before, afterStep: freshGuard.after, cancelStep: freshGuard.cancel });
                summary.world.planned += result.results.length;
                summary.world.results.push(...result.results);
                const state = plan.actions.some(a => allow(a.kind)) ? normalize(await client.request('OnWaterRequest', {})).building : survey.factories;
                factoryDeadline = nextFactoryCheck(state, client.serverClockOffsetMs || 0, enabled('collect'));
              } catch (error) {
                if (stop.aborted) return;
                factoryDeadline = Date.now() + 30_000;
                phaseFailure('world', '定时收货与补产', error);
              }
            });
            if (checkUpgrade) upgradeAt = Date.now() + 30_000;
          }
        }
        while(!stop.aborted&&Date.now()<nextRound){
          const merchantAt = merchantNext();
          const changed=await waitWithFollow(Math.max(0,Math.min(nextRound,merchantAt,siliconNext(),extendedNext())-Date.now()),signal);
          if (merchantNext() <= Date.now()) await schedule(checkMerchant);
          if (extendedNext() <= Date.now()) await schedule(checkExtended);
          if (siliconNext() <= Date.now()) await schedule(checkDispatch);
          if(changed)await schedule(checkDispatch);
          else if (Date.now() >= nextRound) break;
        }
      }
      catch (error) { if (!stop.aborted) throw error; }
    }
  }
  }finally{unsubscribeFollow();unsubscribeMaintenance();unsubscribeMerchant();unsubscribeSilicon();client.off?.('automationSettingsChanged',settingsWake);client.off?.('message',extendedPush);watchFleetMaintenance(client).hold([]);followWake=null;}

  return { history, rejected };
}

export function formatLoopStep(entry) {
  const category = entry.category ?? ({ tasks: '任务', dailies: '日常', world: '海面' })[entry.phase] ?? '挂机';
  const title = entry.step?.label || entry.title || entry.label;
  const action = [title, entry.note && entry.note !== title ? entry.note : null].filter(Boolean).join(' · ') || '检查任务';
  const message = category + ' · ' + action;
  if (entry.status==='pending'||entry.status==='unknown') return message+'等待确认：'+(entry.reason||'保留记录，不重复提交');
  if (entry.skipped) {
    const reason = entry.reason || entry.error;
    if(reason===title)return category+' · '+reason+'（等待）';
    return message + '已跳过' + (reason ? '：' + reason : '');
  }
  if (entry.ok === false) return message + '失败：' + (entry.error || '未返回原因');
  if(entry.status==='confirmed')return message+'（已确认）';
  if ('sent' in entry) return message + '（已发送）';
  return message;
}

export function formatLoopRound(summary) {
  const results = [...summary.tasks.results, ...summary.dailies.results, ...summary.world.results];
  const skipped = results.filter(entry => entry.skipped).length;
  const failed = results.filter(entry => !entry.skipped && entry.ok === false && !['unknown','pending'].includes(entry.status)).length;
  const sent = results.filter(entry => !entry.skipped && entry.ok && 'sent' in entry).length;
  const done = results.filter(entry => !entry.skipped && entry.ok && !('sent' in entry)).length;
  const pending=results.filter(entry=>['pending','unknown'].includes(entry.status)).length;
  const counts = [];
  if(pending)counts.push('待确认 '+pending+' 项');
  if (done) counts.push('完成 ' + done + ' 项');
  if (sent) counts.push('已发送 ' + sent + ' 项');
  if (skipped) counts.push('跳过 ' + skipped + ' 项');
  if (failed) counts.push('失败 ' + failed + ' 项');
  return '挂机第 ' + summary.round + ' 轮结束 · ' + (counts.join('，') || '本轮没有可执行的操作')
    + (summary.world.population ? ' · 人口 ' + summary.world.population : '');
}
