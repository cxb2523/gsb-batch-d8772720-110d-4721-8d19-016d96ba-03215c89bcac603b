import assert from 'node:assert/strict';
import { fields, typeNames, extractFields } from './describe.mjs';

// The bundle ships no reflection metadata, so field layouts are recovered from the
// generated encode/decode bodies. These expectations are the ones read by eye from the
// source; if the extractor drifts, phase-2 message work silently breaks.
function layout(name) {
  return fields(name).map((field) => `${field.number}:${field.name}:${field.kind}:${field.type}`);
}

// Namespace aliases are chosen by each minified build, not by the protocol.
// Exercise both deployed aliases and valid identifiers with dollars/digits, for
// nested messages, repeated messages, and the single-field ternary decoder.
for (const alias of ['tf', 'tk', '$proto2', '_bundle$3']) {
  const decoded = extractFields(`switch(i>>>3){case 1:o.order=${alias}.protocol.HeroRaidOrder.decode(t,t.uint32());break;case 2:o.raids&&o.raids.length||(o.raids=[]),o.raids.push(${alias}.protocol.DispHeroRaid.decode(t,t.uint32()));break;}`);
  assert.deepEqual(decoded.map(({ number, name, kind, type }) => ({ number, name, kind, type })), [
    { number: 1, name: 'order', kind: 'message', type: 'HeroRaidOrder' },
    { number: 2, name: 'raids', kind: 'repeated', type: 'DispHeroRaid' },
  ], 'nested/repeated namespace alias ' + alias);
  const single = extractFields(`i>>>3==1?o.reward=${alias}.protocol.DisplayAssetPackage.decode(t,t.uint32()):t.skipType(i&7)`);
  assert.equal(single.length, 1, 'single message namespace alias ' + alias);
  assert.equal(single[0].kind, 'message');
  assert.equal(single[0].type, 'DisplayAssetPackage');
}

assert.deepEqual(layout('HeroRaidOrderResponse'), [
  '1:order:message:HeroRaidOrder',
  '2:reward:message:DisplayAssetPackage',
]);
assert.deepEqual(fields('HeroRaidGotRewardResponse').filter(field => field.kind === 'message').map(({ number, name, type }) => ({ number, name, type })), [
  { number: 1, name: 'gotInfo', type: 'HeroRaidTimes' },
  { number: 2, name: 'reward', type: 'DisplayAssetPackage' },
]);
assert.deepEqual(layout('FinishGuildOrderResponse'), ['1:reward:message:DisplayAssetPackage']);
assert.deepEqual(layout('DispHeroRaid'), [
  '1:raidId:scalar:int32',
  '2:passedStage:scalar:int32',
  '3:finishTime:scalar:int32',
  '4:gift:repeated:DispHeroGift',
  '5:drawTimesInfo:message:HeroRaidTimes',
  '6:order:message:HeroRaidOrder',
  '7:startTime:scalar:int32',
]);

assert.deepEqual(layout('LoginResponse'), [
  '1:result:scalar:int32',
  '2:playerInfo:message:PlayerInfo',
  '3:errorMessage:scalar:string',
  '4:initSeqNo:scalar:int32',
]);

assert.deepEqual(layout('LoginRequest').filter(field => !field.startsWith('10:')), [
  '1:testAccount:scalar:string',
  '4:language:scalar:string',
  '5:superToken:scalar:string',
  '6:eworldParams:message:EworldLoginParams',
  '7:eworldClientInfo:message:EworldClientInfo',
  '8:worldId:scalar:int64',
  '9:systemLanguage:scalar:string',
]);
// Newer bundles append this optional field; older supported bundles omit it.
const loginRate = fields('LoginRequest').find(field => field.number === 10);
if (loginRate) assert.deepEqual({ name: loginRate.name, kind: loginRate.kind, type: loginRate.type, optional: loginRate.optional },
  { name: 'loginRateType', kind: 'scalar', type: 'int32', optional: true });

assert.deepEqual(layout('GameWorldInfo'), [
  '1:worldId:scalar:int64',
  '2:tag:scalar:int32',
  '3:roleInfo:message:AccountRoleInfo',
]);

assert.deepEqual(layout('GameWorldListResponse'), [
  '1:recentWorlds:repeated:GameWorldInfo',
  '2:latestGroupId:scalar:int32',
]);

assert.deepEqual(layout('GameWorldGroupListResponse'), ['1:worlds:repeated:GameWorldInfo']);
assert.deepEqual(layout('GameWorldListRequest'), [], 'world list request is empty');
assert.deepEqual(layout('ExitWorldMapRequest'), [], 'exit world map request is empty');

assert.deepEqual(layout('GameWorldGroupListRequest'), ['1:groupId:scalar:int32']);
assert.equal(fields('GameWorldGroupListRequest')[0].required, true, 'groupId is proto2 required');

assert.deepEqual(layout('PingRequest'), ['1:clientTimestamp:scalar:int64']);

// PlayerInfo is wide; spot-check the identity fields the world listing depends on.
{
  const byName = new Map(fields('PlayerInfo').map((field) => [field.name, field]));
  assert.equal(byName.get('playerId').number, 1);
  assert.equal(byName.get('playerId').type, 'int64');
  assert.equal(byName.get('nickname').number, 2);
  assert.equal(byName.get('level').number, 7);
  assert.equal(byName.get('power').number, 10);
  assert.equal(byName.get('newRole').number, 11);
  assert.equal(byName.get('newRole').type, 'bool');
  assert.equal(byName.get('worldId').number, 12);
}

// AccountRoleInfo carries the same identity under different numbers; the world listing
// reads worldId (10) and bornWorldId (5) from it.
{
  const byName = new Map(fields('AccountRoleInfo').map((field) => [field.name, field]));
  assert.equal(byName.get('bornWorldId').number, 5);
  assert.equal(byName.get('worldId').number, 10);
  assert.equal(byName.get('lastLoginTime').number, 11);
}

// A single-field type exercises the `i>>>3==N?` decode form the extractor normalises.
assert.deepEqual(layout('Position'), ['1:x:scalar:int32', '2:y:scalar:int32']);

const total = typeNames().length;
assert.ok(total > 1400, `expected the full protocol table, got ${total} types`);

console.log(`selftest ok: describe recovered field layouts for ${total} protocol types`);
