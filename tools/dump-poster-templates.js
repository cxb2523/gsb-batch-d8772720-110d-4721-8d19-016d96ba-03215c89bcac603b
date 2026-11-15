/**
 * tools/dump-poster-templates.js — 列出主图模板及其文字层
 *
 * 用在排查「某个模板的字渲染不出来」这类问题：
 * 把每个模板里的文字字段原样打出来，看有没有空串、单字、缺字。
 *
 * 用法: node tools/dump-poster-templates.js [模板id]
 */
const out = require('../lib/out');
const http = require('../lib/http');

const WANT = process.argv[2] || '';

function textsOf(node, acc, path) {
  if (node === null || node === undefined) return acc;
  if (typeof node === 'string') {
    if (node.trim()) acc.push({ path, text: node });
    return acc;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => textsOf(v, acc, path + '[' + i + ']'));
    return acc;
  }
  if (typeof node === 'object') {
    Object.keys(node).forEach((k) => {
      const v = node[k];
      // 只挖可能装文字的字段，避免把坐标/颜色也当文字
      if (/text|content|label|title|value|char|word/i.test(k) && typeof v === 'string') {
        acc.push({ path: path + '.' + k, text: v });
      } else {
        textsOf(v, acc, path + '.' + k);
      }
    });
  }
  return acc;
}

(async () => {
  const r = await http.get('/api/poster/templates', { timeout: 60000 });
  const items = (r && (r.items || r.data)) || [];
  if (!Array.isArray(items) || !items.length) { out.bad('拿不到模板列表：' + JSON.stringify(r).slice(0, 200)); out.done(2); }

  out.head('主图模板');
  out.kv('数量', items.length);
  out.table(['id', '名称', '文字层数'],
    items.map((t) => {
      const acc = textsOf(t.layers || t, [], '');
      return [t.id, String(t.name || t.label || ''), acc.length];
    }), { maxCol: [22, 24, 8] });

  const list = WANT ? items.filter((t) => String(t.id).indexOf(WANT) >= 0) : items;
  list.forEach((t) => {
    const acc = textsOf(t.layers || t, [], '');
    out.head('模板 ' + t.id + (t.name ? ' · ' + t.name : ''));
    if (!acc.length) { out.warn('  没有任何文字层'); return; }
    acc.forEach((a) => {
      const flag = a.text.trim().length <= 1 ? '  ⚠️ 只有一个字' : '';
      out.plain('  [' + a.text.length + '字] ' + JSON.stringify(a.text) + flag);
      out.plain('        ' + a.path);
    });
  });
  out.done(0);
})().catch((e) => out.fail(e));
