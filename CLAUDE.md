# CLAUDE.md

本文件说明仓库结构、开发接线和验证约定。

## 项目概述

微信/抖音小游戏《疯狂水世界》的协议侧挂机工具：直连游戏 WebSocket 网关，并提供本地网页控制台。仅面向 Windows，Node.js >= 20.11，ESM。文档、界面和日志均为中文。

## 常用命令

```powershell
npm start                     # prestart 先构建界面，再启动；端口 17321
.\start-console.cmd           # 用户入口，端口 17323，不自动开浏览器，输出地址和实时业务日志
.\start-console.cmd url       # 只输出地址并保持窗口，不启动控制台
.\start-console.cmd status    # 只检查 MITM 证书状态，不启动控制台
npm run build:ui              # 改 TSX 或 theme.css 后运行，提交 src/ui/dist 产物
npm test                      # pretest 先构建，再依次执行下面三组，遇错即停
npm run test:core             # 核心协议、日常、原有玩法、阵容与掉线处理
npm run test:progression      # 装备、情报、订单、博物馆、海兽、预留与迁移接线
npm run test:extra            # 详细配置、活动、调度、维修、城战/锻造、礼包与地图
npm run test:core-subset      # core 子集
npm run test:capture          # 采集三组不在 npm test 内
npm run test:wechat
npm run test:wxapkg
node tools/selftest-radar.mjs # 单独运行对应测试文件
npm run sync-config           # 同步配置表到 work/
npm run sync-resources        # 从游戏发布清单更新配置表和世界地图
npm run sync-art              # 同步素材；缓存缺图可加 -- --fetch
```

`CW_PORT` 可改端口，`CW_NO_BROWSER=1` 禁止自动开浏览器。没有 lint 和测试框架；测试用 `node:assert/strict`，新文件需加入对应 `package.json` 脚本，不会自动发现。单跑某个测试分组不会触发顶层 `pretest`，涉及界面标记时先构建。

- `selftest-{fishing,fishing-upgrade,antique-recruit,activity-schedule,resident-orders,resident-http}.mjs` 由 `selftest-automation.mjs` 调用，单独执行不会跑测试。
- `selftest-registry.mjs` 与 `selftest-describe.mjs` 不在 npm 测试脚本内；注册表测试会写测试键并自行清理。
- CLI 见 `src/app.mjs` 的 `main()`。本地只读有 `accounts`、`actions`、`config [表名]`；`state/worlds/world/tasks/dailies/heroes/loot/loop/stages/field/act/connect/probe` 会连接游戏。用 `--account` 或 `CW_ACCOUNT` 选账号。

## 真实账号与测试数据

- 带 `--yes` 或 `CW_ALLOW_MUTATE=1` 的命令可能改变真实账号。`--dry` 不执行写操作，但仍会登录；验证改动使用离线测试，不用真实账号跑回归。
- 工具登录与游戏客户端可能互相顶号；`worlds <worldId>` 进入没有角色的区服可能创建角色。
- 涉及账号存储或控制台的测试，必须在动态导入 `accounts.mjs`、`server.mjs` 前设置临时 `CW_DATA_DIR`，必要时设置临时 `CW_CONFIG_PACK`。`DATA_DIR` 在模块加载时确定。
- `data/` 含凭据、账本与日志，`work/` 含游戏协议与配置，均被忽略，不提交或外发。`src/ui/dist/` 是应提交的构建产物。

## 架构

### 协议与配置

仓库不分发 `.proto` 或配置表，运行和部分测试需要本机游戏缓存。

- `proto.mjs` 执行游戏自带 `game.js`，取得 protobufjs 编解码类。`protocol-source.mjs` 按 `CW_PROTO_BUNDLE`、微信缓存最高版本 `_src_chunks_.wxapkg`、`work/extracted/` 查找。
- 无反射信息，使用 `tools/describe.mjs` 还原字段、`tools/ctx.mjs` 查压缩代码上下文。`work/extracted/` 可能落后于微信缓存，客户端逻辑以缓存最高版本的主包为准。请求名和响应名必须核对真实 `protocol[name]`，不能凭名称推测接口。
- `config.mjs` 按 `CW_CONFIG_PACK`、已验证的远程资源快照、较新的本地同步副本或微信缓存查找。`resource-updater.mjs` 在控制台和 CLI 持续挂机启动时及每 30 分钟检查发布清单（`CW_RESOURCE_UPDATE_MINUTES` 可调），验证配置和地图后原子启用；`config.resources` 保留任务的地图快照，挂机只在下一轮切换。`npm run sync-resources` 手动更新远程资源，`npm run sync-config` 备份本地配置来源；旧注释中的 `tools/fetch-config.mjs` 已不存在。测试应使用临时 `CW_RESOURCE_DIR`，控制台测试默认不启用远程更新。
- `actions.mjs` 是协议操作目录，`mutate` 区分读写；`CW_DEBUG=1` 可同时在终端输出协议日志，原始日志默认写项目 `data/protocol.log`，主日志与 `.1` 按 `CW_PROTOCOL_LOG_MAX_BYTES`（默认 5 MB）轮转。

### 执行与调度

- `client.mjs` 的 `GameClient` 管理 WebSocket、序号、Ack、心跳和请求匹配；帧格式见 `codec.mjs`、`frame-header.mjs`、`lz4.mjs`。有响应的请求用 `request`；`sendWatch` 未收到 prompt 也不能据此确认实际结果。
- 玩法模块先读取状态，再计算计划，最后在发送前复查。明确未发送可释放预留；超时或结果不明需保留记录，按对应玩法查询确认。
- `loop.mjs` 编排自动任务，结合开关、状态、到期时间、推送和账本决定何时复查，并非第二轮计划必然为空。CLI 与控制台共用它，是否传 `isEnabled` 会影响路径，修改需检查两侧。
- `challenge-automation.mjs` 接入每轮主线/闯关与试炼挑战，海盗讨伐在 `checkDispatch` 中按舰队优先级每轮最多派遣一次。`loop.challengeRun` 跨重连保留失败计数与海盗预算，达到失败上限不因换轮重试；重新开始挂机才创建新计数。挂机主线与试炼共用 `progression` 配置和失败上限，旧 `schedule.stageAuto` 迁移到 `progression.mainline`；挑战页手动参数独立。`battle-pacing.mjs` 在账号队列中为手动/自动主线和试炼共用 5 秒间隔，等待后复查开关。自动与手动相互避让，明确拒绝不计战败，未知战果不能重发。
- `server.mjs` 管理 HTTP API 与账号会话；同账号手动和挂机写操作经 `enqueue` 串行执行，新增写路由也必须接入。暂停、切号或等待期间关闭开关后，发送前再次检查。
- 挂机一轮是一个 `enqueue` 任务，可持续一分钟以上。新增只读路由用 `readJob` 或 `progressionJob(..., { read: true })`，队列忙时经 `GameClient.interleaveRead` 插在两次请求之间。`PromptResponse` 没有请求编号，不能让读取与其他请求同时在途；这条通道只能用于确实不改变游戏状态的读取。
- 网页仅控制和订阅日志，关闭网页不停止后台 `loop.job`。业务日志经 `createConsole({ onLog })` 输出到 CLI；日志回调和 SSE 异常不能影响游戏任务，显式关闭控制台时再关闭 SSE。验证使用 `selftest-console-background.mjs` 的隔离账号与假客户端。
- `activity-availability.mjs` 集中记录已确认结束活动的配置下线规则，依据见 `docs/activity-availability.md`。只过滤配置视图和有效调度，不删除 `automationTasks`、设置 schema 或历史值。服务器当前开放的对应子活动可覆盖旧下线记录；配置静态字段、动态补全、旧控制 API 和 loop 别名门控须一起检查，不能按“限时活动”整个分组停用。
- 挂机使用外层运行 controller 和每连接独立 attemptController。普通网络、心跳连续超时和重传失败会中断旧轮次，待其退出后退避重连（3 秒起、最高 60 秒），保留进度、账本与预留；被顶号、拒绝登录、协议错误及用户停止不重试。`GameClient.closeReason` 和登录错误 `recoverable` 决定分类，不能靠所有异常一律重登。重连期间网页读取不得另起登录绕过退避。旧可配置重连界面和 Webhook 仍未恢复。
- CLI 的 `console-output.mjs` 在支持 VT 的 TTY 使用滚动区固定地址/提示，日志分批且有界，非 TTY 保留纯文本；关闭恢复滚动区。不要绕过此输出器打印普通控制台日志或全局替换 console；`CW_PIN_HEADER=0` 可关闭顶部固定。
- `reward-schedule.mjs` 记录奖励下次检查时间，相关推送提前唤醒。推送只触发串行检查，不能另开并行派遣绕过预算。
- `accounts.mjs`、`capture.mjs`、`tools/mitm-*.mjs` 管理账号与采集；采集会临时改系统代理和用户证书。

### 控制台页面

`page.mjs` 在模块加载时生成完整 `PAGE`，页面文件变更后需重启控制台。

- `src/ui/*.tsx` 经 esbuild 输出 `src/ui/dist/console.mjs`，服务端渲染静态标记；浏览器没有 React，组件不能依赖 hooks 或事件属性。
- 行为使用原生 JS：`page.mjs` 的脚本与 `settings-ui.js`、`ui/progression.js`、`ui/activities.js`、地图、礼包、仓库和活动统计/排行脚本共享页面作用域。
- 界面采用 shadcn/ui new-york-v4 的默认 neutral 主题。`src/ui/{button,card,table,switch,badge,dialog}.tsx` 用官方样式字符串；`theme.css` 的 `@layer components` 按官方样式定义 input、select、textarea、checkbox、radio、range、summary、页签、弹窗和气泡，运行时脚本直接创建原生元素也能得到相同外观，不要再给控件写专用外观。换主色只改 `:root` 的 `--primary`、`--primary-foreground`。
- 样式层顺序为 `properties, theme, base, components, page, utilities`。`console.css`、`settings.css` 在 `page` 层，只放布局和间距，不用 Tailwind 处理，所以不能写 `@apply`。模板克隆元素带工具类，变体颜色写在 `theme.css` 的 `@layer utilities`。新增运行时模板需在 `layout.tsx` 的 `templates()` 声明。修改 TSX 或 `theme.css` 后执行 `npm run build:ui`，将 `src/ui/dist/` 一起提交；`npm start`、`npm test` 也会先构建。
- 手机布局以 768px 为界：导航固定到底部，页头不吸顶。`table()` 生成的四列以上表格在 `main` 窄于 600px 时变为卡片，列名来自 `td[data-label]`。图标走 `art-thumbs.mjs` 的单图缩略图，页面不要再引用整张图集。
- 顶层导航为总览、挂机、游戏配置、建筑一览、挑战、资源与玩法、账号。总览提供运行状态、只读活动统计/排行和世界地图；手动玩法归建筑一览、挑战或资源与玩法。
- 游戏配置按账号草稿编辑。导入、保存、预览分别处理，保存不启动挂机；预览可连接读取真实状态但不写资源，运行安排预览无需连接。

## 自动任务接线

1. `automation.mjs` 的 `automationTasks` 保留任务名、分组和缺省值；`automation-controls.mjs` 定义 UI 控制字段、门控、挂机模块入口和配置跳转，`settings-ui.js` 定义细项。
2. 详细字段在 `automation-settings.mjs` 定义默认值、校验和旧格式兼容；原生任务映射通过 `nativeFields`，策略检查通过 `automation-policy.mjs`。不要用新增默认值覆盖旧账号的显式 true/false。
3. 在 `loop.mjs` 接入实际执行与 `report`，通过 `reward-schedule` 或模块调度控制复查；手动日常单项还涉及 `daily-single.mjs`。报告明确区分完成、已发送、跳过与失败。
4. 新增路由在 `operation-labels.mjs` 补中文名称；测试放入 core、progression 或 extra，并更新用户文档。

原有 `schedule.guildOrders/radarAuto/radarRepair/equipmentCollect/equipmentCraft/museumCollect/museumExplore/petCollect/petBreed` 独立保存，不强行映射成需要舰队、配方等参数的新模块。对应详细模块有效开启时接管相同功能，避免双跑；停用详细模块后可恢复旧规则。周订单手动、自动和活动入口统一调用 `activities.mjs` 的 `runWeekOrder`，共用持久防重键和材料预留。

门控有各自范围：`loop.world` 管基地，`loop.dailies` 管招募、点金、竞技场等日常动作，英雄自动养成需要 `loop.heroes && heroes.enabled`。免费领奖有独立开关。新增资源消费应由用户主动开启，海商王走商 `merchantTrade`、风采投票 `beautyVotes` 和罗盘用券 `compassSpin` 默认 false；不要笼统把所有“活动”都当成免费领奖。

### 用量与资源预留

- `automation-settings.mjs` 保存 `automation-settings.json` 与 `automation-usage.json`，按账号管理。导出只含设置，兼容旧 `crazywaterword-automation` 格式，不能导出凭据或账本。
- `createUsageLedger` 在发送前持久占用预算，确认后登记，明确未发送或拒绝才取消。日计数按北京时间换日，带 `uniqueKey` 的未知 pending 跨日保留；重启、导入或保存设置不能清零记录。未知结果不当成成功，也不能直接重试。
- `automation-policy.mjs` 计算消费、保留量、次数限制与总预算。钻石总开关默认 false、总日预算默认 2000、保留阈值默认 0；日预算 0 禁止自动钻石。模块预算和总预算同时检查，加速器共用保留量。
- 原主分支的 `order-reservations.mjs`、`gold-reservations.mjs`、`fleet-reservations.mjs` 继续协调材料、金币和舰队/汽油。已确认扣款可能早于库存同步，因此进程内记录按账号跨重连保留，进程重启后清空；与持久账本共同防止旧余额被重复使用。
- 普通材料/金币消费通过 `operation` 保存明确回执或使用新连接的业务状态核对函数，先取业务证据再读完整库存结算；通用 guard 的核对见 `spend-evidence.mjs`。不得用净余额下降作为已确认操作的唯一恢复条件，也不能把旧队列自然成熟当成未知新请求成功。新增材料消费者应传实际材料范围，避免阻塞无关材料；缺少完整读取或业务证据继续保留记录。
- `guard.before` 返回每次操作独立的票据，即使没有日计数也必须原样传给 `after/cancel`，不能按相同请求参数代替票据。即时核对与重连核对共用同一发送前基线；`notSent` 只可归属于原写请求，写入后的回读或回调报错不能取消已发送消费。
- 新增消耗型玩法需接入适用的两层检查，保留周订单、贸易港和居民订单用料。日常动作在预算占用后等待期间被关闭时取消 ticket，已发送但结果未知则保留预算。

### 舰队与额外玩法

- `fleet-availability.mjs` 统一派遣顺序和两代占用桥接：默认城战、首杀、世界 Boss、巨轮跟随、普通巨轮、联盟情报。意向预留不抢占真实在途舰队；首杀、城战窗口等预留只阻止低优先级任务。
- `fleet-settlement.mjs` 依据服务端状态核对占用。解除占用时保留防重证据与已确认费用，空闲不代表未知任务已成功。
- `fleet-maintenance.mjs` 复用启用城战/巨轮的 `autoRepair` 和舰队名单，空闲后普通补满，不要求下一个目标或仍处于城战时段。同舰队取优先来源的维修参数，遵守该来源保留量与预算。
- `world-boss.mjs` 只在服务器当天参与次数为 0 时派一支空闲舰队；城战接续、万吨巨轮、首杀各自检查目标、耐久、汽油和持久防重记录。城战原生委任额度来自服务器 VIP 规则，不能写死次数；`cityWar.nativeCommissionLimit` 默认 -1 按 VIP 等待，0 关闭所选舰队的原生委任后接管，N 表示先用 N 次再关闭，关闭结果需回读 `MyFleetsResponse` 确认。
- `equipment-forge.mjs` 管详细锻造，`equipment-crafting.mjs` 保留原手动制造；达到下单上限不应阻止完工领取。海兽放生与装备分解不能读取客户端本地锁定，页面帮助必须说明限制。`antique-upgrade.mjs` 管藏品激活、升星、大师等级和套装升级；激活只消耗对应碎片，升星可用万能碎片，套装与大师消耗金币/经验；结果未知时按持久键阻止重复发送。
- `seasonal-activities.mjs` 与奖励模块处理新活动；消费动作与免费奖励分别门控。`side-rewards.mjs` 处理漫剧、擂台赛每日礼包和赛季宝箱；擂台赛状态只有推送，由 `server.mjs` 记在连接上。`gift-codes.mjs` 按账号保存记录，多账号各自排队、发送跨账号串行；未知或连接失败只停该账号，限频停止同批未发送账号，未知码不重发。
- 世界地图、活动统计和排行榜是只读展示。地图移动位置为已同步行军数据的推算，自动刷新间隔与挂机独立，不能承诺实时坐标。

## 数据与验证约定

- 未安装 Long 库，int64 常为 `{ low, high, unsigned }`。普通数值用 `client.mjs` 的 `toNumber`；UID 等大整数需精确字符串或 `automation-policy.mjs` 的 ID 转换，不能先转不安全 Number。
- 服务端时间使用 `Date.now() + client.serverClockOffsetMs`，每日按北京时间重置；合服后 `GameWorldInfo.worldId` 可能不同于角色 `worldId`。
- 用假 client 驱动玩法，同时断言请求/响应存在于真实 `protocol`。为消费流程验证预算、并发、未知结果、重连/跨日防重及发送前关闭，不写只复述实现的测试。
- 变更通过适用分组后即可；界面相关先构建。完整迁移使用 `npm test` 验证三组，并用 `git diff --check` 检查格式，避免真实账号验证。

## 文档

用户行为变化更新 `README.md` 和倒序 `CHANGELOG.md`；协议与配置依据见 `docs/gameplay.md`，登录来源见 `docs/wechat-login.md`。
