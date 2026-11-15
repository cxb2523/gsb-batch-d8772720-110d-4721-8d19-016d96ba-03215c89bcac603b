/**
 * tools/set-item-leadcard.js —— 留资卡批量工具（先抓包/差分，再批量写）
 *
 * 背景（2026-11-14）：
 *   留资卡是 **App 里的商品级开关**，PC 发闲置页不渲染、editdetail 50 个字段里也搜不到
 *   「留资/线索/clue/lead/手机号」（2026-11-11 作业单实测，今天复查结论不变）。
 *   所以本工具的定位是：**等你从 App 侧拿到"那个字段/那个接口"之后，用它批量落到其余链接上。**
 *
 * 三种模式：
 *   1) 存快照（开留资卡【之前】先存一份，用来差分）
 *      node tools/set-item-leadcard.js --ids=1068824885185,983656825778 --snapshot
 *
 *   2) 差分（开完 1 条之后，跟快照比，看多出来哪个字段）
 *      node tools/set-item-leadcard.js --diff=_tmp/ed-983656825778-<旧时间戳>.json --ids=983656825778
 *
 *   3) 批量写（两种写法选一种）
 *      a. 字段补丁（差分出差字段名后，直接写进 idleitem.edit 的 payload）
 *         node tools/set-item-leadcard.js --ids=... --patch='{"leadCardEnable":true}' --go
 *      b. 原样回放（抓包拿到 api + data 后，按 itemId 替换再发）
 *         node tools/set-item-leadcard.js --ids=... --api=mtop.xxx.yyy --v=1.0 --dataFile=_tmp/leadcard-payload.json --go
 *
 * 护栏：
 *   - 不带 --go 只预览（打印要下发的 payload 差异，不写线上）
 *   - 写之前自动备份到 replace-backup/<itemId>-leadcard-<ts>.json
 *   - 写之后回读 editdetail，把 patch 里的字段值读回来比对
 */
const fs = require('fs');
const path = require('path');
const agent = require('../lib/agent');
const storeProfile = require('../lib/store-profile');
const { ROOT, STORE: ENV_STORE } = require('../lib/env');

const asObj = (r) => {
  if (r == null) return {};
  if (typeof r === 'string') { try { return JSON.parse(r); } catch (e) { return { _raw: r }; } }
  if (r.result !== undefined) return typeof r.result === 'string' ? JSON.parse(r.result) : r.result;
  return r;
};

const argv = process.argv.slice(2);
const GET = (k, d) => { const a = argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const GO = argv.includes('--go');
const SNAPSHOT = argv.includes('--snapshot');
// 【2026-11-14 加】--patchFile=<json文件>：PowerShell 传 --patch='{"a":"b"}' 会把内层双引号
//   弄丢（native 参数引用的老坑，SOP 里早写了「复杂参数用临时 JSON 文件，唯一稳的」）。
const PATCH_FILE = GET('patchFile', '');

const STORE = GET('store', '') || ENV_STORE || '好易美代拍';
const IDS = String(GET('ids', '')).split(',').map((s) => s.trim()).filter(Boolean);
const PATCH_RAW = GET('patch', '');
const API = GET('api', '');
const V = GET('v', '1.0');
const DATA_FILE = GET('dataFile', '');
const DIFF_FILE = GET('diff', '');

const READ = (id) => `
  var r = await mtop.request({ api: 'mtop.idle.pc.idleitem.editdetail', v: '1.0', data: { itemId: ${JSON.stringify(id)} }, type: 'GET' });
  var d = (r && r.data) || {};
  return JSON.stringify({ ret: r && r.ret, data: d });
`;

// ── 模式 0：--status 只读开关状态（App 里点完用来核对）
//    ⚠️ READ 必须声明在本块之前，且本块不能用顶层 return（那样 READ 永远不声明 → TDZ，踩过）。
if (argv.includes('--status')) {
  (async () => {
    await agent.ready({ stores: [STORE], timeout: 240000 });
    console.log('留资卡开关（editdetail.leadCard，"1"=已开通，无字段=未开通）');
    for (const id of IDS) {
      const r = asObj(await agent.mtop(READ(id), { timeout: 120000 }));
      const d = r.data || {};
      const v = d.leadCard;
      const on = v !== undefined && String(v) === '1';
      console.log('  ' + (on ? '✅已开通' : '❌未开通') + '  ' + id + '  ' + String((d.itemTextDTO || {}).title || '').slice(0, 34));
    }
  })().catch((e) => { console.log('❌ ' + (e && e.message || e)); process.exit(1); });
} else {

if (!IDS.length) {
  console.log('用法: node tools/set-item-leadcard.js --ids=<id,id> [--snapshot] | [--diff=<快照.json>] | [--patch=<json>|--api=.. --dataFile=..] [--go]');
  process.exit(2);
}

const PROF = (() => { try { return storeProfile.load(STORE); } catch (e) { return {}; } })();

const outDir = path.join(ROOT, '_tmp');
fs.mkdirSync(outDir, { recursive: true });

(async () => {
  await agent.ready({ stores: [STORE], timeout: 240000 });

  // ── 模式 1：存快照 ──
  if (SNAPSHOT) {
    for (const id of IDS) {
      const r = asObj(await agent.mtop(READ(id), { timeout: 120000 }));
      if (!r.data) { console.log('❌ ' + id + ' 读不到: ' + JSON.stringify(r).slice(0, 160)); continue; }
      const f = path.join(outDir, 'ed-' + id + '-' + Date.now() + '.json');
      fs.writeFileSync(f, JSON.stringify(r.data, null, 2), 'utf8');
      console.log('✅ 快照 ' + id + ' → ' + f + '  （字段 ' + Object.keys(r.data).length + ' 个）');
    }
    return;
  }

  // ── 模式 2：差分 ──
  if (DIFF_FILE) {
    const old = JSON.parse(fs.readFileSync(path.resolve(ROOT, DIFF_FILE), 'utf8'));
    for (const id of IDS) {
      const now = asObj(await agent.mtop(READ(id), { timeout: 120000 })).data || {};
      const keys = new Set([...Object.keys(old), ...Object.keys(now)]);
      const added = [], changed = [];
      for (const k of keys) {
        const a = JSON.stringify(old[k]);
        const b = JSON.stringify(now[k]);
        if (a === b) continue;
        if (a === undefined) added.push(k); else changed.push(k);
      }
      console.log('\n=== ' + id + ' ===');
      if (added.length) {
        console.log('  🆕 新增字段: ' + added.join(', '));
        added.forEach((k) => console.log('     ' + k + ' = ' + JSON.stringify(now[k]).slice(0, 200)));
      }
      if (changed.length) {
        console.log('  ✏️ 变化的字段: ' + changed.join(', '));
        changed.forEach((k) => console.log('     ' + k + ': ' + JSON.stringify(old[k]).slice(0, 120) + ' → ' + JSON.stringify(now[k]).slice(0, 120)));
      }
      if (!added.length && !changed.length) console.log('  （没有任何差异 —— 说明留资卡不落在 editdetail 里，只能走接口回放或 App 手工点）');
    }
    return;
  }

  // ── 模式 3：批量写 ──
  if (!PATCH_RAW && !PATCH_FILE && !API) { console.log('❌ 要给 --patch=<json> / --patchFile=<文件> 或 --api=<接口名> --dataFile=<json>'); process.exit(2); }
  const patch = PATCH_RAW ? JSON.parse(PATCH_RAW)
    : (PATCH_FILE ? JSON.parse(fs.readFileSync(path.resolve(ROOT, PATCH_FILE), 'utf8')) : null);
  const apiData = DATA_FILE ? JSON.parse(fs.readFileSync(path.resolve(ROOT, DATA_FILE), 'utf8')) : null;

  for (const id of IDS) {
    const cur = asObj(await agent.mtop(READ(id), { timeout: 120000 }));
    const d = cur.data || {};
    if (!d.itemTextDTO) { console.log('❌ ' + id + ' 读不到现状，跳过'); continue; }

    const bakDir = path.join(ROOT, 'replace-backup');
    fs.mkdirSync(bakDir, { recursive: true });
    const bak = path.join(bakDir, id + '-leadcard-' + Date.now() + '.json');
    fs.writeFileSync(bak, JSON.stringify(d, null, 2), 'utf8');

    if (patch) {
      // 字段补丁：把 patch 直接盖进 publish 那套 payload，再调 idleitem.edit
      const imgs = (d.imageInfoDOList || []).map((x) => ({
        extraInfo: x.extraInfo || { isH: 'false', isT: 'false', raw: 'false' }, isQrCode: !!x.isQrCode, url: x.url,
        heightSize: String(x.heightSize), widthSize: String(x.widthSize),
        major: String(x.major), type: String(x.type != null ? x.type : 0), status: 'done',
      }));
      const carry = {};
      for (const [k, v] of Object.entries({
        itemProperties: d.itemProperties, itemSkuList: d.itemSkuList, itemAddrDTO: d.itemAddrDTO,
        itemCatDTO: d.itemCatDTO, itemLabelExtList: d.itemLabelExtList, itemPostFeeDTO: d.itemPostFeeDTO,
        userRightsProtocols: d.userRightsProtocols, quantity: d.quantity, simpleItem: d.simpleItem,
        itemTypeStr: d.itemTypeStr, freebies: d.freebies, defaultPrice: d.defaultPrice,
        itemPriceDTO: d.itemPriceDTO, properties: d.properties,
      })) if (v !== undefined && v !== null) carry[k] = v;

      const code = `
        var data = {
          itemId: ${JSON.stringify(id)}, freebies: false, itemTypeStr: 'b',
          quantity: String(${JSON.stringify(String(d.quantity || '9999'))}), simpleItem: 'true',
          imageInfoDOList: ${JSON.stringify(imgs)},
          itemTextDTO: { desc: ${JSON.stringify(String((d.itemTextDTO || {}).desc || ''))}, title: ${JSON.stringify(String((d.itemTextDTO || {}).title || ''))}, titleDescSeparate: false },
          itemPriceDTO: {}, defaultPrice: false, itemCatDTO: ${JSON.stringify(d.itemCatDTO || {})},
          uniqueCode: Date.now() + '_' + Math.random().toString(36).substring(2, 10),
          sourceId: 'pcMainPublish', bizcode: 'pcMainPublish', publishScene: 'pcMainPublish'
        };
        var CARRY = ${JSON.stringify(carry)};
        for (var k in CARRY) { if (CARRY[k] !== undefined && CARRY[k] !== null && data[k] === undefined) data[k] = CARRY[k]; }
        var PATCH = ${JSON.stringify(patch)};
        for (var k2 in PATCH) data[k2] = PATCH[k2];
        var out = {};
        try { var r = await mtop.request({ api: 'mtop.idle.pc.idleitem.edit', v: '1.0', data: data, type: 'POST' }); out.ret = r && r.ret; }
        catch (e) { out.err = (e && (e.ret ? JSON.stringify(e.ret) : e.message)) || String(e); }
        return JSON.stringify(out);
      `;
      console.log('\n=== ' + id + '  patch=' + JSON.stringify(patch) + ' 备份=' + path.basename(bak));
      if (!GO) { console.log('  [未加 --go] 只预览'); continue; }
      const r = asObj(await agent.mtop(code, { timeout: 180000 }));
      console.log('  ' + JSON.stringify(r));
      const chk = asObj(await agent.mtop(READ(id), { timeout: 120000 })).data || {};
      const diff = Object.keys(patch).map((k) => k + '=' + JSON.stringify(chk[k]) + (JSON.stringify(chk[k]) === JSON.stringify(patch[k]) ? ' ✅' : ' ❌'));
      console.log('  回读: ' + diff.join('  '));
      continue;
    }

    // 接口回放：data 里 {ITEM_ID} 会被替换
    const data = JSON.parse(JSON.stringify(apiData).split('{ITEM_ID}').join(id));
    console.log('\n=== ' + id + '  replay ' + API + '  data=' + JSON.stringify(data).slice(0, 200));
    if (!GO) { console.log('  [未加 --go] 只预览'); continue; }
    const code = `
      var out = {};
      try { var r = await mtop.request({ api: ${JSON.stringify(API)}, v: ${JSON.stringify(V)}, data: ${JSON.stringify(data)}, type: 'POST' }); out.ret = r && r.ret; out.data = r && r.data; }
      catch (e) { out.err = (e && (e.ret ? JSON.stringify(e.ret) : e.message)) || String(e); }
      return JSON.stringify(out);
    `;
    console.log('  ' + JSON.stringify(asObj(await agent.mtop(code, { timeout: 180000 }))).slice(0, 300));
  }
})().catch((e) => { console.log('❌ ' + (e && e.message || e)); process.exit(1); });

}   // end else（非 --status 分支）
