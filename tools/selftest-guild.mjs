import assert from 'node:assert/strict';
import { claimGuildWelfare, readGuild } from '../src/guild.mjs';

const config = { tables: { ModuleOpenCfg: { data: [{ moduleId: '联盟', playerLevel: 16 }] } },
  materialName: id => ({ RUBY: '钻石', WHEAT: '小麦' })[id] };
const guildId = { low: 1, high: 2097152 }; // larger than Number.MAX_SAFE_INTEGER
const member = { level: 16, guildId, playerId: 10 };
export async function testGuild() {
  const now = Math.floor(Date.now() / 1000);
  const guild = { guildId, name: '测试联盟', level: 3, memberCount: 18, gotWelfareTime: now - 1000,
    welfarePack: [{ createTime: now - 1100 }, { createTime: now - 60 }] };
  const noCalls = { async request(name) { assert.fail('不应请求 ' + name); } };
  assert.equal((await readGuild(noCalls, config, { level: 15, guildId })).state, 'locked');
  assert.equal((await readGuild(noCalls, config, { level: 16, guildId: { low: 0, high: 0 } })).state, 'notJoined');
  assert.equal((await readGuild(noCalls, config, { level: 16 })).state, 'unknown');

  const calls = [];
  const aid = id => ({ asker: { playerId: id, nickname: '居民' + id }, reqItemId: 'WHEAT', endTime: now + 60 });
  let welfare = { reward: { asset: [{ id: 'RUBY', num: 8 }] }, lastGotTime: now };
  const client = { promptNames: { 95: 'NO_GUILD' }, async request(name, body, responseName) {
    calls.push(name);
    switch (name) {
      case 'GuildInfoRequest':
        assert.equal(responseName, 'GuildInfoResponse');
        return { guild };
      case 'GuildAidListRequest':
        assert.deepEqual(body, { type: 0 });
        return { askItems: [aid(2), aid(10), { ...aid(3), endTime: now - 1 }] };
      case 'MyGuildAidRequest': return { aids: [] };
      case 'GotGuildWelfarePackRequest':
        assert.equal(responseName, 'GotGuildWelfarePackResponse');
        assert.deepEqual(body, {});
        return welfare;
      default: assert.fail('意外请求 ' + name);
    }
  } };
  const view = await readGuild(client, config, member);
  assert.equal(view.name, '测试联盟');
  assert.equal(view.welfareCount, 1);
  assert.deepEqual(view.requests, [{ requester: '居民2', quantity: 1, material: '小麦', endTime: now + 60 }]);
  assert.deepEqual(calls, ['GuildInfoRequest', 'GuildAidListRequest', 'MyGuildAidRequest'], '互助列表只读，不能捐材料');
  const claimed = await claimGuildWelfare(client, config, { player: member });
  assert.match(claimed.label, /钻石 ×8/);
  assert(claimed.ok);
  assert((await claimGuildWelfare(client, config, { player: member })).skipped);
  assert.equal(calls.filter(name => name === 'GotGuildWelfarePackRequest').length, 1, '同连接重复点击不能重领旧礼包');
  assert(calls.every(n => ['GuildInfoRequest', 'GuildAidListRequest', 'MyGuildAidRequest', 'GotGuildWelfarePackRequest'].includes(n)));

  let deadline = 0;
  const scheduler = { now: () => now, due: () => deadline <= now, defer: (key, until) => {
    assert.equal(key, 'guildWelfare'); deadline = until;
  } };
  assert((await claimGuildWelfare(noCalls, config, { player: { level: 16, guildId: 0 }, scheduler })).skipped);
  assert(deadline > now);
  assert((await claimGuildWelfare(noCalls, config, { player: member, scheduler })).skipped);

  const absent = { promptNames: { 95: 'NO_GUILD' }, async request() {
    throw Object.assign(new Error('服务端返回未入盟'), { prompt: { prompt: 95 } });
  } };
  assert.equal((await readGuild(absent, config, member)).state, 'notJoined');
  assert.match((await claimGuildWelfare(absent, config, { player: member })).reason, /未加入联盟/);

  // A shared timestamp in a stale detail response mustn't make an old reward
  // count as the confirmation of a newly offered pack.
  guild.welfarePack.push({ createTime: now + 1 });
  welfare = { ...welfare, lastGotTime: now - 5 };
  await assert.rejects(claimGuildWelfare(client, config, { player: member }), /未确认/);
  const before = calls.length;
  assert((await claimGuildWelfare(client, config, { player: member, enabled: () => false })).skipped);
  assert.equal(calls.length, before);
  const stale = await readGuild(client, config, { ...member, guildId: { low: 2, high: 2097152 } });
  assert.equal(stale.state, 'unknown');
  assert.equal(calls.at(-1), 'GuildInfoRequest', '联盟已变更时不能查询原联盟求助');
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  await testGuild();
  console.log('guild ok: membership gates, read-only aid list, verified free welfare and rechecks');
}
