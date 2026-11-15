#!/usr/bin/env node
/**
 * tools/store-wizard.js —— 店铺配置向导（五步，给员工和代理用）
 *
 * 为什么需要它（2026-11-12）：
 *   老板的原话：「每个人的商品上架配置都是不一样的。我们要引导他怎么做成自己的模板。」
 *   而 `presets/代拍-标准.json` 建店时自己就会警告两项【众数很弱】：
 *     推广·预期成本 ¥2.8（4/11，占 36%）· 推广·时段 15h（6/11，占 55%）
 *   —— 样板不能当标准，只能当起点。所以向导不是"照抄"，是"给起点 + 逼确认"。
 *
 * 五步：
 *   ① 店铺名 + 闲鱼账号（从 8093 账号表里选，一个账号只能属于一个店）
 *   ② 价格 / 规格档位 / 分类（业务判断，每个店不同）
 *   ③ 主图风格 —— 调 museav 中台生成店铺专属底图（老板要求：主图引导用 museav）
 *   ④ 版式 —— 按底图主色推荐（实测红底配红字会糊，见下）
 *   ⑤ 文案口味 + 广告预算 → 写档案
 *
 * 底图-版式配对规则（来自 2026-11-12 实测）：
 *   红/暖深色底 配 tpl_redtext 的红字 → 红字融进红底，几乎看不清
 *   所以红底只推荐 __shoukai / xuliang-v1（白字/黄紫块）。
 *
 * 用法:
 *   node tools/store-wizard.js                          # 交互式，一步步问
 *   node tools/store-wizard.js --dry                    # 只看会写什么
 *   （管道模式支持预设答案，便于自动化测试：printf 'a\nb\n...' | node tools/store-wizard.js）
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const A = {};
process.argv.slice(2).forEach((a, i, arr) => {
  if (!a.startsWith('--')) return;
  const eq = a.indexOf('=');
  if (eq > 2) { A[a.slice(2, eq)] = a.slice(eq + 1); return; }
  A[a.slice(2)] = (arr[i + 1] && !arr[i + 1].startsWith('--')) ? arr[i + 1] : true;
});
const DRY = !!A.dry;

// 【第 253 轮】未知参数给个明确提示。
//   起因：我第一次调它用了 --apply --store --price --spec --cat --style --tone --budget --bid
//   —— 这些【一个都不认】（实际只认 --dry / --answers / --answersFile，见 L22-25 用法），
//   全被静默忽略，跑完 exit0 但档案没写，我还以为是参数生效了只是没落盘。
//   写档案本来就是默认行为（只有 --dry 才不写），所以连 --apply 也是多余的。
{
  const KNOWN = new Set(['dry', 'answers', 'answersFile']);
  const unknown = Object.keys(A).filter((k) => !KNOWN.has(k));
  if (unknown.length) {
    console.log('');
    console.log('  ⚠️ 这些参数向导不认，已忽略：' + unknown.map((k) => '--' + k).join(' '));
    console.log('    向导是【一步步问你】的，值不通过参数传。认的只有：');
    console.log('      --dry                只看会写什么，不落档');
    console.log('      --answers=a|b|c|…   预设答案（自动化用，| 分隔）');
    console.log('      --answersFile=路径   从文件读答案');
    console.log('    写档案是默认行为，不用加 --apply。');
    console.log('    最省事的办法：用网页 staff-ui 里的「⑤ 配置一家新店」，有表单。');
    console.log('');
  }
}

// ── 输入（TTY 交互 / 管道预设答案 / --answers 参数）──────
// ⚠️【2026-11-12】网页版调它时，stdin 传中文会被按系统代码页解码成 `??`
//   （实测：店名变 ??????? ，mkdir 到 publish-assets\???????\底图 直接 ENOENT）。
//   所以加了 --answers：答案用 | 分隔走【命令行参数】—— 中文走参数是验证过没问题的。
//   顺序：店名|标价|规格|分类|风格|版式|口味|预算|出价
let PRESET = [];
if (A.answersFile) {
  // ⚠️【2026-11-12】Windows 上中文既不能走 spawn 的 stdin（按系统代码页解码成 ??），
  //   也不能走 spawn 的命令行参数（同样丢成 ??，实测「向导接口测试店」变 7 个问号）。
  //   唯一稳的是【文件】：JSON 明文 UTF-8，读写都不经过命令行。
  PRESET = JSON.parse(fs.readFileSync(A.answersFile, 'utf8'));
  console.log('（答案来自文件 ' + A.answersFile + '）');
} else if (A.answers) {
  PRESET = String(A.answers).split('|');
  console.log('（答案来自 --answers 参数）');
} else if (!process.stdin.isTTY) {
  try { PRESET = fs.readFileSync(0, 'utf8').split(/\r?\n/); } catch (e) { PRESET = []; }
}
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q, def) => {
  const suffix = def !== undefined && def !== '' ? '（回车= ' + def + '）' : '';
  if (PRESET.length) {
    const v = PRESET.shift();
    console.log(q + suffix + ' ' + v);
    return Promise.resolve(String(v || '').trim() || (def === undefined ? '' : String(def)));
  }
  if (!process.stdin.isTTY) return Promise.resolve(def === undefined ? '' : String(def));
  return new Promise(res => rl.question(q + suffix + ' ', v => res(String(v || '').trim() || (def === undefined ? '' : String(def)))));
};

const { resolveMuseavCli } = require('../lib/museav');
const MUSEAV_CLI = resolveMuseavCli();
const STYLES = {
  gold: { name: '金色舞台', tone: 'warm', prompt: 'vertical concert poster background, luxurious dark gold stage lighting, golden trophy silhouette in center, bokeh light beams, floating gold ribbons, cinematic, no text, no letters, clean lower area for title, 3:4 poster' },
  red: { name: '中国红', tone: 'warm', prompt: 'vertical concert poster background, deep crimson red stage with golden light rays, glowing particles, elegant silk drapery, cinematic, no text, no letters, clean lower area for title, 3:4 poster' },
  blue: { name: '科技蓝紫', tone: 'cool', prompt: 'vertical concert poster background, dark navy blue and violet stage lighting, holographic geometric light beams, subtle particles, futuristic, cinematic, no text, no letters, clean lower area for title, 3:4 poster' },
  pink: { name: '粉紫梦幻', tone: 'light', prompt: 'vertical concert poster background, soft pink and lavender stage lights, dreamy bokeh, floating petals and sparkles, gentle gradient, no text, no letters, clean lower area for title, 3:4 poster' },
  dark: { name: '极简黑金', tone: 'dark', prompt: 'vertical concert poster background, minimal matte black backdrop with a single warm golden spotlight from above, subtle haze, high-end premium feel, no text, no letters, clean lower area for title, 3:4 poster' },
};

/** 底图主色 → 推荐版式（红底别用红字版式，实测会糊） */
const TPL_BY_TONE = {
  warm: ['__shoukai', 'xuliang-v1'],
  cool: ['xuliang-v1', '__shoukai'],
  light: ['xuliang-v1', '__shoukai'],
  dark: ['tpl_redtext', '__shoukai'],
};
const TPL_NAME = { 'xuliang-v1': '三黄块+一紫块', '__shoukai': '紫块+三行红字', 'tpl_redtext': '满屏红字', 'hmd_yellow_3red': '黄块+三行贴纸' };

function sh(script, args, env) {
  try {
    return { ok: true, out: execFileSync(process.execPath, [path.join(ROOT, script), ...args], { cwd: ROOT, encoding: 'utf8', timeout: 600000, env: Object.assign({}, process.env, env || {}) }) };
  } catch (e) { return { ok: false, out: (e.stdout || '') + (e.stderr || '') }; }
}

(async () => {
  console.log('\n════════ 店铺配置向导 ════════');
  console.log('五步配好一家店。每一步都会先给你看结果，你点头才写档案。\n');

  // ① 店名 + 账号
  const accounts = (() => {
    try { return JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'tools', 'store-new.js'), '--list-accounts'], { cwd: ROOT, encoding: 'utf8' })); } catch (e) { return []; }
  })();
  const storeName = await ask('① 店铺名（要和 8093 里的闲鱼账号名一致）');
  if (!storeName) { console.log('没填店名，退出'); rl.close(); return; }

  let accList = [];
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'store-new.js'), '--list-accounts'], { cwd: ROOT, encoding: 'utf8' });
    accList = (out.match(/[\w\u4e00-\u9fa5-]+\s+1\d{10}/g) || []);
  } catch (e) {}
  console.log('\n  8093 里的闲鱼账号：' + (accList.length ? accList.join(' / ') : '（读不到，稍后 store-new 会自动匹配）'));

  // ② 价格 / 规格 / 分类
  console.log('\n② 上架参数（每个店不一样，别照抄别人的）');
  const price = await ask('   标价（元）', '50');
  const spec = await ask('   规格档位（单档写「标准」；多档用 / 隔开，如：看台/内场）', '标准');
  const cat = await ask('   分类名（代购 / 演出票代拍）', '演出票代拍');

  // ③ 主图风格（museav）
  console.log('\n③ 主图底图 —— 用 museav 中台生成（这是你店铺的脸，一次生成长期复用）');
  console.log('   可选风格：' + Object.entries(STYLES).map(([k, v]) => k + '(' + v.name + ')').join('  '));
  let styleKey = await ask('   选一个风格', 'gold');
  if (!STYLES[styleKey]) { console.log('   没有这个风格，用 gold'); styleKey = 'gold'; }
  const tone = STYLES[styleKey].tone;
  let baseImg = '';

  // ⚠️【2026-11-12 改】--dry 也要出图。
  //   原来 dry 直接跳过 museav，只打一行"假定底图为 xxx" ——
  //   那"预览"就只剩文字，代理根本看不到底图长什么样，等于没预览。
  //   现在：图照出（落盘到店铺目录，无害），只是【不写档案】的 baseImg。
  {
    console.log('\n   调 museav 出图（约 25-40 秒）' + (DRY ? '（--dry 也出图，只是不写档案）' : '') + '…');
    const outDir = path.join(ROOT, 'publish-assets', storeName, '底图');
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, 'base-' + styleKey + '.jpg');
    try {
      // 【2026-11-13 改】museav CLI 出图时会往 stderr 反复打「生成中...」，实测一次跑下来
      //   刷了将近 30 行，中间还有几十秒没别的输出 —— 学员看到这个会以为卡死了，
      //   而真正该看的信息（"约 25-40 秒"）被顶上去了。
      //   把 stderr 也捕获起来，改成一个每 3 秒动一下的进度点；失败时再把原始输出打出来（排查用）。
      process.stdout.write('   出图中 ');
      const dot = setInterval(() => process.stdout.write('.'), 3000);
      let out;
      let genErr = '';
      try {
        out = execFileSync(process.execPath, [MUSEAV_CLI, 'gen', '-p', STYLES[styleKey].prompt, '-r', '3:4'],
          { encoding: 'utf8', timeout: 600000, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e1) {
        genErr = String((e1 && (e1.stderr || e1.message)) || '');
        throw e1;
      } finally {
        clearInterval(dot);
        process.stdout.write('\n');
        if (genErr) {
          console.log('   museav 原始输出（排查用）：');
          genErr.split(/\r?\n/).slice(-8).forEach((l) => console.log('     ' + l));
        }
      }
      const m = String(out).match(/https:\/\/\S+\.(png|jpg|jpeg|webp)/i);
      if (!m) throw new Error('没拿到图片 URL');
      const http = require(m[0].startsWith('https') ? 'https' : 'http');
      const tmp = outFile.replace(/\.jpg$/, '.tmp');
      await new Promise((resolve, reject) => {
        const f = fs.createWriteStream(tmp);
        http.get(m[0], res => { if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode)); res.pipe(f); f.on('finish', () => { f.close(); resolve(); }); }).on('error', reject);
      });
      // museav 返回 PNG，统一转 JPEG（扩展名与真实格式必须一致）
      try {
        const { PATHS } = require('../lib/env');
        const sharp = require(path.join(PATHS.playwrightService, 'node_modules', 'sharp'));
        await sharp(tmp).jpeg({ quality: 95 }).toFile(outFile);
        fs.unlinkSync(tmp);
      } catch (e) { try { fs.renameSync(tmp, outFile); } catch (e2) {} }
      baseImg = path.relative(ROOT, outFile).replace(/\\/g, '/');
      console.log('   ✅ 底图：' + baseImg + '  ' + Math.round(fs.statSync(outFile).size / 1024) + 'KB');
    } catch (e) {
      // 【第 169 轮】e.message 对 execFileSync 是「Command failed: <整条命令>\n<子进程输出>」：
      //   · 第一行是又长又英文的命令路径 —— 学员看不懂
      //   · 后面几行里混着子进程自己的正常输出（如 museav 的 prompt）
      //   所以：去掉命令行 → 在剩下的里找【最像错误的那行】（❌/失败/error/failed），
      //   找不到就退回第一行。实测出图失败时得到「❌ fetch failed」而不是
      //   「Command failed: C:\...\node.exe C:\...\museav 提交出图: vertical...」。
      const _raw = String(e.message || e).split('\n');
      const _rest = _raw.slice(1).filter((l) => l.trim());
      const _err = [..._rest].reverse().find((l) => /❌|失败|error|Error|failed|not found|ENOENT/i.test(l));
      const _brief = (_err || _rest[0] || _raw[0]).trim().replace(/^❌s*/, '').slice(0, 90);
      console.log('   ❌ 出图失败：' + _brief);
      console.log('      常见原因：没装 museav（npm i -g museav-cli@latest）或没登录（museav login）。');
      console.log('      → 这次不写入底图，发布时会退回用大麦官方海报（不影响发布）。');
      console.log('      → 想补专属底图：museav login 后再跑 node tools/make-base-img.js --store="' + storeName + '" --style=' + styleKey);
      // ⚠️【2026-11-12 修】原来这里仍然给 baseImg 赋了一个路径，结果是：
      //   出图失败（比如学员没 museav login）→ 档案里的 主图.baseImg 指向一个【不存在的文件】
      //   → 自检报「底图格式 文件不存在」、发布时也可能踩空。
      //   现在失败就不写，让下游走「未配底图 → 大麦海报」这条正常降级路径。
      baseImg = '';
    }
  }

  // ④ 版式（按底色推荐）
  const rec = TPL_BY_TONE[tone] || TPL_BY_TONE.warm;
  console.log('\n④ 版式（按底图主色推荐，实测红底配红字会看不清）');
  console.log('   底图主色：' + tone + ' → 推荐：' + rec.map(k => k + '(' + TPL_NAME[k] + ')').join(' ／ '));
  const tplPick = await ask('   用哪个', rec[0]);
  const tpl = rec.includes(tplPick) ? tplPick : rec[0];
  if (tplPick !== tpl) console.log('   ⚠️ ' + tplPick + ' 不在推荐里（红底配红字会糊），改用 ' + tpl);

  // ⑤ 文案 + 广告
  console.log('\n⑤ 文案口味 + 广告预算');
  const tone2 = await ask('   文案口味（狠 / 稳 / 捡漏）', '稳');
  const budget = await ask('   日推广预算（元）', '50');
  const bid = await ask('   单次咨询成本出价（元，红线 ≤4）', '4');

  // ── 汇总确认 ──
  console.log('\n══════ 将要写入档案 ══════');
  console.log('  店铺名    : ' + storeName);
  console.log('  标价/规格 : ¥' + price + ' / ' + spec);
  console.log('  分类      : ' + cat);
  console.log('  主图底图  : ' + (baseImg || '(无)') + '  风格=' + styleKey);
  console.log('  版式      : ' + tpl + '（' + TPL_NAME[tpl] + '）');
  console.log('  文案口味  : ' + tone2);
  console.log('  广告      : 日上限 ¥' + budget + ' / 出价 ¥' + bid);

  const yes = await ask('\n写入档案？(y/n)', 'y');
  if (String(yes).toLowerCase() !== 'y') { console.log('已放弃，什么都没写'); rl.close(); return; }

  // ── 建档 ──
  if (DRY) { console.log('\n[--dry] 不写档案'); rl.close(); return; }
  // 档案已存在时 store-new 会拒绝（防覆盖），这不是失败——下面直接改它
  if (fs.existsSync(path.join(ROOT, 'stores', storeName + '.json'))) {
    console.log('\n建档：跳过（档案已存在，下面直接改它）');
  } else {
    const r1 = sh('tools/store-new.js', ['--name=' + storeName, '--preset=代拍-标准']);
    console.log('\n建档：' + (r1.ok ? '✅ 新建' : '❌ 失败（看上面输出）'));
  }

  // ── 改档案里的这几项 ──
  const profPath = path.join(ROOT, 'stores', storeName + '.json');
  if (fs.existsSync(profPath)) {
    const p = JSON.parse(fs.readFileSync(profPath, 'utf8'));
    p.价格 = { default: Number(price) || 50, origPrice: null };
    p.规格 = { propertyName: '代拍费', specs: String(spec).split('/').map(s => ({ valueText: s.trim() })) };
    // ⚠️ 分类必须【同时】改 catName 和 channelCatId —— 只改名字会留下不一致的 id
    //    （2026-11-12 实测：catName=演出票代拍 但 channelCatId 还是代购的 201456914，
    //      平台按 id 归类，等于没改成。留资卡也要求品类对得上。）
    const { CATEGORY_TEMPLATES } = require('../lib/store-profile');
    const tplCat = CATEGORY_TEMPLATES[cat];
    p.分类 = Object.assign({}, p.分类, {
      catName: cat,
      catId: tplCat ? tplCat.catId : p.分类.catId,
      channelCatId: tplCat ? tplCat.channelCatId : p.分类.channelCatId,
    });
    if (!tplCat) console.log('   ⚠️ 分类「' + cat + '」不在 CATEGORY_TEMPLATES 里，沿用原 id，请人工核对');
    else console.log('   分类：' + cat + ' → catId=' + tplCat.catId + ' channelCatId=' + tplCat.channelCatId);
    if (baseImg) { p.主图 = p.主图 || {}; p.主图.baseImg = baseImg; }
    p.主图 = p.主图 || {}; p.主图.templates = [tpl];
    p.广告 = p.广告 || {}; p.广告.enabled = true;
    p.广告.planBudget = Number(budget) || 50;
    p.广告.计划 = Object.assign({}, p.广告.计划 || {}, { 预期成本: Number(bid) || 4, 日上限: Number(budget) || 50 });
    p._向导生成 = '由 tools/store-wizard.js 于 ' + new Date().toISOString().slice(0, 19) + ' 生成；文案口味=' + tone2;
    fs.writeFileSync(profPath, JSON.stringify(p, null, 2), 'utf8');
    console.log('档案已改：价格/规格/分类/底图/版式/广告 → stores/' + storeName + '.json');

    // ⚠️【2026-11-12 加】检查 accountId 有没有填上。
    //   学员里最常见的顺序错误：先配店、后填 service.local.json。
    //   那样 store-new 匹配不到 8093 账号，档案里 accountId 留空，
    //   之后所有发布/广告操作都会失败，而报错是「店铺未就绪」—— 学员根本看不出是这个问题。
    if (!p.accountId) {
      console.log('');
      console.log('⚠️ 这份档案没填上 accountId —— 说明 8093 里还没有「' + storeName + '」这个账号。');
      console.log('   常见原因：service.local.json 还没填，或者填了但没重启 8093。');
      console.log('   怎么修（顺序很重要）：');
      console.log('     ① 编辑 xianyu-playwright-service\\service.local.json，确保 localAccounts[0].name = "' + storeName + '"');
      console.log('     ② 双击 xianyu-playwright-service\\start.bat 重启服务');
      console.log('     ③ 确认：node tools\\store-new.js --list-accounts   ← 应该能看到「' + storeName + '」');
      console.log('     ④ 再跑一次本向导（配置不会白配，会覆盖成同一份）');
      console.log('   现在配置的其他项都是对的，只差这一步关联。');
    }
  }

  // ── 出一张成品预览 ──
  if (baseImg) {
    console.log('\n出一张成品预览（底图 + ' + tpl + '）…');
    const r2 = sh('publish-one.js', ['广州', '示例明星', '首开', '--dry'], {
      XY_STORE: storeName,
      KUN_BASE_IMG: path.join(ROOT, baseImg),
      KUN_MAIN_TPL: tpl,
    });
    const mm = (r2.out || '').match(/图片:\s*(\S+\.jpg)/);
    if (mm) console.log('   ✅ publish-out/' + path.basename(mm[1]) + '  ← 看一眼，不满意重跑换个风格');
    else console.log('   预览出图跳过');
  }

  // ── 收尾：还差什么 ──
  console.log('\n══════ 还差这两步（机器做不了）══════');
  console.log('  ① 扫码登录： node tools/store-login.js "' + storeName + '"');
  console.log('  ② 补闲鱼userId：登录后在 stores/' + storeName + '.json 里加 "闲鱼userId": "<那串数字>"');
  console.log('     （不补的话 list-onsale 会拒绝运行，这是故意的——免得查错店）');
  console.log('\n弄完就能发了：');
  console.log('  $env:XY_STORE="' + storeName + '"; node publish-one.js 广州 <明星> 首开\n');
  rl.close();
})().catch(e => { console.log('❌ ' + (e && e.message || e)); process.exit(1); });
