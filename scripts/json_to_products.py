# -*- coding: utf-8 -*-
"""
京东商品详情 JSON 数据导入 MySQL 数据库

功能：
1. 将 jd_product_detail.py 爬取的 JSON 数据导入到 products 表
2. 图片同时存 URL 与本地路径（download_images 开启时本地路径生效，否则本地路径为空）
3. 自动处理 JSON 中的特殊字符

使用方法：
1. 导入单个 JSON 文件：
   python json_to_products.py --file data/100012043978/product_100012043978.json

2. 批量导入 data 目录下所有商品：
   python json_to_products.py --dir data

3. 查看统计：
   python json_to_products.py --stats
"""

import sys
import os
import json
import argparse
from datetime import datetime
from typing import Dict, List, Optional

import pymysql

# 项目根目录：本文件位于 scripts/ 下，其父目录即项目根。
# 离线导入的默认 --dir data 统一解析到项目根，避免依赖 cwd 生成 scripts/data 错位目录。
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 添加 jdcrawler 目录到路径，导入 settings 与状态常量
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'jdcrawler'))

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
    MYSQL_HOST = '127.0.0.1'
    MYSQL_USER = 'root'
    MYSQL_PASSWORD = '123456'
    MYSQL_DB = 'jd_data'
    MYSQL_PORT = 3306
    MYSQL_CHARSET = 'utf8mb4'

# 公共入库逻辑（修复 M3/M5）：字段提取、按表结构动态截断、UPSERT 统一维护
from product_persist import (
    PRODUCT_COLUMNS,
    PRODUCT_UPSERT,
    get_product_column_limits,
    build_product_values,
    upsert_product,
    extract_gallery_urls,
    clean_text,
)
# 运行会话记录（健壮性 L3）
from crawl_session import ensure_session_table, start_session, finish_session


class JsonToProductsImporter:
    """JSON 数据导入 products 表"""
    
    def __init__(self):
        self.connection = None
        self.cursor = None
        self.host = MYSQL_HOST
        self.user = MYSQL_USER
        self.password = MYSQL_PASSWORD
        self.db = MYSQL_DB
        self.port = MYSQL_PORT
        self.charset = MYSQL_CHARSET
        
        self.total_imported = 0
        self.total_skipped = 0
        self.total_errors = 0
    
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
                autocommit=False
            )
            self.cursor = self.connection.cursor()
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
    
    def init_products_table(self):
        """创建/补全 products 表以兼容 JSON 数据。

        表不存在时统一由 db_schema.ensure_products_table 创建（与详情采集包装器
        共用同一份 DDL，避免两份定义漂移）；表已存在时仅补齐历史缺失列。
        """
        try:
            # 先检查表是否存在
            self.cursor.execute("SHOW TABLES LIKE 'products'")
            table_exists = self.cursor.fetchone() is not None

            if table_exists:
                # 表已存在，仅补齐历史缺失列（兼容旧表）
                self.cursor.execute("DESCRIBE products")
                existing_columns = {row[0] for row in self.cursor.fetchall()}

                columns_to_add = {
                    'sku_id': "ALTER TABLE products ADD COLUMN sku_id VARCHAR(50) COMMENT '商品SKU ID' AFTER id",
                    'skus_json': "ALTER TABLE products ADD COLUMN skus_json JSON COMMENT 'SKU列表JSON' AFTER tags_json",
                    'comments_json': "ALTER TABLE products ADD COLUMN comments_json JSON COMMENT '评论JSON' AFTER skus_json",
                }
                for col_name, alter_sql in columns_to_add.items():
                    if col_name not in existing_columns:
                        try:
                            self.cursor.execute(alter_sql)
                            print(f"[初始化] 添加列 {col_name} 成功")
                        except pymysql.MySQLError as e:
                            print(f"[初始化] 添加列 {col_name} 失败（可能已存在）: {e}")
                self.connection.commit()
                # 确保 sku_id 唯一索引（幂等写入/重入前提，修复 M1/M2）
                self.ensure_products_unique_skuid()
                print("[初始化] products 表已更新，添加了缺失的列")
            else:
                # 表不存在：统一交由 db_schema 创建（含 sku_id 唯一索引），
                # 与 detail_crawler_wrapper 共用同一份 DDL，杜绝定义漂移
                from db_schema import ensure_products_table
                ensure_products_table(self.cursor, self.connection, self.db)
                print("[初始化] products 表创建成功")
        except pymysql.MySQLError as e:
            print(f"[初始化] 创建/修改表失败: {e}")
    
    def ensure_products_unique_skuid(self):
        """
        确保 products 表对 sku_id 有唯一索引（幂等写入/重入的前提，健壮性 M1/M2）。
        若已存在重复 sku，ALTER 会失败，此时仅告警不阻塞（需先手动去重）。
        """
        try:
            self.cursor.execute(
                "SELECT COUNT(1) FROM INFORMATION_SCHEMA.STATISTICS "
                "WHERE TABLE_SCHEMA = %s AND TABLE_NAME = 'products' AND INDEX_NAME = 'uk_sku_id'",
                (self.db,),
            )
            if self.cursor.fetchone()[0] == 0:
                self.cursor.execute("ALTER TABLE products ADD UNIQUE KEY uk_sku_id (sku_id)")
                self.connection.commit()
                print("[初始化] 已为 products.sku_id 添加唯一索引 uk_sku_id")
        except pymysql.MySQLError as e:
            print(f"[初始化] 确保 uk_sku_id 失败（若已存在重复 sku，请先手动去重）: {e}")
    
    def _clean_text(self, text: str) -> str:
        """清理文本，移除特殊字符（委托 product_persist.clean_text，修复 M5）"""
        return clean_text(text)

    def _extract_image_urls(self, gallery_json: List) -> List[str]:
        """从 gallery_json 中提取所有图片 URL（委托 product_persist.extract_gallery_urls，修复 M5）"""
        return extract_gallery_urls(gallery_json)
    
    def _check_relation_table_exists(self) -> bool:
        """检查 product_category_relation 表是否存在"""
        try:
            self.cursor.execute("SHOW TABLES LIKE 'product_category_relation'")
            return self.cursor.fetchone() is not None
        except pymysql.MySQLError:
            return False
    
    def _show_relation_table_structure(self):
        """显示 product_category_relation 表结构（调试用）"""
        try:
            if not self._check_relation_table_exists():
                print("[调试] product_category_relation 表不存在")
                return
            
            self.cursor.execute("DESCRIBE product_category_relation")
            columns = self.cursor.fetchall()
            print("[调试] product_category_relation 表结构:")
            for col in columns:
                print(f"  - {col['Field']}: {col['Type']}")
        except pymysql.MySQLError as e:
            print(f"[调试] 获取表结构失败: {e}")
    
    def _get_category_id_from_relation(self, sku_id: str) -> Optional[int]:
        """
        从 product_category_relation 表获取 category_id
        
        Args:
            sku_id: 商品SKU ID
            
        Returns:
            category_id 或 None
        """
        try:
            # 检查表是否存在
            if not self._check_relation_table_exists():
                print(f"[调试] product_category_relation 表不存在，跳过")
                return None

            print(f"[调试] 查询 product_category_relation 表，sku_id={sku_id}")
            
            self.cursor.execute(
                "SELECT category_id FROM product_category_relation WHERE sku_id = %s LIMIT 1",
                (sku_id,)
            )
            result = self.cursor.fetchone()
            print(f"[调试] 查询结果: {result}")
            if result:
                # 普通游标返回元组，需要根据索引获取
                if isinstance(result, tuple):
                    category_id = result[0]
                else:
                    category_id = result['category_id']
                print(f"[调试] 获取到 category_id: {category_id}")
                return category_id
        except pymysql.MySQLError as e:
            print(f"[错误] 查询 product_category_relation 失败: {e}")
        except Exception as e:
            print(f"[错误] 未知错误: {e}")
        return None
    
    def import_json_file(self, file_path: str, use_relation_category: bool = True) -> bool:
        """
        导入单个 JSON 文件到 products 表（幂等：冲突时按 sku_id 更新，修复 M1/M2）。

        字段提取 / 动态截断 / 组装统一委托 product_persist（修复 M3/M5）。
        """
        try:
            # 读取 JSON 文件
            with open(file_path, 'r', encoding='utf-8') as f:
                data = json.load(f)

            sku_id = data.get('sku_id', '')
            if not sku_id:
                print(f"[跳过] SKU ID 为空: {file_path}")
                self.total_skipped += 1
                return False

            # 按表结构动态获取列长度上限（修复 M3），超长自动截断并告警
            limits = get_product_column_limits(self.cursor, self.db)

            # 优先从 product_links 取 id（双路径一致：products.id = product_links.id）
            self.cursor.execute("SELECT id FROM product_links WHERE sku_id = %s", (sku_id,))
            link_result = self.cursor.fetchone()
            product_id = link_result[0] if link_result else None

            # 获取 category_id：优先 relation 表
            category_id = None
            if use_relation_category:
                category_id = self._get_category_id_from_relation(sku_id)
            if category_id is None:
                category_id = data.get('category_id')

            # 统一组装字段并执行幂等写入（修复 M5）
            values = build_product_values(data, category_id, limits, warn=print)
            upsert_product(self.cursor, product_id, values)
            self.total_imported += 1
            print(f"[导入] SKU {sku_id}: {data.get('title', '')[:30]}...")
            return True

        except json.JSONDecodeError as e:
            print(f"[错误] JSON 解析失败 {file_path}: {e}")
            self.total_errors += 1
            return False
        except pymysql.MySQLError as e:
            print(f"[错误] 数据库错误 {file_path}: {e}")
            self.total_errors += 1
            return False
        except Exception as e:
            print(f"[错误] 未知错误 {file_path}: {e}")
            self.total_errors += 1
            return False
    
    def import_directory(self, dir_path: str, batch_size: int = 50, use_relation_category: bool = True):
        """
        批量导入目录下所有 JSON 文件（离线模式，不依赖 DrissionPage）。
        字段组装委托 product_persist（修复 M5）；记录运行会话（健壮性 L3）。
        """
        if not os.path.isdir(dir_path):
            print(f"[错误] 目录不存在: {dir_path}")
            return

        # 收集所有 JSON 文件
        json_files = []
        for root, dirs, files in os.walk(dir_path):
            for file in files:
                if file.startswith('product_') and file.endswith('.json'):
                    json_files.append(os.path.join(root, file))

        if not json_files:
            print(f"[警告] 目录中没有找到商品 JSON 文件: {dir_path}")
            return

        print(f"\n[批量导入] 找到 {len(json_files)} 个 JSON 文件")
        print(f"[批量导入] 目录: {dir_path}")
        print(f"[批量导入] 批量大小: {batch_size}")
        print("=" * 60)

        # 动态列长度上限（一次获取，缓存到 cursor）
        limits = get_product_column_limits(self.cursor, self.db)

        # 记录会话（健壮性 L3）
        ensure_session_table(self.cursor, self.connection)
        session_id = start_session(self.cursor, self.connection, 'json_import', note=f"dir={dir_path}")

        buffer = []
        success = 0
        failed = 0

        for idx, file_path in enumerate(json_files, 1):
            try:
                with open(file_path, 'r', encoding='utf-8') as f:
                    data = json.load(f)

                sku_id = data.get('sku_id', '')
                if not sku_id:
                    continue

                self.cursor.execute("SELECT id FROM product_links WHERE sku_id = %s", (sku_id,))
                link_result = self.cursor.fetchone()
                product_id = link_result[0] if link_result else None

                # 获取 category_id：优先 relation 表
                category_id = None
                if use_relation_category:
                    category_id = self._get_category_id_from_relation(sku_id)
                if category_id is None:
                    category_id = data.get('category_id')

                # 统一组装字段（修复 M5）
                values = build_product_values(data, category_id, limits, warn=print)
                if product_id:
                    buffer.append((product_id,) + values)   # 24 字段（含 id）
                else:
                    buffer.append(values)                  # 23 字段
                self.total_imported += 1
                success += 1

                # 批量提交
                if len(buffer) >= batch_size:
                    self._flush_buffer(buffer)
                    buffer = []

                if idx % 100 == 0:
                    print(f"[进度] 已处理 {idx}/{len(json_files)} 个文件")

            except Exception as e:
                failed += 1
                print(f"[错误] 处理失败 {file_path}: {e}")
                continue

        # 提交剩余数据
        if buffer:
            self._flush_buffer(buffer)

        finish_session(self.cursor, self.connection, session_id,
                       total=len(json_files), success=success, failed=failed)

        print("=" * 60)
        print(f"[完成] 共处理 {len(json_files)} 个文件")
        print(f"  导入成功: {self.total_imported}")
        print(f"  跳过: {self.total_skipped}")
        print(f"  错误: {self.total_errors}")

    def _flush_buffer(self, buffer: List):
        """批量提交缓冲区数据（幂等 UPSERT，修复 M1/M2/M5）。"""
        if not buffer:
            return

        try:
            records_with_id = []     # 24 字段（含 id）
            records_without_id = []  # 23 字段（不含 id）

            for item in buffer:
                if len(item) == 24:
                    records_with_id.append(item)
                else:
                    records_without_id.append(item)

            cols = ", ".join(PRODUCT_COLUMNS)
            placeholders = ", ".join(["%s"] * len(PRODUCT_COLUMNS))

            if records_with_id:
                sql = f"INSERT INTO products (id, {cols}) VALUES (%s, {placeholders}) {PRODUCT_UPSERT}"
                self.cursor.executemany(sql, records_with_id)
                print(f"[提交] 批量提交 {len(records_with_id)} 条带ID数据")

            if records_without_id:
                sql = f"INSERT INTO products ({cols}) VALUES ({placeholders}) {PRODUCT_UPSERT}"
                self.cursor.executemany(sql, records_without_id)
                print(f"[提交] 批量提交 {len(records_without_id)} 条无ID数据")

            self.connection.commit()
            print(f"[提交] 共提交 {len(buffer)} 条数据")

            # 更新 product_links 的 crawl_status（标记已入库）
            sku_ids = [rec[1] if len(rec) == 24 else rec[0] for rec in buffer]
            if sku_ids:
                placeholders_in = ','.join(['%s'] * len(sku_ids))
                sql_update = f"UPDATE product_links SET crawl_status = 1 WHERE sku_id IN ({placeholders_in})"
                self.cursor.execute(sql_update, tuple(sku_ids))
                self.connection.commit()
                print(f"[状态更新] 已更新 {self.cursor.rowcount} 条记录的 crawl_status")

        except pymysql.MySQLError as e:
            print(f"[错误] 批量提交失败: {e}")
            self.connection.rollback()
    
    def show_stats(self):
        """显示数据库统计"""
        try:
            self.cursor.execute("SELECT COUNT(*) as total FROM products")
            total = self.cursor.fetchone()[0]
            
            self.cursor.execute("SELECT COUNT(*) FROM products WHERE cover_image != ''")
            with_cover = self.cursor.fetchone()[0]
            
            self.cursor.execute("SELECT COUNT(*) FROM products WHERE gallery_json != '[]'")
            with_gallery = self.cursor.fetchone()[0]
            
            self.cursor.execute("SELECT COUNT(*) FROM products WHERE comments_json != '[]'")
            with_comments = self.cursor.fetchone()[0]
            
            print("\n" + "="*60)
            print("products 表统计")
            print("="*60)
            print(f"  总记录数: {total}")
            print(f"  有封面图: {with_cover}")
            print(f"  有轮播图: {with_gallery}")
            print(f"  有评论: {with_comments}")
            print("="*60 + "\n")
            
        except pymysql.MySQLError as e:
            print(f"[错误] 查询统计失败: {e}")


def main():
    """主函数"""
    parser = argparse.ArgumentParser(description='京东商品详情 JSON 导入 MySQL')
    parser.add_argument('--file', type=str, help='单个 JSON 文件路径')
    parser.add_argument('--dir', type=str, default='data', help='批量导入目录（默认 data）')
    parser.add_argument('--batch', type=int, default=50, help='批量提交大小（默认 50）')
    parser.add_argument('--init', action='store_true', help='初始化 products 表')
    parser.add_argument('--stats', action='store_true', help='显示统计信息')
    
    args = parser.parse_args()

    # 批量导入目录：相对路径统一解析到项目根，避免 cwd 依赖导致的错位
    import_dir = args.dir if os.path.isabs(args.dir) else os.path.join(PROJECT_ROOT, args.dir)

    # 创建导入器
    importer = JsonToProductsImporter()
    
    try:
        # 连接数据库
        if not importer.connect():
            return
        
        # 初始化表
        if args.init:
            importer.init_products_table()
            print("[完成] 表初始化完成")
            return
        
        # 显示统计
        if args.stats:
            importer.show_stats()
            return
        
        # 导入单个文件
        if args.file:
            if not importer.import_json_file(args.file):
                sys.exit(1)
            importer.connection.commit()
            print(f"\n[完成] 导入成功: {importer.total_imported}, 跳过: {importer.total_skipped}")
            return
        
        # 批量导入目录
        importer.import_directory(import_dir, batch_size=args.batch, use_relation_category=True)
        importer.show_stats()
        
    finally:
        importer.close()


if __name__ == "__main__":
    main()
