# -*- coding: utf-8 -*-
"""
数据库连接模块（复用 jdcrawler/settings.py 配置）
功能：连接数据库，获取未爬取的商品URL，标记URL状态
"""

import pymysql
import sys
import os
from typing import List, Dict, Optional

# 将项目根目录加入 sys.path，确保从任意目录运行时都能导入 jdcrawler 包
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

try:
    from jdcrawler.settings import (
        MYSQL_HOST,
        MYSQL_USER,
        MYSQL_PASSWORD,
        MYSQL_DB,
        MYSQL_PORT,
        MYSQL_CHARSET
    )
except ImportError:
    # 备用配置
    MYSQL_HOST = '127.0.0.1'
    MYSQL_USER = 'root'
    MYSQL_PASSWORD = '123456'
    MYSQL_DB = 'jd_data'
    MYSQL_PORT = 3306
    MYSQL_CHARSET = 'utf8mb4'

# 状态枚举（健壮性 L4）
from jdcrawler.status_constants import DetailStatus
# 运行会话记录（健壮性 L3）
from crawl_session import ensure_session_table, start_session, finish_session


class DatabaseConnection:
    """数据库连接管理类"""
    
    def __init__(self):
        self.connection = None
        self.cursor = None
        self.host = MYSQL_HOST
        self.user = MYSQL_USER
        self.password = MYSQL_PASSWORD
        self.db = MYSQL_DB
        self.port = MYSQL_PORT
        self.charset = MYSQL_CHARSET
        # 表字段存在性缓存（健壮性 L2）：避免每条 SKU 重复 SHOW COLUMNS
        self._schema_cache: Dict = {}

    def connect(self) -> bool:
        """连接数据库"""
        try:
            self.connection = pymysql.connect(
                host=self.host,
                user=self.user,
                password=self.password,
                database=self.db,
                port=self.port,
                charset=self.charset,
                autocommit=True
            )
            self.cursor = self.connection.cursor(pymysql.cursors.DictCursor)
            print(f"[数据库] 连接成功: {self.host}:{self.port}/{self.db}")
            return True
        except pymysql.MySQLError as e:
            print(f"[数据库] 连接失败: {e}")
            return False
    
    def close(self):
        """关闭数据库连接"""
        if self.cursor:
            self.cursor.close()
        if self.connection:
            self.connection.close()
        print("[数据库] 连接已关闭")

    def _ensure_connection(self):
        """
        确保连接可用；断开则重连（修复长时批量爬取中途 MySQL 连接超时导致的失败，健壮性 M4）。
        """
        try:
            if self.connection is None or not getattr(self.connection, "open", False):
                return self.connect()
            self.connection.ping(reconnect=True)
            return True
        except Exception:
            try:
                return self.connect()
            except Exception:
                return False

    def _has_column(self, table: str, column: str) -> bool:
        """缓存表字段存在性（健壮性 L2）：避免每条 SKU 重复 SHOW COLUMNS。

        table 为项目内固定表名（可信），直接拼接；column 由参数传入用于 LIKE。
        """
        key = (table, column)
        if key in self._schema_cache:
            return self._schema_cache[key]
        try:
            self._ensure_connection()
            self.cursor.execute(f"SHOW COLUMNS FROM {table} LIKE %s", (column,))
            exists = self.cursor.fetchone() is not None
        except pymysql.MySQLError:
            exists = False
        self._schema_cache[key] = exists
        return exists

    def ensure_products_unique_skuid(self):
        """
        确保 products 表对 sku_id 有唯一索引（幂等写入/重入的前提，健壮性 M1/M2）。
        若已存在重复 sku，ALTER 会失败，此时仅告警不阻塞（需先手动去重）。
        """
        try:
            self._ensure_connection()
            self.cursor.execute(
                "SELECT COUNT(1) AS cnt FROM INFORMATION_SCHEMA.STATISTICS "
                "WHERE TABLE_SCHEMA = %s AND TABLE_NAME = 'products' AND INDEX_NAME = 'uk_sku_id'",
                (self.db,),
            )
            if self.cursor.fetchone()['cnt'] == 0:
                self.cursor.execute("ALTER TABLE products ADD UNIQUE KEY uk_sku_id (sku_id)")
                self.connection.commit()
                print("[数据库] 已为 products.sku_id 添加唯一索引 uk_sku_id")
        except pymysql.MySQLError as e:
            print(f"[数据库] 确保 uk_sku_id 失败（若已存在重复 sku，请先手动去重）: {e}")
    
    # ---- 核心表自动创建（完善数据库初始化，修复 SETUP 文档与代码不符的缺口）----
    def ensure_product_links_table(self):
        """确保 product_links 表存在（列表采集产出表）。"""
        from db_schema import ensure_product_links_table as _f
        _f(self.cursor, self.connection)

    def ensure_product_category_relation_table(self):
        """确保 product_category_relation 表存在（列表采集关联表）。"""
        from db_schema import ensure_product_category_relation_table as _f
        _f(self.cursor, self.connection)

    def ensure_products_table(self):
        """确保 products 表存在并补齐 sku_id 唯一索引（详情入库依赖）。"""
        from db_schema import ensure_products_table as _f
        _f(self.cursor, self.connection, self.db)

    def ensure_core_tables(self):
        """确保全部核心表存在：product_links / product_category_relation / products / crawl_session。

        在详情采集 init() 与 --init-db 中调用，使干净库上 --db/--url/--stats 均可直接工作。
        """
        from db_schema import ensure_core_tables as _f
        _f(self.cursor, self.connection, self.db)

    def get_uncrawled_urls(self, limit: int = 10, status: int = DetailStatus.PENDING) -> List[Dict]:
        """
        获取未爬取的商品URL

        Args:
            limit: 返回数量限制
            status: 详情状态（见 jdcrawler.status_constants.DetailStatus），
                    默认 PENDING(0) 待爬取；retry 时传入 FAILED(2)

        Returns:
            [{'id': 1, 'sku_id': 'xxx', 'source_url': 'xxx'}, ...]
        """
        try:
            self._ensure_connection()
            has_column = self._has_column('product_links', 'detail_status')

            if has_column:
                # 使用 detail_status 字段
                sql = """
                    SELECT id, sku_id, source_url 
                    FROM product_links 
                    WHERE detail_status = %s 
                    ORDER BY id ASC 
                    LIMIT %s
                """
            else:
                # 兼容旧表，假设都是未爬取
                sql = """
                    SELECT id, sku_id, source_url 
                    FROM product_links 
                    ORDER BY id ASC 
                    LIMIT %s
                """
                status = None
            
            if status is not None:
                self.cursor.execute(sql, (status, limit))
            else:
                self.cursor.execute(sql, (limit,))
            
            results = self.cursor.fetchall()
            print(f"[数据库] 获取到 {len(results)} 个未爬取URL")
            return results
        except pymysql.MySQLError as e:
            print(f"[数据库] 查询失败: {e}")
            return []
    
    def update_crawl_status(self, link_id: int, status: int, error_msg: str = None) -> bool:
        """
        更新URL爬取状态

        Args:
            link_id: product_links 表的 id
            status: 详情状态（见 jdcrawler.status_constants.DetailStatus）
            error_msg: 错误信息（失败时记录）

        Returns:
            是否更新成功（健壮性 M7：向调用方返回失败信号，而非静默吞掉）
        """
        try:
            self._ensure_connection()
            has_column = self._has_column('product_links', 'detail_status')

            if has_column:
                if error_msg:
                    sql = """
                        UPDATE product_links
                        SET detail_status = %s,
                            detail_error = %s,
                            detail_crawled_at = NOW()
                        WHERE id = %s
                    """
                    self.cursor.execute(sql, (status, error_msg, link_id))
                else:
                    sql = """
                        UPDATE product_links
                        SET detail_status = %s,
                            detail_crawled_at = NOW()
                        WHERE id = %s
                    """
                    self.cursor.execute(sql, (status, link_id))
                self.connection.commit()
                print(f"[数据库] 更新ID={link_id} 状态={status}")
                return True
            else:
                print("[数据库] 表中无 detail_status 字段，跳过状态更新")
                return False
        except pymysql.MySQLError as e:
            print(f"[数据库] 更新失败: {e}")
            return False

    def add_detail_status_column(self):
        """为 product_links 表添加详情爬取状态字段"""
        try:
            # 检查并添加 detail_status 字段
            if not self._has_column('product_links', 'detail_status'):
                self.cursor.execute("""
                    ALTER TABLE product_links
                    ADD COLUMN detail_status TINYINT DEFAULT 0 COMMENT '详情状态：0未爬取，1已爬取，2失败'
                """)
                print("[数据库] 添加字段 detail_status 成功")

            # 检查并添加 detail_crawled_at 字段
            if not self._has_column('product_links', 'detail_crawled_at'):
                self.cursor.execute("""
                    ALTER TABLE product_links
                    ADD COLUMN detail_crawled_at DATETIME NULL COMMENT '详情爬取时间'
                """)
                print("[数据库] 添加字段 detail_crawled_at 成功")

            # 检查并添加 detail_error 字段
            if not self._has_column('product_links', 'detail_error'):
                self.cursor.execute("""
                    ALTER TABLE product_links
                    ADD COLUMN detail_error TEXT NULL COMMENT '详情爬取错误信息'
                """)
                print("[数据库] 添加字段 detail_error 成功")

            print("[数据库] 详情状态字段添加完成")
        except pymysql.MySQLError as e:
            print(f"[数据库] 添加字段失败: {e}")

    # ---- 运行会话记录（健壮性 L3）----
    def ensure_crawl_session_table(self):
        """确保 crawl_session 表存在。"""
        ensure_session_table(self.cursor, self.connection)

    def start_session(self, run_type: str, note: str = '') -> Optional[int]:
        """开始一条采集会话，返回 session_id。"""
        return start_session(self.cursor, self.connection, run_type, note)

    def finish_session(self, session_id: Optional[int], total: int = 0,
                       success: int = 0, failed: int = 0, note: str = '') -> None:
        """结束会话：更新成功/失败计数。"""
        finish_session(self.cursor, self.connection, session_id, total, success, failed, note)

    def get_total_stats(self) -> Dict:
        """获取统计信息"""
        try:
            # 检查是否有 detail_status
            has_column = self._has_column('product_links', 'detail_status')

            if has_column:
                self.cursor.execute("""
                    SELECT 
                        COUNT(*) as total,
                        SUM(CASE WHEN detail_status = 0 THEN 1 ELSE 0 END) as uncrawled,
                        SUM(CASE WHEN detail_status = 1 THEN 1 ELSE 0 END) as crawled,
                        SUM(CASE WHEN detail_status = 2 THEN 1 ELSE 0 END) as failed
                    FROM product_links
                """)
            else:
                self.cursor.execute("""
                    SELECT 
                        COUNT(*) as total,
                        COUNT(*) as uncrawled,
                        0 as crawled,
                        0 as failed
                    FROM product_links
                """)
            
            result = self.cursor.fetchone()
            return result
        except pymysql.MySQLError as e:
            print(f"[数据库] 查询统计失败: {e}")
            return {'total': 0, 'uncrawled': 0, 'crawled': 0, 'failed': 0}
