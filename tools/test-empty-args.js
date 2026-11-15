/**
 * 一次性验证：模拟 publish-group.js 的 spawn 方式，确认「显式空值」真的被尊重。
 * 为什么不能用 PowerShell 直接测：
 *   · PowerShell 里 $env:X='' 会【删除】变量，不是设成空串 → 测不出"显式空"
 *   · 空串参数 '' 会被 PowerShell 丢掉 → argv 位置整体前移（上次"拱墅区"跑到 session 就是这原因）
 * 所以必须用 Node 的 execFileSync 复刻真实调用。
 */
const { execFileSync } = require('child_process');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'publish-one.js');

function run(label, ev, sess, tplId) {
  const env = Object.assign({}, process.env, {
    KUN_EVENT: ev,                 // 关键：显式 '' 而非 undefined
    KUN_PRICE: '50',
    KUN_TITLE_TPL_ID: String(tplId),
    KUN_MAIN_TPL: 'xuliang-v1',
    KUN_BASE_IMG: path.join(ROOT, 'publish-assets', '中国舞蹈年度大赏-底图.jpg'),
  });
  let out = '';
  try {
    out = execFileSync(process.execPath, [PUB, '杭州', '中国舞蹈年度大赏', sess, '拱墅区', '--dry'],
      { encoding: 'utf8', env, timeout: 300000, maxBuffer: 8 * 1024 * 1024 });
  } catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); }
  const m = out.match(/标题\(\d+\): "([^"]+)"/);
  console.log('  ' + label.padEnd(30) + ' → ' + (m ? m[1] : '(没抓到标题)'));
}

console.log('期望：显式空值 → 标题干净，不含「演唱会」「首开」');
run('KUN_EVENT="" session=""', '', '', 1);
run('KUN_EVENT="" session=""', '', '', 2);
console.log('');
console.log('对照（老行为，应当保留默认）：');
run('KUN_EVENT="大师赛" session="二开"', '大师赛', '二开', 1);
