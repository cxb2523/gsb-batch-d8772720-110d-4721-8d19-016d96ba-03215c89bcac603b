/*
 * DownloadInspector — 下载区入口巡检模块（页面内可调用，同时兼容 Node.js）
 *
 * 用法（浏览器，index.html 已通过 <script src="download-inspector.js" defer> 加载）：
 *   const report = await DownloadInspector.inspect({ timeoutMs: 10000 });
 *   console.table(report.results);
 *
 * 用法（Node.js，用于本地样例验证）：
 *   const DownloadInspector = require('./download-inspector.js');
 *   const report = await DownloadInspector.inspect({ html, baseUrl, timeoutMs: 1500 });
 *
 * 报告结构（字段稳定、顺序与页面卡片顺序一致，重复巡检输出顺序不变）：
 *   {
 *     results: [
 *       {
 *         index,            // 卡片在下载区中的序号（从 0 开始）
 *         title,            // 卡片标题
 *         url,              // 原始链接地址（无链接卡片为 null）
 *         labeledPlatform,  // 卡片标题标注的平台：windows/macos/linux/snap/unknown
 *         entryKind,        // platform-file | non-platform | no-link
 *         outcome,          // ok | platform-mismatch | unreachable | no-link
 *         reason,           // 文字说明（含超时 / 重定向 / 非 2xx 的具体归类原因）
 *         httpStatus,       // 最终 HTTP 状态码（无响应为 null）
 *         redirected,       // 是否发生重定向
 *         finalUrl,         // 重定向后的最终落点（无重定向时等于 url）
 *         errorKind         // null | timeout | http-error | network-error
 *       }, ...
 *     ]
 *   }
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.DownloadInspector = api;
  }
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  var DEFAULT_TIMEOUT_MS = 10000;

  // 平台关键词（按优先级匹配卡片标题）
  var PLATFORM_TITLE_PATTERNS = [
    [/windows|microsoft|\.exe|\.msi/i, 'windows'],
    [/mac\s?os|macos|osx|darwin|\.pkg|\.dmg/i, 'macos'],
    [/linux|appimage|\.deb|\.rpm/i, 'linux'],
    [/snap/i, 'snap']
  ];

  // 地址特征 → 平台（安装包扩展名 / 文件名关键词）
  var PLATFORM_URL_PATTERNS = [
    [/\.(exe|msi|msix|msixbundle)(\?|#|$)/i, 'windows'],
    [/\.(pkg|dmg)(\?|#|$)/i, 'macos'],
    [/\.(appimage|deb|rpm)(\?|#|$)/i, 'linux'],
    [/\.snap(\?|#|$)|snapcraft\.io\/[^/]+\/download/i, 'snap'],
    [/windows/i, 'windows'],
    [/mac\s?os|macos|darwin/i, 'macos'],
    [/linux/i, 'linux']
  ];

  // 指向平台安装包文件的地址特征
  var PLATFORM_FILE_URL_PATTERN =
    /(\.(exe|msi|msix|msixbundle|pkg|dmg|appimage|deb|rpm|snap|zip|tar\.gz|tgz)(\?|#|$))|(\/releases?\/download\/)/i;

  // 兼容平台组：snap 包属于 linux 生态
  var PLATFORM_COMPAT = {
    windows: ['windows'],
    macos: ['macos'],
    linux: ['linux', 'snap'],
    snap: ['snap', 'linux']
  };

  function detectLabeledPlatform(title) {
    for (var i = 0; i < PLATFORM_TITLE_PATTERNS.length; i++) {
      if (PLATFORM_TITLE_PATTERNS[i][0].test(title)) return PLATFORM_TITLE_PATTERNS[i][1];
    }
    return 'unknown';
  }

  function detectUrlPlatform(url) {
    for (var i = 0; i < PLATFORM_URL_PATTERNS.length; i++) {
      if (PLATFORM_URL_PATTERNS[i][0].test(url)) return PLATFORM_URL_PATTERNS[i][1];
    }
    return null;
  }

  function classifyEntryKind(url) {
    if (!url) return 'no-link';
    return PLATFORM_FILE_URL_PATTERN.test(url) ? 'platform-file' : 'non-platform';
  }

  function stripTags(html) {
    return String(html).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  }

  // 从单个卡片的 HTML 片段中提取标题 / 链接 / 商店 productid
  function extractCardFromHtml(fragment) {
    var title = '';
    var m = fragment.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    if (m) title = stripTags(m[1]);

    var url = null;
    m = fragment.match(/<a\s[^>]*?href="([^"]+)"/i);
    if (m) {
      url = m[1];
    } else {
      // ms-store-badge 之类的商店徽标：由 productid 推导商店页地址
      m = fragment.match(/<ms-store-badge[^>]*?productid="([^"]+)"/i);
      if (m) url = 'https://apps.microsoft.com/detail/' + m[1];
    }
    return { title: title, url: url };
  }

  // Node 环境：从整页 HTML 中解析下载区卡片（浏览器环境请用 parseDocument）
  function parseHtml(html) {
    var secMatch = String(html).match(/<section[^>]*id="downloads"[^>]*>/i);
    if (!secMatch) throw new Error('未找到 id="downloads" 的下载区');
    var start = secMatch.index + secMatch[0].length;
    var end = String(html).indexOf('</section>', start);
    if (end === -1) end = String(html).length;
    var sectionHtml = String(html).slice(start, end);

    var cards = [];
    var articleRe = /<article\b[\s\S]*?<\/article>/gi;
    var am;
    while ((am = articleRe.exec(sectionHtml)) !== null) {
      cards.push(extractCardFromHtml(am[0]));
    }
    return cards;
  }

  // 浏览器环境：基于 DOM 解析下载区卡片
  function parseDocument(doc) {
    var section = doc.getElementById('downloads');
    if (!section) throw new Error('未找到 id="downloads" 的下载区');
    var nodes = section.querySelectorAll('.download-card');
    var cards = [];
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var h3 = node.querySelector('h3');
      var anchor = node.querySelector('a[href]');
      var badge = node.querySelector('ms-store-badge[productid]');
      var url = null;
      if (anchor) {
        url = anchor.getAttribute('href');
      } else if (badge) {
        url = 'https://apps.microsoft.com/detail/' + badge.getAttribute('productid');
      }
      cards.push({ title: h3 ? h3.textContent.trim() : '', url: url });
    }
    return cards;
  }

  function resolveUrl(url, baseUrl) {
    if (!url) return null;
    if (!baseUrl) return url;
    try {
      return new URL(url, baseUrl).href;
    } catch (e) {
      return url;
    }
  }

  // 请求单条链接；任何失败都就地消化，返回完整结果对象，绝不抛出
  async function probeUrl(url, timeoutMs, fetchImpl) {
    var result = {
      httpStatus: null,
      redirected: false,
      finalUrl: url,
      errorKind: null,
      reason: ''
    };
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = null;
    if (controller) {
      timer = setTimeout(function () { controller.abort(); }, timeoutMs);
    }
    try {
      var response = await fetchImpl(url, controller ? { signal: controller.signal, redirect: 'follow' } : { redirect: 'follow' });
      result.httpStatus = response.status;
      result.redirected = !!response.redirected;
      result.finalUrl = response.url || url;
      if (response.status >= 200 && response.status < 300) {
        result.reason = 'HTTP ' + response.status + ' 可访问';
      } else {
        result.errorKind = 'http-error';
        result.reason = '非 2xx 响应：HTTP ' + response.status + (response.statusText ? ' ' + response.statusText : '');
      }
      if (result.redirected) {
        result.reason += '；发生重定向，最终落点 ' + result.finalUrl;
      }
    } catch (err) {
      if (err && (err.name === 'AbortError' || /aborted|timeout/i.test(String(err && err.message)))) {
        result.errorKind = 'timeout';
        result.reason = '请求超时（超过 ' + timeoutMs + 'ms 未响应）';
      } else {
        result.errorKind = 'network-error';
        result.reason = '网络错误：' + (err && err.message ? err.message : String(err));
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
    return result;
  }

  function buildResult(index, card, probe) {
    var labeledPlatform = detectLabeledPlatform(card.title || '');
    var entryKind = classifyEntryKind(card.url);
    var base = {
      index: index,
      title: card.title || '',
      url: card.url,
      labeledPlatform: labeledPlatform,
      entryKind: entryKind,
      outcome: null,
      reason: '',
      httpStatus: null,
      redirected: false,
      finalUrl: card.url,
      errorKind: null
    };

    if (entryKind === 'no-link') {
      base.outcome = 'no-link';
      base.reason = '卡片内未找到可请求的链接';
      return base;
    }

    base.httpStatus = probe.httpStatus;
    base.redirected = probe.redirected;
    base.finalUrl = probe.finalUrl;
    base.errorKind = probe.errorKind;

    if (probe.errorKind) {
      // 超时 / 非 2xx / 网络错误分别归类，原因写在 reason 中
      base.outcome = 'unreachable';
      base.reason = probe.reason;
      return base;
    }

    if (entryKind === 'non-platform') {
      // 商店页 / 个人主页等非平台文件入口：只判可达性，不参与平台一致性判断
      base.outcome = 'ok';
      base.reason = probe.reason + '；非平台文件入口，不参与平台一致性判断';
      return base;
    }

    // 平台安装包入口：可达性 + 平台一致性
    var urlPlatform = detectUrlPlatform(card.url);
    if (!urlPlatform || labeledPlatform === 'unknown') {
      base.outcome = 'ok';
      base.reason = probe.reason + '；平台特征不足，无法核对一致性（标注 ' +
        labeledPlatform + ' / 地址特征 ' + (urlPlatform || '未知') + '）';
      return base;
    }
    var compatible = (PLATFORM_COMPAT[labeledPlatform] || [labeledPlatform]).indexOf(urlPlatform) !== -1;
    if (compatible) {
      base.outcome = 'ok';
      base.reason = probe.reason + '；平台一致（标注 ' + labeledPlatform + '，地址特征 ' + urlPlatform + '）';
    } else {
      base.outcome = 'platform-mismatch';
      base.reason = probe.reason + '；平台不一致：标注为 ' + labeledPlatform +
        '，但地址特征指向 ' + urlPlatform;
    }
    return base;
  }

  /**
   * 巡检下载区全部卡片。
   * @param {object} options
   *   - document: 浏览器 DOM Document（默认取全局 document）
   *   - html:     整页 HTML 字符串（Node 环境使用）
   *   - baseUrl:  解析相对链接的基准地址
   *   - timeoutMs: 单条链接超时时间（默认 10000ms）
   *   - fetchImpl: 自定义 fetch 实现（默认全局 fetch）
   * @returns {Promise<{results: Array}>} 结果顺序与卡片在页面中的顺序一致
   */
  async function inspect(options) {
    options = options || {};
    var timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    var fetchImpl = options.fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
    if (!fetchImpl) throw new Error('当前环境没有可用的 fetch，请通过 fetchImpl 传入');

    var doc = options.document || (typeof document !== 'undefined' ? document : null);
    var cards = doc ? parseDocument(doc) : parseHtml(options.html || '');

    // 全部卡片并发请求；单条失败只影响自身结果，不中断其余入口；
    // Promise.all 保持与卡片顺序一致的输出顺序，重复巡检顺序稳定。
    var results = await Promise.all(cards.map(async function (card, index) {
      var resolved = resolveUrl(card.url, options.baseUrl);
      var probe = resolved
        ? await probeUrl(resolved, timeoutMs, fetchImpl)
        : { httpStatus: null, redirected: false, finalUrl: null, errorKind: null, reason: '' };
      // url 字段保留页面中的原始链接；resolved 仅用于发起请求
      return buildResult(index, { title: card.title, url: card.url }, probe);
    }));

    return { results: results };
  }

  return {
    inspect: inspect,
    parseHtml: parseHtml,
    parseDocument: parseDocument,
    _internals: {
      detectLabeledPlatform: detectLabeledPlatform,
      detectUrlPlatform: detectUrlPlatform,
      classifyEntryKind: classifyEntryKind
    }
  };
});
