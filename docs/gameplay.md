# 疯狂水世界 玩法与协议地图

早期章节中的账号数据来自一次登录后的只读采集。后续章节另外标明了客户端配置、协议定义和操作实测的依据。

- 采集方式：`node src/app.mjs state --out`，登录后一次性发出真实客户端进主界面时的全部只读查询。
- 采集结果：47 条响应全部成功，0 失败，耗时 106ms。
- 原始快照：`data/state.json`（含登录信息与该账号的全部响应体）。
- 字段布局来源：`tools/describe.mjs` 从游戏自带的 protobuf 生成代码中还原，未使用任何 `.proto` 描述符。

合规说明：协议挂机违反游戏用户协议，存在封号风险。文中带 `--yes` 的操作会改变账号状态。

## 1. 身份、区服与登录

网关 `wss://dhyaoj-gate.khlgamen.com/ws`。首次连接直接发 `LoginRequest`，没有独立的挑战握手；`LoginResponse.result === 0` 才是鉴权成功。2026-10-19 解包版本 71 确认枚举 `LOGIN_SUCCESS=0`、`SERVER_MAINTAIN=1`，更正此处原先将 1 写为成功的错误，详见 [微信登录分析](wechat-login.md)。

网关不区分区服：一个 socket 服务整个账号，区服由 `LoginRequest.worldId` 选择，`worldId=0` 表示进入账号上次所在的区服。

- 选服界面的键是 `GameWorldInfo.worldId`，即角色**出生**的区服。
- `roleInfo.worldId` 是角色**当前**所在的区服。
- 合服后两者不同，服务端会把请求的出生服键解析到承接服。本账号实例：请求 `2001001001`，返回角色的 `worldId=2004001001`、`bornWorldId=2001001001`。不了解这一点会把合服误读成 bug。
- 区服显示名由客户端 `WorldIdRule` 计算：`worldId = 大区 × 1e9 + 赛季 × 1e6 + 区服序号`，名称为“大区前缀 + 序号 + 服”。大区 3 是海港、4 是海灯，其余按海岛处理；赛季不进入显示名。

本账号实测身份：

| 字段 | 值 |
|---|---|
| id | 55059310000001 |
| nickname | 示例玩家1001 |
| level | 11 |
| power | 40889 |
| worldId | 2004001001 |
| bornWorldId | 2001001001 |
| appId | 14021170 |
| channelId | 1400 |
| newRole | false |

账号下 2 个区服，所属分组 137 共 98 个区服。

## 2. 进入世界后的只读状态集

真实客户端登录后会在一次突发里发出 47 个查询，服务端全部一次返回。两个信号没有对应的 `*Response` 类型，走推送或通用 `OkResponse` 应答，以即发即弃方式发送。

查询按客户端顺序（`src/game.mjs` 的 `ENTRY_QUERIES`）：

```
AllItem              AllResource          AllHero              GetFormation(module=1)
EmailBox(pageNo=0)   Equips               Badges               RecruitInfo
AchievementInfo      DailyTaskInfo        MainTaskInfo         GuideInfo
AfkInfo              MonthCard            AllAntique           OnWater
FishEncyclopedia     CargoShips           AppointInfo          ChatRecord(channel=1)
GameEffect           AllGuildAbstraction  MyFleets             PirateKillRecord
MyResFields          GuildTechInfo        GuildOrder           MyFormationPreset
SeasonTaskStage      WorldBossInfo        LimitedBossOpen      AllPet
SeasonRankInfo       WeekInfo             PassStageState       WeekOrderInfo
CounterInfo          RadarInfo            EnvSkinList          ChannelRewardInfo
LimitTicket          SeasonCard           AllPirate            PlayerFrame
ChurnInfo            UltraOpen            BlackList
```

信号（`ENTRY_SIGNALS`）：`ExitWorldMapRequest`、`RedPointRequest`。

`collectState()` 一次发出全部查询，按请求名收集结果；`summarize()` 把它归约成玩家视角的状态；`formatState()` 负责渲染，CLI 与网页控制台共用同一个渲染器。

## 3. 系统地图

下面每个系统给出：玩家可见的玩法、对应的协议入口、以及本账号的实测值。

### 3.1 资源与道具

- 协议：`AllResourceRequest`、`AllItemRequest`。
- 资源是服务端数字枚举，道具 ID 是中文字符串，自描述。

资源实测：

| res | 枚举名 | 展示名 | amount |
|---|---|---|---|
| 3 | GOLD | 金币 | 67070 |
| 4 | RUBY | 钻石 | 5785 |
| 5 | ARENA_POINT | 挑战券 | 10 |
| 6 | LEAGUE_POINT | 积分赛挑战券 | 10 |

数字枚举到字符串 id 的映射只存在于客户端生成代码里：`Resource = {1:"EXP", 3:"GOLD", 4:"RUBY", 5:"ARENA_POINT", 6:"LEAGUE_POINT"}`（2 被跳过）。展示名再经 CDN 的 `ResourceCfg` 表解析。

道具实测：共 52 种、308650 个。数量靠前的有 `英雄经验` 290020、`木材` 1200、`玻璃` 1200、`加速器` 801、`建筑蓝图` 74、`橙卡万能碎片` 26、`抽卡券` 9。

### 3.2 英雄、阵型与任命

- 协议：`AllHeroRequest`、`GetFormationRequest{module}`、`MyFormationPresetRequest`、`AppointInfoRequest`。
- 英雄 ID 是中文字符串，另有 `showName` 展示名与 `skinId` 皮肤。

实测 7 个英雄，总战力 45280：

| heroId | 展示名 | level | star | power |
|---|---|---|---|---|
| 杰森 | 鬼火杰森 | 45 | 0 | 11658 |
| 蜜雪 | 蜜雪儿 | 45 | 1 | 11240 |
| 赏金猎人 | 赏金猎人 | 45 | 2 | 7117 |
| 棒球手 | 重炮琼斯 | 45 | 0 | 6320 |
| 弓箭手 | 珍妮 | 45 | 3 | 4554 |
| 机器警察 | 警员鲍勃 | 1 | 2 | 2473 |
| 小布 | 小布 | 1 | 2 | 1918 |

每个英雄带 `attributes` 数组，`attr` 是服务端数字枚举。观察到的 attr 值：1、2、3、4、6、7、8、9、12、14、16、18、19。`attr=1` 数值最大，与 `power` 量级一致，是最可能的攻击或战力主属性；`attr=4` 是小数，取值 0.6/0.75，像暴击率或类似百分比。名称表由 CDN 下发，包内没有。

`skillLevels` 是长度为 4 的数组，本账号英雄全部为 `[1,0,0,0]`，即只解锁了第一个技能。另有 `equips`、`badges`、`chips`、`heroFates`、`skillUpgrades` 五条独立的养成线。

`AppointInfoRequest` 返回 `heroes[]`，元素为 `{heroId, posId}`，是英雄任命到职位的配置。

### 3.3 招募与藏品

- 协议：`RecruitInfoRequest`、`AllAntiqueRequest`。
- 免费招募有冷却时间，招募有保底计数。

实测：

| 类别 | 已招募 | 下次保底 | 免费冷却结束 |
|---|---|---|---|
| 英雄 | 52 | 48 | 1786632105 |
| 藏品 | 21 | 9 | 1786591840 |

已拥有：藏品 7 件、大师等级 1、套装 0；宠物 0；装备 0。

### 3.4 水上建筑与工厂生产线

- 协议：`OnWaterRequest`。
- 响应有 11 个字段：`building[]`、`floater[]`、`workerOrder[]`、`fishingLevel`、`salvageLevel`、`divingLevel`、`autoProduceEndTime`、`autoProduceForever`、`orderOfTheDay`、`autoFarming`、`adv[]`。
- 建筑 ID 是中文字符串，形如 `1训练营`、`1切鱼厂`、`2A民居`，前缀数字是等级段，后缀是品类。

`DispWaterBuilding` 有 15 个字段。除建筑本身外，还挂了工厂 `factory`、装备制造 `equipMaking`、舰队 `fleet`、农田 `farm`、宠物培育 `petBreed`、宠物服务 `petServe` 六种功能，同一张建筑表承载了全部水上设施。

`DispFactory` 三个字段：`factoryQ[]` 生产队列、`finishedProducts[]` 已完成的成品、`autoProductId` 自动生产的产品。

`DisplayAsset` 形状为 `{type, id, num}`，`type=0` 是道具、`type=1` 是资源，`id` 为字符串。

实测 22 座建筑。可操作的信号：

- 待竣工，`buildFinishTime` 已过：`1训练营`、`1食品厂`。
- 工厂有成品未收：`1切鱼厂` 有 `鱼肠线`x4、`生鱼片`x2；`1材料厂` 有 `布匹`x4；`1食品厂` 有 `烤鱼`x5；`1服装厂` 有 `救生衣`x4。

产出链是真实的生产链：`1食品厂` 用鱼做 `烤鱼`，`1切鱼厂` 把鱼切成 `鱼肠线`/`生鱼片`，`1服装厂` 出 `救生衣`，`1材料厂` 出 `布匹`。

### 3.5 挂机（离线收益）

- 协议：`AfkInfoRequest`。
- 响应结构：`AfkInfoResponse { afkInfo: DispAfkInfo, clickGoldInfo: DispClickGoldInfo }`。

`DispAfkInfo` 四个字段，全部是 int32：

| 字段 | 含义 |
|---|---|
| level | 当前挂机等级 |
| afkStartTime | 本段收益开始时间 |
| afkFinishTime | 收益封顶时间 |
| rewardedLevel | 已领奖到的等级 |

机制：收益在 `afkFinishTime` 之前持续累积，到点后停止增长（封顶）。领奖会把收益结算掉并开启新的时间段。

等级奖励不是"level 减 rewardedLevel"，而是由配置表决定，两条规则都在客户端代码里：

- 可领的等级 = `OfflineLvRewardCfg` 中第一个 `level > rewardedLevel` 且 `reward` 非空的条目。
- 只有该等级 `<= afkInfo.level` 时才允许领取；否则客户端只弹提示，根本不发请求。

实测：`level=1`、`rewardedLevel=0`。`OfflineLvRewardCfg` 的 1 级 `reward` 为空，下一个有奖励的是 2 级，而挂机等级只有 1，所以当前没有可领的等级奖励。服务端对 `DrawAfkLevelRewardRequest{level:1}` 回 `PromptResponse{args:["no claimable afk reward"]}`，对 `level:2` 回 `"afk level too low"`，与上述规则一致。

`DispClickGoldInfo` 是点金玩法：`freeTimes`、`paidTimes`、`minGold=7500`、`resetTime`、`maxPaidTimes=7`。

### 3.6 日常：每日任务、成就、活跃宝箱、邮件

- 协议：`DailyTaskInfoRequest`、`AchievementInfoRequest`、`EmailBoxRequest{pageNo}`、`ChurnInfoRequest`、`ChannelRewardInfoRequest`。

`DailyTaskInfoRequest` 字段：`dailyTask[]`、`dailyRewardClaimed[]`、`weeklyRewardClaimed[]`、`dailyActivity`、`weeklyActivity`、`dailyResetTime`。

任务元素 `{id, progress, targetProgress, rewardClaimed}`。完成判定是 `progress >= targetProgress`；已完成且未领奖的就是可领项。

实测：任务 ID 从 1001 起，`1001` 已完成未领、`1002`/`1003` 未完成；`dailyActivity=0`。

`EmailBoxRequest` 返回 `{email[], total}`，元素含 `emailId`、`subject`、`emailType`、`status`、`sender`、`sendTime`、`content`、`attachment`、`got`、`scenarioId`。附件 `attachment.assets.asset[]` 是 `DisplayAsset` 数组。实测 1 封系统邮件「新赛季开始」，附件含 `抽卡券`x10、`汽油`x150000、`种子`x50000、`RUBY`x200、`公会科技点`x50000，未领取。

`ChurnInfoRequest` 含 `task`、`gotTaskId`、`gotPaidGift`、`paidPack`、`type`，是流失召回与付费礼包的运营投放。

### 3.7 世界地图：资源田、舰队、货船、海盗、世界 Boss

- 协议：`MyResFieldsRequest`、`MyFleetsRequest`、`CargoShipsRequest`、`AllPirateRequest`、`PirateKillRecordRequest`、`WorldBossInfoRequest`、`LimitedBossOpenRequest`、`RadarInfoRequest`。

实测：资源田 `0/10`（上限 10）、舰队 0、货船 0、海盗 0（扫荡次数 0）、世界 Boss `raidId=0`、雷达 `raidId=0`。这些是世界服玩法，本账号等级尚低，基本未参与。

### 3.8 公会

- 协议：`AllGuildAbstractionRequest`、`GuildTechInfoRequest`、`GuildOrderRequest`。

实测返回 4 个公会条目，ID 形如 `2004001001004`，前缀与世界 ID 一致，说明公会 ID 在世界内分配。每条含 `flagBackground`、`flagPattern`、`level`。本账号未入会。

日常计数 `CounterInfoRequest.counters[]` 是本账号的活跃度计数：

| type | num |
|---|---|
| DAILY_WORLD_BOSS_TIMES | 0 |
| DAILY_GUILD_AID | 0 |
| DAILY_WORLD_ONLINE_RWD | 0 |
| DAILY_FINISH_GUILD_ORDER | 0 |

### 3.9 赛季、周活动、月卡

- 协议：`SeasonRankInfoRequest`、`SeasonTaskStageRequest`、`SeasonCardRequest`、`WeekInfoRequest`、`WeekOrderInfoRequest`、`MonthCardRequest`、`BattlePassRequest`、`PassStageStateRequest`。

赛季实测：`startTime=1791561600`、`midEndTime=1793375973`、`endTime=1795449570`、`seasonTaskStage=1`，另有 `midAutoGrantTime`、`autoGrantTime` 两个自动发奖时间点。

周活动实测 5 条，每条 `{type, period, startTime, endTime}`，type 取值 1、2、4、5、6，period 是区分同类活动的周期编号（4021、104001、140011、4001、4001）。

月卡 `MonthCardRequest.cardItem[]`，元素含 `type`、`endTime`、`gotDailyReward`；`endTime > now` 即生效。

### 3.10 引导与主线

- 协议：`GuideInfoRequest`、`MainTaskInfoRequest`、`GameEffectRequest`、`EnvSkinListRequest`、`PlayerFrameRequest`、`LimitTicketRequest`、`BlackListRequest`。

引导实测 `{triggerGuideId: [1,2,3,4,36,5,6,8,9,10,43,12,14,15,16,17,18,20,22], guide: {stage: 2, step: 1}}`，即引导进度停在第 2 阶段第 1 步。

## 4. 挂机收益闭环

这是本阶段最有价值的发现。全部免战斗的收益入口都已定位：

### 4.1 离线挂机

```
AfkInfoRequest              -> AfkInfoResponse { afkInfo{level, afkStartTime, afkFinishTime, rewardedLevel}, clickGoldInfo }
DrawAfkRewardRequest        -> DrawAfkRewardResponse { reward, afkStartTime, afkFinishTime }   领取本段收益并重置时间段
UpgradeAfkLevelRequest{level}  ->  提升挂机等级，消耗 OfflineCfg 里该等级声明的物品
DrawAfkLevelRewardRequest{level}  ->  领取等级奖励，level 取自 OfflineLvRewardCfg
```

实测一次 `DrawAfkRewardRequest` 返回 `reward.assetPackage.asset = [{type:1,id:"GOLD",num:800}, {type:0,id:"加速器",num:8}]`，并把时间段重置为 start=1791612415、finish=1791641215（8 小时）。`type:1` 是资源、`type:0` 是道具。

`DrawAfkRewardRequest` 的响应会回传新的 `afkStartTime`、`afkFinishTime`，客户端据此刷新倒计时，不需要额外查询。

### 4.2 建筑与工厂生产

```
GainFactoryProduceRequest{buildingId}        -> GainFactoryProduceResponse        收取工厂成品
CollectBuildingProductRequest{buildingId}    -> CollectBuildingProductResponse    收取建筑产物
FinishUpgradeBuildingRequest{buildingId}     竣工，仅在 buildFinishTime 已过时有效，无响应类型
SetBuildingAutoWorkRequest{buildingId, isOn}    开关自动工作，无响应类型
SetFactoryAutoProduceRequest{buildingId, productId}   设置工厂自动生产的产品，无响应类型
```

四个无响应类型的请求由推送或通用 `OkResponse` 应答，实现上以即发即弃方式发送。

### 4.3 扫荡

以下请求的响应直接携带 `reward`，无需本地战斗推演：

```
ArenaSweepRequest           CatcherSweepRequest        ExpeditionSweepRequest
PirateSweepRequest          TrialRaidBuySweepRequest
```

配合 `ChallengeStageRequest`、`ChallengeWorldBossRequest`、`ChallengeResFieldRequest`、`ChallengePirateRequest`、`ArenaChallengeRequest`、`TrialRaidChallengeRequest` 等直接挑战的入口。战斗为服务端结算：`ChallengeStageResponse` 同时返回 `initialData`、`stats.isLeftWin`、`reward`，本地战斗推演只用于动画回放。挂机不需要复刻战斗引擎。

### 4.4 日常领取

```
DrawDailyRewardRequest{index}        领取每日活跃宝箱，无响应类型
DrawDailyTaskRewardRequest{id}       领取每日任务奖励
GotAchievementRewardRequest{id}      领取成就奖励，无响应类型
QuickGotReadEmailRequest{all}        一键处理未读邮件与附件，无专属响应类型
MonthCardDailyRewardRequest          领取月卡每日奖励，无响应类型
```

### 4.5 采集侧与发放侧的对应关系

邮件入口先按 `EmailBoxResponse.total` 遍历所有分页，处理未读邮件及未领取附件；发送一键领取后再次完整读取邮箱，按精确 `emailId` 核对已读/已领状态。分页不完整时不提交，领取结果未确认时不报告成功，也不在同一轮重发。

采集用 `AfkInfoRequest` / `OnWaterRequest` / `DailyTaskInfoRequest` 判断"有没有可领的"，发放用 4.1 到 4.4 的请求执行。判定与执行完全解耦，这正是挂机客户端需要的形状：轮询采集，条件满足才发发放请求。

本账号当前实际可执行的操作：

- 挂机有 1 个待领等级，本段收益已封顶。
- `1训练营`、`1食品厂` 待竣工。
- `1切鱼厂`、`1材料厂`、`1食品厂`、`1服装厂` 有工厂成品待收。
- 1 封系统邮件附件未领，每日任务 `1001` 已完成未领奖。

## 5. 协议表面统计

- 协议表共 1558 个键：约 1495 个消息类型、62 个枚举、1 个 `BattleService`。
- `tools/describe.mjs` 已从生成代码中还原 1506 个类型的字段布局。
- 扫荡类请求 8 个，战斗与挑战类请求 16 个。
- 已实现的动作目录（`src/actions.mjs`）13 个，全部是状态变更动作，全部带门控。

## 6. 配置表

配置表不在游戏包里，是 Cocos 的独立远程 bundle `config_cn`。2026-11-13 实测客户端 1.14.5 读取 `https://dhyaoj-cdn.khlgamen.com/HotUpdateRes/wx/1.14.5/version.manifest`，发布版本为 1.14.5.112，`bundleVers.config_cn=f6b95`、`bundleVers.world_map=cda1a`。先获取 `remote/config_cn/config.<版本>.json`，再按 `packs/uuids/versions.import` 取得实际 JSON 数据包；当前为 635 张表。地图也按同一发布清单的版本和资源索引下载，不将旧地图与新配置混用。

控制台和 CLI 持续挂机启动检查并默认每 30 分钟复查，配置与地图验证后保存在 `work/cdn/resources/<版本目录>/`，最后原子替换 `active.json`。旧任务保留配置及地图目录快照，下一轮重新读取新配置。配置来源优先级为 `CW_CONFIG_PACK` 显式文件、已验证远程版本、按修改时间选择的本地同步副本/微信缓存。显式文件会停用远程更新；下载失败不破坏已有版本。`npm run sync-resources` 可手动触发，`CW_RESOURCE_UPDATE_MINUTES` 调整间隔，`GET /api/resources` 查询状态。客户端大版本需另外确认兼容性后调整 `CW_RESOURCE_APP_VERSION`，协议代码仍来自本机客户端包。

`src/config.mjs` 负责加载，`node tools/sync-config.mjs` 把缓存快照到 `work/cdn/`，`node src/app.mjs config [表名]` 查看。

几个关键表：

| 表 | 行数 | 用途 |
|---|---|---|
| ResourceCfg | 5 | 资源数字枚举到展示名 |
| OfflineCfg | 601 | 挂机每级的主线门槛 `stage` 与消耗 |
| OfflineLvRewardCfg | 133 | 挂机等级奖励，`reward` 为空的等级不产出 |
| DailyTaskCfg | - | 每日任务目标与奖励 |
| AchievementTaskCfg | - | 成就目标与奖励 |
| BuildingCfg / BuildingProduceCfg | - | 建筑与生产链 |

## 7. 已知未解

- `PromptResponse` 只带 `style`/`prompt`/`args`，`prompt` 是数字、`args` 是文案。数字到提示类型的映射表尚未定位，目前直接展示 `args` 文本。
- 英雄 `attributes[].attr` 是服务端数字枚举，取值 1/2/3/4/6/7/8/9/12/14/16/18/19，名称表（`HeroAttributeCfg`）已在配置表里，但数字到枚举的映射还没从客户端代码里抠出来。
- 其余 CDN bundle（美术、音频、地图）尚未获取，挂机用不到。

## 8. 安全边界与门控

- 本阶段的全部采集都是只读请求，不改变账号任何状态。
- 状态变更动作集中在 `src/actions.mjs`，共 24 个，全部标记 `mutate: true`。
- 门控在连接之前生效：`assertAllowed` 与 `buildBody` 在 `client.connect` 之前调用，未显式授权时不会打开任何会话。
- 授权方式：命令行加 `--yes`，或环境变量 `CW_ALLOW_MUTATE=1`；网页控制台另需请求体里带 `confirm: true`。
- 已对真实账号执行过的变更：一轮 `loot --yes`（见第 10 节）、日常任务一轮（见 11.4）、
  英雄养成两轮（见 11.4）、进度任务领取与海面排产各若干轮（见 12.6）。
- 付费动作单独门控：点金/折扣商店这类要花钻石的，还要 `--paid` 才执行，默认跳过。
- 加速与拒单各有独立开关（`--speed-up` / `--reroll`），默认关闭；加速计划只花「加速器」道具，
  `SpeedUpCostParam.type` 发 2，不用钻石(1)。广告(3)只由独立开关的广告加速使用，见 13.7。
- 不使用 `LoginRequest` 里的 `testAccount` / `superToken` 等开发者字段（鉴权后门，不在范围内）。
- 账号选择（`--account` / `CW_ACCOUNT` / 网页 `?account=`）只是挑「用哪份已有凭证」，
  不会放宽任何一项授权要求，也不会顺带连接：连接仍然要显式动作。
- 网页「一键扫码 + 抓包」会动系统设置（HKCU 代理 + 当前用户根证书）。它比普通写操作门控更重：
  必须先在页面上确认，且改动随时可完整回滚（见 13.2）。

## 9. 复现命令

```bash
node src/app.mjs state --out        # 采集状态并写入 data/state.json
node src/app.mjs state --raw        # 采集并打印原始响应体
node src/app.mjs worlds             # 列出账号区服与登录区服的用户信息
node src/app.mjs worlds <worldId>   # 进入指定区服并打印其用户信息
node src/app.mjs actions            # 列出动作目录
node src/app.mjs act <id> k=v --yes # 执行单个动作，需显式授权
node src/app.mjs loot --dry         # 预览一键领取计划，不发任何请求
node src/app.mjs loot --yes         # 执行一键领取，需显式授权
node src/app.mjs heroes --dry       # 预览英雄养成计划，不发任何请求
node src/app.mjs heroes --yes       # 执行英雄升级/升星/技能，需显式授权
node src/app.mjs dailies --dry      # 调研 17 项日常任务各能不能做
node src/app.mjs dailies --yes      # 自动完成能做的日常并领奖，需显式授权
node src/app.mjs dailies --yes --paid  # 允许花钻石的日常（点金/折扣商店）
node src/app.mjs tasks --dry        # 预览主线/支线/成就/订单档位的可领清单
node src/app.mjs tasks --yes        # 领取全部可领任务奖励，需显式授权
node src/app.mjs world --dry        # 预览海面计划（收成品/竣工/交单/排产/升级）
node src/app.mjs world --yes        # 执行海面计划，需显式授权
node src/app.mjs world --yes --speed-up --reroll   # 额外允许花加速器与拒单重刷
node src/app.mjs field              # 只读报告：资源田、城市、舰队与占田可行性
node src/app.mjs field occupy <gridIdx> --fleets a,b --yes   # 派舰队占田
node src/app.mjs field giveup <gridIdx> --yes                # 放弃资源田
node src/app.mjs loop --rounds 3 --every 60 --yes            # 定时循环：任务+日常+海面
node src/app.mjs config [表名]      # 查看本地配置表
node src/app.mjs accounts           # 列出本机存了哪些账号，当前账号前面带 *
node src/app.mjs state --account 示例玩家1001   # 按昵称/序号/id 前缀挑账号，也可用 CW_ACCOUNT=...
node tools/sync-config.mjs          # 把配置表缓存快照到 work/cdn
node tools/sync-art.mjs             # 把界面要用的图集从微信缓存镜像到 work/cdn/art
node src/art.mjs                    # 打印素材覆盖率；带个名字就查它对应哪个图标
node src/app.mjs selftest           # 离线自检
node tools/selftest-describe.mjs    # 字段布局还原自检
```

## 10. 本次实际执行的一次领取

已对真实账号执行过一轮 `loot --yes`，共 12 项计划，11 项成功：

| 动作 | 结果 |
|---|---|
| 邮件一键领取 | 附件入账（汽油 15 万、种子 5 万、公会科技点 5 万、紫藏品经验 4400） |
| 每日任务 1001 | 领取成功 |
| 成就 1010 / 1011 | 已提交 |
| 挂机本段收益 | 金币 800 + 加速器 8，时间段重置为 8 小时 |
| 挂机等级 1 | 服务端回 `no claimable afk reward`，符合配置表规则 |
| 四个工厂成品 | 鱼肠线、生鱼片、布匹、烤鱼、救生衣全部入账 |
| 1训练营 / 1食品厂 竣工 | 均已完成 |

前后对比：金币 66270 变 67070、钻石 5585 变 5785、道具 52 种变 56 种、邮件未领 1 变 0、成就完成 9 变 11。

## 11. 英雄养成与日常任务（协议侧自动化）

新增两个模块：`src/heroes.mjs`（升级 / 升星 / 技能）与 `src/dailies.mjs`（每日任务驱动注册表）。
两者都是「只读探测 → 算出计划 → 显式授权后逐条执行」，网页控制台对应「英雄养成」与「日常任务」两个页签。

### 11.1 升星一次只涨一星

`HeroStarUpRequest{heroId, universal}` 的成功响应是 `HeroStarUpResponse.nextStar`，
一次只推进一颗星；客户端 `_onBtnStarUp` 点一次也只发一条。所以 0 星升到 8 星是 **8 条请求**，
计划器必须按星逐条展开（早期把它当成一条请求发，结果只涨了 1 星）。
`universal:true` 等价于面板上的「自动兑换」，允许用 `HeroCfg.universalItemId` 的万能碎片补差额。

### 11.2 技能升级的门槛是星级，不是当前星级的技能上限

客户端里有两套不同的判定，很容易搞混：

- `HeroSkillUtil.isSkillLevelUp(hero, slot, level)`（红点用）
  `cap = HeroStarCfg[当前星级].maxSkillLevel[slot]`。
- `HeroSkillPanel._showFromHero()`（按钮能不能点，服务端也按这套校验收到的请求）
  `cap = HeroStarCfg[最大星级].maxSkillLevel[slot]`，
  并且要求 `hero.star >= HeroUtil.heroStarBySkillLv(slot, 目标等级)` ——
  即 HeroStarCfg 里第一条 `maxSkillLevel[slot] >= 目标等级` 的记录的 star。

按红点那套算出来的计划会被服务端以 `PromptResponse{"args":["upgrade condition unmet"]}` 拒掉。
本机实测：技能槽 1 升到 2 级需要 5 星、升到 3 级需要 10 星。
消耗取 `HeroSkillUpCfg[品质_目标等级].costArr[槽位]`，和客户端 `skillUpCost` 一致。

### 11.3 PromptResponse 的归属规则

服务端在业务拒绝时不回 `*Response`，只推一条 `PromptResponse{style, prompt, args[]}`，
而这条消息**不带我们发出去的 seq**，无法直接对应请求。

`HeroLevelUpRequest` / `HeroSkillLevelUpRequest` / `DiscountShopBuyRequest` 这类请求
没有配套 Response：成功时服务端一声不吭，被拒时只有那条 PromptResponse。
一次英雄养成有 160+ 条这样的请求，归错一条就会把同时段在飞的无关请求拒掉 ——
实测中一条技能升级被拒的 PromptResponse 拒掉了当时在飞的 `AllHeroRequest`，
整个 HTTP 调用变成 400。

规则：**服务端按请求到达顺序应答，所以一条 prompt 属于最早那条还没被应答的发送**。
`GameClient.sendWatch(name, body, {window})` 为无响应请求开一个观察窗口（守到 prompt 即被拒，
窗口内没动静即成功），`GameClient.attributePrompt()` 按上面的顺序规则认领。

### 11.4 本轮实测结果

英雄养成：7 个英雄全部从 lv45 升到玩家等级允许的上限 lv55；蜜雪 2→8 星、杰森 1→2 星
（共 24 个万能碎片）；蜜雪技能 1、2 各升到 2 级（20 本橙技能书）。共 9 条请求，全部成功，
之后计划器剩余步骤为 0。

日常任务：17 项里 10 项可协议完成（1001-1007 全部完成并领奖），消耗钻石 18。
其余 7 项阻塞原因：1008 地图上没货轮/世界货物、1009 试炼副本需要玩家等级 14（当前 11）、
1010 地图上没有海盗、1011-1017 需要联盟身份 / 限时时段 / 功能未开放。

## 12. 任务领取与海面自动化

新增三个模块：`src/tasks.mjs`（任务领取闭环）、`src/world.mjs`（海面探测 / 计划 / 执行 / 资源田）、
`src/loop.mjs`（把任务、日常、海面串成定时循环）。网页控制台对应「自动循环」页签。

### 12.1 三类任务，三种结构

| 任务 | 响应 | 字段 | 领取请求 |
|---|---|---|---|
| 主线（成长） | `MainTaskInfoResponse.task`（单条） | `DispMainTask{taskId, progress, rewardClaimed}` | `DrawMainTaskRewardRequest{taskId}` |
| 支线 | `MainTaskInfoResponse.branch[]` | `DispBranchTask{taskId, progress}`，**没有 rewardClaimed** | `GotBranchTaskRewardRequest{taskId}` |
| 成就 | `AchievementInfoResponse.task[]` | `DispAchievementTask{id, progress, targetProgress, rewardClaimed}`，**自带目标** | `GotAchievementRewardRequest{id}` |

主线与支线的响应里没有目标值，只能从 `MainTaskCfg` / `BranchTaskCfg` 的 `params` 取
（`{taskId, type, desc, params:[...], reward}`）。取法对齐客户端 `TaskUtil.taskProgress()`：

- 大部分类型的目标值是 `params[0]`；
- `拥有指定资源` / `获取资源` / `生产物品` / `种植作物` / `占领资源地` / `击败野怪` /
  `英雄升星` / `英雄万能升星` / `藏品万能升星` / `强化装备` / `分解装备` / `分解海兽`
  这 12 类取 **`params[1]`**（`params[0]` 是物品名或类型名）；
- `升级建筑` 的 `params[1]` 形如 `"1|1"`（数量|等级），取竖线前那段；
- `试炼挑战` 的目标值客户端写死为 1。

取不出目标值（`params` 缺失或太短）的任务返回 `null`，**不排进计划**，只在 notes 里写明，
宁可漏领也不猜。

每日订单进度奖励：`OnWaterResponse.orderOfTheDay = {orderNum, rewardedNum}`，
`rewardedNum` 是「最后一个已领档位的 reqNum」，所以下一档是第一个大于它的
`OrderDailyRewardCfg.reqNum`（6/12/18/24/30/40 …），领取用空体 `GetNextOrderOTDRewardRequest{}`，
一次领一档。

### 12.2 建筑 ID 与工厂队列

`buildingId` 是 `<序号><可选字母><建筑类型>`（`1食品厂`、`1A民居`、`1指标楼A`）。
匹配类型时按**最长后缀**去比 `BuildingCfg.buildingType`（58 种），否则「海水厂」会被
更短的「水厂」之类抢先匹配。

- 人口由客户端计算，`population = GameParamCfg 初始人口 + Σ 已建成民居当前等级的「人口增加」`，
  `maxPopulation = GameParamCfg 初始人口上限(10) + Σ「人口上限」`。协议里没有，计划器只能按同样口径离线复算。
- `DispFactory{factoryQ:[{idx, productId, finishTime}], finishedProducts[], autoProductId}`。
- 常量散在几张 param 表里：`制造位上限=6` 在 `BuildingProduceParamCfg`，
  `产品存量初始上限=50`、`初始人口上限=10` 在 `GameParamCfg`，`订单每日上限=40` 在 `OrderParamCfg`。
  按名字查时要跨表查，只查一张表会拿到 0（本轮踩过：制造位上限读成 0，导致所有工厂都被判定为队列已满）。
- `AllResourceResponse.list[].res` 是数字（`{EXP:1, GOLD:3, RUBY:4, ARENA_POINT:5, LEAGUE_POINT:6}`），
  而配置表的消耗项写的是名字（`GOLD`、`木材`），两边要分开对待。

### 12.3 收成品、排产与升级的实测时序

| 请求 | 配套 Response | 说明 |
|---|---|---|
| `GainFactoryProduceRequest{buildingId}` | 有 | 领工厂囤积的成品，回 `products.asset[]` |
| `CollectBuildingProductRequest{buildingId:[]}` | 有 | 非工厂建筑的产物，可一次传多个 |
| `StartFactoryProduceRequest{buildingId, productId}` | 无 | 只有这 2 个字段 |
| `FinishWorkerOrderRequest{index}` | 有 | 交居民订单 |
| `UpgradeBuildingRequest{buildingId}` | 无 | 升级建筑 |
| `SpeedUpUpgradeBuildingRequest{buildingId, speedUp}` | 无 | 加速建造 |
| `SpeedUpFactoryProduceRequest{buildingId, speedUp, index}` | 无 | 加速生产，`index` 是队列下标 |

`SpeedUpCostParam{type, useNum}`，`type`: 1=钻石 2=加速器 3=广告；加速计划只用 2，广告分支见 13.7。
`useNum` 按客户端 `new SpeedUpResult(!0, SPEED_UP_ITEM, min(ceil(剩余秒/60), 持有量))` 算，最少 1。

实测（收成品）：对 4 栋有囤积成品的工厂各发一条 `GainFactoryProduceRequest`，
`finishedProducts` 立刻清空，`生鱼片 18→19`、`淡水 15→16`、`布匹 12→13`、`救生衣 9→10`，
响应体是 `{"products":{"asset":[{"type":0,"id":"生鱼片","num":1}]}}`。

实测（排产）：`StartFactoryProduceRequest` 入队时 `finishTime` 就是当前时刻，
5 秒内该队列项消失并出现在 `finishedProducts` —— 即这条请求一次只产 1 件且**即时完成**，
`BuildingProduceCfg.produceTime`（90/300 秒）在界面上是倒计时展示，不是这条请求的等待时间。
所以循环里每轮「收成品 + 排产」是正常的一进一出，不是重复发同一个请求：
只有当队列里已经有同一个 `productId` 时计划器才会跳过（此时它会去挑别的配方）。

### 12.4 资源田：静态数据在客户端地图 bundle 里

`MyResFieldsResponse.info = {fields:[{gridIdx, cityId, type}], maxNum}` 只描述**已经占下的**田。
哪些 `gridIdx` 是田来自客户端静态地图数据（`worldModelMgr.getResourceModel(gridIdx)`），
591 张配置表里没有任何 grid→田 的映射。地图 bundle 已从 CDN 取下并解码：

- `world_map1`：240x640，97 城，717 块田；`world_map2`：408x1088，281 城，2531 块田。
- `mapData[gridIdx] = resType * 10000 + cityId`；`cityInfo[cityId] = {gridIdx, fort, res:[田的 gridIdx...], neighbors, monsters}`。
- 读取入口 `src/world.mjs` 的 `loadMapAsset(scenarioId)`，文件在 `work/cdn/world_map.world_map1.json`。

占田用 `ChallengeResFieldRequest{resFieldGridIdx, fleetBuildingIds}`、放弃用
`GiveUpResFieldRequest{resFieldGridIdx}`，两者都无 Response。

**实测本账号不可自动占田**：`MyFleetsResponse.fleets` 是空数组，占田的前置条件
（有闲置且 `durability>0` 的舰队）不满足；账号 `guildId=0` 也没有联盟。
因此 `field` 模式只做只读报告（`src/world.mjs` 的 `formatFieldReport` 会如实打印
「没有舰队，占田的前置条件不满足」），占田 / 弃田必须手动指名 `gridIdx` 并显式 `--yes`。

### 12.5 循环与门控

`runLoop` 每轮顺序执行：任务（`surveyTasks` → `runTasks`）→ 日常（`surveyDailies` → `runDailies`）
→ 海面（`surveyWorld` → `planWorld` → `runWorld`）。每轮都是「先只读探测，再算计划，再执行」，
所以第二轮起没什么可做时计划自然为空，不会重复发同样的请求。被服务端拒过的具体动作记在
跨轮的 `rejected` 集合里，同类动作失败后不再重试。

门控延续既有边界，未放宽：写请求要 `--yes` 或 `CW_ALLOW_MUTATE=1`，网页要 `confirm: true`；
`DenyOrder`（拒单消耗订单名额）与加速各有独立开关（`--reroll` / `--speed-up`），默认关闭；
加速只花「加速器」道具，**不花钻石**；`--rounds 0` 表示一直跑到 Ctrl-C / 网页停止按钮。

### 12.6 本轮实测结果

- `tasks`：主线 62 领取成功，下一轮立刻出现主线 63，说明成长任务是链式的（领完当前才解锁下一条）。
- `world`：一次计划 8 条（4 收成品 + 4 排产），8/8 成功，材料按配方扣减
  （木材 -5、塑料 -15、玻璃 -10、海藻 -20、碎布 -30）；再探测时订单 #1-#4 仍是材料不足，
  按「不重刷」策略保留等待生产。
- `loop --rounds 1 --every 5 --yes`：任务 1/1、海面 6/6，全成功零失败，人口 30/40。
- 升级动作在本账号（lv11）不会触发，这是正确行为而非缺陷：切鱼厂/食品厂已 lv2，
  海水厂 lv2 需要人口 45（当前 30），材料厂 lv2 需要玩家等级 13，服装厂 lv2 需要 12，
  训练营 lv2 需要 28 —— 全部被 `BuildingUpgradeCfg` 的等级/人口门槛挡住，计划器已按门槛判定。
- 网页控制台「自动循环」页签背后的接口全部用 curl 验证过一遍：
  `GET /api/tasks`、`GET /api/world`、`POST /api/tasks/run`、`POST /api/world/run`、
  `POST /api/loop/start`（重复开启报「循环已经在跑」，缺 `confirm` 报「需要确认才会开自动循环」）、
  `GET /api/loop`、`POST /api/loop/stop`（停止后 `running` 翻回 false）。

### 12.7 活跃度宝箱、每日赠礼与自动建造

**日活跃度宝箱和周活跃度宝箱是两张表，门槛差很远。** 客户端也是分开取的
（`AchievementUtil.allDailyActiveRewardCfg / allWeeklyActiveRewardCfg`）：

| | 表 | 门槛 | 奖励示例（第 1 档） |
|---|---|---|---|
| 每日 | `DailyActivityRewardCfg` | 20/40/60/80/100 | 加速器 120 |
| 每周 | `WeeklyActivityRewardCfg` | 120/240/360/480/600 | 藏品券 10 |

两张表都是 4 个 season × 5 档，`id` 在季节之间重复，只有第 5 档的奖励随赛季变，
所以判「哪几档可领」只用 `id`，不用挑季节。领法：`DrawDailyRewardRequest{index:[…]}` /
`DrawWeeklyRewardRequest{index:[…]}`，都是 repeated int32、都无 Response。

> 踩过的坑：一开始拿 `DailyActivityRewardCfg` 去算周宝箱，85 周活跃被算成「可领 1-4 档」，
> 发出去服务端回 `prompt=38` 全拒。`src/dailies.mjs` 的 `CHEST_TABLE` 现在把
> 「kind → 表名」写死，`selftest` 会拿真实配置表断言「80 日活跃够 1-4 档、80 周活跃一档都不够」。

**「每日赠礼」不是宝箱，也不在配置表里。** 它是「福利 → 每日特惠 → 每日精选」面板里那档免费礼包：

- packId 是客户端**硬编码的字面量**（`DailyPackBuyPanel` 的字段初值）：
  `freePackId="赠礼"`、`wholePackId="合并礼包"`、`packIdArr=["礼包1","礼包2","礼包3"]`。
  后两个要走充值（或先买过礼包 1/2/3），本工具不碰。
- 可领性看 `DailyGiftPackResponse.drawnPack` 里有没有 `"赠礼"`；`resetTime` 是次日 0 点。
- 领取用 `GotFreeDailyPackRequest{packId:"赠礼"}`，**协议表里没有配套 Response**，
  所以发完必须重新拉一次 `DailyGiftPackResponse` 确认 `drawnPack` 真的多了它 ——
  「没被 prompt 打回」不等于成功。

**建造与升级是两个请求。** 客户端 `_toBuildOrUpgradeRequest` 的分支是
`0 == t.level ? BuildBuildingRequest : UpgradeBuildingRequest`。首建按具体地块的 `BuildingUnlockCfg` 检查等级、前置建筑、当前人口与材料，民居还需给施工中的人口预留上限。建成后的升级使用 `BuildingUpgradeCfg`。计划器处理两种施工状态：

1. `level === 0` 且 `buildFinishTime` 在**将来** = 正在盖，重发只会被拒，跳过；
2. `level === 0` 且 `buildFinishTime` **已过** = 本轮要先发 `FinishUpgradeBuildingRequest`，
   收尾后它已经是 level 1，同一轮**不能再排建造**（`planWorld` 用 `finishing` 集合挡掉）。

材料不齐时客户端会先弹「用钻石补」，本工具不这么做，记一笔
「建造材料不足（X a/b），不买材料，等下一轮」；等级不够也记明「建造要等级 N，当前 M，先推主线」。

## 13. 账号、素材与网页控制台

### 13.1 多账号：一条记录 = 一份凭证

- 身份是 `login.eworldParams.openId`。同一个号反复抓包只会刷新那一条的凭证，不会多出一条。
- 存储 `data/accounts.json`（`{version:1, activeId, accounts:[…]}`）。早期只有一个账号时的
  `data/credentials.json` 仍保留，作为迁移来源与备份：`accounts.json` 不存在时 `loadStore()`
  就地合成一条（**只读，不写盘**），第一次真正的写操作才落盘（先写 `.tmp` 再 rename）。
- 选账号的顺序（`pickAccount`）：id → 昵称 → 1 起的序号 → 唯一的 id 前缀或昵称子串，
  撞到多个就报错而不是随便挑一个。CLI 用 `--account` 或 `CW_ACCOUNT`，网页用顶栏下拉与 `?account=`。
- 并发：每个账号一条独立 WebSocket（`Map<accountId, session>`），互不干扰。但**一个账号同时只有一条连接**——
  第二条会话登录会把第一条顶掉（`SCChannelExpired`），所以自动循环要按账号各开一份，不能两个号共用一个会话。
- 凭证是本机明文文件。网页默认打码（头尾各 4 位），必须显式点一次「显示凭证」才返回全文。

### 13.2 从电脑微信采集登录

- `tools/mitm-proxy.mjs` 改成工厂 `createProxy({port,onLogin,log})`，CLI 与网页共用一份实现；
  默认端口 **17322**（`CW_PROXY_PORT` 可覆盖）——原来的 17321 与控制台撞车，这是必须修掉的一处。
- `src/capture.mjs` 是网页与 CLI 共用的编排：准备 CA → 监听成功 → 设 HKCU 代理 → 抓到 `LoginRequest` → 入库 → 回滚。
- 系统改动全部限定在当前用户（`certutil -user`、HKCU），只绑 `127.0.0.1`，`stop()` 幂等，
  进程退出钩子兜底；回滚后逐项比对注册表是否真的还原，结果写进页面日志。
  装 CA 与开代理这两步都必须先在页面上确认（勾选 + 3 秒倒计时）。
- 版本 71 的实际登录链未发现独立二维码授权接口。原先将自行拼接的启动链接当作扫码登录没有实现依据，已移除。
  `data/qrcode.png` 可作为用户提供的游戏入口码展示，但不与捕获会话关联。
  必须在电脑版微信中打开游戏；手机扫码启动手机游戏不能向本机代理传回凭证。
  捕获请求后仍须观察 `LoginResponse.result === 0` 才能确认登录成功。

### 13.3 素材：用游戏自己的图标

- 白名单 11 个 bundle 从微信缓存镜像到 `work/cdn/art/`（约 49M）：`ui_iconlib` / `ui_iconlib2`
  道具与资源、`ui_herohead` / `ui_herohead2` 英雄头像、`ui_iconequip` 装备、`ui_building` 建筑与工厂、
  `ui_iconaccess` 要塞、`ui_iconchip` 芯片、`ui_iconworker` 工人、`ui_preset`、`ui_chat_iframe`。
  砍掉了 `ui_common`（9.0M，核心图标一个都不落在这里）与 `ui_head_frame`（3.8M，界面不显示）。
- `src/fgui.mjs` 解 FairyGUI 二进制，`src/art.mjs` 把游戏实体翻成图标名，
  索引落在 `work/cdn/art/index.json`（1352 个图标 / 46 张图集页）。
- 实体 → 图标名：道具 `ItemCfg.pic`、资源 `ResourceCfg.pic`、装备 `EquipCfg.icon`、
  工人 `WorkerBaseCfg.icon`、要塞 `WorldFortCfg.icon`。建筑没有 icon 列，用 `resPath` 末段
  （`building/HomeBase` → `HomeBase`）。英雄头像三层兜底：
  `HeroSkinCfg.headId` → `HeadImageCfg.heroId→icon` → 该英雄碎片物品的 `pic`。
- 实测覆盖率：道具 1104/1145、资源 5/5、装备 36/36、英雄头像 51/115（缺的 64 个是 NPC / boss / 技能展示木头人）、
  建筑 53/58、工人 38/50、联盟工事 1/5。查不到就返回 `null`，界面退回中文文字，不编造。
- **旋转贴图**：索引里 209/1352 是转 90 度打包的。图集里占的是 h 宽、w 高（与显示尺寸 w×h 差一个 90 度）。
  这条结论是从游戏自己的引擎代码核出来的——`SpriteFrame._calculateUV` 的旋转分支用
  `(rect.x + rect.height) / texWidth` 算右边界；也用 `work/tmp/crop-icon.mjs` 把像素裁出来看过，
  ARENA 字牌与英雄头像都能摆正。页面渲染的做法：元素盒按 h×w 铺，
  `translate(0, h*k) rotate(-90deg) scale(k)`，这样四个角与引擎给的 UV 一一对应。
- 服务端 `GET /api/art/atlas/<bundle>/<file>` 直接返回 PNG，靠 CSS 裁切，不需要任何图像处理依赖；
  只允许取镜像目录里真实存在的文件（`..`、斜杠、不存在的文件名一律 404）。

### 13.4 网页控制台

- 控制台有总览、挂机、游戏配置、建筑一览、挑战、资源与玩法、账号七个页签。资源与玩法下分日常、联盟、仓库、英雄与装备、材料与订单、礼包兑换；原活动入口保留在材料与订单中，按限时、周期、常驻分类。运行日志显示操作结果和跳过原因，可筛选警告与错误。
- 账号页支持从电脑微信或抖音添加账号，以及导出、暂停和恢复托管。开始采集前有勾选和倒计时确认。
- 手动交居民订单、装备强化、试炼挑战和海盗出征等操作按账号排队，点击后可在主日志查看结果。
- 挂机页展示模块开关，旁边的“配置”跳到游戏配置对应项目；游戏配置分基地、世界、英雄、日常与活动四类。保存只更新当前账号设置，不会启动挂机；已在运行的挂机在后续检查时使用新设置。首杀连续推进、主线自动挑战和联盟互助仍需单独启动。

原主分支保存的开关继续保留，原有消费项目不会因迁移而自动开启。下面这些原有规则可在游戏配置中编辑；开启对应详细模块后，由详细模块接管，日志说明跳过原因，避免两套规则重复执行。关闭详细模块后，仍按已明确开启的原有规则运行。

| 原有功能 | 配置入口 | 与详细模块的关系 |
| --- | --- | --- |
| 联盟订单 | 游戏配置 → 世界 → 联盟订单 | 保留原有独立服务。 |
| 联盟情报派遣、舰队维修 | 游戏配置 → 世界 → 联盟情报 | 开启联盟情报自动处理后，由详细情报模块接管。 |
| 装备制造领取、续产 | 游戏配置 → 英雄 → 装备制造原有规则 | 开启基地中的装备自动锻造后，由详细锻造模块接管。 |
| 博物馆领奖、探险 | 游戏配置 → 基地 → 博物馆探宝 | 基地执行总开关与自动探宝同时开启时，由详细博物馆模块接管。 |
| 海兽成熟领取、培育 | 游戏配置 → 基地 → 海兽培育室 | 基地执行总开关与海兽培育总开关同时开启时，由详细海兽模块接管。 |

### 13.5 v75 客户端核对的挂机规则

以下规则读自 v75/v76 客户端和配置表，均由离线测试覆盖；其中海商王已增加真实账号只读和受保护单步门控验证（2026-11-13 08:35 实测处于 10:00–22:00 窗口外，未发送写请求），完整跨港航程仍需按实际到港结果确认。

- **世界在线奖励：** `CounterInfoRequest` 的 `DAILY_WORLD_ONLINE_RWD` 给出已领档位和上次领取时间。当天 20:00 后开放，上次领取已在 21:00 后则当天结束，每档按上次领取时间计时。领取请求没有声明回包类型，所以用重新读取的计数确认结果。
- **海商王联盟任务：** `TradeGotTaskRequest` 的字段是 `day`，按天领取，只领活动已进行到的天数。活动时间取自 `SCAllActivity.trade`。
- **海商王走商（2026-11-12 核对 v76）：** `TradeGuildRadarResponse.radar` 提供可航行港口，未共享紧缺货仍可选港；不能用场景全部城市替代商港列表。客户端 `TradeUtil.openCiytTrade` 只查询当前港，未确认异地 `TradeCity` 可读，因此远端收益统一标为风险折扣估算，到港重读实价。`TradePlayerGoods` 的 `pid/goodsId/num/buyPrice/cityId` 是独立采购批次；禁止在来源港出售。`DispTradeGoods.stock` 为已购量，可购库存是 `TradeGoodsCfg.maxCount-stock`，且联盟共享，发送前须复查。`ActivityTradeCfg` 提供贸易时段、航程、加速时长和报价库存刷新；`TipsDescCfg[海商王]` 说明紧缺每天首个贸易时刻更新，不等于每次价格刷新。亏损不享受利润加成、不增加累计利润；只有明确配置清仓亏损上限才允许亏损出售。
- **海商王指针与升级：** 加速使用 `TradeSpeedRequest.useNum` 和已有道具 `海商王加速`，回包 `TradeSpeedResponse.moveEndTime` 必须配合同一航程提前的状态及完整库存回读确认；原航程自然到港不能证明未知加速成功。指针默认关闭，周转模式需本期至少两笔已核实出售和有效观测窗口，否则退回截止补救策略。`TradeShipCfg.upMoney` 是累计利润解锁门槛，`upCost` 才是钻石费用；船舶升级默认关闭，启用时还需全局钻石开关、保留量、日预算、相邻船级及完整资源回读共同满足。新策略已完成离线真实协议、HTTP、监控调度回归，并已在真实账号上完成只读状态和窗口外单步门控验证；完整两小时航程的成交结果仍以实际到港回读为准。
- **赛季任务：** `GotSeasonTaskRequest` 没有字段，一次领取所有已达标档位。
- **红点：** `SCRedPoint` 带 `num` 表示有待处理事项，不带表示已清除。33 跨服排行、41 世界宝藏、42 收到互助、43 新求助、53 海商王任务、64 联盟职级、65 博物馆。
- **联盟互助：** 每轮只响应一次，下一轮读到库存已扣减后才继续。
- **世界宝藏：** 需要 `GuildTitleCfg.treasureLoot` 为 1，每日奖励次数读 `TreasureLootParamCfg`，每队消耗 `进攻宝藏消耗汽油`。工具避开 20:00 到 21:00，不去其他联盟占领的宝藏，舰队返回前不再派下一队。

### 13.6 玩法结果如何确认

本次迁移的入口兼容、跨模块资源保护与战报防重经过离线模拟回包和 HTTP 测试，未操作真实游戏账号。文中其他章节标注的历史账号实测结论仍按原验证范围理解。

| 操作 | 确认依据 |
| --- | --- |
| 保存远征舰队首次编队 | 发送 `FleetSaveFormationRequest` 后，从海面建筑重读每个站位的英雄，再用 `MyFleetsRequest` 单独检查世界地图是否列出该队。 |
| 应用推荐阵容 | 主线、远征和积分赛分别走 `SaveFormationRequest{module:1}`、`ExpeditionSaveFormationRequest`、`LeagueSaveFormationRequest`，用回包核对站位。舰队走 `FleetSaveFormationRequest`，从海面建筑重读确认。海兽保持原值，舰队与客户端一样不发 `petUid`。这些写操作只有离线测试，尚未在真实账号验证。 |
| 联动活动签到 | `ClaimActivityDailyCheckInRewardRequest{activityId, checkId}`。客户端按开放日算当天，`signDay` 早于当天的是补签，服务端扣钻石（`dailyActive.checkRuby`）。工具只发当天的 `rewardId`，两个开放时间不在同一天时跳过，用回包 `checkId` 核对。 |
| 联动活动活跃 | `ClaimActivityDailyActiveRewardRequest`，每次领下一档，回包 `claimedId` 递增。分数来自 `SCAllActivity` 和 `SCActivityActiveScoreUpdate`。 |
| 联动每日免费礼包 | `ClaimDailyCombGiftRequest`、`ClaimFreeSelectGiftRequest` 只发 `price` 为 0 的礼包。没有响应类型，靠 `sendWatch` 和道具推送确认。服务端只在登录时下发状态，跨天按客户端 `dailyReset` 在本地清空。 |
| 走江踏浪 | `SnowballDetailRequest` 读积分和档位，`SnowballClaimGiftRequest` 领免费礼包，`SnowballClaimRewardRequest` 领达标档位。不开局，不买体力。 |
| 抽奖 | `SpinCompassWheelRequest{num:1}` 只在 `CompassWheelInfoResponse.cost` 是抽奖券时发送，`WeekLotteryPrizeRequest{times:1}` 只在持有周转盘币时发送。各开关默认关闭。罗盘张数按账号设置，默认 10 张，周抽奖每轮最多 10 次。 |
| 周活动奖励 | 累充 `WeekChargeGotRewardRequest`、升星 `WeekHeroStarGotRewardRequest`、芯片 `WeekChipGotFreeRequest`、翻牌 `GotUniqueLotteryFreeRequest`、周订单 `WeekOrderGotFinalRequest`。提交周订单 `FinishWeekOrderRequest` 接入材料预留，默认关闭。 |
| VIP 每日奖励 | `GotVipDailyRewardRequest{vipLevel}`，只领不高于当前等级且未领的档位。 |
| 战报奖励 | 奖励留在 `CampaignReport`（`rewards`、`received`）里，不会自动到账。从 `CampaignReportsRequest{pageNo:0}` 开始完整分页，列表不完整时不发领取。对确有奖励且 `received:false` 的战报发送 `QuickGotCampaignReportRequest{all:true}`，必须收到含实际奖励的通用 `GotRewardResponse`，并完整重读确认本批每个精确 UID 均为 `received:true`，才记录成功。`SCNewCampaignReport` 推送新战报。 |
| 开服冲榜 | `OpenRankType`：1 订单、2 闯关、3 剿匪、4 战力。`OpenRankInfoRequest{type}` 返回 `progress`、`gotRewardId`、`leaderBoard`，`GotOpenRankRewardRequest{type, id: 配置 score}` 领积分奖励。排名奖励含联盟礼包，由服务端结算。协议里没有海盗组队或集结，"多人"体现在共享地图目标和全服排名。 |
| 海盗首杀 | 派遣前重新核对目标、舰队、耐久和汽油。出征走 `ChallengePirateRequest`，战斗推送只说明目标战况，个人首杀以角色自己的击杀记录为准。 |
| 装备穿戴和强化 | 穿戴后核对装备归属。强化前核对画面中显示的等级和材料费，发包后从 `EquipsResponse` 核对新等级。 |
| 联盟福利 | `GuildAidListRequest` 读取成员求助。免费福利走 `GotGuildWelfarePackRequest`，回包中的领取时间和奖励共同确认到账。 |
| 免费试炼扫荡 | 先查最高已通关关卡，再用 `buySweepTimes` 查下一次价格。仅在零钻档位执行，读取次数增长后才记录成功。 |

战报的手动活动、单次领奖、挂机和新战报推送入口共用账号队列及持久领取记录。超时、断线或回执不全时保留未确认记录；只有回读证实该批全部 UID 已领取后才核销，在此之前新增战报也不会触发再次一键领取。服务器明确拒绝同一请求时才撤销未确认记录。新战报推送可在挂机未启动时处理，但仍需开启战报奖励开关、账号未暂停且连接有效。

### 13.7 广告奖励协议

依据 v75 客户端的 `AdvUtils.playAdv`：先发 `WatchAdvRequest{type,id}`，回 `OkResponse` 后才判断 `canSkipAdv`（VIP 特权“免广告”或首充记录）。有权益立即回调，否则才播放激励视频。视频完成回调之后，客户端才发业务请求。

| 场景 | `WatchAdv(type,id)` | 业务请求 | 回包 | 日上限 | 真实账号记录 |
| --- | --- | --- | --- | --- | --- |
| 挂机收益 | 1,1 | `DrawAfkRewardRequest{useAdvCard:true}` | `DrawAfkRewardResponse` | 1 | 有 |
| 英雄招募 | 1,2 | `RecruitStartRequest{way:5}` | `RecruitStartResponse` | 3 | 有 |
| 英雄经验/强化石/海兽经验试炼 | 1,4 / 1,3 / 1,5 | `TrialRaidBuySweepRequest{raidId,useAdvCard:true}` | 无同名回包 | 各 1 | 无 |
| 工厂生产加速 | 1,6 | `SpeedUpFactoryProduceRequest{buildingId,index,speedUp:{type:3,useNum:0}}` | `OkResponse` | 3 | 有 |
| 藏品招募 | 1,7 | `AntiqueRecruitRequest{type:1,way:5}` | `AntiqueRecruitResponse` | 3 | 有 |
| 建筑升级加速 | 1,8 | `SpeedUpUpgradeBuildingRequest{buildingId,speedUp}` | 无同名回包 | 与展柜共 3 | 无 |
| 博物馆展柜加速 | 1,8 | `MuseumSpeedUpCaseRequest{exhibitionId,caseIndex,speedUp}` | 无同名回包 | 与建筑共 3 | 无 |
| 广告商店 | 2,product.id | `GotAdvRewardRequest{id}` | `GotRewardResponse` | 商品 max | 有 |
| 龙王罗盘礼包 | 3,packId | `GotAdvRewardRequest{type:3,id}` | `GotRewardResponse` | limitCount | 有 |
| 走江助力礼包 | 4,packId | `GotAdvRewardRequest{type:4,id}` | `GotRewardResponse` | limitCount | 有 |

真实账号记录来自 issue #11 附带的第三方接口文档（v76 缓存），本工具未用真实账号复测。服务器对业务请求的拦截是 `PromptResponse{prompt:5,args:["adv not finished"]}`，文档记录的等待时长：藏品招募 1 秒被拒、5 秒成功；广告商店 3 秒被拒；上表标“有”的入口 15 秒成功。全入口最短阈值未知。

- 广告次数读 `OnWaterResponse.adv[]`，日上限读 `AdvEffectCfg`。商店 effectId 9 没有配置行，按 `AdvShopInfoResponse.product[].max`；礼包按配置 `limitCount` 与活动状态。
- 广告礼包配置为 `price<0`：`LinkageLSRLimitPackCfg#1001` 与 `SnowBallGiftCfg#1001`。两者 packId 相同，靠 type 区分。罗盘状态在子活动 10 的 `dailySelectGift.boughtTimes`，只随登录快照同步，所以被服务器拒绝（非“未完成”）时当天不再申请；走江状态由 `SnowballDetailRequest.giftBuy` 回读。
- 挂机广告按钮只在 `服务器时间 - afkStartTime - 1 <= 60` 时显示。第三方记录中超出窗口也领取成功，且金币数与“已挂机时长 + 2 小时”吻合，但工具仍按客户端窗口执行，避免额外偏离客户端行为。
- `DispFactoryJob.idx` 是 optional，0 号队列可能不在线路上出现，读取时按 0 处理。`finishTime` 为 0 表示未开工，客户端不提供加速。
- 展柜到期由客户端补发 `MuseumFinishCaseUpgradeRequest{exhibitionId,caseIndex}`；工具没有其他展柜升级入口，由广告加速开关一并处理。
- 实现位于 `ad-shop.mjs` 的 `adAccess`、`takeAdSlot`、`prepareAd` 与 `ad-rewards.mjs`。

## 14. 漫剧、擂台赛与赛季宝箱

依据微信缓存版本 75 的主包。`work/extracted/` 中的旧主包仍是 `SeasonChestOpenRequest {chestId}` 与每箱次数上限，已不适用。以下请求尚未在真实账号发送过，回包类型来自协议和客户端用法，首次运行时以 `data/protocol.log` 为准。

| 玩法 | 读取 | 写入 | 回包 |
| --- | --- | --- | --- |
| 法旨战令 | `BattlePassRequest {type:11}` | `BattlePassGotRewardRequest {type:11}` | `BattlePassGotRewardResponse` |
| 漫剧 | `MainTaskInfoResponse.comicDrama`：`comics[{comicId,state}]`、`gotDaily`、`isRead` | `ComicDramaReadRequest {comicId}`、`ComicDramaGotRewardRequest {comicId}`、`ComicDramaGotDailyRequest` | 观看无专属回包，按 `OkResponse` 等待，超时后回读；领奖为 `GotRewardResponse` |
| 擂台赛 | 推送 `SCTournamentOpen`（`state.currentStageId`、`lastClaimDailyGiftTime`）、`SCTournamentUpdate` | `TournamentClaimDailyGiftRequest` | `GotRewardResponse` |
| 赛季宝箱 | `SeasonChestInfoResponse.flow`：`stage`、`costItemId[]` | `SeasonChestOpenRequest`（无参数） | `SeasonChestOpenResponse {reward, flow}` |

- 漫剧条目不存在时显示播放，`state=false` 时可领奖，`state=true` 时已领奖。解锁条件是 `ComicDramaCfg` 的 `unlockLevel` 与 `unlockTime + unlockHours`；模块条件是 `ModuleOpenCfg` 的“漫剧”。每日奖励要求 `isRead` 为真。
- 擂台赛入口只在 `currentStageId` 大于 1（预选）且小于 8（结束）时进入赛场页；每日礼包条件是 `lastClaimDailyGiftTime` 不在当天。
- 赛季宝箱开放条件是 `GameplayOpenCfg` 的“赛季交换宝箱”（`openDays: [0,1,1,1]`，第一赛季关闭）。宝箱按 `SeasonExchangeChestCfg.stage` 循环；每次消耗 `costItemId` 列出的钥匙，种类随机且可重复。自动开启只接受 `SeasonChestKeyLibCfg` 中的钥匙。结果未知时，阶段变化视为已生效，超过 10 分钟阶段未变视为未生效。

## 15. 装备分解、海兽放生与城战选城（v76）

- `DispEquip.star` 是锻造随机得到的装备星级，只影响 `EquipAttrCfg` 的等级上限，不代表已养成；自动分解只看 `level <= 1`、`refineLv == 0` 且没有属性洗练记录。`DispPet` 的 `level` 和 `star` 才表示海兽已投入养成。
- 当前协议没有 `LeagueFormationRequest`；本人的积分赛编队从 `LeagueInfoResponse.ownFormations`（字段 5，重复 `LeagueFormation`）读取，`LeagueFormationResponse` 只用于保存编队。
- `WorldCity` 的本盟现场数量由 `attackFleetNum + priorityAtkFleetNum` 加上 `battlePoints` 中左侧非 NPC 且属于本盟的交战点组成；已同步在途舰队从 `WorldInfoResponse.fleets` 读取：`state == 2`、`targetCityId` 为目标城、`owner.guildId` 为本盟，并按 `owner.playerId` 排除 MyFleets 已统计的本人舰队。归属或数量无法确认时不当作 0。
- `SetFleetAutoFightRequest { buildingIds[], isOn }` 没有配套响应；关闭后回读 `MyFleetsResponse.fleets[].autoFight.isOn` 确认。城战原生委任设置 -1 按 VIP 额度等待，0 关闭后接管，N 表示原生先用 N 次再关闭。

## 16. 藏品养成协议（v76）

- `AllAntiqueResponse`：字段 1 `antiques[]`（`DisplayAntique {id, star}`）、字段 2 `suits[]`（`DisplayAntiqueSuit {id, level, effectiveNum, advEffectValue}`）、字段 3 `masterLv`。
- 激活：`ActivateAntiqueRequest {id}`，消耗 `AntiqueBaseCfg.activeFrag` 个 `id + "碎片"`；不提供万能碎片自动兑换。
- 升星：`AntiqueStarUpRequest {id, universal}`；目标星级 `current + 1`，消耗数量取 `AntiqueStarCfg[target]` 中按藏品颜色对应的 `consumeBlue/consumePur/consumeOra/consumeRed`。`universal:true` 时普通碎片不足可用 `AntiqueBaseCfg.universalItemId` 补足。
- 套装：`AntiqueSuitLevelUpRequest {id}`。普通套装激活需集齐本套装全部藏品，红色套装（`colorIndex >= 4`）至少激活 2 件；激活本身不消耗资源。升级消耗 `AntiqueSuitLvCfg` 中 `maxLevel >= 目标等级` 的首行，上限还要受 `AntiqueMasterLvCfg[masterLv].maxSuitLv` 限制。
- 大师：`AntiqueMasterLevelUpRequest`（无参数）返回 `AntiqueMasterLevelUpResponse.masterLv`；目标等级要求 `AntiqueMasterLvCfg.totalStarNum` 不大于当前已激活藏品星级总和，消耗 `costArr`（通常为“藏品大师经验”）。
- 当前协议没有激活、升星、套装升级的专属响应，成功时通过 `SCAntiqueUpdate` / `SCAntiqueSuitUpdate` 推送并回读 `AllAntiqueResponse` 确认。
