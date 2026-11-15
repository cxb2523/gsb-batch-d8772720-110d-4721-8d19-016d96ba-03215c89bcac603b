/**
 * tools/store-claim.js — 认领 / 转移店铺归属（「一个闲鱼账号只能一台机器操作」那条红线的开关）
 *
 * 背景：
 *   店铺档案里有个 ownerMachine。不是本机的店，lib/agent.js 会【直接拒绝启动】——
 *   所有登录/发布/广告操作都过 ready()，所以这是唯一的必经闸门。
 *   这个脚本是那个闸门唯一的合规出口：把归属转到本机（或指定机器）。
 *
 * ⚠️ 转移归属只改一个字段，它【不会】帮你确认另一台机器已经停了。
 *    所以 --apply 时会强制要求你确认，并且把这次转移写进档案的 _归属历史。
 *    铁律：先让旧机器停手（并把它的 ownerMachine 留在这里作为记录），再在新机器上开。
 *
 * 用法:
 *   node tools/store-claim.js --list                     # 看所有店的归属（本机 id 也打出来）
 *   node tools/store-claim.js --store=X                  # 预演：会改成什么
 *   node tools/store-claim.js --store=X --apply          # 认领到本机
 *   node tools/store-claim.js --store=X --to=<machineId> --apply   # 转给别的机器
 *   node tools/store-claim.js --store=X --release --apply          # 解除认领（任何机器都能用，不推荐）
 * 退出码: 0 成功 / 1 出错 / 2 参数问题
 */
const fs = require('fs');
const path = require('path');
const { ROOT, MACHINE } = require('../lib/env');
const profile = require('../lib/store-profile');

const ARGV = process.argv.slice(2);
const flag = (k) => ARGV.indexOf('--' + k) >= 0;
const opt = (k, d) => { const a = ARGV.find((x) => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };

const LIST = flag('list');
const APPLY = flag('apply');
const RELEASE = flag('release');
const STORE = opt('store', '');
const TO = opt('to', MACHINE.id);

function die(m, c) { console.log('❌ ' + m); process.exit(c || 2); }
function readRaw(f) {
  let s = fs.readFileSync(f, 'utf8');
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  return s;
}

console.log('本机 machine id : ' + (MACHINE.id || '(拿不到 —— 会一律放行)') + '   [来源: ' + MACHINE.source + ']');
if (!MACHINE.id) {
  console.log('⚠️ 本机身份拿不到，互斥闸门不会生效。请在 config.local.json 里加：{ "machine": { "id": "任意唯一字符串" } }');
}

// ── --list ──
if (LIST || !STORE) {
  const names = profile.list();
  if (!names.length) { console.log('\n（stores/ 下没有档案）'); process.exit(0); }
  console.log('\n店铺'.padEnd(22) + '归属'.padEnd(34) + '状态');
  console.log('-'.repeat(78));
  names.forEach((n) => {
    let P;
    try { P = profile.load(n); } catch (e) { console.log('  ' + n.padEnd(20) + '（档案读不了）'.padEnd(32) + e.message.slice(0, 24)); return; }
    const owner = profile.ownerOf(P);
    const foreign = profile.isForeign(P, MACHINE.id);
    const tag = !owner ? 'ⓘ 未认领' : (foreign ? '❌ 属别的机器' : '✅ 本机');
    console.log('  ' + n.padEnd(20) + (owner || '(未认领)').slice(0, 32).padEnd(32) + tag);
  });
  console.log('\n未认领的店任何机器都能操作 —— 建议逐台认领。');
  console.log('认领：node tools/store-claim.js --store="<店名>" --apply');
  process.exit(0);
}

// ── 单店 ──
const names = profile.list();
if (names.indexOf(STORE) < 0) die('没有这个店：' + STORE + '\n   现有: ' + names.join(' / '));
const file = profile.fileOf(STORE);
const raw = JSON.parse(readRaw(file));
const before = String(raw.ownerMachine || '');
const after = RELEASE ? '' : String(TO || MACHINE.id);
if (!RELEASE && !after) die('拿不到目标 machine id，用 --to=<id> 指定');

console.log('\n店铺        : ' + STORE);
console.log('当前归属    : ' + (before || '(未认领)'));
console.log('改为        : ' + (after || '(解除认领 —— 任何机器都能操作，不推荐)'));

// 危险提示：转给别的机器 / 解除认领，都不该顺手做
if (before && before !== after) {
  console.log('\n⚠️ 这是【转移/解除】归属，不是首次认领。');
  console.log('   转移前必须确认：旧机器（' + before + '）已经停止操作这家店。');
  console.log('   两台机器同时登录同一个闲鱼账号 → 登录互踢 + 重复发布 + 抢同一个广告计划。');
  console.log('   确认无误再 --apply；不放心就先去旧机器上把它的服务停掉。');
}

if (!APPLY) { console.log('\n[预演] 没改文件。加 --apply 真写。'); process.exit(0); }

raw.ownerMachine = after;
// 归属历史写进档案（_ 开头，不会被当成配置；也是"什么时候谁接手的"的唯一记录）
raw._归属历史 = (raw._归属历史 || []).concat([{
  at: new Date().toISOString(),
  from: before || null,
  to: after || null,
  by: MACHINE.id,
}]);

// 只改这两个键：不整体重写（否则会把别人的并发修改冲掉，也容易把注释键弄丢）
const txt = fs.readFileSync(file, 'utf8');
const bom = txt.charCodeAt(0) === 0xFEFF;
let obj;
try { obj = JSON.parse(bom ? txt.slice(1) : txt); } catch (e) { die('档案不是合法 JSON：' + e.message, 1); }
obj.ownerMachine = after;
obj._归属历史 = raw._归属历史;
fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');   // 不写 BOM

// 回读校验（不靠"写成功"当成功）
let back = '';
try { back = String(JSON.parse(readRaw(file)).ownerMachine || ''); } catch (e) {}
if (back === after) {
  console.log('\n✅ 已写入并回读校验通过：stores/' + STORE + '.json  ownerMachine = ' + (after || '(空)'));
} else {
  die('回读对不上（期望 ' + JSON.stringify(after) + '，实际 ' + JSON.stringify(back) + '）—— 请检查文件', 1);
}
