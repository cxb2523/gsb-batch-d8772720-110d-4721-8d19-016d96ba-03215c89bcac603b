import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createPhoneLogin, decryptBody, encryptForm, PHONE_LOGIN, PhoneLoginError } from '../src/phone-login.mjs';

assert.equal(encryptForm('abc'), '8d9fd81439f9a6935a8f1c15c08b1f9b');
assert.equal(decryptBody(encryptForm('abc')), 'abc');

const fixedNow = 1794061114000;
const testDevice = {
  di: '07'.repeat(32),
  oi: '07'.repeat(16),
  deviceCode: '07'.repeat(8),
  businessDid: '0A'.repeat(16),
  businessDeviceCode: '07'.repeat(8),
  model: 'Test',
  sysVersion: '12',
};
const account = '13800138000';
const password = 'testpass123';
const ewanPayload = {
  status: 200,
  openId: 'ewan-open-id',
  token: 'ewan-token',
  sign: 'ewan-sign',
  timestamp: fixedNow,
  username: 'tester',
  birthday: '20001013',
  auth: '1',
  areaId: '2',
};
const businessData = {
  openId: 'game-open-id',
  token: 'raw-session-token',
  signToken: 'game-sign-token',
  sign: 'game-sign',
  ts: fixedNow,
  realName: { birthday: '2000-10-13', gender: 1 },
};

function fakeFetch({ business = null, ewan = () => ewanPayload } = {}) {
  const calls = [];
  const impl = async (url, options = {}) => {
    const isBusiness = String(url).startsWith(PHONE_LOGIN.businessBase);
    if (isBusiness) {
      const parsed = new URL(url);
      const body = options.body ? JSON.parse(options.body) : null;
      const call = { url: parsed, method: options.method ?? 'GET', body, headers: options.headers };
      calls.push(call);
      const payload = await business(call);
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const plain = decryptBody(options.body);
    const call = { url, options, plain, fields: new URLSearchParams(plain) };
    calls.push(call);
    const payload = await ewan(call);
    return new Response(encryptForm(JSON.stringify(payload)), { status: 200, headers: { 'content-type': 'text/plain' } });
  };
  return { impl, calls };
}

{
  const fetch = fakeFetch();
  const client = createPhoneLogin({ fetchImpl: fetch.impl, now: () => fixedNow, device: testDevice });
  const result = await client.loginWithPassword(account, password);
  assert.equal(fetch.calls[0].url, PHONE_LOGIN.loginUrl);
  assert.equal(fetch.calls[0].fields.get('protocol'), '100003');
  assert.equal(fetch.calls[0].fields.get('username'), account);
  assert.equal(fetch.calls[0].fields.get('password'), password);
  assert.equal(fetch.calls[0].fields.get('appid'), PHONE_LOGIN.appId);
  assert.equal(fetch.calls[0].fields.get('packetid'), PHONE_LOGIN.packetId);
  assert.equal(fetch.calls[0].options.headers.ai, PHONE_LOGIN.appId);
  assert.equal(fetch.calls[0].options.headers.pi, PHONE_LOGIN.packetId);
  assert.equal(fetch.calls[0].options.headers.di.length, 64);
  assert.equal(fetch.calls[0].options.headers.oi, fetch.calls[0].options.headers.di.slice(32));
  assert.equal(result.direct, true);
  assert.equal(result.ewan.openId, 'ewan-open-id');
  assert.equal(result.ewan.token, 'ewan-token');
  assert.equal(result.ewan.sign, 'ewan-sign');
  assert.equal(result.ewan.timestamp, fixedNow);
  assert.deepEqual(client.candidateUids(result), ['ewan-open-id', 'tester', account]);
  assert.equal(JSON.stringify(result).includes(password), false);
}

{
  const fetch = fakeFetch({ ewan: ({ url, fields }) => {
    assert.equal(url, PHONE_LOGIN.loginUrl);
    if (fields.get('protocol') === '420012') {
      assert.equal(fields.get('phone'), account);
      assert.equal(fields.get('querytype'), '1');
      assert.equal(fields.get('queryvalue'), '123456');
      assert.equal(fields.get('resolution'), '720*1280');
      return {
        status: 200,
        userAccountStatus: 1,
        userAccount: [{ userId: 0, userName: 'tester', multiAccountToken: 'multi-token' }],
        phone: account,
      };
    }
    assert.equal(fields.get('protocol'), '420007');
    assert.equal(fields.get('phone'), account);
    assert.equal(fields.get('multiAccountToken'), 'multi-token');
    assert.equal(fields.get('validatecode'), '123456');
    return ewanPayload;
  } });
  const client = createPhoneLogin({ fetchImpl: fetch.impl, now: () => fixedNow, device: testDevice });
  const result = await client.loginWithSms(account, '123456');
  assert.equal(fetch.calls.length, 2);
  assert.equal(result.direct, true);
  assert.equal(result.ewan.openId, 'ewan-open-id');
  assert.equal(result.selectedAccount.userName, 'tester');
}

{
  const fetch = fakeFetch({ ewan: ({ url, fields }) => {
    assert.equal(url, PHONE_LOGIN.accountUrl);
    assert.equal(fields.get('protocol'), '100015');
    assert.equal(fields.get('phone'), account);
    assert.equal(fields.get('type'), '7');
    return { status: 200, validatecode: '' };
  } });
  const client = createPhoneLogin({ fetchImpl: fetch.impl, now: () => fixedNow, device: testDevice });
  const result = await client.requestSmsCode(account);
  assert.equal(result.status, 200);
  assert.equal(result.validatecode, '');
}

{
  const fetch = fakeFetch({ ewan: () => ({ status: -100, error: 1002, errorMsg: '亲,用户名或密码错误哦' }) });
  const client = createPhoneLogin({ fetchImpl: fetch.impl, now: () => fixedNow, device: testDevice });
  await assert.rejects(
    () => client.loginWithPassword(account, password),
    (error) => error instanceof PhoneLoginError && error.code === 1002 && error.status === -100 && /用户名或密码错误/.test(error.message),
  );
}

{
  const fetch = fakeFetch({ ewan: () => ({ status: -100, error: 1004, errorMsg: '亲,动态验证码错误哦' }) });
  const client = createPhoneLogin({ fetchImpl: fetch.impl, now: () => fixedNow, device: testDevice });
  await assert.rejects(
    () => client.loginWithSms(account, '123456'),
    (error) => error instanceof PhoneLoginError && error.code === 1004 && /动态验证码错误/.test(error.message),
  );
}

{
  const fetch = fakeFetch({ ewan: () => ({ status: 200, userAccountStatus: 1, userAccount: [], phone: account }) });
  const client = createPhoneLogin({ fetchImpl: fetch.impl, now: () => fixedNow, device: testDevice });
  await assert.rejects(() => client.loginWithSms(account, '123456'), /没有关联账号/);
}

{
  const { publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 1024,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const publicKeyBase64 = publicKey.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const fetch = fakeFetch({
    ewan: () => ewanPayload,
    business: (call) => {
      if (call.url.pathname === '/api/public/info') {
        assert.equal(call.method, 'GET');
        assert.equal(call.url.searchParams.get('ai'), PHONE_LOGIN.business.appId);
        return { code: 0, data: { publicKey: publicKeyBase64, timestamp: fixedNow } };
      }
      if (call.url.pathname === '/api/init') {
        assert.equal(call.body.pn, PHONE_LOGIN.business.packageName);
        assert.equal(call.body.did, testDevice.businessDid);
        assert.equal(call.body.dc, testDevice.businessDeviceCode);
        assert.equal(typeof call.body.key, 'string');
        assert.ok(call.body.key.length > 40);
        return { code: 0, data: { initId: 'init-1', channel: { appKey: 'channel-key' } } };
      }
      if (call.url.pathname === '/api/user/login') {
        assert.equal(call.body.channel.uid, 'ewan-open-id');
        const ext = JSON.parse(call.body.channel.extJson);
        assert.equal(ext.username, 'tester');
        assert.equal(ext.token, 'ewan-token');
        assert.equal(ext.birthday, '20001013');
        return { code: 0, data: businessData };
      }
      throw new Error(`unexpected business request ${call.url}`);
    },
  });
  const client = createPhoneLogin({ fetchImpl: fetch.impl, now: () => fixedNow, device: testDevice });
  const result = await client.loginWithPassword(account, password);
  const game = await client.gameLogin(result);
  assert.equal(game.business, true);
  assert.equal(game.uid, 'game-open-id');
  assert.equal(game.data.token, 'game-sign-token');
  const credential = client.credential(game, { account });
  assert.equal(credential.url, PHONE_LOGIN.gateway);
  assert.equal(credential.source, 'phone');
  assert.equal(credential.login.eworldParams.openId, 'game-open-id');
  assert.equal(credential.login.eworldParams.token, 'game-sign-token');
  assert.equal(credential.login.eworldParams.sign, 'game-sign');
  assert.deepEqual(credential.login.eworldParams.timestamp, {
    low: Number(BigInt(fixedNow) & 0xffffffffn) | 0,
    high: Number((BigInt(fixedNow) >> 32n) & 0xffffffffn) | 0,
    unsigned: false,
  });
  assert.equal(credential.login.language, 'zh_CN');
  assert.equal(credential.login.systemLanguage, 'zh_cn_#hans');
  assert.equal(credential.login.eworldClientInfo.appId, PHONE_LOGIN.business.appId);
  assert.equal(credential.login.eworldClientInfo.channelId, PHONE_LOGIN.business.channelId);
  assert.equal(credential.login.eworldClientInfo.did, testDevice.businessDid);
  assert.equal(credential.login.eworldClientInfo.clientVersion, '1.12.9');
  assert.equal(credential.login.eworldClientInfo.networkType, 'Wifi');
  assert.equal(credential.login.eworldClientInfo.sc, PHONE_LOGIN.packetId);
  assert.equal(credential.login.eworldClientInfo.extc, PHONE_LOGIN.packetId);
  assert.equal(credential.login.eworldClientInfo.biz, '102');
  assert.equal(credential.login.eworldClientInfo.birthday, '2000-10-13');
  assert.equal(credential.login.eworldClientInfo.originVersion, PHONE_LOGIN.clientVersion);
  assert.equal(JSON.stringify(credential).includes(password), false);
}

{
  const client = createPhoneLogin({ fetchImpl: async () => { throw new Error('offline'); }, now: () => fixedNow, device: testDevice });
  await assert.rejects(() => client.loginWithPassword(account, password), /登录服务连接失败/);
  await assert.rejects(() => client.loginWithSms(account, '123456'), /登录服务连接失败/);
}

{
  // 页面脚本是模板字符串；正则里的 \d 必须写成 [0-9]，否则运行时变成 d{9}。
  const { PAGE } = await import('../src/page.mjs');
  assert.equal(PAGE.includes('/^1[3-9][0-9]{9}$/'), true);
  assert.equal(PAGE.includes('/^1[3-9]d{9}$/'), false);
}

console.log('selftest-phone-login: ok');
