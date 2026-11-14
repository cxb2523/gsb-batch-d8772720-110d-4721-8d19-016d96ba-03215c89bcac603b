// Base automation must prove the requested pet operation before releasing costs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-base-pet-evidence-'));
const priorData = process.env.CW_DATA_DIR;
process.env.CW_DATA_DIR = directory;
const { loadProtocol } = await import('../src/proto.mjs');
const { defaultSettings } = await import('../src/automation-settings.mjs');
const { runBaseAutomation } = await import('../src/base-automation.mjs');
const { pendingOrderMaterialSpends, refreshOrderMaterialSpends } = await import('../src/order-reservations.mjs');
const { pendingGoldSpend, refreshGoldSpend } = await import('../src/gold-reservations.mjs');
const protocol = loadProtocol();
const config = { tables: { BuildingUnlockCfg: { data: [{ buildingId: '1宠物培育室', buildingType: '宠物培育室' }] } } };
let serial = 17900000, passed = 0;
const test = async (name, work) => { await work(); passed++; console.log('通过：' + name); };
const roundtrip = (name, value) => protocol[name].decode(protocol[name].encode(value).finish());

function fixture(kind) {
  const now = Math.floor(Date.now() / 1000);
  const player = { playerId: ++serial, worldId: 1000001, level: 40, guildId: 1 };
  const settings = defaultSettings(); settings.pet.enabled = settings.pet.feed = settings.pet.breed = true;
  const original = { idx: 7, petId: 'wanted', startTime: now - 100, finishTime: now + 300 };
  const room = { buildingId: '1宠物培育室', level: 3, petBreed: { maxQLength: 3,
    breedQ: kind === 'petFeed' ? [structuredClone(original)] : [], maturePets: [] } };
  const state = { room, original, now, stock: 100, gold: 1000, writes: [], reads: [], change: () => {}, beforeRead: () => {} };
  const client = { connected: true, serverClockOffsetMs: 0,
    async request(name, body = {}, response = name.replace('Request', 'Response')) {
      assert(protocol[name] && protocol[response], '读请求及回包必须存在于真实协议');
      protocol[name].encode(body).finish();
      state.reads.push({ name, afterWrite: state.writes.length > 0 });
      state.beforeRead(name);
      if (name === 'OnWaterRequest') return roundtrip(response, { building: [room] });
      if (name === 'AllItemRequest') return roundtrip(response, { items: [{ itemId: 'fish', num: state.stock }] });
      if (name === 'AllResourceRequest') return roundtrip(response, { list: [{ res: 3, amount: state.gold }] });
      throw new Error('禁止意外读取 ' + name);
    },
    async sendWatch(name, body) {
      assert.equal(name, kind === 'petFeed' ? 'PetFeedRequest' : 'PetBreedRequest');
      roundtrip(name, body);
      state.writes.push({ name, body });
      state.change();
      return { sent: 1 }; // Silence alone is never a receipt.
    },
  };
  const step = { kind, scope: 'base', setting: kind === 'petFeed' ? 'pet.feed' : 'pet.breed',
    request: kind === 'petFeed' ? 'PetFeedRequest' : 'PetBreedRequest', response: null,
    body: kind === 'petFeed' ? { jobIdx: 7 } : { petId: 'wanted', universal: false },
    costs: [{ id: 'fish', num: 10 }, { id: 'GOLD', num: 20 }],
    verify: kind === 'petFeed' ? { finishTime: original.finishTime } : { queueBefore: 0 } };
  const run = () => runBaseAutomation(client, protocol, config, { actions: [step] }, { player, getSettings: () => settings });
  const assertPending = async expected => {
    assert.equal(pendingOrderMaterialSpends(player).length, expected ? 1 : 0, '材料预留必须依据所请求的业务状态结算');
    assert.equal(!!pendingGoldSpend(player), expected, '金币预留与材料使用同一业务证据');
    if (expected) {
      await refreshOrderMaterialSpends({ ...client }, { ...player });
      await refreshGoldSpend({ ...client }, { ...player });
      assert.equal(pendingOrderMaterialSpends(player).length, 1, '替换连接回读仍不能将无关变化当成本次成功');
      assert(pendingGoldSpend(player));
    }
  };
  return { state, client, run, assertPending };
}

try {
  await test('投喂静默后旧任务自然成熟，不能冒充投喂成功', async () => {
    const f = fixture('petFeed');
    f.state.change = () => {
      f.client.serverClockOffsetMs = 301000;
      f.state.room.petBreed.breedQ = [];
      f.state.room.petBreed.maturePets = [{ petId: 'wanted', star: 0 }];
    };
    assert.equal((await f.run())[0].ok, false);
    assert.equal(f.state.writes.length, 1);
    await f.assertPending(true);
  });
  await test('培育静默后出现其他种类任务，不能冒充目标培育成功', async () => {
    const f = fixture('petBreed');
    f.state.change = () => { f.state.room.petBreed.breedQ = [{ ...f.state.original, petId: 'other' }]; };
    assert.equal((await f.run())[0].ok, false);
    assert.equal(f.state.writes.length, 1);
    await f.assertPending(true);
  });
  for (const changed of ['petId', 'startTime']) {
    await test('投喂任务编号被重用且' + changed + '改变，缩短时间不能证明原任务成功', async () => {
      const f = fixture('petFeed');
      f.state.change = () => {
        f.state.room.petBreed.breedQ = [{ ...f.state.original, finishTime: f.state.original.finishTime - 50,
          [changed]: changed === 'petId' ? 'other' : f.state.original.startTime + 1 }];
      };
      assert.equal((await f.run())[0].ok, false);
      assert.equal(f.state.writes.length, 1);
      await f.assertPending(true);
    });
  }
  await test('已有同种培育任务成熟，不能冒充新请求已培育完成', async () => {
    const f = fixture('petBreed'); f.state.room.petBreed.breedQ = [structuredClone(f.state.original)];
    f.state.change = () => {
      f.state.room.petBreed.breedQ = [];
      f.state.room.petBreed.maturePets = [{ petId: 'wanted', star: 0 }];
    };
    assert.equal((await f.run())[0].ok, false);
    assert.equal(f.state.writes.length, 1);
    await f.assertPending(true);
  });
  for (const kind of ['petFeed', 'petBreed']) {
    await test(kind + '发送前仅用同份队列基线，不能在旧共享基线上归因已有变化', async () => {
      const f = fixture(kind);
      f.state.beforeRead = name => {
        if (name !== 'OnWaterRequest' || f.state.writes.length) return;
        const reads = f.state.reads.filter(row => row.name === 'OnWaterRequest' && !row.afterWrite).length;
        // Previously the guard read an earlier state, then base preflight read
        // this unrelated change. A later shared reader falsely credited it to
        // the silent request even after base rejected that same conclusion.
        if (reads === 2) {
          if (kind === 'petFeed') f.state.room.petBreed.breedQ[0].finishTime -= 50;
          else f.state.room.petBreed.breedQ.push({ ...f.state.original, startTime: f.state.now });
        }
      };
      assert.equal((await f.run())[0].ok, false, '没有实际执行的新请求不能被确认');
      assert.equal(f.state.writes.length, 1);
      assert.equal(f.state.reads.filter(row => row.name === 'OnWaterRequest' && !row.afterWrite).length, 1,
        '基地发送前检查和共享业务证据必须复用同一队列快照');
      await f.assertPending(true);
    });
  }
  await test('同编号、种类与开始时间的投喂任务缩短，完整回读可结算净增长库存', async () => {
    const f = fixture('petFeed');
    f.state.change = () => {
      f.state.room.petBreed.breedQ[0].finishTime -= 50;
      f.state.stock = 110; f.state.gold = 1010;
    };
    assert.equal((await f.run())[0].ok, true);
    assert.equal(f.state.writes.length, 1);
    assert(f.state.reads.some(row => row.afterWrite && row.name === 'AllItemRequest'));
    assert(f.state.reads.some(row => row.afterWrite && row.name === 'AllResourceRequest'));
    await f.assertPending(false);
  });
  await test('真正新增目标种类队列，完整回读可结算净增长库存', async () => {
    const f = fixture('petBreed');
    f.state.room.petBreed.breedQ = [{ ...f.state.original, petId: 'other' }];
    f.state.change = () => {
      f.state.room.petBreed.breedQ.push({ ...f.state.original, idx: 8, startTime: f.state.now });
      f.state.stock = 110; f.state.gold = 1010;
    };
    assert.equal((await f.run())[0].ok, true);
    assert.equal(f.state.writes.length, 1);
    assert(f.state.reads.some(row => row.afterWrite && row.name === 'AllItemRequest'));
    assert(f.state.reads.some(row => row.afterWrite && row.name === 'AllResourceRequest'));
    await f.assertPending(false);
  });
  console.log('基地海兽业务证据专项 ' + passed + '/' + passed + ' 通过');
} finally {
  if (priorData === undefined) delete process.env.CW_DATA_DIR;
  else process.env.CW_DATA_DIR = priorData;
  fs.rmSync(directory, { recursive: true, force: true });
}
