import assert from 'node:assert/strict';
import { claimRewards } from '../src/claim-rewards.mjs';

const heroes = [
  { heroId: '待领取', showName: '瑞文' }, { heroId: '已完成' },
  { heroId: '无奖励' }, { heroId: '被拒绝' }, { heroId: '待领取', showName: '瑞文' },
  { heroId: '回包丢失' }, { heroId: '名单未更新' },
];
const claimed = new Set(['已完成']);
const writes = [];
const config = {
  tables: {
    HeroAbilityShowCfg: { data: ['待领取', '已完成', '被拒绝', '未拥有', '回包丢失', '名单未更新', '无奖励']
      .map(id => ({ id, reward: id === '无奖励' ? [] : ['RUBY', 20] })) },
  },
  materialName: id => id === 'RUBY' ? '钻石' : undefined,
};
const client = {
  async request(name, body, response) {
    if (name === 'AllHeroRequest') return { heroes, showSkillHeroes: Array.from(claimed) };
    assert.equal(name, 'GotHeroShowSkillRequest');
    assert.equal(response, 'GotRewardResponse');
    writes.push(body.heroId);
    if (body.heroId === '被拒绝') throw new Error('服务器拒绝');
    if (body.heroId !== '名单未更新') claimed.add(body.heroId);
    if (body.heroId === '回包丢失') throw new Error('响应超时');
    return { reward: { asset: [{ id: 'RUBY', num: { low: 20, high: 0 } }] } };
  },
};
const enabled = key => key === 'heroShowRewards';
const results = await claimRewards(client, {}, config, null, enabled);
assert.deepEqual(writes, ['待领取', '被拒绝', '回包丢失', '名单未更新']);
assert.deepEqual(results.map(row => row.ok), [true, false, true, false]);
assert.match(results[0].label, /瑞文.*钻石 ×20/);
assert.match(results[1].error, /服务器拒绝/);
assert.match(results[2].label, /奖励明细未返回/);
assert.match(results[3].error, /尚未.*已领名单/);

writes.length = 0;
await claimRewards(client, {}, config, null, enabled);
assert.deepEqual(writes, ['被拒绝', '名单未更新'], '新的领取轮次以最新已领名单为准');
assert.deepEqual(await claimRewards({ request() { assert.fail('未开启该项时不应读写英雄'); } },
  {}, config, null, () => false), []);
console.log('hero show rewards ok: eligible and owned only, confirmation, duplicate and partial failure handling, Chinese reward names');
