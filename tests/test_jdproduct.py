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


def make_failure(meta):
    """构造 Scrapy errback 收到的 Failure 替身（只需要 request.meta 与 value）。"""
    class _Req:
        def __init__(self, m):
            self.meta = m

    class _Fail:
        def __init__(self, m):
            self.request = _Req(m)
            self.value = "boom"

    return _Fail(meta)


class FakeListCursor:
    """列表爬虫用的假游标：记录 SQL，可返回预设的 fetchall 结果。"""

    def __init__(self, rows=None):
        self.calls = []
        self.rows = rows if rows is not None else []
        self.rowcount = 0
        self.closed = False

    def execute(self, sql, params=None):
        self.calls.append((sql, params))
        return None

    def fetchall(self):
        return self.rows

    def fetchone(self):
        return None

    def close(self):
        self.closed = True


class FakeListConnection:
    def __init__(self, cursor):
        self._cursor = cursor
        self.committed = 0
        self.closed = False

    def cursor(self):
        return self._cursor

    def commit(self):
        self.committed += 1

    def close(self):
        self.closed = True


BASE_META = {
    "category_id": 5,
    "category_name": "冰箱",
    "category_full_name": "家用电器 > 冰洗 > 冰箱",
    "page": 1,
    "total_extracted": 0,
}


class Recorder:
    def __init__(self):
        self.calls = []      # 位置参数元组，如 (5, 3)
        self.kwargs = []     # 对应的关键字参数，如 {"page": 3, "items": 120}

    def __call__(self, *a, **k):
        self.calls.append(a)
        self.kwargs.append(k)


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
        return make_failure(meta)

    def test_next_page_failure_completes_category(self):
        """未采到任何商品就翻页失败：维持"没有下一页"的既有语义，标记完成(2)。"""
        fb = self._failure({"category_id": 5, "category_full_name": "x", "page": 3, "dp_next_page": True})
        self.spider.errback_handler(fb)
        self.assertIn((5, 2), self.updater.calls)

    def test_next_page_failure_after_items_marks_partial(self):
        """已采到商品后翻页失败：保留成果，标记部分完成(4)并从断点继续。"""
        fb = self._failure({
            "category_id": 5, "category_full_name": "x",
            "page": 3, "total_extracted": 120, "dp_next_page": True,
        })
        self.spider.errback_handler(fb)
        self.assertEqual(self.updater.calls[0][0:2], (5, CategoryCrawlStatus.PARTIAL))
        self.assertEqual(self.updater.kwargs[0], {"page": 2, "items": 120})
        self.assertNotIn((5, 2), self.updater.calls)
        self.assertNotIn((5, 3), self.updater.calls)

    def test_first_page_failure_marks_failed(self):
        fb = self._failure({"category_id": 5, "category_full_name": "x", "page": 1, "dp_next_page": False})
        self.spider.errback_handler(fb)
        self.assertIn((5, 3), self.updater.calls)  # 首页失败=爬取失败

    def test_resume_request_failure_keeps_partial(self):
        """续爬请求（非首页）失败时仍保持部分完成，不降级为失败(3)。"""
        fb = self._failure({
            "category_id": 5, "category_full_name": "x",
            "page": 4, "total_extracted": 180, "dp_next_page": False,
        })
        self.spider.errback_handler(fb)
        self.assertEqual(self.updater.calls[0][0:2], (5, CategoryCrawlStatus.PARTIAL))
        self.assertEqual(self.updater.kwargs[0], {"page": 3, "items": 180})


class TestPartialCompletion(unittest.TestCase):
    """部分完成(4)：已采一页后短响应 / 翻页失败保留成果，并支持断点续爬。"""

    def setUp(self):
        self.spider = JdProductSpider()
        self.updater = Recorder()
        self.spider._update_category_status = self.updater

    def _cards(self, skus):
        items = "".join(f'<li class="gl-item" data-sku="{s}"></li>' for s in skus)
        return f"<html><body><ul>{items}</ul>{' '*(1200-len(items))}</body></html>"

    def test_short_response_after_one_page_keeps_items_and_marks_partial(self):
        """
        第 1 页正常产出 3 个 item；第 2 页短响应（反爬）时：
        - 已产出的 item 全部保留（不被撤回/丢弃）；
        - 分类标记为部分完成(4)，断点在 1 页、累计 3 个；
        - 不会误标记为完成(2)或失败(3)。
        """
        page1 = make_response(self._cards(["100", "200", "300"]), dict(BASE_META))
        items = parse_items(self.spider, page1)
        self.assertEqual(len(items), 3)

        page2_meta = dict(BASE_META, page=2, total_extracted=3, dp_next_page=True)
        page2 = make_response("<html><body>anti-bot</body></html>", page2_meta)
        out = list(self.spider.parse_product_list(page2))

        self.assertEqual(out, [])
        self.assertEqual(len(items), 3)  # 已产出 item 保留
        self.assertEqual(self.updater.calls[-1][0:2], (5, CategoryCrawlStatus.PARTIAL))
        self.assertEqual(self.updater.kwargs[-1], {"page": 1, "items": 3})
        self.assertNotIn((5, 2), self.updater.calls)
        self.assertNotIn((5, 3), self.updater.calls)

    def test_short_response_on_first_page_still_failed(self):
        resp = make_response("<html><body>anti-bot</body></html>", dict(BASE_META))
        list(self.spider.parse_product_list(resp))
        self.assertIn((5, 3), self.updater.calls)
        self.assertNotIn((5, 4), self.updater.calls)

    def test_each_page_writes_breakpoint_progress(self):
        """每页存库后立即落断点进度：进程被强杀（不走 errback）时也能续爬。"""
        page2_meta = dict(BASE_META, page=2, total_extracted=3, dp_next_page=True)
        resp = make_response(self._cards(["400", "500"]), page2_meta)
        list(self.spider.parse_product_list(resp))
        progress_calls = [
            (c, k) for c, k in zip(self.updater.calls, self.updater.kwargs) if k
        ]
        self.assertEqual(len(progress_calls), 1)
        call, kwargs = progress_calls[0]
        self.assertEqual(call[0:2], (5, CategoryCrawlStatus.CRAWLING))
        self.assertEqual(kwargs, {"page": 2, "items": 5})

    def test_done_and_failed_clear_breakpoint_progress(self):
        """完成/失败为终态，同时清空断点，避免日后重置状态时误从旧断点续爬。"""
        spider = JdProductSpider()
        conn = MagicMock()
        cursor = conn.cursor.return_value
        with patch("jdcrawler.spiders.jdproduct.pymysql.connect", return_value=conn):
            spider._update_category_status(5, CategoryCrawlStatus.DONE)
            spider._update_category_status(5, CategoryCrawlStatus.FAILED)
        done_sql = cursor.execute.call_args_list[0][0]
        failed_sql = cursor.execute.call_args_list[1][0]
        self.assertIn("crawl_page = 0", done_sql[0])
        self.assertIn("crawl_page = 0", failed_sql[0])
        # 爬取中(1)只改状态，不动断点
        with patch("jdcrawler.spiders.jdproduct.pymysql.connect", return_value=conn):
            spider._update_category_status(5, CategoryCrawlStatus.CRAWLING)
        crawling_sql = cursor.execute.call_args_list[2][0]
        self.assertNotIn("crawl_page", crawling_sql[0])

    def test_update_category_status_writes_progress_columns(self):
        """部分完成会同时落库断点页与累计数量。"""
        spider = JdProductSpider()  # 用真实 _update_category_status（setUp 中被替换为 Recorder）
        conn = MagicMock()
        cursor = conn.cursor.return_value
        with patch("jdcrawler.spiders.jdproduct.pymysql.connect", return_value=conn):
            spider._update_category_status(
                5, CategoryCrawlStatus.PARTIAL, page=3, items=120
            )
        sql, params = cursor.execute.call_args[0]
        self.assertIn("crawl_page", sql)
        self.assertIn("crawl_items", sql)
        self.assertEqual(params, (CategoryCrawlStatus.PARTIAL, 3, 120, 5))


class TestStatusRecoveryAndResume(unittest.TestCase):
    """启动复苏只重置爬取中(1)；部分完成(4)会被加载并从断点继续。"""

    def setUp(self):
        self.spider = JdProductSpider()

    def test_reset_stuck_categories_only_resets_crawling(self):
        cursor = FakeListCursor()
        conn = FakeListConnection(cursor)
        with patch("jdcrawler.spiders.jdproduct.pymysql.connect", return_value=conn):
            self.spider._reset_stuck_categories()

        updates = [c[0] for c in cursor.calls if "UPDATE CATEGORIES" in c[0].upper()]
        self.assertEqual(len(updates), 1)
        sql = " ".join(updates[0].split())
        self.assertIn("crawl_status = 0", sql)
        self.assertIn("crawl_status = 1", sql)
        # 不再重置失败(3)与部分完成(4)
        self.assertNotIn("IN (1, 3)", sql.upper())
        self.assertNotIn("3", sql)
        self.assertNotIn("4", sql)
        self.assertEqual(conn.committed, 1)

    def test_reset_failure_does_not_raise(self):
        with patch("jdcrawler.spiders.jdproduct.pymysql.connect", side_effect=Exception("no db")):
            self.spider._reset_stuck_categories()  # 仅告警，不抛出

    def _load_with_rows(self, rows):
        cursor = FakeListCursor(rows)
        conn = FakeListConnection(cursor)
        with patch("jdcrawler.spiders.jdproduct.pymysql.connect", return_value=conn):
            self.spider._load_categories_from_db()
        return cursor

    def test_loads_pending_and_partial_with_progress(self):
        rows = [
            {"id": 1, "name": "冰箱", "parent_id": 0, "path": "1", "level": 3,
             "source_url": "https://search.jd.com/Search?keyword=冰箱", "crawl_status": 0,
             "crawl_page": 0, "crawl_items": 0,
             "parent_name": None, "grand_parent_name": None},
            {"id": 2, "name": "洗衣机", "parent_id": 0, "path": "2", "level": 3,
             "source_url": "", "crawl_status": CategoryCrawlStatus.PARTIAL,
             "crawl_page": 3, "crawl_items": 120,
             "parent_name": None, "grand_parent_name": None},
        ]
        cursor = self._load_with_rows(rows)

        self.assertEqual([c["id"] for c in self.spider.categories], [1, 2])
        pending, partial = self.spider.categories
        self.assertEqual((pending["resume_page"], pending["resume_total"]), (1, 0))
        self.assertEqual((partial["resume_page"], partial["resume_total"]), (4, 120))
        # 查询同时纳入 0 与 4，且读取进度列
        sql = " ".join(cursor.calls[0][0].split())
        self.assertIn("crawl_status IN (0, 4)", sql)
        self.assertIn("crawl_page", sql)

    def test_load_falls_back_when_progress_columns_missing(self):
        """旧库缺进度列时仍加载部分完成分类（退化为从第 1 页爬），不整轮退出。"""
        class _RaisingCursor(FakeListCursor):
            def execute(self, sql, params=None):
                self.calls.append((sql, params))
                if "crawl_page" in sql:
                    raise Exception("Unknown column 'crawl_page'")
                return None

        cursor = _RaisingCursor([
            {"id": 2, "name": "洗衣机", "parent_id": 0, "path": "2", "level": 3,
             "source_url": "", "crawl_status": CategoryCrawlStatus.PARTIAL,
             "parent_name": None, "grand_parent_name": None},
        ])
        conn = FakeListConnection(cursor)
        with patch("jdcrawler.spiders.jdproduct.pymysql.connect", return_value=conn):
            self.spider._load_categories_from_db()

        self.assertEqual(len(self.spider.categories), 1)
        self.assertEqual(self.spider.categories[0]["resume_page"], 1)

    def test_start_resumes_partial_from_breakpoint(self):
        self.spider.categories = [
            {"id": 1, "name": "冰箱", "source_url": "https://search.jd.com/Search",
             "full_name": "冰箱", "crawl_status": 0, "resume_page": 1, "resume_total": 0},
            {"id": 2, "name": "洗衣机", "source_url": "https://search.jd.com/Search",
             "full_name": "洗衣机", "crawl_status": CategoryCrawlStatus.PARTIAL,
             "resume_page": 4, "resume_total": 120},
        ]
        self.spider.category_limit = 0
        self.spider._update_category_status = Recorder()

        async def collect():
            return [r async for r in self.spider.start()]

        reqs = asyncio.run(collect())
        self.assertEqual(len(reqs), 2)
        self.assertEqual(reqs[0].meta["page"], 1)
        self.assertEqual(reqs[0].meta["total_extracted"], 0)
        # 部分完成分类：请求 meta 接着上次进度（4 页 / 120 个），而不是 1 页 / 0 个
        self.assertEqual(reqs[1].meta["page"], 4)
        self.assertEqual(reqs[1].meta["total_extracted"], 120)
        self.assertEqual(reqs[1].meta["dp_page_num"], 4)
        self.assertFalse(reqs[1].meta["dp_next_page"])

    def test_start_skips_resume_beyond_max_pages(self):
        self.spider.categories = [
            {"id": 2, "name": "洗衣机", "source_url": "", "full_name": "洗衣机",
             "crawl_status": CategoryCrawlStatus.PARTIAL,
             "resume_page": 21, "resume_total": 1200},
        ]
        self.spider.category_limit = 0
        self.spider.max_pages = 20
        updater = Recorder()
        self.spider._update_category_status = updater

        async def collect():
            return [r async for r in self.spider.start()]

        reqs = asyncio.run(collect())
        self.assertEqual(reqs, [])
        self.assertIn((2, CategoryCrawlStatus.DONE), updater.calls)


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
