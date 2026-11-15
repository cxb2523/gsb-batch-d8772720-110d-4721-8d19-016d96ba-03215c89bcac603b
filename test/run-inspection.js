/*
 * 本地验证脚本：启动一个本地 HTTP 服务器承接样例中的各类链接，
 * 用 download-inspector.js 巡检 test/sample-downloads.html 的下载区，
 * 校验七类卡片的结局分类与输出顺序稳定性。不访问真实外网。
 *
 * 运行：node test/run-inspection.js
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const DownloadInspector = require(path.join(__dirname, '..', 'download-inspector.js'));

const SAMPLE_PATH = path.join(__dirname, 'sample-downloads.html');

function createServer() {
  return http.createServer((req, res) => {
    const url = req.url;
    if (url.startsWith('/files/')) {
      // 正常安装包文件
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end('fake-installer-payload');
    } else if (url.startsWith('/legacy/')) {
      // 重定向到 /files/
      res.writeHead(302, { Location: url.replace('/legacy/', '/files/') });
      res.end();
    } else if (url.startsWith('/hang/')) {
      // 永不响应，模拟超时（服务器关闭时统一销毁 socket）
    } else if (url.startsWith('/missing/')) {
      res.writeHead(404, 'Not Found');
      res.end('not found');
    } else if (url.startsWith('/reset/')) {
      // 直接断开连接，模拟网络错误
      req.socket.destroy();
    } else if (url.startsWith('/home')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body>profile page</body></html>');
    } else {
      res.writeHead(400);
      res.end('unexpected route: ' + url);
    }
  });
}

// 期望结果：与样例卡片一一对应（顺序即卡片顺序）
const EXPECTED = [
  { title: 'Windows OneFile Executable', outcome: 'ok', errorKind: null, redirected: false, entryKind: 'platform-file' },
  { title: 'Linux Installer', outcome: 'platform-mismatch', errorKind: null, redirected: false, entryKind: 'platform-file' },
  { title: 'macOS Installer', outcome: 'ok', errorKind: null, redirected: true, entryKind: 'platform-file' },
  { title: 'Windows Setup', outcome: 'unreachable', errorKind: 'timeout', redirected: false, entryKind: 'platform-file' },
  { title: 'Linux AppImage', outcome: 'unreachable', errorKind: 'http-error', redirected: false, entryKind: 'platform-file' },
  { title: 'Windows Portable Zip', outcome: 'unreachable', errorKind: 'network-error', redirected: false, entryKind: 'platform-file' },
  { title: 'GitHub Profile', outcome: 'ok', errorKind: null, redirected: false, entryKind: 'non-platform' }
];

function checkResults(results, label) {
  const failures = [];
  if (results.length !== EXPECTED.length) {
    failures.push(`结果数量 ${results.length} 与卡片数量 ${EXPECTED.length} 不一致（有卡片被丢弃）`);
    return failures;
  }
  results.forEach((r, i) => {
    const e = EXPECTED[i];
    for (const key of Object.keys(e)) {
      if (r[key] !== e[key]) {
        failures.push(`[${label}] 卡片 ${i} "${r.title}" 字段 ${key}: 期望 ${e[key]}，实际 ${r[key]}`);
      }
    }
    for (const field of ['index', 'title', 'url', 'labeledPlatform', 'entryKind', 'outcome', 'reason', 'httpStatus', 'redirected', 'finalUrl', 'errorKind']) {
      if (!(field in r)) failures.push(`[${label}] 卡片 ${i} 缺少字段 ${field}`);
    }
  });
  return failures;
}

async function main() {
  const server = createServer();
  const sockets = new Set();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const html = fs.readFileSync(SAMPLE_PATH, 'utf8');

  let failures = [];
  try {
    // 第一次巡检
    const report1 = await DownloadInspector.inspect({ html, baseUrl, timeoutMs: 1500 });
    // 第二次巡检：验证重复执行输出顺序稳定
    const report2 = await DownloadInspector.inspect({ html, baseUrl, timeoutMs: 1500 });

    console.log('=== 巡检结果 ===');
    for (const r of report1.results) {
      console.log(`#${r.index} [${r.outcome}] ${r.title}`);
      console.log(`    url=${r.url}  platform=${r.labeledPlatform}  kind=${r.entryKind}`);
      console.log(`    status=${r.httpStatus}  redirected=${r.redirected}  final=${r.finalUrl}  error=${r.errorKind}`);
      console.log(`    reason=${r.reason}`);
    }

    failures = failures.concat(checkResults(report1.results, 'run1'));
    failures = failures.concat(checkResults(report2.results, 'run2'));

    // 顺序稳定性：两次巡检的 (title, url, outcome) 序列必须完全一致
    const seq1 = JSON.stringify(report1.results.map((r) => [r.title, r.url, r.outcome]));
    const seq2 = JSON.stringify(report2.results.map((r) => [r.title, r.url, r.outcome]));
    if (seq1 !== seq2) failures.push('两次巡检输出顺序/结果不一致');

    // 正常入口与异常入口都必须保留在结果中
    const hasOk = report1.results.some((r) => r.outcome === 'ok');
    const hasBad = report1.results.some((r) => r.outcome !== 'ok');
    if (!hasOk || !hasBad) failures.push('结果中未同时保留正常入口与异常入口');
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => server.close(resolve));
  }

  if (failures.length) {
    console.error('\n=== 验证失败 ===');
    failures.forEach((f) => console.error(' - ' + f));
    process.exit(1);
  }
  console.log('\n全部检查通过：7 张卡片均保留在结果中，分类与顺序稳定。');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
