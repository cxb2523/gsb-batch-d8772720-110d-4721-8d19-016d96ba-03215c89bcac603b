/**
 * tools/make-release.js — 打「可分发给学员」的代码包（zip + sha256 + 清单）
 *
 * 为什么需要它、以及为什么它同时解决了「密钥还在 git 历史里」这个问题：
 *   泄漏在【git 历史】里（`git log -p` 能挖出中台 tenant key / Supabase service_role / 企微 chat id），
 *   而**当前工作树是干净的**（tools/scrub-secrets.js 一直报「跟踪文件里没有真实密钥」）。
 *   所以：给他一个**没有 .git 的快照包**，他就拿不到历史 ——
 *   不必等密钥轮换完才能发代码。（轮换仍然要做，因为只读 token 那条路依然会暴露历史。）
 *
 * 打包内容 = `git ls-files`（只含被跟踪文件）+ 排除清单。
 *   用 ls-files 而不是遍历目录：自动排除 .gitignore 里的东西（config.local.json、
 *   service.local.json、node_modules、日志）—— 这几样恰恰是最可能带密钥的。
 *
 * ⚠️ 打完必须【扫一遍包里的内容】再落盘。扫不过就拒绝产出。
 *    "应该没有密钥"不是结论，扫过才是。
 *
 * 用法:
 *   node tools/make-release.js                    # 打两个仓（achun + playwright-service）
 *   node tools/make-release.js --only=achun
 *   node tools/make-release.js --out=D:\release
 *   node tools/make-release.js --list             # 只列出会打进包的文件，不产包
 * 退出码: 0 成功 / 1 扫出密钥或打包失败 / 2 参数问题
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ARGV = process.argv.slice(2);
const opt = (k, d) => { const a = ARGV.find((x) => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const ONLY = opt('only', '');
const OUT = opt('out', path.join('D:\\', 'xianyu-release'));
const LIST_ONLY = ARGV.indexOf('--list') >= 0;

const ACHUN = path.resolve(__dirname, '..');
let SVC_REPO = '';
let MON_REPO = '';
try {
  const P = require('../lib/env').PATHS || {};
  SVC_REPO = P.playwrightService || '';
  MON_REPO = P.xianyuMonitor || '';
} catch (e) {}

/**
 * 排除清单 —— 学员要的是"能跑起来的代码 + 说明书"，不是老板的素材和台账。
 * 注意这里【不需要】再排除 config.local.json 之类：它们本来就没被 git 跟踪。
 */
function excluded(rel) {
  const f = rel.replace(/\\/g, '/');
  if (f === 'stores/_template.json') return false;                 // 例外：建店模板要发
  // 【第 166 轮加】方案文件模板 —— 配置手册教「照抄现成的改」，
  //  而 publish-groups/ 整个目录是老板的 140 个真实方案（带 itemId），排掉了。
  //  没有模板的话，学员照着手册找不到「现成的」可抄。这个 _template 是脱敏版。
  if (f === 'publish-groups/_template.json') return false;  // 【2026-11-13 加】tools/_syntax-check-all.js 是【学员包里的 verify-student-view 要调用的】。
  //   原来它被下面的「下划线开头 = 一次性脚本」规则排除，结果：
  //     · git 里加了（git add -f）→ 但 make-release 还是不带它
  //     · 包里 verify-student-view 的⑨组 execFileSync 调它 → ENOENT
  //   这和 install.cmd 那次是同一类错：多个环节各有一套排除规则，改一个不够。
  if (f === 'tools/_syntax-check-all.js') return false;             // 例外：自检要用
  // 【2026-11-13 第 116 轮加】ad-cost-breaker.js 是【广告花费熔断器】，
  //   每 30 分钟跑一次，学员配置手册里明确让学员用 `node ad-cost-breaker.js --dry` 预演。
  //   底下那条 /^ad-[\w-]+\.js$/ 把它一起排了 —— 自检 ⑦ 组抓到的（「缺 ad-cost-breaker.js」）。
  //   根层 39 个 ad-*.js 里只有它一个是给员工用的，其余 38 个都是老板的一次性脚本。
  if (f === 'ad-cost-breaker.js') return false;                      // 例外：学员手册要用
  const rules = [
    /^stores\//,                    // 老板各店的档案（含价格策略、素材路径）
    /^publish-assets\//,            // 85MB 素材，学员自己出
    /^publish-out\//,               // 出图产物
    /^_archive\//,                  // 历史脚本
    /^logs\//, /^_backup\//, /^release\//,
    /\.log$/, /\.ndjson$/,          // 运行日志（含真实计划名/花费）
    /\.(jpe?g|png|webp|gif|zip|pdf|psd|sqlite)$/i,   // 图片/包/账本
    /^上架台账\.json$/,              // 含 itemId + 标题 + 本地路径
    /^config\.local\.json$/, /service\.local\.json$/,
    /(^|\/)\.[^/]+$/,               // 隐藏文件
    // 【2026-10-09 加】内部文档不进学员包：
    //   index/ = 我自己的环境与账号笔记（含两个真实闲鱼手机号 + 账号 UUID）
    //   给王恩博/给小美/发给吴伟龙 这些是【发给老板或同事】的沟通件，不是学员材料，
    //   而且里面为方便对方核对写了真实账号。
    //   这不是"看着不专业"的问题 —— §9.3 明写要剥离老板的闲鱼登录信息。
    /^index\//,
    // 注意别把「给学员的一页说明.md」也排掉 —— 第一版我的模式里有 `给学员`，
    // 结果把学员最需要的安装说明从包里剔了（校验脚本抓到的）。
    // 要排的是【给同事/老板】的沟通件，不是给学员的说明书。
      /(给王恩博|发给吴伟龙|给小美|协同小美)/,
      // 【2026-11-13 加】还有几份内部件混在根层，学员打开包会看到「密钥清理说明」这种标题：
      //   - 交付说明-* / 说明与分析 / 密钥清理说明：都是给老板或我自己看的
      //   - 企微智能表格指令通道：内部通道说明
      //   学员真正需要的只有：发放说明-给学员.md / 学员安装-给学员DSH.md / install-guide.html
      /(交付说明-|说明与分析|密钥清理说明|指令通道)/,
    // 【2026-10-09 加】`tools/_*` = 本仓自己的约定「下划线开头是一次性脚本」。
    //   学员不需要它们（安装流程只用 install.ps1 / print-paths / install-config /
    //   store-init / healthcheck / install-tasks，没有一个下划线开头），
    //   而它们里常有测试用的假账号/假号码，留在包里只会让 PII 扫描狼来了。
    /(^|\/)_[^/]*$/,
  // 【2026-11-13 加】老板自己的定时任务和内部协作件 —— 学员包里不该有这些东西。
  //   实测（第 108 轮）：包里带着 111 处写死的 D:\DSH\achun，分布在 49 个文件里，
  //   其中就包括「暂停发布.cmd」「继续发布.cmd」「ad-*.cmd」「publish-*.cmd」。
  //   风险不是"看着乱"，是【误点】：
  //     · 点「暂停发布.cmd」→ 自动发布整个停掉
  //     · 点「ad-window-8am.cmd」→ 在学员机器上跑广告任务，八成报错
  //   而且这些 .cmd 里写死的都是 D:\DSH\achun，学员的目录不是这个，跑了必然失败。
  //
  //   ⚠️ 注意只排【.cmd】。`publish-one.js` / `publish-group.js` 是学员要用的，
  //      光写 /^publish-/ 会把它们一起排掉 —— 这是这类规则最容易犯的错。
  /^(ad-|publish-|stop-|jg-snapshot|night-quiet)[\w.-]*\.cmd$/,
  /^(暂停发布|继续发布)\.cmd$/,
  // 内部协作 / 交接 / 立项文档：学员看这些只会困惑
  /^(workbuddy-task-|协作|交接-|项目瘦身|管理员竞选|管理员交接|派活模板)/,
  /^(闲鱼自动化-操作手册|中台账号与Key-对照|住宅代理采购|聚光取数清单|巡检日常动作清单)\.md$/,
  /^(闲鱼项目-|闲鱼自动化项目-|票务Hope-|主图规范-|文案对照-|贴图模板-|出图SOP-|采集SOP-|多店铺快速配置|员工使用方案|中台需求|企微CLI|好易美中台-|闲鱼上架与擦亮)/,
  // 【2026-11-13 加·第二批】包里的【内部 PowerShell 脚本】。
  //   第 108 轮只排了 .cmd，这轮扫 .ps1 才发现还有一整套：
  //     ad-*.ps1（4 个）—— 老板的广告定时任务，由 Windows 计划任务唤醒
  //     wecom-send.ps1  —— 企微发消息
  //     workbuddy-*.ps1/.cmd —— 内部 CLI 登录与运行
  //     ask-dsh / make-channel / ss-call / test-guard-live / add-cmd-sheet —— 内部工具
  //     wake-publish-sleep.* —— 保活任务（注释里直接写着 D:\DSH\achun\暂停发布.cmd）
  //   学员拿到这些只会困惑（双击了多半报错），而且里面有内部地址和调用方式。
  //
  //   要保留的（学员真会双击的）：install.ps1 / install.cmd / 体检.cmd /
  //   启动.cmd / run-node.cmd / start.bat，以及 lib\ps\*.ps1（被 run-node 那条链用）。
  /^(ad-[\w-]+|wecom-send|ask-dsh|make-channel|ss-call|test-guard-live|add-cmd-sheet|workbuddy-[\w-]+|login-workbuddy|wake-publish-sleep)\.(ps1|cmd|bat)$/,
  /(^|\/)(workbuddy-[\w-]*|login-workbuddy)\.(ps1|cmd)$/,
  /(^|\/)(verify-config|test-utf8-writer)\.ps1$/,
  // 【2026-11-13 加·第三批】和闲鱼自动化无关的东西。
  //   第 110 轮按扩展名统计包里 2.35 MB 时发现的：
  //     dsh-bloom-theme-0.13.2.tgz（141 KB）/ dsh-llm-hub-0.6.1.tgz（47 KB）
  //         —— 这是【DSH 编辑器自己的主题/插件包】，和闲鱼一点关系没有
  //     dc4.txt（129 KB）—— 我早期探 goofish 接口时的探测记录（不敏感，但学员用不上）
  //     dsh-data-backend-prompt.md —— 内部提示词
  //   这类东西的特征是：在 git 里（所以会被打包），但没人想到要排。
  /^dsh-.*\.(tgz|md)$/,
  /^dc4\.txt$/,
  // 各种「探测/抓包」留下的 .txt / .json（都是开发时的中间产物）
  /^(probe|dc\d+|netcap|_netcap)[\w.-]*\.(txt|json)$/,
  // 【2026-11-13 加·第四批】根层那一堆探测记录和业务文档。
  //   第 111 轮扫 .txt 发现包里有 39 个，其中绝大部分是：
  //     · 我探 goofish 接口时 dump 下来的（recon / dc-* / label-* / items-* / seller-api …）
  //     · 老板的业务交底书（票务业务-交底书-微信版.txt 25 KB）—— 这是【业务机密】
  //     · publish-groups/*.log.txt —— 发布日志，里面有真实商品名和 D:\DSH\achun 路径
  //   都不是学员该看的。
  //   ⚠️ PACKAGE-README.txt 要保留（三个仓库各一份，说明这个目录是什么）。
  /^(datacompass\d*|dc-[\w-]+|label-[\w-]+|recon\d*|status-[\w-]+|dig-[\w-]+|nav-links|card-shape|item-perf|items-[\w-]+|seller-api\d*|stat-probe|newest|scripts|user-tpl|param-cap|after-click|cap\d+|q|ad-[\w-]+)\.txt$/,
  /^(票务业务-|票务交底书|xy-copy-report)/,
  /(^|\/)publish-groups\/.*\.log\.txt$/,
  // 【2026-11-13 加·第五批】根层那一堆内部复盘文档。
  //   第 111 轮扫 .md 发现包里有 69 个，其中 47 个是【老板和我自己的执行记录】：
  //     · *-执行结果.md（十来个）—— 某次推广/补齐链接的结果
  //     · 出价变更记录.md（34 KB）/ 上架执行记录-*.md / 推广开启记录-*.md
  //     · 闲鱼同行数据-14明星*.md（24 KB）—— 竞品数据，业务机密
  //     · 今日表现分析-*.md / 状态快照-*.md / 教训-*.md / 私董会功能测试反馈-*.md
  //   这些是"我做完了什么"的记录，不是"学员怎么用"的说明。
  //   ⚠️ 别把「学员配置手册.md」「给学员的一页说明.md」这类排掉 —— 名字里没有这些关键词。
  /(执行结果|变更记录|上架执行记录|推广开启记录|停推广-|暂停计划-方法|状态快照-|今日表现分析|教训-|私董会功能测试反馈|同行数据|同行文案分析|商品与表现细读|主图AB测试|模板测试|验证清单-第|全流程测试与配置向导|未覆盖商品-可投机会|订单量目标-平台限制|六明星-单明星计划|单明星-三计划|单明星-补齐链接|热销Top5计划|十八轮变更清单|最终验收报告|广州守望先锋-上架|广州王嘉尔-上架|守望先锋-王嘉尔-推广|刘宪华-模板测试|徐良-三计划|三角洲-近期开抢)/,
  // 0 KB 的测试消息
  /^(wecom-test-msg|ad-cost-breaker-msg|stuck-recovered-msg)\.md$/,
  // 【2026-11-13 加·第六批】最后两个
  //   「待办-等登录后执行.md」—— 我自己的 TODO，和学员无关
  //   「标价对照表-14明星.md」—— 168 条同行代拍商品的实测标价（2026-09-21 抓取），业务机密
  /^(待办-|标价对照表-)/,
  // 【2026-11-13 加·第七批】根层那一堆【业务抓取数据】。
  //   第 112 轮扫 .json 发现根层有 248 个，1491 KB，绝大多数是我从闲鱼后台 dump 下来的：
  //     ad-*.json   112 个 —— 广告后台（真实花费 / 余额 / 点击成本 / 擦亮中计划）
  //     xy-*.json    30 个 —— 扫店/竞品汇总（xy-competitor-summary 45 KB）
  //     items-*.json 12 个 —— 商品列表快照
  //     damai-*.json      —— 大麦在架数据
  //   这些是【老板的经营数据】，发给学员既没用又泄露。
  //
  //   ⚠️ 必须限定根层（^）。子目录里的同名要留：
  //      lib/config.json（运行时配置）/ presets/*（建店预设）/
  //      stores/_template.json（建店模板）/ package.json
  /^(ad|xy|items|item|damai|plans?|verify|consol|raise150|half|ab|all-items|提到150)[-_.][\w.\u4e00-\u9fa5-]*\.json$/,
  /^(item-data|items-want|xy-[\w-]+|ad-[\w-]+|all-items\d*)\.json$/,
  // 【2026-11-13 加·第八批】剩下的几个业务数据文件。
  //   onsale.json         —— 在售商品快照（真实 itemId + 标题 + 销量）
  //   my-plans.json       —— 广告计划全字段
  //   AD-EXCLUDE.json     —— 排除名单，里面写着老板的原话指令
  //   shows-hold.json     —— 暂存任务（含真实商品标题）
  //   publish-schedule.json —— 10-11 的上架排期（老板的原话也在里面）
  //   webkubor-baseline.json —— GitHub 仓库基线，和闲鱼完全无关
  //   poster-templates.backup_*.json —— 备份文件
  //   console-out-*.json  —— 控制台抓取输出
  //   ⚠️ 检查过：publish-one.js 里提到 publish-schedule.js 只是【注释】，
  //      不是真的读那个 json，排掉不会让发布链报错。
  /^(my-plans|onsale|AD-EXCLUDE|webkubor-baseline|shows-hold|publish-schedule|combined|console-out-[\d]+|poster-templates\.backup_[\w]+|待删除清单-)/,
  // 【2026-11-13 加·第九批】四个【纯业务数据目录】。
  //   第 113 轮扫包发现：492 个文本文件里有 982 处真实 itemId、118 处「老板原话」。
  //   来源就是这四个目录：
  //     xy-daily/*.json       —— 每日抓取快照（无任何代码引用，纯数据）
  //     data/ad-daily.json    —— 广告日报，442 处真实 itemId
  //     publish-groups/*.json —— 发布方案（140 个，引用它的脚本不在包里）
  //     shows/*.json          —— 场次档案（56 个，含「老板 2026-10-15」这种指令原文）
  //
  //   已核实：学员会用的五个脚本（publish-one / first-publish / store-wizard /
  //   store-init / healthcheck）【一个都不引用这些目录】。排掉不影响学员。
  /^(xy-daily|publish-groups|shows)\//,
  /^data\//,
  // 【2026-11-13 加·第十批】根层剩下的运行产物（跑一次就生成一个，含真实 itemId）。
  //   第 113 轮扫完还剩 260 处 itemId，主要来自这几个：
  //     healthcheck.json（43 处）—— 一键体检的缓存结果
  //     campaigns-now.json（21 处）/ pause-result-*.json（14 处）
  //     cz-diag.json / cz-probe.json（各 12 处）—— 排查时 dump 的
  //   这些都是"跑完就有、下次跑会重新生成"的东西，学员机器上第一次跑自己会写。
  /^(healthcheck|campaigns-now|cz-diag|cz-probe|pause-result-[\d]+|ad-pending|dig-\w+)[\w.-]*\.json$/,
  // 【2026-11-13 加·第十一批】老板的广告【脚本】（.js）。
  //   前面排 ad-*.ps1 / ad-*.cmd / ad-*.json，漏了 .js ——
  //   第 113 轮 scan-package 扫出来 ad-stop-two.js（8 处真实 itemId）、
  //   ad-stop-shows.js（7 处）还在包里。这些是"停某几个计划"的专用脚本，
  //   里面写死了老板的 itemId，学员双击/运行只会报错。
  //
  //   ⚠️【2026-11-13 第 116 轮修】这条规则误伤了 ad-cost-breaker.js ——
  //      它是【广告花费熔断器】，每 30 分钟跑一次，学员配置手册里明确让学员
  //      用 `node ad-cost-breaker.js --dry` 做熔断预演。自检 ⑦ 组抓到的（缺 ad-cost-breaker.js）。
  //      根层 39 个 ad-*.js 里只有它一个是给员工用的，其余 38 个都是老板的一次性脚本。
  /^ad-[\w-]+\.js$/,
  /^(pause|resume|stop|start)-[\w-]+\.js$/,
  // 【2026-11-13 加·第十二批】打包工具本身。第 114 轮扫 tools\ 时发现它还在包里：
  //   make-release.js 是"打三个仓 + 生成 zip"的工具，只在打包机上跑。
  //   学员拿到它没有任何用途，而且它里面有 D:\xianyu-release / D:\xianyu-public 这些
  //   本机路径，跑了必然报错。
  //   （verify-student-view.js 和 _syntax-check-all.js 保留 —— 技术负责人
  //     拿到包之后可以用它们复核，而且它们找不到包时会自己说明"这是给技术负责人用的"。）
  /^tools\/make-release\.js$/,
  /^make-release\.js$/,
  // 【2026-11-13 加·第十三批】第 118 轮扫 --dry 副作用时发现的【老板一次性调度/下架脚本】。
  //   publish-schedule.js   （18 处写操作没被 !DRY 挡住）
  //   publish-4groups.js    （写排期锁、改地址）
  //   republish-bad.js      （会执行 do-offshelf.js —— 下架商品！）
  //   sheet-command-runner.js（执行控制台命令 + 写 state）
  //   这些是"某次上架排期 / 重发失败品 / 从飞书表格触发命令"的专用脚本，
  //   学员不会用，而且 --dry 保护并不完整。
  /^tools\/(publish-schedule|publish-4groups|republish-bad|sheet-command-runner)\.js$/,
  /^(publish-schedule|publish-4groups|republish-bad|sheet-command-runner)\.js$/,
  // 【2026-11-13 加·第十四批】第 134 轮新加的发包工具。它在打包机上把 zip 发到 gh-pages，
  //   学员拿到没有任何用途（里面有 GH_TOKEN / gh-pages 分支名 / 固定仓库路径）。
  /^tools\/publish-package\.js$/,
  // 【2026-11-13 加·第十五批】第 133 轮加的截图工具。它 require('playwright')，
  //   而 xianyu-achun 这个仓【没有 package.json】—— 学员机器上装了也跑不起来。
  //   它是维护者工具（把一页纸截成图贴群用），不该进包。
  /^tools\/shot-one-pager\.js$/,
  // 【2026-11-13 加·第十六批】第 136 轮实测：这两个进包之后，学员好奇跑一下会报红。
  //   regression-check.js —— 查的是「开发机上历史修复还在不在」，读的是源码和发布目录；
  //                          在包里跑 = 「31 通过 / 7 失败 · 有修复被覆盖了」，
  //                          学员看到会以为装坏了（实际什么都没坏，只是它查不到该查的东西）。
  //   scan-package.js     —— 要读 D:\xianyu-release 里的 zip，包里没有那个目录。
  // 这两个纯粹是维护者工具，学员一个都用不到。
  // （verify-student-view.js 和 _syntax-check-all.js 保留 —— 技术负责人拿到包后能复核；
  //   而且 verify 找不到包时会明确说「这个脚本是给技术负责人用的，不是学员工具」。）
  /^tools\/regression-check\.js$/,
  /^tools\/scan-package\.js$/,
  // 【2026-11-13 加·第十八批，第 138 轮】根层的一次性脚本。
  //   判据：包里 93 个根层 js，只有 32 个被【任何文档或代码】引用过；
  //   剩下 61 个连 require 都没有 —— 学员不可能用到，全是老板某次任务跑一遍就丢的。
  //   这里按前缀排；带具体明星/场次名的单独列（那是真·一次性）。
  /^(probe-artist-items|probe-budget-dom|probe-detail|probe-image-to-template|probe-item-location|probe-item-traffic|probe-more|probe-offshelf-btn|probe-personal|probe-items-traffic)\.js$/,
  /^(publish-3-quanzhou-xuliang|publish-quanzhou-xuliang|publish-stagger|publish-api)\.js$/,
  /^(test-guard-mismatch|test-guard|test-idfilter|test-rebid-gates)\.js$/,
  /^(check-3new|check-item-images|check-login)\.js$/,
  /^(gen-3-covers|gen-redtext-cover|gen-via-central)\.js$/,
  /^raise150-[\w]+\.js$/,
  /^(xy-scan|xy-snapshot-run|xy-store-data)\.js$/,
  /^(damai-probe|damai-scan)\.js$/,
  /^(diag-entity|diag-table)\.js$/,
  /^(im-conv-dump|im-today)\.js$/,
  /^(run-add-baby|run-on-console)\.js$/,
  /^(verify-item-via-agent|verify-publish-3)\.js$/,
  /^(bal-probe|clean-command-sheet|compare-new5|confirm-render|debug-status-filter)\.js$/,
  /^(dump-plan-items|find-plans|fix-dangling2|goto-manage|list-by-status)\.js$/,
  /^(make-cover-layers|push-redtext|read-msgs|restore-96129660|reveal-and-dump)\.js$/,
  /^(scan-buckets|set-bid|shot-items|sim-templates|stuck-plan|try-relist)\.js$/,
  // 【2026-11-13 加·第十九批，第 139 轮】skills/ 目录。
  //   第 113 轮 scan-package 扫到 skills/xianyu-reanchor/SKILL.md 里有 9 处真实 itemId；
  //   第 139 轮细看发现它是【老板的高级操作技巧】——「把已有浏览量的老链接重新锚定到
  //   新场次，吃掉它沉淀的检索权重」，属于业务方法论，还带店铺名和老板原话。
  //   这和「票务业务-交底书」是同一类东西，不该随包发给学员。
  /^skills\//,
  // 【2026-11-13 加·第二十批，第 139 轮】两个带经营数据的 md：
  //   上架审核流程-永久.md —— 老板 2026-10-10 原话 + 「深圳王者荣耀那批」的实测 itemId 与结果。
  //      （它讲的「-9 = 审核中」这件事，4 份学员文档里都写过了，排掉不损失信息。）
  //   主图参考-2026-10-11.md —— 老板 05:08 发的 10 张参考图清点 + 一整张场次投放表
  //      （南宁许嵩 / 贵阳王力宏 + itemId + 计划 id + 投放状态）。
  /^(上架审核流程-永久|主图参考-2026-10-11)\.md$/,
  // 【2026-11-13 加·第二十一批，第 139 轮】presets/ 里那个"从好易美导出"的原始样板。
  //   presets/ 有两个文件：
  //     代拍-标准.json            ← 学员要用的标准样板（向导读它），保留
  //     代拍-参考-从好易美导出.json ← 从老板店里导出的原始档（4 个真实 itemId + 店铺名 +
  //                                 publish-assets/好易美代拍/副图-第二组 这种本机路径），排掉
  //   文件名里就写着"从好易美导出"，一眼能看出来是原始档不是样板。
  /^presets\/代拍-参考-从好易美导出\.json$/,
  // 【2026-11-14 加·第二十二批，第 163 轮】make-covers.js —— 老板批量出主图的一次性脚本。
  //   判据（手册第二节⑦ 的三问）：
  //     ① 学员会打开它吗 —— 不会：9 份学员文档里一处没提
  //     ② 打开会困惑吗   —— 会：它 require(xianyu-playwright-service/node_modules/playwright)，
  //        而包里不带 node_modules，直接甩英文 Cannot find module
  //        （第 162 轮全包扫裸 require，只剩这一处）
  //     ③ 有内部信息吗   —— 有：文件头写着输出到 D:\DSH\achun\主图筛选-…
  //   它唯一的调用方 gen-redtext-cover.js 第 138 轮已经排掉，包里没人引用它。
  /^make-covers\.js$/,
  // 【2026-11-14 加·第二十三批，第 179 轮】根层的【没人读的测试/结果残留】。
  //   怎么发现的：把包解开列根层文件，85 个里有 29 个【没有任何文档、也没有任何代码提到】。
  //   其中这些是明确的垃圾：
  //     · {var              ← 文件名本身就是坏的（模板变量写漏到磁盘上），内容是一次
  //                           eval-on-store 调试的 AI 回复，还带着老板店名
  //     · *-result.json / *-task.xml / verify2~4.json / plan7test.json
  //                          ← 某次跑完留下的结果快照，没有脚本会读
  //     · pager.json(36B) / table.json(43B) / dangling-fix.json / find-ad-link.json
  //                          ← 空壳或一次性调试残留
  //     · GitLab注册流程-给潘春兴.md ← 内部文档，写着具体人名
  //   判据是「三问」：学员会打开吗（不会）/ 打开会困惑吗（会，一堆看不懂的 JSON）/
  //   有内部信息吗（有，老板店名 + 具体人名）。
  //   ⚠️ config.local.json.example 不在此列 —— 学员要复制它。
  /^(\{var|pager\.json|table\.json|verify[234]\.json|plan7test\.json|dangling-fix\.json|find-ad-link\.json|publish-\d+-[\w-]+-result\.json|publish-4groups-result\.json|publish-4groups-task\.xml|publish-batch-result\.json|wechat-messages\.json|GitLab注册流程-给潘春兴\.md)$/,
  // 【第 180 轮·第二十四批】上一批的延续：把「引用者本身也不在包里」的算清楚之后，
  //   又清出 12 个。判据是【引用者在不在包】：
  //     · im-keywords.json  ← 只有 im-today.js 读，而 im-today.js 不在包里
  //     · xy-scan-page.js   ← 只有 xy-scan.js 调，而 xy-scan.js 不在包里
  //     · 员工入口/文案模板定稿/闲鱼筛选规则 ← 只被「交付说明」「上架方案」这类
  //       内部文档提到，那几份自己也不在包里
  //     · bid-types/clickables/new-plan/order-fields.json ← 全仓没有任何 .js 按名字读
  //   ⚠️ 明确保留（别跟着删）：
  //     · PACKAGE-README.txt        ← make-release 自己要写它
  //     · config.local.json.example ← 学员要复制
  //     · 交付清单.md / 交付状态-*.md ← 【regression-check 会读】（L131 / L341）
  /^(im-keywords\.json|xy-scan-page\.js|代拍文案润色\.md|企微授权-点这里\.html|文案模板-改动记录-20260926\.md|员工入口-staff-使用说明\.md|文案模板-定稿\.md|闲鱼商品筛选规则-定稿\.md|bid-types\.json|clickables\.json|new-plan\.json|order-fields\.json)$/,
  // 【第 181 轮·第二十五批】另外两个仓的孤儿 —— excluded() 对三个仓【共用】（pack L505），
  //   所以这里写相对路径就能排到 playwright-service / monitor 里去。
  //   怎么发现的：把包解开，对每个仓的文件名在【全包文本】里数出现次数，
  //   只出现 1 次（=只有自己）就是没人提的。
  //   ⚠️ 保留：package-lock.json（npm install 要用）、两份 PACKAGE-README.txt（make-release 要写）
  //   ⚠️ 保留：批量发布模板.xlsx / xianyu-asset-spec.json（人工打开的模板和规格，没有代码引用是正常的）
  /^(damai-plan-list\.js|damai-recon\.js|probe-damai\.js)$/,                     // playwright-service 的大麦探测
  /^(ad_ledger\.py|CODE_REVIEW\.md|操作记录-[\d-]+\.md|闲鱼项目合体研究-完整报告\.md)$/,
  /^console-tools\/(capture-sku|dump-items|find-item-api|tmp-today)\.js$/,
  // 【第 211 轮·第二十六批】复查孤儿（第179–181 轮的方法重跑一遍，看新增变化）。
  //   判据：全包文本里【文件名只出现1 次】= 只有自己 = 没人读它。
  //   再核一层「学员会碰的文件（9 文档 + 根入口 + tools/）提没提」——
  //   8 个零提及 + shows.json（只在一句注释里被说「不用它」）。
  //   ⚠️ 保留（都查过）：
  //     · 工程纪律.md / 新店上架SOP-给员工和代理.md ← 一页纸「想更深入了解」列着
  //     · xianyu-商品索引.csv ← staff-ui/server.js L127 真的在读
  //     · config.local.json.example / PACKAGE-README.txt / 交付状态 ← 已知保留
  /^(check-client-decl\.mjs|final-check\.js|fix-live-titles\.js|probe-status-dom\.js|rebuild-publish-baseline\.js|unify-desc\.js|unify-live-desc\.js|verify-gen\.js|shows\.json)$/,
  // 【第 212 轮】wecom-sheet.js —— 老板往企微智能表格写日报/收指令的工具，
  //   它要调 ss-call.ps1，而那个 .ps1 被 ⑭ 排了（ALLOWED 里没有）——
  //   留着 .js 只会让 check-refs 报「指向的脚本不在包里」。
  //   学员文档一处没提（第 212 轮核过），不在 TOOLS_ALLOWED。
  /^wecom-sheet\.js$/,
  ];

  // ── tools/ 下的 .js 走【白名单】而不是黑名单 ──
  //   【2026-11-13 加·第十七批，第 137 轮】
  //   上面那 16 批规则全是「发现一个排一个」，而 tools/ 下藏着 103 个老板的一次性工具
  //   （probe-* 18 个、ad-* 11 个、fix-* 5 个、make-cover* 5 个、check-* 4 个、
  //    test-* 4 个、apply-* 3 个……），黑名单永远列不完。
  //   所以这里反过来：tools/ 下每个 .js 必须在下面的白名单里，不在就排掉。
  //   要加学员工具就往这个 Set 里加一行 —— 忘了加会被自检 ⑭之二 报出来。
  if (/^tools\/.+\.js$/.test(f)) {
    const sub = f.slice('tools/'.length);
    return !TOOLS_ALLOWED.has(sub);
  }

  return rules.some((r) => r.test(f));
}

/** tools/ 下允许进包的 js（学员会用到的） */
const TOOLS_ALLOWED = new Set([
  // 建店 / 配店
  'store-wizard.js', 'store-init.js', 'store-ready.js', 'store-login.js',
  '学员回报.js',   // 第242轮：真机验证一键收集回报（真机清单步骤10）
  'store-new.js', 'store-list.js', 'store-bulk.js', 'store-audit.js',
  'preset-export.js', 'install-config.js', 'install-tasks.js',
  'dump-store-config.js', 'print-paths.js',
  // 出图 / 文案
  'make-base-img.js', 'rebuild-covers-and-desc.js',
  // 【2026-11-14 第 161 轮加·回归修复】make-templates-from-example.js 必须进包：
  //   install.ps1 L438 会调它生成 ~/.xianyu-templates.json（文案模板库）。
  //   第 137 轮手写白名单时漏了它 → 包里没有 → 学员机上：
  //     install.ps1 报「缺 tools\make-templates-from-example.js —— 不影响发布」
  //     然后 first-publish.js 因为读不到模板库直接报「❌ 读不到文案模板」
  //   这是「装的时候看着没事、第一次发链接才炸」的那类问题。
  //   （.ps1 里的引用原来扫不到 —— check-refs 只扫 .js，第 161 轮把它也扫上。）
  'make-templates-from-example.js',
  // 上架 / 验证
  'first-publish.js', 'publish-group.js', 'verify-published.js',
  'probe-item-sku.js', 'set-item-sku.js',
  // 【2026-11-14 第 164 轮加·回归修复】agent-reset.js 必须进包：
  //   first-publish.js L130 拿它当「环境探针」跑（--help），
  //   第 137 轮手写白名单时漏了它 → 包里没有 → 每次发链接第一步都打
  //   「Error: Cannot find module '...tools\agent-reset.js'」。
  //   它本身也是有用的：让浏览器只保留当前运营的店铺，省内存。
  'agent-reset.js',
  // 【第 164 轮】first-publish L158 调它查大麦场次 —— 发链接的核心一步，
  //   漏了它 = 学员永远查不到场次。同批漏的还有 make-cover.js
  //   （rebuild-covers-and-desc.js L66 调它重出封面）。
  'damai-events.js', 'make-cover.js',
  // 推广
  'ad-plan-create.js', 'ad-status.js', 'ad-window.js', 'set-ad-hours.js',
  // 【2026-11-13 第 137 轮加】这两个在「学员装完该有的能力」自查表里（学员安装-给学员DSH.md L220/L223），
  //   学员真会用：list-onsale 看这家店有哪些链接，ad-review 看推广计划。
  //   第 137 轮改白名单时被漏掉，自检 ⑦ 组当场抓出来。
  'list-onsale.js', 'ad-review.js',
  // 【2026-11-13 第 137 轮加】这三个也是学员文档里明确教的：
  //   probe-mtop-apis.js  —— 「想知道闲鱼某个接口能不能做」自查表
  //   probe-event-dup.js  —— 「发布前先查重」，学员文档的红线第 6 条
  //   ad-set-bid-budget.js —— 「单次成本超 ¥4 就降出价」，错误速查里的处置方法
  //   （根层还有 16 个 probe-* 是老板的一次性探测脚本，不要一起放进来）
  'probe-mtop-apis.js', 'probe-event-dup.js', 'ad-set-bid-budget.js',
  // 体检 / 自检
  'healthcheck.js', 'selftest-lib.js',
  // 【2026-11-13 第 152 轮】selftest-update.js 不进包：
  //   它是【开发机的回归测试】—— 要 git（造源码仓 + clone 两台机器），
  //   还要 stores/好易美代拍.json（那是老板的店，打包规则早排掉了）。
  //   在学员机上跑必然炸在 ENOENT 上，而它验的「update.js 走 git 更新」
  //   本来就是学员用不了的那条路（第 151 轮）。
  //   留着只会让学员以为自己装坏了。
  'verify-student-view.js',      // 技术负责人可用（找不到包时会自己说明）
  '_syntax-check-all.js',        // 被 verify 调用
  // 更新 / 编码 / 工具
  'update.js', 'utf8-check.js', 'scrub-secrets.js', 'today.js',
  // staff-ui 自己
  'staff-ui/server.js', 'staff-ui/start.js',
  // 【2026-11-13 第 140 轮加】staff-ui/server.js 会【真的执行】这三个，第 137 轮白名单漏了：
  //   ensure-agent.js —— /api/warmup「预热」按钮
  //   ad-power.js     —— 开/关推广
  //   apply-item.js   —— 应用商品改动
  // 查法：扫所有 js 里 'tools/xxx.js' 这类字符串，看它在不在白名单（见回归第 140 项）。
  'ensure-agent.js', 'ad-power.js', 'apply-item.js',
]);

/**
 * 手机号检测 —— 必须带【数字边界】。
 *
 * ⚠️ 第一版我写的是 `1[3-9]\d{9}`（不带边界），结果在 70 个文件里报了 270 个"手机号" ——
 *   而那些几乎全是 13 位闲鱼 itemId 的前 11 位（正则从一个更长的数字里截了一段）。
 *   一个会在 70 个文件上狼来了的检查器，比没有检查器更糟（见 工程纪律.md 纪律二）。
 *   加上 (?<!\d) / (?!\d) 之后，真命中从 270 降到 6（4 个文件、2 个号码）。
 */
const PHONE_RE = /(?<![0-9])1[3-9][0-9]{9}(?![0-9])/g;

/**
 * 明显是假号的白名单 —— 否则"我把测试桩里的真号换成假号"这个动作本身会把发版卡住
 * （实测：换完立刻扫出 13800000001/13800000002 并拒绝产出）。假号必须放行，真号必须拦。
 */
const FAKE_PHONES = new Set(['13800000001', '13800000002', '13800000003', '13800138000']);
/** 自检用的号码在源码里【不许写成连续 11 位】——否则扫描器会把自己的源码当命中 */
const SELFTEST_PHONE = ['139', '1234', '5678'].join('');

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();

/**
 * 载入本机已知的真实【凭证】，用来扫包。
 *
 * ⚠️ 这里必须区分「凭证」和「端点」—— 第一版把 adminHost / supaUrl 也当密钥，
 *   结果 server.js 立刻"命中"，把发版整个卡住。那是假阳性：
 *   `https://xxx.supabase.co` 和后台主机名是【配置里的地址】，出现在代码里天经地义。
 *   假阳性比漏报更快毁掉一个检查器（参见 工程纪律.md 纪律二）。
 *
 * 判定规则：
 *   凭证  → 必须扫，命中就拒绝产出
 *   端点  → 不扫（URL/主机名）；除非 URL 里带 token/key 查询参数（那种 webhook 就是凭证）
 */
const ENDPOINT_KEYS = ['adminHost', 'supaUrl', 'base', 'host', 'url', 'apiBase', 'middleBase', 'smtpHost'];
const CREDENTIAL_KEYS = ['apiKey', 'hymKey', 'hymPass', 'hymUser', 'supaKey', 'SUPABASE_SERVICE_KEY',
  'tenant', 'key', 'chatId', 'webhook', 'feishuWebhook', 'password', 'passwd', 'secret', 'token'];

/** URL 里带 token/key/signature 这类查询参数 → 它本身就是凭证 */
function urlIsCredential(v) {
  return /^https?:\/\//i.test(v) && /[?&](key|token|secret|sign|signature|access_token|apikey)=/i.test(v);
}

function secretValues() {
  const vals = [];
  const add = (k, v) => {
    const s = String(v || '').trim();
    if (s.length < 8) return;
    const isUrl = /^https?:\/\//i.test(s);
    if (ENDPOINT_KEYS.some((e) => k === e) && !urlIsCredential(s)) return;   // 纯端点 → 不是凭证
    if (CREDENTIAL_KEYS.some((c) => k.toLowerCase().indexOf(c.toLowerCase()) >= 0)) { vals.push({ k, v: s }); return; }
    // 键名不认识时保守处理：URL 默认不算，其它算
    if (!isUrl) vals.push({ k, v: s });
  };
  const j = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return {}; } };
  const c = j(path.join(ACHUN, 'config.local.json'));
  Object.keys(c.service || {}).forEach((k) => add(k, c.service[k]));
  Object.keys(c.middle || {}).forEach((k) => add(k, c.middle[k]));
  Object.keys(c.wecom || {}).forEach((k) => add(k, c.wecom[k]));
  if (SVC_REPO) {
    const s = j(path.join(SVC_REPO, 'service.local.json'));
    Object.keys(s).forEach((k) => add(k, s[k]));
  }
  return vals;
}

/** 扫一个目录里的所有文本文件，返回命中（凭证 + 手机号） */
function scan(dir, secrets) {
  const hits = [];
  const walk = (d) => {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      const st = fs.statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      if (st.size > 4 * 1024 * 1024) continue;
      let buf;
      try { buf = fs.readFileSync(p); } catch (e) { continue; }
      if (buf.indexOf(0) >= 0) continue;                 // 二进制跳过
      const txt = buf.toString('utf8');
      const rel = path.relative(dir, p).replace(/\\/g, '/');
      secrets.forEach((s) => {
        if (txt.indexOf(s.v) >= 0) hits.push({ file: rel, key: s.k, secret: s.v.slice(0, 6) + '****' });
      });
      // 手机号：学员包里不该出现任何人的真实号码（明显假号放行，见 FAKE_PHONES）
      const phones = txt.match(PHONE_RE);
      if (phones) [...new Set(phones)].filter((ph) => !FAKE_PHONES.has(ph))
        .forEach((ph) => hits.push({ file: rel, key: '手机号', secret: ph.slice(0, 3) + '****' + ph.slice(7) }));
    }
  };
  walk(dir);
  return hits;
}

function pack(repoDir, name, secrets) {
  if (!fs.existsSync(repoDir)) { console.log('❌ 找不到仓库: ' + repoDir); return null; }
  let files;
  try { files = git(repoDir, ['ls-files', '-z']).split('\0').filter(Boolean); }
  catch (e) { console.log('❌ ' + repoDir + ' 不是 git 仓库（' + e.message.slice(0, 60) + '）'); return null; }

  const keep = files.filter((f) => !excluded(f) && fs.existsSync(path.join(repoDir, f)));
  const skipped = files.length - keep.length;

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  let head = 'nogit';
  try { head = git(repoDir, ['rev-parse', '--short', 'HEAD']); } catch (e) {}
  const version = stamp + '-' + head;
  const zipName = name + '-' + version + '.zip';

  console.log('\n════ ' + name + ' ════');
  console.log('  仓库      : ' + repoDir);
  console.log('  跟踪文件  : ' + files.length + '，打进包 ' + keep.length + '，排除 ' + skipped);
  const bytes = keep.reduce((s, f) => s + fs.statSync(path.join(repoDir, f)).size, 0);
  console.log('  原始体积  : ' + (bytes / 1048576).toFixed(1) + ' MB');

  // 【2026-11-13 加·第 150 轮】提示「有未提交的改动会进包」。
  //   为什么：本脚本按 `git ls-files` 列文件名，但【内容从磁盘读】（L464 copyFileSync），
  //   所以工作区里改了没提交的文件照样会进包，而 git 里查不到那版 —— 回滚只能靠人工。
  //   第 150 轮实测：update.js 的 --middle（中台更新，203 行）在包里、不在 git 里。
  //   这里只警告不改行为（打包还是要能跑）。
  try {
    const dirty = git(repoDir, ['diff', '--name-only']).split(/\r?\n/).filter(Boolean);
    const dirtyInPack = dirty.filter((f) => keep.includes(f.replace(/\\/g, '/')));
    if (dirtyInPack.length) {
      console.log('  ⚠️  未提交改动会进包: ' + dirtyInPack.length + ' 个');
      dirtyInPack.slice(0, 5).forEach((f) => console.log('        ' + f));
      if (dirtyInPack.length > 5) console.log('        …还有 ' + (dirtyInPack.length - 5) + ' 个');
      console.log('        （内容从磁盘读，git 里没有这一版 —— 要保底就先 commit）');
    }
  } catch (e) { /* 不是 git 仓就跳过 */ }

  if (LIST_ONLY) { keep.forEach((f) => console.log('    ' + f)); return null; }

  // ── 先在临时目录拼出来，扫过之后再打 zip ──
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xy-rel-'));
  const stage = path.join(tmp, name);
  keep.forEach((f) => {
    const dst = path.join(stage, f);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(repoDir, f), dst);
  });
  // 放一份「这个包是什么、怎么用」的说明在包根
  fs.writeFileSync(path.join(stage, 'PACKAGE-README.txt'),
    name + ' 代码包 ' + version + '\n' +
    '由 tools/make-release.js 生成；只含被 git 跟踪的代码文件，不含 .git、配置、素材、台账。\n' +
    '安装：解压到目标目录后跑 install.cmd（详见 给学员的一页说明.md）。\n', 'utf8');

  // ── version.json（需求书《中台需求-代码包分发与更新.md》§3.1 要点 5）──
  // 学员机靠它回答「我现在是哪一版」，tools/update.js --middle 会把 version 传给中台，
  // 中台比一下就直接回 upToDate（只传几百字节，不重复下 4MB）。
  // ⚠️ 格式必须是 { version, builtAt, commit }：update.js 的 readVersion() 读的是 .version。
  const builtAt = new Date().toISOString();
  fs.writeFileSync(path.join(stage, 'version.json'),
    JSON.stringify({ version, builtAt, commit: head, pack: name }, null, 2) + '\n', 'utf8');

  const hits = scan(stage, secrets);
  if (hits.length) {
    console.log('  ❌ 包里扫出 ' + hits.length + ' 处本机真实凭证 —— 拒绝产出：');
    hits.slice(0, 10).forEach((h) => console.log('       ' + h.file + '  ← ' + h.key + ' = ' + h.secret));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
    return { fail: true };
  }
  console.log('  ✅ 凭证扫描通过（拿本机 ' + secrets.length + ' 个真实凭证逐个文件查过）');

  fs.mkdirSync(OUT, { recursive: true });

  // 【2026-10-10 加】产出前先删掉【同一个仓的老版本】。
  //   为什么必须自动做：这个目录里躺两个版本时，选文件的一方（人也好、脚本也好）
  //   极容易拿错 —— 我自己验证时就被 Get-ChildItem -Filter 按名字排序选中了旧包，
  //   差点据此得出"包里还有手机号"的错结论。**同名多版本是发错文件的头号原因。**
  ['zip', 'zip.sha256', 'manifest.json'].forEach((ext) => {
    const suffix = '.' + ext;
    fs.readdirSync(OUT).forEach((f) => {
      if (f.startsWith(name + '-') && f.endsWith(suffix) && f !== zipName + suffix && !f.startsWith(zipName)) {
        try { fs.unlinkSync(path.join(OUT, f)); console.log('  🗑  清掉同仓旧版本: ' + f); } catch (e) {}
      }
    });
  });

  const zipPath = path.join(OUT, zipName);
  let zipped = false;
  try { execFileSync('tar', ['-a', '-c', '-f', zipPath, '-C', tmp, name], { stdio: 'ignore' }); zipped = true; }
  catch (e) {
    try {
      execFileSync('powershell', ['-NoProfile', '-Command',
        'Compress-Archive -Path "' + stage + '" -DestinationPath "' + zipPath + '" -Force'], { stdio: 'ignore' });
      zipped = true;
    } catch (e2) {}
  }
  if (!zipped) { console.log('  ❌ 压缩失败（tar 和 Compress-Archive 都不行）'); return { fail: true }; }

  const buf = fs.readFileSync(zipPath);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  fs.writeFileSync(zipPath + '.sha256', sha + '  ' + zipName + '\n', 'utf8');
  fs.writeFileSync(path.join(OUT, name + '-' + version + '.manifest.json'),
    JSON.stringify({ name, version, head, at: new Date().toISOString(), files: keep.length, excluded: skipped, bytes: buf.length, sha256: sha, list: keep }, null, 2), 'utf8');

  console.log('  ✅ ' + zipPath);
  console.log('     体积 ' + (buf.length / 1048576).toFixed(1) + ' MB   sha256 ' + sha.slice(0, 16) + '…');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  return { zipName, sha, bytes: buf.length, files: keep.length };
}

(async () => {
  // ── --selftest：给扫描器做阳性/阴性对照 ──
  //   为什么必须有：一个只会说"通过"的检查器等于没有检查器。
  //   而且第一版就是被假阳性卡住的（把 supaUrl 端点当成密钥）。所以两边都要验：
  //     阳性对照：把一个真凭证塞进临时文件 → 必须被抓到
  //     阴性对照：端点 URL / 主机名 → 必须不被抓
  if (ARGV.indexOf('--selftest') >= 0) {
    const secrets = secretValues();
    if (!secrets.length) { console.log('❌ 本机读不到任何凭证，自检无从谈起'); process.exit(2); }
    const real = secrets[0];
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xy-scan-'));
    fs.writeFileSync(path.join(tmp, 'hit.js'), 'const k = "' + real.v + '";\n', 'utf8');
    fs.writeFileSync(path.join(tmp, 'endpoint.js'), 'const u = "https://abcdefg.supabase.co";\nconst h = "admin.example.com";\n', 'utf8');
    // 手机号对照：真号必须抓到；13 位 itemId 必须【不】抓（第一版就在这里狼来了 270 次）
    fs.writeFileSync(path.join(tmp, 'phone.js'), 'const p = "' + SELFTEST_PHONE + '";\n', 'utf8');
    fs.writeFileSync(path.join(tmp, 'itemid.js'), 'const id = "1788450123456";\nconst id2 = "1089153350454";\n', 'utf8');
    const hits = scan(tmp, secrets);
    const caughtReal = hits.some((h) => h.file === 'hit.js');
    const flaggedEndpoint = hits.some((h) => h.file === 'endpoint.js');
    const caughtPhone = hits.some((h) => h.file === 'phone.js' && h.key === '手机号');
    const flaggedItemId = hits.some((h) => h.file === 'itemid.js');
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
    console.log('扫描器自检（本机 ' + secrets.length + ' 个凭证）');
    console.log('  ' + (caughtReal ? '✅' : '❌') + ' 阳性对照：真凭证被塞进文件 → ' + (caughtReal ? '抓到了' : '【漏报！扫描器是坏的】'));
    console.log('  ' + (!flaggedEndpoint ? '✅' : '❌') + ' 阴性对照：端点 URL / 主机名 → ' + (!flaggedEndpoint ? '正确忽略' : '【假阳性！会无谓卡住发版】'));
    console.log('  ' + (caughtPhone ? '✅' : '❌') + ' 手机号对照：11 位真号 → ' + (caughtPhone ? '抓到了' : '【漏报】'));
    console.log('  ' + (!flaggedItemId ? '✅' : '❌') + ' 手机号反例：13 位 itemId → ' + (!flaggedItemId ? '正确忽略（带数字边界）' : '【假阳性！itemId 被当成手机号】'));
    process.exit(caughtReal && !flaggedEndpoint && caughtPhone && !flaggedItemId ? 0 : 1);
  }

  console.log('输出目录 : ' + OUT);
  const secrets = secretValues();
  console.log('本机凭证 : 载入 ' + secrets.length + ' 个用于扫描');

  const jobs = [];
  if (!ONLY || ONLY === 'achun') jobs.push([ACHUN, 'xianyu-achun']);
  if ((!ONLY || ONLY === 'service') && SVC_REPO) jobs.push([SVC_REPO, 'xianyu-playwright-service']);
  // 【2026-10-10 加】xianyu-monitor 是【第三个仓】，而且不是可选的：
  //   playwright-service 的 server.js/agent.js 运行时要读它（MONITOR_DIR 静态目录、
  //   EXTENSION_PATH 注入脚本、native_host.py），缺文件时是 if(!exists) continue 静默跳过 ——
  //   学员机上「界面能开、/health 正常，但发布和广告全都不工作且零报错」就是缺这个仓造成的。
  //   吴卫龙的 agent 自己也点出来了：「找发件人要 xianyu-monitor」。
  if ((!ONLY || ONLY === 'monitor') && MON_REPO) jobs.push([MON_REPO, 'xianyu-monitor']);
  if (!jobs.length) { console.log('❌ 没有可打的仓（--only 写错了？或 playwright-service 路径解析不到）'); process.exit(2); }

  const results = jobs.map(([d, n]) => pack(d, n, secrets));
  const failed = results.filter((r) => !r || r.fail);
  if (failed.length) {
    if (LIST_ONLY) process.exit(0);
    console.log('\n❌ 有 ' + failed.length + '/' + results.length + ' 个包没打成（或扫出凭证）—— 不要发出去');
    process.exit(1);
  }

  console.log('\n════ 可以发的包 ════');
  results.forEach((r) => console.log('  ' + r.zipName + '   ' + (r.bytes / 1048576).toFixed(1) + ' MB   ' + r.files + ' 文件'));
  // 【第 221 轮加】自动清旧包：只留最近 10 个。
  //   为什么不手动：第220 轮查发现 D:\xianyu-release 已经积到 132 个 zip（约 120 MB），
  //   全是每轮打包留下的。不清理会一直涨，而且 publish-package 每次都要把
  //   130+ 个文件名打印一遍（第220 轮实测输出里全是「旧: …」）。
  try {
    const KEEP = 10;
    const zips = fs.readdirSync(OUT)
      .filter((f) => /^xianyu-install-.*\.zip$/.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(OUT, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    const drop = zips.slice(KEEP);
    if (drop.length) {
      for (const d of drop) {
        for (const suf of ['', '.sha256', '.checks.json']) {
          try { fs.rmSync(path.join(OUT, d.f + suf), { force: true }); } catch (e) { /* 忽略 */ }
        }
      }
      console.log('  清了 ' + drop.length + ' 个旧包（保留最近 ' + KEEP + ' 个）');
    }
  } catch (e) { console.log('  · 旧包清理跳过: ' + e.message); }

  console.log('  sha256 都在同目录的 .sha256 里 —— 发的时候一起带上，让学员那边校验。');
  console.log('\n⚠️ 这个包【不含】.git，所以学员拿不到含密钥的历史；');
  console.log('   但也因此不能用 git 更新 —— 更新走 node tools/update.js --from=<新包URL> 或重新发包覆盖。');
})().catch((e) => { console.log('❌ ' + (e && e.stack || e)); process.exit(1); });
