#!/usr/bin/env node
/**
 * tools/make-base-img.js —— 用 museav 中台给店铺生成「专属主图底图」，并写回店铺档案
 *
 * 为什么需要它（2026-11-12）：
 *   原来主图底图只有两条路：
 *     ① 抓大麦官方海报（明星有票务才抓得到；电竞赛事、小众场次抓不到）
 *     ② 老板手工给一张（每家店风格不统一，代理不会做图）
 *   而 museav 中台能按「风格关键词」生成无文字的底图，一次生成、长期复用，
 *   同一家店所有链接视觉统一 —— 这正是「每人配置不一样」里最该先定的一项。
 *
 * 它做什么：
 *   1. 按风格预设（或自定义关键词）调 museav gen 出一张 3:4 底图（**不含文字**）
 *   2. 下载到 publish-assets/<店铺>/底图/base-<风格>.png
 *   3. 把路径写进 stores/<店铺>.json 的 主图.baseImg
 *   4. 立刻用现役版式叠一张成品图给你看（调 publish-one --dry）
 *
 * 为什么底图不能带文字：版式（xuliang-v1 / __shoukai / tpl_redtext …）会往上叠城市、
 *   明星、卖点三层字，底图自己带字就会糊成一团。所以 prompt 里固定压 no text。
 *
 * 用法:
 *   node tools/make-base-img.js --store="<你的店铺名>" --style=gold
 *   node tools/make-base-img.js --store="XX" --style=custom --prompt="dark blue stage, silver confetti, cinematic"
 *   node tools/make-base-img.js --list                       # 看有哪些风格预设
 *   node tools/make-base-img.js --store="XX" --style=gold --dry   # 只生成不写档案
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

const A = {};
process.argv.slice(2).forEach((a, i, arr) => {
  if (!a.startsWith('--')) return;
  const eq = a.indexOf('=');
  if (eq > 2) { A[a.slice(2, eq)] = a.slice(eq + 1); return; }
  A[a.slice(2)] = (arr[i + 1] && !arr[i + 1].startsWith('--')) ? arr[i + 1] : true;
});

/**
 * 风格预设 —— 每条都是一段"无文字"的底图 prompt。
 * 共同点：no text / no letters / clean lower area（下方留白给版式的字）
 */
const STYLES = {
  gold: {
    name: '金色舞台（默认，最通用）',
    prompt: 'vertical concert poster background, luxurious dark gold stage lighting, golden trophy silhouette in center, bokeh light beams, floating gold ribbons, cinematic, no text, no letters, clean lower area for title, 3:4 poster',
  },
  red: {
    name: '中国红（喜庆、票务感强）',
    prompt: 'vertical concert poster background, deep crimson red stage with golden light rays, glowing particles, elegant silk drapery, cinematic, no text, no letters, clean lower area for title, 3:4 poster',
  },
  blue: {
    name: '科技蓝紫（电竞 / 电子音乐）',
    prompt: 'vertical concert poster background, dark navy blue and violet stage lighting, holographic geometric light beams, subtle particles, futuristic, cinematic, no text, no letters, clean lower area for title, 3:4 poster',
  },
  pink: {
    name: '粉紫梦幻（偶像 / 女团 / 见面会）',
    prompt: 'vertical concert poster background, soft pink and lavender stage lights, dreamy bokeh, floating petals and sparkles, gentle gradient, no text, no letters, clean lower area for title, 3:4 poster',
  },
  dark: {
    name: '极简黑金（高级感，适合内场贵价）',
    prompt: 'vertical concert poster background, minimal matte black backdrop with a single warm golden spotlight from above, subtle haze, high-end premium feel, no text, no letters, clean lower area for title, 3:4 poster',
  },
};

if (A.list || !A.store) {
  console.log('\n风格预设：');
  Object.entries(STYLES).forEach(([k, v]) => console.log('  ' + k.padEnd(8) + v.name));
  console.log('\n用法: node tools/make-base-img.js --store="店铺名" --style=gold');
  console.log('      node tools/make-base-img.js --store="店铺名" --style=custom --prompt="..."\n');
  process.exit(A.list ? 0 : 2);
}

const STORE = A.store;
const STYLE = A.style || 'gold';
const DRY = !!A.dry;

if (STYLE !== 'custom' && !STYLES[STYLE]) {
  console.log('❌ 没有这个风格：' + STYLE + '（用 --list 看可选项）');
  process.exit(2);
}
const PROMPT = STYLE === 'custom' ? String(A.prompt || '') : STYLES[STYLE].prompt;
if (!PROMPT) { console.log('❌ --style=custom 时必须给 --prompt'); process.exit(2); }

const profilePath = path.join(ROOT, 'stores', STORE + '.json');
if (!fs.existsSync(profilePath)) {
  console.log('❌ 没有这个店铺的档案：' + profilePath);
  console.log('   先建店：node tools/store-new.js --name="' + STORE + '" --preset=代拍-标准');
  process.exit(2);
}

const outDir = path.join(ROOT, 'publish-assets', STORE, '底图');
const outFile = path.join(outDir, 'base-' + (STYLE === 'custom' ? 'custom' : STYLE) + '.jpg');

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  console.log('\n店铺：' + STORE);
  console.log('风格：' + (STYLE === 'custom' ? '自定义' : STYLES[STYLE].name));
  console.log('\n调 museav 中台出图（约 30-60 秒）…');

  // 1. 出图，museav 输出的是 URL
  //
  // ⚠️ 不能用 execFileSync('museav', [...], { shell: true })：
  //   shell 会把带空格的 prompt 拆成几十个参数（实测报 "too many arguments ... got 28"）。
  //   直接调 CLI 的 js 入口，参数走数组，完全绕开 shell 引号问题。
  const { resolveMuseavCli } = require('../lib/museav');
  const MUSEAV_CLI = resolveMuseavCli();

  let url = '';
  try {
    if (!MUSEAV_CLI) throw new Error('找不到 museav-cli 的 js 入口（museav 是不是没装？）');
    const out = execFileSync(process.execPath, [MUSEAV_CLI, 'gen', '-p', PROMPT, '-r', '3:4'], {
      encoding: 'utf8', timeout: 600000,
    });
    const m = String(out).match(/https:\/\/\S+\.(png|jpg|jpeg|webp)/i);
    if (m) url = m[0];
    else console.log(out);
  } catch (e) {
    // 2026-11-13 改：原来只说「没登录先 museav login」—— 学员根本没有中台账号，
    //   也不知道 museav 是什么。先说清影响（不影响发布），再说怎么修。
    // 【第 169 轮】同 store-wizard：execFileSync 的 e.message 第一行是「Command failed: <整条命令>」，
    //   后面混着子进程自己的正常输出。去掉命令行，在剩下的里找最像错误的那行。
    const _raw = String((e && e.message) || e).split('\n');
    const _rest = _raw.slice(1).filter((l) => l.trim());
    const _err = [..._rest].reverse().find((l) => /❌|失败|error|Error|failed|not found|ENOENT/i.test(l));
    const _brief = (_err || _rest[0] || _raw[0]).trim().replace(/^❌s*/, '').slice(0, 90);
    console.log('❌ 生成专属底图失败：' + _brief);
    console.log('');
    console.log('   影响：只影响这一张底图。主图会自动改用大麦官方海报，发布照常。');
    console.log('   要修的话：');
    console.log('     ① 先确认 museav 装了：museav -V');
    console.log('     ② 没登录过就登录：museav login  （需要中台账号，找管理员要）');
    console.log('   不修也行，用大麦海报完全能发。');
    process.exit(1);
  }
  if (!url) { console.log('❌ 没从输出里找到图片 URL'); process.exit(1); }
  console.log('✅ 出图：' + url);

  // 2. 下载（museav 返回的是 PNG，落盘前统一转 JPEG —— 扩展名和真实格式必须一致，
  //    否则下游 sharp / 闲鱼图床都会踩到「.jpg 里装的是 PNG」这种坑）
  const http = require(url.startsWith('https') ? 'https' : 'http');
  const tmp = outFile.replace(/\.jpg$/, '.tmp');
  await new Promise((resolve, reject) => {
    const f = fs.createWriteStream(tmp);
    http.get(url, (res) => {
      if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
      res.pipe(f);
      f.on('finish', () => { f.close(); resolve(); });
    }).on('error', reject);
  });
  let kb = 0;
  try {
    const { PATHS } = require('../lib/env');
    const sharp = require(path.join(PATHS.playwrightService, 'node_modules', 'sharp'));
    await sharp(tmp).jpeg({ quality: 95 }).toFile(outFile);
    fs.unlinkSync(tmp);
    kb = Math.round(fs.statSync(outFile).size / 1024);
  } catch (e) {
    // 没有 sharp 就直接用原文件（至少能用），但如实说明
    fs.renameSync(tmp, outFile);
    kb = Math.round(fs.statSync(outFile).size / 1024);
    console.log('   ⚠️ 没转成 JPEG（' + (e.message || e).slice(0, 60) + '），原格式直接落盘');
  }
  console.log('✅ 已存：' + path.relative(ROOT, outFile) + '  ' + kb + 'KB');

  // 3. 写回档案
  if (DRY) {
    console.log('\n[--dry] 不写档案。要写进去就去掉 --dry');
    return;
  }
  const prof = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  const rel = path.relative(ROOT, outFile).replace(/\\/g, '/');
  prof.主图 = prof.主图 || {};
  prof.主图.baseImg = rel;
  prof.主图._baseImg来源 = 'museav 中台生成（' + new Date().toISOString().slice(0, 10) + '，风格 ' + STYLE + '）';
  fs.writeFileSync(profilePath, JSON.stringify(prof, null, 2), 'utf8');
  console.log('✅ 已写入档案：stores/' + STORE + '.json → 主图.baseImg = ' + rel);

  // 4. 立刻叠一张成品图给店员看
  console.log('\n出一张成品图预览（底图 + 现役版式）…');
  try {
    const out2 = execFileSync(process.execPath, [path.join(ROOT, 'publish-one.js'), '广州', '示例明星', '首开', '--dry'], {
      cwd: ROOT, encoding: 'utf8', timeout: 300000,
      env: Object.assign({}, process.env, { XY_STORE: STORE, KUN_BASE_IMG: outFile }),
    });
    const mm = String(out2).match(/图片:\s*(\S+\.jpg)/);
    if (mm) console.log('✅ 成品图：publish-out/' + path.basename(mm[1]));
    if (mm) console.log('   看一眼满不满意；不满意换个 --style 再跑一次。');
  } catch (e) {
    console.log('（预览出图跳过：' + (e.message || '').slice(0, 80) + '）');
  }
})().catch(e => { console.log('❌ ' + (e && e.message || e)); process.exit(1); });
