---
name: xianyu-reanchor
description: |
  把一条【已有浏览量的闲鱼老链接】重新锚定到新场次，而不是从零发新链接。
  itemId 不动、分类不动、价格不动、规格不动，只换标题 / 正文 / 主图 / 所在地，
  吃掉它已经沉淀的检索权重、人群标签和评价。
  输入：新场次（城市 + 主体 + 活动类型 + 场次类型）+ 一张官方海报；输出：一条历史权重不丢的在场链接。
  触发场景：要把已过场的老链接换成本期新场次、手上有一批高浏览但卖不动的链接、
  想知道「闲鱼老链接能不能改成别的演出」、新链接冷启动太慢想借老链接权重、
  要按浏览量挑一条链接做改造。包含「按浏览量选链接」的取数方法与实测踩坑清单。
  关键词：重锚 / reanchor / 老链接改造 / 老链接替换 / 替换老链接 / 链接复用 /
  权重继承 / 闲鱼换品 / 换宝贝 / 老链接改成新场次 / 按浏览量选链接
metadata:
  author: achun
  version: "1.0.0"
  license: MIT
---

# xianyu-reanchor（重锚）— 闲鱼老链接权重迁移

> **一句话定义**：把一条已有浏览量的死链接，重新锚定到新场次上。
> `itemId` 不动、分类不动、价格不动、规格不动 —— 只换它"说什么"，不换它"是谁"。

---

## 一、这个名字为什么叫「重锚」

来自 GEO（Generative Engine Optimization）的第一性原则：**实体一致性**。

GEO 的判据是：同一个东西如果在不同地方有三套措辞，检索系统认不成同一个实体，只能各自降权。
所以 GEO 的第一根杠杆不是"多发内容"，而是"先把已有实体的表述统一"——
**存量资产优先于新建资产**。

闲鱼链接就是同一个道理，只是层级更低：

| GEO 世界 | 闲鱼世界 |
|---|---|
| 页面被检索系统收录、有排序权重 | 链接被平台收录、有搜索词沉淀 / 人群标签 / 评价 / DSR |
| 新建页面 = 新实体 = 从零建立信任 | 新发链接 = 冷启动，先晒几天再说 |
| 改已有页面的表述 = 实体不变、语义更新 | **改老链接 = itemId 不变、语义换新** |

「重锚」= **不换实体，只换锚点**（anchor）。
把这条链接的语义锚从「深圳奇妙夜」挪到「广州守望先锋」，它带着原有的人群标签和曝光权重过去。

这不是"换宝贝"那种灰操作 —— 换宝贝稽查盯的是**类目 / 价格 / 品牌 / 属性**的突变，
这四样一个都不碰，改的是标题、正文、主图，属于正常商品运营。

---

## 二、什么时候用 / 什么时候别用

### ✅ 用

- 老场次已经演完，链接还在售、还有浏览量 → 改成新场次
- 手上有一批高浏览但零成交的链接（万能话术链接、「专业团队接各种演出」这类）
- 新场次开票前要快速铺量，等不起新链接冷启动
- 同一主体要铺多条链接，需要靠老链接分摊权重

### ⛔ 先过这道闸：这条链接"能不能动"

**这是本 skill 最容易犯的错，2026-11-12 已经栽过一次。**

我按浏览量把 `1067404891764`（9435 浏览，排名第一）改成了王嘉尔场次。
它其实是店里**卖得最好的主力链接之一**——`xianyu-商品索引.csv` 里记着：
**33561 曝光 / 26 笔成交 / ¥21523.95 成交额**。
老板的原话：**「你改造老链接，不能拿我正在上架的链接改啊」**。

改之前必须按下面三列同时看，**任何一列命中就不能动**：

| 判据 | 数据在哪 | 命中即禁改 |
|---|---|---|
| 有成交 | `xianyu-商品索引.csv` 的「支付额」列 | 支付额 > 0 |
| 高曝光 | 同上「曝光」列 / `node tools/item-traffic.js` | 浏览 > 5000 |
| 正在投推广 | `node tools/ad-status.js` | 出现在任何在投计划里 |

**只有「已过场 + 零成交 + 非在投」三个条件同时满足，才是可重锚的链接。**

这才是"老链接"的定义：**已经死掉、但权重还在的链接**。
不是"看起来旧"、更不是"浏览量最高的那条"。

本次实操的正例：`1091514912987`（原广州徐良超强捡漏）——已过场、零成交，重锚成守望先锋 ✅
反例：`1067404891764`——主力在售，被误改，靠同款链接的正文才勉强恢复（原文 2480 字永久丢失）❌

### ❌ 别用

- 新场次和原场次**类目不同**（例：演唱会 → 实物商品）→ 类目变了就是换宝贝，高危
- 原链接**已经下架**（`status=1`）**不是死路** —— 实测 `idleitem.edit` 会让它重新走审核并**自动上架**。
  2026-11-12 验证：`1046802550739` 原为已下架，改造完成后 `list-onsale` 直接显示 🟢 在售，
  已下架数 31 → 30。所以「从下架的链接里挑」是完全可行的路线，而且比动在售主力安全得多。
  先看 `node tools/list-onsale.js`，只在 **在售(status=0)** 里挑
- 原链接是**主推爆款**（日花费高、正在出单）→ 改了等于自断流量
- 平台侧商品还在**审核中**（`status=-9`）→ 先等过审，改也白改

---

## 三、流程（四步，全部有命令）

### 第 1 步 · 挑一条「已死的链接」（不是挑浏览量最高的）

```powershell
node tools/item-traffic.js --top=10      # 拿浏览/想要
node tools/ad-status.js                  # 看哪些在投推广
```

然后**逐个过第三节那道闸**：已过场 + 零成交 + 非在投，三条同时满足才能动。

想按成交额筛，读 `xianyu-商品索引.csv`（列：序号 / itemId / 状态 / 标题 / 价格 / 想要 / 曝光 / 成交 / 支付额 / 广告元）。

```powershell
# 只想要「支付额为 0」的：直接筛这一列
Import-Csv "xianyu-商品索引.csv" -Encoding UTF8 | Where-Object { $_.支付额 -eq '0' -or $_.支付额 -eq '' }
```

⚠️ 这份 CSV 是历史快照，可能过期；**成交额 > 0 的必须先排除，宁可少改一条，也别动主力**。

### 第 2 步 · 出主图（必须带店铺现役版式）

```powershell
$env:KUN_EVENT="演唱会"          # 或 见面会 / 音乐节 / 全球总决赛…
$env:KUN_MAIN_TPL="__shoukai"    # 或 xuliang-v1 / tpl_redtext / hmd_yellow_3red
node publish-one.js 广州 王嘉尔 首开 --dry
```

- 明星类：不传 `KUN_BASE_IMG`，服务端会去**大麦自动抓官方海报**（`baseOrigin=damai`）
- 电竞赛事等大麦搜不到的：`$env:KUN_BASE_IMG="<自备海报>.jpg"`
- ⛔ **不许用 `KUN_MAIN_IMG` 直出成品图绕过版式** —— `publish-one.js` 会直接报错拦住
  （老板定的规矩：主图必须带现役版式，见 `主图规范-好易美代拍-定稿.md`）

### 第 3 步 · 改链接（一次 edit 全改完）

```powershell
node tools/apply-item.js <itemId> `
  --main="D:\...\publish-out\广州-王嘉尔-__shoukai-xxx.jpg" `
  --title="【高命中代拍】王嘉尔广州站演唱会首开门票代拍帮抢 高命中率！" `
  --descFile="D:\...\desc\王嘉尔-B-模板3帮抢.txt" `
  --addrCity=广州 `
  --go
```

不加 `--go` 只预览：会打印标题字数、正文全文、主图路径、**所在地改前→改后**，并自动备份。

要点：

| 参数 | 作用 | 注意 |
|---|---|---|
| `--title` | 新标题 | **硬上限 30 字**，超了平台从尾部静默砍；用 `lib/title.js` 先算 |
| `--descFile` | 正文文件（UTF-8） | 第一行会被当卡片标题，所以正文里别重复标题 |
| `--main` | 新主图 | 走 `/api/agent/upload-image`，自动设成 `major` |
| `--addrCity` | 把所在地改到该城市 | **外地老链接必用**，否则标题写广州、所在地还是长沙 |
| `--main-only` | 只换主图 | 标题/正文保持线上原样 |

### 第 4 步 · 验收

```powershell
node tools/list-onsale.js --ids=<itemId>     # 在售？还是 -9 审核中
node tools/cat-audit.js                      # 分类是否被改坏
```

**唯一权威判据是在售清单**。商品页显示「已删除」不等于被删，是没过审 ——
清单里没有就**先等，别补发**（补发会变成两条重复链接）。

---

## 四、真接口（这行最容易踩死）

```
改已发布商品 = mtop.idle.pc.idleitem.edit     ← 真的
              mtop.idle.pc.idleitem.update   ← 不存在，任何 PC 上下文都 ABORT
```

`mtop.idle.pc.idleitem.update` 在 PC 侧**根本不存在** ——
最小化实测（只传 itemId → 全字段回填，7 级）每一级都是 `ABORT::接口异常退出`。
仓库里老的 `fix-item.js` 一直用 update，所以它从来没真正跑通过。

`edit` 需要 **publish 那套完整 payload + itemId**：

```js
{ itemId, freebies:false, itemTypeStr:'b', quantity, simpleItem:'true',
  imageInfoDOList, itemTextDTO, itemLabelExtList, itemPriceDTO:{}, defaultPrice:false,
  itemSkuList, itemAddrDTO, userRightsProtocols, itemPostFeeDTO, itemCatDTO,
  uniqueCode, sourceId:'pcMainPublish', bizcode:'pcMainPublish', publishScene:'pcMainPublish' }
```

排错口诀：

| 返回 | 含义 |
|---|---|
| `ABORT::接口异常退出` | 接口不存在 / 不可用 → 换接口名 |
| `FAIL_BIZ_ITEM_NO_PICS::没有设置图片` | 接口对了，缺 imageInfoDOList |
| `FAIL_BIZ_IDLEITEM_UNKNOWN_THROWABLE::发布失败，请稍后重试吧!` | 接口对了，参数不全 |
| `FAIL_BIZ_UN_CATCH_EXCEPTION::闲鱼太累啦～请您稍候重试～` | **不一定是限流**，先看下面第 5 节的 SKU 坑 |
| `FAIL_BIZ_USER_ERROR_USER_WAS_FORBIDDEN2::闲鱼发布权限被限制` | 账号级写权限被锁，代码无解 |

---

## 五、六个实测坑（每个都栽过）

### 坑 0 · 动了正在出单的主力链接（最贵的一个）

按浏览量把 `1067404891764` 当成"老链接"改了，它其实是 26 笔成交 / ¥21523.95 的主力。
**原正文 2480 字没有备份，永久丢失**，最后只能借同款链接的 270 字话术恢复。

两条补救已落地：
- `tools/apply-item.js` 现在**动线上之前无条件写备份**到 `replace-backup/<itemId>-<时间戳>.json`
- 本 skill 第三节加了「已过场 + 零成交 + 非在投」三重闸

**教训**：浏览高 ≠ 可改。浏览高恰恰说明它是活的。

### 坑 1 · 无规格商品不能按有规格发

老链接可能是**单一口价、没有 SKU**（`editdetail` 的 `itemSkuList` 长度为 0）。
这时传 `itemSkuList: []` + `itemPriceDTO: {}` 会被判定「声明要规格却没给规格」，
报 `闲鱼太累啦～`，看着像限流，等多久都没用。

```js
const hasSku = Array.isArray(cur.sku) && cur.sku.length > 0;
const priceDTO = hasSku ? {} : (cur.price || { priceInCent: '5000' });
if (hasSku) carry.itemSkuList = cur.sku;   // 只有真有规格才带
```

### 坑 2 · 改完不要马上开推广

商品被 edit 后，广告侧会认为「部分商品因状态异常无法擦亮」，
此时建计划能成功、但 `pauseStatus` 拨不上去，`ad-power on` 返回 SUCCESS 却校验不过。

正确顺序：**改商品 → 等审核通过（在售清单能看到）→ 再开推广**。通常 30–60 分钟。

### 坑 3 · 所在地只改区划会留下旧 POI 名

构造 `itemAddrDTO` 时只覆盖 `prov/city/area/divisionId/gps`，
平台会把原来的 `poiName / poiId / aoiId` 带过来（例：广州番禺区 + 「长沙站」）。
买家看到的所在地以区划为准，影响小，但下次动它时顺手清掉：`poiName: ''`、`poiId: ''`。

### 坑 4 · 标题 30 字是硬上限

平台对超过 30 字的部分**从尾部静默砍掉**，发出去看不见，只有回读才发现。
先用 `lib/title.js` 的 `makeFitTitle` 算好；补位若只剩 1–2 个字符，
宁可选别的模板组合，也别留一串「！！」。

⚠️ **模板正文有重复**：模板1 ≡ 模板2、模板3 ≡ 模板4。
想让多条链接正文不同，必须跨组选（1/2 × 3/4 × 5）。

### 坑 5 · 改造 ≠ 换宝贝（四项敏感字段别碰）

平台稽查「换宝贝」盯的是**类目 / 价格 / 品牌 / 属性**的突变。
`apply-item.js` 只改 `itemTextDTO` 和 `imageInfoDOList`（外加可选的 `itemAddrDTO`），
其余字段全部从 `editdetail` 原值回填，一个值都不改。**别为了"统一"顺手改价格或规格。**

---

## 六、一次完整的实证（2026-11-12）

| | 广州守望先锋 | 广州王嘉尔 |
|---|---|---|
| 新发链接 | `1097491887563` | `1098444018224` |
| 重锚老链接 | `1091514912987`（原：广州徐良超强捡漏） | `1067404891764`（原：专业团队接各种演出，**9435 浏览**）|
| 老链接所在地 | 广州海珠区（本来就是广州，不动） | 长沙芙蓉区 → **广州番禺区** |
| 分类 | 演出票代拍/202285710 | 演出票代拍/202285710（不动） |
| 价格 | ¥50 ×9996（不动） | ¥45 一口价（不动，见坑 1） |

结果：两条重锚链接当场在售；两条新发链接进入审核（-9），过一段时间自行过审。

---

### 坑 6 · 老链接多半不是「演出票代拍」分类，而且带着不兼容的服务承诺

apply-item 默认不碰分类，所以下架老链接改完可能仍是「代购/201456914」。
而留资卡要求本地服务类（演出票代拍），广告计划的 catId 也要跟商品一致 —— 必须一起改：

```powershell
node tools/apply-item.js <itemId> ... --useStoreCat --go
```

`--useStoreCat` 会按 `stores/<店铺>.json` 的分类覆盖 `itemCatDTO` + `itemLabelExtList`。

⚠️ 但只改分类会撞另一个错：

```
FAIL_BIZ_ITEM_CONDITION_NOT_SUPPORT_SIGN::未开通服务或当前品类不支持开通服务
```

原因是老链接带着一堆服务承诺（`NONCONFORMITY_FREE_REFUND` / `SEVEN_DAY_REFUND` /
`VIRTUAL_NONCONFORMITY_FREE_REFUND_SERVICE` …），新品类不支持。
`--useStoreCat` 已经一并把 `userRightsProtocols` 清回基座
（`[{serviceCode:'SKILL_PLAY_NO_MIND', enable:'false'}]`，与店铺档案「承诺全不勾」一致）。

## 七、配套文件

| 文件 | 作用 |
|---|---|
| `tools/item-traffic.js` | 按浏览量给在售链接排序（选链接的第一步） |
| `tools/apply-item.js` | 按给定内容重写已发布商品（主图/标题/正文/所在地） |
| `tools/replace-item.js` | 按模板自动推导标题正文并重写（含 `--main-only` 只换图、`--subs=<目录>` 整组换副图、`--addr-city=<城市>` 顺带改所在地，**一次 edit 改全**） |
| `tools/set-item-addr.js` | 只改所在地（不动标题/图/类目/规格） |
| `tools/make-subimgs.js` | 出本店口径副图（场次信息/可信承诺/贴纸，参数化：`--title --date --venue --platform`） |
| `tools/cat-audit.js` | 逐条查真实分类，核对改造有没有动坏类目 |
| `tools/ad-power.js` | 单计划开关（重锚完要不要挂推广） |
| `lib/title.js` | 30 字硬上限与补位的唯一实现 |
| `stores/<店铺>.json` | 分类 / 规格 / 价格 / 主图池 / 推广 9 项的唯一配置出口 |

### 七点一、一次 edit 改全（2026-11-13 实测省一半往返）

老链接换场次经常要连改四五样：标题、主图、副图、所在地、补规格。
**分成多次 edit = 多轮审核 + 多次模型往返**。现在 `replace-item.js` 一次全带：

```powershell
node tools/replace-item.js <itemId> 深圳 王琳凯 演唱会 首开 `
  --tpl=3 --main="<新主图>" --subs="publish-assets/<店>/副图" --addr-city=深圳 --go
```

- `--subs` 会把副图整组替换（不给就保留线上原样）
- `--addr-city` 顺带把 `itemAddrDTO` 改到该城市（区池见 `lib/city-areas.json`）
- 无规格老链接会自动补一档规格（否则编辑接口回 `FAIL_BIZ_UN_...闲鱼太累啦～`）
- 回读校验：标题一致 / 主图尺寸 / 副图张数 / 规格 / 所在地
