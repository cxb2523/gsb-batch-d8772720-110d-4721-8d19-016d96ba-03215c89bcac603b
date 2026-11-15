/**
 * tools/print-paths.js — 把 lib/env.js 解析出来的路径打成 JSON（给安装器/脚本用）
 *
 * 为什么存在：
 *   安装器（install.ps1）要在写 config.local.json 之前就知道"那两个依赖仓库在哪"。
 *   第一版在 PowerShell 里把猜路径的规则【又抄了一遍】，结果漏了 Desktop 那条，
 *   于是明明装好的 xianyu-monitor 被当成"需要克隆" —— DryRun 一跑就露馅。
 *   现在统一委托到这里，路径规则只有 lib/env.js 一份。
 *
 * 用法: node tools/print-paths.js
 */
const { ROOT, PATHS, NODE } = require('../lib/env');
console.log(JSON.stringify({
  root: ROOT.replace(/\\/g, '/'),
  paths: PATHS,
  node: NODE.path || '',
  serviceBase: 'http://' + require('../lib/env').SVC.host + ':' + require('../lib/env').SVC.port,
}, null, 2));
