# 硅矿截图对照与协议依据

本次核对使用本机微信缓存第 76 版 `_src_chunks_.wxapkg` 的 protobuf 和同版 `_subpackages_main_.wxapkg` 客户端逻辑，以及当前 `config_cn` 配置。私有缓存不纳入仓库。离线回归后按用户要求进行单队初等空位真实派遣，确认汽油消耗及重连防重；完整实测范围见 [实测记录](live-validation-2026-11-14.md)。

## 已有与新增

此前仅有通用舰队状态识别（`chipWar.rewardTs` 防止其他玩法抢用采矿舰队），没有矿区读取、采矿派遣、抢占、撤回或硅矿自动化配置。本次新增 `src/silicon-mining.mjs`，接入游戏配置的硅矿分组和挂机调度；新总开关、三个舰队开关、维修与加速均默认关闭，保存配置不会启动挂机。

| 截图功能 | 实现与边界 |
| --- | --- |
| 硅矿总开关、三个独立舰队 | 每队单独矿级、空位模式、战力排序和上限、安全名单、失败次数、追击和维修／加速。停用不会清除子项选择。 |
| 角色 16 级解锁 | 真实规则还要求 `GameplayOpenCfg` 的“芯片”赛季开放。当前表为 `[0,0,1,1]`，即 S1、S2 不开放，S3 起按当前赛季开放日检查，不能只按图片的 16 级派遣。 |
| 单日领奖上限 | 0 为不额外限制，始终服从服务端 `myRewardTimes/maxRewardTimes/rewardResetTime`。服务器奖励自动发放，没有伪造“领奖”接口。持久保存周期计数增量，达到用户日上限后停止新派遣并申请撤回。 |
| 达限撤回 | 客户端明确要求 `DispChipMinePlayer.rewardTimes > 0` 才能撤回。首轮采集未满 15 分钟时仅停止新派遣，等服务器允许后撤回，不能承诺立即中断首轮奖励。 |
| 占领时段 | 北京时间 `HH:mm-HH:mm`，支持多个时段和跨午夜，空列表全天。时段外同样先停派、再按服务器规则撤回已启用队伍。 |
| 空位和抢占 | 普通模式先空位。只空位时不攻击也不追击；初等矿永不攻击已有玩家。中、高矿只攻击配置战力比例内、非同盟、非安全名单的玩家；战力可升序／降序。 |
| 每舰每日抢占上限 | 持久独立计数，发送前占用。另读取服务器玩家共享 `fightTimes/maxFightTimes`，不能把三队各 30 次误当成服务器允许总 90 次。上限耗尽仍可普通空位采集。 |
| 单敌失败限制 | 按“舰队 + 昵称 + 联盟编号”记录当日失败。已确认派出后归队、未曾占领目标位置记一次失败；未知请求不算失败也不重发。次日重新计数。 |
| 安全名单 | 玩家完整昵称忽略大小写；联盟使用服务器 `guildIdx` 数字编号。同盟永不攻击。矿位协议不返回玩家 UID 或联盟名，因此界面不将昵称当成唯一 UID。 |
| 追击 | 三日奖励周期开始后的配置分钟数内，只追击真实游戏黑名单里且本工具已通过个人胜利战报核实击败过的目标。目标必须仍满足矿级、战力、安全名单、失败、用户日上限和服务器次数限制。无匹配时待命，不回退空位／普通敌人。周期窗口结束恢复普通采矿。 |
| 普通维修 | 自动维修只针对选定空闲舰队，读取 `FleetRepairParam` 实时报价，用 `RepairFleetRequest` 修复；服从汽油保留量、单次维修上限和硅矿日汽油预算。 |
| 维修加速／行军加速 | 独立关闭默认。需要资源页钻石总开关、总日预算和硅矿日钻石预算（0 禁止加速）。维修加速仅处理本模块确认启动的维修；行军加速仅处理本模块确认派往矿区的行军。每次核对舰队原结束时间，加速后必须有提前结束的业务证据。 |
| 调度与推送 | 普通间隔 10 分钟；启用有效追击配置时 2 分钟。矿区、奖励额度、舰队、战力、战报和库存推送唤醒串行检查，配置更改由统一调度提前检查；不在推送回调直接派遣。 |

## 协议实证

以下字段按真实 encode/decode 和客户端调用共同核实。`tools/describe.mjs` 的老正则只认某一 protobuf 命名空间别名，可能漏报第 76 版的消息和数组字段，因此本次同时检查了实际编码函数并在测试中往返编码。

- `ChipMineListRequest {}` → `ChipMineListResponse {chipMines: DispChipMine[]}`：`gridId/color/occupiedNum/positionNum`。
- `ChipMineRequest {gridId}` → `ChipMineResponse {occupiedNum,positionNum,occupiedPositions,rewardInfo,fightTimes,maxFightTimes}`。响应不带 gridId，逐矿串行查询避免错配。
- `DispChipMinePosition {index,player}`；`DispChipMinePlayer {nickname,avatar,power,rewardTimes,guildIdx,title?,fleetId?,skinId?}`。客户端 `ChipMinePop` 将带 `fleetId` 的位置认作己方队伍。
- `ChipMineRewardRequest {}` → `ChipMineRewardResponse {rewardInfo}`。`LoginProxy` 将其作为世界信息初次读取的一部分；没有领道具或扣费参数。
- `ChipMineRewardInfo {myRewardTimes,rewardResetTime,maxRewardTimes}`；`SCChipMineRewardInfo` 只推送 `maxRewardTimes`，不能根据它推断已领次数增加。
- `ChipMineSendFleetRequest {gridId,index,fleetId}`。`SelectTroopPop` 限制一次选一队，汽油使用 `WorldParamCfg` 的“采集硅矿消耗汽油”（当前 500）。
- `ChipMineRetreatRequest {fleetId}`。`ChipMinePop` 发送前检查该己方位置 `rewardTimes > 0`。通用明确拒绝包括 `CHIP_WAR_RETREAT_LATER` 和 `CHIP_WAR_NO_REWARD_TIMES`。
- `ChipMineCfg` 品质 `BLUE=3`、`PURPLE=4`、`ORANGE=5` 分别对应初等、中等、高等矿。槽位数量以响应为准，不硬编码旧赛季的 7／16 个位置。
- `MyFleetsResponse.fleets[]` 返回精确舰队状态、战力、耐久、行军时间与 `chipWar.rewardTs`；`FleetState.QUEUING=5` 且带 `chipWar` 表示采矿。
- `BlackListRequest {}` → `BlackListResponse.list[]` 含 `playerId/nickname/avatar`。矿位没有 UID，当前追击以游戏黑名单中唯一的完整昵称，加已验证胜利目标的联盟编号进行匹配；不会添加或删除游戏黑名单。
- `CampaignReportsRequest {pageNo:0}` 读取个人战报。`type=11 (CHIP_WAR)`、`mySide=0`、`win=true`、`chipWar.fleetId/color`、发送后时间匹配后，再用 `CampaignReportDetailRequest {campaignId}` 中 `battles[].rightCamp.player.nickname` 核对对手，才记录已击败。不能通过仅“战力大于对方”推断必胜。
- `RepairFleetRequest {buildingId}` 使用 `FleetRepairParamResponse.unitRepairCost/unitRepairTime`。
- `SpeedUpRepairRequest {buildingId,speedUp:{type:SPEED_UP_RUBY(1),useNum:0}}` 按 `SpeedUpRubyCfg.fleet` 分段费率。累计分钟来自 `SCSpeedUp` 的 `SPEED_FLEET=4`；若本连接未收到，则按真实价格表最高档保守计入预算，不假设费率总是每分钟 10 钻。
- `SpeedUpFleetRequest {buildingId}` 使用 `WorldParamCfg`“行军加速消耗”（当前 30 钻）；每次只能按真实新 `moveEndTs` 确认。

`TipsCfg`“硅矿争夺”写明：每队每 15 分钟一奖、玩家每三天共享最多 100 奖、首轮 15 分钟后可撤退、每天玩家共享最多 30 次抢占。实际奖励额度可能因权益变化，因此执行以响应为准，不把 100／30 写死为服务端上限。

## 持久化、预算和未知结果

- 设置沿用账号设置文件及自动保存。`automation-usage.json` 中 `silicon-state:<world>` 保存日奖励基线、失败和已击败记录；账号账本隔离，世界编号参与键，跨区不会复用队伍状态。
- 没有当日历史基线时，服务端只有三日累计次数，无法准确反推出今天单独领取多少。首次使用保守把当前周期计数计入今日，之后以增量记录；这可能少派，但不会凭空把今日清成 0。
- `silicon:<world>:<fleet>` 在发送前持久占用汽油与舰队。派遣要看到实际向该矿行军或己方队伍占领该位置才确认。未知请求即使下一次读到空闲也不重发，跨日和重启不会清除 pending。
- 派遣、维修及钻石加速使用独立持久键。明确拒绝或确定未发才取消；超时、结果不明继续占预算。普通修复结束不能误认为未知加速成功。
- 汽油 pending 与联盟情报、世界 Boss、海盗、城战、货轮共用，舰队实际占用与其他玩法互斥。硅矿默认处于派遣优先级最后。

## 离线验证

`node tools/selftest-silicon.mjs` 使用 `tools/fixtures/silicon.mjs` 的虚构角色与真实 protobuf 编解码。覆盖默认关闭、赛季门控、只读预览、三舰队、名单/战力、空位与低矿、服务器共享与本地独立上限、失败换目标、黑名单和胜利战报、日奖励与撤回、跨日未知防重、共享预算、维修／加速、配置中途关闭与推送调度。任何测试都不建立真实游戏连接。
