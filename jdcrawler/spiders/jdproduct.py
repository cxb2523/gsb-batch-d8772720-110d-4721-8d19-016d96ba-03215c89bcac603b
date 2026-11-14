import re
import json
import os
import scrapy
import pymysql

from jdcrawler.items import JdItem
from jdcrawler.status_constants import CategoryCrawlStatus, CATEGORY_STATUS_TEXT

# L3 运行会话记录：将列表采集接入 crawl_session 表（与批量入库/离线导入一致）
import sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', 'scripts')))
from crawl_session import ensure_session_table, start_session, finish_session


# 商品卡片选择器（健壮性 M6）：主选择器优先；仅当主选择器为空才回退，
# 避免"主选择器命中 1~9 个但回退选择器命中 0 个"时被数量阈值误判丢数据。
PRIMARY_CARD_SELECTOR = "div[data-sku]"
FALLBACK_CARD_SELECTORS = ["li[class*='gl-item']", "div[class*='item']"]


class JdProductSpider(scrapy.Spider):
    """
    京东商品爬虫（从数据库读取分类）
    
    核心流程（每页立即存库，不攒数据）：
        1. 从 jd_data.categories 表读取三级分类（叶子节点）
        2. 中间件渲染单页 → spider 解析 yield item → pipeline 立即存库
        3. spider 发下一页请求 → 重复上述流程
        4. 翻页控制权在 spider 手中，保证每页数据即时入库
    """
    
    name = "jdproduct"
    allowed_domains = ["search.jd.com", "n1.jd.com", "img14.360buyimg.com"]

    custom_settings = {
        "CONCURRENT_REQUESTS": 1,
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.category_limit = 0
        self.start_category = 0
        self.end_category = 0
        self.max_pages = 100             # 每个分类最大页数
        self.items_per_category = 0       # 每个分类目标商品数量
        
        # 数据库配置
        self.mysql_host = '127.0.0.1'
        self.mysql_user = 'root'
        self.mysql_password = '123456'
        self.mysql_db = 'jd_data'
        self.mysql_port = 3306
        self.mysql_charset = 'utf8mb4'
        
        # 分类数据
        self.categories = []             # 待爬取的三级分类列表
        self.category_stats = {}         # 分类ID -> 已有商品数量
        
        # 统计信息
        self.total_categories = 0        # 总分类数
        self.processed_categories = 0    # 已处理分类数
        self.total_items = 0             # 总提取商品数

        # L3 会话记录相关
        self.success_categories = 0      # 本次运行成功处理的分类数
        self.failed_categories = 0       # 本次运行失败的分类数
        self._session_id = None          # crawl_session 表当前会话 id
        self._session_conn = None        # 会话记录的 DB 连接（spider_opened 建立）

    @classmethod
    def from_crawler(cls, crawler, *args, **kwargs):
        spider = super().from_crawler(crawler, *args, **kwargs)
        # -a 参数优先，settings 作为默认值
        if spider.category_limit == 0:
            spider.category_limit = crawler.settings.getint('CATEGORY_LIMIT', 0)
        if spider.start_category == 0:
            spider.start_category = crawler.settings.getint('START_CATEGORY', 0)
        if spider.end_category == 0:
            spider.end_category = crawler.settings.getint('END_CATEGORY', 0)
        if spider.max_pages == 100:
            spider.max_pages = crawler.settings.getint('MAX_PAGES', 100)
        if spider.items_per_category == 0:
            spider.items_per_category = crawler.settings.getint('ITEMS_PER_CATEGORY', 0)
        
        spider.mysql_host = crawler.settings.get('MYSQL_HOST', spider.mysql_host)
        spider.mysql_user = crawler.settings.get('MYSQL_USER', spider.mysql_user)
        spider.mysql_password = crawler.settings.get('MYSQL_PASSWORD', spider.mysql_password)
        spider.mysql_db = crawler.settings.get('MYSQL_DB', spider.mysql_db)
        if spider.mysql_port == 3306:
            spider.mysql_port = crawler.settings.getint('MYSQL_PORT', 3306)
        spider.mysql_charset = crawler.settings.get('MYSQL_CHARSET', spider.mysql_charset)
        
        crawler.signals.connect(spider.spider_opened, signal=scrapy.signals.spider_opened)
        crawler.signals.connect(spider.spider_closed, signal=scrapy.signals.spider_closed)
        
        return spider

    def spider_opened(self, spider):
        """爬虫启动时的初始化"""
        self.logger.info("=" * 60)
        self.logger.info("[爬虫启动] 京东商品爬虫开始运行")
        self.logger.info(f"[配置信息] 数据库: {self.mysql_db}")
        self.logger.info(f"[配置信息] 分类限制: {self.category_limit} (0=全部)")
        self.logger.info(f"[配置信息] 每个分类最大页数: {self.max_pages}")
        
        self._reset_stuck_categories()
        self._load_categories_from_db()
        self._check_existing_data()
        self.logger.info("=" * 60)

        # L3 运行会话记录：为本次列表采集建立一条会话（失败不影响爬取主流程）
        try:
            self._session_conn = pymysql.connect(
                host=self.mysql_host,
                user=self.mysql_user,
                password=self.mysql_password,
                db=self.mysql_db,
                charset=self.mysql_charset,
                cursorclass=pymysql.cursors.DictCursor
            )
            cursor = self._session_conn.cursor()
            ensure_session_table(cursor, self._session_conn)
            self._session_id = start_session(
                cursor, self._session_conn, 'list_crawl',
                note=f'分类限制={self.category_limit}'
            )
            self.logger.info(f"[会话] 已建立列表采集会话 id={self._session_id}")
        except Exception as e:
            self.logger.warning(f"[会话] 建立会话失败（不影响爬取）: {e}")
            self._session_id = None
            self._session_conn = None

    def spider_closed(self, spider):
        """爬虫关闭时的统计"""
        self.logger.info("=" * 60)
        self.logger.info("[爬虫结束] 京东商品爬虫运行结束")
        self.logger.info(f"[统计信息] 总分类数: {self.total_categories}")
        self.logger.info(f"[统计信息] 已处理分类: {self.processed_categories}")
        self.logger.info(f"[统计信息] 总提取商品: {self.total_items}")
        self.logger.info("=" * 60)

        # L3 运行会话记录：结束会话并写入成功/失败统计（DB 不可用时仅告警）
        if self._session_conn is not None and self._session_id is not None:
            try:
                finish_session(
                    self._session_conn.cursor(), self._session_conn,
                    self._session_id,
                    total=self.total_categories,
                    success=self.success_categories,
                    failed=self.failed_categories,
                    note=f'提取商品={self.total_items}'
                )
                self.logger.info(
                    f"[会话] 列表采集会话 id={self._session_id} 结束："
                    f"成功={self.success_categories} 失败={self.failed_categories}"
                )
            except Exception as e:
                self.logger.warning(f"[会话] 结束会话失败（不影响）: {e}")
            finally:
                try:
                    self._session_conn.close()
                except Exception:
                    pass

    def _reset_stuck_categories(self):
        """
        复苏被卡在"爬取中(1)"/"失败(3)"的分类，重置为待爬取(0)。
        修复健壮性缺陷 H1：start() 会把分类标记为 1，一旦中途中断或首页
        短响应未恢复，分类会永久停留 1，导致下次运行永远不再爬取。
        """
        try:
            conn = pymysql.connect(
                host=self.mysql_host,
                user=self.mysql_user,
                password=self.mysql_password,
                db=self.mysql_db,
                charset=self.mysql_charset,
                cursorclass=pymysql.cursors.DictCursor
            )
            cursor = conn.cursor()
            cursor.execute(
                "UPDATE categories SET crawl_status = 0 WHERE crawl_status IN (1, 3)"
            )
            reset = cursor.rowcount
            conn.commit()
            cursor.close()
            conn.close()
            if reset:
                self.logger.info(f"[分类复苏] {reset} 个卡住的分类已重置为待爬取(0)")
        except Exception as e:
            self.logger.warning(f"[分类复苏] 重置失败（不影响本次运行）: {e}")

    def _load_categories_from_db(self):
        """从数据库加载待爬取的三级分类（叶子节点）"""
        self.logger.info("[分类加载] 正在从数据库加载分类...")
        
        try:
            conn = pymysql.connect(
                host=self.mysql_host,
                user=self.mysql_user,
                password=self.mysql_password,
                db=self.mysql_db,
                charset=self.mysql_charset,
                cursorclass=pymysql.cursors.DictCursor
            )
            cursor = conn.cursor()
            
            cursor.execute("""
                SELECT 
                    c.id,
                    c.name,
                    c.parent_id,
                    c.path,
                    c.level,
                    c.source_url,
                    c.crawl_status,
                    p.name AS parent_name,
                    pp.name AS grand_parent_name
                FROM categories c
                LEFT JOIN categories p ON c.parent_id = p.id
                LEFT JOIN categories pp ON p.parent_id = pp.id
                WHERE c.is_leaf = TRUE
                  AND c.crawl_status = 0
                ORDER BY c.sort_order
            """)
            
            rows = cursor.fetchall()
            
            for row in rows:
                names = []
                if row.get('grand_parent_name'):
                    names.append(row['grand_parent_name'])
                if row.get('parent_name'):
                    names.append(row['parent_name'])
                names.append(row['name'])
                category_full_name = ' > '.join(names)
                
                self.categories.append({
                    'id': row['id'],
                    'name': row['name'],
                    'source_url': row['source_url'],
                    'full_name': category_full_name,
                })
            
            cursor.close()
            conn.close()
            
            self.total_categories = len(self.categories)
            self.logger.info(f"[分类加载] 共加载 {self.total_categories} 个待爬取分类")
            
            if self.categories:
                self.logger.info("[分类加载] 分类示例:")
                for cat in self.categories[:5]:
                    self.logger.info(f"[分类加载]   ID={cat['id']}, {cat['full_name']}")
                if len(self.categories) > 5:
                    self.logger.info(f"[分类加载]   ... 还有 {len(self.categories) - 5} 个分类")
            
        except Exception as e:
            self.logger.error(f"[分类加载] 从数据库加载分类失败: {e}")
            self.categories = []
            # 健壮性 M7：连接/查询失败不应被静默吞掉，必须让用户看到，否则会以 0 分类静默退出
            print(f"\n[严重] 分类加载失败，爬虫将以 0 个分类退出：{e}\n")

    def _check_existing_data(self):
        """检测数据库中现有商品数据"""
        try:
            conn = pymysql.connect(
                host=self.mysql_host,
                user=self.mysql_user,
                password=self.mysql_password,
                db=self.mysql_db,
                charset=self.mysql_charset
            )
            cursor = conn.cursor()
            
            cursor.execute("""
                SELECT category_id, COUNT(*) as count 
                FROM products 
                GROUP BY category_id
            """)
            results = cursor.fetchall()
            
            if results:
                for category_id, count in results:
                    self.category_stats[category_id] = count
                self.logger.info(f"[数据检测] 数据库中已有 {len(results)} 个分类的商品数据")
            else:
                self.logger.info("[数据检测] 数据库为空，将从头开始爬取")
            
            cursor.close()
            conn.close()
            
        except Exception as e:
            self.logger.warning(f"[数据检测] 查询数据库失败: {e}")

    def _update_category_status(self, category_id, status):
        """更新分类的爬取状态（status 见 jdcrawler.status_constants.CategoryCrawlStatus，健壮性 L4）"""
        try:
            conn = pymysql.connect(
                host=self.mysql_host,
                user=self.mysql_user,
                password=self.mysql_password,
                db=self.mysql_db,
                charset=self.mysql_charset
            )
            cursor = conn.cursor()
            cursor.execute(
                "UPDATE categories SET crawl_status = %s WHERE id = %s",
                (status, category_id)
            )
            conn.commit()
            cursor.close()
            conn.close()

            status_text = CATEGORY_STATUS_TEXT.get(status, str(status))
            self.logger.info(f"[分类状态] 分类ID={category_id} 状态更新为: {status_text}")

            # L3 会话统计：累计本次运行成功/失败的分类数，供 spider_closed 写入 crawl_session
            if status == CategoryCrawlStatus.DONE:
                self.success_categories += 1
            elif status == CategoryCrawlStatus.FAILED:
                self.failed_categories += 1

        except Exception as e:
            self.logger.error(f"[分类状态] 更新分类状态失败: {e}")

    async def start(self):
        """
        开始请求：遍历分类，为每个分类生成搜索请求（Scrapy 2.13+ 新规范）。
        
        每个分类只发一个初始请求，翻页由 parse_product_list 中递归发请求完成。
        """
        if not self.categories:
            self.logger.warning("[爬虫启动] 没有待爬取的分类，爬虫将直接退出")
            return
        
        self.logger.info(f"[爬虫启动] 开始为 {len(self.categories)} 个分类生成搜索请求...")
        
        count = 0
        current_index = 0
        
        for cat in self.categories:
            cat_id = cat['id']
            cat_name = cat['name']
            cat_url = cat['source_url']
            cat_full_name = cat['full_name']
            
            # 检查是否在指定范围内
            if self.start_category > 0 and current_index < self.start_category:
                current_index += 1
                continue
            if self.end_category > 0 and current_index >= self.end_category:
                break
            current_index += 1
            
            # 检查是否已经达到了目标数量
            existing_count = self.category_stats.get(cat_id, 0)
            if self.items_per_category > 0 and existing_count >= self.items_per_category:
                self.logger.info(f"[分类解析] 跳过已达标分类: {cat_full_name} (已有 {existing_count} 个)")
                self._update_category_status(cat_id, CategoryCrawlStatus.DONE)
                continue
            
            # 使用分类的 source_url 作为搜索链接
            url = cat_url if cat_url else f"https://search.jd.com/Search?keyword={cat_name}&enc=utf-8"
            
            self.logger.info(f"[分类解析] 准备爬取: [{cat_id}] {cat_full_name}")
            
            # 标记为爬取中
            self._update_category_status(cat_id, CategoryCrawlStatus.CRAWLING)
            
            yield scrapy.Request(
                url=url,
                callback=self.parse_product_list,
                errback=self.errback_handler,
                meta={
                    "category_id": cat_id,
                    "category_name": cat_name,
                    "category_full_name": cat_full_name,
                    "page": 1,
                    "total_extracted": 0,
                    # 告诉中间件这是首页（不是翻页）
                    "dp_next_page": False,
                    "dp_page_num": 1,
                },
            )
            
            count += 1
            if self.category_limit and count >= self.category_limit:
                self.logger.info(f"[分类解析] 已达到分类限制: {self.category_limit} 个")
                break
        
        self.logger.info(f"[分类解析] 本次爬取 {count} 个分类")

    def parse_product_list(self, response):
        """
        解析单页搜索结果，提取商品后立即 yield（走 pipeline 存库），
        然后发下一页请求继续爬。
        
        核心流程：解析一页 → yield item（立即存库）→ 发下一页请求
        """
        category_id = response.meta.get("category_id", "")
        category_name = response.meta.get("category_name", "")
        category_full_name = response.meta.get("category_full_name", "")
        current_page = response.meta.get("page", 1)
        total_extracted = response.meta.get("total_extracted", 0)

        self.logger.info(f"[商品解析] 正在解析: [{category_id}] {category_full_name} (第 {current_page} 页)")
        
        # 检查响应内容
        html_content = response.text
        if len(html_content) < 1000:
            self.logger.warning("[商品解析] 响应内容过短，可能被反爬")
            # 修复 H1：标记为失败(3)并计入已处理，避免分类卡在"爬取中(1)"
            self._update_category_status(category_id, CategoryCrawlStatus.FAILED)
            self.processed_categories += 1
            return

        # 查找商品卡片：优先主选择器，仅当为空时才回退（健壮性 M6），
        # 避免"主选择器命中 1~9 个但回退选择器命中 0 个"时被数量阈值误判丢数据
        cards = response.css(PRIMARY_CARD_SELECTOR)
        used_fallback = False
        if not cards:
            for sel in FALLBACK_CARD_SELECTORS:
                cards = response.css(sel)
                if cards:
                    used_fallback = True
                    break
        if used_fallback:
            self.logger.warning(
                "[商品解析] 主选择器未命中，已回退到备用选择器（卡片结构可能与预期不同，请关注数据完整性）"
            )

        self.logger.info(f"[商品解析] 找到 {len(cards)} 个商品卡片")

        # 健壮性 M6：提示卡片字段完整性，页面改版时便于发现数据丢失
        missing = sum(1 for c in cards if not c.attrib.get("data-sku"))
        if missing:
            self.logger.warning(
                f"[商品解析] {missing} 个卡片缺少 data-sku 属性，已跳过（可能页面结构变化，请检查选择器）"
            )

        if len(cards) == 0:
            self.logger.warning("[商品解析] 未找到商品卡片，本分类结束")
            self._update_category_status(category_id, CategoryCrawlStatus.DONE)
            self.processed_categories += 1
            return
        
        # 提取本页商品，yield 后立即走 pipeline 存库
        seen = set()
        count = 0

        for card in cards:
            sku = card.attrib.get("data-sku", "")
            
            if not sku or sku in seen:
                continue
            seen.add(sku)

            item = JdItem(
                category_id=category_id,
                sku_id=sku,
                source_url=f"https://item.jd.com/{sku}.html",
                category_name=category_full_name,
            )
            
            # yield 后 item 立即进入 pipeline 存库
            yield item
            count += 1
            self.total_items += 1
        
        # 本页数据已全部存库
        new_total = total_extracted + count
        self.logger.info(
            f"[商品解析] [{category_full_name}] 第{current_page}页: "
            f"提取 {count} 个商品并已存库，累计 {new_total} 个"
        )
        
        # 检查是否达到每个分类的商品数量限制
        if self.items_per_category > 0 and new_total >= self.items_per_category:
            self.logger.info(f"[分类完成] [{category_full_name}] 已达到目标数量 {self.items_per_category}")
            self._update_category_status(category_id, CategoryCrawlStatus.DONE)
            self.processed_categories += 1
            return
        
        # 检查是否达到最大页数
        if current_page >= self.max_pages:
            self.logger.info(f"[分类完成] [{category_full_name}] 已达到最大页数 {self.max_pages}")
            self._update_category_status(category_id, CategoryCrawlStatus.DONE)
            self.processed_categories += 1
            return
        
        # 发送下一页请求（中间件会点击下一页按钮）
        next_page = current_page + 1
        self.logger.info(f"[翻页请求] [{category_full_name}] 发送第 {next_page} 页请求...")
        
        yield scrapy.Request(
            url=response.url,
            callback=self.parse_product_list,
            errback=self.errback_handler,
            dont_filter=True,  # 同一URL翻页，需要允许重复
            meta={
                "category_id": category_id,
                "category_name": category_name,
                "category_full_name": category_full_name,
                "page": next_page,
                "total_extracted": new_total,
                # 告诉中间件这是翻页请求
                "dp_next_page": True,
                "dp_page_num": next_page,
            },
        )

    def errback_handler(self, failure):
        """
        请求失败回调。
        
        如果是翻页请求失败（中间件返回None），说明没有下一页了，标记分类完成。
        如果是首页请求失败，标记分类为失败。
        """
        request = failure.request
        category_id = request.meta.get("category_id", "")
        category_full_name = request.meta.get("category_full_name", "")
        current_page = request.meta.get("page", 1)
        is_next_page = request.meta.get("dp_next_page", False)
        
        if is_next_page:
            # 翻页失败 = 没有下一页了 = 本分类正常结束
            self.logger.info(
                f"[分类完成] [{category_full_name}] 第{current_page}页翻页失败，"
                f"视为本分类爬取完成"
            )
            self._update_category_status(category_id, CategoryCrawlStatus.DONE)
            self.processed_categories += 1
        else:
            # 首页失败 = 本分类爬取失败
            self.logger.error(f"[请求失败] [{category_id}] {category_full_name}: {failure.value}")
            self._update_category_status(category_id, CategoryCrawlStatus.FAILED)
