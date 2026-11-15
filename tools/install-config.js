/**
 * tools/install-config.js — 把「这台机器的配置」写出来（安装器调用；也能单独跑）
 *
 * 为什么用 Node 而不是 PowerShell 写 JSON：
 *   PS 5.1 的 `Set-Content -Encoding UTF8` 会写 BOM，而 `.json` 带 BOM 会让 `JSON.parse` 直接抛
 *   Unexpected token（这个坑本仓踩过：服务端版式库整个读空）。Node 侧统一 UTF-8 无 BOM、2 空格缩进。
 *
 * 优先级设计（新机器零配置也能跑）：
 *   本机推导（paths / node）> 中台下发（middle / service / wecom / 学员身份 / 账号）> 仓库默认
 *   **已有非空值默认不覆盖** —— 重装/升级不能把老板手工填的东西冲掉，要覆盖必须显式 --force。
 *
 * 用法:
 *   node tools/install-config.js --show                        # 打印当前生效配置（密钥脱敏）
 *   node tools/install-config.js --derive                      # 只推导本机项（预览）
 *   node tools/install-config.js --from=<中台响应.json> --apply
 *   node tools/install-config.js --set=paths.images=D:/pics --apply
 *   node tools/install-config.js --derive --apply --force      # 覆盖已有值
 *
 * 退出码：0 成功（含"有缺失项但已装好骨架"）；1 = 参数错 / 写盘失败
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ROOT, PATHS, NODE } = require('../lib/env');

const A = process.argv.slice(2);
const on = (k) => A.includes('--' + k);
const opt = (k, d) => { const a = A.find((x) => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };

const APPLY = on('apply');
const FORCE = on('force');
const CFG_LOCAL = path.join(ROOT, 'config.local.json');
const CFG_SHIPPED = path.join(ROOT, 'lib', 'config.json');
// 8093 服务端内置的排除项（配了也不会出现），别拿来当店铺名
const BLOCKED_STORE_NAMES = ['湖畔暴富的蓝环章鱼', '追梦的镇宇', 'casa家居'];

function readJSON(file, dflt) {
  try {
    let s = fs.readFileSync(file, 'utf8');
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);   // 本仓大量文件带 BOM
    return JSON.parse(s);
  } catch (e) { return dflt; }
}
function writeJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak_' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14));
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');   // 无 BOM
}
function at(o, p) { let c = o; for (const k of String(p).split('.')) { if (c == null || typeof c !== 'object') return undefined; c = c[k]; } return c; }
function setAt(o, p, v) {
  const ks = String(p).split('.'); let c = o;
  for (let i = 0; i < ks.length - 1; i++) { if (c[ks[i]] == null || typeof c[ks[i]] !== 'object') c[ks[i]] = {}; c = c[ks[i]]; }
  c[ks[ks.length - 1]] = v;
}
const mask = (s) => (!s ? s : (String(s).length <= 8 ? '****' : String(s).slice(0, 5) + '****' + String(s).slice(-3)));

// ── 1. 本机可推导的部分 ──
function deriveMachine() {
  const parent = path.dirname(ROOT);
  const guess = (cands) => { for (const c of cands) { try { if (c && fs.existsSync(c)) return c.replace(/\\/g, '/'); } catch (e) { /* next */ } } return ''; };
  // machine.id —— 本机身份，用来强制「一个闲鱼账号只能一台机器操作」那条红线。
  // ⚠️ 生成一次就【永不改】：店铺档案的 ownerMachine 记的就是它，
  //   换掉等于所有店立刻变成"归别的机器"，自己的店会被 lib/agent.js 拒绝启动。
  //   所以只在为空时生成；已有值一律原样保留（也靠上层的"非空不覆盖"兜一层）。
  let mid = '';
  try { mid = String(((readJSON(CFG_LOCAL, {}) || {}).machine || {}).id || '').trim(); } catch (e) { mid = ''; }
  if (!mid) mid = 'mch-' + require('crypto').randomBytes(6).toString('hex');
  return {
    'paths.work': ROOT.replace(/\\/g, '/'),
    'paths.playwrightService': PATHS.playwrightService || guess([
      path.join(parent, 'playwright-service'), path.join(parent, 'xianyu-playwright-service'),
      path.join(os.homedir(), '.kun', 'default_workspace', 'playwright-service')]),
    'paths.xianyuMonitor': PATHS.xianyuMonitor || guess([
      path.join(parent, 'xianyu-monitor'), path.join(os.homedir(), 'Desktop', 'xianyu-monitor')]),
    'paths.images': PATHS.images || guess([path.join(os.homedir(), 'Desktop', '闲鱼上架图片')]),
    'node.path': (NODE.path || process.execPath).replace(/\\/g, '/'),
    'machine.id': mid,
  };
}

// ── 2. 中台响应 → 本机配置的映射 ──
// 响应格式见 中台需求-xianyu-install-config.md
function mapFromRemote(r) {
  const out = { cfg: {}, serviceLocal: {}, warnings: [] };
  if (!r || r.ok !== true) { out.warnings.push('中台响应 ok!=true，按"什么都不下发"处理'); return out; }
  const S = r.student || {};
  if (S.name || S.id) out.cfg.student = { id: S.id || '', name: S.name || '', role: S.role || '' };
  if (S.wecomChatId) out.cfg['wecom.chatId'] = S.wecomChatId;
  for (const k of ['base', 'tenant', 'key']) if ((r.middle || {})[k]) out.cfg['middle.' + k] = r.middle[k];
  for (const k of ['host', 'port', 'apiKey']) if ((r.service || {})[k] !== undefined) out.cfg['service.' + k] = r.service[k];
  if (r.stores && (r.stores.default || (r.stores.active || []).length)) out.store = r.stores;
  const ov = r.overrides || {};
  for (const k of ['thresholds', 'rules', 'urls']) if (ov[k] && Object.keys(ov[k]).length) out.cfg[k] = ov[k];
  if (Array.isArray(r.accounts) && r.accounts.length) {
    // 账号属于【8093 服务】那一侧，写进它的 service.local.json；
    // 服务读到 localAccounts 就【不再去问远程】—— 否则学员会看到老板的全量店铺。
    out.serviceLocal.localAccounts = r.accounts.map((a) => ({ id: a.id, name: a.name }));
  }
  if (r.expiresAt) out.expiresAt = r.expiresAt;
  return out;
}

// ── 3. 合并（已有非空值默认不覆盖）──
function mergeInto(target, changes, force, log) {
  for (const k of Object.keys(changes)) {
    const cur = at(target, k);
    const next = changes[k];
    const curEmpty = cur === undefined || cur === null || cur === '' ||
      (typeof cur === 'object' && !Array.isArray(cur) && !Object.keys(cur).length) ||
      (Array.isArray(cur) && !cur.length);
    if (!curEmpty && !force) {
      if (JSON.stringify(cur) !== JSON.stringify(next)) log.kept.push(k + '（保留本机值 ' + JSON.stringify(cur).slice(0, 40) + '）');
      continue;
    }
    if (JSON.stringify(cur) === JSON.stringify(next)) continue;
    setAt(target, k, next);
    log.set.push(k + ' = ' + JSON.stringify(next).slice(0, 60));
  }
}

(async () => {
  if (!A.length || on('help')) {
    console.log('用法:');
    console.log('  node tools/install-config.js --show');
    console.log('  node tools/install-config.js --derive [--apply] [--force]');
    console.log('  node tools/install-config.js --from=<中台响应.json> --apply');
    console.log('  node tools/install-config.js --set=paths.images=D:/pics --apply');
    return;
  }

  const cur = readJSON(CFG_LOCAL, {}) || {};

  if (on('show')) {
    console.log('── config.local.json 生效值 ──');
    console.log(JSON.stringify({
      paths: cur.paths, node: { path: cur.node && cur.node.path },
      service: { host: cur.service && cur.service.host, port: cur.service && cur.service.port, apiKey: mask(cur.service && cur.service.apiKey) },
      middle: { base: cur.middle && cur.middle.base, tenant: cur.middle && cur.middle.tenant, key: mask(cur.middle && cur.middle.key) },
      wecom: { chatId: mask(cur.wecom && cur.wecom.chatId) },
      student: cur.student, store: cur.store,
    }, null, 2));
    console.log('\n── 服务侧（playwright-service/service.local.json）──');
    const sp = path.join(PATHS.playwrightService || '', 'service.local.json');
    const sc = readJSON(sp, null);
    if (sc) {
      console.log('  ' + sp);
      console.log('  apiKey=' + mask(sc.apiKey) + '  localAccounts=' + ((sc.localAccounts || []).length) + ' 个');
    } else console.log('  （读不到：paths.playwrightService=' + (PATHS.playwrightService || '(未配置)') + '）');
    return;
  }

  const changes = {};
  const log = { set: [], kept: [] };
  const missing = [];

  if (on('derive') || !opt('from', '')) {
    const d = deriveMachine();
    for (const k of Object.keys(d)) {
      if (!d[k]) { missing.push(k); continue; }
      changes[k] = d[k];
    }
  }

  // ── 学员的店铺名：从本机 service.local.json 推出来 ──────────────
  // ⚠️【2026-11-13 修·硬阻塞】lib/config.json 里 store.default / store.active 写死的是
  //   老板的「好易美代拍」。原来只有【中台下发 stores】那条路才会改写它们，
  //   而 --InstallCode 那条路按文档是【未完成】的（中台接口没建好）。
  //   于是学员走解压安装时：store.active 留着「好易美代拍」→ agent.ready() 去启动
  //   一个他机器上根本不存在的店 → 网页顶部也显示别人店名。
  //   这里补上：没有中台下发时，用 service.local.json 里学员自己的店名覆盖。
  const deriveOwnStore = () => {
    if (on('keep-store')) return null;
    const sp = PATHS.playwrightService ? path.join(PATHS.playwrightService, 'service.local.json') : '';
    if (!sp || !fs.existsSync(sp)) return null;
    const sc = readJSON(sp, null);
    const first = sc && Array.isArray(sc.localAccounts) && sc.localAccounts[0];
    const nm = first && String(first.name || '').trim();
    if (!nm) return null;
    if (/^<.*>$/.test(nm)) return null;                    // 还是占位符，没填
    if (BLOCKED_STORE_NAMES.indexOf(nm) >= 0) return null; // 服务端内置排除项
    return nm;
  };

  const from = opt('from', '');
  let remote = null;
  if (from) {
    remote = readJSON(from, null);
    if (!remote) { console.log('❌ --from 的文件读不了或不是 JSON：' + from); process.exit(1); }
    const m = mapFromRemote(remote);
    m.warnings.forEach((w) => console.log('⚠️ ' + w));
    Object.assign(changes, m.cfg);
    if (m.serviceLocal.localAccounts) {
      const sp = path.join(PATHS.playwrightService || '', 'service.local.json');
      if (!PATHS.playwrightService) missing.push('paths.playwrightService（写不了服务侧账号表）');
      else {
        const sc = readJSON(sp, {}) || {};
        if (!(sc.localAccounts || []).length || FORCE) sc.localAccounts = m.serviceLocal.localAccounts;
        else log.kept.push('service.local.json.localAccounts（保留本机 ' + sc.localAccounts.length + ' 个）');
        if (APPLY) writeJSON(sp, sc);
        else console.log('  [预览] 会写 ' + sp + ' 的 localAccounts（' + m.serviceLocal.localAccounts.length + ' 个）');
      }
    }
  }

  // --set 是【显式指令】，所以它总是生效（不受"已有非空值不覆盖"保护）。
  // 保护规则是给"重新安装不能冲掉手工配置"用的，不适用于人当场敲的值。
  const sets = {};
  for (const s of A.filter((x) => x.startsWith('--set='))) {
    const kv = s.slice(6); const i = kv.indexOf('=');
    if (i <= 0) { console.log('❌ --set 要写成 --set=路径=值，收到：' + s); process.exit(1); }
    sets[kv.slice(0, i)] = /^\d+$/.test(kv.slice(i + 1)) ? Number(kv.slice(i + 1)) : kv.slice(i + 1);
  }

  mergeInto(cur, changes, FORCE, log);
  for (const k of Object.keys(sets)) { setAt(cur, k, sets[k]); log.set.push(k + ' = ' + JSON.stringify(sets[k]) + '（--set）'); }

  // store 要写进 lib/config.json（env.js 故意不让本机文件盖 store，见那里的注释）。
  //
  // ⚠️ default 和 active 必须【成组】生效。第一版把 default 交给"非空不覆盖"保护、
  //    却直接替换了 active，结果出现 default=好易美代拍 / active=[好易美票务Hope] 这种
  //    自相矛盾的状态（默认店不在常驻店里）。
  //    这里从宽：中台下发的店铺是【指派】而不是手工调的值，所以默认直接覆盖；
  //    想保留本地设置就加 --keep-store。
  let shipped = null;

  // 本机自我推导：没有中台下发时，用 service.local.json 里学员自己的店名
  // 覆盖 lib/config.json 里写死的「好易美代拍」。否则学员的 agent 会去启动别人的店。
  {
    const ownStore = deriveOwnStore();
    if (ownStore) {
      shipped = readJSON(CFG_SHIPPED, null);
      if (shipped) {
        shipped.store = shipped.store || {};
        const wantActive = [ownStore];
        const changedOwn = shipped.store.default !== ownStore ||
          JSON.stringify(shipped.store.active || []) !== JSON.stringify(wantActive);
        if (changedOwn) {
          shipped.store.default = ownStore;
          shipped.store.active = wantActive;
          shipped.store.all = (shipped.store.all || []).indexOf(ownStore) < 0
            ? (shipped.store.all || []).concat([ownStore]) : shipped.store.all;
          log.set.push('lib/config.json: store.default = ' + ownStore +
            ', store.active = ' + JSON.stringify(wantActive) + '（按本机 service.local.json 推导）');
          console.log('  店铺：' + ownStore + '（从 service.local.json 读到，已设为默认+活跃）');
        } else {
          log.kept.push('lib/config.json 的 store（已是 ' + ownStore + '）');
        }
      }
    }
  }
  if (remote && remote.stores) {
    shipped = readJSON(CFG_SHIPPED, null);
    if (!shipped) console.log('⚠️ lib/config.json 读不了，跳过 store 下发');
    else {
      shipped.store = shipped.store || {};
      const want = remote.stores;
      const before = JSON.stringify({ d: shipped.store.default, a: shipped.store.active });
      if (!on('keep-store') && (want.default || (want.active || []).length)) {
        if (want.default) shipped.store.default = want.default;
        // 只给了 default 没给 active 时，active 也跟上一个店 —— 别留一个空/过期的 active
        shipped.store.active = (Array.isArray(want.active) && want.active.length)
          ? want.active.slice()
          : (shipped.store.default ? [shipped.store.default] : shipped.store.active);
        const after = JSON.stringify({ d: shipped.store.default, a: shipped.store.active });
        if (before !== after) log.set.push('lib/config.json: store.default = ' + shipped.store.default +
          ', store.active = ' + JSON.stringify(shipped.store.active));
      } else if (on('keep-store')) {
        log.kept.push('lib/config.json 的 store（--keep-store）');
      }
      if (Array.isArray(remote.accounts)) {
        for (const a of remote.accounts) {
          shipped.store.all = shipped.store.all || [];
          if (shipped.store.all.indexOf(a.name) < 0) shipped.store.all.push(a.name);
        }
      }
      // ⚠️ 【2026-10-09 修】default / active 必须【无条件】补进 all。
      //   原来补 all 只在 `Array.isArray(remote.accounts)` 成立时才做 ——
      //   中台只下发 stores 没下发 accounts 时，default/active 会指向一个不在名册里的店，
      //   于是 tools/selftest-lib.js 的「active 是名册子集」断言失败 →
      //   tools/update.js 的自检不过 → **每次更新都回滚**，学员机永远更不了。
      //   agent.ready() 也会因为这个不一致拒绝启动。
      shipped.store.all = shipped.store.all || [];
      const must = (shipped.store.active || []).concat(shipped.store.default ? [shipped.store.default] : []);
      must.forEach((n) => { if (n && shipped.store.all.indexOf(n) < 0) { shipped.store.all.push(n); log.set.push('lib/config.json: store.all 补上 ' + n); } });
    }
  }

  console.log('\n── 将要写入 ──');
  if (!log.set.length) console.log('  （config.local.json 没有要改的）');
  for (const s of log.set) console.log('  ✅ ' + s);
  if (log.kept.length) { console.log('  ── 保护住没动的（要覆盖加 --force）──'); for (const s of log.kept) console.log('  ⛔ ' + s); }
  if (missing.length) { console.log('  ── 推导不到的（需要人给）──'); for (const s of missing) console.log('  ⚠️ ' + s); }
  if (shipped) console.log('  ✅ lib/config.json 的 store（default=' + shipped.store.default + ' active=' + JSON.stringify(shipped.store.active) + '）');

  if (!APPLY) { console.log('\n📋 预览，没有写盘。加 --apply 生效'); return; }

  writeJSON(CFG_LOCAL, cur);
  if (shipped) writeJSON(CFG_SHIPPED, shipped);
  console.log('\n✅ 已写入 ' + CFG_LOCAL + (shipped ? ' 和 ' + CFG_SHIPPED : ''));
  if (missing.length) console.log('⚠️ 还有 ' + missing.length + ' 项没配（上面列了）—— 骨架已装好，补齐后重跑本命令');
})().catch((e) => { console.log('❌ ' + ((e && e.stack) || e)); process.exit(1); });
