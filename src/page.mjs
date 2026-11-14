import { readFileSync } from 'node:fs';
import { automationControls } from './automation-controls.mjs';
import { operationLabels } from './operation-labels.mjs';
import { chrome, journal, dialogs, templates, giftCodesPage, overviewPage, manualPage, inventoryPage, heroesPage, dailiesPage, guildPage, activitiesPage, accountPage, loginSettingsPage, idlePanel, stagePanel, settingsPage } from './ui/dist/console.mjs';
const componentCss = readFileSync(new URL('./ui/dist/theme.css', import.meta.url), 'utf8');
const consoleCss = readFileSync(new URL('./console.css', import.meta.url), 'utf8');
const progressionScript = readFileSync(new URL('./ui/progression.js', import.meta.url), 'utf8');
const settingsScript = readFileSync(new URL('./settings-ui.js', import.meta.url), 'utf8');
const activitiesScript = readFileSync(new URL('./ui/activities.js', import.meta.url), 'utf8');
const settingsCss = readFileSync(new URL('./settings.css', import.meta.url), 'utf8');
const giftCodeScript=readFileSync(new URL('./gift-codes-ui.js',import.meta.url),'utf8');
const rankingScript=readFileSync(new URL('./activity-rankings-ui.js',import.meta.url),'utf8');
const activityStatisticsScript=readFileSync(new URL('./activity-statistics-ui.js',import.meta.url),'utf8');
const inventoryScript=readFileSync(new URL('./inventory-ui.js',import.meta.url),'utf8');
const worldMapScript=readFileSync(new URL('./world-map-ui.js',import.meta.url),'utf8');
import {mapMotionPosition} from './world-map-geometry.mjs';
const helpTipsScript = readFileSync(new URL('./help-tips.js', import.meta.url), 'utf8');

export const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'%3E%3Crect fill='%23102d39' width='40' height='40' rx='8'/%3E%3Cpath fill='%23ffbd77' d='m20 3 4 13 13 4-13 4-4 13-4-13-13-4 13-4z'/%3E%3C/svg%3E">
<title>疯狂水世界</title>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#ffffff">
<meta name="format-detection" content="telephone=no">
<style>@layer properties, theme, base, components, page, utilities; @layer page { ${consoleCss} ${settingsCss} } ${componentCss}</style>
</head>
<body>
${chrome()}
<div class="deck"><main>
  <nav id="resource-tabs" class="resource-tabs" aria-label="资源与玩法分类" hidden>
    <button type="button" data-resource-tab="dailies">日常</button><button type="button" data-resource-tab="guild">联盟</button><button type="button" data-resource-tab="inventory">仓库</button><button type="button" data-resource-tab="heroes">英雄与装备</button><button type="button" data-resource-tab="activities">材料与订单</button><button type="button" data-resource-tab="giftcodes">礼包兑换</button>
  </nav>
  <section id="tab-overview">
    ${overviewPage()}
  </section>

  <section id="tab-idle" class="hidden">
    ${idlePanel(automationControls)}
  </section>

  <section id="tab-settings" class="hidden">
    ${settingsPage()}
  </section>

  <section id="tab-manual" class="hidden">
    ${manualPage()}
  </section>

  <section id="tab-stages" class="hidden">
    ${stagePanel()}
  </section>

  <section id="tab-inventory" class="hidden">
    ${inventoryPage()}
  </section>

  <section id="tab-heroes" class="hidden">
    ${heroesPage()}
  </section>

  <section id="tab-activities" class="hidden">
    ${activitiesPage()}
  </section>
  <section id="tab-dailies" class="hidden">
    ${dailiesPage()}
  </section>

  <section id="tab-guild" class="hidden">${guildPage()}</section>

  <section id="tab-giftcodes" class="hidden">
    ${giftCodesPage()}
  </section>
  <section id="tab-account" class="hidden">
    ${accountPage()}
  </section>
  <section id="tab-login-settings" class="hidden">
    ${loginSettingsPage()}
  </section>
</main></div>
${journal()}
${dialogs()}
${templates()}

<script>
const $ = (id) => document.getElementById(id);
const logEl = $('log');
const operationNames = ${JSON.stringify(operationLabels)};

// 同一个页面只伺候一个账号：所有请求都带 ?account=<当前选中>。
let current = null;
let accounts = [];
let stream = null;
let dailyAccount = null, dailyVersion = 0;
const pendingDailyAccounts = new Set();

function num(v) {
  if (v == null || typeof v !== 'object') return v;
  return (v.low >>> 0) + (v.high >>> 0) * 4294967296;
}

function fmt(v) {
  const n = num(v);
  if (typeof n !== 'number') return String(n == null ? '-' : n);
  return n.toLocaleString('zh-CN');
}

function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('zh-CN', { hour12: false });
}

let callsInFlight = 0, callProgressTimer = 0;
function trackCall(delta) {
  callsInFlight += delta;
  if (callsInFlight > 0) {
    if (!callProgressTimer) callProgressTimer = setTimeout(() => { callProgressTimer = 0; if (callsInFlight > 0) document.body.setAttribute('data-loading', ''); }, 400);
    return;
  }
  clearTimeout(callProgressTimer);
  callProgressTimer = 0;
  document.body.removeAttribute('data-loading');
}

async function call(path, options) {
  const opts = options || {};
  let url = path;
  if (current && url.indexOf('/api/') === 0 && url.indexOf('account=') < 0) {
    url += (url.indexOf('?') < 0 ? '?' : '&') + 'account=' + encodeURIComponent(current);
  }
  const account = current;
  trackCall(1);
  try {
    const res = await fetch(url, opts);
    const data = await res.json();
    if (!res.ok) {
      const error = new Error(data.error || res.statusText);
      if (data.fields) error.fields = data.fields;
      if (data.log && (!data.log.account || account === current)) appendLog(data.log);
      error.logged = true;
      if (!data.log && account === current) reportError(new Error(data.error || ('控制台返回 HTTP ' + res.status)), path);
      throw error;
    }
    return data;
  } catch (error) {
    if (!error.logged && account === current) reportError(error, path);
    error.logged = true;
    throw error;
  } finally {
    trackCall(-1);
  }
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function clear(node) {
  node.textContent = '';
  return node;
}

// ---- 图标 ------------------------------------------------------------------
// 每个图标单独下载缩略图；屏幕外的不加载，取不到时退回名字首字。

function iconEl(entry, size, name) {
  if (!entry?.thumb) {
    const box = el('span', 'ico');
    box.style.width = size + 'px';
    box.style.height = size + 'px';
    box.appendChild(el('span', 'fallback', (name || '?').slice(0, 1)));
    box.title = name || '';
    return box;
  }
  const k = size / Math.max(entry.w, entry.h);
  const img = el('img', 'ico');
  img.width = Math.max(1, Math.round(entry.w * k));
  img.height = Math.max(1, Math.round(entry.h * k));
  img.alt = '';
  img.title = name || '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.onerror = () => img.replaceWith(iconEl(null, size, name));
  img.src = entry.thumb;
  return img;
}

// 一项东西：图标 + 名字 + 数量
function cell(entry, size, name, qty, showPlaceholder = true) {
  const node = el('div', 'cell');
  if (entry || showPlaceholder) node.appendChild(iconEl(entry, size || 34, name));
  const txt = el('div', 'txt');
  txt.appendChild(el('span', 'nm', name || '?'));
  if (qty != null) txt.appendChild(el('span', 'qty', qty));
  node.appendChild(txt);
  return node;
}

function component(id) {
  return $(id).content.firstElementChild.cloneNode(true);
}
function smallButton(label, danger = false) {
  const button = component(danger ? 'ui-delete' : 'ui-button');
  button.textContent = label;
  return button;
}
function chip(status, text) {
  const badge = component('ui-badge');
  badge.classList.add('chip', status);
  badge.textContent = text;
  return badge;
}

// ---- 弹窗 ------------------------------------------------------------------
function closeModal() {
  $('modal').close();
  $('m-ok').onclick = null;
}
function openConfirm(title, bodyNodes, onOk) {
  $('m-title').textContent = title;
  const body = clear($('m-body'));
  for (const node of bodyNodes) body.appendChild(node);
  $('m-ok').onclick = async () => {
    const run = onOk;
    closeModal();
    try {
      await run();
    } catch (error) {
      $('hint').textContent = '';
      reportError(error);
    }
  };
  $('modal').showModal();
  $('m-cancel').focus();
}
$('m-cancel').onclick = closeModal;
$('modal').oncancel = event => { event.preventDefault(); closeModal(); };
function isChecked(control) {
  return control.getAttribute('aria-checked') === 'true';
}
for (const control of document.querySelectorAll('[data-local-switch]')) {
  control.onclick = () => setTaskSwitch(control, !isChecked(control));
}

function accountDialog(title, message, value) {
  const dialog = $('account-dialog'), input = $('account-label-input');
  $('account-title').textContent = title;
  $('account-message').textContent = message;
  input.hidden = value === undefined;
  input.value = value ?? '';
  dialog.returnValue = '';
  dialog.showModal();
  if (!input.hidden) input.select();
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok' ? input.value : null), { once: true });
  });
}

function bindGameAction(id, action) {
  const button = $(id);
  button.onclick = async () => {
    if (!current || button.disabled) return;
    button.disabled = true;
    try { await action(); }
    catch (error) { reportError(error); }
    finally { button.disabled = false; }
  };
}

// ---- 运行记录 --------------------------------------------------------------
const seen = new Set();
const logTime = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
let logAccount;
let onlyIssues = false;
let logCategory = 'all';
let logReturnFocus;
function openJournal() {
  if ($('journal-dialog').open) return;
  closeHelpTip(false); logReturnFocus = document.activeElement;
  document.body.classList.add('has-log-dialog'); $('journal-dialog').showModal(); $('log-category').focus();
}
$('logs-open').onclick = openJournal;
$('logs-close').onclick = () => $('journal-dialog').close();
$('journal-dialog').addEventListener('close', () => { document.body.classList.remove('has-log-dialog'); (logReturnFocus?.isConnected ? logReturnFocus : $('logs-open')).focus(); });
$('log-category').onchange = () => { logCategory = $('log-category').value; updateLogSummary(); };
let logClearBefore = 0, logClearAt = 0;
let guildRefreshTimer;
function updateLogSummary() {
  let count = 0;
  for (const row of logEl.children) {
    row.hidden = (onlyIssues && !row.classList.contains('error') && !row.classList.contains('warn')) || (logCategory !== 'all' && row.dataset.category !== logCategory);
    if (!row.hidden) count++;
  }
  $('log-top-count').textContent = logEl.children.length;
  $('log-count').textContent = String(count);
  $('log-empty').hidden = count > 0;
  $('log-empty').textContent = logCategory !== 'all' ? '这个功能暂无符合筛选条件的记录' : onlyIssues ? '没有警告或错误' : '还没有运行记录';
}
function appendLog(entry) {
  if (entry.account && entry.account !== current) return;
  if (entry.id ? entry.id <= logClearBefore : entry.t <= logClearAt) return;
  if (entry.id && seen.has(entry.id)) return;
  if (entry.id) seen.add(entry.id);
  const atTop = logEl.scrollTop < 30;
  const anchor = [...logEl.children].find(row => row.getBoundingClientRect().bottom > logEl.getBoundingClientRect().top);
  const anchorTop = anchor?.getBoundingClientRect().top;
  const waitKey=entry.extra?.waitKey;
  const repeated=waitKey && [...logEl.children].find(row=>row.dataset.waitKey===waitKey);
  if(repeated){repeated.logEntries.unshift(entry);if(repeated.logEntries.length>400){const dropped=repeated.logEntries.pop();seen.delete(dropped.id);}repeated.dataset.waitCount=String(Number(repeated.dataset.waitCount||1)+1);updateLogRow(repeated);logEl.prepend(repeated);updateLogSummary();return;}
  const batch = entry.extra?.batch;
  const first = logEl.firstElementChild;
  const newer = (a, b) => a.t > b.t || (a.t === b.t && (a.id || Infinity) > (b.id || 0));
  if (batch && first?.dataset.batch === batch && first.logEntries.length < 32 && newer(entry, first.logEntries[0])) {
    first.logEntries.unshift(entry);
    updateLogRow(first);
  } else {
    const row = el('div', 'row ' + entry.level);
    row.dataset.category = entry.category || 'system';
    if(waitKey){row.dataset.waitKey=waitKey;row.dataset.waitCount='1';}
    row.logEntries = [entry];
    if (batch) row.dataset.batch = batch;
    const timestamp = logTime.format(entry.t);
    row.appendChild(el('time', 'ts', timestamp));
    const body = el('div', 'log-body');
    const levelName = { error: '错误', warn: '提醒' }[entry.level];
    if (levelName) body.appendChild(el('span', 'log-level', levelName));
    body.appendChild(el('span', 'log-message', entry.message));
    if (entry.detail || batch) {
      const details = el('details', 'log-details');
      details.hidden = !entry.detail;
      details.append(el('summary', null, batch ? '查看逐次排产' : '查看详情'),
        el('div', 'log-detail-text', entry.detail || timestamp + ' ' + entry.message));
      body.appendChild(details);
    }
    row.appendChild(body);
    const next = [...logEl.children].find(item => newer(entry, item.logEntries[0]));
    logEl.insertBefore(row, next || null);
  }
  while (logEl.childElementCount > 400) {
    for (const item of logEl.lastChild.logEntries) seen.delete(item.id);
    logEl.lastChild.remove();
  }
  updateLogSummary();
  if (atTop) logEl.scrollTop = 0;
  else if (anchor?.isConnected) logEl.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
}
function updateLogRow(row) {
  const entry = row.logEntries[0];
  row.querySelector('time').textContent = logTime.format(entry.t);
  row.querySelector('.log-message').textContent = row.dataset.waitKey ? entry.message+'（累计 '+row.dataset.waitCount+' 次，时间为最后检查）' : row.logEntries.length > 1
    ? entry.extra.factory + '：连续安排生产' + entry.extra.product + '，共 ' + row.logEntries.length + ' 次' : entry.message;
  const details = row.querySelector('.log-details');
  if (details) {
    details.hidden = row.logEntries.length < 2 && !entry.detail;
    row.querySelector('.log-detail-text').textContent = entry.detail || row.logEntries.map(item => logTime.format(item.t) + ' ' + item.message).join(String.fromCharCode(10));
  }
}
function clearLogBefore(data) {
  logClearBefore = Math.max(logClearBefore, data.before);
  logClearAt = Math.max(logClearAt, data.at);
  for (const row of [...logEl.children]) {
    row.logEntries = row.logEntries.filter(entry => entry.id ? entry.id > logClearBefore : entry.t > logClearAt);
    if (row.logEntries.length) updateLogRow(row); else row.remove();
  }
  seen.clear();
  for (const row of logEl.children) for (const entry of row.logEntries) if (entry.id) seen.add(entry.id);
  updateLogSummary();
}
$('log-clear').onclick = async () => {
  if (!current) return;
  const account = current, button = $('log-clear');
  button.disabled = true;
  try {
    const data = await call('/api/logs/clear', { method: 'POST', body: JSON.stringify({ confirm: true }) });
    if (account === current) clearLogBefore(data);
  } catch (error) { if (account === current) reportError(error); }
  finally { button.disabled = false; }
};
function reportError(error, context) {
  if (error?.logged) return;
  const api = context?.startsWith('/api/');
  const action = api ? operationNames[context.split('?')[0]] || '控制台操作' : context;
  const raw = error?.message || String(error);
  const reason = raw === 'Failed to fetch' ? '无法连接本地控制台，请检查控制台是否仍在运行' : raw;
  appendLog({ t: Date.now(), level: 'error', message: (action ? action + '失败：' : '') + reason,
    detail: api ? context + ' · ' + raw : undefined });
  if (error instanceof Error) error.logged = true;
}
window.addEventListener('unhandledrejection', (event) => { reportError(event.reason); event.preventDefault(); });
for (const [id, filtered] of [['log-all', false], ['log-issues', true]]) {
  $(id).onclick = () => {
    onlyIssues = filtered;
    $('journal').classList.toggle('issues', filtered);
    $('log-all').setAttribute('aria-pressed', String(!filtered));
    $('log-issues').setAttribute('aria-pressed', String(filtered));
    updateLogSummary();
  };
}
function subscribe() {
  if (stream) stream.close();
  if (logAccount !== current) {
    seen.clear(); clear(logEl); updateLogSummary(); logAccount = current;
    logClearBefore = logClearAt = 0;
  }
  $('log-clear').disabled = !current;
  const account = current;
  stream = new EventSource('/api/events' + (current ? '?account=' + encodeURIComponent(current) : ''));
  stream.addEventListener('logs-cleared', event => { if (account === current) clearLogBefore(JSON.parse(event.data)); });
  stream.addEventListener('guild-aid-changed', () => {
    clearTimeout(guildRefreshTimer);
    guildRefreshTimer = setTimeout(() => {
      if (account === current && !snapshot.paused && !$('tab-guild').classList.contains('hidden')) {
        void refreshProgression('guild');
      }
    }, 300);
  });
  stream.onmessage = (event) => {
    if (account !== current) return;
    const entry = JSON.parse(event.data);
    appendLog(entry);
    if (entry.extra?.pauseChanged && entry.account === current) void loadAccounts(false);
    if (entry.extra?.worldUpdated && entry.account === current && Date.now() - entry.t < 10_000) refreshManualWorld();
  };
}

// ---- 账号 ------------------------------------------------------------------
function setBusy(text, state) {
  const pill = $('busy');
  pill.textContent = text;
  pill.dataset.state = state;
}
function paintConnection() {
  if (snapshot.paused) setBusy('已暂停 · 可自行上号', 'paused');
  else if (snapshot.connected) setBusy('已连接', 'on');
  else setBusy('未连接', 'off');
}
let snapshot = { connected: false, state: 'IDLE', busy: null, looping: false };
const disconnected = new Set();

let accountDetailsOwner=null,credentialVersion=0;
function renderAccountSelect() {
  if (dailyAccount !== current || snapshot.paused || disconnected.has(current)) {
    dailyAccount = current; dailyVersion++;
    clear($('dailies-table'));
    $('dailies-hint').textContent = snapshot.paused ? '账号已暂停' : '点击探测查看当前日常';
  }
  const box=$('account');
  const choices=accounts.length?accounts.map(a=>[a.id,a.title]):[['','没有账号']];
  if(box.options.length!==choices.length||choices.some(([id,label],i)=>box.options[i]?.value!==id||box.options[i]?.text!==label)){
    box.replaceChildren(...choices.map(([id,label])=>new Option(label,id)));
  }
  box.disabled=!accounts.length;box.value=current||'';
  if(accountDetailsOwner!==current){
    accountDetailsOwner=current;credentialVersion++;
    clear($('cred'));clear($('worlds'));$('worlds-hint').textContent='';$('world-input').value='';
    $('who').textContent=current?'等待连接':'未选择账号';$('res').textContent='';
    $('cred-show').disabled=!current;
    renderAccounts();
  }
  if(activityStatsOwner!==null&&activityStatsOwner!==current)resetActivityStatistics();
  if(worldMapOwner!==null&&worldMapOwner!==current)resetWorldMap();
  $('account-pause').disabled = !current;
  $('account-pause').textContent = snapshot.paused ? '恢复托管' : '暂停托管';
  $('account-pause').title = snapshot.paused ? '结束自行上号，允许控制台重新登录游戏' : '断开游戏连接，方便自行上号';
  paintConnection();
  $('connect').disabled = snapshot.paused || snapshot.connected || !accounts.length;
  $('disconnect').disabled = !snapshot.connected;
}

async function loadAccounts(reload) {
  const data = await call('/api/accounts');
  const previous = current;
  accounts = data.accounts;
  if (!current && data.activeId) current = data.activeId;
  if (current && !accounts.some((a) => a.id === current)) current = data.activeId;
  snapshot = accounts.find(a => a.id === current)?.status ?? {};
  renderAccountSelect();
  if (previous !== current || reload) refreshProgression();
  if (previous !== current) refreshManualWorld();
  if (previous !== current) {configAccountChanged();giftAccountChanged();loginSettingsAccountChanged();}
  if (reload) {
    subscribe();
    refreshOverview();
  }
}

$('account').onchange = async () => {
  const next = $('account').value;
  if (!await configMayChangeAccount(next)) { $('account').value = current || ''; return; }
  current = next;
  giftAccountChanged();
  configAccountChanged();
  loginSettingsAccountChanged();
  snapshot = accounts.find(a => a.id === current)?.status ?? {};
  renderAccountSelect();
  refreshProgression();
  refreshManualWorld();
  refreshActivities();
  refreshStages();
  refreshLoop();
  await call('/api/accounts/active', { method: 'POST', body: JSON.stringify({ confirm: true, id: current }) });
  subscribe();
  refreshOverview();
};

$('account-pause').onclick = async () => {
  const account = current;
  $('account-pause').disabled = true;
  try {
    const status = await call('/api/accounts/pause', { method: 'POST', body: JSON.stringify({ paused: !snapshot.paused }) });
    const row = accounts.find(a => a.id === account);
    if (row) row.status = status;
    if (current !== account) return;
    snapshot = status;
    if (!status.paused) disconnected.delete(account);
    renderAccountSelect();
    refreshProgression();
    refreshManualWorld();
    refreshOverview();
    refreshLoop();
    refreshActivities();
  } finally {
    if (current === account) $('account-pause').disabled = false;
  }
};

$('connect').onclick = async () => {
  setBusy('连接中…', 'busy');
  try {
    await call('/api/connect', { method: 'POST' });
    disconnected.delete(current);
    refreshManualWorld();
    snapshot.connected = true;
    renderAccountSelect();
    refreshProgression();
    refreshOverview();
  } catch (error) {
    paintConnection();
    reportError(error);
  }
};
$('disconnect').onclick = async () => {
  const account = current;
  disconnected.add(account);
  refreshProgression();
  refreshManualWorld();
  await call('/api/disconnect', { method: 'POST' });
  if (account !== current) return;
  snapshot.connected = false;
  paintConnection();
  renderAccountSelect();
};

// ---- 总览 ------------------------------------------------------------------
function renderWho(view) {
  const box = clear($('who'));
  const role = view.player || {};
  const account = view.account || {};
  const status = view.status || {};
  const items = [
    ['账号', account.title || '-'],
    ['角色', role.nickname || '-'],
    ['等级', role.level == null ? '-' : String(role.level)],
    ['战力', fmt(role.power)],
    ['区服', role.worldId == null ? '-' : (role.worldName ? role.worldName + '（' + role.worldId + '）' : String(role.worldId))],
    ['状态', status.connected ? '已连接' : '未连接'],
  ];
  for (const [k, v] of items) {
    const cellBox = el('div', 'item');
    cellBox.appendChild(el('span', 'k', k));
    cellBox.appendChild(el('span', 'v', v));
    box.appendChild(cellBox);
  }
  if (view.afk) {
    const afk = el('div', 'item');
    afk.appendChild(el('span', 'k', '闯关挂机收益'));
    const finish = view.afk.finishTime;
    const status = view.afk.capped ? '收益已满' : finish > 0 ? new Date(finish * 1000).toLocaleTimeString() + ' 满额' : '暂无计时';
    afk.appendChild(el('span', 'v', '等级 ' + (view.afk.level ?? '-') + ' · ' + status));
    box.appendChild(afk);
  }
}

function renderOverview(data) {
  renderWho(data);

  const res = clear($('res'));
  for (const entry of data.resources || []) res.appendChild(cell(entry.icon, 18, entry.name, entry.amount == null ? '未取得' : fmt(entry.amount), false));
  if (!res.childElementCount) res.appendChild(el('span', 'dim', '暂无数据'));

  const heroes = clear($('hero-strip'));
  for (const hero of (data.heroes && data.heroes.list) || []) {
    heroes.appendChild(cell(hero.icon, 40, hero.heroId, 'lv' + hero.level + ' · ' + hero.star + '星'));
  }
  if (!heroes.childElementCount) heroes.appendChild(el('span', 'dim', '暂无数据'));
}

let overviewPending = false;
async function refreshOverview() {
  if (overviewPending===current || !current || snapshot.paused || disconnected.has(current) || document.hidden || ($('tab-overview').classList.contains('hidden')&&$('tab-heroes').classList.contains('hidden')&&$('tab-account').classList.contains('hidden'))) return;
  const account = current;
  overviewPending = account;
  if (!snapshot.connected) setBusy('连接中…', 'busy');
  try {
    const data = await call('/api/overview');
    if (account !== current || snapshot.paused || disconnected.has(account)) return;
    snapshot = data.status;
    renderAccountSelect();
    renderOverview(data);
    if(!$('tab-overview').classList.contains('hidden'))void refreshActivityRanks();
    if(!$('tab-overview').classList.contains('hidden'))void refreshActivityStatistics();
    if(!$('tab-overview').classList.contains('hidden'))maybeRefreshWorldMap();
    $('hint').textContent = '';
    paintConnection();
  } catch (error) {
    reportError(error, '刷新总览');
    paintConnection();
  } finally { if(overviewPending===account)overviewPending=false; }
}


// ---- 挂机 ------------------------------------------------------------------
const HERO_STATUS = { ready: '可做', done: '已完成', blocked: '不可做' };

let stageVersion = 0;
let stageAccount = null;
function stagePreferences() {
  return { maxFailures: Number($('stage-failures').value) };
}
function renderStages(data) {
  $('stage-start').disabled = data.running || !current;
  $('stage-stop').disabled = !data.running || data.stopping;
  $('stage-failures').disabled = data.running;
  if (data.running) $('stage-failures').value = data.maxFailures;
  const details = data.stage ? '第 ' + data.stage + ' 关 · 已过 ' + data.wins + ' 关 · 连续失败 ' + data.failures + ' 次' : '';
  $('stage-view').textContent = [data.stopping ? '正在停止，等待在途战报' : data.running ? '自动挑战中' : data.stage ? '已停止' : '未开启', details, data.reason==='尚未开启'?'':data.reason].filter(Boolean).join('　');
}
async function refreshStages() {
  if(document.hidden)return;
  if ($('tab-stages').classList.contains('hidden')) return;
  const version = ++stageVersion;
  const account = current;
  if (stageAccount !== account) {
    stageAccount = account;
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('stages:' + account)) || {}; } catch {}
    $('stage-failures').value = saved.maxFailures || 3;
    $('stage-start').disabled = $('stage-stop').disabled = true;
    $('stage-view').textContent = '正在读取状态';
  }
  if (!account) { $('stage-view').textContent = '请先选择账号'; return; }
  try {
    const data = await call('/api/stages');
    if (current === account && stageVersion === version) renderStages(data);
  } catch (error) {
    if (current === account && stageVersion === version) { reportError(error); }
  }
}
async function stageCommand(start) {
  const account = current;
  const prefs = stagePreferences();
  if (start && (!Number.isSafeInteger(prefs.maxFailures) || prefs.maxFailures < 1)) {
    reportError(new Error('失败停止次数需要填写正整数'), '主线推关');
    return;
  }
  ++stageVersion;
  $('stage-start').disabled = $('stage-stop').disabled = true;
  try {
    const data = await call('/api/stages/' + (start ? 'start' : 'stop'), {
      method: 'POST', body: JSON.stringify({ confirm: true, ...prefs }),
    });
    if (start) { try { localStorage.setItem('stages:' + account, JSON.stringify(prefs)); } catch {} }
    if (account === current) renderStages(data);
  } catch (error) {
    if (account === current) { reportError(error); }
  } finally { refreshStages(); }
}
$('stage-start').onclick = () => stageCommand(true);
$('stage-stop').onclick = () => stageCommand(false);

let loopVersion = 0;
let loopAccount = null,loopFieldDefaults=null;
const savingTasks = new Set();
let loopSettingsRevision = null;
function selectIdleGroup(value) {
  document.querySelector('[aria-label="挂机设置分组"]').hidden=false;
  $('idle-search').value='';$('idle-filter').value='all';for(const row of document.querySelectorAll('.task-setting'))row.hidden=false;$('idle-filter-count').textContent='';
  document.querySelectorAll('[data-idle-group]').forEach(tab=>tab.setAttribute('aria-selected',String(tab.dataset.idleGroup===String(value))));
  document.querySelectorAll('[data-idle-panel]').forEach(panel=>panel.hidden=panel.dataset.idlePanel!==String(value));
}
for(const button of document.querySelectorAll('[data-idle-group]')) {
  button.onclick=()=>selectIdleGroup(button.dataset.idleGroup);
  button.onkeydown=event=>{
    const buttons=[...document.querySelectorAll('[data-idle-group]')],at=buttons.indexOf(button);
    const next=event.key==='ArrowRight'?(at+1)%buttons.length:event.key==='ArrowLeft'?(at+buttons.length-1)%buttons.length:event.key==='Home'?0:event.key==='End'?buttons.length-1:null;
    if(next!==null){event.preventDefault();buttons[next].click();buttons[next].focus();}
  };
}
const taskInputs = [...document.querySelectorAll('[data-auto-task]:not([data-legacy])')];
function setTaskSwitch(input, enabled) {
  input.setAttribute('aria-checked', String(enabled));
  input.dataset.state = enabled ? 'checked' : 'unchecked';
  input.querySelector('[data-slot=switch-thumb]').dataset.state = input.dataset.state;
}
const pirateAdvanceErrors=new Map();
const pirateFailureOptions=new Map();
function renderPirateAdvance(data) {
  if(!data)return;
  $('pirate-advance-start').disabled=data.running || !current;
  $('pirate-advance-stop').disabled=!data.running || data.stopping;
  $('pirate-manual-failures').disabled=!!data.running;
  if(data.running)$('pirate-manual-failures').value=data.maxFailures;
  $('pirate-advance-state').textContent=[data.stopping?'正在停止':data.running?'推进中':'未运行',data.target,'本次已首杀 '+data.wins+' 级 · 已用汽油 '+data.spent,pirateAdvanceErrors.get(current)||data.reason].filter(Boolean).join(' · ');
}
async function pirateAdvanceCommand(start) {
  const account=current;
  const maxFailures=Number($('pirate-manual-failures').value);
  if(start&&(!$('pirate-manual-failures').reportValidity()||!Number.isSafeInteger(maxFailures)))return;
  if(start)pirateFailureOptions.set(account,maxFailures);
  pirateAdvanceErrors.delete(account);
  if(start && !await configFlush()){reportError(new Error('海盗参数尚未保存，请先处理配置页的提示'));return;}
  if(account!==current)return;
  $('pirate-advance-start').disabled=$('pirate-advance-stop').disabled=true;
  try{const data=await call('/api/pirates/advance/'+(start?'start':'stop'),{method:'POST',body:JSON.stringify({confirm:true,...(start?{maxFailures}:{})})});if(account===current)renderPirateAdvance(data);}
  catch(error){if(account===current){pirateAdvanceErrors.set(account,error.message);$('pirate-advance-state').textContent='未启动：'+error.message;reportError(error);}}
  finally{if(account===current)refreshLoop();}
}
$('pirate-advance-start').onclick=()=>pirateAdvanceCommand(true);
$('pirate-advance-stop').onclick=()=>pirateAdvanceCommand(false);
let overviewLoopData=null,overviewLoopOwner=null,overviewRenderKey="";
function compactOverviewText(text){
 return String(text||'—').replaceAll('本次连接尚无检查结果','待检查').replaceAll('尚未同步当前条件','待同步')
   .replaceAll('当前没有可读取的万吨货轮','暂无万吨货轮').replaceAll('当前不在服务器','未到')
   .replaceAll('受总控限制：','受限：').replaceAll('当前没有新的联盟福利礼包','暂无联盟福利礼包');
}
function renderAutomationOverview(data){
 overviewLoopData=data;overviewLoopOwner=current;
 const root=$('overview-task-groups'),opened=new Set([...root.querySelectorAll('details[open]')].map(d=>d.dataset.group));
 const query=$('overview-task-search').value.trim().toLowerCase(),mode=$('overview-task-filter').value;
 const issue=t=>t.enabled&&(t.blockedBy?.length||['error','pending'].includes(t.observation?.state));
 const controls=(data.controls??[]).map(t=>({...t,group:t.group==='总控制'?'运行范围与权限':t.group}));
 const renderKey=JSON.stringify([current,data.running,query,mode,controls,data.fleetMaintenance]);if(renderKey===overviewRenderKey)return;overviewRenderKey=renderKey;
 const filterKey=JSON.stringify([current,query,mode]);
 const previousGroups=root.filterKey===filterKey?new Set([...root.children].map(s=>s.dataset.group)):new Set();
 root.filterKey=filterKey;
 const expanded=key=>previousGroups.has(key)?opened.has(key):!!query||mode==='issues'||opened.has(key);
 const focusedGroup=document.activeElement?.closest('.overview-task-group')?.dataset.group;clear(root);
 if(!Array.isArray(data.controls)){clear(root);$('overview-task-summary').textContent='未同步';return;}
 const selected=controls.filter(t=>(mode==='all'||mode==='enabled'&&t.enabled||mode==='issues'&&issue(t))&&(!query||(t.label+' '+(t.observation?.text??'')).toLowerCase().includes(query)));
 $('overview-task-summary').textContent=(data.running?'运行中':'已停止')+' · 已开 '+controls.filter(t=>t.enabled).length+' · 异常/受限 '+controls.filter(issue).length+((query||mode!=='enabled')?' · 筛出 '+selected.length:'');
 for(const group of [...new Set(selected.map(t=>t.group))]){
  const items=selected.filter(t=>t.group===group),section=el('details','overview-task-group');section.dataset.group=group;section.open=expanded(group);
  section.append(el('summary','',group+' · '+items.length+' 项'));
  section.append(table(['功能','当前进度','当前条件'],items.map(t=>[t.label,compactOverviewText(t.progress),compactOverviewText(t.condition||t.observation?.text||'待同步')])));
  root.append(section);if(group===focusedGroup)section.querySelector('summary').focus({preventScroll:true});
 }
 const maintenance=data.fleetMaintenance,repairRows=(maintenance?.rows??[]).filter(r=>(!query||('战后维修 '+r.name+' '+r.source+' '+r.condition).toLowerCase().includes(query))&&(mode!=='issues'||['waiting','unknown'].includes(r.state)));
 const maintenanceShown=maintenance&&(mode==='all'||maintenance.enabled)&&(repairRows.length||(!query||'战后维修'.includes(query))&&maintenance.reason);
 if(maintenanceShown){
  const section=el('details','overview-task-group');section.dataset.group='fleet-maintenance';section.open=expanded('fleet-maintenance');section.append(el('summary','','战后维修 · '+repairRows.length+' 队'));
  section.append(el('p','dim','沿用城战/巨轮所选舰队和自动维修参数；重复选择按调度优先级取参数。'));
  if(maintenance.reason)section.append(el('p','dim',maintenance.reason));
  if(repairRows.length)section.append(table(['舰队','当前进度','当前条件'],repairRows.map(r=>[r.name+' · '+r.source,(r.durability??'未同步')+'/'+(r.maxDura??'未同步'),maintenance.enabled?r.condition:'监控未运行；'+r.condition])));
  root.append(section);
 }
 if(!selected.length&&!maintenanceShown)root.append(el('p','dim','没有符合当前筛选的项目。'));
}
$('overview-task-search').oninput=()=>{if(overviewLoopData&&overviewLoopOwner===current)renderAutomationOverview(overviewLoopData);};
$('overview-task-filter').onchange=$('overview-task-search').oninput;
$('idle-go-settings').onclick=()=>document.querySelector('#tabs [data-tab="settings"]').click();
$('idle-go-overview').onclick=()=>{document.querySelector('#tabs [data-tab="overview"]').click();$('overview-task-summary').scrollIntoView({block:'center'});};
function filterIdleControls(){
 const query=$('idle-search').value.trim().toLowerCase(),mode=$('idle-filter').value;let count=0;
 for(const input of taskInputs){const row=input.closest('.task-setting');const match=(!query||row.textContent.toLowerCase().includes(query))&&(mode!=='enabled'||input.getAttribute('aria-checked')==='true')&&(mode!=='blocked'||row.dataset.blocked==='true');row.hidden=!match;if(match)count++;}
 const filtering=!!query||mode!=='all';
 document.querySelector('[aria-label="挂机设置分组"]').hidden=filtering;
 for(const panel of document.querySelectorAll('[data-idle-panel]'))panel.hidden=filtering?![...panel.querySelectorAll('.task-setting')].some(row=>!row.hidden):document.querySelector('[data-idle-group="'+panel.dataset.idlePanel+'"]').getAttribute('aria-selected')!=='true';
 $('idle-filter-count').textContent=filtering?'跨分组找到 '+count+' 项':'';
}
function openChallengeConfig(id){
  const hash='#config-group-'+id;
  if(location.hash!==hash)location.hash=hash;
  else{activateConsolePage(document.querySelector('#tabs [data-tab="settings"]'));configApplyHash();}
}
$('single-go-pirate').onclick=()=>openChallengeConfig('pirate-hunt');
$('single-go-stages').onclick=()=>openChallengeConfig('progression');
$('single-go-mutual').onclick=()=>activateConsolePage(document.querySelector('#tabs [data-tab=resources]'),'guild');
$('idle-search').oninput=filterIdleControls;$('idle-filter').onchange=filterIdleControls;
function renderLoop(data) {
  renderAutomationOverview(data);
  renderPirateAdvance(data.pirateAdvance);
  $('runtime-version').textContent='当前服务加载时间：'+(data.runVersion?new Date(data.runVersion).toLocaleString('zh-CN'):'旧版服务，等待加载本次更新');
  if(data.singleTasks)$('single-task-status').textContent='手动任务 · 首杀：'+(data.singleTasks.pirate?.running?'运行中':'未启动')+' · 主线：'+(data.singleTasks.stages?.running?'运行中':'未启动')+' · 联盟互助：'+(data.singleTasks.mutual?.running?'运行中':'未启动');
  const challenge=data.challenges??{},challengeNotes=[challenge.mainline?.reason&&'主线：'+challenge.mainline.reason,...Object.entries(challenge.trials??{}).map(([id,row])=>row.reason&&'试炼'+id+'：'+row.reason),challenge.pirate?.reason&&'海盗：'+challenge.pirate.reason].filter(Boolean);
  $('challenge-run-state').textContent=challengeNotes.join('；')||'推关与讨伐尚无执行记录';
  loopSettingsRevision = data.settingsRevision;
  for (const input of taskInputs) {
    if (savingTasks.has(current + ':' + input.dataset.autoTask)) continue;
    const task = (data.controls ?? []).find(t => t.key === input.dataset.autoTask);
    setTaskSwitch(input, task?.enabled === true);
    input.closest('.task-setting').dataset.blocked=String(task?.enabled&&!!task?.blockedBy?.length);
    input.title=task?.blockedBy?.length?'需先开启：'+task.blockedBy.join('、'):'';
    input.disabled = false;
  }
  if (loopAccount !== current || data.running) {
    $('loop-every').value = data.everyMs / 1000;
    $('loop-rounds').value = data.rounds;
    loopFieldDefaults={rounds:data.rounds,seconds:data.everyMs/1000};
  }
  filterIdleControls();
  loopAccount = current;
  $('loop-every').disabled = $('loop-rounds').disabled = data.running;
  $('loop-start').disabled = data.running;
  $('loop-stop').disabled = !data.running || data.stopping;
  $('loop-hint').textContent = (data.recovery ? '网络恢复中（第 ' + data.recovery.attempt + ' 次），已完成 ' : data.running ? '后台挂机中，已完成 ' : '未在挂机，累计 ') + data.completed + ' 轮' + (data.error ? '，已中止' : '');
  if (data.stopping) $('loop-hint').textContent = '正在暂停，等待在途请求结束';

}

let loopReads = 0;
async function refreshLoop() {
  if(document.hidden)return;
  const account = current, version = ++loopVersion;
  if ($('tab-idle').classList.contains('hidden')&&$('tab-overview').classList.contains('hidden')&&$('tab-settings').classList.contains('hidden')) return;
  if (loopAccount !== account || !account) {
    $('loop-hint').textContent = account ? '正在读取设置' : '请选择账号';
    for (const input of taskInputs) {
      input.disabled = true;
      setTaskSwitch(input, false);

    }
    if(overviewLoopOwner!==account){overviewLoopData=null;overviewLoopOwner=account;overviewRenderKey='';clear($('overview-task-groups'));$('overview-task-summary').textContent=account?'正在读取运行状态':'请先选择账号';}
    loopSettingsRevision = null;
    $('pirate-advance-start').disabled=$('pirate-advance-stop').disabled=true;
    $('pirate-advance-state').textContent=account?'正在读取首杀状态':'请选择账号';
    $('pirate-manual-failures').value=pirateFailureOptions.get(account)??1;
    $('loop-start').disabled = $('loop-stop').disabled = true;
  }
  if (!account) return;
  loopReads++;
  try {
    const data = await call('/api/loop');
    if (account === current && version === loopVersion) renderLoop(data);
  } catch {
    /* call 已记录错误 */
  } finally {
    loopReads--;
  }
}

async function toggleAutoTask(input) {
  const account = current, key = input.dataset.autoTask, saving = account + ':' + key;
  if (savingTasks.has(saving)) return;
  const enabled = input.getAttribute('aria-checked') !== 'true';
  savingTasks.add(saving);
  input.disabled = true;
  ++loopVersion;
  try {
    if (!await configFlush()) throw new Error('配置尚未保存，请先处理配置页的提示');
    if (account !== current) return;
    setTaskSwitch(input, enabled);
    const eventTask = Boolean(input.dataset.eventTask);
    if (eventTask) activityTaskEdits.set(saving, { enabled, pending: true, version: ++activitiesVersion });
    const updated = await call(eventTask ? '/api/loop/task' : '/api/loop/control', { method: 'POST', body: JSON.stringify({ confirm: true, key, enabled, ...(eventTask ? {} : { revision: loopSettingsRevision }) }) });
    if (eventTask) { syncActivityTask(key, enabled, account); activityTaskEdits.set(saving, { enabled, pending: false, version: ++activitiesVersion }); }
    // 草稿仍属于当前账号；configLoad 按版本刷新，不能清空 owner 后绕过未保存保护。
    if (account === current) { loopSettingsRevision = updated.settingsRevision; }
  } catch (error) { if (input.dataset.eventTask) activityTaskEdits.delete(saving); if(account===current){setTaskSwitch(input, !enabled); reportError(error);} }
  finally {
    savingTasks.delete(saving);
    if (account === current) {
      if (input.dataset.eventTask) {
        for (const toggle of document.querySelectorAll('[data-event-task]')) {
          if (toggle.dataset.autoTask !== key) continue;
          setTaskSwitch(toggle, input.getAttribute('aria-checked') === 'true');
          toggle.disabled = false;
        }
      }
      else refreshLoop();
    }
  }
}
for (const input of taskInputs) input.onclick = () => toggleAutoTask(input);

$('loop-start').onclick = async () => {
  const account = current;
  if (!await configFlush()) { reportError(new Error('配置尚未保存，请先处理配置页的提示')); return; }
  if (account !== current) return;
  try {
    await call('/api/loop/start', {
      method: 'POST',
      body: JSON.stringify({
        confirm: true,
        rounds: Number($('loop-rounds').value || 0),
        everySeconds: Number($('loop-every').value || 60),
      }),
    });
    refreshLoop();
  } catch (error) {
    $('loop-hint').textContent = '';
    reportError(error);
  }
};
$('loop-stop').onclick = async () => {
  try {
    await call('/api/loop/stop', { method: 'POST', body: JSON.stringify({ confirm: true }) });
    refreshLoop();
  } catch (error) {
    $('loop-hint').textContent = '';
    reportError(error);
  }
};

let orderClockOffset=0;
bindGameAction('loot-run', async () => {
  const account = current;
  if (snapshot.paused || disconnected.has(account)) return;
  $('loot-hint').textContent = '领取中…';
  try {
    const data = await call('/api/loot/run', { method: 'POST', body: JSON.stringify({ confirm: true }) });
    if (current === account) $('loot-hint').textContent = data.summary || '本轮领取结束，结果见运行日志';
  } catch (error) {
    if (current === account) $('loot-hint').textContent = '';
    throw error;
  }
});
bindGameAction('tasks-plan', async () => {
  const account = current;
  if (snapshot.paused || disconnected.has(account)) return;
  $('tasks-hint').textContent = '检查中…';
  try {
    const data = await call('/api/tasks');
    if (current !== account) return;
    $('tasks-hint').textContent = '可领 ' + data.plan.length + ' 项';
    logReport('任务奖励：可领 ' + data.plan.length + ' 条', data.text);
  } catch (error) {
    if (current === account) $('tasks-hint').textContent = '';
    throw error;
  }
});
bindGameAction('tasks-run', async () => {
  const account = current;
  if (snapshot.paused || disconnected.has(account)) return;
  $('tasks-hint').textContent = '领取中…';
  try {
    const data = await call('/api/tasks/run', { method: 'POST', body: JSON.stringify({ confirm: true }) });
    if (current !== account) return;
    const summary = '本轮成功领取 ' + data.results.filter(entry => entry.ok).length + ' 项';
    $('tasks-hint').textContent = summary;
    logReport('任务奖励：' + summary, data.text);
  } catch (error) {
    if (current === account) $('tasks-hint').textContent = '';
    throw error;
  }
});
function orderRefreshLabel(at){
 const left=Math.max(0,Math.ceil(at-(Date.now()+orderClockOffset)/1000));
 const time=new Date(at*1000).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
 return time+' 刷新 · '+(left?('剩余 '+Math.floor(left/60)+'分'+left%60+'秒'):'已到时，等待同步');
}
setInterval(()=>{if(document.hidden||$('tab-manual').classList.contains('hidden'))return;for(const node of document.querySelectorAll('[data-order-refresh-at]'))node.textContent=orderRefreshLabel(Number(node.dataset.orderRefreshAt));},1000);
function orderState(order, data) {
  const box = el('div', 'order-state');
  const decision = order.decision;
  const labels = { ready: data.idleRunning ? '等待自动交付' : '等待开启挂机', disabled: '自动交付已关闭', refreshing: '订单刷新中',
    unknown: '等待核对', missing: '材料不足', reserved: '材料已预留', reroll: '等待换单' };
  const state = decision?.status ?? 'unknown';
  const label = !data.autoDeliverOrders && !['reroll','refreshing'].includes(state) ? labels.disabled : labels[state] || labels.unknown;
  box.appendChild(chip(state === 'ready' && data.idleRunning && data.autoDeliverOrders ? 'ready' : 'waiting', label));
  if(order.refreshTime>0){const time=el('span','order-refresh-time',orderRefreshLabel(order.refreshTime));time.dataset.orderRefreshAt=String(order.refreshTime);box.append(time);}
  if (decision?.reason) box.appendChild(el('span', 'dim', decision.reason));
  return box;
}

const pendingResidentOrders = new Set();
function residentOrderButton(order) {
  const account = current, key = account + ':' + order.index;
  const pending = pendingResidentOrders.has(key);
  const button = smallButton(pending ? '提交中…' : '提交订单');
  button.dataset.residentOrder = String(order.index);
  const ready = Boolean(order.orderKey) && order.manualDecision?.status === 'ready';
  button.disabled = pending || !ready || !account || snapshot.paused || disconnected.has(account);
  button.title = pending ? '账号忙时自动排队，结果见运行日志'
    : ready ? '提交这份居民订单' : order.manualDecision?.reason || '请先刷新订单状态';
  button.setAttribute('aria-label', '提交' + (order.workerName || '居民') + '的订单 #' + order.index);
  button.onclick = async () => {
    if (button.disabled || pendingResidentOrders.has(key) || current !== account || snapshot.paused || disconnected.has(account)) return;
    pendingResidentOrders.add(key);
    button.disabled = true;
    button.textContent = '提交中…';
    try {
      await call('/api/world/order/submit', { method: 'POST', body: JSON.stringify({ confirm: true, index: order.index, orderKey: order.orderKey }) });
    } catch (error) {
      if (current === account) reportError(error, '提交居民订单');
    } finally {
      pendingResidentOrders.delete(key);
      if (current === account) {
        const displayed = $('world-orders').querySelector('[data-resident-order="' + order.index + '"]');
        if (displayed) {
          displayed.disabled = true;
          displayed.textContent = '待刷新';
        }
        refreshManualWorld(true);
      }
    }
  };
  return button;
}

function residentOrderActions(order){
 const root=el('div','order-manual-actions');root.append(residentOrderButton(order));
 const account=current,key=account+':'+order.index,button=smallButton('换单');button.setAttribute('aria-label','刷新'+(order.workerName||'居民')+'的订单 #'+order.index);
 button.disabled=pendingResidentOrders.has(key)||!order.manualRefresh?.allowed||!account||snapshot.paused||disconnected.has(account);button.title=order.manualRefresh?.reason||'放弃当前需求，等待新订单';
 button.onclick=()=>{if(button.disabled||current!==account||pendingResidentOrders.has(key))return;
  openConfirm('刷新居民订单',[el('p','','确认放弃'+(order.workerName||'居民')+'的订单 #'+order.index+'并换一单？'),el('p','dim','新需求按游戏刷新时间到达，不使用付费加速。')],async()=>{
   if(current!==account||snapshot.paused||disconnected.has(account)||pendingResidentOrders.has(key))throw Error('账号或订单状态已变化，请刷新后再试');
   pendingResidentOrders.add(key);button.disabled=true;button.textContent='换单中…';
   try{await call('/api/world/order/reroll',{method:'POST',body:JSON.stringify({confirm:true,index:order.index,orderKey:order.orderKey})});}
   finally{pendingResidentOrders.delete(key);if(current===account)await refreshManualWorld(true);}
  });
 };root.append(button);return root;
}

function renderWorld(data) {
  orderClockOffset=Number.isFinite(data.serverNow)?data.serverNow*1000-Date.now():0;
  $('world-view').textContent = '';
  const fbox = clear($('world-factories'));
  if (data.farms?.length) {
    fbox.appendChild(el('h2', null, '农田'));
    const plots = [...data.farms].sort((a, b) => a.plot.localeCompare(b.plot, 'zh-CN', { numeric: true }));
    const grid = el('table', 'farm-grid'); grid.setAttribute('aria-label', '农田状态');
    const body = el('tbody');
    for (let i = 0; i < plots.length; i += 3) {
      const row = el('tr');
      for (let j = 0; j < 3; j++) {
        const plot = plots[i + j], cell = el('td');
        if (plot) cell.append(el('strong', 'farm-plot', plot.plot), el('span', 'farm-status', plot.status));
        else cell.setAttribute('aria-hidden', 'true');
        row.appendChild(cell);
      }
      body.appendChild(row);
    }
    grid.appendChild(body); fbox.appendChild(grid);
  }
  // 空位：没盖的（待建）与正在盖的（施工中）。计划器只会建「待建」那些，
  // 施工中的只能等它盖完由竣工步骤收尾，所以两种状态要分开说，不然看不出差在哪。
  const slots = (data.buildings || []).filter((b) => b.level === 0);
  if (slots.length) {
    fbox.appendChild(el('h2', null, '空位'));
    fbox.appendChild(table(['空位', '类型', '状态'], slots.map((b) => [
      { cell: b.icon, text: b.buildingId },
      b.typeName || b.type || '未知类型',
      b.building ? chip('waiting', '施工中') : b.awaitingFinish ? chip('ready', '待竣工') : chip('ready', '待建'),
    ])));
  }
  if (data.factories.length) {
    fbox.appendChild(el('h2', null, '工厂'));
    fbox.appendChild(table(['建筑', '类型', '等级', '队列', '自动生产'], data.factories.map((b) => [
      { cell: b.icon, text: b.buildingId },
      b.typeName || b.type,
      'lv' + b.level,
      String(b.queue),
      b.auto || '未设置',
    ])));
  }
  const obox = clear($('world-orders'));
  if (data.orders.length) {
    obox.appendChild(el('h2', null, '居民订单'));
    obox.appendChild(el('p', 'dim', '可手动提交材料已齐的订单。账号忙时自动排队，交付结果见运行日志。'));
    obox.appendChild(table(['订单', '居民', '需求', '挂机交付', '手动操作'], data.orders.map((o) => [
      '#' + o.index,
      { cell: o.workerIcon, text: (o.workerName || '未知居民') + (o.isSpecial ? '（特殊）' : '') },
      o.requirements.length && o.decision?.status !== 'refreshing' ? { cells: o.requirements } : '—',
      orderState(o, data),
      residentOrderActions(o),
    ])));
  }
  renderInventory(data.stock);
  const fields=clear($('world-fields'));fields.append(el('p','dim','已占资源田 '+(data.resFields.fields?.length??'?')+'/'+(data.resFields.maxNum??'?')));
  const yields=el('div','field-yield-summary');yields.setAttribute('aria-label','资源田每小时基础总产量');for(const item of data.resFields.totals??[])yields.append(el('span','',item.name+' '+(item.perHour===null?'未同步':fmt(item.perHour)+'/小时')));fields.append(yields);
  if(data.resFields.rows?.length)fields.append(table(['建筑','产出','等级'],data.resFields.rows.map(r=>[r.name+' · '+r.cityName,r.product,r.level??'未同步'])));
  else fields.append(el('p','dim',data.resFields.fields?.length?'资源田信息未同步，请重新加载服务':'暂无已占资源田'));
  fields.append(el('p','dim','产出为每小时基础值，不含科技及其他加成。'));
}

let worldVersion = 0, worldRead = null, displayedWorldAccount;
function refreshManualWorld(force = false) {
  if (force) { worldVersion++; worldRead = null; }
  if ($('tab-manual').classList.contains('hidden')&&$('tab-inventory').classList.contains('hidden')) return;
  const account = current;
  const available = account && !snapshot.paused && !disconnected.has(account);
  if (displayedWorldAccount !== account || !available) {
    $('inventory-status').textContent='正在读取库存';
    displayedWorldAccount = account;
    resetInventory();
    worldVersion++;
    worldRead = null;
    for (const id of ['world-factories', 'world-orders', 'world-stock', 'world-fields', 'world-hint']) clear($(id));
    $('world-view').textContent = !account ? '请先选择账号' : !available ? '账号已断开连接' : '正在读取海面数据…';
  }
  if (!available || worldRead?.account === account) return;
  const version = ++worldVersion;
  worldRead = { account, version };
  $('world-hint').textContent = '正在读取…';
  call('/api/world?speedUp=' + isChecked($('world-speedup'))).then(data => {
    if (version === worldVersion && current === account) renderWorld(data);
  }).catch(error => {
    if (version === worldVersion && current === account) {
      $('inventory-status').textContent='库存读取失败，请重试';
      $('world-view').textContent = '海面数据读取失败，可点「刷新数据」重试。';
      reportError(error);
    }
  }).finally(() => {
    if (worldRead?.version === version) worldRead = null;
    if (version === worldVersion) $('world-hint').textContent = '';
  });
}
$('inventory-refresh').onclick=()=>refreshManualWorld(true);
$('world-plan').onclick = () => refreshManualWorld();
$('world-speedup').onclick = () => { setTaskSwitch($('world-speedup'), !isChecked($('world-speedup'))); refreshManualWorld(true); };
bindGameAction('world-run', async () => {
  const account = current;
  $('world-hint').textContent = '执行中 ...';
  try {
    const body = { confirm: true, speedUp: isChecked($('world-speedup')), reroll: isChecked($('world-reroll')) };
    const data = await call('/api/world/run', { method: 'POST', body: JSON.stringify(body) });
    if (account !== current || disconnected.has(account)) return;
    worldVersion++;
    $('world-hint').textContent = '执行 ' + data.results.length + ' 个动作，失败 ' + data.results.filter((r) => r.ok === false).length;
    if (!data.refreshError) renderWorld(data);
  } catch (error) {
    $('world-hint').textContent = '';
    reportError(error);
  }
});

// ---- 英雄 ------------------------------------------------------------------
function renderAppointments(data) {
  const box = clear($('appoint-table'));
  box.appendChild(el('div', 'dim', '已任命 ' + data.occupied + '/' + data.slots.length + ' 个开放职位'));
  if (data.slots.length) box.appendChild(table(['职位', '效果', '英雄'], data.slots.map(slot => [String(slot.id), slot.effect, slot.hero || '空缺'])));
}
bindGameAction('appoint-view', async () => {
  const account = current;
  const result = await call('/api/appointments');
  if (account === current) renderAppointments(result);
});
bindGameAction('appoint-run', async () => {
  const account = current;
  const result = await call('/api/appointments/run', { method: 'POST', body: JSON.stringify({ confirm: true }) });
  if (account === current) renderAppointments(result);
});
// 技能是一串等级，原始形状是 [1,0,0,0]，直接摆给用户看没意义，只说练了几项。
function skillText(levels) {
  const list = levels || [];
  if (!list.length) return '—';
  const raised = list.filter((level) => level > 0);
  return raised.length ? '已升 ' + raised.length + '/' + list.length : '未升级';
}

function renderHeroes(data) {
  $('hero-view').textContent = data.text;
  const box = clear($('hero-table'));
  const planned = new Set(data.steps.map(step => step.heroId));
  if (!planned.size) return;
  box.appendChild(table(['英雄', '等级', '星级', { label: '战力', num: true }, '技能'], data.heroes.filter(hero => planned.has(hero.heroId)).map((hero) => [
    { cell: hero.head || hero.icon, text: hero.heroId },
    'lv' + hero.level,
    hero.star + ' 星',
    { num: true, text: fmt(hero.power) },
    skillText(hero.skillLevels),
  ])));
}

$('hero-plan').onclick = async () => {
  $('hero-hint').textContent = '计算中 ...';
  try {
    renderHeroes(await call('/api/heroes'));
    $('hero-hint').textContent = '';
  } catch (error) {
    $('hero-hint').textContent = '';
    reportError(error);
  }
};
bindGameAction('hero-run', async () => {
  $('hero-hint').textContent = '执行中 ...';
  try {
    const data = await call('/api/heroes/run', { method: 'POST', body: JSON.stringify({ confirm: true }) });
    $('hero-hint').textContent = '发出 ' + data.sent + ' 个请求，失败 ' + data.failed + '，跳过 ' + data.skipped + '，耗时 ' + Math.round(data.ms / 1000) + 's';
    $('hero-plan').onclick();
  } catch (error) {
    $('hero-hint').textContent = '';
    reportError(error);
  }
});

// ---- 日常 ------------------------------------------------------------------
const DAILY_LABEL = { ready: '可做', paid: '需付费', partial: '部分可做', waiting: '等待中', done: '已完成', blocked: '不可用', error: '出错', unknown: '未知' };

function dailyOperation(entry, account) {
  const cell = el('div', 'daily-operation');
  if (!entry.manual?.token) {
    const reason = entry.manual?.reason || '请重新探测';
    cell.textContent = reason === entry.reason ? '暂无操作' : reason;
    cell.title = reason; return cell;
  }
  const button = smallButton(entry.manual.label);
  button.disabled = pendingDailyAccounts.has(account) || snapshot.paused || disconnected.has(account);
  button.onclick = async () => {
    if (account !== current || snapshot.paused || disconnected.has(account) || pendingDailyAccounts.has(account)) return;
    pendingDailyAccounts.add(account); button.disabled = true; button.textContent = '执行中…';
    $('dailies-hint').textContent = '正在处理“' + entry.task.title + '”…';
    let outcome;
    try {
      outcome = await call('/api/dailies/single', { method: 'POST', body: JSON.stringify({ confirm: true, token: entry.manual.token, paid: isChecked($('dailies-paid')) }) });
    } catch (error) { if (account === current) { outcome = { label: error.message }; reportError(error); } }
    finally {
      pendingDailyAccounts.delete(account);
      if (account === current) {
        await refreshDailyView();
        if (outcome) $('dailies-hint').textContent = outcome.label;
      }
    }
  };
  cell.appendChild(button); return cell;
}
function renderDailies(data, account = current) {
  if (account !== current) return;
  dailyAccount = account;
  const box = clear($('dailies-table'));
  const taskTable = table(['任务', '进度', '状态', '动作 / 原因', '完成操作'], data.tasks.map((entry) => [
    entry.task.title,
    entry.task.progress + '/' + entry.task.targetProgress,
    chip(entry.status, DAILY_LABEL[entry.status] || entry.status),
    entry.status === 'ready' || entry.status === 'paid' || entry.status === 'partial'
      ? (entry.actions || []).map((a) => a.cost || a.request).join('；') || '直接完成'
      : (entry.reason || ''),
    dailyOperation(entry, account),
  ]));
  taskTable.classList.add('daily-tasks');
  box.appendChild(taskTable);
  if (data.chests) {
    const line = (label, chest) => {
      const tiers = chest.tiers || [];
      const tail = tiers.length
        ? '第 ' + tiers.map((t2) => t2.id).join(' / ') + ' 档'
        : (chest.nextAt == null ? '这一季的档位都领完了' : '下一档要 ' + chest.nextAt + ' 点活跃');
      return [label, chest.activity + ' 活跃', chip(tiers.length ? 'ready' : 'done', tiers.length ? '可领' : '不欠'), tail];
    };
    box.appendChild(table(['活跃奖励', '活跃度', '状态', '动作 / 原因'], [
      line('每日宝箱', data.chests.daily),
      line('每周宝箱', data.chests.weekly),
    ]));
  }
  if (data.gift) {
    const free = data.gift.freeAvailable;
    box.appendChild(table(['每日礼包', '状态', '动作 / 原因'], [
      ['每日精选赠礼', chip(free ? 'ready' : 'done', free ? '可领' : '已领'),
        free ? '免费，一键领取会顺手领掉' : '今天那份已经领过了，明天 0 点重置'],
    ]));
  }
}

async function refreshDailyView() {
  const account = current, version = ++dailyVersion;
  if (!account || snapshot.paused || disconnected.has(account)) {
    clear($('dailies-table')); $('dailies-hint').textContent = snapshot.paused ? '账号已暂停' : '请先连接当前账号'; return;
  }
  $('dailies-hint').textContent = '探测中 ...';
  try {
    const data = await call('/api/dailies');
    if (account !== current || version !== dailyVersion) return;
    renderDailies(data, account);
    $('dailies-hint').textContent = '';
  } catch (error) {
    if (account !== current || version !== dailyVersion) return;
    $('dailies-hint').textContent = '读取失败，请重新探测';
    reportError(error);
  }
}
$('dailies-plan').onclick = refreshDailyView;
bindGameAction('dailies-run', async () => {
  const account = current;
  const paid = isChecked($('dailies-paid'));
  $('dailies-hint').textContent = '执行中 ...';
  try {
    const data = await call('/api/dailies/run', { method: 'POST', body: JSON.stringify({ confirm: true, paid }) });
    if (account !== current) return;
    $('dailies-hint').textContent = '完成 ' + data.results.filter((r) => r.ok).length + ' 个动作，失败 ' + data.results.filter((r) => r.ok === false).length + '，领取奖励 ' + data.claimed.length + ' 个，耗时 ' + Math.round(data.ms / 1000) + 's';
    renderDailies(data);
  } catch (error) {
    $('dailies-hint').textContent = '';
    reportError(error);
  }
});

// ---- 表格 ------------------------------------------------------------------
// 单元格可以是字符串、{num}、{chip}、{cell: 图标项}、{cells: [图标项]}
function putCell(td, spec) {
  if (spec == null) return;
  if (spec instanceof Node) {
    td.appendChild(spec);
    return;
  }
  if (typeof spec !== 'object') {
    td.textContent = spec;
    return;
  }
  if (spec.num) {
    td.classList.add('num');
    td.textContent = spec.text;
    return;
  }
  if (spec.chip) {
    td.appendChild(chip(spec.chip, spec.text));
    return;
  }
  if ('cell' in spec || spec.cells) {
    const list = spec.cells ?? [{ name: spec.text, icon: spec.cell }];
    if (spec.prefix) td.appendChild(el('span', 'dim', spec.prefix));
    for (const entry of list) {
      const who = el('span', 'who-cell');
      if (entry?.icon) who.appendChild(iconEl(entry.icon, 26, entry.name));
      who.appendChild(el('span', null, entry ? entry.name + (entry.num != null ? ' x' + fmt(entry.num) : '') : spec.text));
      td.appendChild(who);
      td.appendChild(document.createTextNode(' '));
    }
    if (!list.length) td.appendChild(el('span', 'dim', '齐'));
    return;
  }
  td.textContent = spec.text || '';
}

let sourceIndex;
function renderSourceSearch() {
  const box = clear($('source-results')), query = $('source-query').value.trim();
  if (!query || !sourceIndex) return;
  const matches = sourceIndex.filter(row => row.name.includes(query));
  if (!matches.length) box.textContent = '未找到已配置来源的材料';
  else box.appendChild(table(['材料', '游戏内来源'], matches.map(r => [r.name, r.sources.join('、')])));
}
$('source-query').oninput = renderSourceSearch;

${activitiesScript}

function table(headers, rows) {
  const box = component('ui-table');
  const head = box.querySelector('thead tr');
  const headCell = head.firstElementChild;
  headCell.remove();
  for (const h of headers) {
    const th = headCell.cloneNode(false);
    th.textContent = typeof h === 'string' ? h : h.label;
    if (h.num) th.classList.add('num');
    head.appendChild(th);
  }
  const body = box.querySelector('tbody');
  const rowTemplate = body.firstElementChild;
  const cellTemplate = rowTemplate.firstElementChild;
  rowTemplate.remove();
  const labels = headers.map(h => typeof h === 'string' ? h : h.label);
  if (labels.length >= 4) box.classList.add('table-stack');
  for (const row of rows) {
    const tr = rowTemplate.cloneNode(false);
    row.forEach((spec, index) => {
      const td = cellTemplate.cloneNode(false);
      td.dataset.label = labels[index] ?? '';
      putCell(td, spec);
      tr.appendChild(td);
    });
    body.appendChild(tr);
  }
  return box;
}

// ---- 账号页 ----------------------------------------------------------------
async function exportAccounts(id) {
  try {
    const response = await fetch('/api/accounts/export', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(id ? { id } : { all: true }) });
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || '账号导出失败');
    }
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = (id ? 'account-' : 'accounts-') + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (error) { reportError(error); }
}
$('export-accounts').onclick = () => exportAccounts();
async function renderAccounts() {
  $('export-accounts').disabled = !accounts.length;
  const signature=JSON.stringify([current,accounts.map(a=>[a.id,a.title,a.lastSeen])]);
  if($('accounts').cardSnapshot===signature)return;
  $('accounts').cardSnapshot=signature;
  const details=$('account-details');$('account-detail-home').append(details);
  const box = clear($('accounts'));
  if (!accounts.length) {
    box.appendChild(el('div', 'dim', '还没有账号。先在下面用「从电脑微信添加」，或跑 node tools/capture-credentials.mjs。'));
    return;
  }
  for (const account of accounts) {
    const card = el('div', 'acct' + (account.id === current ? ' on' : ''));
    const top = el('div', 'top');
    top.appendChild(el('span', 'title', account.title));
    top.appendChild(el('span', 'id', account.id.slice(0, 10) + '…'));
    if (account.id === current) top.appendChild(chip('done', '当前'));
    const seen = account.lastSeen;
    const seenWorld = seen && (seen.worldName || seen.worldId);
    const seenInfo = seen
      ? '上次 ' + (seen.nickname || '?') + ' lv' + (seen.level ?? '?') + ' 战力' + fmt(seen.power) + (seenWorld ? ' 区服' + seenWorld : '') + ' @' + when(seen.at)
      : '还没连过';
    top.appendChild(el('span', 'id', seenInfo));
    const use = smallButton(account.id === current ? '已选中' : '切换到它');
    use.disabled = account.id === current;
    use.onclick = async () => {
      if (!await configMayChangeAccount(account.id)) return;
      current = account.id;
      snapshot=account.status??{};renderAccountSelect();
      giftAccountChanged();
      configAccountChanged();
      await call('/api/accounts/active', { method: 'POST', body: JSON.stringify({ confirm: true, id: account.id }) });
      await loadAccounts(true);
      renderAccounts();
    };
    const rename = smallButton('改备注');
    rename.onclick = async () => {
      const label = await accountDialog('修改账号备注', account.title, account.title);
      if (label == null) return;
      await call('/api/accounts/label', { method: 'POST', body: JSON.stringify({ confirm: true, id: account.id, label }) });
      await loadAccounts(false);
      renderAccounts();
    };
    const drop = smallButton('删除', true);
    drop.onclick = async () => {
      if (await accountDialog('删除本机账号', '删除「' + account.title + '」保存在本机的凭证？') === null) return;
      await call('/api/accounts/remove', { method: 'POST', body: JSON.stringify({ confirm: true, id: account.id }) });
      await loadAccounts(true);
      renderAccounts();
    };
    const download = smallButton('导出');
    download.onclick = () => exportAccounts(account.id);
    top.append(use, rename, download, drop);
    card.appendChild(top);
    if(account.id===current)card.append(details);
    box.appendChild(card);
  }
}

$('cred-show').onclick = async () => {
  const owner=current,version=++credentialVersion;
  $('cred-show').disabled = true;
  try {
    const data = await call('/api/accounts/credential?reveal=1');
    if(owner!==current||version!==credentialVersion)return;
    const box = clear($('cred'));
    const rows = [
      ['账号', data.title + '（' + data.id + '）'],
      ['openId', data.raw.openId || '-'],
      ['token', data.raw.token || '-'],
      ['sign', data.raw.sign || '-'],
      ['timestamp', data.raw.timestamp == null ? '-' : String(num(data.raw.timestamp))],
      ['网关', data.url],
      ['抓于', when(data.capturedAt)],
    ];
    const kv = el('div', 'kv');
    for (const [k, v] of rows) {
      kv.appendChild(el('div', 'k', k));
      kv.appendChild(el('div', 'v', v));
    }
    box.appendChild(kv);
    box.appendChild(el('div', 'dim', '登录帧原始数据（' + (data.loginFrameHex || '').length + ' 个十六进制字符）'));
    box.appendChild(el('pre', null, data.loginFrameHex || '（没有保存）'));
  } catch (error) {
    $('hint').textContent = '';
    reportError(error);
  }
  if(owner===current&&version===credentialVersion)$('cred-show').disabled = false;
};
$('cred-hide').onclick=()=>{credentialVersion++;clear($('cred'));$('cred-show').disabled=!current;};

async function renderWorlds() {
  const owner=current;
  const data = await call('/api/worlds');
  if(owner!==current)return;
  const box = clear($('worlds'));
  for (const world of data.recentWorlds) {
    const role = world.role || {};
    const row = el('div', 'acct');
    const top = el('div', 'top');
    top.appendChild(el('span', 'title', world.worldName ? world.worldName + '（' + world.worldId + '）' : String(world.worldId)));
    if (role.worldId && role.worldId !== world.worldId) top.appendChild(el('span', 'id', '合服后 -> ' + (role.worldName ? role.worldName + '（' + role.worldId + '）' : role.worldId)));
    top.appendChild(el('span', 'id', (role.nickname || '') + ' lv' + (role.level ?? '') + ' 战力' + fmt(role.power) + ' 上次登录 ' + when(role.lastLoginTime)));
    const enter = smallButton('进入');
    enter.onclick = () => enterWorld(world.worldId);
    top.appendChild(enter);
    row.appendChild(top);
    box.appendChild(row);
  }
  if (!data.recentWorlds.length) box.appendChild(el('div', 'dim', '这个账号下没有区服'));
  else box.appendChild(el('div', 'dim', '共 ' + data.recentWorlds.length + ' 个区服，分组 ' + data.latestGroupId));
}

async function enterWorld(worldId) {
  const owner=current;
  $('worlds-hint').textContent = '进入 ' + worldId + ' ...';
  try {
    const data = await call('/api/worlds/enter', { method: 'POST', body: JSON.stringify({ confirm: true, worldId, fromWorldId: 0 }) });
    if(owner!==current)return;
    const role = data.player || {};
    $('worlds-hint').textContent = '已在 ' + (role.worldName ? role.worldName + '（' + worldId + '）' : worldId) + '：' + (role.nickname || '') + ' lv' + (role.level ?? '') + ' 战力' + fmt(role.power);
    await loadAccounts(false);
    renderAccounts();
    refreshOverview();
  } catch (error) {
    $('worlds-hint').textContent = '';
    reportError(error);
  }
}

$('load-worlds').onclick = async () => {
  $('worlds-hint').textContent = '加载中 ...';
  try {
    await renderWorlds();
    $('worlds-hint').textContent = '';
  } catch (error) {
    $('worlds-hint').textContent = '';
    reportError(error);
  }
};
$('enter-world').onclick = () => {
  const worldId = Number($('world-input').value.trim());
  if (!worldId) {
    $('worlds-hint').textContent = '先填 worldId';
    return;
  }
  enterWorld(worldId);
};

// ---- 添加账号：从电脑微信采集登录 -----------------------------------------
let capturePoll = null;

const CAPTURE_PHASE_LABELS = {
  idle: '空闲', starting: '启动中', ca: '准备测试证书', listening: '启动本地代理',
  proxy: '设置系统代理', waiting: '等待电脑游戏登录', captured: '已采集登录报文',
  stopping: '停止清理中', error: '未清理干净',
};

function renderCapture(state) {
  const hint = $('cap-hint');
  const previousQr=$('cap-box').querySelector('img'),previousLog=$('cap-box').querySelector('pre');
  const logY=previousLog?.scrollTop??0,logX=previousLog?.scrollLeft??0;
  const box = clear($('cap-box'));
  const cleanupPending = state.phase === 'error';
  $('cap-start').disabled = state.running || cleanupPending;
  $('cap-douyin').disabled = state.running || cleanupPending;
  $('cap-stop').disabled = !state.running && !cleanupPending;
  const phaseLabel = CAPTURE_PHASE_LABELS[state.phase] ?? state.phase;
  hint.textContent = state.error
    ? (cleanupPending ? '清理未完成：' + state.error : state.error)
    : (state.running ? '抓包中：' + phaseLabel : (state.accountId ? '凭证已保存，登录验证结果请查看日志' : ''));
  hint.className = state.error ? 'bad' : 'warn';

  if (state.running || cleanupPending) {
    if (state.running) {
      const steps = el('ol', 'steps');
      const lines = [
        '先登录电脑版' + (state.platform === 'douyin' ? '抖音' : '微信') + '，再从该客户端打开《疯狂水世界》',
        '如果游戏已经打开，请完全退出后重新进入，让它重新发送登录请求',
        '捕获后保存凭证，并尝试读取角色验证登录；验证失败会显示在日志中',
        '完成、失败或等待超时后会自动恢复代理，只移除本次新安装的证书',
      ];
      for (const text of lines) steps.appendChild(el('li', null, text));
      const qr = el('div', 'qr');
      const side = el('div', null, '');
      if (state.platform !== 'douyin' && state.qr && state.qr.kind === 'image') {
        const img=previousQr?.dataset.url===state.qr.url?previousQr:el('img');
        if(!img.dataset.url){img.dataset.url=state.qr.url;img.src=state.qr.url+'?t='+Date.now();}
        img.alt = '游戏入口码（非扫码登录授权）';
        qr.appendChild(img);
      }
      if (state.platform !== 'douyin') side.appendChild(el('div', 'dim', state.qr?.note || '请在电脑微信中打开游戏。'));
      side.appendChild(steps);
      qr.appendChild(side);
      box.appendChild(qr);
    }

    const status = el('div', 'kv');
    const rows = [
      ['阶段', phaseLabel],
      ['系统代理', (state.proxyOn ? '已打开 -> ' + (state.proxy?.ProxyServer ?? '') : '未打开') + '　原值 ' + (state.originalProxy?.ProxyEnable ?? '无') + ' / ' + (state.originalProxy?.ProxyServer ?? '无')],
      ['本地证书', state.caInstalled ? (state.caAddedByCapture ? '本次安装，结束后移除' : '原有证书，结束后保留') : '未安装'],
      ['抓包代理', state.port ? '127.0.0.1:' + state.port : '-'],
    ];
    if (cleanupPending) rows.push(['清理结论', '未清理干净：' + (state.error || '请重试停止') + '（可再次点「停止抓包」重试）']);
    for (const [k, v] of rows) {
      status.appendChild(el('div', 'k', k));
      status.appendChild(el('div', 'v', v));
    }
    box.appendChild(status);
  }

  if (!state.running && !cleanupPending && (state.error || state.capturedAt)) {
    const outcome = el('div', 'kv');
    const rows = [['阶段', '空闲（清理已完成）']];
    if (state.error) rows.push(['结局', state.error]);
    if (state.accountId) rows.push(['账号', state.accountId + '，凭证已保存']);
    for (const [k, v] of rows) {
      outcome.appendChild(el('div', 'k', k));
      outcome.appendChild(el('div', 'v', v));
    }
    box.appendChild(outcome);
  }

  if (state.log && state.log.length) {
    box.appendChild(el('h2', null, '抓包记录'));
    const pre=previousLog||el('pre');const lines=state.log.join(String.fromCharCode(10));
    if(pre.textContent!==lines)pre.textContent=lines;box.appendChild(pre);pre.scrollTop=logY;pre.scrollLeft=logX;
  }
}

async function pollCapture() {
  try {
    const state = await call('/api/capture');
    renderCapture(state);
    if (!state.running && capturePoll) {
      clearInterval(capturePoll);
      capturePoll = null;
      await loadAccounts(true);
      renderAccounts();
    }
  } catch (error) {
    $('cap-hint').textContent = '';
    reportError(error);
  }
}


$('cap-start').onclick = () => beginCapture('wechat');
$('cap-douyin').onclick = () => beginCapture('douyin');
async function beginCapture(platform) {
  let state;
  try {
    state = await call('/api/capture');
  } catch (error) {
    $('cap-hint').textContent = '';
    reportError(error);
    return;
  }
  const body = [
    el('div', null, '抓包只做两处「仅当前用户」的改动，抓到账号后立刻自动还原：'),
    el('div', null, '1. 若缺少证书，Windows 会打开导入向导，目标已选定为当前用户的“受信任的根证书颁发机构”。点击“完成”；若出现安全警告，核对 CrazyWaterWorld Local Test CA 后选择“是”。'),
    el('div', null, '2. 把当前用户的系统代理指向 127.0.0.1:' + state.port + '（原来指向 ' + (state.proxy?.ProxyServer ?? '无') + '，结束后写回）'),
    el('div', null, '使用系统代理的其他程序也会临时经过本机代理；仅解密本游戏网关，结束后恢复原设置。随时可点「停止抓包」。'),
    el('div', null, '采集就绪后，请只在电脑' + (platform === 'douyin' ? '抖音' : '微信') + '里重新打开《疯狂水世界》。'),
    el('div', null, '捕获后会尝试连接游戏验证角色，可能让正在运行的游戏掉线一次。'),
  ];
  openConfirm('开始抓包（将修改当前用户的系统设置）', body, async () => {
    $('cap-hint').textContent = '请在 Windows 证书导入向导中完成导入，返回后会自动检查根证书库…';
    const next = await call('/api/capture/start', { method: 'POST', body: JSON.stringify({ confirm: true, platform }) });
    renderCapture(next);
    if (capturePoll) clearInterval(capturePoll);
    capturePoll = setInterval(pollCapture, 1500);
  });
}

$('cap-stop').onclick = async () => {
  const state = await call('/api/capture/stop', { method: 'POST', body: JSON.stringify({ confirm: true }) });
  renderCapture(state);
  if (capturePoll) {
    clearInterval(capturePoll);
    capturePoll = null;
  }
  await loadAccounts(true);
  renderAccounts();
};

// ---- 手机号登录 -----------------------------------------------------------
let phonePending = null;
function phoneHint(text, bad = false) {
  const hint = $('phone-hint');
  hint.textContent = text;
  hint.className = bad ? 'bad' : 'warn';
}
function phoneError(message) {
  const text = message || '登录失败';
  phoneHint(text, true);
  const box = clear($('phone-result'));
  box.appendChild(el('div', 'bad', text));
}
function renderPhonePending(data) {
  phonePending = data;
  const box = clear($('phone-result'));
  const kv = el('div', 'kv');
  const rows = [
    ['openId', data.openId],
    ['游戏 uid', data.uid],
    ['登录方式', '益世界账号'],
    ['手机号', data.phone || '-'],
    ['已有账号', data.matched ? '是：' + (data.existingTitle || data.openId) + '（保存会刷新凭证）' : '否，保存会新建一个账号'],
  ];
  for (const [key, value] of rows) {
    kv.appendChild(el('div', 'k', key));
    kv.appendChild(el('div', 'v', value));
  }
  box.appendChild(kv);
  if (!data.matched) box.appendChild(el('div', 'dim', '如果这个 openId 不是你要的区服角色，先不要保存；检查手机号绑定或换用另一个 uid 再试。'));
  $('phone-save').disabled = false;
}
async function phoneLogin(payload) {
  $('phone-login').disabled = true;
  $('phone-save').disabled = true;
  phoneHint('正在登录益世界账号并换取游戏凭证…');
  try {
    const data = await call('/api/accounts/phone-login', { method: 'POST', body: JSON.stringify({ confirm: true, ...payload }) });
    phoneHint('');
    renderPhonePending(data);
    $('phone-password').value = '';
    $('phone-code').value = '';
  } catch (error) {
    phoneError(error.message);
    reportError(error);
  } finally {
    $('phone-login').disabled = false;
  }
}
$('phone-login').onclick = () => {
  const body = {
    phone: $('phone-account').value.trim(),
    password: $('phone-password').value,
  };
  if (!body.phone) { phoneHint('先填手机号或账号'); return; }
  if (!body.password) { phoneHint('填登录密码'); return; }
  phonePending = null;
  $('phone-save').disabled = true;
  clear($('phone-result'));
  phoneLogin(body);
};
let smsTimer = null;
function startSmsCountdown(seconds = 60) {
  if (smsTimer) clearInterval(smsTimer);
  const button = $('phone-send-code');
  let left = Number(seconds) || 60;
  button.disabled = true;
  const tick = () => {
    button.textContent = left > 0 ? '重新发送(' + left + 's)' : '发送验证码';
    if (left <= 0) {
      clearInterval(smsTimer);
      smsTimer = null;
      button.disabled = false;
      return;
    }
    left -= 1;
  };
  tick();
  smsTimer = setInterval(tick, 1000);
}
$('phone-send-code').onclick = () => {
  const phone = $('phone-account').value.trim();
  if (!/^1[3-9][0-9]{9}$/.test(phone)) { phoneHint('先填 11 位手机号', true); return; }
  const body = [el('div', null, '将向 ' + phone + ' 发送登录验证码。')];
  openConfirm('发送短信验证码', body, async () => {
    try {
      const data = await call('/api/accounts/phone-login/send-code', { method: 'POST', body: JSON.stringify({ confirm: true, phone }) });
      phoneHint('验证码已发送，请查收短信');
      startSmsCountdown(data.cooldown || 60);
    } catch (error) {
      phoneError(error.message);
      reportError(error);
    }
  });
};
$('phone-sms-login').onclick = () => {
  const phone = $('phone-account').value.trim();
  const code = $('phone-code').value.trim();
  if (!/^1[3-9][0-9]{9}$/.test(phone)) { phoneHint('先填 11 位手机号', true); return; }
  if (!code) { phoneHint('填短信验证码', true); return; }
  phonePending = null;
  $('phone-save').disabled = true;
  clear($('phone-result'));
  phoneLogin({ phone, code });
};
$('phone-save').onclick = () => {
  if (!phonePending) return;
  const body = [
    el('div', null, '将保存 openId ' + phonePending.openId + ' 的登录凭证。'),
    el('div', null, phonePending.matched
      ? '这个 openId 已有账号记录，保存会刷新该账号的凭证并切换为当前账号。'
      : '这是一个新的 openId，保存会新增账号；请确认它对应你要玩的角色。'),
  ];
  openConfirm('保存手机号登录账号', body, async () => {
    try {
      await call('/api/accounts/phone-login/save', { method: 'POST', body: JSON.stringify({ confirm: true, id: phonePending.id }) });
      phonePending = null;
      $('phone-save').disabled = true;
      clear($('phone-result'));
      await loadAccounts(true);
      renderAccounts();
    } catch (error) {
      phoneError(error.message);
      reportError(error);
    }
  });
};

// ---- 启动 ------------------------------------------------------------------
${progressionScript}
${helpTipsScript}
${mapMotionPosition.toString()}
${worldMapScript}
${rankingScript}
${activityStatisticsScript}
${inventoryScript}
${settingsScript}
// ---- 登录设置 --------------------------------------------------------------
let loginSettingsOwner = null;
let loginSettingsData = null;
let loginSettingsBusy = false;
function loginSettingState(text, kind = '') {
  const node = $('login-settings-state');
  if (!node) return;
  node.textContent = text;
  node.dataset.kind = kind;
}
function loginSetSwitch(id, value) {
  const node = $(id);
  if (!node) return;
  const state = value ? 'checked' : 'unchecked';
  node.setAttribute('aria-checked', String(Boolean(value)));
  node.setAttribute('data-state', state);
  node.querySelector('[data-slot=switch-thumb]')?.setAttribute('data-state', state);
  node.dataset.checked = value ? 'true' : 'false';
}
function loginGetSwitch(id) { return $(id)?.getAttribute('aria-checked') === 'true'; }
function loginRender(data) {
  const settings = data?.settings;
  if (!settings) return;
  loginSettingsOwner = current;
  loginSettingsData = data;
  loginSetSwitch('login-reconnect-enabled', settings.reconnectEnabled);
  $('login-reconnect-delay').value = settings.baseDelaySeconds;
  $('login-reconnect-jitter').value = settings.jitterSeconds;
  $('login-reconnect-max-retries').value = settings.maxRetries;
  loginSetSwitch('login-deep-enabled', settings.deep.enabled);
  $('login-deep-start').value = settings.deep.start;
  $('login-deep-end').value = settings.deep.end;
  $('login-deep-delay').value = settings.deep.delaySeconds;
  $('login-reconnect-log').textContent = settings.reconnectEnabled
    ? '达到 ' + settings.maxRetries + ' 次失败后自动停止重试，并记录错误日志。'
    : '自动重连当前关闭；开启后达到最大重试次数会自动停止并记录日志。';
  $('login-settings-save').disabled = false;
  $('login-settings-reset').disabled = false;
  loginSettingState(data.savedAt ? '设置已保存' : '使用默认设置', 'success');
}
async function loginSettingsLoad(force = false) {
  if (!current || loginSettingsBusy || (!force && loginSettingsOwner === current && loginSettingsData)) return;
  const account = current;
  loginSettingsBusy = true;
  loginSettingState('正在载入…');
  try {
    const data = await call('/api/login-settings');
    if (account === current) loginRender(data);
  } catch (error) {
    if (account === current) loginSettingState(error.message, 'error');
  } finally { loginSettingsBusy = false; }
}
function loginSettingsAccountChanged() {
  loginSettingsOwner = null;
  loginSettingsData = null;
  $('login-settings-save').disabled = true;
  $('login-settings-reset').disabled = true;
  loginSettingState(current ? '尚未载入' : '请先选择账号');
  if (current && !$('tab-login-settings').classList.contains('hidden')) void loginSettingsLoad(true);
}
function loginSettingsRead() {
  return {
    reconnectEnabled: loginGetSwitch('login-reconnect-enabled'),
    baseDelaySeconds: Number($('login-reconnect-delay').value),
    jitterSeconds: Number($('login-reconnect-jitter').value),
    maxRetries: Number($('login-reconnect-max-retries').value),
    deep: {
      enabled: loginGetSwitch('login-deep-enabled'),
      start: $('login-deep-start').value,
      end: $('login-deep-end').value,
      delaySeconds: Number($('login-deep-delay').value),
    },
  };
}
for (const id of ['login-reconnect-enabled', 'login-deep-enabled']) {
  $(id).onclick = () => loginSetSwitch(id, !loginGetSwitch(id));
}
$('login-settings-reset').onclick = () => { if (loginSettingsData) loginRender(loginSettingsData); };
$('login-settings-form').onsubmit = async event => {
  event.preventDefault();
  if (!current || !loginSettingsData || loginSettingsBusy) return;
  const account = current;
  loginSettingsBusy = true;
  $('login-settings-save').disabled = true;
  loginSettingState('正在保存…');
  try {
    const data = await call('/api/login-settings', { method: 'POST', body: JSON.stringify({ settings: loginSettingsRead(), revision: loginSettingsData.revision }) });
    if (account === current) loginRender(data);
  } catch (error) {
    if (account === current) loginSettingState(error.message, 'error');
  } finally {
    loginSettingsBusy = false;
    $('login-settings-save').disabled = false;
  }
};
for(const button of document.querySelectorAll('[data-panel-toggle]'))button.onclick=()=>{const panel=$(button.dataset.panelToggle),open=panel.hidden;panel.hidden=!open;button.setAttribute('aria-expanded',String(open));button.textContent=open?'收起':'展开';};
${giftCodeScript}
let selectedResource = 'dailies';
function activateConsolePage(button, resource = selectedResource) {
    const isResource = button.dataset.tab === 'resources';
    const target = isResource ? resource : button.dataset.tab;
    if (isResource) selectedResource = resource;
    $('resource-tabs').hidden = !isResource;
    for (const tab of document.querySelectorAll('[data-resource-tab]')) {
      const selected = tab.dataset.resourceTab === target;
      tab.setAttribute('aria-current', selected ? 'page' : 'false');
      if (selected && isResource) tab.scrollIntoView({ block: 'nearest', inline: 'center' });
    }
    closeHelpTip(false);
    for (const other of document.querySelectorAll('#tabs button')) other.removeAttribute('aria-current');
    button.setAttribute('aria-current', 'page');
    for (const section of document.querySelectorAll('main > section')) {
      section.classList.toggle('hidden', section.id !== 'tab-' + target);
    }
    refreshProgression();
    if (button.dataset.tab === 'overview') {refreshOverview();refreshLoop();}
    if(isResource&&resource==='inventory')refreshManualWorld();
    if(isResource&&resource==='heroes')refreshOverview();
    if (button.dataset.tab === 'account') {
      refreshOverview();
      renderAccounts();
      pollCapture();
    }
    if (button.dataset.tab === 'manual') refreshManualWorld();
    if (button.dataset.tab === 'idle') refreshLoop();
    if (button.dataset.tab === 'settings') { void configLoad(); void refreshLoop(); }
    if (button.dataset.tab === 'login-settings') void loginSettingsLoad();
    if(target==='giftcodes')void refreshGiftCodes();
    if (target === 'activities') refreshActivities();
    if (button.dataset.tab === 'stages') refreshStages();
}
document.querySelectorAll('#tabs button').forEach(button => { button.onclick = () => activateConsolePage(button); });
for(const link of document.querySelectorAll('a[href^="#config-group-"]'))link.onclick=event=>{if(location.hash===link.getAttribute('href')){event.preventDefault();activateConsolePage(document.querySelector('#tabs [data-tab="settings"]'));configApplyHash();}};
document.querySelectorAll('[data-resource-tab]').forEach(button => { button.onclick = () => activateConsolePage(document.querySelector('#tabs [data-tab="resources"]'), button.dataset.resourceTab); });

// 配置页工具栏吸在页头下方；页头高度随触屏尺寸和提示文字变化，手机上页头不吸顶。
new ResizeObserver(() => {
  const header = document.querySelector('header');
  document.documentElement.style.setProperty('--header-h', (getComputedStyle(header).position === 'sticky' ? header.offsetHeight : 0) + 'px');
}).observe(document.querySelector('header'));

async function boot() {
  try {
    await loadAccounts(true);
  } catch (error) {
    $('hint').textContent = '';
    reportError(error);
    return;
  }
  // 每次打开默认总览；移除旧配置锚点，确保随后点击同一链接也能正确定位。
  if(location.hash.startsWith('#config-group-'))history.replaceState(null,'',location.pathname+location.search);
  activateConsolePage(document.querySelector('#tabs [data-tab="overview"]'));
  if (location.hash === '#journal') openJournal();
  if (location.hash === '#pirate-first-kill') activateConsolePage(document.querySelector('#tabs [data-tab="stages"]'));
  pollCapture();
}
boot();
setInterval(refreshOverview, 20000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden){refreshLoop();refreshStages();}});
setInterval(() => { if (!loopReads) refreshLoop(); }, 3000);
setInterval(refreshStages, 3000);
</script>
</body>
</html>`;
