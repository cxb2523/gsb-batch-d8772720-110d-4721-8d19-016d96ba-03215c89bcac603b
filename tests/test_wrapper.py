# -*- coding: utf-8 -*-
"""白盒测试：detail_crawler_wrapper._save_to_db 的图片提取与异常回滚。"""
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import pymysql  # noqa: E402
from detail_crawler_wrapper import DetailCrawlerWrapper  # noqa: E402
from fakes import FakeDb  # noqa: E402


class TestSaveToDb(unittest.TestCase):

    def setUp(self):
        self.wrapper = DetailCrawlerWrapper.__new__(DetailCrawlerWrapper)
        self.wrapper.db = FakeDb()

    def _save(self, product_data, fetchone_queue):
        self.wrapper.db.cursor.fetchone_queue = list(fetchone_queue)
        return self.wrapper._save_to_db(product_data)

    def test_empty_product_data(self):
        self.assertFalse(self._save(None, []))
        self.assertFalse(self._save({}, []))

    def test_save_new_product(self):
        """全新商品：product_links 无记录、relation 无匹配，走无 id 分支。"""
        pd = {
            "sku_id": "555",
            "title": "测试商品",
            "category_id": 9,
            "price": 99.0,
            "gallery_json": [],
        }
        ok = self._save(pd, [None, None])
        self.assertTrue(ok)
        self.assertEqual(self.wrapper.db.connection.committed, 1)
        insert_calls = [c for c in self.wrapper.db.cursor.calls if c[0] == "execute" and "INSERT INTO products" in c[1]]
        self.assertEqual(len(insert_calls), 1)
        values = insert_calls[0][2]
        self.assertEqual(values[0], "555")
        self.assertEqual(values[3], 9)

    def test_existing_product_upserted(self):
        """products 表已存在该 sku => 幂等 upsert（仍执行一次 INSERT，冲突时更新而非重复插入）。"""
        pd = {"sku_id": "555", "title": "x", "category_id": 7}
        # fetchone 队列: SELECT id FROM product_links -> 555 ; SELECT category_id -> 7
        ok = self._save(pd, [{"id": 555}, {"category_id": 7}])
        self.assertTrue(ok)
        insert_calls = [c for c in self.wrapper.db.cursor.calls if c[0] == "execute" and "INSERT INTO products" in c[1]]
        self.assertEqual(len(insert_calls), 1)
        # 带 id 分支：params[0]=product_id(555), params[1]=sku("555")
        self.assertEqual(insert_calls[0][2][0], 555)
        self.assertEqual(insert_calls[0][2][1], "555")
        # SQL 应含幂等子句
        self.assertIn("ON DUPLICATE KEY UPDATE", insert_calls[0][1])

    def test_db_error_rollback(self):
        """INSERT 抛异常 => 回滚并返回 False。"""
        self.wrapper.db.cursor.raise_if_contains = "INSERT INTO PRODUCTS"
        self.wrapper.db.cursor._raise_cls = pymysql.MySQLError
        pd = {"sku_id": "555", "title": "x", "category_id": 9}
        ok = self._save(pd, [None, None])
        self.assertFalse(ok)
        self.assertEqual(self.wrapper.db.connection.rolledback, 1)

    def test_gallery_1440_preference(self):
        """列表项含 1440 尺寸时优先采用，其余尺寸丢弃（验证既有逻辑）。"""
        pd = {
            "sku_id": "777",
            "title": "x",
            "category_id": 1,
            "gallery_json": [
                [{"size": "1440", "url": "big.jpg"}, {"size": "750", "url": "small.jpg"}],
                {"url": "c.jpg"},
            ],
        }
        ok = self._save(pd, [None, None])
        self.assertTrue(ok)
        insert_calls = [c for c in self.wrapper.db.cursor.calls if c[0] == "execute" and "INSERT INTO products" in c[1]]
        values = insert_calls[0][2]
        gallery = __import__("json").loads(values[6])  # gallery_json 是第 7 列(索引 6)
        urls = [g["url"] for g in gallery]
        self.assertEqual(urls, ["big.jpg", "c.jpg"])


if __name__ == "__main__":
    unittest.main()
