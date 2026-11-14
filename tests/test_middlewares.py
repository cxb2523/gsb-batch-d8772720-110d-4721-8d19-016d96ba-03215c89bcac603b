# -*- coding: utf-8 -*-
"""白盒测试：DrissionPage 下载中间件的续爬渲染路径（不依赖真实浏览器）。

用假 tab / 补丁替代浏览器与等待，只验证：
- 部分完成分类从断点页续爬时，会从首页连续翻到目标页并只返回目标页 HTML；
- 翻页失败时抛 IgnoreRequest，交给 spider 的 errback_handler 保留成果。
"""
import os
import sys
import unittest
from unittest.mock import MagicMock, patch

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from scrapy import Request  # noqa: E402
from scrapy.exceptions import IgnoreRequest  # noqa: E402
from jdcrawler.middlewares import DrissionPageMiddleware  # noqa: E402


class TestResumeRender(unittest.TestCase):

    def setUp(self):
        self.mw = DrissionPageMiddleware()
        self.mw.min_page_delay = 0
        self.mw.max_page_delay = 0
        self.mw.min_delay = 0
        self.mw.max_delay = 0

    def _request(self, page_num):
        return Request(
            url="https://search.jd.com/Search",
            meta={"dp_next_page": False, "dp_page_num": page_num},
        )

    def test_render_resume_page_reaches_target(self):
        tab = MagicMock()
        tab.html = "<html>page4</html>"
        self.mw.current_tab = tab
        self.mw._render_first_page = MagicMock(return_value=None)
        self.mw._click_next_page = MagicMock(return_value=True)
        self.mw._scroll_to_load = MagicMock()

        with patch("jdcrawler.middlewares.interruptible_sleep"):
            resp = self.mw._render_resume_page(self._request(4), 4)

        self.assertEqual(resp.text, "<html>page4</html>")
        # 从第 2 页翻到第 4 页，共点击 3 次
        self.assertEqual(self.mw._click_next_page.call_count, 3)
        self.assertEqual(self.mw._scroll_to_load.call_count, 3)

    def test_render_resume_page_raises_when_click_fails(self):
        self.mw.current_tab = MagicMock()
        self.mw._render_first_page = MagicMock(return_value=None)
        self.mw._click_next_page = MagicMock(return_value=False)
        self.mw._scroll_to_load = MagicMock()

        with patch("jdcrawler.middlewares.interruptible_sleep"):
            with self.assertRaises(IgnoreRequest):
                self.mw._render_resume_page(self._request(5), 5)

    def test_process_request_dispatches_resume_for_page_gt_one(self):
        """dp_next_page=False 且 dp_page_num>1 = 续爬，走断点渲染而非首页渲染。"""
        self.mw._render_first_page = MagicMock(return_value="first")
        self.mw._render_next_page = MagicMock(return_value="next")
        self.mw._render_resume_page = MagicMock(return_value="resume")

        resp = self.mw.process_request(self._request(3))

        self.assertEqual(resp, "resume")
        self.mw._render_resume_page.assert_called_once()
        self.mw._render_first_page.assert_not_called()

    def test_process_request_first_page_for_page_one(self):
        self.mw._render_first_page = MagicMock(return_value="first")
        self.mw._render_resume_page = MagicMock(return_value="resume")

        resp = self.mw.process_request(self._request(1))

        self.assertEqual(resp, "first")
        self.mw._render_resume_page.assert_not_called()

    def test_process_request_ignore_request_propagates(self):
        """IgnoreRequest 必须上抛触发 errback，不能被吞成普通下载。"""
        self.mw._render_resume_page = MagicMock(side_effect=IgnoreRequest("resume failed"))
        with self.assertRaises(IgnoreRequest):
            self.mw.process_request(self._request(3))


if __name__ == "__main__":
    unittest.main()
