import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUsageLedger } from '../src/automation-settings.mjs';
import { fleetRecordReason } from '../src/fleet-availability.mjs';
import { recoverPirateHunts, replayPirateReceipt } from '../src/pirate-recovery.mjs';
import { savePirateOutcome } from '../src/pirate-advance.mjs';

export function testPirateRecovery() {
  const at = Date.UTC(2026, 10, 4, 16, 38, 37, 700);
  const second = Math.floor(at / 1000);
  const accountId = 'fleet-test-account';
  const player = { worldId: 1000100, playerId: 9001, scenarioId: 1 };
  const details = {
    kind: 'pirateFirst',
    world: '1000100',
    buildingId: '1远征船',
    type: 3,
    level: 22,
    uid: 701,
    outcome: 'unknown'
  };
  const key = 'pirate-first:1000100:3:22:701';
  const record = { details, confirmed: false };
  const line = (seconds, text) =>
    new Date(at + seconds * 1000).toISOString() + ' [' + accountId.slice(0, 8) + '] ' + text;
  const packet = (sec, name, body) => line(sec, '[' + name + '] seq=1 ' + JSON.stringify(body).slice(0, 400));
  const fleet = (sec, fields) =>
    packet(sec, 'SCMyFleetUpdate', {
      fleets: [
        { buildingId: details.buildingId, owner: { playerId: 9001 }, ...fields, padding: '截断'.repeat(220) }
      ]
    });
  const report = {
    uid: 55001,
    type: 1,
    win: false,
    createTime: second + 7,
    pirate: { type: 3, level: 22 },
    scenarioId: 1
  };
  const lines = [
    line(0, '-> [ChallengePirateRequest] seq=7 41B'),
    fleet(0.04, {
      state: 2,
      targetCityId: 0,
      targetGridIdx: 66794,
      moveStartTs: second,
      moveEndTs: second + 7
    }),
    fleet(7, { state: 5, cityId: 39, curGridIdx: 66794 }),
    packet(7, 'SCPirateCampaignBegin', { uid: 701 }),
    fleet(7.01, { state: 3, cityId: 39, curGridIdx: 66794 }),
    packet(10, 'SCPirateCampaignEnd', { uid: 701, isWin: false }),
    fleet(10.1, { state: 2, startGridIdx: 66794, targetGridIdx: 53796 }),
    packet(30, 'CampaignReportsResponse', { reports: [report, { padding: '截断'.repeat(220) }] })
  ];
  const options = { accountId, player, record, sentAt: at };
  assert.equal(replayPirateReceipt(lines, options)?.outcome, 'lost');
  for (const index of [0, 1, 3, 4, 5, 6, 7]) {
    assert.equal(
      replayPirateReceipt(
        lines.filter((_, i) => i !== index),
        options
      ),
      null
    );
  }
  assert.equal(replayPirateReceipt(lines, { ...options, player: { ...player, playerId: 9002 } }), null);
  assert.equal(replayPirateReceipt(lines, { ...options, accountId: 'different' }), null);
  assert.equal(replayPirateReceipt(lines, { ...options, player: { ...player, worldId: 2020000 } }), null);
  assert.equal(
    replayPirateReceipt(
      [...lines, packet(32, 'CampaignReportsResponse', { reports: [{ ...report, uid: 55002 }] })],
      options
    ),
    null
  );
  assert.equal(
    replayPirateReceipt(
      lines.map((x) => x.replace('"isWin":false', '"isWin":true')),
      options
    ),
    null
  );
  const winning = lines.map((x) =>
    x.replace('"isWin":false', '"isWin":true').replace('"win":false', '"win":true')
  );
  assert.equal(replayPirateReceipt(winning, options), null);
  assert.equal(
    replayPirateReceipt(
      [...winning, packet(35, 'PirateKillRecordResponse', { records: [{ type: 3, maxKilledLevel: 22 }] })],
      options
    )?.outcome,
    'won'
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-hunt-recover-'));
  try {
    const log = path.join(dir, 'protocol.log');
    fs.writeFileSync(log, lines.join('\n') + '\n');
    let now = at;
    const ledger = createUsageLedger(accountId, { file: path.join(dir, 'usage.json'), now: () => now });
    ledger.reserve({ piratePetrol: 300 }, {}, {}, { uniqueKey: key, details });
    ledger.reserve(
      { radarPetrol: 200 },
      {},
      {},
      { uniqueKey: 'other', details: { kind: 'radarSend', buildingId: '2远征船' } }
    );
    const client = new EventEmitter();
    assert.equal(recoverPirateHunts(client, player, ledger, accountId, log).length, 1);
    assert.equal(ledger.confirmedCounters().piratePetrol, 300);
    assert.equal(ledger.pendingCounters().piratePetrol ?? 0, 0);
    assert.equal(ledger.pendingCounters().radarPetrol, 200);
    assert.equal(fleetRecordReason(ledger.keyRecords(), '1远征船'), '');
    assert.equal(recoverPirateHunts(client, player, ledger, accountId, log).length, 0);
    savePirateOutcome(ledger, key, { status: 'started' });
    assert.equal(ledger.keyRecords()[key].details.outcome, 'lost');
    assert.equal(ledger.confirmedCounters().piratePetrol, 300);
    const next = createUsageLedger(accountId, { file: path.join(dir, 'next.json'), now: () => now });
    next.reserve({ piratePetrol: 300 }, {}, {}, { uniqueKey: key, details });
    now += 86400000;
    recoverPirateHunts(client, player, next, accountId, log);
    assert.equal(next.keyRecords()[key].details.outcome, 'lost');
    assert.equal(next.confirmedCounters().piratePetrol ?? 0, 0);
    // 重连时旧的参战标记不能单独证明收到的全服战败广播属于本队。
    const clock = Date.now();
    const resumed = createUsageLedger(accountId, {file:path.join(dir,'resumed.json'),now:()=>clock});
    resumed.reserve({piratePetrol:300},{},{},{uniqueKey:key,details:{...details,sentAt:clock,grid:66794,ownBattle:true}});
    const reconnect = new EventEmitter();
    recoverPirateHunts(reconnect,player,resumed,accountId,null);
    reconnect.emit('message',{name:'SCPirateCampaignEnd',body:{uid:701,isWin:false}});
    assert.equal(resumed.pendingCounters().piratePetrol,300);
    reconnect.emit('message',{name:'SCMyFleetUpdate',body:{fleets:[{buildingId:'1远征船',state:3,curGridIdx:66794,cityId:39}]}});
    reconnect.emit('message',{name:'SCPirateCampaignEnd',body:{uid:701,isWin:false}});
    assert.equal(resumed.keyRecords()[key].details.outcome,'lost');
    assert.equal(resumed.confirmedCounters().piratePetrol,300);
    assert.equal(fleetRecordReason(resumed.keyRecords(),'1远征船'),'');
  } finally {
    for (const name of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, name));
    fs.rmdirSync(dir);
  }
}
