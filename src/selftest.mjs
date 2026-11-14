import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadProtocol } from './proto.mjs';
import { createCodec, HEADER_PREFIX } from './codec.mjs';
import { compressBlock, decompressBlock, compressBound, makeHashTable } from './lz4.mjs';
import { GameClient } from './client.mjs';
import { createStageTask, runStages, stageFailureLimit } from './stages.mjs';

const require = createRequire(import.meta.url);
const minimal = require('protobufjs/minimal');

const protocol = loadProtocol();
const codec = createCodec(protocol);

function referenceEncode(name, seq, body) {
  const nameLength = name.length;
  const headerLength = HEADER_PREFIX + nameLength + 1;
  const headerBuffer = new ArrayBuffer(142);
  new Uint8Array(headerBuffer, 0, headerLength).fill(0);
  const view = new DataView(headerBuffer);
  let cursor = 4;
  view.setInt8(cursor, 2); cursor += 1;
  view.setInt32(cursor, seq); cursor += 4;
  view.setInt8(cursor, nameLength); cursor += 1;
  for (let i = 0; i < nameLength; i += 1) view.setUint8(cursor + i, name.charCodeAt(i));
  view.setInt8(cursor + nameLength, 0);
  const writer = minimal.Writer.create();
  writer.bytes(new Uint8Array(headerBuffer, 0, headerLength));
  protocol[name].encode(body, writer);
  const raw = writer.finish();
  new DataView(raw.buffer).setInt32(raw.byteOffset + 1, raw.length - 1 - 4);
  return raw.buffer.slice(raw.byteOffset + 1, raw.byteOffset + raw.length);
}

const cases = [
  ['PingRequest', 0, { clientTimestamp: 1234567890123 }],
  ['PingResponse', 42, { clientTimestamp: 1234567890123, serverTimestamp: 1234567890999 }],
  ['Ack', 0, { seqNo: 7 }],
  ['LoginRequest', 1, { language: 'zh_CN', worldId: 1, eworldParams: { openId: 'oX', token: 'tk', timestamp: 1700000000, sign: 'sg' } }],
  ['LoginResponse', 2147483647, { result: 1, initSeqNo: 5, errorMessage: '', playerInfo: { playerId: 10001, nickname: 'tester', level: 3 } }],
];

let checked = 0;

{
  const { appointments } = await import('./appointments.mjs');
  const config = { tables: { AppointPosCfg: { data: [
    { posId: 1, effectId: '生产时间', playerLevel: 4 }, { posId: 2, effectId: '生产时间', playerLevel: 8 },
    { posId: 3, effectId: '生产时间', playerLevel: 15 }, { posId: 4, effectId: '建造速度', playerLevel: 6 },
    { posId: 5, effectId: '建造速度', playerLevel: 10 }, { posId: 6, effectId: '建造速度', playerLevel: 18 },
  ] } } };
  const calls = [];
  let assigned = false;
  const client = {
    request: async (name, body, response) => {
      calls.push(name);
      assert.equal(response, 'AppointInfoResponse');
      if (name === 'AutoAppointRequest') {
        assert.deepEqual(body.posId, [4, 5, 6, 1, 2, 3]);
        assigned = true;
      }
      return { heroes: assigned ? [{ posId: 4, heroId: '瑞文' }] : [], priorPosIds: [4, 5, 6] };
    },
  };
  assert.equal((await appointments(client, config, 13)).occupied, 0);
  assert.deepEqual(calls.splice(0), ['AppointInfoRequest']);
  const result = await appointments(client, config, 13, { assign: true });
  assert.deepEqual(calls.splice(0), ['AppointInfoRequest', 'AutoAppointRequest', 'AppointInfoRequest']);
  assert.deepEqual(result.slots.map(s => s.id), [4, 5, 1, 2]);
  assert.equal(result.changed, 1);
  assert.equal(result.slots[0].hero, '瑞文');
  assert.equal((await appointments(client, config, 1, { assign: true })).slots.length, 0);
  assert.deepEqual(calls, ['AppointInfoRequest']);
  checked++;
}

{
  const { surveyWorld, planWorld } = await import('./world.mjs');
  const config = { tables: {
    GameParamCfg: { data: [{ paramName: '初始人口', paramValue: 3 }, { paramName: '初始人口上限', paramValue: 10 }] },
    BuildingCfg: { data: ['住宅', '电站'].map(buildingType => ({ buildingType })) },
    BuildingUpgradeCfg: { data: [
      { buildingType: '住宅', level: 1, effect: [['人口增加', 12]] },
      { buildingType: '电站', level: 1, effect: [['人口上限', 10]] },
    ] },
    BuildingUnlockCfg: { data: [
      { buildingId: '2住宅', buildingType: '住宅', category: '民居', playerLevel: 2, condition: [['1住宅', 1]], consume: [] },
      { buildingId: '2电站', buildingType: '电站', category: '指标', playerLevel: 2, condition: [['1电站', 1]], consume: [['木材', 5]] },
      { buildingId: '3住宅', buildingType: '住宅', category: '民居', playerLevel: 2, condition: [['2住宅', 1]], consume: [] },
    ] },
  } };
  const raw = [{ buildingId: '1住宅', level: 1 }, { buildingId: '1电站', level: 1 }];
  const client = { request: async name => name === 'OnWaterRequest' ? { building: raw } : { items: [{ itemId: '木材', num: 5 }] } };
  const read = () => surveyWorld(client, protocol, { config, player: { level: 2 } });
  const first = await read();
  assert.equal(first.population, 15);
  assert.equal(first.maxPopulation, 20);
  assert(!first.buildings.some(b => b.buildingId === '3住宅'));
  const plan = planWorld(first, { config });
  assert.deepEqual(plan.actions.map(a => a.body.buildingId), ['2电站']);
  assert(plan.notes.some(n => n.includes('需上限 27')));
  raw.push({ buildingId: '2电站', level: 1 });
  assert.deepEqual(planWorld(await read(), { config }).actions.map(a => a.body.buildingId), ['2住宅']);
  raw.push({ buildingId: '2住宅', level: 0, buildStartTime: 1, buildFinishTime: Math.ceil(Date.now()/1000) + 100 });
  const building = await read();
  assert.equal(building.population, 15);
  assert.equal(building.futurePopulation, 27);
  assert(!planWorld(building, { config }).actions.some(a => a.kind === 'build'));
  checked++;
}

{
  // No empty plots in OnWaterResponse: reconstruct non-housing plots and
  // keep building even if daily probes or an unrelated first plot fail.
  const { runLoop } = await import('./loop.mjs');
  const ids = ['1农田', '1工厂', '1仓库', '2工厂'];
  const config = { tables: { BuildingUnlockCfg: { data: ids.map((buildingId, i) => ({
    buildingId, buildingType: buildingId.slice(1), category: ['农田', '工厂', '', '工厂'][i],
    playerLevel: 1, condition: [], consume: [['木材', 2]],
  })) } } };
  const attempts = [];
  const buildings = [];
  let wood = 6;
  const client = {
    connected: true,
    request: async (name) => {
      if (name === 'MainTaskInfoRequest' || name === 'DailyTaskInfoRequest') throw new Error('fixture timeout');
      if (name === 'OnWaterRequest') return { building: structuredClone(buildings) };
      return name === 'AllItemRequest' ? { items: [{ itemId: '木材', num: wood }] } : {};
    },
    sendWatch: async (name, body) => {
      assert.equal(name, 'BuildBuildingRequest');
      attempts.push(body.buildingId);
      if (attempts.length === 1) throw Object.assign(new Error('fixture rejection'), { request: name, prompt: {} });
      wood -= 2;
      buildings.push({ buildingId: body.buildingId, level: 0, buildStartTime: 1, buildFinishTime: Math.ceil(Date.now() / 1000) + 100 });
    },
  };
  const { history } = await runLoop(client, protocol, { config, player: { level: 1, playerId: 710001, worldId: 9001 }, allowMutate: true });
  assert.equal(history[0].world.planned, 3, 'four plots share materials for three builds');
  assert.equal(attempts.length, 3);
  assert.equal(new Set(attempts).size, 3);
  assert.equal(history[0].world.results.filter(entry => entry.ok).length, 2);
  assert(history[0].dailies.results.some(entry => entry.ok === false));
  checked++;
}

{
  const config = { tables: { StageCfg: { data: [
    { stage: 41, playerLevel: 10 }, { stage: 42, playerLevel: 11 }, { stage: 43, playerLevel: 12 },
  ] } } };
  const player = { mainlineStage: 41, level: 11 };
  const calls = [];
  const delays = [];
  let loseAt;
  const client = {
    async request(name, body, responseName) {
      calls.push(body.stage);
      assert.equal(name, 'ChallengeStageRequest');
      assert.equal(responseName, 'ChallengeStageResponse');
      const frame = codec.encode(responseName, 2, {
        initialData: { mainlineStage: body.stage }, stats: { isLeftWin: body.stage !== loseAt },
      });
      return codec.decode(frame).body;
    },
  };
  const execute = { allowMutate: true, wait: async (ms) => delays.push(ms) };
  assert.equal((await runStages(client, player, config)).wins, 0);
  assert.deepEqual(calls, []);
  assert.match((await runStages(client, player, config, execute)).reason, /等级 12/);
  assert.deepEqual(calls.splice(0), [41, 42]);
  assert.equal(delays.length, 1);
  assert(delays.splice(0).every(ms => ms > 0 && ms <= 5000));
  const longRun = await runStages({ request: async (_, { stage }) => ({
    initialData: { mainlineStage: stage }, stats: { isLeftWin: stage <= 105 },
  }) }, { mainlineStage: 1, level: 1 }, { tables: { StageCfg: { data:
    Array.from({ length: 106 }, (_, i) => ({ stage: i + 1, playerLevel: 1 })) } } },
  { allowMutate: true, wait: async () => {}, maxFailures: 2 });
  assert.equal(longRun.wins, 105);
  assert.match(longRun.reason, /第 106 关连续战败 2 次/);
  loseAt = 41;
  assert.match((await runStages(client, player, config, { ...execute, maxFailures: 1 })).reason, /战败/);
  assert.deepEqual(calls.splice(0), [41]);
  assert.equal(delays.length, 1, '同一连接新任务也遵守挑战间隔');
  assert(delays.splice(0).every(ms => ms > 0 && ms <= 5000));
  const outcomes = [false, false, true, false, false, false];
  const retried = { request: async (name, { stage }) => {
    calls.push(stage);
    return { initialData: { mainlineStage: stage }, stats: { isLeftWin: outcomes.shift() } };
  } };
  const battles = [];
  const stopped = await runStages(retried, player, config, { ...execute, maxFailures: 3, onBattle: (battle) => battles.push(battle) });
  assert.match(stopped.reason, /第 42 关连续战败 3 次/);
  assert.equal(stopped.wins, 1);
  assert.deepEqual(calls.splice(0), [41, 41, 41, 42, 42, 42]);
  assert.deepEqual(battles.map((entry) => entry.failures), [1, 2, 0, 1, 2, 3]);
  assert.equal(delays.length, 5);
  assert(delays.splice(0).every(ms => ms > 0 && ms <= 5000));
  for (const response of [{}, { initialData: { mainlineStage: 40 }, stats: { isLeftWin: true } }]) {
    await assert.rejects(runStages({ request: async () => response }, player, config, execute), /战报/);
  }
  let attempts = 0;
  await assert.rejects(runStages({ request: async () => { attempts++; throw new Error('timeout'); } }, player, config, execute), /timeout/);
  assert.equal(attempts, 1);
  assert.deepEqual(delays, []);
  for (const value of [0, -1, 1.5, 'abc', Infinity]) {
    assert.throws(() => stageFailureLimit(value));
  }
  assert.equal(stageFailureLimit(101), 101);

  const task = createStageTask();
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  let finish;
  let sent = 0;
  const jobClient = { request: () => { sent++; return new Promise((resolve) => { finish = resolve; }); } };
  const open = async () => ({ client: jobClient, player, config });
  assert(task.start({}, open).running);
  assert.throws(() => task.start({}, open), /已经开启/);
  await flush();
  assert(task.stop().stopping);
  assert.throws(() => task.start({}, open), /已经开启/);
  finish({ initialData: { mainlineStage: 41 }, stats: { isLeftWin: true } });
  await flush();
  assert.equal(sent, 1);
  assert.equal(player.mainlineStage, 42);
  assert.equal(task.view().wins, 1);
  assert(!task.view().running);
  await new Promise(resolve => setTimeout(resolve, 5050));
  task.start({}, open);
  await flush();
  finish({ initialData: { mainlineStage: 42 }, stats: { isLeftWin: false } });
  await flush();
  assert.equal(task.view().failures, 1);
  task.stop();
  await flush();
  assert(!task.view().running, 'stop cancels the delay before a retry');
  assert.equal(sent, 2);
  checked++;
}
for (const [name, seq, body] of cases) {
  const mine = codec.encode(name, seq, body);
  const ref = new Uint8Array(referenceEncode(name, seq, body));
  assert.deepEqual(Buffer.from(mine), Buffer.from(ref), `encode mismatch for ${name}`);

  const view = new DataView(mine.buffer, mine.byteOffset, mine.byteLength);
  assert.equal(view.getInt32(0), mine.byteLength - 4, `${name}: length field`);
  assert.equal(view.getInt8(4), 2, `${name}: version`);
  assert.equal(view.getInt32(5), seq, `${name}: seq`);
  assert.equal(view.getInt8(9), name.length, `${name}: name length`);

  const back = codec.decode(mine);
  assert.equal(back.seq, seq, `${name}: decoded seq`);
  assert.equal(back.name, name, `${name}: decoded name`);
  assert.equal(
    Buffer.from(protocol[name].encode(back.body, minimal.Writer.create()).finish()).toString('hex'),
    Buffer.from(protocol[name].encode(body, minimal.Writer.create()).finish()).toString('hex'),
    `${name}: body round-trip`,
  );
  checked += 1;
}

// Frames arrive as pooled Buffers / slices over a larger ArrayBuffer; decoding must
// respect the view's own bounds instead of reading to the end of the backing pool.
for (const [name, seq, body] of cases) {
  const frame = codec.encode(name, seq, body);
  const pooled = Buffer.from(frame);
  const sliced = Buffer.alloc(frame.length + 32, 0xaa).subarray(16, 16 + frame.length);
  sliced.set(frame);
  for (const [label, buffer] of [['pooled', pooled], ['sliced', sliced]]) {
    const back = codec.decode(buffer);
    assert.equal(back.name, name, `${name} (${label}): decoded name`);
    assert.equal(back.seq, seq, `${name} (${label}): decoded seq`);
    assert.deepEqual(
      JSON.parse(JSON.stringify(back.body)),
      JSON.parse(JSON.stringify(protocol[name].decode(
        minimal.Reader.create(protocol[name].encode(body, minimal.Writer.create()).finish()),
      ))),
      `${name} (${label}): body`,
    );
  }
  checked += 1;
}

// The decompressor must follow the LZ4 block spec, not merely agree with our own
// compressor. These blocks are written out by hand from the format definition.
function decompress(block, expectedLength) {
  const out = new Uint8Array(expectedLength);
  const written = decompressBlock(block, out, 0, block.length, 0);
  assert.equal(written, expectedLength, 'lz4 block: written length');
  return Buffer.from(out).toString('latin1');
}

// "abcd" then a match 4 bytes back of length 4, then trailing literals "xyz".
assert.equal(
  decompress(Buffer.from([0x40, 0x61, 0x62, 0x63, 0x64, 0x04, 0x00, 0x30, 0x78, 0x79, 0x7a]), 11),
  'abcdabcdxyz',
  'lz4 block: literal + short match',
);
// 20 literals (extended length: token nibble 15 + extra byte 5), then a match of 4 at offset 20.
assert.equal(
  decompress(Buffer.concat([Buffer.from([0xf0, 0x05]), Buffer.alloc(20, 0x41), Buffer.from([20, 0, 0x00])]), 24),
  'A'.repeat(24),
  'lz4 block: extended literal length and overlapping match',
);
// A long match (extended match length byte): 4 literals, then match offset 4 with
// match length 15 + 255 + 0 (+4) = 274, which copies from the literals themselves.
{
  const block = Buffer.from([0x4f, 0x41, 0x42, 0x43, 0x44, 0x04, 0x00, 0xff, 0x00]);
  assert.equal(decompress(block, 4 + 274), 'ABCD'.repeat(278).slice(0, 278), 'lz4 block: extended match length');
}

// Same bounds check for the compressed branch of the frame codec.
{
  const body = { result: 1, initSeqNo: 5, errorMessage: 'session expired '.repeat(40).trim() };
  const plain = codec.encode('LoginResponse', 5, body);
  const nameLength = 'LoginResponse'.length;
  const payload = plain.subarray(HEADER_PREFIX + nameLength + 1);
  const dst = new Uint8Array(compressBound(payload.length));
  const dstLength = compressBlock(payload, dst, 0, payload.length, makeHashTable());
  assert.ok(dstLength > 0 && dstLength < payload.length, 'lz4 frame: payload should compress');
  const lengthPrefix = Buffer.alloc(4);
  lengthPrefix.writeInt32BE(payload.length, 0);
  const lz4 = Buffer.concat([
    Buffer.from(plain.subarray(0, HEADER_PREFIX + nameLength)),
    Buffer.from([1]),
    lengthPrefix,
    Buffer.from(dst.subarray(0, dstLength)),
  ]);
  new DataView(lz4.buffer, lz4.byteOffset, lz4.byteLength).setInt32(0, lz4.byteLength - 4);
  const back = codec.decode(lz4);
  assert.equal(back.name, 'LoginResponse', 'lz4 frame: decoded name');
  assert.deepEqual(
    JSON.parse(JSON.stringify(back.body)),
    JSON.parse(JSON.stringify(codec.decode(plain).body)),
    'lz4 frame: body matches uncompressed frame',
  );
  checked += 1;
}

// Compressor round-trip. The hash table is caller-owned (as in the vendored code)
// and must start zeroed for each independent block.
function roundTrip(corpus, label) {
  const compressed = new Uint8Array(compressBound(corpus.length));
  const compressedLength = compressBlock(corpus, compressed, 0, corpus.length, makeHashTable());
  assert.ok(compressedLength > 0, `lz4 ${label}: block should compress`);
  assert.ok(compressedLength < corpus.length, `lz4 ${label}: compressed should be smaller`);
  const restored = new Uint8Array(corpus.length);
  const restoredLength = decompressBlock(compressed, restored, 0, compressedLength, 0);
  assert.equal(restoredLength, corpus.length, `lz4 ${label}: restored length`);
  assert.deepEqual(Buffer.from(restored), Buffer.from(corpus), `lz4 ${label}: round-trip bytes`);
}

roundTrip(Buffer.from(Array.from({ length: 4096 }, (_, i) => (i % 97) + ((i * 7) % 13))), 'patterned');
roundTrip(Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7) % 251)), 'mixed');
roundTrip(Buffer.alloc(4096), 'zeros');
roundTrip(Buffer.from('RequestResponse'.repeat(200)), 'text');

// Heartbeat matching. The server echoes our int64 timestamp back in long form, so a
// naive identity check never matches and every ping looks like a timeout.
{
  const { GameClient, toNumber, nextSeqNo, isSeqNoInRange, MAX_SEQ } = await import('./client.mjs');
  const client = new GameClient({ protocol });
  const sent = 1791350000123;
  client.sendNoSeq = () => true;
  const high = Math.floor(sent / 4294967296);
  const low = sent - high * 4294967296;

  assert.equal(toNumber({ low, high, unsigned: false }), sent, 'toNumber: long form');
  assert.equal(toNumber(sent), sent, 'toNumber: plain number');

  client.sendPing(sent);
  assert.equal(
    client.tryHandlePong({ clientTimestamp: { low, high, unsigned: false }, serverTimestamp: { low, high, unsigned: false } }),
    true,
    'pong with long-form echo matches the outstanding ping',
  );
  assert.equal(client.lastPingTimestamp, 0, 'pong clears the outstanding ping');
  assert.ok(Number.isFinite(client.latencyMs) && client.latencyMs >= 0, 'pong yields a latency sample');

  client.sendPing(sent);
  assert.equal(client.tryHandlePong({ clientTimestamp: sent + 1 }), false, 'mismatched echo is ignored');
  assert.equal(client.lastPingTimestamp, sent, 'mismatched echo leaves the ping outstanding');
  client.lastPingTimestamp = 0;
  assert.equal(client.tryHandlePong({ clientTimestamp: sent }), false, 'unsolicited pong is ignored');

  assert.equal(nextSeqNo(MAX_SEQ), 1, 'seq wraps to 1');
  assert.equal(nextSeqNo(5), 6, 'seq increments');
  assert.equal(isSeqNoInRange(5, 5), true, 'seq in range');
  assert.equal(isSeqNoInRange(MAX_SEQ, 1), true, 'seq wraps inside range');
  assert.equal(isSeqNoInRange(9, 5), false, 'seq out of range');
  checked += 1;
}

// World listing helpers. The server reports a role's current world separately from the
// key the client asked for (a merged world resolves to its successor), so both must
// survive normalisation as plain numbers rather than int64 objects.
{
  const { normalize, describeRole, describeWorld } = await import('./worlds.mjs');
  const { worldName } = await import('./world-name.mjs');
  const long = (value) => ({ low: value >>> 0, high: Math.floor(value / 4294967296), unsigned: false });

  assert.deepEqual(normalize({ a: long(2001001001), b: [long(7)], c: null }), { a: 2001001001, b: [7], c: null }, 'normalize: nested long forms');

  // 客户端 WorldIdRule 把 worldId 拆成 大区/赛季/区服序号，显示名只取大区前缀和序号。
  assert.equal(worldName(2001001448), '海岛1448服', 'area 2 uses 海岛 and drops the season');
  assert.equal(worldName(long(2004001986)), '海岛1986服', 'int64 input gets the same name');
  assert.equal(worldName(3001000007), '海港7服', 'area 3 uses 海港');
  assert.equal(worldName(4001000008), '海灯8服', 'area 4 uses 海灯');
  assert.equal(worldName(0), null, 'missing worldId has no name');
  assert.equal(worldName(null), null, 'null worldId has no name');

  const role = describeRole({
    id: long(55059310000001),
    nickname: '示例玩家1001',
    level: 11,
    power: long(40889),
    worldId: long(2004001001),
    bornWorldId: long(2001001001),
  });
  assert.equal(role.id, 55059310000001);
  assert.equal(role.power, 40889);
  assert.equal(role.worldId, 2004001001, 'role worldId is where the role lives now');
  assert.equal(role.worldName, '海岛1001服');
  assert.equal(role.bornWorldId, 2001001001, 'bornWorldId is the world it was created in');
  assert.equal(role.bornWorldName, '海岛1001服');
  assert.equal(role.newRole, undefined, 'absent flags stay absent');

  // PlayerInfo names the same identity fields differently; describeRole accepts both.
  assert.equal(describeRole({ playerId: long(34190310000001), newRole: false }).id, 34190310000001);
  assert.equal(describeRole({ playerId: long(5), newRole: false }).newRole, false);

  const world = describeWorld({ worldId: long(2001001001), tag: 2, roleInfo: { worldId: long(2004001001) } });
  assert.equal(world.worldId, 2001001001, 'the select-screen key is GameWorldInfo.worldId');
  assert.equal(world.worldName, '海岛1001服');
  assert.equal(world.role.worldId, 2004001001, 'the live world is roleInfo.worldId');
  assert.equal(world.role.worldName, '海岛1001服');
  checked += 1;
}

// The entry query set is transcribed from a capture of the real client. Every name in
// it must exist in the protocol table along with its response, or the whole burst turns
// into timeouts at runtime.
{
  const { ENTRY_QUERIES, ENTRY_SIGNALS, summarize, formatState } = await import('./game.mjs');

  for (const { name } of ENTRY_QUERIES) {
    assert.ok(protocol[name], `entry query has no protocol type: ${name}`);
    const response = `${name.slice(0, -'Request'.length)}Response`;
    assert.ok(protocol[response], `entry query has no response type: ${response}`);
  }
  for (const { name } of ENTRY_SIGNALS) assert.ok(protocol[name], `entry signal has no protocol type: ${name}`);

  // summarize must survive a completely empty state: a fresh account answers some of
  // these with nothing at all, and the CLI still has to print.
  const empty = summarize({ ok: {} });
  assert.equal(empty.items.kinds, 0);
  assert.equal(empty.heroes.power, 0);
  assert.equal(empty.afk, null);
  assert.equal(empty.buildings.length, 0);
  assert.ok(formatState(empty).includes('道具: 0 种'));

  const sample = summarize({
    ok: {
      AllResourceRequest: { list: [{ res: 3, amount: 10 }] },
      AllItemRequest: { items: [{ itemId: '加速器', num: 5 }, { itemId: '木材', num: 1 }] },
      AllHeroRequest: { heroes: [{ heroId: '杰森', level: 45, star: 2, power: 11658 }] },
      GetFormationRequest: { formation: { heroPositions: [{ heroId: '杰森', pos: { x: 4, y: 2 } }] } },
      AfkInfoRequest: { afkInfo: { level: 3, afkStartTime: 100, afkFinishTime: 200, rewardedLevel: 1 } },
      DailyTaskInfoRequest: {
        dailyTask: [
          { id: 1, progress: 1, targetProgress: 1, rewardClaimed: false },
          { id: 2, progress: 0, targetProgress: 2, rewardClaimed: false },
        ],
        dailyActivity: 5,
        weeklyActivity: 9,
        dailyResetTime: 300,
      },
      OnWaterRequest: { building: [{ buildingId: '1切鱼厂', level: 2, auto: true, factory: { finishedProducts: [{ type: 0, id: '生鱼片', num: 2 }] } }] },
    },
  }, { now: 250 });
  assert.equal(sample.items.total, 6);
  assert.equal(sample.items.top[0].itemId, '加速器', 'items sorted by count');
  assert.equal(sample.heroes.power, 11658);
  assert.equal(sample.heroes.formation[0].heroId, '杰森');
  assert.equal(sample.afk.capped, true, 'afk finish time is in the past');
  assert.equal(sample.afk.pendingLevels, 2, 'level 3 with level 1 rewarded');
  assert.equal(sample.daily.done, 1);
  assert.equal(sample.daily.claimable, 1, 'finished but unclaimed task counts');
  assert.equal(sample.daily.dailyActivity, 5);
  assert.equal(sample.buildings[0].auto, true);
  assert.equal(sample.buildings[0].factory.finished[0].id, '生鱼片');
  assert.ok(formatState(sample).includes('杰森 lv45 2星 战力11658'));
  checked += 1;
}

// The action catalog. Every request type must exist, every declared parameter must be
// produced by its own body builder, and the mutation gate must refuse by default.
{
  const { ACTIONS, listActions, buildBody, assertAllowed } = await import('./actions.mjs');

  for (const [id, action] of Object.entries(ACTIONS)) {
    assert.ok(protocol[action.request], `${id}: no protocol type for ${action.request}`);
    if (action.response) assert.ok(protocol[action.response], `${id}: no protocol type for ${action.response}`);
    const filled = Object.fromEntries((action.params ?? []).map((key) => [key, key === 'isOn' ? true : '1']));
    const body = buildBody(action, filled);
    assert.equal(typeof body, 'object', `${id}: body must be an object`);
    for (const key of action.params ?? []) {
      assert.ok(key in filled, `${id}: parameter ${key} is not buildable`);
      assert.ok(Object.keys(body).length > 0, `${id}: body is empty despite parameters`);
    }
    if ((action.params ?? []).length > 0) {
      assert.throws(() => buildBody(action, {}), /missing parameter/, `${id}: missing parameter is not caught`);
    }
  }

  assert.ok(listActions().length === Object.keys(ACTIONS).length);
  assert.throws(() => assertAllowed('afkDraw'), /changes account state/, 'mutation gate refuses by default');
  assert.throws(() => assertAllowed('nope'), /unknown action/);
  assert.equal(assertAllowed('afkDraw', { allowMutate: true }).request, 'DrawAfkRewardRequest');
  checked += 1;
}

// The console page is a JS template literal, so an escape sequence meant for the browser
// (a "\n" inside the inline script) is silently eaten at module load and leaves the page
// with a syntax error nothing else would catch. Parse the emitted script here.
{
  const vm = await import('node:vm');
  const { PAGE } = await import('./page.mjs');
  const start = PAGE.indexOf('<script>') + '<script>'.length;
  const end = PAGE.lastIndexOf('</script>');
  assert.ok(start > 0 && end > start, 'console page has an inline script');
  new vm.Script(PAGE.slice(start, end), { filename: 'page-inline.js' });
  checked += 1;
}

// 服务端拒绝一个请求时不回 *Response，而是推一条 PromptResponse。若不当场结掉对应的
// pending，调用方要干等满超时。
{
  const { GameClient } = await import('./client.mjs');
  const client = new GameClient({ protocol });
  let rejected = null;
  const entry = { name: 'DrawAfkLevelRewardRequest', responseName: 'DrawAfkLevelRewardResponse', resolve: () => {}, reject: (error) => { rejected = error; }, timer: setTimeout(() => {}, 1000) };
  client.pending.push(entry);
  client.onMessage(codec.encode('PromptResponse', 5, { style: 1, prompt: 5, args: ['no claimable afk reward'] }));
  assert.ok(rejected, 'prompt rejects the pending request');
  assert.match(rejected.message, /no claimable afk reward/);
  assert.equal(client.pending.length, 0, 'prompt clears the pending entry');
  clearTimeout(entry.timer);

  // 没有待处理请求时，push 过来的提示不该抛错。
  client.onMessage(codec.encode('PromptResponse', 6, { style: 1, prompt: 5, args: ['notice'] }));
  checked += 1;
}

{
  // v74 wire fixture: field 2 contains DispTierTask { taskId: 7, progress: 3 }.
  const name = 'SCTierTaskUpdate';
  const push = Buffer.alloc(11 + name.length + 6);
  push.writeInt32BE(push.length - 4);
  push[4] = 2;
  push.writeInt32BE(41, 5);
  push[9] = name.length;
  push.write(name, 10);
  push.set([0x12, 4, 8, 7, 16, 3], 11 + name.length);
  const legacy = { ...protocol };
  delete legacy[name];
  for (const table of new Set([protocol, legacy])) {
    const client = new GameClient({ protocol: table });
    client.recvSeqNo = 40;
    client.send = () => 1;
    const acknowledged = [];
    client.ack = (seq) => acknowledged.push(seq);
    const pushes = [];
    client.on('message', (msg) => { if (msg.name === name) pushes.push(msg.body); });
    const waiting = client.request('DailyTaskInfoRequest', {}, 'DailyTaskInfoResponse');
    client.onMessage(push);
    assert.equal(client.pending.length, 1, 'a push cannot settle the reward query');
    client.onMessage(codec.encode('DailyTaskInfoResponse', 42, { dailyActivity: 20 }));
    assert.equal((await waiting).dailyActivity, 20);
    assert.deepEqual(acknowledged, [41, 42]);
    assert.equal(pushes.length, table[name] ? 1 : 0);
    if (table[name]) assert.equal(pushes[0].task.progress, 3);
    client.stop();
  }
  checked++;
}

// 领奖请求传回包名数组时，任一回包都能结掉请求；先发的请求先拿到同名回包。
{
  const { GameClient, toNumber } = await import('./client.mjs');
  const client = new GameClient({ protocol });
  client.recvSeqNo = 60;
  client.send = () => 1;
  client.ack = () => {};
  const either = ['GotRewardResponse', 'OkResponse'];
  const daily = client.request('DailyTaskInfoRequest', {}, 'DailyTaskInfoResponse');
  const ok = client.request('GotGuildTitleRewardRequest', {}, either);
  const reward = client.request('GetDailyRewardRequest', {}, either);
  client.onMessage(codec.encode('OkResponse', 61, {}));
  assert.equal(client.pending.length, 2, 'OkResponse 只结掉第一个接受它的请求');
  assert.equal(client.pending[0].name, 'DailyTaskInfoRequest');
  client.onMessage(codec.encode('GotRewardResponse', 62, { reward: { asset: [{ id: 'RUBY', num: 5 }] } }));
  client.onMessage(codec.encode('DailyTaskInfoResponse', 63, { dailyActivity: 1 }));
  await ok;
  assert.equal(toNumber((await reward).reward.asset[0].num), 5);
  assert.equal((await daily).dailyActivity, 1);
  assert.equal(client.pending.length, 0);
  const late = client.request('GotWorldOnlineRwdRequest', {}, either, 20);
  await assert.rejects(late, /timeout waiting for GotRewardResponse or OkResponse/);
  client.stop();
  checked++;
}

{
  const client = new GameClient({ protocol });
  let nacks = 0;
  client.sendNack = () => { nacks++; };
  client.ack = () => {};
  client.recvSeqNo = 989;
  assert(!client.handleSeqNo(991, 'DailyTaskInfoResponse'));
  assert(!client.handleSeqNo(992, 'DailyTaskInfoResponse'));
  assert.equal(nacks, 1, 'only one immediate retransmission per missing sequence');
  assert(client.handleSeqNo(990, 'SCUpdateResource'));
  assert.equal(client.gapTimer, null);
  client.send = () => 1;
  const waiting = client.request('DailyTaskInfoRequest', {}, 'DailyTaskInfoResponse');
  client.onMessage(codec.encode('ResendFailed', 995, { seqNo: 991 }));
  await assert.rejects(waiting, /重传/);
  assert.equal(client.state, 'CLOSED');
  assert.equal(client.pending.length, 0);
  checked++;
}

{
  const { claimRewards } = await import('./claim-rewards.mjs');
  const calls = [];
  const client = {
    async request(name) {
      calls.push(name);
      if (name === 'DailyTaskInfoRequest') throw new Error('timeout waiting for DailyTaskInfoResponse (sent DailyTaskInfoRequest)');
      if (name === 'EmailBoxRequest') return { total: 1, email: [{ emailId: '1', attachment: {}, status: calls.includes('QuickGotReadEmailRequest') ? 1 : 2, got: calls.includes('QuickGotReadEmailRequest') }] };
      if (name === 'AfkInfoRequest') return { afkInfo: { afkFinishTime: 1 } };
      if (name === 'DailyGiftPackRequest') return { drawnPack: ['赠礼'] };
      return {};
    },
    async sendWatch(name) { calls.push(name); },
  };
  const steps = [];
  const results = await claimRewards(client, protocol, null, (entry) => steps.push(entry));
  assert.deepEqual(steps, results);
  assert(results.some((entry) => !entry.ok && entry.error.includes('DailyTaskInfoResponse')));
  assert(results.some((entry) => entry.ok && entry.label === '闯关挂机收益已满，领取本段收益'));
  assert(calls.includes('QuickGotReadEmailRequest'));
  assert.equal(calls.filter((name) => name === 'DailyTaskInfoRequest').length, 1);
  assert(!calls.some((name) => /Challenge|RecruitStart|ClickGold/.test(name)));
  checked++;
}

// 配置表来自 CDN 的 config_cn bundle，本地是微信缓存或 work/cdn 的快照。缺了就跳过，
// 但在快照存在时必须能解出表并完成资源名映射。
{
  const { findConfigPack, loadConfig, RESOURCE } = await import('./config.mjs');
  const file = findConfigPack();
  if (file) {
    const config = loadConfig({ file });
    assert.ok(config.names.length > 500, `config should expose many tables, got ${config.names.length}`);
    assert.ok(Array.isArray(config.tables.OfflineCfg.data), 'OfflineCfg has rows');
    assert.equal(RESOURCE[3], 'GOLD', 'resource enum maps 3 to GOLD');
    assert.equal(config.resourceName(3), '金币', 'GOLD renders as 金币');
    assert.equal(config.resourceName(4), '钻石', 'RUBY renders as 钻石');
    assert.equal(config.resourceName('RUBY'), '钻石');
    assert.equal(config.afkMaxLevel(1), 1, 'mainline stage 1 caps afk level at 1');
    assert.equal(config.nextAfkRewardLevel(0), 2, 'level 1 has no reward, next is 2');
    assert.equal(config.nextAfkRewardLevel(2), 5, 'after level 2 the next rewarded level is 5');
    // 活跃度宝箱的两套门槛：日表低、周表高。表名或门槛写错都会在这里当场炸。
    const chest = await import('./dailies.mjs');
    assert.deepEqual(chest.chestTiers(config, { kind: 'daily', activity: 80 }).map((t) => t.id), [1, 2, 3, 4], '日 80 活跃够 1-4 档');
    assert.deepEqual(chest.chestTiers(config, { kind: 'weekly', activity: 80 }).map((t) => t.id), [], '周 80 活跃一档都不够');
    assert.deepEqual(chest.chestTiers(config, { kind: 'weekly', activity: 480 }).map((t) => t.id), [1, 2, 3, 4], '周 480 活跃够 1-4 档');
  } else {
    console.log('selftest: config pack not found, skipping config checks');
  }
  checked += 1;
}

// 英雄养成计划：判定条件照抄客户端红点逻辑，用合成配置跑，不依赖 CDN 快照。
{
  const { planHeroes, maxHeroLevelFor } = await import('./heroes.mjs');
  const config = {
    tables: {
      HeroUpgradeCfg: { data: [
        { level: 1, exp: 0, reqPlayerLv: 1 },
        { level: 2, exp: 100, reqPlayerLv: 1 },
        { level: 3, exp: 200, reqPlayerLv: 5 },
      ] },
      HeroStarCfg: { data: [
        { star: 1, starNum: 1, consumeBlue: 1, consumePur: 1, consumeOra: 1, consumeRed: 1, maxSkillLevel: [1] },
        { star: 2, starNum: 1, consumeBlue: 1, consumePur: 1, consumeOra: 1, consumeRed: 1, maxSkillLevel: [2, 2] },
      ] },
      HeroCfg: { data: [{ id: 'A', quality: 'ORANGE', universalItemId: '万能' }] },
      HeroSkillUpCfg: { data: [{ quality: 'ORANGE', level: 2, costArr: [['橙技能书', 10], ['橙技能书', 10]] }] },
    },
  };
  assert.equal(maxHeroLevelFor(1, config), 2, 'player level 1 caps hero level at 2');
  assert.equal(maxHeroLevelFor(9, config), 3, 'player level 9 unlocks level 3');

  const items = new Map([['英雄经验', 500], ['万能', 5], ['橙技能书', 10]]);
  const hero = { heroId: 'A', level: 1, star: 0, power: 1, skillLevels: [0] };
  const plan = planHeroes({ config, heroes: [hero], itemNum: (id) => items.get(id) ?? 0, playerLevel: 1 });
  const levelStep = plan.steps.find((step) => step.kind === 'level');
  assert.equal(levelStep.count, 1, 'only one level fits under the player-level cap');
  assert.equal(levelStep.exp, 100, 'level 2 costs 100 exp');
  // HeroStarUpRequest 一次只涨一星，所以每颗星单独一条请求，执行时一颗一颗发。
  const starSteps = plan.steps.filter((step) => step.kind === 'star');
  assert.deepEqual(starSteps.map((step) => step.to), [1, 2], 'each star level is its own request');
  assert.deepEqual(starSteps.map((step) => step.from), [0, 1]);
  assert.equal(starSteps[0].fragments, 1, 'star 1 costs one fragment');
  assert.ok(starSteps.every((step) => step.universal), 'universal fragments are reported');

  // 技能：星级不到面板要求就不排，星级够且书够才排一条。
  const skillHero = { heroId: 'A', level: 1, star: 2, power: 1, skillLevels: [1, 0] };
  const skillPlan = planHeroes({ config, heroes: [skillHero], itemNum: (id) => items.get(id) ?? 0, playerLevel: 9 });
  const skillStep = skillPlan.steps.find((step) => step.kind === 'skill');
  assert.ok(skillStep, 'skill upgrade is planned when the star cap and books allow it');
  assert.equal(skillStep.slot, 0, 'skillIdx is 1-based on the wire, 0-based in the slot');

  // 技能要求 2 星（heroStarBySkillLv(0, 2)），碎片又不够升到 2 星时，面板点不动，计划里也不该有。
  const lowStar = { heroId: 'A', level: 1, star: 1, power: 1, skillLevels: [1, 0] };
  const broke = new Map([['英雄经验', 0], ['橙技能书', 10]]);
  const lowPlan = planHeroes({ config, heroes: [lowStar], itemNum: (id) => broke.get(id) ?? 0, playerLevel: 9 });
  assert.equal(lowPlan.steps.filter((step) => step.kind === 'skill').length, 0, 'the star gate blocks the skill plan');
  assert.ok(lowPlan.notes.some((note) => note.includes('需要 2 星')), 'the blocked skill says why');
  checked += 1;
}

// 日常驱动：免费/付费点金的分支、以及地图没野怪时不给动作。
{
  const { DAILY_DRIVERS, TASK_TITLES } = await import('./dailies.mjs');
  const { typeNames } = await import('../tools/describe.mjs');
  const names = new Set(typeNames());
  for (const driver of Object.values(DAILY_DRIVERS)) {
    assert.ok(TASK_TITLES[driver.id], 'driver ' + driver.id + ' has a title');
    for (const [name] of driver.probes ?? []) assert.ok(names.has(name), driver.id + ': probe ' + name + ' is a real protocol type');
  }

  const config = { tables: { OfflineParamCfg: { data: [
    { paramName: '免费点金次数', paramValue: 3 },
    { paramName: '点金价格', paramValue: 50 },
  ] } } };
  const task = { id: 1006, progress: 0, targetProgress: 3 };
  const probe = (name) => (name === 'ClickGoldInfoRequest' ? { info: { freeTimes: 0, paidTimes: 0, maxPaidTimes: 7 } } : null);

  const free = DAILY_DRIVERS[1006].evaluate({ task, probe, config, items: new Map(), ruby: 0, now: 0 });
  assert.equal(free.status, 'ready', 'free clicks are preferred');
  assert.deepEqual(free.actions.map((a) => a.body), [{ times: 1, free: true }, { times: 1, free: true }, { times: 1, free: true }]);

  const paidProbe = (name) => (name === 'ClickGoldInfoRequest' ? { info: { freeTimes: 3, paidTimes: 0, maxPaidTimes: 7 } } : null);
  const paid = DAILY_DRIVERS[1006].evaluate({ task, probe: paidProbe, config, items: new Map(), ruby: 200, now: 0 });
  assert.equal(paid.status, 'paid', 'paid clicks are flagged, never silently run');
  assert.equal(paid.actions[0].body.free, false);

  const broke = DAILY_DRIVERS[1006].evaluate({ task, probe: paidProbe, config, items: new Map(), ruby: 10, now: 0 });
  assert.equal(broke.status, 'blocked', 'not enough diamonds blocks paid clicking');

  const noPirates = DAILY_DRIVERS[1010].evaluate({ task: { id: 1010, progress: 0, targetProgress: 5 }, probe: () => ({ pirates: [] }), items: new Map(), ruby: 0, now: 0, config });
  assert.equal(noPirates.status, 'waiting', 'daily task panel delegates free pirate sweeps to the independent service');
  assert.equal(noPirates.actions?.length ?? 0, 0, 'legacy daily task driver must not send unfiltered pirate sweeps');
  assert.match(noPirates.reason, /游戏剩余次数/);
  assert.equal(noPirates.actions, undefined);

  const stage = DAILY_DRIVERS[1003].evaluate({ task: { id: 1003, progress: 0, targetProgress: 1 }, probe: () => null, items: new Map(), ruby: 0, now: 0, config, player: { mainlineStage: 41, level: 11 } });
  assert.equal(stage.actions, undefined, 'ordinary daily and idle runs must never challenge a stage');
  assert.equal(stage.status, 'waiting');

  const trialTask = DAILY_DRIVERS[1009].evaluate({ task: { progress: 0, targetProgress: 1 } });
  assert.equal(trialTask.actions, undefined, '日常任务不发起试炼挑战');
  checked += 1;
}

// PromptResponse 不带我们发出去的 seq，只能按发送顺序认领。英雄升级这类没有配套 Response
// 的请求靠 sendWatch 守着 prompt；若归属错了，一条和英雄无关的 prompt 会拒掉当时在飞的
// AllHeroRequest，整个养成运行就变成 400。
{
  const client = new GameClient({ url: 'wss://example.invalid/ws', protocol });
  const fake = (name, order) => {
    const state = { name, order, timer: null, settled: null, error: null };
    const settle = (kind) => (value) => { state.settled = kind; state.error = kind === 'reject' ? value : null; };
    return { state, entry: { name, responseName: `${name.slice(0, -7)}Response`, order, timer: null, resolve: settle('resolve'), reject: settle('reject') } };
  };

  // 先发的是被观察的升级请求，后发的是在飞的查询：prompt 归升级请求，查询必须活着。
  const watch = fake('HeroSkillLevelUpRequest', 0);
  const query = fake('AllHeroRequest', 1);
  client.watchers.push(watch.entry);
  client.pending.push(query.entry);
  client.attributePrompt({ style: 1, prompt: 5, args: ['upgrade condition unmet'] });
  assert.equal(watch.state.settled, 'reject', 'a prompt belongs to the watched send');
  assert.equal(watch.state.error.request, 'HeroSkillLevelUpRequest');
  assert.equal(query.state.settled, null, 'an unrelated in-flight request must not be rejected');
  assert.equal(client.pending.length, 1, 'the in-flight request stays pending');

  // 没有观察者时，一般提示归给最早仍在等待的请求。
  client.pending.length = 0;
  const only = fake('ArenaChallengeRequest', 2);
  const newer = fake('AllHeroRequest', 3);
  client.pending.push(only.entry, newer.entry);
  client.attributePrompt({ args: ['no chance left'] });
  assert.equal(only.state.settled, 'reject', 'without a watcher the oldest pending entry takes the prompt');
  assert.deepEqual(client.pending, [newer.entry]);
  for (const names of [['GuildCityInfoRequest', 'HeroStarUpRequest'], ['HeroStarUpRequest', 'GuildAidListRequest'],
    ['HeroStarUpRequest', 'GuildInfoRequest'], ['HeroStarUpRequest', 'GotGuildWelfarePackRequest']]) {
    client.pending.length = 0;
    const entries = names.map((name, index) => fake(name, index));
    client.pending.push(...entries.map(({ entry }) => entry));
    client.onMessage(codec.encode('PromptResponse', 0, { prompt: 95, style: 1 }));
    const guild = entries.find(({ entry }) => entry.name !== 'HeroStarUpRequest');
    const hero = entries.find(({ entry }) => entry.name === 'HeroStarUpRequest');
    assert.match(guild.state.error.message, /NO_GUILD/);
    assert.deepEqual(client.pending, [hero.entry]);
    client.onMessage(codec.encode('HeroStarUpResponse', 0, { nextStar: { heroId: '瑞文', star: 3 } }));
    assert.equal(hero.state.settled, 'resolve');
  }
  const unrelatedRead = fake('AllHeroRequest', 5), unrelatedWrite = fake('HeroLevelUpRequest', 6);
  client.pending.push(unrelatedRead.entry);
  client.watchers.push(unrelatedWrite.entry);
  client.onMessage(codec.encode('PromptResponse', 0, { prompt: 95, style: 1 }));
  assert.deepEqual(client.pending, [unrelatedRead.entry], '迟到的未入盟提示不能拒绝无关的查询');
  assert.deepEqual(client.watchers, [unrelatedWrite.entry], '迟到的未入盟提示也不能拒绝无关的写请求');

  // 在飞请求比观察者发得更早时，它就比观察者更该认领这条 prompt。
  client.pending.length = 0;
  client.watchers.length = 0;
  const older = fake('DrawAfkRewardRequest', 3);
  const later = fake('HeroLevelUpRequest', 4);
  client.pending.push(older.entry);
  client.watchers.push(later.entry);
  client.attributePrompt({ args: ['too early'] });
  assert.equal(older.state.settled, 'reject', 'the oldest outstanding send wins');
  assert.equal(later.state.settled, null, 'the newer watcher keeps waiting');
  checked += 1;
}

// 任务目标值推导：主线/支线只有 params，没有 targetProgress，取法必须和客户端一致；
// 取不出来的返回 null，调用方据此跳过，绝不能猜一个数出来当目标。
{
  const { taskTarget, nextOrderTier } = await import('./tasks.mjs');
  assert.equal(taskTarget({ type: '关卡进度', params: [30] }), 30, 'plain targets read params[0]');
  assert.equal(taskTarget({ type: '获取资源', params: ['淡水', 20] }), 20, 'resource targets read params[1]');
  assert.equal(taskTarget({ type: '击败野怪', params: ['海盗', '5'] }), 5, 'string numbers are parsed');
  assert.equal(taskTarget({ type: '升级建筑', params: ['民居', '1|1'] }), 1, 'upgrade targets take the part before the bar');
  assert.equal(taskTarget({ type: '试炼挑战', params: ['x'] }), 1, 'trial challenge is hardcoded to 1');
  assert.equal(taskTarget({ type: '未知类型' }), null, 'a missing params array yields null, never a guess');
  assert.equal(taskTarget({ type: '获取资源', params: ['淡水'] }), null, 'a short params array yields null');

  const orderCfg = { tables: { OrderDailyRewardCfg: { data: [
    { reqNum: 18, reward: [] }, { reqNum: 6, reward: [] }, { reqNum: 12, reward: [] },
  ] } } };
  const tier = nextOrderTier(orderCfg, { orderNum: 7, rewardedNum: 6 });
  assert.equal(tier.tier, 12, 'the next tier is the first reqNum above the rewarded one');
  assert.equal(tier.claimable, false, '7 orders is not enough for the 12-order tier');
  assert.equal(nextOrderTier(orderCfg, { orderNum: 12, rewardedNum: 6 }).claimable, true);
  assert.equal(nextOrderTier(orderCfg, { orderNum: 99, rewardedNum: 18 }).tier, null, 'the last tier claims nothing');
  checked += 1;
}

// 订单优先的资源分配：订单材料与排产耗料先扣，剩下的才轮到升级。所以同样的库存，
// 少 8 个木材就该从「能升级」翻成「不能升级」，而这条分界线只能来自预留而不是随机。
{
  const { planWorld, surveyWorld } = await import('./world.mjs');
  const config = { tables: {
    BuildingCfg: { data: [{ buildingType: '民居' }, { buildingType: '材料厂' }] },
    BuildingProduceCfg: { data: [
      { buildType: '材料厂', itemId: '布匹', produceTime: 300, unlockLevel: 1, costItem: [['木材', 5]] },
    ] },
    BuildingUpgradeCfg: { data: [
      { buildingType: '民居', level: 1, playerLevel: 1, curPeople: 1, costTime: 30, consume: [['木材', 50]], condition: [] },
      { buildingType: '民居', level: 2, playerLevel: 1, curPeople: 5, costTime: 60, consume: [['木材', 50]], condition: [] },
    ] },
  } };
  const stockOf = (wood) => new Map([['木材', wood], ['布匹', 0]]);
  const surveyFor = (wood) => {
    const stock = stockOf(wood);
    const factory = { buildingId: '1材料厂', type: '材料厂', level: 1, product: [],
      factory: { factoryQ: [], finishedProducts: [], autoProductId: '' } };
    return {
      now: 1000, player: { level: 11 }, population: 30, maxPopulation: 40, stockCap: 50, factorySlots: 6,
      have: (id) => stock.get(id) ?? 0,
      stock,
      buildings: [
        { buildingId: '1A民居', type: '民居', level: 1, product: [], buildFinishTime: 0, factory: null },
        factory,
      ],
      factories: [factory],
      orders: [{ index: 1, requirements: [{ id: '布匹', num: 2 }], missing: [{ id: '布匹', num: 2 }], rewardExp: 100 }],
    };
  };

  const weekly = surveyFor(60);
  const construction = surveyFor(60);
  construction.orders = [];
  construction.factories[0].factory.factoryQ = [{ productId: '布匹' }];
  construction.stock.set('布匹', 1);
  construction.buildings.push({ buildingId: '待建工厂', type: '种子厂', level: 0, product: [] });
  const buildingConfig = { materialName: id => id, tables: { ...config.tables,
    BuildingUnlockCfg: { data: [{ buildingId: '待建工厂', playerLevel: 10, consume: [['布匹', 4]] }] },
    BuildingProduceCfg: { data: [...config.tables.BuildingProduceCfg.data,
      { buildType: '材料厂', itemId: '木板', unlockLevel: 1, produceTime: 1, costItem: [] }] },
  } };
  const jobsForBuild = setting => planWorld(construction, { config: buildingConfig,
    enabled: key => key === 'build' || key === 'startProduce' || (key === 'buildSupply' && setting),
  }).actions.filter(step => step.kind === 'startProduce');
  assert.deepEqual(jobsForBuild(true).slice(0, 2).map(job => job.body.productId), ['布匹', '布匹']);
  assert.equal(jobsForBuild(true).filter(job => job.label.includes('建造缺')).length, 2, '备料扣除库存和在产');
  assert.equal(jobsForBuild(false)[0].body.productId, '木板', '关闭备料后恢复按库存排产');
  construction.weekOrder = new Map([['木板', 1]]);
  assert.equal(jobsForBuild(true)[0].body.productId, '木板', '周订单优先于建材');
  // reserve all 50 items for the weekly order: only a VIP stock bonus leaves
  // room to make more for the resident, without submitting either order.
  const capacityConfig = { tables: { ...config.tables,
    GameParamCfg: { data: [{ paramName: '产品存量初始上限', paramValue: 50 }] },
    BuildingProduceParamCfg: { data: [{ paramName: '制造位上限', paramValue: 6 }] },
    VipLevelCfg: { data: [{ level: 3, effects: [] }, { level: 4, effects: [['加工品存量上限', 5]] }] },
  } };
  const client = { request: async name => name === 'OnWaterRequest' ? {
    building: [weekly.factories[0]], workerOrder: [{ index: 1, requirements: [{ id: '布匹', num: 1 }] }],
  } : { items: [{ itemId: '布匹', num: 50 }, { itemId: '木材', num: 50 }] } };
  for (const [vip, expectedCap] of [[undefined, 50], [{ vipLevel: 3 }, 50], [{ vipLevel: 4 }, 55]]) {
    const snapshot = await surveyWorld(client, protocol, { config: capacityConfig, player: { level: 15, vip }, includeWeekOrder: false });
    snapshot.weekOrder.set('布匹', 50);
    const actions = planWorld(snapshot, { config: capacityConfig }).actions;
    const jobs = actions.filter(a => a.kind === 'startProduce');
    assert.equal(snapshot.stockCap, expectedCap);
    assert.equal(jobs.length, expectedCap - 50);
    if (jobs.length) assert.match(jobs[0].label, /居民订单缺 1/);
    assert(!actions.some(a => a.kind === 'finishOrder'));
  }
  const balancing = surveyFor(60);
  balancing.orders = [];
  balancing.stock.set('布匹', 3);
  const recipes = { tables: { ...config.tables, BuildingProduceCfg: { data: [
    ...config.tables.BuildingProduceCfg.data,
    { ...config.tables.BuildingProduceCfg.data[0], itemId: '纸', produceTime: 600 },
  ] } } };
  const balanced = planWorld(balancing, { config: recipes }).actions.filter(a => a.kind === 'startProduce');
  assert.deepEqual(balanced.map(a => a.body.productId), ['纸', '纸', '纸', '布匹', '纸', '布匹']);
  weekly.orders = [];
  weekly.weekOrder = new Map([['布匹', 4]]);
  weekly.stock.set('布匹', 1);
  const firstFactory = weekly.factories[0];
  firstFactory.factory = { factoryQ: [{ productId: '布匹' }], finishedProducts: [{ id: '布匹', num: 1 }] };
  for (const buildingId of ['2材料厂', '3材料厂']) weekly.factories.push({ ...firstFactory, buildingId, factory: {} });
  const weeklyPlan = planWorld(weekly, { config });
  const weeklyJobs = weeklyPlan.actions.filter(action => action.kind === 'startProduce');
  assert.equal(weeklyJobs.filter(a => a.label.includes('周订单缺')).length, 1, '库存、队列、待收成品、本轮新排产合计满足周订单后停止补货');
  assert.match(weeklyJobs[0].label, /周订单缺 1/);
  assert.equal(weeklyJobs[0].body.productId, '布匹');
  assert.ok(!weeklyPlan.actions.some(action => action.request.includes('WeekOrder')));
  const cargo = surveyFor(60);
  cargo.orders = [];
  cargo.stock.set('布匹', 2);
  cargo.weekOrder = new Map([['布匹', 2]]);
  cargo.cargoOrder = new Map([['布匹', 4]]);
  cargo.factories[0].factory.factoryQ = [{ productId: '布匹' }];
  cargo.factories[0].factory.finishedProducts = [{ id: '布匹', num: 2 }];
  cargo.factories.push({ ...cargo.factories[0], factory: {}, buildingId: '2材料厂' });
  const cargoJobs = () => planWorld(cargo, { config }).actions.filter(a => a.kind === 'startProduce');
  assert.deepEqual(cargoJobs().flatMap(a => a.label.match(/贸易港缺 \d+/) ?? []), ['贸易港缺 1']);
  cargo.stock.set('布匹', 3);
  assert.equal(cargoJobs().filter(a => a.label.includes('贸易港缺')).length, 0, '周订单库存另计，货轮缺口已由现货、待收、在产覆盖');
  const factorySurvey = surveyFor(50);
  factorySurvey.orders = [];
  factorySurvey.weekOrder = new Map([['布匹', 1]]);
  const factoryConfig = { tables: { ...config.tables,
    BuildingProduceCfg: { data: [{ ...config.tables.BuildingProduceCfg.data[0], unlockLevel: 2 }] },
    BuildingUpgradeCfg: { data: [{ buildingType: '材料厂', level: 2, playerLevel: 1,
      curPeople: 1, consume: [['木材', 50]], condition: [] }] },
    BuildingUnlockCfg: { data: ['1民居', '1材料厂'].map(buildingId => ({
      buildingId, playerLevel: 1, consume: [['木材', 50]], condition: [],
    })) },
  } };
  const planFactory = () => planWorld(factorySurvey, { config: factoryConfig, enabled: k => ['build', 'weekFactory'].includes(k) });
  factorySurvey.buildings.push({ buildingId: '1民居', type: '民居', level: 0, product: [] });
  assert.deepEqual(planFactory().actions.map(a => a.kind), ['weekFactory'], '周订单升级优先预留建材，即使余料升级关闭');
  factorySurvey.factories[0].level = 2;
  assert.ok(!planFactory().actions.some(a => a.kind === 'weekFactory'), '达到配方等级后停止定向升级');
  factorySurvey.factories[0].level = 0;
  assert.deepEqual(planFactory().actions.map(a => a.body.buildingId), ['1材料厂'], '材料只够建一座时优先周订单工厂');
  const tight = planWorld(surveyFor(52), { config });
  const produce = tight.actions.find((a) => a.kind === 'startProduce');
  assert.equal(produce.body.productId, '布匹', 'the order gap decides what gets produced');
  assert.equal(tight.actions.some((a) => a.kind === 'upgrade'), false,
    '排满生产队列后，剩余材料不足以升级');
  assert.equal(tight.actions.filter(a => a.kind === 'startProduce').length, 6);
  assert.deepEqual(tight.reserved, [['木材', 30]], 'the reservation is reported, not hidden');

  const loose = planWorld(surveyFor(80), { config });
  const upgrade = loose.actions.find((a) => a.kind === 'upgrade');
  assert.ok(upgrade, 'with 80 wood six jobs leave 50 for the upgrade');
  assert.equal(upgrade.body.buildingId, '1A民居');
  assert.deepEqual(loose.reserved, [['木材', 80]], 'production and the upgrade both hold their share');
  const village = surveyFor(155);
  village.buildings.push({ ...village.buildings[0], buildingId: '2A民居' }, { ...village.buildings[0], buildingId: '3A民居' });
  const upgradesOnly = () => planWorld(village, { config, enabled: kind => kind === 'upgrade' });
  assert.equal(upgradesOnly().actions.filter(a => a.kind === 'upgrade').length, 3);
  village.weekOrder = new Map([['木材', 10]]);
  assert.equal(upgradesOnly().actions.filter(a => a.kind === 'upgrade').length, 2);

  // 交得起的订单要排在升级前面：它只花材料不动人口，而且能立刻换来经验。
  const payable = surveyFor(80);
  payable.stock.set('布匹', 9);
  payable.orders[0].missing = [];
  const ordered = planWorld(payable, { config });
  const kinds = ordered.actions.map((a) => a.kind);
  assert.ok(kinds.indexOf('finishOrder') < kinds.indexOf('upgrade'), 'the order is submitted before the upgrade');
  const partial = surveyFor(60);
  partial.factories[0].factory.factoryQ.push({ productId: '布匹' });
  const countJobs = () => planWorld(partial, { config }).actions.filter(a => a.kind === 'startProduce').length;
  assert.equal(countJobs(), 5, '六格已有一项在产，只补五项');
  partial.stock.set('布匹', 47);
  assert.equal(countJobs(), 2, '库存和队列合计达到上限即停止');
  partial.stock.set('木材', 5);
  assert.equal(countJobs(), 1, '后一格不得重复使用前一格预留的原料');

  // 没开 --reroll 时材料不足的订单只写进 notes，绝不偷偷拒单。
  const held = planWorld(surveyFor(0), { config });
  assert.equal(held.actions.some((a) => a.kind === 'denyOrder'), false, 'a short order is kept unless reroll is on');
  assert.ok(held.notes.some((note) => note.includes('材料不足')), 'the kept order says why');
  const rerolled = planWorld(surveyFor(0), { config, allowReroll: true, minOrderExp: 500 });
  assert.equal(rerolled.actions.find((a) => a.kind === 'denyOrder')?.body.index, 1, 'low-value orders are denied when asked');
  checked += 1;
}

// 建造：OnWaterResponse 里 level=0 的建筑是已解锁未建的空位，走 BuildBuildingRequest，
// 每个首建地块有独立的解锁门槛和消耗。
{
  const { planWorld } = await import('./world.mjs');
  const config = { materialName: id => id === '木材' ? '测试木料' : null, tables: {
    BuildingCfg: { data: [{ buildingType: '日用品厂' }, { buildingType: '军工厂' }, { buildingType: '硅矿厂' }, { buildingType: '玩具厂' }] },
    BuildingProduceCfg: { data: [] },
    BuildingUnlockCfg: { data: [
      ...[1, 2, 3, 4, 5, 6, 7].map(n => ({ buildingId: n + '日用品厂', playerLevel: 10, consume: [], condition: [] })),
      { buildingId: '1军工厂', playerLevel: 51, consume: [], condition: [] },
      { buildingId: '1硅矿厂', playerLevel: 51, consume: [], condition: [['码头', 1]] },
      { buildingId: '1玩具厂', playerLevel: 18, consume: [['木材', 10]], condition: [] },
    ] },
  } };
  const survey = {
    now: 1000, player: { level: 21 }, population: 30, maxPopulation: 40, stockCap: 50, factorySlots: 6,
    have: () => 0, stock: new Map(),
    buildings: [
      // 够等级、没在施工 -> 该建
      { buildingId: '1日用品厂', type: '日用品厂', level: 0, product: [], buildFinishTime: 0, factory: null },
      // 等级不够
      { buildingId: '1军工厂', type: '军工厂', level: 0, product: [], buildFinishTime: 0, factory: null },
      // 有额外条件
      { buildingId: '1硅矿厂', type: '硅矿厂', level: 0, product: [], buildFinishTime: 0, factory: null },
      // 已经在盖了，不能重发
      { buildingId: '2日用品厂', type: '日用品厂', level: 0, product: [], buildFinishTime: 2000, factory: null },
      // 要材料而库存是 0：客户端会拿钻石买，本工具不买，只记一笔
      { buildingId: '1玩具厂', type: '玩具厂', level: 0, product: [], buildFinishTime: 0, factory: null },
    ],
    factories: [], orders: [],
  };
  const plan = planWorld(survey, { config });
  const builds = plan.actions.filter((a) => a.kind === 'build');
  assert.equal(builds.length, 1, '只有够等级、没在施工、没额外条件、材料也够的空位被排进计划');
  assert.equal(builds[0].request, 'BuildBuildingRequest', '建造用的是 BuildBuildingRequest，不是升级那条');
  assert.equal(builds[0].body.buildingId, '1日用品厂');
  assert.equal(builds[0].response, null, 'BuildBuildingRequest 没有配套 Response，必须走 sendWatch');
  assert.ok(plan.notes.some((note) => note.includes('额外条件')), '有条件的空位要说明跳过原因');
  assert.ok(plan.notes.some((note) => note.includes('测试木料 0/10')), '材料不够时宁可等，也不替玩家花钻石买');
  assert.ok(plan.notes.some((note) => note.includes('建造要等级 51')), '等级不够也要说清楚差多少，不能静默丢掉');

  const many = { ...survey, buildings: [1, 2, 3, 4, 5, 6, 7].map(n => n + '日用品厂').map((buildingId) => (
    { buildingId, type: '日用品厂', level: 0, product: [], buildFinishTime: 0, factory: null }
  )) };
  assert.equal(planWorld(many, { config }).actions.filter(a => a.kind === 'build').length, 7);

  // 盖完了的那一栋：这一轮只发竣工，不能再顺手发一次建造——竣工后它已经是 level 1，
  // 建造会被服务端拒，界面上就成了一条假的失败。
  const pendingFinish = { ...survey, buildings: [
    { buildingId: '1日用品厂', type: '日用品厂', level: 0, product: [], buildFinishTime: 900, factory: null },
  ] };
  const done = planWorld(pendingFinish, { config });
  assert.deepEqual(done.actions.map((a) => a.kind), ['finishUpgrade'], '正在收尾的楼同一轮不该再排建造');
  assert.equal(done.actions[0].request, 'FinishUpgradeBuildingRequest');
  assert.equal(planWorld(pendingFinish, { config, enabled: key => key === 'build' }).actions.length, 0,
    '竣工开关关闭时，待竣工的建筑也不能被当成空地重复建造');
  checked += 1;
}

// 活跃度宝箱：日、周是两张表两套门槛，混用会把周宝箱算多。
// 门槛取自线上配置表（Daily 20/40/60/80/100，Weekly 120/240/360/480/600），
// 这里写死成缩样是为了断言「周走的是 WeeklyActivityRewardCfg」这一点不被改回去。
{
  const { planChests, chestTiers, CHEST_TABLE, formatSurvey } = await import('./dailies.mjs');
  const tiers = (base) => [1, 2, 3, 4, 5].map((id) => ({ season: 1, id, activity: base * id, reward: ['奖励', id] }));
  const config = { tables: {
    DailyActivityRewardCfg: { data: [...tiers(20), { season: 2, id: 1, activity: 20, reward: ['加速器', 120] }] },
    WeeklyActivityRewardCfg: { data: tiers(120) },
  } };
  assert.equal(CHEST_TABLE.weekly, 'WeeklyActivityRewardCfg', '周宝箱必须走周表');

  // 测试账号上线时的真实状态：日 4/4 已领、85 活跃度两边都不够下一档。
  const real = planChests({ dailyActivity: 85, dailyRewardClaimed: [1, 2, 3, 4], weeklyActivity: 85, weeklyRewardClaimed: [] }, config);
  assert.deepEqual(real.daily.tiers.map((tier) => tier.id), [], '日宝箱 1-4 已领，第 5 档要 100 活跃度，还不能领');
  assert.equal(real.daily.nextAt, 100, '差多少要说出来：下一档 100');
  assert.deepEqual(real.weekly.tiers.map((tier) => tier.id), [], '周一档都没领，但 85 活跃度连第 1 档 120 都不到');
  assert.equal(real.weekly.nextAt, 120, '周门槛是 120 不是 20，这就是被服务端拒过的那一条');
  assert.equal(real.actions.length, 0, '两边都没得领，不该发出任何请求');

  // 周活跃度真的够了才发：240 够周 1、2 档。
  const weekly = planChests({ dailyActivity: 85, dailyRewardClaimed: [1, 2, 3, 4], weeklyActivity: 240, weeklyRewardClaimed: [1] }, config);
  assert.deepEqual(weekly.actions.map((action) => action.request), ['DrawWeeklyRewardRequest'], '日那边没得领，就只发周那一条');
  assert.deepEqual(weekly.actions[0].body.index, [2], 'index 是 repeated int32，必须发数组，且只补没领的档');
  assert.equal(weekly.actions[0].response, null, '这条请求在协议表里没有配套 Response');

  // 两档之间：跨过 40 之后 2 档可领，1 档已领过不再重复发。
  const between = planChests({ dailyActivity: 45, dailyRewardClaimed: [1], weeklyActivity: 0, weeklyRewardClaimed: [] }, config);
  assert.deepEqual(between.daily.tiers.map((tier) => tier.id), [2], '只补没领的那一档');
  assert.equal(between.daily.nextAt, 60);
  // 跨季节去重：同一个 id 在多季都有一行，只能算一次。
  assert.deepEqual(chestTiers(config, { activity: 20, claimed: [] }).map((tier) => tier.id), [1], '同 id 跨季节要去重');

  const survey = { tasks: [], chests: real };
  assert.ok(formatSurvey(survey).includes('第 100 档'), '没得领的原因是「差多少」，不是「已领」');
  checked += 1;
}

// 每日精选的免费赠礼：packId 是客户端硬编码的字面量，可领性只看 drawnPack 里有没有它。
{
  const { planDailyGift, formatSurvey } = await import('./dailies.mjs');
  const { FREE_DAILY_PACK_ID } = await import('./actions.mjs');
  assert.equal(FREE_DAILY_PACK_ID, '赠礼', 'packId 必须与客户端 DailyPackBuyPanel.freePackId 一致');

  const unclaimed = planDailyGift({ drawnPack: [], resetTime: 1791648000, heroId: '马斯克' });
  assert.equal(unclaimed.freeAvailable, true, 'drawnPack 空 = 今天还没领');
  assert.deepEqual(unclaimed.actions.map((a) => a.request), ['GotFreeDailyPackRequest']);
  assert.equal(unclaimed.actions[0].body.packId, FREE_DAILY_PACK_ID);
  assert.equal(unclaimed.actions[0].response, null, '协议表里没有 GotFreeDailyPackResponse，只能靠重新查 drawnPack 确认');

  const done = planDailyGift({ drawnPack: ['赠礼'], resetTime: 1791648000, heroId: '马斯克' });
  assert.equal(done.freeAvailable, false, 'drawnPack 里有赠礼 = 领过了');
  assert.equal(done.actions.length, 0, '领过了就不该再发请求');

  // 买了礼包1 但没领赠礼时也还是要领——两者互不影响。
  const mixed = planDailyGift({ drawnPack: ['礼包1'], resetTime: 0, heroId: '马斯克' });
  assert.equal(mixed.freeAvailable, true, '买过付费礼包不等于领了免费那档');

  const text = formatSurvey({ tasks: [], chests: null, gift: unclaimed });
  assert.ok(text.includes('每日赠礼 未领'), '调查报告要能看出每日赠礼欠着');
  checked += 1;
}

// 静默请求：协议表里没有 *Response 的写请求，服务端成功时一声不吭、被拒时只推 PromptResponse。
// 它们必须走 sendWatch（守窗口），发成裸 request 就会挂到超时并且分不清成功与否。
{
  const { ACTIONS, runAction } = await import('./actions.mjs');
  // docs/gameplay.md 第 11.3 节列的静默请求。写死在这里是有意为之：新增动作时若把某个
  // 没有 Response 的请求写成有 Response，下面的集合比对会直接失败，而不是发出去等到超时。
  const SILENT = new Set([
    'DrawMainTaskRewardRequest', 'GotBranchTaskRewardRequest', 'GotAchievementRewardRequest',
    'GetNextOrderOTDRewardRequest', 'StartFactoryProduceRequest', 'SetFactoryAutoProduceRequest',
    'FinishUpgradeBuildingRequest', 'SpeedUpUpgradeBuildingRequest', 'UpgradeBuildingRequest',
    'BuildBuildingRequest', 'GotFreeDailyPackRequest',
    'DenyOrderRequest', 'SpeedUpFactoryProduceRequest', 'SetBuildingAutoWorkRequest',
    'QuickGotReadEmailRequest', 'DrawDailyRewardRequest', 'DrawWeeklyRewardRequest', 'MonthCardDailyRewardRequest',
    'ChallengeResFieldRequest', 'GiveUpResFieldRequest',
  ]);
  const sent = [];
  const client = {
    request: async (name) => {
      sent.push({ via: 'request', name });
      if (name === 'EmailBoxRequest') {
        const got = sent.some(row => row.name === 'QuickGotReadEmailRequest');
        return { total: 1, email: [{ emailId: '1', attachment: {}, status: got ? 1 : 2, got }] };
      }
      return {};
    },
    sendWatch: async (name) => { sent.push({ via: 'watch', name }); },
  };
  for (const [id, action] of Object.entries(ACTIONS)) {
    assert.ok(protocol[action.request], `${id} names a request the protocol does not have`);
    if (action.response) {
      assert.ok(protocol[action.response], `${id} declares a response type the protocol does not have`);
      assert.equal(SILENT.has(action.request), false, `${id} declares a response for a request that has none`);
    } else {
      assert.ok(SILENT.has(action.request), `${id} has no response but is not on the documented silent list`);
    }
    if (!action.mutate) continue;
    sent.length = 0;
    await runAction(client, protocol, id, { buildingId: 'x', productId: 'y', taskId: 1, index: 1, gridIdx: 1, useNum: 1, level: 1, isOn: true, id: 1 }, { allowMutate: true });
    const writes = sent.filter(row => row.name === action.request);
    assert.equal(writes.length, 1, `${id} sends exactly one action message`);
    assert.equal(writes[0].via, action.response ? 'request' : 'watch', `${id} must go through ${action.response ? 'request' : 'watch'}`);
    assert.equal(sent.length, id === 'emailQuickGet' ? 3 : 1, `${id} only adds required confirmation reads`);
  }
  checked += 1;
}

// 账号仓库：迁移、按 id/昵称/序号选中、同账号换凭证时就地替换但保留备注。
{
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-accounts-'));
  // 账号仓库与自检都在同一个进程里跑，靠环境变量把它指到临时目录 + 换 query 重新加载，
  // 免得不小心写到真的 data/accounts.json。
  process.env.CW_DATA_DIR = dir;
  const reload = () => import(`${pathToFileURL(path.resolve('src/accounts.mjs')).href}?case=${Math.random()}`);
  const mod = await reload();
  const credential = (openId, token) => ({
    url: 'wss://example/ws',
    login: { eworldParams: { openId, token, sign: 'sg', timestamp: 1 } },
    loginFrameHex: 'aabb',
    source: 'mitm',
    capturedAt: '2026-01-01T00:00:00.000Z',
  });
  const TOKEN_1 = 'tk-open-1-0123456789';
  const TOKEN_2 = 'tk-open-2-9876543210';

  const store = { version: 1, activeId: null, accounts: [] };
  const first = mod.upsertAccount(store, credential('open-1', TOKEN_1));
  assert.equal(first.created, true, '首次入库要标记为新建');
  assert.equal(store.activeId, 'open-1', '第一个账号自动成为当前账号');
  mod.upsertAccount(store, credential('open-2', TOKEN_2));
  store.accounts[1].label = '小号';
  assert.equal(mod.pickAccount(store, '小号').id, 'open-2', '按备注选账号');
  assert.equal(mod.pickAccount(store, '2').id, 'open-2', '按序号选账号');
  assert.equal(mod.pickAccount(store, 'open-1').id, 'open-1', '按 id 选账号');
  assert.throws(() => mod.pickAccount(store, 'open'), /匹配到多个/, '前缀撞车要报错而不是随便挑一个');

  // 同一个账号重新抓包 → 凭证换新，备注与 lastSeen 保留
  const seen = { nickname: '老船长', level: 11, power: 900, worldId: 7 };
  mod.rememberSeen(store.accounts[1], seen);
  const refreshed = 'tk-open-2-refreshed-0001';
  const again = mod.upsertAccount(store, credential('open-2', refreshed));
  assert.equal(again.created, false, '同账号不算新建');
  assert.equal(again.account.label, '小号', '重新抓包不该丢掉备注');
  assert.equal(again.account.login.eworldParams.token, refreshed, '凭证要换成新的');
  assert.equal(again.account.lastSeen.nickname, '老船长', 'lastSeen 保留');
  assert.equal(store.accounts.length, 2, '不会因为重复抓包多出一条');

  assert.equal(mod.accountId(credential('open-9', 'x')), 'open-9', '账号身份取自 openId');
  assert.equal(mod.accountId({ login: {} }), null, '没有 openId 就不是一份可用凭证');

  // 默认打码：头尾各 4 位；8 位以内整串打掉；要点一次「显示凭证」才给全文
  const first0 = mod.describeAccount(store.accounts[0]);
  assert.equal(first0.masked.token, `${TOKEN_1.slice(0, 4)}********${TOKEN_1.slice(-4)}`, '默认打码只露头尾');
  assert.equal(mod.describeAccount(store.accounts[0]).masked.token, first0.masked.token, '打码结果稳定');
  assert.equal(first0.hasFrame, true, '有原始帧要标出来');
  const tiny = mod.describeAccount({ id: 'x', url: 'wss://x', login: { eworldParams: { openId: 'ab', token: 'tk', sign: 'sg' } } });
  assert.equal(tiny.masked.token, '**', '8 位以内整串打掉');
  assert.equal(mod.revealAccount(store.accounts[0]).raw.token, TOKEN_1, '显示凭证才给全文');
  assert.equal(mod.revealAccount(store.accounts[0]).loginFrameHex, 'aabb', '显示凭证也带原始帧');

  mod.saveStore(store);
  const reloaded = mod.loadStore();
  assert.equal(reloaded.accounts.length, 2, '写盘后能读回来');
  assert.equal(reloaded.activeId, 'open-1', '当前账号也一起存了');
  assert.equal(reloaded.accounts[1].login.eworldParams.token, refreshed, '重新抓包后的新凭证也落了盘');
  assert.equal(fs.existsSync(path.join(dir, 'accounts.json.tmp')), false, '落盘要先写临时文件再改名，不留残渣');
  mod.removeAccount(reloaded, 'open-1');
  assert.equal(reloaded.activeId, 'open-2', '删掉当前账号后自动切到剩下的');

  // 迁移：早期版本只有 credentials.json，第一次读到时要能就地合成一个账号，并且不写盘
  fs.rmSync(path.join(dir, 'accounts.json'), { force: true });
  fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({
    url: 'wss://legacy/ws',
    login: { eworldParams: { openId: 'open-old', token: 'legacy-token-0001', sign: 'sg', timestamp: 2 } },
    loginFrameHex: 'ccdd',
    source: 'mitm',
    capturedAt: '2025-12-31T00:00:00.000Z',
  }));
  const legacy = (await reload()).loadStore();
  assert.equal(legacy.accounts.length, 1, '老凭证要能合成出账号');
  assert.equal(legacy.activeId, 'open-old', '合成出来的账号就是当前账号');
  assert.equal(legacy.accounts[0].login.eworldParams.token, 'legacy-token-0001', '凭证本体原样带过来');
  assert.equal(fs.existsSync(path.join(dir, 'accounts.json')), false, '只是读，不该悄悄落盘');
  fs.rmSync(dir, { recursive: true, force: true });
  checked += 1;
}

// 素材索引：图标矩形得真的落在自己那张图集页里（拿 PNG 的 IHDR 对账），
// 实体到图标名的映射要有足够覆盖率，查不到的时候老实返回 null 而不是编一个。
{
  const { iconIndex, iconOf, atlasFile, iconEntry, iconCoverage, itemIcon, buildingIcon, heroIcon } = await import('./art.mjs');
  const { pngSize } = await import('./fgui.mjs');
  const index = iconIndex();
  if (!Object.keys(index.icons).length) {
    console.log('跳过素材检查：还没跑过 node tools/sync-art.mjs');
  } else {
    const sizes = new Map();
    const dims = (bundle, page) => {
      const key = `${bundle}/${page}`;
      if (!sizes.has(key)) sizes.set(key, pngSize(atlasFile(bundle, page)));
      return sizes.get(key);
    };
    let outOfRange = 0;
    for (const [name, icon] of Object.entries(index.icons)) {
      const size = dims(icon.bundle, icon.page);
      if (!size) continue;
      // 旋转打包的贴图在图集里占的是 h 宽、w 高 —— 这条是从游戏自己的引擎代码里核出来的
      // （SpriteFrame._calculateUV 里旋转分支用 (x+rect.height)/texWidth 算右边界），
      // 也用 work/tmp/crop-icon.mjs 裁出来肉眼确认过。显示尺寸仍是矩形本身的 w×h。
      // 所以量「图集占位」时要把两个数换过来。
      const spanW = icon.rotated ? icon.h : icon.w;
      const spanH = icon.rotated ? icon.w : icon.h;
      const inside = icon.x >= 0 && icon.y >= 0 && icon.x + spanW <= size.width && icon.y + spanH <= size.height;
      if (!inside && outOfRange++ === 0) console.log(`  越界的图标: ${name} ${JSON.stringify(icon)} 图集 ${size.width}x${size.height}`);
    }
    assert.equal(outOfRange, 0, '所有图标矩形都必须落在自己的图集页里');
    assert.ok(Object.values(index.icons).some((icon) => icon.rotated), '索引里应有旋转打包的贴图，界面必须把这类转回来');

    const [page] = index.pages;
    assert.ok(atlasFile(page.split('/')[0], page.split('/')[1]), '图集页要能真的读到，这是路由的正常路径');
    assert.equal(atlasFile('..', 'accounts.json'), null, '图集路由不接受 ..');
    assert.equal(atlasFile('ui_iconlib', '../index.json'), null, '图集路由不接受带斜杠的文件名');
    assert.equal(atlasFile('ui_iconlib', '不存在.png'), null, '图集路由只给真实存在的文件');

    const fish = itemIcon('生鱼片');
    assert.ok(fish && fish.url.startsWith('/api/art/atlas/') && fish.w > 0 && fish.h > 0, '道具「生鱼片」要有能直接裁的图标入口');
    assert.ok(buildingIcon('食品厂'), '建筑「食品厂」应该有图标（resPath 末段 Kitchen）');
    assert.equal(iconOf('绝对不存在的图标名'), null, '查不到就返回 null，不编造');
    assert.equal(iconEntry('绝对不存在的图标名'), null, '没有图标就没有入口');

    const coverage = Object.fromEntries(iconCoverage().map((line) => [line.label, line]));
    assert.equal(coverage['资源'].missing, 0, `资源图标必须齐全: ${JSON.stringify(coverage['资源'])}`);
    assert.ok(coverage['道具'].hit / coverage['道具'].total > 0.9, `道具图标覆盖率偏低: ${JSON.stringify(coverage['道具'])}`);
    assert.ok(coverage['英雄头像'].hit >= 40, `有头像的英雄太少: ${JSON.stringify(coverage['英雄头像'])}`);
    assert.ok(heroIcon('小布'), '英雄「小布」应该有头像（英雄碎片物品的图兜底）');
    checked += 1;
  }
}

// 二维码：编码 → 把矩阵读回来 → 反掩码、反交错、校验证验码、还原出原文。
// 等于自己实现一遍解码器来对，扫不扫得动还得靠手机，但结构错了这里就过不去。
{
  const QR = await import('./vendor/qrcode.mjs');
  const text = 'https://servicewechat.com/wxascheme/jump_wxa?url=weixin%3A%2F%2Fdl%2Fbusiness%2F%3Fappid%3Dwx2ea52a972ea18e5e%26env_version%3Drelease';
  const matrix = QR.encodeMatrix(text);

  // 版本 8 / 纠错等级 M 的规格：4 块（38,38,39,39），每块 22 个纠错码字。照标准抄的。
  const dataLens = [38, 38, 39, 39];
  const ecLen = 22;
  const size = matrix.size;
  const bytesLen = Buffer.byteLength(text);
  assert.ok(bytesLen > 122 && bytesLen <= 152, `这段链接应落在版本 8 的容量里（当前 ${bytesLen} 字节）`);
  assert.equal(matrix.version, 8, '应自动选到版本 8');
  assert.equal(size, 49, '版本 8 的模块边长是 49');

  // 定位图形与定时图形
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) assert.equal(matrix.modules[cy + dy][cx + dx], true, '定位图形中心 3x3 必须是深色');
    }
  }
  for (let i = 8; i < size - 8; i += 1) {
    assert.equal(matrix.modules[6][i], i % 2 === 0, `横向定时图形第 ${i} 格`);
    assert.equal(matrix.modules[i][6], i % 2 === 0, `纵向定时图形第 ${i} 格`);
  }

  // 格式信息：两份必须一致，BCH 余数为 0，解出来的掩码与编码时选的相等
  const readFormat = (spots) => spots.reduce((acc, [col, row], i) => acc | (matrix.modules[row][col] ? 1 << i : 0), 0);
  const first = readFormat([[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]]);
  const second = readFormat([[size - 1, 8], [size - 2, 8], [size - 3, 8], [size - 4, 8], [size - 5, 8], [size - 6, 8], [size - 7, 8], [size - 8, 8], [8, size - 7], [8, size - 6], [8, size - 5], [8, size - 4], [8, size - 3], [8, size - 2], [8, size - 1]]);
  assert.equal(first, second, '两份格式信息必须一致');
  const raw = first ^ 0x5412;
  let remainder = raw;
  for (let i = 14; i >= 10; i -= 1) if ((remainder >> i) & 1) remainder ^= 0x537 << (i - 10);
  assert.equal(remainder, 0, '格式信息的 BCH 校验位必须自洽');
  assert.equal(raw >> 13, 0b00, '纠错等级应为 M');
  assert.equal((raw >> 10) & 7, matrix.mask, '格式信息里的掩码必须和实际选的一致');

  // 反掩码 + 按同样的蛇形顺序把数据位读回来
  const maskFn = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x, y) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  const isFunction = (x, y) => {
    if (x < 9 && y < 9) return true;                            // 左上定位图形、分隔带、格式信息
    if (x > size - 9 && y < 9) return true;                     // 右上定位图形
    if (x < 9 && y > size - 9) return true;                     // 左下定位图形
    if (x === 6 || y === 6) return true;                        // 定时图形
    if ((y < 6 && x >= size - 11 && x <= size - 9) || (x < 6 && y >= size - 11 && y <= size - 9)) return true; // 版本信息
    const centers = [6, 24, 42];                                // 版本 8 的校正图形中心
    for (const cy of centers) {
      for (const cx of centers) {
        if (Math.abs(x - cx) > 2 || Math.abs(y - cy) > 2) continue;
        const nearFinder = (cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6);
        if (!nearFinder) return true;
      }
    }
    return false;
  };
  // 按编码时同样的蛇形顺序回读：从右下角起两列一组，跳过第 6 列，方向交替。
  const bits = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const y = upward ? size - 1 - vert : vert;
        if (isFunction(x, y)) continue;
        bits.push(matrix.modules[y][x] !== maskFn[matrix.mask](x, y) ? 1 : 0);
      }
    }
  }
  assert.equal(bits.length, 242 * 8, '版本 8 的数据区正好放 242 个码字');
  const codewords = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }

  // 反交错：先逐列取各块的数据码字，再逐列取各块的纠错码字
  const data = dataLens.map(() => []);
  const ecc = dataLens.map(() => []);
  let at = 0;
  for (let i = 0; i < Math.max(...dataLens); i += 1) {
    for (let b = 0; b < dataLens.length; b += 1) if (i < dataLens[b]) data[b].push(codewords[at++]);
  }
  for (let i = 0; i < ecLen; i += 1) for (let b = 0; b < dataLens.length; b += 1) ecc[b].push(codewords[at++]);
  assert.equal(at, codewords.length, '交错后的码字要正好用完');

  // 纠错码校验：把每块当作多项式，在 α^0..α^{ecLen-1} 处求值，应该全为 0
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  {
    let x = 1;
    for (let i = 0; i < 255; i += 1) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
    for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
  }
  const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);
  for (let b = 0; b < dataLens.length; b += 1) {
    const poly = data[b].concat(ecc[b]);
    for (let i = 0; i < ecLen; i += 1) {
      let value = 0;
      for (const coef of poly) value = mul(value, EXP[i]) ^ coef;
      assert.equal(value, 0, `第 ${b} 块在 α^${i} 处的校验值应为 0`);
    }
  }

  // 数据位：模式 0100 + 8 位长度 + UTF-8 正文。正文跨块，得把各块的数据码字按顺序接回来。
  const dataBits = [];
  for (const block of data) for (const byte of block) for (let i = 7; i >= 0; i -= 1) dataBits.push((byte >> i) & 1);
  const take = (from, count) => dataBits.slice(from, from + count).reduce((acc, bit) => (acc << 1) | bit, 0);
  assert.equal(take(0, 4), 0b0100, '模式指示符应为字节模式');
  const length = take(4, 8);
  assert.equal(length, Buffer.byteLength(text), '长度字段应等于正文的字节数');
  const decoded = [];
  for (let i = 0; i < length; i += 1) decoded.push(take(12 + i * 8, 8));
  assert.equal(Buffer.from(decoded).toString('utf8'), text, '解出来的正文应与原文一致');

  // SVG 里深色模块的数量要对得上，且带静区
  const svg = QR.qrSvg(text, { scale: 4 });
  const dark = matrix.modules.flat().filter(Boolean).length;
  assert.equal((svg.match(/M\d+ \d+h1v1h-1z/g) || []).length, dark, 'SVG 里的方块数应等于深色模块数');
  assert.ok(svg.includes(`viewBox="0 0 ${size + 8} ${size + 8}"`), 'SVG 应带 4 格静区');
  checked += 1;
}

console.log(`selftest ok: ${checked} 组检查通过（协议帧 / lz4 / 账号仓库 / 素材索引 / 二维码 / 海面计划 / 活跃度宝箱 / 每日赠礼）`);
