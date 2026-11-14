import fs from 'node:fs';
import { normalize } from './worlds.mjs';
import { exactAutomationId } from './automation-policy.mjs';
import { restorePirateFlight } from './pirates.mjs';
import { savePirateOutcome } from './pirate-advance.mjs';

const SECOND = 1000;
const WINDOW = 15 * 60 * SECOND;

// 历史协议日志的正文最多400字符。只采用截断前已完整记录的 JSON 字段。
function readPrefix(text) {
  try {
    return JSON.parse(text);
  } catch {
    /* 尝试读取最后一个完整字段之前的内容。 */
  }
  const stack = [];
  let quoted = false,
    escaped = false,
    complete = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') stack.push('}');
    else if (char === '[') stack.push(']');
    else if (char === '}' || char === ']') {
      if (stack.pop() !== char) return null;
    } else if (char === ',') complete = text.slice(0, i) + [...stack].reverse().join('');
  }
  try {
    return JSON.parse(complete);
  } catch {
    return null;
  }
}

// 按时间定位一个有限窗口，避免在每次登录时从头加载整个协议文件。
function traceWindow(file, from, until) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    let lo = 0,
      hi = size;
    const sample = Buffer.alloc(4096);
    while (hi - lo > 65536) {
      const mid = lo + Math.floor((hi - lo) / 2);
      const n = fs.readSync(fd, sample, 0, sample.length, mid);
      const line = sample.toString('utf8', 0, n).split('\n')[1];
      const stamp = Date.parse(line?.slice(0, 24));
      if (!Number.isFinite(stamp)) return [];
      if (stamp < from) lo = mid;
      else hi = mid;
    }
    const buffer = Buffer.alloc(Math.min(size - lo, 8 * 1024 * 1024));
    const n = fs.readSync(fd, buffer, 0, buffer.length, lo);
    const lines = buffer.toString('utf8', 0, n).split('\n');
    if (lo) lines.shift();
    return lines.filter((line) => {
      const time = Date.parse(line.slice(0, 24));
      return time >= from && time <= until;
    });
  } finally {
    fs.closeSync(fd);
  }
}

export function replayPirateReceipt(lines, { accountId, player, record, sentAt, offset = 0 }) {
  const d = record.details;
  const owner = exactAutomationId(player.playerId);
  if (!owner || String(normalize(player.worldId)) !== d.world || !Number.isFinite(sentAt)) return null;
  const prefix = ' [' + accountId.slice(0, 8) + '] ';
  const events = [];
  for (const line of lines) {
    if (!line.startsWith(prefix, 24)) continue;
    const entry = line.slice(24 + prefix.length);
    const match = /^(-> )?\[(\w+)\] seq=\d+ (.*)$/.exec(entry);
    if (!match) continue;
    const at = Date.parse(line.slice(0, 24)) + offset;
    events.push({ at, name: match[2], out: !!match[1], text: match[3] });
  }
  const sends = events.filter(
    (e) => e.out && e.name === 'ChallengePirateRequest' && Math.abs(e.at - sentAt) <= 2 * SECOND
  );
  if (sends.length !== 1) return null;
  let grid = null,
    begin = null,
    fought = false,
    end = null,
    returned = false,
    personalWin = false;
  const reports = new Map();
  for (const e of events) {
    if (e.at < sends[0].at) continue;
    if (e.out) {
      if (e !== sends[0] && e.name === 'ChallengePirateRequest' && !returned) return null;
      continue;
    }
    if (
      ![
        'SCMyFleetUpdate',
        'SCPirateCampaignBegin',
        'SCPirateCampaignEnd',
        'CampaignReportsResponse',
        'PirateKillRecordResponse',
        'SCPirateKillRecordUpdate'
      ].includes(e.name)
    )
      continue;
    const body = readPrefix(e.text);
    if (!body) continue;
    if (e.name === 'SCMyFleetUpdate') {
      const fleet = body.fleets?.find(
        (f) => f.buildingId === d.buildingId && exactAutomationId(f.owner?.playerId) === owner
      );
      if (!fleet) continue;
      if (
        grid === null &&
        fleet.state === 2 &&
        fleet.targetGridIdx > 0 &&
        Math.abs(fleet.moveStartTs * SECOND - sentAt) <= 2 * SECOND
      ) {
        if (d.grid != null && d.grid !== fleet.targetGridIdx) return null;
        grid = fleet.targetGridIdx;
      }
      if (grid !== null && fleet.state === 3 && fleet.curGridIdx === grid && !end) fought = true;
      if (end && fleet.state === 2 && fleet.startGridIdx === grid && fleet.targetGridIdx !== grid)
        returned = true;
    } else if (e.name === 'SCPirateCampaignBegin' && grid !== null && body.uid === d.uid && !end) {
      if (begin !== null) return null;
      begin = Math.floor(e.at / SECOND);
    } else if (
      e.name === 'SCPirateCampaignEnd' &&
      body.uid === d.uid &&
      begin !== null &&
      fought &&
      !end &&
      typeof body.isWin === 'boolean'
    ) {
      end = { win: body.isWin };
    } else if (end?.win && ['PirateKillRecordResponse', 'SCPirateKillRecordUpdate'].includes(e.name)) {
      const records = body.records ?? [body.record];
      if (records.some((r) => r?.type === d.type && r.maxKilledLevel >= d.level)) personalWin = true;
    } else if (e.name === 'CampaignReportsResponse' && end) {
      for (const report of body.reports ?? []) {
        const id = exactAutomationId(report.uid),
          time = normalize(report.createTime);
        if (
          id &&
          report.type === 1 &&
          report.pirate?.type === d.type &&
          report.pirate.level === d.level &&
          report.scenarioId === (player.scenarioId || 1) &&
          Math.abs(time - begin) <= 1 &&
          typeof report.win === 'boolean'
        )
          reports.set(id, report);
      }
    }
  }
  if (
    !returned ||
    reports.size !== 1 ||
    !end ||
    [...reports.values()][0].win !== end.win ||
    (end.win && !personalWin)
  )
    return null;
  return { outcome: end.win ? 'won' : 'lost', grid, reportId: [...reports.keys()][0], battleAt: begin };
}

export function recoverPirateHunts(client, player, ledger, accountId, tracePath) {
  if (!player) return [];
  const world = String(normalize(player.worldId)),
    offset = client.serverClockOffsetMs || 0,
    results = [];
  for (const [key, record] of Object.entries(ledger.keyRecords())) {
    const d = record.details;
    if (
      record.expired ||
      d?.kind !== 'pirateFirst' ||
      d.world !== world ||
      ['won', 'lost'].includes(d.outcome)
    )
      continue;
    const sentAt = d.sentAt ?? ledger.reservationTime(key);
    if (!Number.isFinite(sentAt)) continue;
    if (tracePath && fs.existsSync(tracePath)) {
      const from = sentAt - offset;
      const proof = replayPirateReceipt(traceWindow(tracePath, from - 2 * SECOND, from + WINDOW), {
        accountId,
        player,
        record,
        sentAt,
        offset
      });
      if (proof) {
        ledger.resolveKey(key, true, { ...d, ...proof });
        results.push({ key, ...proof });
        continue;
      }
    }
    // 重连时仍在途的新版派遣继续监听本人舰队和个人记录，不发起新挑战。
    const age = Date.now() + offset - sentAt;
    if (age >= 0 && age <= WINDOW && Number.isSafeInteger(d.grid) && d.grid >= 0)
      restorePirateFlight(client, d, (event) => savePirateOutcome(ledger, key, event));
  }
  return results;
}
