/**
 * tools/staff-ui/server.js —— 闲鱼上架助手（本地网页版）
 *
 * 为什么要有它（2026-11-12）：
 *   同一件事已经有一个 CLI 版 tools/staff.js，但给两类人用都不合适：
 *     · 内部人员：记不住命令、看不到进度
 *     · 代理（学员）：本机装了三仓 + Node，还要开命令行
 *   公司其他系统（hym-website / hym-admin）都是网页，代理已经习惯"打开网页点按钮"。
 *
 * 形态选择：**本机 localhost 网页**，不是云端后台。
 *   因为闲鱼操作必须落在【这台机器】的浏览器登录态上（8093 Playwright），
 *   云端页面调不到本机浏览器。所以：网页做界面，执行还在本机。
 *
 * 设计约束（照抄 hym-website/AGENTS.md 的规矩）：
 *   · 零新依赖，只用 Node 内置 http/fs/child_process
 *   · 单文件 < 500 行
 *   · 动作全部转发现有脚本，不在这里重写业务逻辑
 *     （publish-one / first-publish / ad-plan-create / ad-power / apply-item / list-onsale）
 *   · 护栏照 staff.js：改旧链接前查成交额，有成交直接拒
 *
 * 用法: node tools/staff-ui/server.js [--port=8099] [--store=好易美代拍]
 *       然后浏览器打开 http://127.0.0.1:8099
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const NODE = process.execPath;
const A = process.argv.slice(2).reduce((o, a) => {
  const i = a.indexOf('=');
  if (a.startsWith('--') && i > 2) o[a.slice(2, i)] = a.slice(i + 1);
  return o;
}, {});
const PORT = Number(A.port || 8099);
const STORE_NAME = A.store || process.env.XY_STORE || '好易美代拍';

// ── 任务表（内存，够用）──────────────────────────────────────
const TASKS = new Map();
let seq = 0;
function newTask(kind) {
  const id = String(++seq);
  TASKS.set(id, { id, kind, status: 'running', log: [], result: null, startedAt: Date.now() });
  if (TASKS.size > 50) { // 只留最近 50 个
    const oldest = [...TASKS.keys()].slice(0, TASKS.size - 50);
    oldest.forEach(k => TASKS.delete(k));
  }
  return TASKS.get(id);
}
function pushLog(t, s) {
  String(s).split(/\r?\n/).forEach(line => { if (line.trim()) t.log.push(line); });
  if (t.log.length > 800) t.log = t.log.slice(-800);
}

/** 跑一个仓库脚本，把输出收进任务日志 */
function runScript(t, script, args, timeoutMs = 900000, env) {
  return new Promise((resolve) => {
    pushLog(t, '$ ' + [script, ...args].join(' '));
    const cp = execFile(NODE, [path.join(ROOT, script), ...args], {
      cwd: ROOT, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
      env: Object.assign({}, process.env, env || {}),
    }, (err, stdout, stderr) => {
      pushLog(t, stdout || '');
      pushLog(t, stderr || '');
      resolve({ code: err ? (err.code || 1) : 0, out: (stdout || '') + (stderr || '') });
    });
    if (cp.stdout) cp.stdout.on('data', d => pushLog(t, d.toString()));
    if (cp.stderr) cp.stderr.on('data', d => pushLog(t, d.toString()));
  });
}

// ── 业务：四项动作 ──────────────────────────────────────────
const HUMAN = [
  // 【2026-11-12 实测】超能水手代拍发布时撞到：
  //   FAIL_BIZ_SELLER_ANNUAL_COMPLIANCE_REQUIRED::请到闲鱼App完成经营者年检任务后，再发布或编辑商品
  //   这是账号侧的资质动作，代码完全无解，必须人去 App 做。
  [/ANNUAL_COMPLIANCE_REQUIRED/, '这个闲鱼号需要在【闲鱼 App】完成「经营者年检」才能发布/编辑商品。代码改不了，得你去 App 操作（一般在我-设置-资质/年检里）。做完再重试。'],
  [/USER_WAS_FORBIDDEN2/, '账号被平台限制了发布权限。代码改不了，等恢复或找老板。'],
  [/CONDITION_NOT_SUPPORT_SIGN/, '老链接带着新品类不支持的服务承诺。工具会自动清理，重跑一次。'],
  [/闲鱼太累啦|UN_CATCH_EXCEPTION/, '大概率不是限流：先看这条链接有没有规格——无规格的商品改不了。'],
  [/ABORT::接口异常退出/, '调到了不存在的接口，不是你的操作问题，把这段发给技术。'],
  [/未就绪|not ready/i, '浏览器上下文被回收了，先在"环境体检"里点一次预热。'],
  // ── 2026-11-12 补：学员真会撞到的场景，按「是什么 + 你该做什么」写 ──
  [/HTTP Basic|Authentication failed|no such remote/i, '连不上代码仓库（凭证过期或没网）。不影响已装好的功能，先用着，别乱重装。'],
  [/ENOTFOUND|EAI_AGAIN|getaddrinfo/i, 'DNS 解析失败——这台电脑没网或网络被拦了。先确认能打开 goofish.com。'],
  [/ECONNREFUSED|socket hang up/i, '本机 8093 服务没起来。点右上角「环境体检 / 预热」重试；还不行就重跑 install.cmd。'],
  [/ETIMEDOUT|timeout of \d+ms exceeded/i, '超时了。多半是网络慢或平台在限速，等 1 分钟重试一次，别连点。'],
  [/req-gate|10 分钟内已发/i, '操作太密集被限速了（60 次/10 分钟）。等 1-2 分钟再试，不用重启任何东西。'],
  [/Target page, context or browser has been closed/i, '浏览器页面被关掉了。点右上角「环境体检 / 预热」，然后重试。'],
  [/请先登录|未登录|login required|SESSION_EXPIRED/i, '登录失效了。点右上角「店铺 ▾」→ 你的店 → 「登录」，重新扫码。'],
  [/余额不足|balance_paused/i, '这个店的广告账户没钱了。充值后计划会自动恢复（余额型暂停是自愈的），不用重建。'],
  [/FAIL_BIZ_ITEM_NO_PICS/i, '发布时图片没传上去（图床失败）。重跑一次；连续失败就把图发给技术。'],
  [/FAIL_BIZ_BAD_REQUEST|BIZPARAM_MISSED/i, '这次提交少参数（多是不带规格的老链接）。把日志发给技术。'],
  [/FAIL_SYS_HSF_NOTFOUND/i, '接口调不通（平台侧变动）。不是你的操作问题，发给技术。'],
  [/找不到 museav|museav-cli/i, '没装出图客户端。命令行跑：npm i -g museav-cli@latest，然后 museav -V 确认能打印版本。'],
  [/大麦|damai.*(没有|查不到)|场次.*(为空|找不到)/i, '大麦上查不到这个场次。核对一下城市/明星写得对不对；确实没有就别硬发。'],
  [/标题.*重复|重复标题/i, '这个标题店里已经有了。换场次，或让工具换一套文案模板重试。'],
  [/[-_]9\b|审核/i, '-9 是【审核中】，不是被删。等 10-30 分钟自己会转正，别重复发。'],
  [/ENOENT.*publish-assets/i, '缺图：publish-assets 里对应的文件不在。先跑一次出图（配店第③步或 make-base-img）。'],
  [/EACCES|EPERM/i, '没有文件权限。别把工具放在 C 盘系统目录，换到 D:\\ 或用户目录下。'],
  // ── 2026-11-13 补：代理 / VPN 类。学员最常见的"看起来坏了"其实是开着代理 ──
  [/ERR_PROXY|ERR_TUNNEL|PROXY_CONNECTION|ECONNRESET.*proxy/i,
    '代理/VPN 把连接掐断了。**先关掉 VPN / 系统代理**（Clash、v2ray、公司 VPN 都算），再重试。闲鱼对代理 IP 很敏感，开着代理基本用不了。'],
  [/FAIL_SYS_NETWORK|网络异常|NETWORK_ERROR/i,
    '网络请求失败。先检查：① 是不是开着 VPN/代理（关掉）② 能不能正常打开 goofish.com ③ 有没有断网。'],
  // ── 2026-11-13 补：杀毒/防火墙静默拦截。360、火绒常把 node.exe 当可疑程序阻止联网，
  //   表现就是"莫名其妙连不上"，而且没有任何提示 —— 学员会以为是工具坏了。
  [/ECONNRESET|ECONNABORTED|socket hang up|连接被重置|远程主机强迫关闭/i,
    '连接被对方（或本机安全软件）强制断开了。\n' +
    '     最常见的两个原因：① 开着代理/VPN ② 杀毒软件（360/火绒/电脑管家）拦了 node.exe 联网。\n' +
    '     处理：先把杀毒软件对【node.exe】的联网限制关掉，或临时退出安全软件再试一次。'],
  [/ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED/i,
    '这台电脑连不上外网。检查网络连接，或先确认浏览器能打开任意网站。'],
  // ── 2026-11-13 补：SSL / 证书 / 系统时间。笔记本休眠久了时间会飘，TLS 直接拒连 ──
  [/CERT_|SSL|TLS|UNABLE[ _]TO[ _]VERIFY|self.signed certificate|证书/i,
    'SSL 证书校验失败。最常见原因不是证书坏了，而是【这台电脑的系统时间不对】。\n' +
    '     处理：Windows 设置 → 时间和语言 → 打开"自动设置时间"→ 点"立即同步"，然后重试。'],
  [/TOKEN_EXOIRED|TOKEN_EXPIRED|签名|SIGNATURE|FAIL_SYS_ILLEGAL_ACCESS/i,
    '平台拒绝了这次请求（签名/时间戳对不上）。\n' +
    '     处理：① 先确认电脑时间准（设置里同步一次时间）② 重新扫码登录 ③ 还不行就把日志发给技术。'],
];
const humanize = (s) => { for (const [re, m] of HUMAN) if (re.test(s)) return m; return ''; };

/** 读索引里的成交数据（改链接前的护栏） */
function indexOfItem(itemId) {
  const f = path.join(ROOT, 'xianyu-商品索引.csv');
  if (!fs.existsSync(f)) return null;
  for (const line of fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = line.match(/"([^"]*)","([^"]*)","([^"]*)","([^"]*)","([^"]*)","([^"]*)","([^"]*)","([^"]*)","([^"]*)","([^"]*)"/);
    if (m && m[2] === itemId) return { 标题: m[4], 价格: m[5], 曝光: m[7], 成交: m[8], 支付额: m[9] };
  }
  return null;
}

async function doPublish(t, p) {
  // ⚠️【2026-11-12 修】两个 bug 一起修：
  //   ① first-publish.js 不加 --yes 时只走预演，最后停在「[6/6] 真要发吗？重跑加 --yes」，
  //     【什么都没发】。网页上一路点下来界面显示"完成"，员工以为发出去了 —— 这个按钮是废的。
  //     现在按 confirm 决定：不勾 = 只预演（dry），勾了 = 真发（--yes）。
  //   ② 没传 XY_STORE，永远发到服务端默认店，不是页面上那个店。
  const args = [p.city, p.star, p.session || '首开', '--event=' + (p.event || '演唱会')];
  // 底图来源：页面选了就覆盖，没选就跟随档案（主图.底图来源）
  if (p.base) { args.push('--base=' + p.base); pushLog(t, '（主图底图：' + (p.base === 'shop' ? '店铺专属 museav 底图' : '大麦官方海报') + '）'); }
  if (p.confirm) {
    args.push('--yes');
    pushLog(t, '（已确认发布，会真发）');
  } else {
    pushLog(t, '（未勾「确认发布」——只跑预演，不会真发）');
  }
  const r = await runScript(t, 'tools/first-publish.js', args, 900000, { XY_STORE: STORE_NAME });
  const published = /itemId[=:]\s*"?\d{10,}/.test(r.out) || /已发布|发布成功/.test(r.out);
  if (r.code === 0 && published) t.status = 'done';
  else if (r.code === 0) t.status = 'preview';      // 预演跑完了，没发
  else { t.status = 'failed'; pushLog(t, '❗ ' + (humanize(r.out) || '把上面的输出发给技术。')); }
}

async function doPromote(t, p) {
  const r1 = await runScript(t, 'tools/ad-plan-create.js',
    ['--store=' + STORE_NAME, '--items=' + p.itemId, '--city=' + p.city, '--star=' + p.star, '--apply']);
  const m = r1.out.match(/\bid=(\d+)\s/);
  if (!m) { t.status = 'failed'; pushLog(t, '❗ 没建成功。' + (humanize(r1.out) || '把输出发给技术。')); return; }
  const planId = m[1];
  pushLog(t, '\n=== 计划已建：' + planId + '，开始开启 ===');
  const r2 = await runScript(t, 'tools/ad-power.js', ['on', planId]);
  const okPart = r2.out.split('动作后校验')[1] || '';
  if (/✅/.test(okPart)) { t.status = 'done'; pushLog(t, '\n✅ 推广已开启，今天就能跑'); }
  else {
    t.status = 'done';
    pushLog(t, '\n⚠️ 计划建好了，但暂时开不起来：商品刚改过，广告这边还没同步。');
    pushLog(t, '   → 等 30-60 分钟，再执行：node tools/ad-power.js on ' + planId);
    pushLog(t, '   不要短时间内反复试，会触发限流。');
  }
}

async function doReanchor(t, p) {
  // 护栏：有成交直接拒
  const idx = indexOfItem(p.itemId);
  const blank = v => v === '' || v === undefined || v == null || v === '0';
  if (idx) {
    pushLog(t, '索引记录：' + idx.标题);
    pushLog(t, '成交 ' + (idx.成交 || 0) + ' 笔 / 支付额 ¥' + (idx.支付额 || 0) + ' / 曝光 ' + (idx.曝光 || '?'));
    if (Number(idx.成交) > 0 || Number(idx.支付额) > 0) {
      // ⚠️ 这不是"失败"，是护栏【正确拦截】。用 blocked 单独一档，
      //   否则界面显示「失败了 —— 把日志发给技术」，员工会以为系统坏了。
      t.status = 'blocked';
      pushLog(t, '\n⛔ 这条链接有成交，是主力，不能改。改了会丢权重，正文也找不回来。');
      pushLog(t, '   请换一条：已过场 + 零成交 + 没在投广告的链接。');
      return;
    }
    if (blank(idx.成交) && blank(idx.支付额) && blank(idx.曝光)) {
      pushLog(t, '\n⚠️ 查不到流量数据。若它正在出单，请立即停止。');
    }
  } else {
    pushLog(t, '⚠️ 索引里没有这条记录，查不到成交数据。若它正在出单，请立即停止。');
  }

  pushLog(t, '\n[1/2] 出主图…');
  const r1 = await runScript(t, 'publish-one.js',
    [p.city, p.star, p.session || '首开', '--dry', '--event=' + (p.event || '演唱会')]);
  const mm = r1.out.match(/图片:\s*(\S+\.jpg)/);
  if (!mm) { t.status = 'failed'; pushLog(t, '❗ 出图失败。' + (humanize(r1.out) || '把输出发给技术。')); return; }
  const img = path.join(ROOT, 'publish-out', path.basename(mm[1]));
  pushLog(t, '   主图：' + path.basename(img));

  // 标题：取店铺文案池里第一个"30 字整、不补！"的模板
  const os = require('os');
  const T = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.xianyu-templates.json'), 'utf8'));
  const POOL = ((T.storeTemplates || {})[STORE_NAME]) || T.templates.map(x => x.id);
  const fit = require(path.join(ROOT, 'lib', 'title')).makeFitTitle({
    pad: [' 全站全价位都可接', ' 全价位都能接', ' 高命中率', ' 全价位接', ' 可上号', ' 秒付前排', ' 稳中', ' 秒付', ' 包中'],
    max: 30, min: 30,
  });
  let pick = null;
  for (const tid of POOL) {
    const tp = T.templates.find(x => x.id === tid);
    if (!tp) continue;
    const raw = String(tp.titlePattern).replace(/\{明星\}/g, p.star).replace(/\{城市\}/g, p.city)
      .replace(/\{活动类型\}/g, p.event || '演唱会').replace(/\{场次类型\}/g, p.session || '首开');
    const r = fit.detail(raw);
    if (r.text.length === 30 && !r.how && !/！/.test(r.text)) { pick = { tp, title: r.text }; break; }
  }
  if (!pick) {
    const tp = T.templates.find(x => x.id === POOL[0]);
    pick = { tp, title: fit(String(tp.titlePattern).replace(/\{明星\}/g, p.star).replace(/\{城市\}/g, p.city)
      .replace(/\{活动类型\}/g, p.event || '演唱会').replace(/\{场次类型\}/g, p.session || '首开')) };
  }
  const descFile = path.join(ROOT, 'publish-out', '_ui-desc-' + p.itemId + '.txt');
  fs.writeFileSync(descFile, String(pick.tp.descPattern || ''), 'utf8');
  pushLog(t, '   标题：' + pick.title);

  // ⚠️【2026-11-12 加】改链接也要能先预览。
  //   原来这里硬编码 --go，一点就直接写线上 —— 和「① 发链接」「⑤ 配置新店」的设计不一致，
  //   而改链接是【破坏性最强】的动作（会覆盖标题/正文/主图/所在地），更该先给预览。
  //   dry 时不加 --go，apply-item 会打印"改前 → 改后"再退出，不写线上。
  const dry = !!p.dry;
  pushLog(t, '\n[2/2] ' + (dry ? '预览改动（不写线上）…' : '改链接（自动备份原内容）…'));
  const acArgs = [
    p.itemId, '--main=' + img, '--title=' + pick.title, '--descFile=' + descFile,
    '--addrCity=' + p.city, '--useStoreCat',
  ];
  if (!dry) acArgs.push('--go');
  const r2 = await runScript(t, 'tools/apply-item.js', acArgs);
  if (dry) {
    // 预览：apply-item 的预览总是退 0，且不含 SUCCESS（因为没写）
    t.status = 'preview';
    pushLog(t, '\n📋 这只是预览，线上一个字都没改。确认无误就去掉「只预览」再点一次。');
  } else if (r2.code === 0 && /SUCCESS/.test(r2.out)) {
    t.status = 'done';
    pushLog(t, '\n✅ 改好了。如果原来是下架的，平台会自动重新上架，等几分钟在 App 里看。');
  } else {
    t.status = 'failed';
    pushLog(t, '❗ 没改成。原内容已自动备份在 replace-backup/。' + (humanize(r2.out) || ''));
  }
}

// ── 业务：配置新店（把 store-wizard.js 接到网页上）──────────
// 员工/代理不用碰命令行，网页填完九个空就行。
// 向导本身是交互式的，这里把答案按顺序喂到它的 stdin（它支持管道预设答案）。
function doWizard(t, p) {
  const answers = [
    p.store,            // ① 店铺名
    p.price,            // ② 标价
    p.spec,             //    规格档位
    p.cat,              //    分类名
    p.style,            // ③ 主图风格
    p.tpl,              // ④ 版式
    p.tone,             // ⑤ 文案口味
    p.budget,           //    日预算
    p.bid,              //    出价
  ];
  return new Promise((resolve) => {
    pushLog(t, '$ store-wizard.js  ← 答案：' + answers.join(' / '));
    // 答案走【临时文件】。Windows 上中文既不能过 spawn 的 stdin（变 ??），
    // 也不能过命令行参数（同样变 ??，实测「向导接口测试店」→ 7 个问号）。
    // 文件是 UTF-8 明文，两个方向都不经过命令行编码转换。
    const ansFile = path.join(ROOT, 'publish-out', '_wizard-answers-' + t.id + '.json');
    fs.mkdirSync(path.dirname(ansFile), { recursive: true });
    fs.writeFileSync(ansFile, JSON.stringify(answers, null, 2), 'utf8');
    const wArgs = [path.join(ROOT, 'tools', 'store-wizard.js'), '--answersFile=' + ansFile];
    if (p.dry) { wArgs.push('--dry'); pushLog(t, '（只预览，不写档案）'); }
    const cp = spawn(NODE, wArgs, { cwd: ROOT, windowsHide: true });
    cp.stdout.on('data', d => pushLog(t, d.toString('utf8')));
    cp.stderr.on('data', d => pushLog(t, d.toString('utf8')));
    cp.on('error', e => { pushLog(t, '❗ 启动失败：' + e.message); t.status = 'failed'; resolve(); });
    cp.on('close', code => {
      t.status = code === 0 ? 'done' : 'failed';
      if (code !== 0) pushLog(t, '❗ 向导没走完（退出码 ' + code + '），看上面哪一步报错。');
      resolve();
    });
  });
}

// ── 业务：店铺切换与登录 ────────────────────────────────────
// 起因（2026-11-12）：老板问「在哪里登录超能水手代拍」，而网页上只有一行灰字写着当前店铺，
//   没有任何切换/登录入口 —— 代理根本不知道要去命令行敲 store-login。
//   这里把「看有哪些店 / 当前是哪个 / 换一个 / 登录它」搬进网页。
const agentMod = require(path.join(ROOT, 'lib', 'agent'));

async function listStores() {
  let accounts = [];
  try { accounts = await agentMod.accounts(); } catch (e) { accounts = []; }
  let activeName = '';
  let svcState = '';
  let svcUp = false;
  try {
    const s = await agentMod.status();
    const d = s.data || s;
    activeName = ((d.active || {}).name) || '';
    svcState = String(d.state || '');
    svcUp = !!d.running;
  } catch (e) { svcUp = false; }
  const seen = new Set();
  const stores = [];
  for (const a of accounts) {
    const n = String(a.name || '').trim();
    if (!n || seen.has(n)) continue;
    seen.add(n);
    stores.push({ name: n, username: String(a.username || '').trim(), active: n === activeName });
  }
  // ⚠️【2026-11-12 加】把 8093 的 state 一起返回。
  //   8093 空闲 20 分钟会把店铺上下文回收（active 变 null、state 变 idle），
  //   前端只看 active 会误判成「还没登录任何店铺」，害学员去重新扫码。
  return { active: activeName, stores, serviceUp: svcUp, serviceState: svcState };
}

// 登录是个长任务（要人在弹窗里扫码），进度靠日志轮询
function doLogin(t, p) {
  // ⚠️ 第二个参数是【整个 body 对象】，不是店名字符串。
  //   第一版写成 doLogin(t, name) 直接用，结果 store-login 收到的是 "[object Object]"
  //   （实测报「账号列表里没有「[object Object]」」）。这里显式取字段。
  const name = (p && (p.store || p.name)) || '';
  if (!name) { pushLog(t, '❗ 没给店铺名'); t.status = 'failed'; return Promise.resolve(); }
  return new Promise((resolve) => {
    pushLog(t, '$ store-login.js "' + name + '"  ← 会弹出该店专属的 Chrome 窗口');
    pushLog(t, '请在【那个窗口】里扫码 / 过滑块 / 输短信验证码。脚本每 15 秒复核一次。');
    const cp = spawn(NODE, [path.join(ROOT, 'tools', 'store-login.js'), name, '--wait=10'],
      { cwd: ROOT, windowsHide: true });
    cp.stdout.on('data', d => pushLog(t, d.toString('utf8')));
    cp.stderr.on('data', d => pushLog(t, d.toString('utf8')));
    cp.on('error', e => { pushLog(t, '❗ 启动失败：' + e.message); t.status = 'failed'; resolve(); });
    cp.on('close', code => {
      const ok = /已登录|登录成功|SUCCESS/.test(t.log.join('\n'));
      t.status = ok ? 'done' : (code === 0 ? 'done' : 'failed');
      if (!ok && code !== 0) pushLog(t, '❗ 没登上。看上面哪一步卡住（常见：没扫码 / 滑块没过 / 短信没输）。');
      resolve();
    });
  });
}

// ── HTTP ────────────────────────────────────────────────────
const htmlPath = path.join(__dirname, 'ui.html');
const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};
const readBody = (req) => new Promise((resolve) => {
  let b = '';
  req.on('data', c => { b += c; if (b.length > 1e6) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); } });
});

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const p = u.pathname;

  if (p === '/' || p === '/index.html') {
    // ⚠️【2026-11-12 修·性能】这里原来 `await listStores()` 才吐 HTML —— 那个调用要打
    //   8093 的 /api/agent/accounts + /api/agent/status，实测【首页响应 10.8 秒】。
    //   学员双击启动后白屏 11 秒，以为没反应、又点一次。
    //   现在：立即用启动时的 STORE_NAME 吐页面（毫秒级），前端 refreshStoreLabel() 异步纠正。
    //   代价是店铺名可能先显示启动值、1-3 秒后自动更新 —— 比白屏 11 秒好得多。
    //   （上一版之所以改成同步查，是为了修「切换店铺后顶部名字不更新」，
    //     但那个问题前端 refreshStoreLabel 已经解决了，服务端不必再查一次。）
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
    });
    return res.end(fs.readFileSync(htmlPath, 'utf8').replace(/\{\{STORE\}\}/g, STORE_NAME));
  }

  if (p === '/api/health') return json(res, 200, { ok: true, store: STORE_NAME, port: PORT });

  if (p === '/api/stores') {
    try { const d = await listStores(); return json(res, 200, d); }
    catch (e) { return json(res, 200, { active: '', stores: [], error: e.message }); }
  }

  // 某家店"配没配好"——给前端引导用（只读档案，不碰线上）
  if (p === '/api/store-detail') {
    const nm = (u.searchParams.get('name') || '').trim();
    if (!nm) return json(res, 200, { configured: false, error: '没给 name' });
    try {
      const profile = require(path.join(ROOT, 'lib', 'store-profile'));
      const s = profile.load(nm);
      const tpls = (s.主图 && s.主图.templates) || [];
      const hasBase = !!(s.主图 && s.主图.baseImg);
      const hasAd = !!(s.广告 && s.广告.enabled);
      return json(res, 200, {
        name: nm,
        configured: tpls.length > 0 && !!s.价格 && !!s.价格.default,
        templates: tpls, baseImg: hasBase, adEnabled: hasAd,
        userId: s.闲鱼userId || '',
        catName: (s.分类 && s.分类.catName) || '',
      });
    } catch (e) {
      return json(res, 200, { configured: false, error: e.message });
    }
  }

  if (p === '/api/onsale') {
    const t = newTask('onsale');
    // ⚠️【2026-11-12 修】原来无条件 t.status='done'，导致脚本挂了界面还显示绿色"完成"。
    //   实测遇到过 `Target page, context or browser has been closed`（8093 的页面被关），
    //   界面却打勾 —— 员工会以为查成功了。现在按退出码判。
    runScript(t, 'tools/list-onsale.js', []).then(r => {
      t.status = r.code === 0 ? 'done' : 'failed';
      t.out = r.out;
      if (r.code !== 0) pushLog(t, '❗ 没查成功。' + (humanize(r.out) || ''));
    });
    return json(res, 200, { taskId: t.id });
  }

  if (p === '/api/healthcheck') {
    // 学员装完点一下就知道"到底能不能用"。
    // healthcheck.js 是现成的整机体检（环境/服务/依赖/档案/推广/监控/安全，只读不写），
    // 但此前只有命令行入口 —— 学员不会敲，所以接到网页上来。
    const t = newTask('healthcheck');
    runScript(t, 'tools/healthcheck.js', ['--json'], 300000).then(r => {
      // 输出里可能混着日志行，从第一个 { 到最后一个 } 取 JSON
      const s = String(r.out || '');
      const i = s.indexOf('{'), j = s.lastIndexOf('}');
      try {
        t.result = JSON.parse(s.slice(i, j + 1));
        t.status = 'done';
      } catch (e) {
        t.status = 'failed';
        pushLog(t, '❗ 体检结果解析失败：' + (e.message || e));
        pushLog(t, s.slice(-600));
      }
    });
    return json(res, 200, { taskId: t.id });
  }

  if (p === '/api/warmup') {
    const t = newTask('warmup');
    runScript(t, 'tools/ensure-agent.js', []).then(r => {
      t.status = r.code === 0 ? 'done' : 'failed';
      if (r.code !== 0) pushLog(t, '❗ 预热没成功。' + (humanize(r.out) || ''));
    });
    return json(res, 200, { taskId: t.id });
  }

  if (p === '/api/action' && req.method === 'POST') {
    const body = await readBody(req);
    const kind = body.kind;
    const needed = { publish: ['city', 'star'], promote: ['itemId', 'city', 'star'], reanchor: ['itemId', 'city', 'star'], wizard: ['store'], login: ['store'] }[kind];
    if (!needed) return json(res, 400, { error: '未知动作' });
    for (const k of needed) if (!body[k]) return json(res, 400, { error: '缺少参数：' + k });
    if (['promote', 'reanchor'].includes(kind) && !/^\d+$/.test(String(body.itemId))) {
      return json(res, 400, { error: 'itemId 只能是一串数字' });
    }
    const t = newTask(kind);
    const fn = { publish: doPublish, promote: doPromote, reanchor: doReanchor, wizard: doWizard, login: doLogin }[kind];
    const payload = kind === 'login' ? Object.assign({}, body, { name: body.store }) : body;
    fn(t, payload).catch(e => { t.status = 'failed'; pushLog(t, '❗ 内部错误：' + (e && e.message || e)); });
    return json(res, 200, { taskId: t.id });
  }

  const mt = p.match(/^\/api\/task\/(\d+)$/);
  if (mt) {
    const t = TASKS.get(mt[1]);
    if (!t) return json(res, 404, { error: '任务不存在' });
    return json(res, 200, { id: t.id, kind: t.kind, status: t.status, log: t.log, out: t.out || '', result: t.result || null });
  }

  // 【第 233 轮】兜底 404 原来是英文 `not found` ——
  //   学员不会直接打这些地址，但【万一】前端哪天拼错路径，
  //   他看到的就是 `{"error":"not found"}`，完全看不懂发生了什么。
  //   全站唯一还在的英文报错，顺手改掉。
  json(res, 404, { error: '接口不存在：' + p });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  闲鱼上架助手已启动');
  console.log('  店铺：' + STORE_NAME);
  console.log('  请在浏览器打开：  http://127.0.0.1:' + PORT);
  console.log('');
  console.log('  （关掉这个窗口就停止服务）');
});
