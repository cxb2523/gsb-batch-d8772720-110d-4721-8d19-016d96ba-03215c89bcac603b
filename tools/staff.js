#!/usr/bin/env node
/**
 * tools/staff.js —— 员工入口：一个菜单，四个动作，不用记任何参数名
 *
 * 为什么需要它（2026-11-12）：
 *   这套系统有 169 个 tools/*.js，员工不可能知道该用哪个、参数怎么写。
 *   分析文档《员工使用方案-闲鱼自动化-20261112.md》的结论是：
 *   能力已经超出员工的需要，缺的是把能力【收窄成入口】。
 *   这个文件就是那个入口。
 *
 * 员工只需要：
 *     node tools/staff.js
 * 然后按菜单选数字，回答问题。每个动作都【先打印要做什么、再等 y 确认】。
 *
 * 四个动作：
 *   1 发一条新链接        → 转 first-publish.js（已有一键 + 6 条护栏）
 *   2 给链接开推广        → ad-plan-create --apply + ad-power on，失败给「怎么办」
 *   3 把旧链接改成新场次  → 前置校验成交额 → 出图 → apply-item（--useStoreCat --addrCity）
 *   4 看链接和推广情况    → list-onsale + ad-status 摘要（只读）
 *
 * 三条护栏（都是血泪）：
 *   ① 改链接前查 xianyu-商品索引.csv 的「支付额」，>0 直接拒绝
 *      —— 2026-11-12 曾把 26 笔成交、¥21523 的主力链接当老链接改掉，正文永久丢失
 *   ② 开推广后如果拨不上，明确说「在冷却，等 30-60 分钟」，而不是让人反复重试
 *   ③ 所有 mtop 原始错误码都翻成「人话 + 下一步动作」
 *
 * 用法: node tools/staff.js [--store=店名]
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const readline = require('readline');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
const { STORE } = require('../lib/env');

const A = process.argv.slice(2).reduce((o, a) => {
  const i = a.indexOf('=');
  if (a.startsWith('--') && i > 2) o[a.slice(2, i)] = a.slice(i + 1);
  return o;
}, {});
const STORE_NAME = A.store || STORE;

const C = {
  title: (s) => '\n\x1b[1;36m' + s + '\x1b[0m',
  ok: (s) => '\x1b[32m' + s + '\x1b[0m',
  warn: (s) => '\x1b[33m' + s + '\x1b[0m',
  bad: (s) => '\x1b[31m' + s + '\x1b[0m',
  dim: (s) => '\x1b[90m' + s + '\x1b[0m',
};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
// 管道模式（echo … | node）下，stdin 是一次性写完就 EOF 的：
//   直接把所有行读成"预设答案队列"，按顺序消费 —— 交互模式和自动化都好使。
//   终端里（TTY）走正常问询。
let PRESET = [];
if (!process.stdin.isTTY) {
  try {
    PRESET = fs.readFileSync(0, 'utf8').split(/\r?\n/);
  } catch (e) { PRESET = []; }
}
process.stdin.on('end', () => { if (process.stdin.isTTY) { console.log('\n再见'); process.exit(0); } });
const ask = (q) => {
  if (PRESET.length) {
    const v = PRESET.shift();
    console.log(q + v);
    return Promise.resolve(String(v || '').trim());
  }
  if (!process.stdin.isTTY) return Promise.resolve('');
  return new Promise((res) => rl.question(q, (v) => res(String(v || '').trim())));
};
const pause = () => ask(C.dim('\n回车继续…'));

/** 跑子进程，实时把输出打出来；返回 {code, out} */
function run(script, args, { echo = true } = {}) {
  try {
    const out = execFileSync(NODE, [path.join(ROOT, script), ...args], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: process.env,
    });
    if (echo && out) console.log(out);
    return { code: 0, out: out || '' };
  } catch (e) {
    const out = (e.stdout || '') + (e.stderr || '');
    if (echo && out) console.log(out);
    return { code: e.status || 1, out };
  }
}

/** mtop 原始错误 → 人话 + 下一步 */
const HUMAN = [
  [/USER_WAS_FORBIDDEN2/, '账号被平台限制了发布权限。这个代码改不了，只能等恢复或找老板。'],
  [/CONDITION_NOT_SUPPORT_SIGN/, '老链接带着新品类不支持的服务承诺。本工具会自动清理，重跑一次即可。'],
  [/闲鱼太累啦|UN_CATCH_EXCEPTION/, '大概率不是限流：先确认这条链接【有没有规格】——无规格的商品改不了；确认后隔 10 分钟再试。'],
  [/ABORT::接口异常退出/, '调到了一个不存在的接口。不是你的操作问题，把这段原样发给技术。'],
  [/未就绪|not ready/i, '浏览器上下文被回收了。先跑：node tools/store-ready.js "' + STORE_NAME + '"'],
  [/FAIL_BIZ_ITEM_NO_PICS/, '这条链接没有图片数据，工具读不到。找技术确认。'],
  [/找不到|ENOENT/, '找不到要用的文件或商品，检查 itemId 有没有抄错。'],
];
function humanize(out) {
  for (const [re, msg] of HUMAN) if (re.test(out)) return msg;
  return '';
}

/** 读索引里的成交/曝光（选链接的唯一依据） */
function indexOfItem(itemId) {
  const f = path.join(ROOT, 'xianyu-商品索引.csv');
  if (!fs.existsSync(f)) return null;
  const txt = fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '');
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/"([^"]*)","([^"]*)","([^"]*)","([^"]*)","([^"]*)","([^"]*)","([^"]*)","([^"]*)","([^"]*)","([^"]*)"/);
    if (m && m[2] === itemId) return { 状态: m[3], 标题: m[4], 价格: m[5], 想要: m[6], 曝光: m[7], 成交: m[8], 支付额: m[9] };
  }
  return null;
}

/** 从输出里抓 itemId / 计划 id / 图片路径 */
const grabid = (s, re) => { const m = String(s).match(re); return m ? m[1] : ''; };

// ─────────────────────────────────────────────────────────────
async function act1() {
  console.log(C.title('① 发一条新链接'));
  console.log(C.dim('   （会先去大麦查场次；查不到就停，不会乱花钱）'));
  const city = await ask('城市（例：广州　回车取消）: ');
  if (!city) return;
  const star = await ask('是谁的场子（例：王嘉尔）: ');
  if (!star) return;
  const sess = (await ask('场次（首开 / 二开 / 三开，直接回车=首开）: ')) || '首开';
  const ev = (await ask('活动类型（演唱会 / 见面会 / 音乐节，回车=演唱会）: ')) || '演唱会';

  console.log(C.warn(`\n将要发布：${city} · ${star} · ${sess} · ${ev}`));
  console.log(C.dim('   接着会先预演给你看，你看完再决定发不发。'));
  const y = await ask('继续？(y/n) ');
  if (y.toLowerCase() !== 'y') { console.log('已取消'); return; }

  const r = run('tools/first-publish.js', [city, star, sess, '--event=' + ev]);
  if (r.code === 0) console.log(C.ok('\n✅ 完成'));
  else console.log(C.bad('\n❌ 没成功。' + (humanize(r.out) || '把上面的输出原样发给技术。')));
}

// ─────────────────────────────────────────────────────────────
async function act2() {
  console.log(C.title('② 给链接开推广（超级擦亮）'));
  console.log(C.dim('   出价 ¥4 / 日上限 ¥50 / 只投 8:00-23:00，都是店铺档案里定好的，不用你填'));
  const id = await ask('商品 itemId（商品链接 ?id= 后面那串数字）: ');
  if (!/^\d+$/.test(id)) { console.log(C.bad('itemId 只能是一串数字')); return; }
  const city = await ask('这条链接是哪个城市（例：广州）: ');
  const star = await ask('是谁的场子（例：王嘉尔）: ');
  if (!city || !star) return;

  console.log(C.warn(`\n将要给 ${id}（${city}·${star}）建一个推广计划`));
  console.log(C.dim('   建完会自动尝试开启。如果开不起来，说明商品刚改过，在冷却。'));
  const y = await ask('继续？(y/n) ');
  if (y.toLowerCase() !== 'y') { console.log('已取消'); return; }

  console.log(C.dim('\n[1/2] 建计划…'));
  const r1 = run('tools/ad-plan-create.js', ['--store=' + STORE_NAME, '--items=' + id, '--city=' + city, '--star=' + star, '--apply'], { echo: false });
  console.log(r1.out.split('\n').slice(-14).join('\n'));
  const planId = grabid(r1.out, /\bid=(\d+)\s/);
  if (!planId) {
    console.log(C.bad('\n❌ 没建成功。' + (humanize(r1.out) || '把上面输出发给技术。')));
    return;
  }
  console.log(C.ok('\n  计划已建：' + planId));

  console.log(C.dim('[2/2] 开启计划…'));
  const r2 = run('tools/ad-power.js', ['on', planId], { echo: false });
  const on = /✅/.test(r2.out.split('动作后校验')[1] || '');
  if (on) {
    console.log(C.ok('\n✅ 推广已开启，今天就能跑'));
  } else {
    console.log(C.warn('\n⚠️ 计划建好了，但暂时开不起来'));
    console.log('   平台说：部分商品因状态异常无法擦亮');
    console.log('   意思：商品刚被改过（改标题/主图/正文），广告这边还没同步。');
    console.log(C.warn('   → 等 30-60 分钟，再跑：node tools/ad-power.js on ' + planId));
    console.log(C.dim('   不要在短时间内反复试，会触发限流。'));
  }
}

// ─────────────────────────────────────────────────────────────
async function act3() {
  console.log(C.title('③ 把旧链接改成新场次（重锚）'));
  console.log(C.dim('   ⚠️ 只能改【已经死了】的链接：场次演完了、没成交、没在投广告。'));
  console.log(C.dim('      正在出单的主力链接绝对不能改 —— 会丢权重、丢正文。'));
  const id = await ask('\n要改的 itemId（回车取消）: ');
  if (!id) return;
  if (!/^\d+$/.test(id)) { console.log(C.bad('itemId 只能是一串数字')); return; }

  // ★ 护栏：有成交直接拒绝；数据全空则不能算"安全"，要人工确认
  const idx = indexOfItem(id);
  const blank = (v) => v === '' || v === undefined || v === null || v === '0';
  if (idx && !blank(idx.成交) && Number(idx.成交) > 0) {
    console.log(C.dim(`\n   索引记录：${idx.标题.slice(0, 30)}`));
    console.log(C.dim(`   成交 ${idx.成交} 笔 / 支付额 ¥${idx.支付额} / 曝光 ${idx.曝光 || '?'}`));
    console.log(C.bad('\n⛔ 这条链接有成交，是主力，不能改。'));
    console.log('   改了会丢权重、丢评价沉淀，而且正文找不回来。');
    console.log(C.dim('   请换一条：已过场 + 零成交 + 没在投广告的链接。'));
    return;
  }
  if (idx && !blank(idx.支付额) && Number(idx.支付额) > 0) {
    console.log(C.dim(`\n   索引记录：${idx.标题.slice(0, 30)}`));
    console.log(C.dim(`   成交 ${idx.成交 || 0} 笔 / 支付额 ¥${idx.支付额} / 曝光 ${idx.曝光 || '?'}`));
    console.log(C.bad('\n⛔ 这条链接有成交额，是主力，不能改。'));
    return;
  }
  // 数据缺失（索引是 2026-09-28 的快照，之后发的链接都是空的）→ 不能当"安全"
  const noData = !idx || (blank(idx.成交) && blank(idx.支付额) && blank(idx.曝光));
  if (noData) {
    if (idx) console.log(C.dim(`\n   索引记录：${idx.标题.slice(0, 30)}　（成交/曝光都是空，查不到历史）`));
    console.log(C.warn('\n⚠️ 查不到这条链接的成交和曝光数据，没法判断它是不是主力。'));
    console.log('   如果它正在卖、正在出单，现在就按 n 退出。');
    const go = await ask('确认它不是正在卖的链接？(y/n) ');
    if (go.toLowerCase() !== 'y') { console.log('已取消'); return; }
  } else {
    console.log(C.dim(`\n   索引记录：${idx.标题.slice(0, 30)}`));
    console.log(C.dim(`   成交 ${idx.成交 || 0} 笔 / 支付额 ¥${idx.支付额 || 0} / 曝光 ${idx.曝光 || '?'} —— 没有成交，可以改`));
  }

  const city = await ask('新场次城市（例：广州）: ');
  const star = await ask('新场次主体（例：王嘉尔）: ');
  const ev = (await ask('活动类型（回车=演唱会）: ')) || '演唱会';
  const sess = (await ask('场次（回车=首开）: ')) || '首开';
  if (!city || !star) return;

  console.log(C.dim('\n[1/2] 出一张新主图…'));
  const r1 = run('publish-one.js', [city, star, sess, '--dry', '--event=' + ev], { echo: false });
  const imgRel = grabid(r1.out, /图片:\s*(\S+\.jpg)/);
  if (!imgRel) {
    console.log(C.bad('❌ 出图失败。' + (humanize(r1.out) || '把上面输出发给技术。')));
    return;
  }
  const img = path.join(ROOT, 'publish-out', path.basename(imgRel));
  console.log(C.ok('  主图：' + path.basename(img)));

  console.log(C.warn(`\n将要做的改动（只改这四样，价格/规格/分类之外的东西都不动）：`));
  console.log(`   标题 → 改成 ${city}${star} 的标题（30 字内，自动算）`);
  console.log(`   正文 → 换成这个场次的话术`);
  console.log(`   主图 → 上面这张`);
  console.log(`   所在地 → 改到 ${city}`);
  console.log(C.dim(`   分类 → 会按店铺档案统一改成「演出票代拍」（老链接常是「代购」）`));
  const y = await ask('继续？(y/n) ');
  if (y.toLowerCase() !== 'y') { console.log('已取消'); return; }

  console.log(C.dim('\n[2/2] 改链接（会自动备份原内容）…'));

  // 标题按「店铺文案池」自动算一个 30 字整、不补「！！」、不硬截断的
  const os = require('os');
  const T = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.xianyu-templates.json'), 'utf8'));
  const POOL = ((T.storeTemplates || {})[STORE_NAME]) || T.templates.map(x => x.id);
  const fit = require('../lib/title').makeFitTitle({
    pad: [' 全站全价位都可接', ' 全价位都能接', ' 高命中率', ' 全价位接', ' 可上号', ' 秒付前排', ' 稳中', ' 秒付', ' 包中'],
    max: 30, min: 30,
  });
  let pick = null;
  for (const tid of POOL) {
    const t = T.templates.find(x => x.id === tid);
    if (!t) continue;
    const raw = String(t.titlePattern)
      .replace(/\{明星\}/g, star).replace(/\{城市\}/g, city)
      .replace(/\{活动类型\}/g, ev).replace(/\{场次类型\}/g, sess);
    const r = fit.detail(raw);
    if (r.text.length === 30 && !r.how && !/！/.test(r.text)) { pick = { t, title: r.text }; break; }
  }
  if (!pick) {
    const t = T.templates.find(x => x.id === POOL[0]);
    pick = { t, title: fit.detail(String(t.titlePattern)
      .replace(/\{明星\}/g, star).replace(/\{城市\}/g, city)
      .replace(/\{活动类型\}/g, ev).replace(/\{场次类型\}/g, sess)).text };
  }
  const descFile = path.join(ROOT, 'publish-out', '_staff-desc-' + id + '.txt');
  fs.mkdirSync(path.dirname(descFile), { recursive: true });
  fs.writeFileSync(descFile, String(pick.t.descPattern || ''), 'utf8');
  console.log('  标题：' + pick.title);
  console.log(C.dim('  正文：用模板' + pick.t.id + ' ' + (pick.t.name || '')));

  const r2 = run('tools/apply-item.js', [
    id, '--main=' + img,
    '--title=' + pick.title, '--descFile=' + descFile,
    '--addrCity=' + city, '--useStoreCat', '--go',
  ], { echo: false });
  console.log(r2.out.split('\n').slice(-12).join('\n'));
  if (r2.code === 0 && /SUCCESS/.test(r2.out)) {
    console.log(C.ok('\n✅ 改好了'));
    console.log(C.dim('   如果原来是下架的，平台会自动重新上架，等几分钟在 App 里看得到。'));
  } else {
    console.log(C.bad('\n❌ 没改成。' + (humanize(r2.out) || '原内容已自动备份，把输出发给技术。')));
  }
}

// ─────────────────────────────────────────────────────────────
async function act4() {
  console.log(C.title('④ 现在的链接和推广情况'));
  console.log(C.dim('   （只读，不动任何东西）\n'));
  const r1 = run('tools/list-onsale.js', [], { echo: false });
  console.log(r1.out.split('\n').filter(l => /在售|已下架|其它/.test(l)).join('\n') || C.dim('(取不到)'));
  console.log('');
  const r2 = run('tools/ad-status.js', [], { echo: false });
  const lines = r2.out.split('\n').filter(l => /暂停|投放中|在线|¥/.test(l)).slice(0, 12);
  console.log(lines.length ? lines.join('\n') : C.dim('(取不到推广数据)'));
}

// ─────────────────────────────────────────────────────────────
async function main() {
  console.log('\x1b[1m闲鱼助手\x1b[0m  ' + C.dim('店铺：' + STORE_NAME));
  console.log(C.dim('输入数字回车，直接回车退出\n'));

  for (;;) {
    console.log('  1  发一条新链接');
    console.log('  2  给链接开推广');
    console.log('  3  把旧链接改成新场次');
    console.log('  4  看现在的链接和推广情况');
    console.log('  0  退出');
    const c = await ask('\n选哪个: ');
    if (!c || c === '0') break;
    try {
      if (c === '1') await act1();
      else if (c === '2') await act2();
      else if (c === '3') await act3();
      else if (c === '4') await act4();
      else console.log(C.bad('没有这个选项'));
    } catch (e) {
      console.log(C.bad('出错了：' + (e && e.message || e)));
    }
    await pause();
    console.log('\n' + '─'.repeat(46));
  }
  rl.close();
  console.log('再见');
}

main();
