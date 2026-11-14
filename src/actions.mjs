// Catalog of the protocol calls that matter for idle play, with an explicit split
// between "ask the server something" and "tell the server to change something".
//
// Field numbers come from tools/describe.mjs against the game's own generated codec, not
// from guessing. Requests whose response type does not exist in the protocol table are
// answered by a push or a generic OkResponse instead, so they are sent fire-and-forget.

import { claimMail } from './mail.mjs';

// SpeedUpCost.SPEED_UP_ITEM=2（1=钻石 2=加速器 3=广告）。本工具只允许 2。
export const SPEED_UP_ITEM_TYPE = 2;

// 「每日精选」里几个礼包的 packId 是客户端写死的字面量（DailyPackBuyPanel 的字段初值），
// 不是配置表里的值，所以这里也只能写死。赠礼=免费那档，合并礼包=要买过礼包1/2/3 才能领。
export const FREE_DAILY_PACK_ID = '赠礼';
export const DAILY_GIFT_PACK_IDS = ['礼包1', '礼包2', '礼包3'];

// repeated int32 参数：接受 "1,2,3" 或 1 或 [1,2,3]。
function indexList(value) {
  if (Array.isArray(value)) return value.map(Number);
  return String(value ?? '')
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isFinite(n));
}

export const ACTIONS = {
  afkDraw: {
    request: 'DrawAfkRewardRequest',
    response: 'DrawAfkRewardResponse',
    mutate: true,
    desc: '领取挂机时段收益，服务端据此把挂机时间段重置',
    body: (params) => (params?.useAdvCard ? { useAdvCard: true } : {}),
  },
  afkLevelDraw: {
    request: 'DrawAfkLevelRewardRequest',
    response: 'DrawAfkLevelRewardResponse',
    mutate: true,
    desc: '领取指定挂机等级的奖励',
    params: ['level'],
    body: ({ level }) => ({ level: Number(level) }),
  },
  afkUpgrade: {
    request: 'UpgradeAfkLevelRequest',
    response: 'UpgradeAfkLevelResponse',
    mutate: true,
    desc: '提升挂机等级',
    params: ['level'],
    body: ({ level }) => ({ level: Number(level) }),
  },
  factoryGain: {
    request: 'GainFactoryProduceRequest',
    response: 'GainFactoryProduceResponse',
    mutate: true,
    desc: '收取指定建筑的工厂产出',
    params: ['buildingId'],
    body: ({ buildingId }) => ({ buildingId }),
  },
  buildingCollect: {
    request: 'CollectBuildingProductRequest',
    response: 'CollectBuildingProductResponse',
    mutate: true,
    desc: '收取指定建筑的产物',
    params: ['buildingId'],
    body: ({ buildingId }) => ({ buildingId }),
  },
  buildingFinish: {
    request: 'FinishUpgradeBuildingRequest',
    response: null,
    mutate: true,
    desc: '竣工指定建筑，仅在 buildFinishTime 已过时有效',
    params: ['buildingId'],
    body: ({ buildingId }) => ({ buildingId }),
  },
  buildingAutoWork: {
    request: 'SetBuildingAutoWorkRequest',
    response: null,
    mutate: true,
    desc: '开关指定建筑的自动工作',
    params: ['buildingId', 'isOn'],
    body: ({ buildingId, isOn }) => ({ buildingId, isOn: isOn === true || isOn === 'true' }),
  },
  factoryAutoProduce: {
    request: 'SetFactoryAutoProduceRequest',
    response: null,
    mutate: true,
    desc: '设置工厂自动生产的产品',
    params: ['buildingId', 'productId'],
    body: ({ buildingId, productId }) => ({ buildingId, productId }),
  },
  dailyTaskDraw: {
    request: 'DrawDailyTaskRewardRequest',
    response: 'DrawDailyTaskRewardResponse',
    mutate: true,
    desc: '领取每日任务奖励',
    params: ['id'],
    body: ({ id }) => ({ id: Number(id) }),
  },
  achievementDraw: {
    request: 'GotAchievementRewardRequest',
    response: null,
    mutate: true,
    desc: '领取成就奖励',
    params: ['id'],
    body: ({ id }) => ({ id: Number(id) }),
  },
  emailQuickGet: {
    request: 'QuickGotReadEmailRequest',
    response: null,
    mutate: true,
    desc: '一键处理未读邮件与附件，分页检查并回读确认',
    body: () => ({ all: true }),
  },
  // index 是 repeated int32，传单个数字会被编码成空数组，所以这里统一收成数组，
  // 命令行写 "1" 或 "1,2,3,4" 都行。
  dailyRewardDraw: {
    request: 'DrawDailyRewardRequest',
    response: null,
    mutate: true,
    desc: '领取日常活跃宝箱（档位来自 DailyActivityRewardCfg，门槛 20/40/60/80/100）',
    params: ['index'],
    body: ({ index }) => ({ index: indexList(index) }),
  },
  weeklyRewardDraw: {
    request: 'DrawWeeklyRewardRequest',
    response: null,
    mutate: true,
    desc: '领取周活跃宝箱（自己的表 WeeklyActivityRewardCfg，门槛 120/240/360/480/600）',
    params: ['index'],
    body: ({ index }) => ({ index: indexList(index) }),
  },
  freeDailyPackDraw: {
    request: 'GotFreeDailyPackRequest',
    response: null,
    mutate: true,
    desc: '领「每日精选」里那档免费礼包（packId 由客户端硬编码为「赠礼」，可领性看 DailyGiftPackResponse.drawnPack）',
    // 付费那三档与「合并礼包」不在工具范围内，所以参数写死、不开放给命令行。
    body: () => ({ packId: FREE_DAILY_PACK_ID }),
  },
  monthCardDaily: {
    request: 'MonthCardDailyRewardRequest',
    response: null,
    mutate: true,
    desc: '领取月卡每日奖励',
    body: () => ({}),
  },
  taskDrawMain: {
    request: 'DrawMainTaskRewardRequest',
    response: null,
    mutate: true,
    desc: '领取主线（成长任务）奖励',
    params: ['taskId'],
    body: ({ taskId }) => ({ taskId: Number(taskId) }),
  },
  taskDrawBranch: {
    request: 'GotBranchTaskRewardRequest',
    response: null,
    mutate: true,
    desc: '领取支线任务奖励',
    params: ['taskId'],
    body: ({ taskId }) => ({ taskId: Number(taskId) }),
  },
  orderDayReward: {
    request: 'GetNextOrderOTDRewardRequest',
    response: null,
    mutate: true,
    desc: '领取每日订单进度档位奖励（空体，一次领一档）',
    body: () => ({}),
  },
  finishOrder: {
    request: 'FinishWorkerOrderRequest',
    response: 'FinishWorkerOrderResponse',
    mutate: true,
    desc: '提交居民订单，材料必须齐全',
    params: ['index'],
    body: ({ index }) => ({ index: Number(index) }),
  },
  rerollOrder: {
    request: 'DenyOrderRequest',
    response: null,
    mutate: true,
    desc: '拒绝（重刷）一条居民订单，会消耗订单名额',
    params: ['index'],
    body: ({ index }) => ({ index: Number(index) }),
  },
  startProduce: {
    request: 'StartFactoryProduceRequest',
    response: null,
    mutate: true,
    desc: '让工厂开始生产指定产品',
    params: ['buildingId', 'productId'],
    body: ({ buildingId, productId }) => ({ buildingId, productId }),
  },
  upgradeBuilding: {
    request: 'UpgradeBuildingRequest',
    response: null,
    mutate: true,
    desc: '升级建筑（要满足 BuildingUpgradeCfg 的等级、人口与消耗）',
    params: ['buildingId'],
    body: ({ buildingId }) => ({ buildingId }),
  },
  buildBuilding: {
    request: 'BuildBuildingRequest',
    response: null,
    mutate: true,
    desc: '建造新建筑（OnWaterResponse 里 level=0 的空位，条件是 BuildingUpgradeCfg 的 level 1 行）',
    params: ['buildingId'],
    body: ({ buildingId }) => ({ buildingId }),
  },
  speedUpUpgrade: {
    request: 'SpeedUpUpgradeBuildingRequest',
    response: null,
    mutate: true,
    desc: '花加速器缩短建造时间；type=2 是加速器。钻石(1)不用，广告(3)见 ad-rewards.mjs',
    params: ['buildingId', 'useNum'],
    body: ({ buildingId, useNum }) => ({ buildingId, speedUp: { type: SPEED_UP_ITEM_TYPE, useNum: Number(useNum) } }),
  },
  speedUpProduce: {
    request: 'SpeedUpFactoryProduceRequest',
    response: null,
    mutate: true,
    desc: '花加速器缩短工厂生产时间',
    params: ['buildingId', 'index', 'useNum'],
    body: ({ buildingId, index, useNum }) => ({
      buildingId,
      index: Number(index),
      speedUp: { type: SPEED_UP_ITEM_TYPE, useNum: Number(useNum) },
    }),
  },
  challengeField: {
    request: 'ChallengeResFieldRequest',
    response: null,
    mutate: true,
    desc: '派舰队攻打并占领资源田，要求该田所属城是我方城且有闲置舰队',
    params: ['gridIdx'],
    body: ({ gridIdx, fleetBuildingIds }) => ({
      resFieldGridIdx: Number(gridIdx),
      fleetBuildingIds: String(fleetBuildingIds).split(',').map((s) => s.trim()).filter(Boolean),
    }),
  },
  giveUpField: {
    request: 'GiveUpResFieldRequest',
    response: null,
    mutate: true,
    desc: '放弃已占领的资源田',
    params: ['gridIdx'],
    body: ({ gridIdx }) => ({ resFieldGridIdx: Number(gridIdx) }),
  },
};

export function listActions() {
  return Object.entries(ACTIONS).map(([id, action]) => ({
    id,
    request: action.request,
    mutate: action.mutate,
    params: action.params ?? [],
    desc: action.desc,
  }));
}

// Checked before dialing the gateway, so a missing opt-in costs nothing and never even
// opens a session.
export function assertAllowed(id, { allowMutate = false } = {}) {
  const action = ACTIONS[id];
  if (!action) throw new Error(`unknown action: ${id}`);
  if (action.mutate && !allowMutate) {
    throw new Error(`action "${id}" changes account state; re-run with --yes to proceed`);
  }
  return action;
}

export function buildBody(action, params = {}) {
  for (const key of action.params ?? []) {
    if (params[key] === undefined || params[key] === '') {
      throw new Error(`missing parameter: ${key}`);
    }
  }
  return action.body(params) ?? {};
}

// Runs one action. Mutating calls are refused unless the caller explicitly opts in, so a
// stray command line cannot change the account by accident.
export async function runAction(client, protocol, id, params = {}, { allowMutate = false, timeout = 15000 } = {}) {
  const action = assertAllowed(id, { allowMutate });
  const body = buildBody(action, params);
  if (!protocol[action.request]) throw new Error(`protocol has no type ${action.request}`);

  if (id === 'emailQuickGet') {
    const result = await claimMail(client);
    if (result.ok === false) throw Error(result.error);
    return { id, sent: result.sent ? action.request : null, response: null, body: result };
  }

  if (action.response && protocol[action.response]) {
    const response = await client.request(action.request, body, action.response, timeout);
    return { id, sent: action.request, response: action.response, body: response };
  }
  // 没有配套 Response 的写请求：成功时服务端一声不吭，被拒时只推 PromptResponse，
  // 所以守着窗口听一下，守到就算失败（见 src/client.mjs 的 attributePrompt）。
  await client.sendWatch(action.request, body, { window: 400 });
  return { id, sent: action.request, response: null, body: null };
}
