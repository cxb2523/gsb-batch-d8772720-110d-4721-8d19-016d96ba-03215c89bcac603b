# 部署与使用手册（USAGE）

本手册面向**从零开始把项目跑起来**的用户，覆盖环境准备、部署、日常使用与排错。架构与设计见 [ARCHITECTURE.md](./ARCHITECTURE.md)，健壮性细节见 [ROBUSTNESS.md](./ROBUSTNESS.md)。

---

## 1. 环境要求

| 组件 | 版本 / 说明 |
|------|-------------|
| Python | 3.10+（推荐 3.13） |
| MySQL | 8.0（本地，库名 `jd_data`，默认账号 `root` / `123456`） |
| 浏览器 | Chrome / Edge 等 Chromium 内核其一，用于 DrissionPage 接调试端口 |
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

- **Chrome**
  ```bash
  "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
  ```
- **Edge**
  ```bash
  "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222
  ```
- 或在该浏览器快捷方式「目标」后追加 ` --remote-debugging-port=9222`

启动后访问 `http://127.0.0.1:9222/json/version` 能返回 JSON 即正常。`jdcrawler/settings.py` 中的 `EDGE_ADDRESS` 需与此端口一致（变量名虽叫 EDGE_ADDRESS，但只表示「浏览器调试端口」，与具体浏览器无关）。

---

## 4. 创建数据库

只需创建空库，数据表会在首次运行时按需自动创建：

```sql
CREATE DATABASE IF NOT EXISTS jd_data CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
```

各表创建时机（全部 `CREATE TABLE IF NOT EXISTS`，重复运行安全）：

| 表 | 由谁创建 |
|----|----------|
| `categories` | 运行 `python scripts/load_categories.py [--reset]` 自动建表并写入种子 |
| `product_links` | 运行 `scrapy crawl jdproduct` 时由列表采集管道自动建表 |
| `product_category_relation` | 随列表采集自动建表 |
| `products` | 详情采集首次运行时自动建表（`--db` / `--url` / `--init-db` 任一都会确保） |
| `crawl_session` | 每次详情 / 批量运行自动建表 |

一键确保全部核心表存在（换库 / 迁移后最省心）：

```bash
python scripts/detail_crawler_wrapper.py --init-db
# 或通过统一入口：
python main.py initdb
```

> 若使用分类列表采集（底层能力），需先建 `categories` 表并写入种子：
> ```bash
> python scripts/load_categories.py --reset     # 清空并全量重建（首次或分类有大变更时）
> python scripts/load_categories.py            # 增量导入（可重复运行）
> python scripts/load_categories.py --dry-run  # 仅统计各级 / 叶子数量，不连库
> ```
> 种子文件 `seeds/jd_categories_full.json` 为京东完整 4 级分类树。

---

## 5. 运行方式

> 所有命令均从**项目根目录**执行。脚本内部按文件位置计算项目根，无需切换目录。

### 5.1 交互菜单（推荐，门槛最低）

```bash
python main.py
```

进入菜单后逐项询问参数，直接回车用默认值：

```
 0  初始化分类表   (init)
 1  初始化数据库表 (initdb)
 2  商品URL采集    (url)   ← 录入商品链接到待爬库
 3  详情批量入库   (detail)
 4  离线 JSON 导入 (import)
 5  重爬失败项     (retry)
 6  查看统计       (stats)
 7  一键完整流程   (all)
 8  单商品详情采集 (single) ← 直接爬取并入库一个商品
 h  使用说明       (help)
 q  退出
```

### 5.2 典型采集流程

1. `python main.py` → 选 `2 商品URL采集`：逐行粘贴商品链接（每行一个，支持 `item.jd.com/{sku}.html`，自动解析 sku_id 去重），写入 `product_links`（detail_status=0）。
2. 选 `3 详情批量入库`：从待爬库取 URL 逐个爬详情并写 `products` 表。
3. 只想采一个：选 `8 单商品详情采集`，直接填 URL 入库（不经 `product_links`）。

### 5.3 子命令（适合写脚本 / 定时任务，不询问、用 settings 默认值）

```bash
python main.py init          # 初始化分类表
python main.py initdb        # 一键确保全部核心表存在
python main.py url           # 商品URL采集
python main.py detail        # 详情批量入库（detail_status=0）
python main.py single        # 单商品详情采集
python main.py retry         # 重爬失败项（detail_status=2）
python main.py import        # 离线导入 data/ 下的 JSON
python main.py stats         # 查看统计
python main.py all           # 一键流程（详情入库 + 重爬 + 导入 + 统计）
python main.py menu          # 强制进入交互菜单
```

### 5.4 各模块可调参数

| 模块 | 参数 | 说明 |
|------|------|------|
| 商品URL采集 | 商品链接 | 每行一个，自动去重；已存在则只更新 URL、保留原状态 |
| 详情批量入库 | 处理上限 / 验证码等待 / 评论数 / 滚动停顿 / 下载图片 | 进入模块后询问，回车用默认 |
| 单商品详情采集 | 商品 URL / 评论数 / 滚动停顿 / 下载图片 / 验证码 | 进入模块后询问，回车用默认 |

命令行直跑时可透传：`--max-comments N`、`--scroll-pause 秒`、`--no-download-images`、`--no-manual-verify`。

---

## 6. 底层四阶段命令（绕过菜单）

> 这些命令与菜单功能等价，适合需要精细控制或写脚本时使用。

```bash
# ① 分类列表采集（底层能力，需先建 categories 种子）
scrapy crawl jdproduct

# ② 单商品详情爬取（落 data/{sku}/ 与 images/{sku}/）
python scripts/jd_product_detail.py --url https://item.jd.com/100012043978.html

# ③ 从数据库批量爬取详情（实时）
python scripts/detail_crawler_wrapper.py --init-db
python scripts/detail_crawler_wrapper.py --db --limit 20

# ④ 离线导入已爬取的 JSON（不需要浏览器）
python scripts/detail_crawler_wrapper.py --from-json
python scripts/detail_crawler_wrapper.py --from-json --init-products

# 其它
python scripts/detail_crawler_wrapper.py --retry-failed   # 重爬失败项
python scripts/detail_crawler_wrapper.py --stats          # 统计
python scripts/detail_crawler_wrapper.py --url <URL> --no-manual-verify  # 单商品跳过验证等待
```

---

## 7. 修改长期配置

调试端口 / 爬取节奏等长期偏好，直接编辑 `jdcrawler/settings.py`（如 `EDGE_ADDRESS`、`MAX_PAGES`、`DOWNLOAD_DELAY`、`MYSQL_*`）。`main.py` 不重复暴露这些旋钮。

---

## 8. 常见问题（FAQ）

- **DrissionPage 提示找不到浏览器 / 连不上 9222**：检查浏览器是否已用调试端口启动，`EDGE_ADDRESS` 是否匹配。
- **列表采集没有产出**：若用分类列表，确认 `categories` 表已有 `leaf=1 AND crawl_status=0` 的记录（先跑 `load_categories.py --reset`）。
- **触发京东风控验证（需人工在浏览器中完成）**：降低 `CONCURRENT_REQUESTS`、增大 `DOWNLOAD_DELAY` 以降低触发概率；详情采集默认会暂停等待人工完成验证，`--db` 模式则不等待、遇到验证跳过该商品。
- **图片 / JSON 未生成在预期位置**：命令必须从项目根目录运行，脚本按项目根解析 `data/`、`images/`。
- **详情图为 0**：通常是滚动太快未触发懒加载；详情采集已改为平滑慢速滚动，必要时调大 `--scroll-pause`。
- **未登录被拦截**：确保已在调试端口浏览器中登录京东；`main.py` 在采集前会检测登录态，未登录会暂停等你登录。

---

## 9. 数据重置与维护

- 清空并重建分类：`python scripts/load_categories.py --reset`
- 重置某商品详情状态以便重爬：将 `product_links.detail_status` 改回 `0`（或失败项用 `--retry-failed`）。
- `data/`、`images/` 为运行时产物，已在 `.gitignore` 忽略，可安全删除后重新采集。
- `scripts/data/`、`scripts/images/` 同样被忽略，正常情况下不应生成（产物统一落项目根）。
