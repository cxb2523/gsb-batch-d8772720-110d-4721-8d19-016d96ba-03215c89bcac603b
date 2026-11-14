# -*- coding: utf-8 -*-
"""白盒测试：product_persist 公共入库逻辑（M3 动态截断 / M5 提取与组装）。"""
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "scripts"))

from product_persist import (  # noqa: E402
    PRODUCT_COLUMNS,
    extract_gallery_urls,
    extract_detail_urls,
    get_product_column_limits,
    build_product_values,
    clean_text,
)
from crawl_session import ensure_session_table, start_session, finish_session  # noqa: E402
from jdcrawler.status_constants import CategoryCrawlStatus, DetailStatus  # noqa: E402
from fakes import RecordingCursor, RecordingConnection  # noqa: E402


class TestExtract(unittest.TestCase):
    def test_gallery_1440_preference(self):
        gallery = [
            [{"size": "1440", "url": "big.jpg"}, {"size": "750", "url": "small.jpg"}],
            {"url": "c.jpg"},
        ]
        self.assertEqual(extract_gallery_urls(gallery), ["big.jpg", "c.jpg"])

    def test_gallery_video_skipped(self):
        gallery = [{"type": "video", "url": "v.mp4"}, {"url": "u.jpg"}]
        self.assertEqual(extract_gallery_urls(gallery), ["u.jpg"])

    def test_gallery_empty(self):
        self.assertEqual(extract_gallery_urls([]), [])

    def test_detail_urls(self):
        self.assertEqual(extract_detail_urls([{"url": "d1.jpg"}, {"url": "d2.jpg"}]), ["d1.jpg", "d2.jpg"])


class TestCleanText(unittest.TestCase):
    def test_control_chars_and_strip(self):
        self.assertEqual(clean_text("\x00ab\x01cd\x7f"), "abcd")
        self.assertEqual(clean_text("  hi  "), "hi")
        self.assertEqual(clean_text(None), "")


class TestColumnLimitsCache(unittest.TestCase):
    def test_limits_cached_on_cursor(self):
        """INFORMATION_SCHEMA 查询应只执行一次（L2 思想：避免重复查元数据）。"""
        cur = RecordingCursor()
        get_product_column_limits(cur, "jd_data")
        get_product_column_limits(cur, "jd_data")  # 第二次应命中缓存
        info_calls = [c for c in cur.calls if "INFORMATION_SCHEMA" in c[1].upper()]
        self.assertEqual(len(info_calls), 1)
        # 结果应被缓存到 cursor 属性上
        self.assertIsInstance(getattr(cur, "_product_col_limits", None), dict)


class TestBuildValuesTruncation(unittest.TestCase):
    def test_varchar_truncated_with_warning(self):
        """M3：超过列上限时按实际长度截断并告警。"""
        warnings = []
        limits = {"title": 5, "brand": 3}
        data = {
            "sku_id": "123",
            "title": "abcdefghij",      # 10 > 5 -> 截断
            "brand": "XYZWV",           # 5 > 3 -> 截断
            "category_id": 7,
            "gallery_json": [[{"size": "1440", "url": "a.jpg"}]],
            "detail_media_json": [{"url": "d.jpg"}],
        }
        values = build_product_values(data, 7, limits, warn=warnings.append)
        self.assertEqual(values[1], "abcde")
        self.assertEqual(values[4], "XYZ")
        self.assertTrue(any("title" in w for w in warnings))
        self.assertTrue(any("brand" in w for w in warnings))

    def test_no_truncation_when_short(self):
        limits = {"title": 50}
        data = {"sku_id": "1", "title": "正常标题", "category_id": 0}
        values = build_product_values(data, 0, limits, warn=lambda *_: None)
        self.assertEqual(values[1], "正常标题")

    def test_column_order_and_gallery_format(self):
        """字段顺序与 gallery/detail 统一包装为 [{'url':..,'local_path':..}]（URL+本地都存）。"""
        limits = {}
        data = {
            "sku_id": "SKU1",
            "title": "商品",
            "category_id": 9,
            "gallery_json": [{"url": "g.jpg", "local_path": "images/SKU1/gallery/0.jpg"}],
            "detail_media_json": [{"url": "dt.jpg", "local_path": "images/SKU1/detail/0.jpg"}],
        }
        values = build_product_values(data, 9, limits, warn=lambda *_: None)
        self.assertEqual(values[0], "SKU1")           # sku_id 第 1 列
        self.assertEqual(values[3], 9)                # category_id 第 4 列
        import json
        self.assertEqual(json.loads(values[6]), [{"url": "g.jpg", "local_path": "images/SKU1/gallery/0.jpg"}])   # gallery_json
        self.assertEqual(json.loads(values[7]), [{"url": "dt.jpg", "local_path": "images/SKU1/detail/0.jpg"}])  # detail_media_json
        # 末尾两列：cover_image_local / shop_logo_local（数据未提供则为空串）
        self.assertEqual(values[-2], "")
        self.assertEqual(values[-1], "")
        self.assertEqual(len(values), len(PRODUCT_COLUMNS))


class TestStatusConstants(unittest.TestCase):
    def test_category_status_values(self):
        self.assertEqual(CategoryCrawlStatus.PENDING, 0)
        self.assertEqual(CategoryCrawlStatus.CRAWLING, 1)
        self.assertEqual(CategoryCrawlStatus.DONE, 2)
        self.assertEqual(CategoryCrawlStatus.FAILED, 3)
        # 部分完成：取值不得与既有 0/1/2/3 冲突，且有中文文案
        self.assertNotIn(CategoryCrawlStatus.PARTIAL, {0, 1, 2, 3})
        from jdcrawler.status_constants import CATEGORY_STATUS_TEXT
        self.assertIn(CategoryCrawlStatus.PARTIAL, CATEGORY_STATUS_TEXT)

    def test_detail_status_values(self):
        self.assertEqual(DetailStatus.PENDING, 0)
        self.assertEqual(DetailStatus.SUCCESS, 1)
        self.assertEqual(DetailStatus.FAILED, 2)


class TestCrawlSession(unittest.TestCase):
    def setUp(self):
        self.cur = RecordingCursor()
        self.conn = RecordingConnection()

    def test_ensure_and_start_and_finish(self):
        ensure_session_table(self.cur, self.conn)
        sid = start_session(self.cur, self.conn, "detail_crawl", note="test")
        self.assertEqual(sid, 0)  # RecordingCursor.lastrowid = 0
        finish_session(self.cur, self.conn, sid, total=10, success=8, failed=2)
        sqls = [c[1].upper() for c in self.cur.calls if c[0] == "execute"]
        self.assertTrue(any("CREATE TABLE" in s for s in sqls))
        self.assertTrue(any("INSERT INTO CRAWL_SESSION" in s for s in sqls))
        self.assertTrue(any("UPDATE CRAWL_SESSION" in s for s in sqls))
        self.assertEqual(self.conn.committed, 3)

    def test_finish_no_session_is_noop(self):
        # session_id 为 None 时不应抛异常
        finish_session(self.cur, self.conn, None, total=1)


if __name__ == "__main__":
    unittest.main()
