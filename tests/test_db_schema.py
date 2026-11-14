# -*- coding: utf-8 -*-
"""db_schema 建表逻辑白盒测试（不依赖 DrissionPage / 真实 MySQL）。

用 tests/fakes 的 RecordingCursor / RecordingConnection 验证：
- 三张核心表的 CREATE TABLE IF NOT EXISTS 语句确实被发出；
- products.sku_id 唯一索引在"索引缺失"时创建、"已存在"时跳过；
- 唯一索引检测兼容 DictCursor（dict）与普通游标（tuple）两种 fetchone 返回；
- ensure_core_tables 覆盖全部核心表。

注意：大小写比较统一用小写（literal 已是小写，haystack 用 .lower()），避免大小写不匹配误判。
"""
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

from db_schema import (  # noqa: E402
    ensure_product_links_table,
    ensure_product_category_relation_table,
    ensure_products_table,
    ensure_core_tables,
    ensure_products_unique_skuid,
    CREATE_PRODUCT_LINKS_SQL,
    CREATE_PRODUCT_CATEGORY_RELATION_SQL,
    CREATE_PRODUCTS_SQL,
    ensure_category_progress_columns,
)
from fakes import RecordingCursor, RecordingConnection  # noqa: E402


class TestDbSchema(unittest.TestCase):
    def _make(self):
        return RecordingCursor(), RecordingConnection()

    def test_ddl_constants_well_formed(self):
        """三张表的建表语句常量必须是 IF NOT EXISTS 且 InnoDB。"""
        self.assertIn("product_links", CREATE_PRODUCT_LINKS_SQL)
        self.assertIn("product_category_relation", CREATE_PRODUCT_CATEGORY_RELATION_SQL)
        self.assertIn("products", CREATE_PRODUCTS_SQL)
        for sql in (CREATE_PRODUCT_LINKS_SQL, CREATE_PRODUCT_CATEGORY_RELATION_SQL, CREATE_PRODUCTS_SQL):
            self.assertIn("create table if not exists", sql.lower())
            self.assertIn("engine=innodb", sql.lower())

    def test_ensure_product_links_issues_create_and_commits(self):
        cur, conn = self._make()
        ensure_product_links_table(cur, conn)
        self.assertTrue(
            any("create table if not exists product_links" in c[1].lower() for c in cur.calls)
        )
        # CREATE 内部已 commit
        self.assertEqual(conn.committed, 1)

    def test_ensure_relation_issues_create(self):
        cur, conn = self._make()
        ensure_product_category_relation_table(cur, conn)
        self.assertTrue(
            any("create table if not exists product_category_relation" in c[1].lower() for c in cur.calls)
        )

    def test_ensure_products_table_creates_and_indexes(self):
        cur, conn = self._make()
        cur.push_fetchone({"cnt": 0})  # INFORMATION_SCHEMA：索引不存在 → 触发 ALTER
        ensure_products_table(cur, conn, "jd_data")
        creates = [c for c in cur.calls if "create table if not exists products" in c[1].lower()]
        self.assertEqual(len(creates), 1)
        alters = [c for c in cur.calls if "alter table products add unique key uk_sku_id" in c[1].lower()]
        self.assertEqual(len(alters), 1)

    def test_ensure_products_unique_skuid_dict_cursor(self):
        """DictCursor 返回 dict 时也能正确判断并创建索引。"""
        cur, conn = self._make()
        cur.push_fetchone({"cnt": 0})
        ensure_products_unique_skuid(cur, conn, "jd_data")
        self.assertTrue(any("add unique key uk_sku_id" in c[1].lower() for c in cur.calls))

    def test_ensure_products_unique_skuid_tuple_cursor(self):
        """普通游标返回 tuple 时同样能正确判断并创建索引（兼容 json_to_products）。"""
        cur, conn = self._make()
        cur.push_fetchone((0,))
        ensure_products_unique_skuid(cur, conn, "jd_data")
        self.assertTrue(any("add unique key uk_sku_id" in c[1].lower() for c in cur.calls))

    def test_ensure_products_unique_skuid_skips_when_exists(self):
        """索引已存在（cnt=1）时不发 ALTER，避免无谓报错。"""
        cur, conn = self._make()
        cur.push_fetchone({"cnt": 1})
        ensure_products_unique_skuid(cur, conn, "jd_data")
        self.assertFalse(any("add unique key" in c[1].lower() for c in cur.calls))

    def test_ensure_core_tables_covers_all(self):
        cur, conn = self._make()
        cur.push_fetchone({"cnt": 0})  # products 索引查询
        ensure_core_tables(cur, conn, "jd_data")
        sqls = " ".join(c[1].lower() for c in cur.calls)
        self.assertIn("create table if not exists product_links", sqls)
        self.assertIn("create table if not exists product_category_relation", sqls)
        self.assertIn("create table if not exists products", sqls)
        self.assertIn("create table if not exists crawl_session", sqls)


class TestCategoryProgressColumns(unittest.TestCase):
    """categories 续爬进度列：幂等补齐，缺列时 ALTER，已存在则跳过。"""

    def test_adds_missing_progress_columns(self):
        cur = RecordingCursor()
        conn = RecordingConnection()
        cur.push_fetchall([{"COLUMN_NAME": "id"}, {"COLUMN_NAME": "crawl_status"}])
        ensure_category_progress_columns(cur, conn, "jd_data")
        alters = [c[1].lower() for c in cur.calls if "alter table categories" in c[1].lower()]
        self.assertEqual(len(alters), 2)
        self.assertTrue(any("crawl_page" in a for a in alters))
        self.assertTrue(any("crawl_items" in a for a in alters))

    def test_skips_existing_progress_columns(self):
        cur = RecordingCursor()
        cur.push_fetchall([
            {"COLUMN_NAME": "crawl_page"}, {"COLUMN_NAME": "crawl_items"},
        ])
        ensure_category_progress_columns(cur, RecordingConnection(), "jd_data")
        self.assertFalse(any("alter table categories" in c[1].lower() for c in cur.calls))

    def test_skips_when_categories_table_absent(self):
        cur = RecordingCursor()
        cur.push_fetchall([])
        ensure_category_progress_columns(cur, RecordingConnection(), "jd_data")
        self.assertFalse(any("alter table categories" in c[1].lower() for c in cur.calls))


if __name__ == "__main__":
    unittest.main()
