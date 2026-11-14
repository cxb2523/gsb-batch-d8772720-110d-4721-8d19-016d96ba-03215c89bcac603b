// Translate only for display. Some game flows decide how to recover from the
// original error text, so the client's errors and API responses stay intact.
const requestLabels = new Map([
  ['DailyTaskInfoRequest', '读取每日任务'],
  ['MainTaskInfoRequest', '读取主线任务'],
  ['WeekInfoRequest', '读取周活动'],
  ['WeekOrderInfoRequest', '读取周订单'],
  ['AllItemRequest', '读取仓库'],
  ['OnWaterRequest', '读取海面建筑'],
  ['HeroStarUpRequest', '英雄升星'],
]);

const promptLabels = new Map([
  ['building not built', '所需建筑尚未建造'],
  ['feature locked', '该账号尚未解锁这项功能'],
  ['no claimable afk reward', '目前没有可领取的挂机奖励'],
  ['upgrade condition unmet', '尚未满足升级条件'],
  ['no chance left', '可用次数已用完'],
  ['too early', '尚未到可执行时间'],
  ['breed queue full', '海兽培育队列已满，等待完成并领取后再培育'],
]);

const connectionLabels = new Map([
  ['login timeout', '登录超时，游戏服务器未及时回应'],
  ['already connected', '账号已连接游戏'],
  ['not connected', '账号尚未连接游戏'],
  ['socket error during login', '登录时无法连接游戏服务器'],
  ['socket error', '与游戏服务器的连接出现异常'],
  ['client stopped', '游戏连接已停止，本次请求已取消'],
  ['ping timeout', '游戏服务器未及时回应心跳'],
  ['Failed to fetch', '浏览器未能连接控制台'],
]);
const connectionPattern = new RegExp('\\b(?:' + [...connectionLabels.keys()].join('|') + ')\\b', 'g');

function explainPrompt(reason, context) {
  if (reason === 'adv not finished') return '服务器判定广告未完成，等待时间不足';
  // 免费英雄招募从广播站进入；其他玩法也可能返回同一个建筑提示。
  if (reason === 'building not built' && context?.request === 'RecruitStartRequest' && context.way === 1) {
    return '所需建筑尚未建造（广播站）';
  }
  if (promptLabels.has(reason)) return promptLabels.get(reason);
  const code = /^prompt=(\d+)\b/.exec(reason);
  if (code && /\bNO_GUILD\b/.test(reason)) return '当前账号未加入联盟';
  if (code) return '游戏服务器拒绝了这项操作（提示码 ' + code[1] + '）';
  return /[\u4e00-\u9fff]/.test(reason) ? '游戏服务器提示：' + reason : '游戏服务器拒绝了这项操作';
}

export function describeLogError(message, context) {
  const translated = message
    .replace(/\btimeout waiting for \w+ \(sent (\w+)\)/g, (_, request) => {
      const label = requestLabels.get(request);
      return (label ? label + '超时' : '请求超时') + '，游戏服务器未及时回复';
    })
    .replace(/\bserver prompt:\s*([^\n]+)/g, (_, reason) => explainPrompt(reason.trim(), context))
    .replace(/\blogin rejected: result=(\d+)([^\n]*)/g, (_, code, reason) => {
      const label = code === '1' ? '游戏服务器维护中，暂时无法登录' : '游戏服务器拒绝登录（结果码 ' + code + '）';
      return /[\u4e00-\u9fff]/.test(reason) ? label + '：' + reason.trim() : label;
    })
    .replace(/\bsocket closed during login: (\d+)[^\n]*/g, (_, code) => '登录时连接已断开（状态码 ' + code + '）')
    .replace(/\bunexpected auth reply: \w+/g, '登录时收到意外的服务器回复')
    .replace(/\bUnknown message type: \w+/g, '当前协议无法识别这条消息')
    .replace(/\bprotocol has no type \w+/g, '当前协议尚不支持这项操作')
    .replace(connectionPattern, reason => connectionLabels.get(reason));
  return translated === message ? { message } : { message: translated, detail: message };
}
