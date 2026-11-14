import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-mail-'));
process.env.CW_DATA_DIR = directory;
const { loadProtocol } = await import('../src/proto.mjs');
const { claimMail, readMailbox } = await import('../src/mail.mjs');
const { claimRewards } = await import('../src/claim-rewards.mjs');
const { runAction } = await import('../src/actions.mjs');
const protocol = loadProtocol();
const wire = (name, value) => protocol[name].decode(protocol[name].encode(value).finish());
const letter = (index, pending = false) => ({ emailId: (9007199254740993n + BigInt(index)).toString(), status: pending ? 2 : 1, got: !pending, attachment: {} });
function fixture(mails = [letter(0, true)]) {
  const f = { mails, reads: [], writes: [], update: true, afterRead: null, afterWrite: null };
  f.client = {
    async request(name, body, response) {
      assert.equal(name, 'EmailBoxRequest'); assert.equal(response, 'EmailBoxResponse');
      f.reads.push(body.pageNo);
      const result = wire(response, { total: f.mails.length, email: f.mails.slice(body.pageNo * 10, (body.pageNo + 1) * 10) });
      f.afterRead?.(body.pageNo); return result;
    },
    async sendWatch(name, body) {
      assert.equal(name, 'QuickGotReadEmailRequest'); assert.equal(wire(name, body).all, true);
      f.writes.push(name);
      if (f.update) for (const mail of f.mails) { mail.got = true; mail.status = 1; }
      f.afterWrite?.();
    },
  };
  return f;
}
let passed = 0;
const check = async (name, run) => { await run(); console.log('通过：' + name); passed++; };
try {
  await check('后页附件会触发一键领取，回读全部分页确认', async () => {
    const f = fixture(Array.from({ length: 21 }, (_, i) => letter(i, i === 20)));
    const result = await claimMail(f.client);
    assert.equal(result.ok, true); assert.equal(result.attachments, 1); assert.equal(result.scanned, 21);
    assert.deepEqual(f.reads, [0, 1, 2, 0, 1, 2]); assert.equal(f.writes.length, 1);
  });
  await check('大整数邮件标识无精度丢失', async () => {
    const f = fixture([letter(0), letter(1, true)]);
    const box = await readMailbox(f.client);
    assert.deepEqual([...box.keys()], ['9007199254740993', '9007199254740994']);
  });
  await check('空邮箱和已读无附件邮件不发送写请求', async () => {
    for (const mails of [[], [{ emailId: '1', status: 1, got: false }]]) {
      const f = fixture(mails); assert.equal((await claimMail(f.client)).status, 'empty'); assert.equal(f.writes.length, 0);
    }
  });
  await check('未读无附件邮件按游戏规则标为已读', async () => {
    const f = fixture([{ emailId: '1', status: 2, got: false }]);
    const result = await claimMail(f.client); assert.equal(result.processed, 1); assert.equal(result.attachments, 0); assert.equal(result.ok, true);
  });
  await check('请求未改变邮箱时不误报成功或立即重发', async () => {
    const f = fixture(); f.update = false;
    const result = await claimMail(f.client); assert.equal(result.ok, false); assert.equal(result.status, 'unknown'); assert.equal(f.writes.length, 1);
  });
  await check('发送结果不明后可由完整邮箱状态确认', async () => {
    const f = fixture(); f.afterWrite = () => { throw Error('模拟发送超时'); };
    assert.equal((await claimMail(f.client)).status, 'confirmed'); assert.equal(f.writes.length, 1);
  });
  await check('回读失败不会误报成功', async () => {
    const f = fixture(); const read = f.client.request;
    f.client.request = (...args) => { if (f.writes.length) throw Error('模拟回读失败'); return read(...args); };
    assert.equal((await claimMail(f.client)).status, 'unknown'); assert.equal(f.writes.length, 1);
  });
  await check('分页重复或中途缺页时不根据半份邮箱写入', async () => {
    for (const duplicate of [true, false]) {
      const f = fixture(Array.from({ length: 11 }, (_, i) => letter(i, true)));
      f.client.request = async (_name, body) => wire('EmailBoxResponse', { total: 11, email: body.pageNo === 0 || duplicate ? f.mails.slice(0, 10) : [] });
      await assert.rejects(claimMail(f.client), /重复|完整/); assert.equal(f.writes.length, 0);
    }
  });
  await check('缺少标识或总数时不写入', async () => {
    for (const reply of [{ email: [{ status: 2 }], total: 1 }, { email: [{ emailId: '1', status: 2 }] }]) {
      const f = fixture(); f.client.request = async () => reply;
      await assert.rejects(claimMail(f.client), /标识|总数/); assert.equal(f.writes.length, 0);
    }
  });
  await check('分页期间关闭立即停止，已发送后仍只读核对', async () => {
    let enabled = true; const f = fixture(Array.from({ length: 11 }, (_, i) => letter(i, true)));
    f.afterRead = () => { enabled = false; };
    assert.equal((await claimMail(f.client, { enabled: () => enabled })).skipped, true); assert.equal(f.writes.length, 0); assert.deepEqual(f.reads, [0]);
    enabled = true; const sent = fixture(); sent.afterWrite = () => { enabled = false; };
    assert.equal((await claimMail(sent.client, { enabled: () => enabled })).status, 'confirmed'); assert.equal(sent.writes.length, 1);
  });
  await check('CLI动作与一键领取共用分页确认，不能绕过授权', async () => {
    const f = fixture(); await assert.rejects(runAction(f.client, protocol, 'emailQuickGet'), /changes account/); assert.equal(f.reads.length, 0);
    const result = await runAction(f.client, protocol, 'emailQuickGet', {}, { allowMutate: true });
    assert.equal(result.body.status, 'confirmed'); assert.equal(f.writes.length, 1);
    const unknown = fixture(); unknown.update = false;
    await assert.rejects(runAction(unknown.client, protocol, 'emailQuickGet', {}, { allowMutate: true }), /未重复提交/);
  });
  await check('挂机报告保留未确认状态且不妨碍其他模块', async () => {
    const f = fixture(); f.update = false;
    const results = await claimRewards(f.client, protocol, null, undefined, key => key === 'mail');
    assert.equal(results[0].taskKey, 'mail'); assert.equal(results[0].status, 'unknown'); assert.equal(results[0].ok, false);
  });
  console.log(`邮件专项 ${passed}/${passed} 通过`);
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
