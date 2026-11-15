/**
 * lib/title.js —— 标题长度规则 + fitTitle 的【唯一实现】（发布链共用）
 *
 * 为什么单独抽出来（2026-10-11，老板点名修）：
 *   闲鱼标题的【硬上限是 30 字】，超出部分由平台【从尾部静默砍掉】——
 *   我们这边发出去的时候看不见，只有发布后的回读才会报 `❌ 标题`。
 *   而仓库里 publish-one.js / tools/publish-group.js / 桌面 publish.js
 *   一直写的是 TITLE_MAX = 40，所以「40 以内都合法」这个前提是错的。
 *
 * 实测证据（2026-10-11，用 mtop.idle.pc.idleitem.editdetail 读闲鱼侧【实存】标题）：
 *   发出 36 字 → 实存 30（【代拍必中】孙燕姿杭州站演唱会回流捡漏接代拍回流捡漏代抢孙燕）
 *   发出 38 字 → 实存 30（【代拍必中】周诗雨&王奕成都站音乐会首开接代拍首开代抢周诗雨）
 *   发出 33 字 → 实存 30（【高命中代拍】王者荣耀深圳站周年庆嘉年华暨KPL奇妙日门票代）
 *   发出 31 字 → 实存 30（【稳中代拍】澳门JX金在中&金俊秀演唱会首开代拍 （可看评价）
 *   发出 30 字 → 实存 30 ✅ 完整
 * 也就是说：历史上一批链接的标题尾部早就被砍过 —— 名字砍一半（…代抢周诗雨）、
 * 词砍一半（…门票代）、括号没闭合（…（可看评价）。没人发现，是因为只对比了「我们发出的」。
 *
 * 规则（makeFitTitle 返回的 fitTitle 里实现）：
 *   ① max 永远不超过 PLATFORM_TITLE_MAX —— 这是平台约束，不是可配置项；
 *      档案里写 40 也会被压回 30（仍允许档案配更小的值）。
 *   ② 超长先做「语义不变」的瘦身：去空白 → 去掉尾部「（可看评价）」整块；
 *      实在收不进才截断，且截断后保证括号闭合，不把词/括号砍成两半。
 *   ③ 不足 min 时按 pad 补足（老行为，理由见 publish-one.js 里那段注释：
 *      卡片标题 = (标题+"\n\n"+正文) 前 30 字，标题不足 30 会让正文渗进卡片标题）。
 *
 * ⚠️ 桌面引擎 C:\Users\43462\Desktop\xianyu-monitor\publish.js 里有一份手抄的
 *    TITLE_MAX = 40 + fitTitle。那是【工程】领地的文件，本仓库改不到它 ——
 *    两边必须同改，否则同一个场次两个系统发出来的标题长度不一致。
 *    校验脚本：test-publishjs-fittitle.js / verify-fittitle.js。
 */

const PLATFORM_TITLE_MAX = 30;   // 闲鱼硬上限（实测，别改成更大的值）

/** 中英文成对括号，截断后用来修「开了没闭」 */
const PAIRS = [['【', '】'], ['（', '）'], ['《', '》'], ['〈', '〉'], ['(', ')'], ['[', ']'], ['{', '}']];

/**
 * 把截断后「开了没闭」的括号连同它后面残留的内容一起丢掉。
 * 例：'…首开代拍 （可看评价' → '…首开代拍 '（去掉未闭合的「（」及其后内容）
 */
function closeBrackets(s) {
  let out = String(s == null ? '' : s);
  for (const [open, close] of PAIRS) {
    const nOpen = out.split(open).length - 1;
    const nClose = out.split(close).length - 1;
    if (nOpen > nClose) out = out.slice(0, out.lastIndexOf(open));
  }
  return out;
}

/**
 * 超长瘦身：尽量在不丢关键字的前提下收进 max。
 * 返回 { text, how }，how 用来告诉我们「是靠什么收进去的」（打印日志用）。
 */
function squeezeTitle(t, max) {
  const src = String(t == null ? '' : t);
  // 【2026-11-13】max 不传时原来是 undefined，日志会打出「硬截断到 undefined 字」。
  //   这不是正常调用路径（发布链都传了），但一旦有人漏传，那句日志会让人以为代码坏了。
  const cap = Math.min(Number(max) || PLATFORM_TITLE_MAX, PLATFORM_TITLE_MAX);
  if (src.length <= cap) return { text: src, how: '' };

  const noSpace = src.replace(/\s+/g, '');
  if (noSpace.length <= cap) return { text: noSpace, how: '去掉空白' };

  // 「（可看评价）」是模板固定尾巴，去空格后再去它
  const tail = noSpace.replace(/[（(]可看评价[）)]$/, '');
  if (tail.length <= cap) return { text: tail, how: '去掉「（可看评价）」尾巴' };

  // 实在收不进：在「去空白」版上硬截断，并保证括号闭合（宁可短，也不要「名字砍一半」）
  return { text: closeBrackets(noSpace.slice(0, cap)), how: '硬截断到 ' + cap + ' 字（已修括号）' };
}

/**
 * 造一个 fitTitle。参数：
 *   pad —— 补足用的候选短语数组（各脚本自己从 publish-one.js 抠，保持同源）
 *   max —— 期望上限（会被 PLATFORM_TITLE_MAX 压住）
 *   min —— 补足下限
 */
function makeFitTitle(opts) {
  opts = opts || {};
  const pad = opts.pad || [];
  const max = Math.min(Number(opts.max) || PLATFORM_TITLE_MAX, PLATFORM_TITLE_MAX);
  const min = Math.min(Number(opts.min) || max, max);

  function fitTitle(t) {
    let s = String(t == null ? '' : t);
    let how = '';
    // 【2026-11-13】空标题【不补足】。
    //   原来 s 为空时会走下面的补足逻辑：pad 补一个「（可看评价）」再拿「！」填到 min，
    //   结果发出来是「（可看评价）！！！！！！！！！！！！！！！！！！！！」这样一屏感叹号。
    //   空标题是上游没生成出来，应该让它空着暴露问题，而不是用感叹号糊过去。
    if (!s.trim()) return { text: '', how: '输入为空，不补足' };
    if (s.length > max) { const r = squeezeTitle(s, max); s = r.text; how = r.how; }
    if (s.length < min) {
      const gap = min - s.length;
      let best = '';
      for (const f of pad) if (f.length <= gap && f.length > best.length) best = f;
      s += best;
      while (s.length < min) s += '！';
    }
    return { text: s, how };
  }

  // 兼容老调用：默认直接返回字符串（大多数脚本就是这么用的）
  const fn = (t) => fitTitle(t).text;
  fn.detail = fitTitle;      // 需要「有没有被砍/怎么砍的」时用它
  fn.max = max;
  fn.min = min;
  return fn;
}

module.exports = { PLATFORM_TITLE_MAX, PAIRS, closeBrackets, squeezeTitle, makeFitTitle };
