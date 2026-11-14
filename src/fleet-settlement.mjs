import { exactAutomationId } from './automation-policy.mjs';
import { normalize } from './worlds.mjs';

const fleetKey = /^(?:radar-send|world-boss|pirate-first|cityWar|treasureRepair|treasure|silicon|silicon-repair|silicon-retreat|silicon-speed):(\d+):/;
const repairKinds = new Set(['cityRepair', 'treasureRepair']);
const integer = Number.isSafeInteger;
const dayOf = (seconds) => Math.floor((seconds + 28800) / 86400);
const zeroId = (value) =>
  value == null || value === 0 || value === '0' || (value.low === 0 && value.high === 0);

export function recordsInWorld(records, worldId) {
  const selected = {};
  for (const [key, record] of Object.entries(records)) {
    const match = fleetKey.exec(key);
    if (match && worldId && match[1] !== String(worldId)) continue;
    const d = record.details;
    // 早期的货轮和城战用键保存舰队编号。只恢复键能够确定的身份。
    const cargo = /^treasure:(\d+):(\d+):([1-9]\d*)$/.exec(key);
    const slot = /^(cityWar|treasureRepair):(\d+):([1-9]\d*)$/.exec(key);
    if (cargo && (!d?.kind || !d.buildingId || !d.uid))
      selected[key] = {
        ...record,
        details: { kind: 'treasureDispatch', uid: cargo[2], buildingId: cargo[3] + '远征船', ...d }
      };
    else if (slot && (!d?.kind || !d.buildingId))
      selected[key] = {
        ...record,
        details: {
          kind: slot[1] === 'cityWar' ? 'citySlot' : 'treasureRepair',
          buildingId: slot[3] + '远征船',
          ...d
        }
      };
    else selected[key] = record;
  }
  return selected;
}

export function fleetAtHome(fleet) {
  return (
    fleet?.state === 1 && fleet.curGridIdx === 0 && zeroId(fleet.treasureLootUid) && !fleet.chipWar?.rewardTs
  );
}

export function radarEvents(info) {
  if (!Array.isArray(info?.events)) return null;
  const events = info.events.map((e) => ({
    ...normalize(e),
    uid: exactAutomationId(e.uid),
    eventId: e.eventId,
    state: e.state,
    createTime: e.createTime,
    startTime: e.startTime,
    fixed: false
  }));
  if (info.fixedEvent?.eventId > 0) {
    const e = info.fixedEvent;
    events.push({
      ...normalize(e),
      uid: '1',
      eventId: e.eventId,
      state: e.state,
      createTime: e.createTime,
      startTime: e.startTime,
      fixed: true
    });
  }
  if (
    events.some(
      (e) =>
        !e.uid ||
        !integer(e.eventId) ||
        e.eventId <= 0 ||
        !integer(e.createTime) ||
        e.createTime < (e.fixed ? 1 : 0) ||
        ![1, 2, 3, 4].includes(e.state)
    )
  )
    return null;
  if (new Set(events.map(radarKey)).size !== events.length) return null;
  return events;
}

export const radarKey = (e) => (e.fixed ? 'fixed-' + e.eventId + '-' + e.createTime : e.uid);
export function radarDispatchConfirmed(snapshot, event, buildingId) {
  if (!event) return false;
  if (event.state === 3 || event.state === 4) return true;
  if (event.state !== 2 || !integer(event.gridIdx) || event.gridIdx < 0) return false;
  const fleet = snapshot.fleets.find((f) => f.buildingId === buildingId);
  return (
    !!fleet &&
    ((fleet.state === 2 && fleet.targetGridIdx === event.gridIdx) ||
      (fleet.state === 3 && fleet.curGridIdx === event.gridIdx))
  );
}

export function outstandingFleets(records, worldId) {
  return Object.entries(recordsInWorld(records, worldId)).filter(([key, r]) => {
    const match = fleetKey.exec(key),
      d = r.details;
    if (!match || match[1] !== String(worldId) || r.expired || !d?.buildingId) return false;
    if (d.kind === 'radarSend' || d.kind === 'worldBoss') return d.active !== false;
    if (d.kind === 'pirateFirst') return !['won', 'lost'].includes(d.outcome);
    return (
      repairKinds.has(d.kind) ||
      d.kind === 'citySlot' ||
      d.kind === 'cityDispatch' ||
      (d.kind === 'treasureDispatch' && !r.confirmed)
    );
  });
}

function personalBattleMatches(details, report) {
  const at = normalize(report.createTime);
  if (!integer(at)) return false;
  if (details.kind === 'worldBoss')
    return (
      report.type === 5 &&
      report.worldBoss?.bossId === details.bossId &&
      dayOf(at) === details.day &&
      (!details.sentAt || at >= details.sentAt)
    );
  return (
    details.kind === 'pirateFirst' &&
    details.ownBattle === true &&
    integer(details.battleAt) &&
    report.type === 1 &&
    report.scenarioId === details.scenarioId &&
    report.pirate?.type === details.type &&
    report.pirate.level === details.level &&
    Math.abs(at - details.battleAt) <= 1 &&
    typeof report.win === 'boolean'
  );
}

// 对已有派遣做结算，不发出游戏动作。先按读回前的记录编号限定范围，防止迟到快照释放新占用。
export function settleFleetSnapshot(
  ledger,
  { worldId, fleets, events, reports, kills, cargoUids, now, kinds, baseline }
) {
  if (!ledger?.keyRecords || !worldId || !Array.isArray(fleets)) return [];
  const records = ledger.keyRecords(),
    changes = [];
  for (const [key, r] of outstandingFleets(records, worldId)) {
    const d = r.details;
    if (
      (kinds && !kinds.includes(d.kind)) ||
      (baseline && (!baseline[key] || baseline[key].id !== r.id || baseline[key].confirmed !== r.confirmed))
    )
      continue;
    const own = fleets.filter((f) => f.buildingId === d.buildingId);
    if (own.length !== 1) continue;
    const fleet = own[0],
      home = fleetAtHome(fleet);
    if (d.kind === 'radarSend') {
      if (!Array.isArray(events) || !d.eventKey || key !== 'radar-send:' + worldId + ':' + d.eventKey)
        continue;
      const event = events.find((e) => radarKey(e) === d.eventKey);
      if (!r.confirmed && radarDispatchConfirmed({ fleets }, event, d.buildingId)) {
        ledger.resolveKey(key, true);
        changes.push({ key, reason: '确认情报派遣' });
      } else if (r.confirmed && home && (!event || event.state === 4 || event.state === 1)) {
        // 同一事件退回待处理、原舰队已经返航，也是这一次派遣的终态。
        const reason = !event ? '事件已离开列表' : event.state === 4 ? '情报可领奖' : '情报已退回待处理';
        ledger.updateKeyDetails(key, { ...d, active: false, releaseReason: reason });
        changes.push({ key, reason });
      }
      continue;
    }
    if (d.kind === 'worldBoss') {
      const atTarget =
        integer(d.grid) &&
        d.grid > 0 &&
        ((fleet.state === 2 && fleet.targetGridIdx === d.grid) ||
          ([3, 5].includes(fleet.state) && fleet.curGridIdx === d.grid));
      if (atTarget && (!r.confirmed || !d.observed)) {
        ledger.resolveKey(key, true, { ...d, observed: true });
        changes.push({ key, reason: '确认首战目标' });
      } else if (r.confirmed && home) {
        const ended = reports?.some((r) => personalBattleMatches(d, r));
        if (d.observed || ended || (integer(d.day) && integer(now) && dayOf(now) > d.day)) {
          ledger.updateKeyDetails(key, { ...d, active: false });
          changes.push({ key, reason: '首战舰队已返航' });
        }
      }
      continue;
    }
    if (d.kind === 'pirateFirst') {
      if (r.confirmed && kills?.some((k) => k.type === d.type && k.maxKilledLevel >= d.level)) {
        ledger.resolveKey(key, true, { ...d, outcome: 'won' });
        changes.push({ key, reason: '个人首杀等级已确认' });
      } else if (r.confirmed && home && d.ownBattle && integer(d.battleAt)) {
        const matches = (reports ?? []).filter((report) => personalBattleMatches(d, report));
        const competing = Object.values(recordsInWorld(records, worldId)).filter(
          (other) =>
            other.details?.kind === 'pirateFirst' &&
            other.details.type === d.type &&
            other.details.level === d.level &&
            Math.abs(other.details.battleAt - d.battleAt) <= 2
        );
        if (
          matches.length === 1 &&
          !matches[0].win &&
          competing.length === 1 &&
          exactAutomationId(matches[0].uid)
        ) {
          ledger.resolveKey(key, true, {
            ...d,
            outcome: 'lost',
            reportId: exactAutomationId(matches[0].uid)
          });
          changes.push({ key, reason: '个人战报确认首杀战败并返航' });
        }
      }
      // 单靠空闲或全服广播不能核销未知首杀。首杀模块另行核实参战格、目标和个人战报。
      continue;
    }
    if (d.kind === 'treasureDispatch') {
      if (
        !r.confirmed &&
        d.uid > 0 &&
        exactAutomationId(fleet.treasureLootUid) === exactAutomationId(d.uid)
      ) {
        ledger.resolveKey(key, true);
        changes.push({ key, reason: '确认货轮派遣' });
      } else if (
        !r.confirmed &&
        home &&
        exactAutomationId(d.uid) &&
        Array.isArray(cargoUids) &&
        !cargoUids.includes(exactAutomationId(d.uid))
      ) {
        // 已消失的目标无法继续占用归队舰队。是否扣费仍未知，按原规则保留预算。
        ledger.resolveKey(key, false);
        changes.push({ key, reason: '货轮目标消失且舰队已归队' });
      }
      continue;
    }
    if (d.kind === 'citySlot') {
      if (r.confirmed && home) {
        ledger.releaseCompletedKey(key);
        changes.push({ key, reason: '已确认的旧城战槽位已归队' });
      }
      continue;
    }
    if (repairKinds.has(d.kind) || d.kind === 'cityDispatch') {
      let confirmed = r.confirmed;
      if (!confirmed) {
        const observed = repairKinds.has(d.kind)
          ? (fleet.state === 4 && fleet.repairing?.endTs > now) ||
            (integer(fleet.durability) &&
              integer(d.beforeDurability) &&
              fleet.durability > d.beforeDurability)
          : (fleet.state === 2 && fleet.targetCityId === d.cityId) ||
            (fleet.cityId === d.cityId &&
              ([3, 5].includes(fleet.state) || (fleet.state === 1 && fleet.curGridIdx > 0)));
        if (!observed) continue;
        ledger.resolveKey(key, true);
        confirmed = true;
        changes.push({ key, reason: '确认城战或维修' });
      }
      if (confirmed && home) {
        ledger.releaseCompletedKey(key);
        changes.push({ key, reason: '已返航，释放舰队槽位' });
      }
    }
  }
  return changes;
}

// 缺少终态时才读取个人战报。首杀的同一战斗时间若对应多份战报，继续保留占用。
const reportCache = new WeakMap();
export function invalidateFleetReports(client) {
  reportCache.delete(client);
}
async function completionReports(client, worldId, records) {
  const signature = JSON.stringify([worldId, ...records.map((r) => [r.id, r.details.battleAt])]);
  const previous = reportCache.get(client);
  if (previous?.signature === signature && Date.now() - previous.at < 60000) return previous.reports;
  const found = new Map();
  let total = null,
    received = 0,
    complete = false;
  for (let pageNo = 0; pageNo < 200; pageNo++) {
    const page = await client.request('CampaignReportsRequest', { pageNo }, 'CampaignReportsResponse', 8000);
    if (
      !Array.isArray(page?.reports) ||
      !integer(page.total) ||
      page.total < 0 ||
      (total !== null && total !== page.total)
    )
      break;
    total = page.total;
    received += page.reports.length;
    for (const report of page.reports)
      if (records.some((r) => personalBattleMatches(r.details, report))) {
        const id = exactAutomationId(report.uid);
        if (id) found.set(id, report);
        else if (report.type === 5) found.set('boss:' + report.worldBoss.bossId, report);
      }
    if (received >= total) {
      complete = true;
      break;
    }
    if (!page.reports.length) break;
    if (
      records.every(
        (r) =>
          r.details.kind === 'worldBoss' &&
          [...found.values()].some((rep) => personalBattleMatches(r.details, rep))
      )
    )
      break;
  }
  const reports = [...found.values()].filter((r) => r.type === 5 || complete);
  reportCache.set(client, { signature, reports, at: Date.now() });
  return reports;
}

const checking = new WeakMap();
export async function checkFleetSettlement(client, player, ledger, { afterPush = false } = {}) {
  const worldId = exactAutomationId(player?.worldId),
    owner = exactAutomationId(player?.playerId);
  const sameOwner = () =>
    exactAutomationId(player.worldId) === worldId && exactAutomationId(player.playerId) === owner;
  if (!ledger?.keyRecords || !worldId) return [];
  const active = checking.get(client);
  if (active) {
    if (!afterPush) return active;
    await active;
    return checkFleetSettlement(client, player, ledger);
  }
  const baseline = ledger.keyRecords(),
    outstanding = outstandingFleets(baseline, worldId);
  if (!outstanding.length) return [];
  const job = (async () => {
    const kinds = new Set(outstanding.map(([, record]) => record.details.kind));
    const read = async (name) => {
      try {
        return await client.request(name + 'Request', {}, name + 'Response', 8000);
      } catch {
        return null;
      }
    };
    const [own, radar, pirate, cargo] = await Promise.all([
      read('MyFleets'),
      kinds.has('radarSend') ? read('RadarInfo') : null,
      kinds.has('pirateFirst') ? read('PirateKillRecord') : null,
      kinds.has('treasureDispatch') ? read('TreasureLootList') : null
    ]);
    if (!Array.isArray(own?.fleets) || !sameOwner() || client.connected === false) return [];
    const now = Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
    let reports;
    const needReport = outstanding
      .map(([, r]) => r)
      .filter((r) => {
        if (!r.confirmed || !own.fleets.some((f) => f.buildingId === r.details.buildingId && fleetAtHome(f)))
          return false;
        if (r.details.kind === 'worldBoss') return !r.details.observed && dayOf(now) === r.details.day;
        return (
          r.details.kind === 'pirateFirst' &&
          r.details.ownBattle &&
          integer(r.details.battleAt) &&
          !pirate?.records?.some((k) => k.type === r.details.type && k.maxKilledLevel >= r.details.level)
        );
      });
    if (needReport.length) {
      try {
        reports = await completionReports(client, worldId, needReport);
      } catch {
        /* 读不到战报时保留原占用。 */
      }
    }
    if (!sameOwner() || client.connected === false) return [];
    const cargoIds = Array.isArray(cargo?.treasure)
      ? cargo.treasure.map((t) => exactAutomationId(t.uid))
      : null;
    return settleFleetSnapshot(ledger, {
      worldId,
      fleets: own.fleets,
      events: radarEvents(radar?.radarInfo),
      kills: pirate?.records,
      cargoUids:
        cargoIds && cargoIds.every(Boolean) && new Set(cargoIds).size === cargoIds.length ? cargoIds : null,
      reports,
      now,
      baseline
    });
  })();
  checking.set(client, job);
  try {
    return await job;
  } finally {
    if (checking.get(client) === job) checking.delete(client);
  }
}
