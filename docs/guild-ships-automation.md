# 联盟商船与联盟工事：截图对照和协议依据

核对日期：2026-11-14。本机微信缓存包版本 76 的协议、主包客户端，以及当前实际配置表作为依据。随后按用户要求读取真实账号，商船活动未开放、工事缺少指定材料，已验证相应跳过，未验证成功消费；见 [实测记录](live-validation-2026-11-14.md)。游戏包及账号数据不纳入仓库。

## 现有实现与新增内容

原项目只有工厂的 `guildShip` 需求来源；没有商船选船、上船、申请船长和工事捐赠执行器。新增 `guild-ships.mjs`、`guild-forts.mjs`，通过同一账号串行挂机队列调度，消费默认关闭。

| 截图功能 | 本次实现 |
| --- | --- |
| 船员、船长独立开关 | 独立保存与发送前复查；正常模式不相互代开 |
| 水姆币与指定奖励筛选 | 奖励水姆币最低值，紫/橙/红船分别配置；关闭筛选保留原数值 |
| 禁用材料 | 过滤需要对应材料的船员订单；不购买缺料 |
| 红船优先 | 红→中→小，按抵港预测保留下一刷新批次至少一个可用队列 |
| 只坐中大船 | 红→橙；不参与小船 |
| 全程可兜底 | 当前批次刷新 20 分钟后放宽奖励与预留，先船员再船长，此时可覆盖角色子开关；仍守水姆币最低值、材料禁用、现有库存和游戏队列上限 |
| 只坐小船／中小船 | 单独模式；中小船先橙后紫 |
| 活动末日 23:25 兜底 | 仅在真实活动结束推送确认当天为最后一天时，允许一船放宽品质、奖励与水姆币筛选；持久记录阻止再次兜底 |
| 红船缺料生产 | 只为符合当前规则、确有可用船员位的红船产生需求；遵守其他订单预留；由工厂生产开关执行，独立于工厂“优先需求”选项 |
| 红船自定义出航 | 实际只能延后**申请船长时间**；游戏协议没有直接发船请求，不能承诺此时准确开航 |
| 联盟工事捐赠 | 捐已有、明确选中的材料；不兑换、不购买、不创建、不拆除、不执行最终完工 |

## 真实商船协议与客户端逻辑

协议通过 `loadProtocol()` 加载实际 protobufjs 类，字段直接核对其编码函数，不能仅依赖旧版字段反编译正则（新版嵌套命名空间发生过变化）。

- `GuildShipRequest {}` → `GuildShipResponse { period, ship[], ownRun[], worldShip[] }`。
- `DispGuildShip` 含 `shipId/type/state/leaderCond[]/leader/cabin[]/reward/preparedEndTime/mvEndTime`。
- `GuildShipCabin` 含 `crewId/order[]/player`。船员申请是 `GuildShipOrderRequest { shipId, crewId }`。
- 船长申请是 `GuildShipSeekRequest { shipId }`，不存在 `GuildShipRunRequest` 或自行编造的“出航”请求。
- 船位变更由 `SCGuildShipLeader`、`SCGuildShipOrder` 推送；实际开航由 `SCGuildShipMove { shipId, startTime, endTime }` 以及服务端完整状态决定。
- `SCGuildShipActivity { period: { period, startTime, endTime } }` 给出真实活动结束时间；完整商船查询只有期数，不能推断末日。

客户端 `GuildShipCargoPop._onConfirm/_sendOrderRequest` 明确检查：有船长、尚在准备期、自己不在此船、队列未满、舱位无人、订单材料足够。上船即交材料，因此详细自动化不把“本人已占船舱”的订单再次当作未完成材料需求。

客户端 `GuildShipLeaderPop._checkCanSeek` 按每个指定英雄的普通星级与专属星级相加，判断是否达到 `leaderCond.star + leaderCond.exStar`；不是分别比较两个星级。申请只消耗队列，不存在给请求附加任意英雄的参数。

客户端 `GuildShipModel.getMyShips/clearOwnMoveEndCityShip` 合并在途船与本人已登上的准备中船，在真实 `mvEndTime` 到达后清理占用。实现使用完整 int64 字符串比较玩家身份。

### 截图中不能写死的数值

- 当前 `ModuleOpenCfg` 的联盟商船开放等级为 **18**。
- `GuildShipCfg.time` 是分钟：紫船 150、橙船 300、红船 540；客户端展示乘以 60。准备时长来自 `GuildShipParamCfg.duration`，当前为 30 分钟，同时参与上限为 2 船。
- 当前 S1–S5 刷新小时为北京时间 08/11/14/17/20/23；S6 起额外增加 09/12/15/18/21。实现按赛季读取表，午夜承接前一天最后批次。
- “水姆币”是 `reward.asset` 中 `id = "水姆币"` 的奖励。截图的 25/70/100 为输入上界，不是消费金币，也不是必须花费的门槛。
- 活动末日放宽必须有当前连接的服务器结束时刻；尚未收到推送时保持普通筛选。

## 工事协议与边界

- `GuildCityInfoRequest` 返回本联盟城市及 `fort`；只检查本联盟城市当前未完工工事。
- `CityFortInfoRequest { cityId }` → `CityFortInfoResponse { fort, dailyDonateNum, ... }`；`fort.process[]` 是 `{ itemId, num }` 累计材料进度。
- `WorldFortCfg.donateCost` 是总材料需求，`FortDonateMaterialCfg` 给出可捐材料的真实规则，`FortSeasonUnlockCfg` 决定赛季开放。`FORT_BUILDING = 0`，`FORT_ACTIVE = 1`。
- `DonateFortRequest { cityId, item: { itemId, num }, selectPackNum: 0 }` → `DonateFortResponse { process[], reward }`。始终把 `selectPackNum` 设为 0；该参数在客户端用于兑换不足材料，本实现不启用。
- 工事材料选择为空时，仅沿用 `alliance.allowedMaterials` 的明确选择；两者皆空不会捐赠任意材料。
- `reserve` 是每种库存保留量；额外保留周订单、贸易港和居民订单。`dailyLimit = 0` 表示不加本工具日限，正数同时计入服务器 `dailyDonateNum` 和持久预占数量。

## 确认、持久化和离线验证

商船申请发送前重读船位、英雄、库存和竞争订单，并复查开关、配置、账号、批次及准备结束时间。只有完整状态出现**本人对应船长/船员身份**才确认成功；无提示不等于成功。未知申请持久保留，跨日、重启或换连接不会自动重复。

材料消费通过全局 `order-reservations` 预留；业务结果确认后读取完整库存核销，不能仅凭库存减少确认。工事公共进度增加不能证明本人的丢失请求成功，未知结果继续保留；明确响应必须带可核对的进度和奖励。确定未发送或对应请求被拒绝才取消预占。

离线测试：`tools/selftest-guild-ships.mjs`、`tools/selftest-guild-forts.mjs`。覆盖实际协议编码、int64、赛季批次、模式/角色/奖励筛选、库存与日限、发送前配置改变、末日一次兜底、完整库存核销、读取失败、未知结果跨重启/跨日及生产需求接线。
