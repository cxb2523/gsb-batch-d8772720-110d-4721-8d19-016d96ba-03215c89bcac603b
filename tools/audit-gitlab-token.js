/**
 * tools/audit-gitlab-token.js — 安全审计：确认本机 GitLab 凭据的形态与有效性
 *
 * ⚠️ 本脚本【绝不打印 token 明文】，只输出：形态判定 / HTTP 状态 / 账号名 / scopes / 过期日。
 * 用法: node tools/audit-gitlab-token.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const CRED = path.join(os.homedir(), '.git-credentials');

function mask(t) {
  if (!t) return '(空)';
  if (t.length <= 10) return '***';
  return t.slice(0, 6) + '…' + t.slice(-4) + ' (len=' + t.length + ')';
}

function api(p, token, authScheme) {
  return new Promise((resolve) => {
    const headers = { 'User-Agent': 'dsh-audit' };
    if (authScheme === 'bearer') headers['Authorization'] = 'Bearer ' + token;
    else headers['PRIVATE-TOKEN'] = token;
    const req = https.request({ host: 'gitlab.com', path: p, method: 'GET', headers, timeout: 20000 }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
    req.end();
  });
}

(async () => {
  if (!fs.existsSync(CRED)) { console.log('~/.git-credentials 不存在 → 本机没有存量凭据'); return; }
  const lines = fs.readFileSync(CRED, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  console.log('~/.git-credentials 行数: ' + lines.length);

  for (const line of lines) {
    const m = line.match(/^(\w+):\/\/([^:]*):([^@]*)@(.+)$/);
    if (!m) { console.log('  无法解析的行（已跳过）'); continue; }
    const [, scheme, user, pass, host] = m;
    console.log('\n── ' + host + '  (' + scheme + ')');
    console.log('   username = ' + mask(user));
    console.log('   password = ' + mask(pass));
    console.log('   username 是 glpat 形态? ' + /^glpat-/.test(user));
    console.log('   password 是 glpat 形态? ' + /^glpat-/.test(pass));

    if (host.indexOf('gitlab.com') < 0) { console.log('   (非 gitlab.com，跳过网络验证)'); continue; }

    // 依次尝试两种认证方式（PAT 用 PRIVATE-TOKEN；若 username 是 glpat 则它才是 token）
    const cands = [];
    if (/^glpat-/.test(pass)) cands.push({ label: 'PRIVATE-TOKEN=password', token: pass, scheme: 'header' });
    if (/^glpat-/.test(user)) cands.push({ label: 'PRIVATE-TOKEN=username', token: user, scheme: 'header' });
    if (/^glpat-/.test(pass)) cands.push({ label: 'Bearer=password', token: pass, scheme: 'bearer' });
    if (!cands.length) { console.log('   ⚠ 不是 glpat- 形态（可能是账号密码或其它 token 类型）'); }

    for (const c of cands) {
      const r = await api('/api/v4/user', c.token, c.scheme);
      console.log('   试 ' + c.label + ' → HTTP ' + r.status);
      if (r.status === 200) {
        let u = {}; try { u = JSON.parse(r.body); } catch (e) {}
        console.log('      ✅ 有效！账号 = ' + u.username + '  (' + u.name + ')  id=' + u.id);
        const s = await api('/api/v4/personal_access_tokens/self', c.token, c.scheme);
        if (s.status === 200) {
          let t = {}; try { t = JSON.parse(s.body); } catch (e) {}
          console.log('      token 名=' + t.name + '  scopes=' + JSON.stringify(t.scopes) + '  过期=' + (t.expires_at || '永不过期'));
          console.log('      最后使用=' + (t.last_used_at || '从未'));
        } else {
          console.log('      (查 token 元信息失败 HTTP ' + s.status + '，可能已被撤销或无 api scope)');
        }
      } else if (r.status === 401) {
        console.log('      ❌ 401 无效/已撤销');
      } else {
        console.log('      ? ' + String(r.body).slice(0, 120));
      }
    }
  }
})();
