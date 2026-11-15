# lib/ — 公共库

**新脚本一律 require 这里，不要内联 API Key / 端口 / 店铺名 / http 样板。**

历史背景：写这套库之前，仓库里 **140 个脚本各自内联了 API Key**，
**135 个各抄了一份 `http.request`**，**84 个 `_*-run.js` 是同一个执行器的手抄副本**
（其中一个的店铺名已经烂成乱码 `濂芥槗缇庝唬鎷?` 而没人发现）。
改一次配置要动 140 个文件，轮换一次 Key 基本上做不到。

## 快速上手

```js
const out = require('../lib/out');
const agent = require('../lib/agent');
const mtop = require('../lib/mtop');

(async () => {
  await agent.ready();                       // 打开所有店铺页（前置条件）
  await agent.enterAdConsole();              // 进 dayu 广告页（带缓存）
  const plans = await mtop.adPlans({ days: 7 });
  out.head('计划');
  out.table(mtop.PLAN_HEADERS, plans.map(mtop.planRow));
  out.full(plans, 'my-plans');
  out.done(0);
})().catch((e) => out.fail(e));
```

## `lib/env.js`

| 导出 | 说明 |
|---|---|
| `ROOT` | 项目根（`D:\DSH\achun`） |
| `cfg` | 完整配置对象 |
| `SVC` `STORE` `STORES` `URL` `TH` `RULES` `OUT` | 常用配置的快捷方式 |
| `p()` | 项目内路径拼接（一律正斜杠）：`p('logs','a.json')` |
| `readJSON(f, fallback)` | 读 JSON，**自动剥 BOM** |
| `writeJSON(f, obj)` | 写 JSON（UTF-8，无 BOM） |
| `ymd(d)` | `YYYYMMDD` |
| `now()` | 本地时间字符串 |

环境变量可覆盖：`XY_API_KEY` `XY_PORT` `XY_HOST` `XY_STORE`。

## `lib/http.js`

`post(path, body, opts)` `get(path, opts)` `getBuffer(path, opts)` `alive()` `request()`

- 默认超时 180 秒，`opts.timeout` 覆盖。
- 服务没起来时错误信息里直接给出处置提示。
- `alive()` 不抛错，返回布尔。

## `lib/agent.js`

| 方法 | 说明 |
|---|---|
| `ready({force, all, stores})` | 启动**当前运营的店铺**（`config.store.active`，默认只有「好易美代拍」）。进程内只真调一次；`all:true` 才开全部三个账号 |
| `evalOnStore(code, {store, timeout})` | 在店铺页执行 JS；**命中 DELETE_GUARD 时抛的 error 带 `blocked=true`** |
| `evalFile(file, opts)` | 执行一个 `.js` 文件内容并 JSON.parse（替代 84 个 `_*-run.js`） |
| `evalPage(code, page)` | `page` 为 `'goofish'` 或 `'dayu'` |
| `enterAdConsole({settle, ttl})` | 进广告页并校验域名；默认等 16 秒，2 分钟内不重跳 |
| `mtop(code, opts)` | 在页面里跑一段用到 `mtop` 的代码，返回解析后的结果 |
| `screenshot(out)` | 截 `agent.page`（**截不到 goofish 页，已知缺口**） |
| `whereAmI()` `status()` `accounts()` `showStore()` `sleep()` `isUp()` | 杂项 |

## `lib/mtop.js`

| 方法 | 说明 |
|---|---|
| `adPlans({days, store})` | 拉计划并规范化为只含叶子字段的对象数组 |
| `adPause(ids, {pauseStatus})` | `pauseStatus` 1=暂停 0=恢复 |
| `itemSearch(key, {tab})` | 广告用商品搜索 |
| `planVerdict(c)` | **状态判定的唯一实现**（statusGroup + statusDescTitle） |
| `isCollection(name)` | 是否「擦亮宝贝*」集合计划 |
| `normalizePlan(c)` `planRow(p)` `PLAN_HEADERS` | 规范化 / 表格行 / 表头 |
| `num` `yuan` `TARGET_CN` `VERDICT_CN` | 小工具 |

规范化后的计划对象字段：
`id name target bidYuan budgetYuan verdict verdictCn desc isCollection
 cumCost cumChat cumOrder dayCost dayChat itemCount items costPerChat`

## `lib/out.js`

`head` `kv` `ok` `warn` `bad` `plain` `table` `full` `done` `fail` `line`

- 默认预算 `config.output.maxLines`(15) 行，`--full` 不限，`XY_OUT_MAX` 覆盖。
- **截断只丢散文行（`kv`/`line`）；表格、`ok/warn/bad`、全量路径永不截断。**
- `full(data, label)` 把全量写进 `logs/<label>-<时间>.json`，摘要里只留一行路径。

## `lib/log.js`

`log(file, msg)`（打屏+写文件）`silent(file, msg)`（只写文件）`tail(file, n)` `rotate(file)`
超过 `output.logMaxKB` 自动只保留最后 `logKeepLines` 行。

## `lib/args.js`

`parse(argv)` → `{ _: [...位置参数], key: value, flag: true, has(k) }`；`need(a, i, label, usage)`。
Node 是 UTF-8 原生，中文参数从 `argv` 进来不会被拆坏。

## `lib/ps/Writes.ps1`（给 PowerShell 用）

```powershell
. (Join-Path $PSScriptRoot 'lib\ps\Writes.ps1')
Write-Utf8NoBom -Path $stateFile -Text ($state | ConvertTo-Json -Depth 4)
```

`Write-Utf8NoBom` / `Read-Utf8Text`。存在的理由：PS 5.1 的 `Out-File -Encoding UTF8`
写出来**带 BOM**，而带 BOM 的 JSON 会让 Node 的 `JSON.parse` 直接抛错（读状态的地方
如果包了 try/catch 就会**静默丢状态**）。

## 自检

```
node tools/selftest-lib.js          # 配置 + 纯函数
node tools/selftest-lib.js --live   # 再加 服务 + 浏览器 + mtop 全链路
```
