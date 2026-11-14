# 超凡英雄活动：截图对照与实际协议

核对日期：2026-11-14。依据本机微信版本 76 的主包 `HeroRaidOrderPanel`、`HeroRaidLotteryPanel`、`HeroRaidUtil`、活动模型和配套 protobuf 类型。订单与奖励通过离线假客户端回归；真实账号已收到完整但为空的活动清单，因此尚未在线验证交单或领奖，见 [实测记录](live-validation-2026-11-14.md)。

## 对照结果

截图中的「超凡英雄活动总开关」在原项目中没有对应执行模块。原来仅监听 `SCHeroRaidOpen`，为工厂准备红卡订单材料，没有自动完成订单、领取累计订单奖励或累计抽取奖励，也遗漏了登录时 `SCAllActivity.raid[]` 中已开放的活动。

本次实现：

- `heroRaid.enabled` 控制整个模块，关闭时保留 `orders` 与 `rewards` 原值。
- `heroRaid.orders` 自动完成已解锁且库存足够的当前活动订单，每轮每个活动最多一单；缺料进入工厂已有 `heroRaid` 需求来源，由工厂总开关和按需生产策略处理。
- `heroRaid.rewards` 分别领取已经达标的累计订单奖励、累计抽取奖励。领取不会主动抽卡。
- 工厂需求仅在总开关和订单开关均开启、活动实际开放且订单没有未知写入时生成。重复材料先合并计算，达最终订单后停止备料。

**没有「免费抽取次数」功能。** 实际 `HeroRaidPrizeRequest` 使用英雄副本抽卡券；客户端 `_onBtnGo` 明确先检查 `HERO_RAID_ITEM = 英雄副本抽卡券` 库存，然后发送 `{raidId,times}`。`HeroRaidTimes` 只有累计 `times` 与已领档位 `gotIndex`，没有免费计数。新增模块不发送 Prize 请求、不买抽卡券、不把现有券标成免费次数。

## 实际数据和协议

| 动作／状态 | 实际协议 | 关键证据 |
| --- | --- | --- |
| 登录全量活动 | `SCAllActivity.raid[]` | 活动模型 `_onSCAllActvity` 用其替换当前英雄活动列表 |
| 新开放单项 | `SCHeroRaidOpen.raid` | 活动模型加入新的 `DispHeroRaid` |
| 当前活动 | `DispHeroRaid` | `raidId/startTime/finishTime/order/drawTimesInfo`，时间以服务端偏移校准 |
| 完成当前订单 | `HeroRaidFinishOrderRequest({raidId})` → `HeroRaidOrderResponse` | 回执同时返回新 `order` 和 `reward` |
| 领取累计订单奖励 | `HeroRaidGotOrderRewardRequest({raidId})` → `HeroRaidOrderResponse` | `HeroRaidOrderRewardCfg.orderCount <= gotOrderId` 且 `orderCount > gotTimes` |
| 领取累计抽取奖励 | `HeroRaidGotRewardRequest({raidId})` → `HeroRaidGotRewardResponse` | `HeroRaidLotteryTimesCfg.reqTimes <= times` 且 `index > gotIndex` |

没有独立 `HeroRaidInfoRequest`。因此不能通过虚构的读取接口「刷新活动」，也不能仅凭配置表推定活动已经开放。`watchHeroRaidPushes` 必须在登录前注册，只使用当前连接收到的完整推送以及经过校验的本模块回执；断开或重新登录清空旧状态。

`HeroRaidOrder.orderId` 为当前单号，`gotOrderId` 为已完成单号，`gotTimes` 为已领取的累计订单奖励阈值。客户端按北京时间开服天数检查 `HeroRaidOrderCfg.unlockDay`，不是简单从开启时间经过 24 小时计一天。

## 保护与未知结果

- 实际下单前重新读取完整库存与周订单、贸易港、居民订单预留；下单使用 `beginOrderMaterialSpend`，避免活动吞掉高优先级订单材料。
- 初始活动进度、活动期间标识、账号身份、开关及时间窗在等待库存读取后再次核对。读取期间推送了新进度或者关闭开关时，不发送旧计划。
- 持久唯一键含账号、活动编号、开始／结束时间与当前订单或已领档位。超时或不完整回执保留 pending，重启后不重复提交。
- 未知订单只有同一活动期间的实际 `gotOrderId` 进展能核销；未知领奖只由对应已领阈值或档位进展核销。库存净下降不能作为唯一成功证据。
- 真实奖励回执与业务进度确认后，才读完整库存结算材料预留；后续读取的 `notSent` 不会释放已经发送的消费票据。

## 接线与测试

- `watchHeroRaidPushes(client)` 返回 `{observed, invalid, raids: Map, revision}`，可供只读状态预览使用。
- `runHeroRaidAutomation(client, protocol, config, player, {getSettings, ledger, enabled, report})` 执行一轮，接入原账号串行队列。
- `heroRaidDemands(client, config, player, settings, {ledger})` 为工厂返回需求，未知请求不继续备料。
- `tools/selftest-hero-raid-automation.mjs` 使用真实配置和实际 protobuf 编解码。覆盖首次推送、登录全量、重连清空、重复材料、日解锁、活动截止、材料预留、发送前配置变化、未知结果、明确拒绝／未发送、领奖档位确认和并发防重。
