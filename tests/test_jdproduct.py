# -*- coding: utf-8 -*-
"""白盒测试：列表爬虫 jdproduct 的解析、翻页、错误回调与请求生成。"""
import os
import sys
import asyncio
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "scripts"))

from scrapy import Request  # noqa: E402
from scrapy.http import HtmlResponse  # noqa: E402
from jdcrawler.spiders.jdproduct import JdProductSpider  # noqa: E402
from jdcrawler.items import JdItem  # noqa: E402
from jdcrawler.status_constants import CategoryCrawlStatus  # noqa: E402
from unittest.mock import MagicMock, patch  # noqa: E402


def parse_items(spider, resp):
    """只保留 parse_product_list 产出的商品 item（排除翻页用的 Request）。"""
    return [x for x in spider.parse_product_list(resp) if isinstance(x, JdItem)]


def make_response(body, meta):
    req = Request(url="https://search.jd.com/Search", meta=meta)
    resp = HtmlResponse(
        url="https://search.jd.com/Search",
        body=body.encode("utf-8"),
        encoding="utf-8",
        request=req,
    )
    return resp


BASE_META = {
    "category_id": 5,
    "category_name": "冰箱",
    "category_full_name": "家用电器 > 冰洗 > 冰箱",
    "page": 1,
    "total_extracted": 0,
}


class Recorder:
    def __init__(self):
        self.calls = []

    def __call__(self, *a, **k):
        self.calls.append(a)


class TestParseProductList(unittest.TestCase):

    def setUp(self):
        self.spider = JdProductSpider()
        self.updater = Recorder()
        self.spider._update_category_status = self.updater

    def _cards(self, skus, tag="li", cls="gl-item"):
        items = "".join(
            f'<{tag} class="{cls}" data-sku="{s}"><div class="p-name">商品{s}</div></{tag}>'
            for s in skus
        )
        # 足够长，绕过 <1000 字符的短响应守卫
        return f"<html><body><ul class='gl-warp'>{items}</ul>{' '*(1200-len(items))}</body></html>"

    def test_extracts_skus(self):
        resp = make_response(self._cards(["100", "200", "300"]), dict(BASE_META))
        items = parse_items(self.spider, resp)
        self.assertEqual(len(items), 3)
        self.assertEqual({it["sku_id"] for it in items}, {"100", "200", "300"})
        for it in items:
            self.assertEqual(it["category_id"], 5)
            self.assertTrue(it["source_url"].startswith("https://item.jd.com/"))

    def test_dedup_within_page(self):
        resp = make_response(
            self._cards(["100", "100", "200"]), dict(BASE_META)
        )
        items = parse_items(self.spider, resp)
        self.assertEqual(len(items), 2)  # 重复 sku 被页内去重

    def test_short_response_guard(self):
        """短响应直接返回，且标记分类为失败(3)，避免永久卡在'爬取中'（修复 H1）。"""
        resp = make_response("<html><body>anti-bot</body></html>", dict(BASE_META))
        items = list(self.spider.parse_product_list(resp))
        self.assertEqual(items, [])
        self.assertIn((5, 3), self.updater.calls)  # 标记为失败而非静默停留 1

    def test_selector_threshold_no_premature_end(self):
        """
        修复验证：主选择器 div[data-sku] 命中 1~9 个时不再因 <10 阈值误判丢数据，
        5 个有效卡片应被正常解析产出，分类不会被错误标记为结束(2)或失败(3)。
        """
        skus = ["1", "2", "3", "4", "5"]
        cards = "".join(f'<div data-sku="{s}"></div>' for s in skus)
        body = f"<html><body>{cards}{' '*(1100-len(cards))}</body></html>"
        resp = make_response(body, dict(BASE_META))
        items = parse_items(self.spider, resp)
        self.assertEqual(len(items), 5)
        self.assertNotIn((5, 2), self.updater.calls)
        self.assertNotIn((5, 3), self.updater.calls)

    def test_no_cards_marks_category_done(self):
        body = f"<html><body><div>无商品</div>{' '*1100}</body></html>"
        resp = make_response(body, dict(BASE_META))
        items = list(self.spider.parse_product_list(resp))
        self.assertEqual(items, [])
        self.assertIn((5, 2), self.updater.calls)  # 正常末页：标记完成


class TestErrback(unittest.TestCase):

    def setUp(self):
        self.spider = JdProductSpider()
        self.updater = Recorder()
        self.spider._update_category_status = self.updater

    def _failure(self, meta):
        class _Req:
            def __init__(self, m):
                self.meta = m
        class _Fail:
            def __init__(self, m):
                self.request = _Req(m)
                self.value = "boom"
        return _Fail(meta)

    def test_next_page_failure_completes_category(self):
        fb = self._failure({"category_id": 5, "category_full_name": "x", "page": 3, "dp_next_page": True})
        self.spider.errback_handler(fb)
        self.assertIn((5, 2), self.updater.calls)  # 翻页失败=正常结束

    def test_first_page_failure_marks_failed(self):
        fb = self._failure({"category_id": 5, "category_full_name": "x", "page": 1, "dp_next_page": False})
        self.spider.errback_handler(fb)
        self.assertIn((5, 3), self.updater.calls)  # 首页失败=爬取失败


class TestStart(unittest.TestCase):

    def setUp(self):
        self.spider = JdProductSpider()

    def test_generates_one_request_per_category(self):
        self.spider.categories = [
            {"id": 1, "name": "冰箱", "source_url": "https://search.jd.com/Search?keyword=冰箱",
             "full_name": "家用电器 > 冰洗 > 冰箱"},
            {"id": 2, "name": "洗衣机", "source_url": "", "full_name": "家用电器 > 冰洗 > 洗衣机"},
        ]
        self.spider.category_limit = 0
        self.updater = Recorder()
        self.spider._update_category_status = self.updater

        async def collect():
            return [r async for r in self.spider.start()]

        reqs = asyncio.run(collect())
        self.assertEqual(len(reqs), 2)
        # 每个分类都被标记为"爬取中"(1)
        self.assertEqual(self.updater.calls.count((1, 1)), 1)
        self.assertEqual(self.updater.calls.count((2, 1)), 1)
        # meta 正确透传
        self.assertEqual(reqs[0].meta["category_id"], 1)
        self.assertTrue(reqs[0].meta["dp_next_page"] is False)
        # 无 source_url 的分类回退到 keyword 搜索
        self.assertIn("keyword=", reqs[1].url)


class TestSessionIntegration(unittest.TestCase):
    """L3 会话记录接入列表采集：计数累计 + DB 不可用降级（不阻断爬取）。"""

    def test_category_status_counters(self):
        spider = JdProductSpider()
        fake_conn = MagicMock()
        with patch("jdcrawler.spiders.jdproduct.pymysql.connect", return_value=fake_conn):
            spider._update_category_status(1, CategoryCrawlStatus.DONE)
            spider._update_category_status(2, CategoryCrawlStatus.FAILED)
            spider._update_category_status(3, CategoryCrawlStatus.DONE)
        self.assertEqual(spider.success_categories, 2)
        self.assertEqual(spider.failed_categories, 1)

    def test_spider_opened_session_degrade_on_db_error(self):
        spider = JdProductSpider()
        spider.categories = []
        with patch("jdcrawler.spiders.jdproduct.pymysql.connect", side_effect=Exception("no db")):
            # 所有 DB 操作应降级为 warning，不应抛出异常
            spider.spider_opened(spider)
        self.assertIsNone(spider._session_id)


if __name__ == "__main__":
    unittest.main()
