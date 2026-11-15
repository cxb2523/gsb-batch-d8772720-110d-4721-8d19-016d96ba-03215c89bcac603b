/**
 * lib/args.js — 极简参数解析
 *
 * Node 是 UTF-8 原生，中文参数从 argv 进来不会像 PowerShell 那样被拆坏；
 * 但仍然建议长文本（文案、标题）走 UTF-8 文件，命令行只传文件名。
 *
 * 用法：
 *   const { parse, need } = require('./lib/args');
 *   const a = parse();                       // node x.js 广州 宋雨琦 --n=3 --dry
 *   a._        → ['广州','宋雨琦']           // 位置参数
 *   a.n        → '3'   a.dry → true
 */
/**
 * 收集【可重复】的键。parse() 是「后一个覆盖前一个」，批量操作要的是全部：
 *   --set a=1 --set b=2 --where "p=1" --where "q=2"
 *   collect → ['a=1','b=2'] / ['p=1','q=2']
 * 与 parse 一样同时支持 `--k=v` 和 `--k v` 两种写法。
 */
function collect(argv, key) {
  argv = argv || process.argv.slice(2);
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i];
    if (s === '--' + key) {
      const next = argv[i + 1];
      if (next !== undefined && next.slice(0, 2) !== '--') { out.push(next); i++; }
    } else if (s.slice(0, key.length + 3) === '--' + key + '=') {
      out.push(s.slice(key.length + 3));
    }
  }
  return out;
}

function parse(argv) {
  argv = argv || process.argv.slice(2);
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i];
    if (s === '--') { out._.push(...argv.slice(i + 1)); break; }
    if (s.startsWith('--')) {
      const eq = s.indexOf('=');
      if (eq > 0) {
        out[s.slice(2, eq)] = s.slice(eq + 1);
      } else {
        const k = s.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) { out[k] = next; i++; }
        else out[k] = true;
      }
    } else if (s.startsWith('-') && s.length === 2) {
      out[s.slice(1)] = true;
    } else {
      out._.push(s);
    }
  }
  out.has = (k) => Object.prototype.hasOwnProperty.call(out, k);
  /** 开关判定：--dry 与 --dry=true / --dry=1 都算开 */
  out.on = (k) => out[k] === true || out[k] === 'true' || out[k] === '1';
  /** 取某个可重复键的全部值：a.allOf('set') → ['a=1','b=2'] */
  out.allOf = (k) => collect(argv, k);
  return out;
}

/** 取必需位置参数，缺了就打印用法并退出 */
function need(a, idx, label, usage) {
  const v = a._[idx];
  if (v === undefined || v === '') {
    process.stderr.write('缺少参数：' + label + '\n用法: ' + (usage || '') + '\n');
    process.exit(2);
  }
  return v;
}

module.exports = { parse, need, collect };
