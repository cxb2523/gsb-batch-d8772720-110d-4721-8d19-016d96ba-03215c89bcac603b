// Each activity owns a tab; task preferences remain scoped to the account.
let activitiesVersion = 0;
let activityExpiryTimer;
let activitiesData = null;
let activitiesAccount = null;
let activitiesReceivedAt = 0;
let selectedActivity = null;
let discoveryVersion = 0;
const activitySelections = new Map();
const pendingActivities = new Set();
const activityTaskEdits = new Map();

function activityNow() {
  return activitiesData.serverNow + (Date.now() - activitiesReceivedAt) / 1000;
}

const activityKinds = {
  limited: { tag: '限时', group: '限时活动' },
  weekly: { tag: '周期', group: '周期活动' },
  permanent: { tag: '常驻', group: '常驻活动' },
};

// Groups render in this order, and arrow keys follow the same list.
function activityRows() {
  const rows = activitiesData?.activities.filter(row => row.endTime > activityNow()) || [];
  if (activitiesData) rows.push({ id: 'fish', name: '钓鱼图鉴', kind: 'permanent', taskKeys: ['fishBook'] });
  if (activitiesData?.vipLevel > 0) rows.push({ id: 'vip', name: 'VIP 每日奖励', kind: 'permanent', taskKeys: ['vipDaily'] });
  rows.push({ id: 'pirates', name: '海盗首杀', kind: 'permanent', taskKeys: !activitiesData ? [] : activitiesData.status?.pirates?.rankOpen ? ['campaignReports', 'openRankRewards'] : ['campaignReports'] });
  const order = Object.keys(activityKinds);
  return rows.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || (a.group || '').localeCompare(b.group || '') || (a.endTime ?? 0) - (b.endTime ?? 0));
}

function activityBadge(kind) {
  return el('span', 'activity-badge ' + kind, activityKinds[kind].tag);
}

function activityRemaining(endTime) {
  if (!endTime) return '长期开放';
  const minutes = Math.max(1, Math.ceil((endTime - activityNow()) / 60));
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60);
  return '剩余 ' + (days ? days + ' 天 ' + hours + ' 小时' : hours ? hours + ' 小时 ' + minutes % 60 + ' 分' : minutes + ' 分钟');
}

function paintActivityTime(node, endTime) {
  node.textContent = activityRemaining(endTime);
  node.classList.toggle('soon', Boolean(endTime) && endTime - activityNow() < 86400);
}

function renderActivityTabs() {
  const rows = activityRows(), tabs = clear($('activity-tabs'));
  if (!rows.some(row => row.id === selectedActivity)) selectedActivity = rows[0]?.id;
  activitySelections.set(current, selectedActivity);
  let group;
  rows.forEach((row, index) => {
    const title = row.group || activityKinds[row.kind].group;
    if (title !== group) {
      group = title;
      const heading = el('div', 'activity-group', group);
      if (row.group) heading.appendChild(el('span', 'activity-group-time', activityRemaining(row.endTime)));
      heading.setAttribute('aria-hidden', 'true');
      tabs.appendChild(heading);
    }
    const button = el('button', 'activity-tab');
    button.type = 'button';
    button.id = 'activity-tab-' + index;
    button.dataset.activity = row.id;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(row.id === selectedActivity));
    button.setAttribute('aria-controls', 'activity-panel');
    button.tabIndex = row.id === selectedActivity ? 0 : -1;
    const head = el('span', 'activity-tab-head');
    head.append(el('span', 'activity-tab-name', row.name));
    if (activitiesData?.status?.[row.id]?.ready) head.appendChild(el('span', 'activity-ready', activitiesData.status[row.id].badge));
    head.appendChild(activityBadge(row.kind));
    button.appendChild(head);
    if (!row.group) {
      const time = el('span', 'activity-tab-time');
      if (row.endTime) time.dataset.end = String(row.endTime);
      paintActivityTime(time, row.endTime);
      button.appendChild(time);
    }
    button.onclick = () => selectActivity(row.id, true);
    button.onkeydown = event => {
      const offsets = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1, Home: -index, End: rows.length - index - 1 };
      if (!(event.key in offsets)) return;
      event.preventDefault();
      selectActivity(rows[(index + offsets[event.key] + rows.length) % rows.length].id, true);
    };
    tabs.appendChild(button);
  });
  renderActivityDetail();
}

setInterval(() => {
  if (!activitiesData) return;
  for (const node of document.querySelectorAll('#activity-tabs [data-end]')) paintActivityTime(node, Number(node.dataset.end));
}, 30000);

function selectActivity(id, focus = false) {
  selectedActivity = id;
  activitySelections.set(current, id);
  ++discoveryVersion;
  renderActivityTabs();
  const tab = $('activity-tabs').querySelector('[aria-selected=true]');
  if (focus) tab?.focus();
  tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  refreshProgression();
}

function renderActivityDetail() {
  const row = activityRows().find(item => item.id === selectedActivity);
  const panel = $('activity-panel');
  panel.hidden = !row;
  const box = clear($('activities-list'));
  clear($('activities-order'));
  if (!row) return;
  panel.setAttribute('aria-labelledby', $('activity-tabs').querySelector('[aria-selected=true]').id);
  $('activity-title').textContent = row.group ? row.group + ' · ' + row.name : row.name;
  clear($('activity-kind')).appendChild(activityBadge(row.kind));
  $('activity-end').textContent = row.endTime ? '结束时间 · ' + new Date(row.endTime * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + '（北京时间）' : '长期开放';
  $('activity-pirates').hidden = row.id !== 'pirates';
  if (!activitiesData) return;
  for (const line of activitiesData.status?.[row.id]?.lines ?? []) box.appendChild(el('p', null, line));
  if (row.weekType === 4) {
    const lottery = activitiesData.lottery;
    box.appendChild(el('p', null, lottery ? '累计抽奖 ' + lottery.times + ' 次 · ' + (lottery.required == null ? '全部档位已领完' : '下一档 ' + lottery.required + ' 次' + (lottery.ready ? '（可领取）' : '')) : activitiesData.lotteryError ? '抽奖进度读取失败，详情见运行日志' : '暂无抽奖进度'));
  }
  if (row.id === 'fish') {
    const fish = activitiesData.fish;
    box.appendChild(el('p', null, fish ? '已收集 ' + fish.names.length + '/' + fish.total + ' 种 · ' + (fish.next ? '下一档 ' + fish.score + '/' + fish.required + ' 分' : '档位已领完') : '钓鱼图鉴读取失败，详情见运行日志'));
    if (fish?.names.length) box.appendChild(el('p', 'dim', fish.names.join('、')));
  }
  if (row.taskKeys?.includes('newbieLogin')) {
    const newbie = activitiesData.newbie;
    if (newbie) box.appendChild(el('p', null, '已登录 ' + newbie.loginDays + ' 天 · ' + (newbie.available.length ? '可领第 ' + newbie.available.join('、') + ' 天奖励' : '当前奖励已领完')));
  }
  const tasks = (row.taskKeys || []).map(key => activitiesData.eventTasks.find(task => task.key === key)).filter(Boolean);
  for (const task of tasks) renderActivityTask(box, row, task);
  if (tasks.length) box.appendChild(el('p', 'dim', '单次执行只处理本项。开启自动运行后，随当前账号挂机执行。'));
  else if (row.weekType !== 5 && row.id !== 'pirates') box.appendChild(el('p', 'dim', '当前活动暂未接入单次操作，可在游戏内参与。'));
  if (row.weekType === 5) renderActivityOrder();
}

function renderActivityTask(box, row, task) {
  const account = activitiesAccount, key = account + ':' + row.id + ':' + task.key;
  const item = el('div', 'activity-task');
  item.appendChild(el('strong', null, task.label));
  const descriptions = {
    evilExpel: '清理当前可驱除的邪祟，并领取已达标的累计奖励。',
    edict: '完成当前解符对局；没有对局时，最多消耗 1 份贡品开局。',
    edictPass: '领取酆都法旨战令已达标的奖励，不消耗贡品。',
    compassReward: '领取已达标的积分奖励，不进行罗盘抽奖。',
    weekPass: '领取已完成任务的积分和已达标的战令奖励。',
    weekGift: '领取本期可用的免费礼包。',
    weekTimes: '领取已达标的累计抽奖次数奖励，不进行抽奖。',
    fishBook: '领取当前已达标的钓鱼图鉴奖励。',
    newbieLogin: '领取当前已解锁的登录奖励。',
    festivalSign: '只签当天，免费。错过的日子要花钻石补签，本工具不会补签。',
    festivalActive: '领取活跃积分已达标的档位。',
    festivalGifts: '领取今天的免费礼包，付费礼包不会购买。',
    snowballFree: '领取免费礼包和通行证已达标的免费奖励，不玩小游戏，也不买体力。',
    riverScore: '领取走江踏浪已达标的累计积分奖励。',
    riverPass: '领取走江踏浪通行证已达标的免费奖励。',
    riverHelp: '领取当前渠道允许的走江踏浪免费助力奖励。',
    compassSpin: '消耗抽奖券抽奖，不花钻石。单次执行和自动运行的每一轮都按设置的张数，不足时有多少用多少。',
    weekLotterySpin: '消耗周转盘币抽奖，每次执行最多 10 次，不花钻石。',
    weekCharge: '领取累充金额已达标的档位，不充值。',
    weekHeroStar: '领取两位英雄星级都已达标的档位。',
    weekChipFree: '领取本期免费礼包。',
    weekUniqueFree: '领取本期免费礼包，翻牌需要手动选择目标，不自动进行。',
    weekOrderFinal: '全部档位完成后领取最终奖励。',
    weekOrderSubmit: '材料备齐后提交一次周订单，会消耗预留的材料。',
    vipDaily: '领取已达到 VIP 等级的每日免费奖励。',
    campaignReports: '海盗战斗等奖励留在战报里，这里一键领取。开启后收到新战报会马上领，不用开挂机。',
    openRankRewards: '领取各个开服冲榜已达标的积分奖励。排名奖励由游戏在活动结束后发放。',
  };
  if (descriptions[task.key]) item.appendChild(el('p', 'dim', descriptions[task.key]));
  const bar = el('div', 'activity-controls');
  const button = smallButton(pendingActivities.has(key) ? '执行中…' : task.key === 'edict' ? '解符一次（最多 1 份贡品）' : task.key === 'weekOrderSubmit' ? '提交周订单' : '执行一次');
  button.dataset.activityRun = task.key;
  button.disabled = pendingActivities.has(key) || snapshot.paused || disconnected.has(account);
  const spinInput = task.key === 'compassSpin' ? spinCountInput(account) : null;
  button.onclick = async () => {
    if (button.disabled || account !== current || snapshot.paused || disconnected.has(account) || pendingActivities.has(key)) return;
    if (row.endTime && row.endTime <= activityNow()) { refreshActivities(); return; }
    if (task.key === 'weekOrderSubmit') { confirmWeekOrderAction('submit'); return; }
    const spinCount = spinInput ? spinInput.valueAsNumber : undefined;
    if (spinInput && !spinInput.checkValidity()) { reportError(new Error('抽奖券张数必须是 1 到 ' + spinInput.max + ' 的整数'), '风水罗盘抽奖'); return; }
    pendingActivities.add(key);
    renderActivityDetail();
    try {
      await call('/api/activities/run?account=' + encodeURIComponent(account), { method: 'POST', body: JSON.stringify({ activityId: row.id, taskKey: task.key, spinCount, confirm: true }) });
    } catch (error) { reportError(error, '单次执行活动'); }
    finally {
      pendingActivities.delete(key);
      if (account === current) refreshActivities();
    }
  };
  const auto = el('label', 'activity-auto');
  const toggle = component('ui-event-switch');
  toggle.dataset.autoTask = task.key;
  toggle.dataset.eventTask = 'true';
  toggle.dataset.account = account;
  toggle.setAttribute('aria-label', task.label + ' · 自动运行');
  setTaskSwitch(toggle, task.enabled);
  toggle.disabled = savingTasks.has(account + ':' + task.key);
  toggle.onclick = () => { if (current === account) toggleAutoTask(toggle); };
  auto.append(toggle, el('span', null, '自动运行'));
  if (spinInput) {
    const field = el('label', 'activity-auto');
    field.append(el('span', null, '每次使用'), spinInput, el('span', null, '张'));
    bar.append(field);
    if (activitiesData.compassSpinEditable === false) bar.appendChild(el('span', 'dim', '在游戏配置中修改'));
  }
  bar.append(button, auto);
  item.appendChild(bar);
  box.appendChild(item);
}

function spinCountInput(account) {
  const input = component('ui-number');
  input.min = 1;
  input.max = 999;
  input.step = 1;
  input.required = true;
  input.value = activitiesData.compassSpinCount;
  input.disabled = activitiesData.compassSpinEditable === false;
  input.setAttribute('aria-label', '风水罗盘每次使用的抽奖券张数');
  input.onchange = async () => {
    const saved = activitiesData.compassSpinCount;
    if (!input.checkValidity()) {
      input.value = saved;
      reportError(new Error('抽奖券张数必须是 1 到 ' + input.max + ' 的整数'), '设置罗盘抽奖券用量');
      return;
    }
    const count = input.valueAsNumber;
    if (count === saved) return;
    try {
      await call('/api/loop/compass-spin-count?account=' + encodeURIComponent(account), { method: 'POST', body: JSON.stringify({ compassSpinCount: count }) });
      if (activitiesAccount === account && activitiesData) activitiesData.compassSpinCount = count;
    } catch (error) {
      input.value = saved;
      reportError(error, '设置罗盘抽奖券用量');
    }
  };
  return input;
}

function syncActivityTask(key, enabled, account) {
  if (activitiesAccount !== account) return;
  const task = activitiesData?.eventTasks.find(task => task.key === key);
  if (task) task.enabled = enabled;
}

function renderActivityOrder() {
  const materials = clear($('activities-order')), data = activitiesData;
  if (data.order?.materials.length && !data.order.finished) {
    materials.appendChild(el('p', 'dim', data.order.ready
      ? '周订单材料已齐，已预留整单用量，可点上方「提交周订单」或开启自动运行。'
      : '周订单尚缺材料。已备齐的居民订单可先用所需份额，挂机再按缺口补产。'));
    const submit = smallButton('提交整单');
    submit.disabled = !data.order.ready;
    submit.onclick = () => confirmWeekOrderAction('submit');
    materials.appendChild(submit);
    materials.appendChild(table(['材料', '需要', '库存', '还缺', '生产地点', '当前状态', '钻石购买'], data.order.materials.map(row => {
      const cost = row.price * row.missing, buy = smallButton(cost + ' 钻');
      buy.onclick = () => confirmWeekOrderAction('buy', { itemId: row.id, quantity: row.missing, cost });
      return [row.name, String(row.required), String(row.owned), row.missing ? String(row.missing) : '已齐',
        row.seed ? '农田' : row.factory ? row.factory.name + ' · ' + row.factory.required + ' 级' : '无工厂配方',
        row.seed ? row.farmStatus : !row.factory ? '—' : row.factory.level === null ? '等级未知' : row.factory.level ? row.factory.level + ' 级' + (row.factory.constructing ? ' · 升级中' : '') : row.factory.constructing ? '建造中' : '未建造',
        row.missing && row.price ? buy : row.missing ? '无售价' : '—'];
    })));
  } else materials.textContent = data.orderError ? '未能读取材料，详情见运行日志' : !data.order ? '本期未开放周订单' : data.order.finalReady ? '本期周订单已全部交付，可在游戏内领取最终奖励。' : data.order.finished ? '本期周订单已完成' : '当前没有材料需求';
}

function confirmWeekOrderAction(action, payload = {}) {
  const account = activitiesAccount, order = activitiesData?.order;
  if (!order || account !== current) return;
  const row = order.materials.find(item => item.id === payload.itemId);
  const detail = action === 'buy'
    ? row.name + ' ×' + payload.quantity + '，共 ' + payload.cost + ' 钻石'
    : order.materials.map(item => item.name + ' ×' + item.required).join('、');
  const key = account + ':week-order:' + action + ':' + (payload.itemId || '');
  openConfirm(action === 'buy' ? '钻石购买材料' : '提交整份周订单', [el('p', '', detail)], async () => {
    if (account !== current || account !== activitiesAccount) throw Error('账号已切换，请刷新');
    if (snapshot.paused || disconnected.has(account)) throw Error('请先连接账号并恢复运行');
    if (pendingActivities.has(key)) return;
    pendingActivities.add(key);
    try {
      const result = await call('/api/week-order/' + action + '?account=' + encodeURIComponent(account), {
        method: 'POST', body: JSON.stringify({ confirm: true, orderKey: order.orderKey, ...payload }),
      });
      if (account === current) $('hint').textContent = result.message;
    } finally {
      pendingActivities.delete(key);
      if (account === current) await refreshActivities();
    }
  });
}

async function refreshActivities() {
  const version = ++activitiesVersion, account = current;
  clearTimeout(activityExpiryTimer);
  ++discoveryVersion;
  const changed = activitiesAccount !== account;
  if (changed) {
    activitiesAccount = account;
    activitiesData = null;
    selectedActivity = activitySelections.get(account) || null;
    clear($('activity-tabs'));
    $('activity-panel').hidden = true;
    for (const id of ['activities-list', 'activities-order', 'pirate-board-view']) clear($(id));
  }
  if ($('tab-activities').classList.contains('hidden')) return;
  const status = $('activities-status');
  const unavailable = !account || snapshot.paused || disconnected.has(account);
  if (unavailable) {
    activitiesData = null;
    clear($('activity-tabs'));
    $('activity-panel').hidden = true;
    status.textContent = !account ? '请先选择账号' : snapshot.paused ? '账号已暂停' : '请先连接账号';
    return;
  }
  status.textContent = '正在读取活动…';
  try {
    const [data, sources] = await Promise.all([
      call('/api/activities'),
      sourceIndex ?? call('/api/material-sources').catch(() => null),
    ]);
    if (version !== activitiesVersion || account !== current) return;
    if (sources) { sourceIndex = sources; renderSourceSearch(); }
    // A settings save can overlap this read. Preserve the newer local value.
    for (const task of data.eventTasks) {
      const local = activityTaskEdits.get(account + ':' + task.key);
      if (local && (local.pending || local.version >= version)) task.enabled = local.enabled;
    }
    activitiesData = data;
    activitiesReceivedAt = Date.now();
    status.textContent = data.activities.length ? '' : '当前没有开放的限时或周期活动';
    renderActivityTabs();
    if (selectedActivity === 'pirates') refreshProgression('pirate-board');
    const endTimes = data.activities.filter(row => row.endTime > activityNow()).map(row => row.endTime);
    if (endTimes.length) activityExpiryTimer = setTimeout(() => {
      renderActivityTabs();
      refreshActivities();
    }, Math.min(2147483647, Math.max(1, Math.ceil((Math.min(...endTimes) - activityNow()) * 1000))));
  } catch {
    if (version !== activitiesVersion || account !== current) return;
    activitiesData = null;
    status.textContent = '活动读取失败，请刷新重试。详情见运行日志';
    renderActivityTabs();
    if (selectedActivity === 'pirates') refreshProgression('pirate-board');
  }
}
$('activities-refresh').onclick = refreshActivities;
