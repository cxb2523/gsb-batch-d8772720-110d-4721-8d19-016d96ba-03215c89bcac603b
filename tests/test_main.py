# -*- coding: utf-8 -*-
"""main.py 的轻量白盒测试（不依赖浏览器/数据库，直接 import 即可运行）。"""
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import main  # noqa: E402  - 顶部仅依赖标准库，import 安全


class TestParseJdSku(unittest.TestCase):
    """parse_jd_sku：从京东商品 URL 提取 sku_id（商品URL采集依赖此解析）。"""

    def test_normal(self):
        self.assertEqual(
            main.parse_jd_sku("https://item.jd.com/100012043978.html"),
            "100012043978",
        )

    def test_with_query(self):
        self.assertEqual(
            main.parse_jd_sku("https://item.jd.com/100012043978.html?sku=100012043978"),
            "100012043978",
        )

    def test_with_fragment(self):
        self.assertEqual(
            main.parse_jd_sku("https://item.jd.com/100012043978.html#crumb-wrap"),
            "100012043978",
        )

    def test_with_quote(self):
        # 菜单/子命令里可能带引号包裹的 URL
        self.assertEqual(
            main.parse_jd_sku('"https://item.jd.com/100012043978.html"'),
            "100012043978",
        )

    def test_invalid(self):
        self.assertIsNone(main.parse_jd_sku("https://www.jd.com/"))
        self.assertIsNone(main.parse_jd_sku("https://item.taobao.com/123.html"))
        self.assertIsNone(main.parse_jd_sku(""))
        self.assertIsNone(main.parse_jd_sku(None))


if __name__ == "__main__":
    unittest.main()
