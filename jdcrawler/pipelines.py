import os
import sys
import json
import pymysql
import logging
from itemadapter import ItemAdapter

logger = logging.getLogger('jdcrawler.pipelines')

# 列表采集依赖的两张表在 open_spider 自动创建（CREATE TABLE IF NOT EXISTS），
# 使"干净库 + scrapy crawl jdproduct"开箱即用（修复 SETUP 文档与代码不符的缺口）。
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))
from db_schema import ensure_product_links_table, ensure_product_category_relation_table  # noqa: E402

# 缓冲数据落盘位置（项目根目录），用于 flush 失败时恢复，避免静默丢数据
_PENDING_FILE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "pending_product_links.jsonl"
)


class JdPipeline:
    """
    去重管道：基于 SKU + 分类 组合去重
    
    同一商品可以出现在不同分类中，但同一分类内不重复。
    """
    seen_keys = set()

    def __init__(self):
        self.drop_count = 0
        self.process_count = 0

    def process_item(self, item):
        """处理商品数据，基于 SKU+分类 去重"""
        adapter = ItemAdapter(item)
        sku = adapter.get("sku_id", "")
        category_id = adapter.get("category_id", 0)
        
        if not sku:
            logger.warning("[去重管道] SKU为空，跳过")
            from scrapy.exceptions import DropItem
            raise DropItem("SKU为空")
        
        key = f"{sku}_{category_id}"
            
        if key in self.seen_keys:
            self.drop_count += 1
            from scrapy.exceptions import DropItem
            raise DropItem(f"重复记录: {sku} 在分类 {category_id}")
        
        self.seen_keys.add(key)
        self.process_count += 1
        
        return item

    def close_spider(self):
        """关闭时输出统计信息"""
        logger.info(f"[去重管道] 处理完成：总处理 {self.process_count} 条，丢弃 {self.drop_count} 条重复")


class MysqlPipeline:
    """
    MySQL管道：多分类关联存储（带缓冲区）
    
    缓冲区大小59条，接近每页商品数，保证每页数据及时入库。
    """

    @classmethod
    def from_crawler(cls, crawler):
        pipeline = cls(
            host=crawler.settings.get('MYSQL_HOST', '127.0.0.1'),
            user=crawler.settings.get('MYSQL_USER', 'root'),
            password=crawler.settings.get('MYSQL_PASSWORD', '123456'),
            db=crawler.settings.get('MYSQL_DB', 'jd_data'),
            port=crawler.settings.getint('MYSQL_PORT', 3306),
            charset=crawler.settings.get('MYSQL_CHARSET', 'utf8mb4'),
            buffer_size=crawler.settings.getint('MYSQL_BUFFER_SIZE', 59),
        )
        pipeline.crawler = crawler
        return pipeline

    def __init__(self, host, user, password, db, port, charset, buffer_size=59):
        self.host = host
        self.user = user
        self.password = password
        self.db = db
        self.port = port
        self.charset = charset
        self.buffer_size = buffer_size
        
        # 缓冲区
        self.product_buffer = []       # 商品缓冲区
        self.relation_buffer = []      # 关联缓冲区
        
        self.total_items = 0           # 总处理商品数
        self.new_products = 0          # 新商品数
        self.new_relations = 0         # 新关联数
        self.connection = None
        self.cursor = None

    def open_spider(self):
        """初始化数据库连接"""
        logger.info(f"[MySQL管道] 正在连接数据库: {self.host}:{self.port}/{self.db}")
        logger.info(f"[MySQL管道] 缓冲区大小: {self.buffer_size}")
        
        try:
            self.connection = pymysql.connect(
                host=self.host,
                user=self.user,
                password=self.password,
                database=self.db,
                port=self.port,
                charset=self.charset,
                autocommit=False,
            )
            self.cursor = self.connection.cursor()
            logger.info(f"[MySQL管道] 数据库连接成功")
            # 自动确保列表采集产出表存在（幂等，干净库首次运行即建表）
            ensure_product_links_table(self.cursor, self.connection)
            ensure_product_category_relation_table(self.cursor, self.connection)
            self._print_stats()
            
        except pymysql.MySQLError as e:
            logger.error(f"[MySQL管道] 连接失败: {e}")
            raise
    
    def _print_stats(self):
        """打印当前数据统计"""
        try:
            self.cursor.execute("SELECT COUNT(*) FROM product_links")
            products = self.cursor.fetchone()[0]
            
            self.cursor.execute("SELECT COUNT(*) FROM product_category_relation")
            relations = self.cursor.fetchone()[0]
            
            logger.info(f"[MySQL管道] 现有 {products} 个商品，{relations} 条分类关联")
            
        except pymysql.MySQLError:
            pass

    def process_item(self, item):
        """
        处理商品数据：添加到缓冲区，达到阈值时批量提交
        """
        adapter = ItemAdapter(item)
        sku_id = adapter.get("sku_id", "")
        
        if not sku_id:
            logger.warning("[MySQL管道] SKU为空，跳过")
            return item
        
        source_url = adapter.get("source_url", "")
        category_id = adapter.get("category_id", 0)
        
        # 添加到缓冲区
        self.product_buffer.append((sku_id, source_url))
        self.relation_buffer.append((sku_id, category_id))
        
        self.total_items += 1
        
        # 达到缓冲区阈值时提交
        if len(self.product_buffer) >= self.buffer_size:
            self._flush_buffers()
        
        return item

    def _ensure_connection(self):
        """确保连接可用；断开则重连（修复长时运行中途连接超时报错，健壮性 M4）。"""
        try:
            if self.connection is None or not getattr(self.connection, "open", False):
                self.open_spider()
            else:
                self.connection.ping(reconnect=True)
        except Exception:
            try:
                self.open_spider()
            except Exception as e:
                logger.error(f"[MySQL管道] 数据库重连失败: {e}")

    def _persist_pending(self, product_buffer, relation_buffer):
        """
        把未能入库的缓冲数据追加写入 pending 文件，避免静默丢失（健壮性 H2）。
        后续可通过重新运行列表采集恢复这些 SKU。
        """
        try:
            cat_map = {sku: cid for sku, cid in relation_buffer}
            rows = [
                {"sku_id": sku, "source_url": url, "category_id": cat_map.get(sku)}
                for sku, url in product_buffer
            ]
            if not rows:
                return
            with open(_PENDING_FILE, "a", encoding="utf-8") as f:
                for r in rows:
                    f.write(json.dumps(r, ensure_ascii=False) + "\n")
            logger.warning(
                f"[MySQL管道] {len(rows)} 条数据写入 {_PENDING_FILE}，可稍后重跑列表采集恢复"
            )
        except Exception as ex:
            logger.error(f"[MySQL管道] 落盘 pending 失败（数据可能丢失）: {ex}")

    def _flush_buffers(self):
        """批量提交缓冲区数据；失败时落盘 pending 文件，不再静默清空丢失。"""
        if not self.product_buffer:
            return
        
        try:
            self._ensure_connection()
            # 1. 批量写入商品
            self.cursor.executemany('''
                INSERT IGNORE INTO product_links (sku_id, source_url)
                VALUES (%s, %s)
            ''', self.product_buffer)
            self.new_products += self.cursor.rowcount
            
            # 2. 批量写入关联
            self.cursor.executemany('''
                INSERT IGNORE INTO product_category_relation (sku_id, category_id)
                VALUES (%s, %s)
            ''', self.relation_buffer)
            self.new_relations += self.cursor.rowcount
            
            self.connection.commit()
            
            logger.info(f"[MySQL管道] [OK] 提交 {len(self.product_buffer)} 条，累计新增 {self.new_products} 商品，{self.new_relations} 关联")
            
        except pymysql.MySQLError as e:
            logger.error(f"[MySQL管道] 批量写入失败: {e}")
            try:
                self.connection.rollback()
            except Exception:
                pass
            # 关键：不再静默丢弃，落盘以便恢复
            self._persist_pending(self.product_buffer, self.relation_buffer)
        
        finally:
            self.product_buffer.clear()
            self.relation_buffer.clear()

    def close_spider(self):
        """关闭爬虫时提交剩余数据"""
        # 提交剩余缓冲区
        if self.product_buffer:
            logger.info(f"[MySQL管道] 提交剩余 {len(self.product_buffer)} 条数据")
            self._flush_buffers()
        
        logger.info(f"[MySQL管道] 爬虫结束：处理 {self.total_items} 个商品，新增 {self.new_products} 个商品，新增 {self.new_relations} 条分类关联")
        
        if self.cursor:
            self.cursor.close()
        if self.connection:
            self.connection.close()
            logger.info("[MySQL管道] MySQL连接已关闭")
