# 京东平台特性与采集技术笔记（研究沉淀）

> 这份文档是**对京东平台本身**的研究记录：它前端怎么渲染、反爬怎么分层、验证怎么触发、
> 数据怎么造假（空壳页），以及我们为了在这些真实约束下把数据稳定拿到，在代码里做了什么。
>
> 它不是"今天改了哪个 bug"的工程流水账——工程侧的缺陷治理、健壮性修复见
> [`ROBUSTNESS.md`](./ROBUSTNESS.md)。反爬的**认知方法论**见 [`ANTI_SCRAPING.md`](./ANTI_SCRAPING.md)。
> 本文档是二者的"代码实证层"：把京东平台的每一个特性，落到 `scripts/jd_product_detail.py`、
> `jdcrawler/settings.py`、`jdcrawler/spiders/jdproduct.py` 的具体实现上。
>
> 所有结论均来自真实调试与代码，未实现的"能力"一律不写。

---

## 一、京东前端渲染结构：详情页是"运行时拼装"的

京东商品详情页**不是**一份静态 HTML。标题、价格、参数、评论、详情图，大部分在浏览器里由
JS 运行时拼装。这决定了"无头 HTTP 拿到的 HTML"和"人看到的页面"是两回事。

### 1.1 详情图是 `background-image` 懒加载，不是 `<img>`

这是踩得最狠的一个点。京东详情图（sku 图文详情）以 CSS `background-image`
形式挂在 `div.ssd-module` 这类容器上，**不是标准的 `<img>` 标签**，URL 形如
`//img30.360buyimg.com/sku/jfs/t1/.../xxx.jpg.avif`。

- 提取逻辑：`_extract_detail_images_by_js()`（`scripts/jd_product_detail.py:1215`）
  遍历 `document.querySelectorAll('*')`，读 `getComputedStyle(el).backgroundImage`，
  只收 `/sku/jfs/` 路径、命中 `360buyimg` 的图，并对已见 URL 去重。
- **关键坑**：`background-image` 是视口驱动的——元素进入视口附近浏览器才去请求真实图。
  原逻辑用 `scrollTo(0, 1.0*height)` 瞬跳到页尾，中间大段区域从没进视口，懒加载没触发，
  `background-image` 一直是占位符，提取结果直接是 **0 张**。
- 解法：`_slow_scroll_to_load()`（`scripts/jd_product_detail.py:1297`）逐屏平滑滚动，
  每屏停 `scroll_pause`（默认 0.8s），每步重读 `scrollHeight`（懒加载会让页面变长，
  目标跟着下沉），**高度连续 2 轮稳定**才判定到底。`run()` 在提图前调用它
  （`scripts/jd_product_detail.py:2148`）。

> 这条直接对应 README「技术难点」第 2 条，也是京东"图文详情区前端懒加载"特性的实证。

### 1.2 参数/规格区 DOM 要点标签才渲染

商品页的"规格参数"并非默认展开。实测发现需先点击"店铺"类标签，参数区对应的 DOM 才会挂载。
`run()` 在提取前主动点击（`:2126`）：

```python
# 点击"店铺"标签加载参数区域
var tabs = document.querySelectorAll('.left-tabs-title li, [class*="tab"] li, ...');
for (...) { if (tabs[i].textContent.trim() === '店铺') { tabs[i].click(); break; } }
```

若不点，参数表抽取会得到空——这是京东"按需挂载 DOM"的典型做法。

### 1.3 评论区是虚拟滚动 + 图片懒加载

京东评论列表（实测 DOM 结构，`_extract_comments_via_page()`，`:1355`）：

- 评论装在独立滚动容器 `[class*="rateListContainer"]`（`overflow:auto`，`scrollHeight` 动态增长）；
- 卡片 `.jdc-pc-rate-card`，字段分布在 `.jdc-pc-rate-card-nick / -main-desc / -user` 等子节点；
- **虚拟滚动**：滚出视口的卡片 DOM 会被回收，不能"滚到底再一把抓"，必须**边滚边提**；
- 评论图片用 `data-src` / `data-lazy-src` / `data-original` 懒加载，需手动把真实 URL 写回 `src`。

策略就是"容器内 `scrollTop += 500` + 停顿 + 触发 `scroll` 事件 + 回填 `data-*` → 即时提取"。
这正是京东"长列表虚拟滚动"特性逼出来的写法。

### 1.4 核心字段靠前端填充，必须进浏览器取

标题（`.sku-name`）、价格等核心字段由前端 JS 写入 DOM，`run()` 用 15 轮轮询等
`.sku-name` 的 `h1` 出现（`:2104`）才认为页面真加载完。若最终 `_extract_all_by_js()`
返回空，直接 `return None`（`:2141`），不让上层生成"假商品"。

> 4.1–4.4 共同说明一件事：**京东详情页的价值数据，只在真实浏览器渲染后才存在**——
> 这是后面"必须上真实浏览器内核"的根本理由。

---

## 二、京东反爬是分层的：列表页 ≠ 详情页

京东的防护按页面类型分两级，这是整套双轨架构的出发点。

### 2.1 列表 / 分类页：协议层防护

列表页主要靠**请求频率、UA、基础 headers** 过滤。Scrapy 配合理的请求编排就能稳定拿 SKU 链接：

- `jdcrawler/settings.py:12` `CONCURRENT_REQUESTS = 1`、`:13` `CONCURRENT_REQUESTS_PER_DOMAIN = 1`
- `:17` `DOWNLOAD_DELAY = 4`（`:18` `RANDOMIZE_DOWNLOAD_DELAY = True` 抖动）
- `:21` `DEFAULT_REQUEST_HEADERS` 带 `Referer: https://search.jd.com/`、`zh-CN` 语言、真实 UA

### 2.2 详情页：行为层防护（运行时指纹 + 验证）

详情页进入另一层级——JS 运行时指纹、验证码、登录态信任分。无头 HTTP 客户端在这些维度上
"一眼假"，要么空数据、要么秒验证。因此详情采集必须用真实浏览器内核：

- `_init_browser()`（`scripts/jd_product_detail.py:113`）用 DrissionPage 的 `ChromiumPage`；
- 通过 `EDGE_ADDRESS = "127.0.0.1:9222"`（`settings.py:56`）**接入本地已登录的 Chromium 调试端口**，
  直接复用你的 cookie 与"信任分"——而不是伪造一个干净会话。

### 2.3 结论：双轨不是冗余，是分层最优解

列表用 Scrapy（协议层、廉价），详情用 DrissionPage（行为层、昂贵），两轨只靠
`product_links.detail_status` 一个字段握手。这是京东"防护分级"直接逼出的架构。

---

## 三、运行时指纹检测：无头即死

京东会检测 `webdriver`、自动化特征、无头模式。`_init_browser()` 在 `enable_anti_detect`
下做反检测（`scripts/jd_product_detail.py:126` 起）：

- 注入 JS 把 `navigator.webdriver` 改为 `undefined`（`:152`），伪装 `navigator.plugins`
  成真实 Chrome 插件列表；
- 启动参数：`--disable-blink-features=AutomationControlled`、`--window-size=1920,1080`、
  `--lang=zh-CN`、时区 `--timezone=Asia/Shanghai`、地理 `--geolocation=39.9042,116.4074`（北京）；
- **刻意不加 `--headless`**：代码注释明确写着"京东会检测无头模式"——无头即触发风控。

> 认知：在京东场景下，"协议层伪装 / 无头方案"在详情页必然失败，真实内核是唯一可行解。
> 这点在 `ANTI_SCRAPING.md` 3.2 有方法论展开。

---

## 四、验证拦截与 403 重定向：检测到就让人

### 4.1 京东怎么拦：验证码 + 403 跳首页

详情页高频触发两类拦截：

- **验证码 / 滑块**：`_check_for_verification()`（`:381`）按**强特征**判定——
  DOM 选择器 `.jdcrawlerJRV-slide` / `.slide-verify` / `#captcha` / `[class*="captcha"]`，
  标题含"安全验证/人机验证/滑块验证/captcha"等。先查强特征、再查标题，避免误报。
- **403 重定向**：`_check_page_redirected()`（`:361`）检测 URL 含 `reason=403`，
  或"本应访问 `item.jd.com` 却被跳回 `www.jd.com` 首页"。

### 4.2 403 时的绕行策略

被 403 不直接放弃，`run()`（`:2058`）先回首页、在搜索框填入 SKU、点搜索进商品页——
借"搜索入口"绕开"直接访问商品页"的拦截：

```python
self.page.get("https://www.jd.com")
# 在 #key / .search-input 填入 self.sku_id，dispatchEvent input/change
# 点击 .search-btn 提交搜索
```

若仍然被拦，才进入人工验证流程。

### 4.3 验证码：人工过码，不自动破解（诚实说明）

本项目**没有**自动滑块验证、验证码识别、打码或前端加密逆向。`_wait_for_manual_verification()`
（`:409`）的做法是：**检测到验证页 → 打印提示 → `input()` 暂停等人手动完成 → 重新校验**。

批量模式（`--db`）为防无人值守卡死，会强制不等待、跳过该商品；单 URL 模式默认等待。
这是"**验证破解成本远高于人力成本**"时的务实取舍——人留在回路最后一道，保证链路不丢数据，
而不是吹嘘"自动突破"。

---

## 五、节奏是最重要的一道防线

指纹伪装有价值，但**速率控制才是防封第一道**。京东对"快而规律"的请求极敏感：

- 列表轨：`DOWNLOAD_DELAY=4` 单并发（见 2.1）；
- 详情轨：`_random_delay(min_s=5, max_s=15)`（`:107`）做随机休眠；
  `run()` 访问商品页后 `sleep(random.uniform(10, 20))`（`:2056`），预热 `sleep(8,15)`（`:302`）；
- 拟人：`_warm_up()`（`:286`）先逛首页建 cookie、随机滚动 + 随机鼠标移动 + 模拟点分类；
  `_simulate_human_behavior()`（`:435`）进页后随机滚、发 `mousemove` 事件再滚回顶部。

认知：**"慢而稳"优于"快而封"**，盲目提并发只会自爆式触发风控。

---

## 六、会话与信任分：借用户环境，而非伪造

京东对**未登录、新会话**极不友好，验证触发率远高于常态登录用户。

- `_warm_up()`（`:286`）先访问 `https://www.jd.com` 建立 Cookie 与会话，模拟真人浏览轨迹，
  让京东"认为这是正常用户"；
- 通过 `EDGE_ADDRESS` 接入**你本地已登录的浏览器**（`:56` + `_init_browser`），继承其 cookie
  与信任分，显著降低验证率。

思路本质是"**借环境**"——复用真实登录态的信任分，而非伪造一个干净会话去硬刚风控。

---

## 七、数据真实性：HTTP 200 的空壳页

京东有时返回 **状态码正常、但内容为空壳**的页面（或悄悄重定向），若仅以状态码判成功，
会入库"标题/品牌为空"的假商品。`run()` 的处理（`scripts/jd_product_detail.py:2141`）：

```python
js_data = self._extract_all_by_js()
if not js_data:
    print("[错误] 核心数据提取失败（返回空），放弃本次爬取")
    return None          # 上层据此标记 detail_status=2，不生成残缺记录
```

配套：进页后 15 轮轮询等 `.sku-name` 的 `h1` 出现（`:2104`），确认真加载而非空壳。

> 认知：**数据真实性的校验必须做到内容级**，状态码在京东这里是不可信的。

---

## 八、字段结构不稳定：动态按表结构截断

京东不同品类的标题、参数长度/结构差异大，写死 VARCHAR 长度会 INSERT 报错或截断出错。
入库统一走 `scripts/product_persist.py`：

- `get_product_column_limits()`（`:121`）从 `INFORMATION_SCHEMA.COLUMNS` 读 `products` 表
  各 `VARCHAR/CHAR` 列的**实际长度上限**；
- `_truncate()`（`:150`）/`_truncate_text()`（`:161`）按上限截断并打"截断告警"日志，
  超长时显式提示信息可能丢失；
- 旧表补列用 `ensure_products_image_columns()`（`scripts/db_schema.py:139`），
  `INFORMATION_SCHEMA` 检测 + `ALTER TABLE` 幂等补列。

> 这是"京东字段不规范"这一平台特性，逼出的工程应对。

---

## 九、已知简化（如实标注，不夸大）

代码里有意保留的**占位/简化**点，文档必须诚实写明，不能当成"已采集的真实数据"：

- **销量、评论数、原价**当前为随机占位值：`scripts/jd_product_detail.py:2154`
  `sales = random.randint(1000, 500000)`、`comment_count = random.randint(100, 50000)`、
  `rating = round(random.uniform(4.0, 5.0), 1)`。注释标注"简化：使用随机值"。
  这些是演示字段，**非京东真实销量/评论数**；完整真实值需后续接入京东评论/价格接口补全。
- 验证码处理是人工过码（见第四节），非自动破解。

---

## 十、小结：一个月研究沉淀的京东认知

1. **详情页数据只在真实浏览器渲染后存在**，无头 HTTP 拿不到真值；
2. **反爬分级**：列表靠协议层（Scrapy + 降速即可），详情靠行为层（必须真实内核 + 登录态）；
3. **京东前端特性逼出特定写法**：`background-image` 懒加载要逐屏滚、虚拟滚动要边滚边提、
   参数区要点标签才挂载；
4. **验证与 403 是常态**：检测到就让人过码 / 借搜索入口绕行，而非追求全自动；
5. **节奏 > 伪装，内容级校验 > 状态码**：慢而稳、对空壳页零容忍，才是京东场景下能跑通的关键。

这五条，是本项目真正的技术积累，也是这份笔记要记录的东西。
