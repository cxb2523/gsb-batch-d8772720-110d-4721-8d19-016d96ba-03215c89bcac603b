# 爬虫健壮性分析报告

> 文档生成日期：2026-07-17
> 分析对象：`jd-product-crawler`（京东商品采集系统）
> 方法：**白盒测试 + 代码审查**。白盒测试位于 `tests/`，共 37 个用例全部通过，覆盖 `load_categories`、`pipelines`、`jdproduct.parse_product_list`、`json_to_products`、`detail_crawler_wrapper` 的可脱离浏览器/数据库的内部逻辑。

---

## 零、修复进度（2026-07-17 第二轮）

按报告优先级实施了修复，白盒测试同步更新并全绿（37/37）。已修复项：

| 编号 | 问题 | 修复方式 | 涉及文件 |
|------|------|----------|----------|
| **H1** | 死分类卡死（crawl_status 永久停留 1） | ① 启动新增 `_reset_stuck_categories()` 将 `IN (1,3)` 重置为 0；② 短响应分支由静默 `return` 改为标记失败(3)并计入已处理 | `jdcrawler/spiders/jdproduct.py` |
| **H2** | 缓冲异常静默丢数据 | `_flush_buffers` 异常时落盘 `pending_product_links.jsonl`（不再静默清空）；`close_spider` 仍会再 flush 一次 | `jdcrawler/pipelines.py` |
| **H3** | 验证码阻塞无人值守 | 批量爬取(`--db`) 强制 `wait_for_manual_verify=False`；`--url` 默认等待，新增 `--no-manual-verify` 可关闭 | `scripts/detail_crawler_wrapper.py` |
| **M1+M2** | products.id 双路径不一致 + 非幂等 | `_save_to_db`/`json_to_products` 改为 `INSERT ... ON DUPLICATE KEY UPDATE`；新增 `ensure_products_unique_skuid()` 为 `products.sku_id` 建唯一索引；始终以 `product_links.id` 作为 `products.id` | `scripts/detail_crawler_wrapper.py`、`scripts/json_to_products.py`、`scripts/db_connection.py` |
| **M4** | 连接无重连 | 新增 `_ensure_connection()`（`ping(reconnect=True)`）；`db_connection` 的查询方法与 `MysqlPipeline._flush_buffers` 前调用 | `scripts/db_connection.py`、`jdcrawler/pipelines.py` |
| **M8** | 失败项无法重爬 | 新增 `--retry-failed` 重爬 `detail_status=2` | `scripts/detail_crawler_wrapper.py` |
| 额外 | 选择器阈值误判丢卡片 | 移除 `<10` 降级阈值，仅当主选择器为空才回退 | `jdcrawler/spiders/jdproduct.py` |
| 额外 | GBK 终端编码报错 | 移除日志中的 `✓` 字符 | `jdcrawler/pipelines.py` |

**未修复（低/中，留待后续）**：M3 字段截断、M5 连接复用（每个状态更新新建连接）、M6 异常吞没不一致、M7 其他、L1–L4。详见下文对应章节。

---

## 零之一、修复进度（2026-07-17 第三轮：剩余中/低优先级）

第二轮完成高/中优先级（H1/H2/H3/M1+M2/M4/M8）后，本轮补齐报告剩余的 M3/M5/M6(残留)/M7/L1–L4。白盒测试同步新增 `test_product_persist.py`（覆盖动态截断、提取、组装、状态常量、会话记录），全量 **50/50 通过**。

| 编号 | 问题 | 修复方式 | 涉及文件 |
|------|------|----------|----------|
| **M3** | 字段硬编码 `[:500]`/`[:100]` 盲切（静默丢信息 + 与表结构耦合） | 新增 `product_persist.get_product_column_limits` 从 `INFORMATION_SCHEMA` 读取 products 表 VARCHAR 列实际长度上限，超长时按列上限截断并**告警**；结果缓存到 cursor 避免重复查询 | `scripts/product_persist.py`、`scripts/detail_crawler_wrapper.py`、`scripts/json_to_products.py` |
| **M5** | 详情入库逻辑重复（DRY 违反，gallery 提取差异） | 抽公共模块 `scripts/product_persist.py`：`extract_gallery_urls`/`extract_detail_urls`/`build_product_values`/`upsert_product` 统一两条路径；gallery/detail 统一包装为 `[{"url": ...}]` | `scripts/product_persist.py` 及上述两脚本 |
| **M6** | 选择器阈值脆弱（残留） | 主/备用选择器提升为模块常量 `PRIMARY_CARD_SELECTOR`/`FALLBACK_CARD_SELECTORS`；仅主选择器为空才回退，并在回退与"卡片缺 data-sku"时告警，提示页面结构变化 | `jdcrawler/spiders/jdproduct.py` |
| **M7** | 异常吞没不一致 | `db_connection.update_crawl_status` 改为**返回 bool** 失败信号；`_load_categories_from_db` 连接失败时**额外打印到 stdout** 大声告警，避免 0 分类静默退出；`jd_product_detail.py` 内部裸 `except` 已于第四轮专项审计修复（见「零之二」） | `scripts/db_connection.py`、`jdcrawler/spiders/jdproduct.py`、`docs/ROBUSTNESS.md` 本节说明 |
| **L1** | 日志不轮转 | `jdcrawler/settings.py` 将 `FileHandler` 改为 `RotatingFileHandler`（单文件 10MB，保留 5 备份，可配置 `LOG_FILE_MAX_BYTES`/`LOG_FILE_BACKUP`） | `jdcrawler/settings.py` |
| **L2** | `get_uncrawled_urls` 每次 `SHOW COLUMNS` | `db_connection` 新增 `_has_column` 带缓存（`self._schema_cache`），`get_uncrawled_urls`/`update_crawl_status`/`get_total_stats`/`add_detail_status_column` 复用 | `scripts/db_connection.py` |
| **L3** | 可观测性弱 | 新增 `scripts/crawl_session.py`（`ensure/start/finish`），记录每次批量爬取 / 导入的开始、结束、成功/失败数到 `crawl_session` 表；接入 `wrapper.crawl_from_db`、离线导入（`json_to_products.import_directory`） | `scripts/crawl_session.py`、`scripts/detail_crawler_wrapper.py`、`scripts/json_to_products.py` |
| **L4** | 两套状态字段语义混淆 | 新增 `jdcrawler/status_constants.py`（`CategoryCrawlStatus` / `DetailStatus` 枚举 + 中文映射），在 `db_connection`/`wrapper`/`jdproduct` 中使用；`docs/ARCHITECTURE.md` 统一记录状态枚举 | `jdcrawler/status_constants.py`、`jdcrawler/spiders/jdproduct.py`、`scripts/db_connection.py`、`scripts/detail_crawler_wrapper.py`、`docs/ARCHITECTURE.md` |

> 更新（M7 边界，已于第四轮专项审计完成）：`scripts/jd_product_detail.py` 的异常分层审计已完成，详见「零之二」。

---

## 零之二、修复进度（2026-07-17 第四轮：jd_product_detail.py 异常分层专项审计）

针对 M7 边界项，对 `scripts/jd_product_detail.py`（约 1900 行爬取核心）做了异常分层审计与加固，并补齐白盒测试 `tests/test_jd_product_detail.py`（9 用例，mock 浏览器 / requests，不依赖真实浏览器），全量 **59/59 通过**。

| 编号 | 问题 | 修复方式 | 涉及文件 |
|------|------|----------|----------|
| **M7** | 裸 `except:`（321 行）会吞掉 `KeyboardInterrupt` / `SystemExit` | 改为 `except Exception as e` 并补 `[调试]` 级日志 | `scripts/jd_product_detail.py` |
| **M7** | 静默 `except Exception: pass`（7 处：369/436/1766/2026/2049/2062/2183）无日志，排查时无感 | 容错步骤补 `[调试]` 级日志（明确哪步失败、可忽略）；其中图片下载失败（1766）补 `[下载]` warning 以感知丢失率 | 同上 |
| **M7** | 关键路径无失败信号：`_extract_all_by_js()` 返回 `{}` 时仍用假标题/假品牌生成"假商品"记录入库 | `run()` 在核心数据提取返回空时 `return None`，让上层 `crawl_single_url` 正确标记为爬取失败（`detail_status=2`），避免脏数据 | 同上 |

**审计结论**：
- 主流程 `run()` 的 `except Exception`（2174 行）已正确 `return None` + traceback，是关键路径的范式样本，保留。
- `except KeyboardInterrupt`（402 行）、`except ValueError`（2075 行，price 解析）、`except json.JSONDecodeError`（1175/1581 行）均为精准捕获，保留。
- 既有带 `print` 的 `except`（330/1175/1261/1596/1683/1800/1996/2174/2219）属"已知失败点有日志"，保留。
- **遗留**：该脚本仍统一使用 `print` 而非 `logging`（未引入日志分级/落盘）。若需更细可观测性，可后续引入 `logging` 模块统一输出；本轮为控制改动风险未做此重构。

### 零之二补充：L3 会话记录扩展到列表采集
- 在 `jdcrawler/spiders/jdproduct.py` 接入 `crawl_session`：新增 `list_crawl` 运行类型。`spider_opened` 建会话（DB 不可用时降级 warning 不阻断爬取），`_update_category_status` 累计本次运行成功/失败分类数，`spider_closed` 写入 total/success/failed 并关闭连接。
- 至此 `crawl_session` 表已覆盖全部三条采集路径：`detail_crawl`（批量入库）、`json_import`（离线导入）、`list_crawl`（列表采集）。
- 白盒测试 `tests/test_jdproduct.py` 新增 `TestSessionIntegration`（计数累计 + DB 错误降级），全量 **61/61 通过**。

---

## 一、白盒测试结论

测试不依赖真实 MySQL 与 DrissionPage 浏览器（用内存假库 `RecordingCursor` 与 Scrapy `HtmlResponse` 驱动），验证了核心逻辑的正确性：

| 模块 | 验证点 | 结果 |
|------|--------|------|
| `scripts/load_categories.py` | `count_nodes` 统计、`insert_tree` 的 parent_id/is_leaf/path 计算、自增 id 分配 | ✅ |
| `jdcrawler/pipelines.py` | `JdPipeline` 按 `sku_id+category_id` 去重、`MysqlPipeline` 缓冲阈值触发与异常丢失 | ✅ |
| `jdcrawler/spiders/jdproduct.py` | `parse_product_list` 的 SKU 抽取、页内去重、短响应守卫、翻页请求生成、`errback` 状态机 | ✅ |
| `scripts/json_to_products.py` | `_clean_text` 清洗、`_extract_image_urls` 提取、`import_json_file` 的 INSERT 字段组装 | ✅ |
| `scripts/detail_crawler_wrapper.py` | `_save_to_db` 的图片 URL 提取、异常回滚 | ✅ |

**测试同时也暴露并推动了 2 个真实的健壮性缺陷修复**（详见 H2、M6、选择器阈值）：
- 缓冲区在异常路径下会**静默丢弃未提交数据** —— 已修复为落盘 `pending_product_links.jsonl`，`tests/test_pipelines.py::test_error_flush_persists_not_loses` 断言新行为。
- `parse_product_list` 的主选择器依赖硬编码数量阈值（`<10` 降级），末页小批量会走不同解析路径 —— 已移除阈值，仅主选择器为空才回退。

---

## 二、健壮性问题清单（按严重度）

### 高优先级（数据丢失 / 采集卡死）

#### H1. 分类"死分类"卡死：`crawl_status` 永久停留在 1
**位置**：`jdcrawler/spiders/jdproduct.py`
- `start()` 第 270 行：为每个分类生成请求前 `_update_category_status(cat_id, 1)`（标记"爬取中"）。
- `parse_product_list()` 第 312 行：`if len(html_content) < 1000: return` —— **直接 return，未恢复分类状态**。
- `_update_category_status()` 第 225 行：`except` 仅 `logger.error`，异常被吞。
- `_load_categories_from_db()` 第 132 行：仅加载 `crawl_status = 0` 的叶子分类。

**现象**：
1. 爬虫在标记 `crawl_status=1` 之后、某分类正常结束之前被中断（Ctrl+C / kill / 断电 / 异常退出）→ 该分类永久停留在 `1`。
2. 首页响应过短（被反爬）命中第 312 行 `return` → 分类既不翻页也不标记完成，停留在 `1`。
3. 下一次运行 `_load_categories_from_db` 只取 `crawl_status=0`，**该分类再也不会被加载** → "死分类"。

**影响**：丢失整分类商品，且随多次中断会累积大量死分类，需人工介入修表。

**修复建议**：
- 爬虫**启动阶段**增加"重置未完成分类"：`UPDATE categories SET crawl_status=0 WHERE crawl_status IN (1, 3)`（或仅 1），让上次中断的分类可重试。
- 第 312 行短响应分支改为 `_update_category_status(category_id, 3)`（标记失败）并 `return`，而非静默 return。
- `_update_category_status` 失败应向上抛或重试，避免状态写库静默失败。

#### H2. 列表采集尾批数据丢失（异常 / 中断时 <59 条缓冲被丢弃）
**位置**：`jdcrawler/pipelines.py` `MysqlPipeline`
- `_flush_buffers()` 第 179-181 行：`finally` 中无条件 `clear()` 缓冲区。
- `close_spider()` 第 183-188 行：调用 `_flush_buffers()`，但 `_flush_buffers` 内部 `except` 已 `rollback` 且 `finally` 已 `clear`，异常时该批数据丢失。
- `process_item()` 第 146 行：仅当 `len(buffer) >= buffer_size(59)` 才落库；**未达阈值的尾批依赖 `close_spider` 刷新**。

**现象**：
1. 爬虫被强制中断（未执行 `close_spider`）时，缓冲区中不足 59 条的尾部商品**永久丢失**。
2. `_flush_buffers` 内 `commit` 失败 → `rollback` → `finally` 清空 → 该批丢弃（白盒测试 `test_error_flush_loses_buffer` 已验证）。

**影响**：中断场景下静默丢数据，且无任何重试/重入队机制。

**修复建议**：
- 降低 `MYSQL_BUFFER_SIZE` 或增加**定时 flush**（独立计时器，每 N 秒强制落库），缩短丢失窗口。
- 异常路径下**保留 buffer** 供重试，而非 `finally` 强制 `clear`；或异常时把未提交数据写入本地 `pending.jsonl`，重启后补录。
- `close_spider` 的 `_flush_buffers` 异常不应被吞，至少记录丢失条数。

#### H3. 详情采集遇验证码无人值守时永久阻塞
**位置**：`scripts/jd_product_detail.py` `JdProductDetailSpider` 构造参数 `wait_for_manual_verify=True`（被 `detail_crawler_wrapper.py` 第 101 行透传）。

**现象**：批量爬取（`crawl_from_db`）过程中一旦触发滑动验证码，脚本**无限等待人工输入**，整批 SKU 卡死。

**影响**：无人值守（定时任务 / 远程服务器）场景下批量任务彻底挂起。

**修复建议**：
- 默认 `wait_for_manual_verify=False`；仅在单 URL 模式（`--url`）显式开启人工验证。
- 若保留等待，增加**超时**（如等待 60s 后仍无验证 → 跳过该 SKU，标记 `detail_status=失败`）并继续后续。

---

### 中优先级（连接 / 幂等 / 类型 / 重复）

#### M1. `products.id` 双路径语义不一致
**现象**：
- `detail_crawler_wrapper._save_to_db()`：用 `product_links.id` 作为 `products.id`（复用主键，第 189 行）。
- `json_to_products.JsonToProductsImporter`：INSERT 不带 `id`，由数据库**自增**。

两条路径向同一张 `products` 表写入，却用不同 id 来源。若混用（同一 SKU 既经 DB 爬取又经 JSON 导入），会产生 **id 冲突或重复记录**。

**修复建议**：统一约定 `products.id = product_links.id`，两条路径都显式传入该 id（JSON 导入也应先查 `product_links` 取 id）。

#### M2. `_save_to_db` 非幂等（INSERT 无 `ON DUPLICATE KEY UPDATE`）
**位置**：`detail_crawler_wrapper.py` 第 178-213 行（INSERT，无 `ON DUPLICATE`）。

**现象**：
- 若 `products` 已存在该 `id`（旧/空记录），第 139-142 行 `SELECT` 命中后 `return True` **跳过**，永远无法更新旧数据。
- 若 `products` 无该 `id` 但 `UNIQUE(sku_id)` 冲突 → INSERT 抛异常 → `rollback` → 该 SKU 标记失败且**无法重试成功**（每次都冲突）。

**修复建议**：改为 `INSERT ... ON DUPLICATE KEY UPDATE`，保证重试可覆盖更新而非冲突失败。

#### M3. 字段长度硬编码截断（静默丢信息 + 潜在写入失败）
**位置**：`detail_crawler_wrapper.py` 第 191-211 行：`[:500]` / `[:100]` / `[:1000]` / `[:65535]`。

**现象**：
- 标题/品牌超长被**无脑切片**静默截断，丢信息。
- 切片长度与 `products` 表实际 `VARCHAR` 定义可能不一致：若表字段更短，INSERT 反而会抛 `Data too long` 异常（被第 256 行 `except` 吞掉并标记失败）。

**修复建议**：以建表结构为准校验长度；捕获 1406 异常后按实际列长截断并告警，而非预先盲切。

#### M4. 单 MySQL 连接无重连（长爬取连接断开）
**位置**：`scripts/db_connection.py`（单连接）、`jdcrawler/pipelines.py`（单连接）、`detail_crawler_wrapper`（全程一个连接）。

**现象**：MySQL `wait_timeout`（默认 8h）或网络抖动导致连接断开后，后续 `execute` 抛 `OperationalError`，无 `ping(reconnect=True)` 恢复。

**影响**：长批量爬取（数百 SKU）中途断连会中断整批。

**修复建议**：封装执行器，每次操作前 `connection.ping(reconnect=True)`；或失败自动重连后重试该语句。

#### M5. 详情入库逻辑重复（DRY 违反）
**现象**：`_save_to_db` 的图片 URL 提取、字段截断、`INSERT` 组装在 `detail_crawler_wrapper.py`（第 156-249 行）与 `json_to_products.py` 的 importer 中**各实现一份**。

**影响**：字段增减 / bug 修复需改两处，极易漏改导致行为不一致（如 gallery 提取逻辑差异）。

**修复建议**：抽公共模块（如 `core/product_persist.py`）供两条路径复用，单点维护。

#### M6. 列表解析选择器阈值脆弱
**位置**：`jdcrawler/spiders/jdproduct.py` `parse_product_list()`
- 第 317-321 行：主选择器 `div[data-sku]` 命中 **`< 10`** 才降级到 `li[class*='gl-item']` / `div[class*='item']`。
- 第 312 行：`len(html) < 1000` 直接 return。

**现象**：
- 末页仅 3 个商品（`<10`）会触发选择器降级，可能命中不同元素集合，解析结果不确定。
- 以"数量阈值"判断选择器是否合理，耦合脆弱（京东改版极易全失效）。

**修复建议**：以"卡片集是否非空且字段完整"为准做校验，而非数量阈值；阈值改为可配置项。

#### M7. 异常吞没不一致
**现象**：
- `jd_product_detail.py`：大量裸 `except: pass` / `except Exception: pass`（**已于第四轮专项审计修复，见「零之二」**）。
- `db_connection.py`：每个方法独立 `try/except` 仅 `print`，调用方拿不到失败信号（如 `update` 失败无感知）。
- `_load_categories_from_db()`：DB 连接失败仅 `log + self.categories=[]` → 爬虫**静默写 0 分类退出**，用户无提示。

**修复建议**：区分"可恢复容错"（元素缺失）与"致命错误"（DB 断连、浏览器起不来）；关键失败应上抛或返回明确失败状态，让上层决策。

#### M8. 详情失败 SKU 的可重入性未声明
**现象**：`_save_to_db` 失败 `return False`，但 `crawl_from_db` 据此如何更新 `detail_status` 未与"可重试失败"明确区分。若失败 SKU 被永久标记且不再重试，需有"失败可重入"机制（如 `detail_status=2` 失败可再次 `--db` 重跑）。

**修复建议**：明确 `detail_status` 枚举（0 待爬 / 1 采集中 / 2 失败 / 3 成功），`--db` 仅取 `0`，失败 SKU 提供 `--retry-failed` 入口。

---

### 低优先级（可观测性 / 性能）

#### L1. 日志不轮转
**位置**：`jdcrawler/settings.py` `LOG_FILE = 'scrapy.log'`（追加模式，无 `RotatingFileHandler`）。长期运行单文件无限增长，撑爆磁盘。

**修复建议**：改用按大小或按日轮转的 `logging` Handler。

#### L2. `get_uncrawled_urls` 每次 `SHOW COLUMNS`
**位置**：`scripts/db_connection.py` `get_uncrawled_urls()` 每次调用都 `SHOW COLUMNS` 判断字段是否存在。

**修复建议**：字段列表缓存到实例属性，避免每条 SKU 重复查元数据。

#### L3. 可观测性弱
无运行进度持久化（如 `crawl_session` 表记录每次运行的开始/结束/成功失败数），中断后难以审计。

**修复建议**：增加轻量运行日志表。

#### L4. 两套状态字段语义混淆
`categories.crawl_status`（0 待爬 / 1 爬取中 / 2 已爬取 / 3 失败）与 `product_links.detail_status`（0 待爬 / …）命名与取值不统一，易误用。

**修复建议**：在 `docs/ARCHITECTURE.md` 中统一文档化状态枚举，代码内用常量定义。

---

## 三、整体改进路线图（建议优先级）

| 顺序 | 项 | 收益 | 工作量 |
|------|----|------|--------|
| 1 | H1 死分类重置 + 短响应标记失败 | 杜绝数据永久丢失 | 小 |
| 2 | H2 缓冲降级落盘 / 定时 flush | 中断丢数降到最低 | 中 |
| 3 | M1+M2 统一 products.id 与幂等写入 | 消除重复/冲突 | 小 |
| 4 | H3 验证码超时跳过 | 无人值守可用 | 小 |
| 5 | M4 连接重连 | 长任务稳定 | 小 |
| 6 | M5 抽公共入库模块 | 降低维护成本 | 中 |
| 7 | M3+M6+M7 类型校验/选择器健壮/异常分层 | 抗京东改版 | 中 |
| 8 | L1-L4 日志轮转/可观测性 | 运维友好 | 小 |

> 说明：本报告所列"位置行号"基于 2026-07-17 重构后的代码；若后续重构请对照方法名定位。白盒测试结果以 `tests/` 为准。
