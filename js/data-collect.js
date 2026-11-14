/*
 * data-collect.js — StatPlanet 数据采集模块
 *
 * 把 data/ 下的文本数据文件登记为采集项，逐项发起 GET 并记录结局，
 * 最后在仪表盘容器内渲染可判读的汇总区。
 *
 * 页面可调用的入口：
 *   DataCollect.collect(paths, options)  -> Promise<Array<result>>
 *   DataCollect.renderSummary(results, container, renderOptions)
 *   DataCollect.DEFAULT_MANIFEST         -> data/ 下实际存在的文本文件清单
 *
 * 每个结果对象（顺序与输入 paths 一致）：
 *   { path, status: 'success' | 'failed' | 'skipped',
 *     content?, length?,        // 成功时：响应文本及其长度
 *     reason?,                  // 失败/跳过时的原因
 *     duplicateOf? }            // 跳过时：首次出现的位置（0 起）
 */
(function (global) {
    'use strict';

    var DEFAULT_TIMEOUT_MS = 10000;

    // data/ 下实际存在的文本数据文件（默认采集清单）
    var DEFAULT_MANIFEST = [
        'data/categoricaldataexample.txt',
        'data/data.txt',
        'data/ict.txt',
        'data/nonlatintextexample.txt',
        'data/settings.txt',
        'data/settings_desktop.txt',
        'data/subcategory.txt',
        'data/subsubcategory1.txt',
        'data/subsubcategory2.txt',
        'data/test.txt'
    ];

    /**
     * 对单个路径发起一次 GET，带独立超时。
     * 超时判定由本项自己的定时器完成，不依赖其他任何请求的结束。
     */
    function fetchOne(path, timeoutMs, fetchImpl) {
        return new Promise(function (resolve) {
            var settled = false;
            var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;

            function finish(result) {
                if (settled) { return; }
                settled = true;
                clearTimeout(timer);
                resolve(result);
            }

            var timer = setTimeout(function () {
                if (controller) {
                    try { controller.abort(); } catch (e) { /* ignore */ }
                }
                finish({
                    path: path,
                    status: 'failed',
                    reason: 'timeout: 超过 ' + timeoutMs + ' ms 未完成'
                });
            }, timeoutMs);

            var fetchOptions = controller ? { signal: controller.signal } : {};

            Promise.resolve()
                .then(function () { return fetchImpl(path, fetchOptions); })
                .then(function (response) {
                    if (!response.ok) {
                        finish({
                            path: path,
                            status: 'failed',
                            reason: 'HTTP ' + response.status +
                                (response.statusText ? ' ' + response.statusText : '')
                        });
                        return null;
                    }
                    return response.text().then(function (text) {
                        finish({
                            path: path,
                            status: 'success',
                            content: text,
                            length: text.length
                        });
                    });
                })
                .catch(function (err) {
                    if (settled) { return; } // 已被超时判定，忽略后续 abort 异常
                    var msg = (err && err.message) ? err.message : String(err);
                    var isAbort = err && (err.name === 'AbortError');
                    finish({
                        path: path,
                        status: 'failed',
                        reason: (isAbort ? 'aborted' : 'network error') + ': ' + msg
                    });
                });
        });
    }

    /**
     * 采集入口。
     * @param {string[]} paths   待采集路径，按输入顺序返回结果
     * @param {object}   options 至少含 timeoutMs（超时毫秒数）；
     *                           可选 fetchImpl（测试注入用，默认 window.fetch）
     * @returns {Promise<Array>} 结果数组，顺序与 paths 一致
     */
    function collect(paths, options) {
        options = options || {};
        var timeoutMs = (typeof options.timeoutMs === 'number' && options.timeoutMs > 0)
            ? options.timeoutMs
            : DEFAULT_TIMEOUT_MS;
        var fetchImpl = options.fetchImpl ||
            (typeof fetch !== 'undefined' ? fetch.bind(global) : null);

        if (!Array.isArray(paths)) {
            return Promise.reject(new Error('collect: paths 必须是数组'));
        }
        if (!fetchImpl) {
            return Promise.reject(new Error('collect: 当前环境没有可用的 fetch'));
        }

        // 登记采集项：同一路径只采一次，后出现的标记跳过
        var firstIndexByPath = {};
        var results = new Array(paths.length);
        var jobs = [];

        paths.forEach(function (path, index) {
            if (Object.prototype.hasOwnProperty.call(firstIndexByPath, path)) {
                var first = firstIndexByPath[path];
                results[index] = {
                    path: path,
                    status: 'skipped',
                    reason: '重复路径：与第 ' + (first + 1) + ' 项相同，已采集过，跳过',
                    duplicateOf: first
                };
                return;
            }
            firstIndexByPath[path] = index;
            jobs.push(
                fetchOne(path, timeoutMs, fetchImpl).then(function (result) {
                    results[index] = result;
                })
            );
        });

        // 单项失败只反映在自己的结果里，不中断其余项
        return Promise.all(jobs).then(function () {
            return results;
        });
    }

    /**
     * 在容器内渲染采集汇总区（稳定元素 id 供验收读取）。
     * @param {Array} results        collect() 的返回数组
     * @param {Element|string} container  容器元素或选择器（默认 '#statsilk-container'）
     * @param {object} renderOptions 可选 { idPrefix }，多汇总区共存时避免 id 冲突
     */
    function renderSummary(results, container, renderOptions) {
        renderOptions = renderOptions || {};
        var prefix = renderOptions.idPrefix || 'data-collect';

        var root = container;
        if (typeof container === 'string') {
            root = document.querySelector(container);
        }
        if (!root) {
            root = document.getElementById('statsilk-container') || document.body;
        }

        results = results || [];
        var total = results.length;
        var ok = 0, failed = 0, skipped = 0;
        results.forEach(function (r) {
            if (r.status === 'success') { ok++; }
            else if (r.status === 'skipped') { skipped++; }
            else { failed++; }
        });

        var summary = document.createElement('div');
        summary.id = prefix + '-summary';
        summary.className = 'data-collect-summary';
        summary.setAttribute('style',
            'margin:12px 0;padding:12px 16px;border:1px solid #ccc;border-radius:6px;' +
            'background:#fafafa;color:#222;font:13px/1.5 monospace;text-align:left;');

        var title = document.createElement('h3');
        title.id = prefix + '-title';
        title.textContent = '数据采集汇总';
        title.setAttribute('style', 'margin:0 0 8px;font-size:15px;');
        summary.appendChild(title);

        function countLine(id, label, value) {
            var p = document.createElement('div');
            var span = document.createElement('span');
            span.id = id;
            span.textContent = String(value);
            p.appendChild(document.createTextNode(label + '：'));
            p.appendChild(span);
            return p;
        }
        summary.appendChild(countLine(prefix + '-total', '总数', total));
        summary.appendChild(countLine(prefix + '-success', '成功', ok));
        summary.appendChild(countLine(prefix + '-failed', '失败', failed));
        summary.appendChild(countLine(prefix + '-skipped', '跳过', skipped));

        // 全部失败（无任何成功项）时仍渲染汇总，并明确提示没有可用数据
        if (ok === 0) {
            var empty = document.createElement('div');
            empty.id = prefix + '-empty';
            empty.setAttribute('style', 'margin:8px 0;padding:6px 10px;background:#fdecea;' +
                'border:1px solid #f5c6c0;color:#a33;border-radius:4px;font-weight:bold;');
            empty.textContent = '没有可用数据：所有采集项均未成功。';
            summary.appendChild(empty);
        }

        var list = document.createElement('ul');
        list.id = prefix + '-items';
        list.setAttribute('style', 'margin:8px 0 0;padding-left:18px;');
        results.forEach(function (r, i) {
            var li = document.createElement('li');
            li.id = prefix + '-item-' + i;
            li.setAttribute('data-status', r.status);
            var text = r.path + ' — ' + r.status;
            if (r.status === 'success') {
                text += '（内容长度 ' + r.length + ' 字符）';
                li.style.color = '#1a7f37';
            } else if (r.status === 'skipped') {
                text += '（' + r.reason + '）';
                li.style.color = '#8a6d00';
            } else {
                text += '（原因：' + r.reason + '）';
                li.style.color = '#b3261e';
            }
            li.textContent = text;
            list.appendChild(li);
        });
        summary.appendChild(list);

        root.appendChild(summary);
        return summary;
    }

    global.DataCollect = {
        collect: collect,
        renderSummary: renderSummary,
        DEFAULT_MANIFEST: DEFAULT_MANIFEST,
        DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS
    };
})(typeof window !== 'undefined' ? window : this);
