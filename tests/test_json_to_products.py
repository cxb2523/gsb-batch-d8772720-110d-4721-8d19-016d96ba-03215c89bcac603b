# -*- coding: utf-8 -*-
"""白盒测试：json_to_products 的文本清洗、图片提取与 JSON 入库逻辑。"""
import os
import sys
import json
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import json_to_products  # noqa: E402
from fakes import RecordingCursor, RecordingConnection  # noqa: E402


class TestCleanText(unittest.TestCase):
    def setUp(self):
        self.imp = json_to_products.JsonToProductsImporter()

    def test_none(self):
        self.assertEqual(self.imp._clean_text(None), "")

    def test_control_chars_removed(self):
        self.assertEqual(self.imp._clean_text("\x00ab\x01\x7fcd"), "abcd")

    def test_strip(self):
        self.assertEqual(self.imp._clean_text("  hi  "), "hi")

    def test_normal(self):
        self.assertEqual(self.imp._clean_text("华为 Mate 60"), "华为 Mate 60")


class TestExtractImageUrls(unittest.TestCase):
    def setUp(self):
        self.imp = json_to_products.JsonToProductsImporter()

    def test_video_skipped(self):
        gallery = [
            {"type": "video", "url": "v.mp4"},
            {"type": "img", "url": "u1.jpg"},
        ]
        self.assertEqual(self.imp._extract_image_urls(gallery), ["u1.jpg"])

    def test_dict_with_url(self):
        self.assertEqual(self.imp._extract_image_urls([{"url": "u2.jpg"}]), ["u2.jpg"])

    def test_nested_list(self):
        gallery = [[{"type": "img", "url": "u3.jpg"}]]
        self.assertEqual(self.imp._extract_image_urls(gallery), ["u3.jpg"])

    def test_empty(self):
        self.assertEqual(self.imp._extract_image_urls([]), [])


class TestImportJsonFile(unittest.TestCase):
    def setUp(self):
        self.imp = json_to_products.JsonToProductsImporter()
        self.imp.cursor = RecordingCursor()
        self.imp.connection = RecordingConnection()
        self.tmp = None

    def tearDown(self):
        if self.tmp and os.path.exists(self.tmp):
            os.remove(self.tmp)

    def _write(self, data):
        tf = tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", encoding="utf-8", delete=False
        )
        with tf:
            json.dump(data, tf, ensure_ascii=False)
        self.tmp = tf.name
        return tf.name

    def test_import_new_product(self):
        """全新商品（product_links 无记录，relation 无匹配）走无 id 分支。"""
        self.imp.cursor.fetchone_queue = [
            None,                          # product_links 查询
            ("product_category_relation",),  # SHOW TABLES 存在
            None,                          # relation 查询无匹配
        ]
        data = {
            "sku_id": "999",
            "title": "测试商品",
            "category_id": 7,
            "price": 199.0,
        }
        ok = self.imp.import_json_file(self._write(data))
        self.assertTrue(ok)
        self.assertEqual(self.imp.total_imported, 1)
        # 找到 INSERT INTO products，且使用无 id 的 23 字段分支
        insert_calls = [c for c in self.imp.cursor.calls if c[0] == "execute" and "INSERT INTO products" in c[1]]
        self.assertEqual(len(insert_calls), 1)
        _, sql, values = insert_calls[0]
        # 无独立 id 列（注意 category_id 中的 id 不是独立列，需用 \b 边界）
        self.assertNotRegex(sql.split("(")[1].split(")")[0], r"\bid,")
        self.assertEqual(values[0], "999")   # sku_id
        self.assertEqual(values[3], 7)       # category_id

    def test_category_from_relation(self):
        """relation 命中时优先使用 relation 的 category_id。"""
        self.imp.cursor.fetchone_queue = [
            None,
            ("product_category_relation",),
            (42,),   # relation 返回 category_id=42
        ]
        data = {"sku_id": "888", "title": "x"}  # JSON 无 category_id
        ok = self.imp.import_json_file(self._write(data))
        self.assertTrue(ok)
        insert_calls = [c for c in self.imp.cursor.calls if c[0] == "execute" and "INSERT INTO products" in c[1]]
        values = insert_calls[0][2]
        self.assertEqual(values[3], 42)  # 来自 relation

    def test_empty_sku_skipped(self):
        data = {"title": "无 sku"}
        ok = self.imp.import_json_file(self._write(data))
        self.assertFalse(ok)
        self.assertEqual(self.imp.total_skipped, 1)

    def test_invalid_json_errors(self):
        tf = tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", encoding="utf-8", delete=False
        )
        with tf:
            tf.write("{not valid json")
        self.tmp = tf.name
        ok = self.imp.import_json_file(tf.name)
        self.assertFalse(ok)
        self.assertEqual(self.imp.total_errors, 1)


if __name__ == "__main__":
    unittest.main()
