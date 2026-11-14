# -*- coding: utf-8 -*-
"""白盒测试：pipelines 的去重与缓冲入库逻辑。"""
import os
import sys
import json
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import pymysql  # noqa: E402
from scrapy.exceptions import DropItem  # noqa: E402
from jdcrawler.items import JdItem  # noqa: E402
from jdcrawler.pipelines import JdPipeline, MysqlPipeline, _PENDING_FILE  # noqa: E402
from fakes import RecordingCursor, RecordingConnection  # noqa: E402


class TestJdPipeline(unittest.TestCase):
    """去重管道：基于 sku_id + category_id 组合。"""

    def setUp(self):
        # seen_keys 是类属性，测试间需重置，否则状态泄漏
        JdPipeline.seen_keys = set()

    def _item(self, sku, cat):
        return JdItem(sku_id=sku, category_id=cat, source_url=f"u{sku}", category_name="x")

    def test_first_pass_kept(self):
        p = JdPipeline()
        it = p.process_item(self._item("100", 5))
        self.assertIs(it, self._item) if False else self.assertEqual(it["sku_id"], "100")
        self.assertEqual(p.process_count, 1)

    def test_duplicate_dropped(self):
        p = JdPipeline()
        p.process_item(self._item("100", 5))
        with self.assertRaises(DropItem):
            p.process_item(self._item("100", 5))
        self.assertEqual(p.drop_count, 1)

    def test_same_sku_diff_category_kept(self):
        p = JdPipeline()
        p.process_item(self._item("100", 5))
        it = p.process_item(self._item("100", 6))  # 不同分类，允许
        self.assertEqual(it["category_id"], 6)

    def test_empty_sku_dropped(self):
        p = JdPipeline()
        with self.assertRaises(DropItem):
            p.process_item(JdItem(sku_id="", category_id=5))


class TestMysqlPipelineFlush(unittest.TestCase):
    """缓冲入库：正常提交与异常回滚（验证数据丢失风险）。"""

    def _make(self, buffer_size=59):
        p = MysqlPipeline.__new__(MysqlPipeline)
        p.host = "x"; p.user = "x"; p.password = "x"; p.db = "x"
        p.port = 3306; p.charset = "utf8mb4"; p.buffer_size = buffer_size
        p.product_buffer = []; p.relation_buffer = []
        p.total_items = 0; p.new_products = 0; p.new_relations = 0
        p.connection = RecordingConnection()
        p.cursor = RecordingCursor()
        return p

    def test_normal_flush(self):
        p = self._make()
        p.product_buffer = [("s1", "u1"), ("s2", "u2")]
        p.relation_buffer = [("s1", 5), ("s2", 6)]
        p._flush_buffers()
        # 两次 INSERT IGNORE（product_links / relation）
        sqls = [c[1] for c in p.cursor.calls if c[0] == "executemany"]
        self.assertEqual(len(sqls), 2)
        self.assertIn("INSERT IGNORE INTO product_links", sqls[0])
        self.assertIn("INSERT IGNORE INTO product_category_relation", sqls[1])
        self.assertEqual(p.connection.committed, 1)
        self.assertEqual(p.new_products, 2)
        self.assertEqual(p.new_relations, 2)
        # 关键：提交后缓冲区必须清空
        self.assertEqual(p.product_buffer, [])
        self.assertEqual(p.relation_buffer, [])

    def test_error_flush_persists_not_loses(self):
        """
        健壮性修复 H2 验证：当 executemany 抛 MySQLError 时，_flush_buffers 回滚后
        将缓冲数据落盘 pending_product_links.jsonl（不再静默清空丢失），缓冲区随后清空。
        """
        # 清理可能残留的 pending 文件，保证断言基于本测试写入的内容
        if os.path.exists(_PENDING_FILE):
            os.remove(_PENDING_FILE)

        p = self._make()
        p.product_buffer = [("s1", "u1")]
        p.relation_buffer = [("s1", 5)]
        p.cursor.raise_if_contains = "INSERT IGNORE INTO PRODUCT_LINKS"
        p.cursor._raise_cls = pymysql.MySQLError

        p._flush_buffers()  # 不应抛异常（内部已捕获）

        self.assertEqual(p.connection.rolledback, 1)
        self.assertEqual(p.new_products, 0)  # 计数未增加（正确）
        # 缓冲区已清空（避免重复提交）
        self.assertEqual(p.product_buffer, [])
        self.assertEqual(p.relation_buffer, [])
        # 关键：数据已落盘，可被恢复，而非静默丢失
        self.assertTrue(os.path.exists(_PENDING_FILE), "pending 文件应已生成")
        with open(_PENDING_FILE, "r", encoding="utf-8") as f:
            lines = [ln for ln in f.read().splitlines() if ln.strip()]
        self.assertEqual(len(lines), 1)
        row = json.loads(lines[0])
        self.assertEqual(row["sku_id"], "s1")
        self.assertEqual(row["source_url"], "u1")
        self.assertEqual(row["category_id"], 5)

        # 清理，避免污染仓库
        if os.path.exists(_PENDING_FILE):
            os.remove(_PENDING_FILE)

    def test_process_item_buffers_until_threshold(self):
        p = self._make(buffer_size=2)
        p.process_item(JdItem(sku_id="1", category_id=1, source_url="u", category_name="x"))
        self.assertEqual(len(p.product_buffer), 1)
        p.process_item(JdItem(sku_id="2", category_id=1, source_url="u", category_name="x"))
        # 达到阈值，自动 flush
        self.assertEqual(len(p.product_buffer), 0)
        self.assertEqual(p.new_products, 2)


if __name__ == "__main__":
    unittest.main()
