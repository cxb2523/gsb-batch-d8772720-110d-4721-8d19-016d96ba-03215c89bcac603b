# 安装与运行（SETUP）

本文档说明如何在本机搭建并运行京东商品采集系统。架构总览见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

---

## 1. 环境要求

| 组件 | 版本/说明 |
|------|-----------|
| Python | 3.10+（推荐 3.13） |
| MySQL | 8.0（本地，库名 `jd_data`，账号 `root`/`123456`） |
| Chrome / Edge 等 Chromium 浏览器 | 已安装其一，用于 DrissionPage 接入调试端口 |
| 操作系统 | Windows（脚本与路径按 Windows 习惯编写） |

> DrissionPage 通过浏览器的远程调试端口（`127.0.0.1:9222`）接管浏览器，**只要 Chrome 或 Edge 用调试端口启动即可**（两者都基于 Chromium，效果一致），再运行爬虫。

---

## 2. 安装依赖

```bash
cd jd-product-crawler
pip install -r requirements.txt
```

依赖包含：`scrapy`、`drissionpage`、`pymysql`、`requests`。

---

## 3. 启动浏览器调试模式

关闭该浏览器的所有窗口后，用调试端口启动（任选其一，**效果一致**，默认端口 9222）：

- **Chrome**：
  ```bash
  "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
  ```
- **Edge**：
  ```bash
  "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222
  ```
- 或在该浏览器快捷方式目标后追加 ` --remote-debugging-port=9222`

启动后访问 `http://127.0.0.1:9222/json/version` 能返回 JSON 即正常。
`jdcrawler/settings.py` 中的 `EDGE_ADDRESS` 需与此端口一致（变量名虽叫 EDGE_ADDRESS，但只表示"浏览器调试端口"，与具体浏览器无关）。

---

## 4. 初始化数据库

只需创建空库，数据表会在首次运行时按需自动创建：

```sql
CREATE DATABASE IF NOT EXISTS jd_data CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
```

各表的创建时机（全部使用 `CREATE TABLE IF NOT EXISTS`，重复运行安全）：

| 表 | 由谁创建 |
|----|----------|
| `categories` | 运行 `python scripts/load_categories.py [--reset]` 自动建表并写入种子 |
| `product_links` | 运行 `scrapy crawl jdproduct` 时由列表采集管道自动建表（含 `detail_status` / `detail_error` 等全部列） |
| `product_category_relation` | 同上，随列表采集自动建表 |
| `products` | 详情采集首次运行即自动建表（`--db` / `--url` / `--init-db` 任一都会确保）；也可显式 `python scripts/detail_crawler_wrapper.py --init-db` 或 `--from-json --init-products` |
| `crawl_session` | 每次详情/批量运行自动建表 |

> 一键确保全部核心表存在（开发/迁移/换库后最省心）：
> ```bash
> python scripts/detail_crawler_wrapper.py --init-db
> # 或通过统一入口：
> python main.py initdb
> ```

### 关于分类数据（categories）

列表采集 Spider 从 `categories` 表读取叶子分类（`is_leaf=1 AND crawl_status IN (0, 4)`，
其中 4=部分完成会从断点页续爬）。
本仓库提供种子文件 `seeds/jd_categories_full.json`（京东完整 4 级分类树，共 2941 个节点，
其中 2694 个叶子节点可被列表采集抓取）。使用内置脚本导入：

```bash
python scripts/load_categories.py --reset     # 清空并全量重建（首次或分类有大变更时）
python scripts/load_categories.py            # 增量导入（跳过已存在的同名同父分类，可重复运行）
python scripts/load_categories.py --dry-run  # 仅统计各级/叶子数量，不连接数据库
```

脚本会自建 `categories` 表（若不存在），递归解析分类树，为每个节点分配自增 id 并维护
`parent_id` 与 id 路径；JSON 中绝大多数节点的 `id` 字段为空，故不使用 JSON 的 id 作主键。

---

## 5. 运行方式（四阶段）

> 所有命令均从**项目根目录**执行。

### 0 初始化分类（前置步骤）
```bash
python scripts/load_categories.py --reset
```
建 `categories` 表并写入 `seeds/` 种子；列表采集依赖此表，必须先执行。

### ① 列表采集（Scrapy）
```bash
scrapy crawl jdproduct
```
按 `jdcrawler/settings.py` 的 `CATEGORY_LIMIT` / `MAX_PAGES` 控制规模（默认只爬 1 个分类、最多 20 页）。
结果写入 `product_links` 与 `product_category_relation`。

### ② 单商品详情爬取
```bash
python scripts/jd_product_detail.py --url https://item.jd.com/100012043978.html
```
结果写入 `data/{sku}/product_{sku}.json` 并下载图片到 `images/{sku}/`。

### ③ 从数据库批量爬取详情（实时）
```bash
python scripts/detail_crawler_wrapper.py --db --limit 20
```
从 `product_links` 取 `detail_status=0` 的 URL 逐个爬取，写入 `products` 表并更新状态。
首次使用先执行一次：
```bash
python scripts/detail_crawler_wrapper.py --init-db
```

### ④ 离线导入已爬取的 JSON
```bash
python scripts/detail_crawler_wrapper.py --from-json
```
将 `data/` 下由 ② 生成的 JSON 批量导入 `products` 表（**不需要浏览器**）。
首次建表：
```bash
python scripts/detail_crawler_wrapper.py --from-json --init-products
```

### 其它
```bash
python scripts/detail_crawler_wrapper.py --stats     # 查看采集统计
python scripts/detail_crawler_wrapper.py --url <url> # 等价于 ② 但通过统一入口
```

---

## 6. 常见问题

- **DrissionPage 提示找不到浏览器 / 连不上 9222**：检查浏览器（Chrome/Edge）是否已用调试端口启动，`EDGE_ADDRESS` 是否匹配。
- **列表采集没有产出**：确认 `categories` 表已有 `leaf=1 AND crawl_status=0` 的记录。
- **触发京东风控验证（需人工在浏览器中完成）**：降低 `CONCURRENT_REQUESTS`、增大 `DOWNLOAD_DELAY` 以降低触发概率；详情采集默认会暂停等待人工完成验证。
- **图片/JSON 未生成在预期位置**：命令必须从项目根目录运行，脚本会按当前工作目录解析 `data/`、`images/`。
