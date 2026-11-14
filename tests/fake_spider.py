# -*- coding: utf-8 -*-
"""
验收用本地假爬虫
继承 BaseSpider，读取 tests/static_pages 下的本地静态页面模拟列表分页与详情页，
不启动真实浏览器。

模拟场景（由构造参数控制）:
    - fail_pages: 指定页码加载时抛出异常（模拟超时/下一页按钮失效）
    - empty: 所有列表页均无项目（模拟全部页面正常但无数据）
    - details/prog_beta.html 故意缺失：模拟单条详情抓取抛异常
"""

import os
import re
import time
from typing import Dict, List, Optional

from spiders.base_spider import BaseSpider
from config import UNIVERSITY_INFO

# 注册测试用大学标识（BaseSpider.__init__ 会校验 UNIVERSITY_INFO）
UNIVERSITY_INFO.setdefault("fake_uni", {
    "code": "TEST001",
    "name": "Fake Test University",
    "name_cn": "本地假大学",
    "base_url": "https://fake.example.edu",
    "list_url": "https://fake.example.edu/programs",
    "allowed_domain": "fake.example.edu",
})

STATIC_PAGES_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static_pages")


class FakeSpider(BaseSpider):
    """
    本地静态页面假爬虫

    参数:
        headless (bool): 兼容基类构造签名（不会真正启动浏览器）
        fail_pages (Dict[int, str]): 页码 -> 异常信息，加载该页时抛出 TimeoutError
        empty (bool): True 时所有列表页返回空（全部页面正常但无项目）
        pages_dir (str): 静态页面目录
    """

    def __init__(self, headless: bool = True,
                 fail_pages: Optional[Dict[int, str]] = None,
                 empty: bool = False,
                 pages_dir: str = STATIC_PAGES_DIR):
        super().__init__("fake_uni", headless)
        self.fail_pages = dict(fail_pages or {})
        self.empty = empty
        self.pages_dir = pages_dir
        self.temp_links: List[Dict] = []

    # ------------------------------------------------------------------
    # 列表分页
    # ------------------------------------------------------------------

    def _load_list_page(self, page: int) -> Optional[List[Dict]]:
        """
        加载一页列表。返回 None 表示没有更多页；返回 [] 表示该页无数据。
        """
        if page in self.fail_pages:
            raise TimeoutError(self.fail_pages[page])

        filename = "list_empty.html" if self.empty else f"list_page{page}.html"
        path = os.path.join(self.pages_dir, filename)
        if not os.path.exists(path):
            return None  # 没有更多页

        with open(path, "r", encoding="utf-8") as f:
            html = f.read()

        items = []
        for link, name in re.findall(r'<a class="program" href="([^"]+)">([^<]+)</a>', html):
            items.append({"name": name.strip(), "link": link.strip()})
        return items

    # ------------------------------------------------------------------
    # 详情页
    # ------------------------------------------------------------------

    def _fill_detail(self, item: Dict, result: Dict) -> None:
        """填充单条详情；详情文件缺失时抛 FileNotFoundError（模拟详情页异常）"""
        path = os.path.join(self.pages_dir, item["link"])
        with open(path, "r", encoding="utf-8") as f:
            html = f.read()
        m = re.search(r'<span class="deadline">([^<]+)</span>', html)
        result["项目deadline"] = m.group(1).strip() if m else "N/A"

    # ------------------------------------------------------------------
    # 主流程
    # ------------------------------------------------------------------

    def run(self) -> List[Dict]:
        self.start_time = time.time()
        self.results = []

        # Phase 1: 逐页采集列表，逐页登记结局；异常页登记后停止翻页
        page = 1
        max_page = max(self.retry_pages) if self.retry_pages else None
        while True:
            # 只重跑指定页码时，跳过其他页
            if self.retry_pages is not None and page not in self.retry_pages:
                page += 1
                if max_page is not None and page > max_page:
                    break
                continue

            try:
                items = self._load_list_page(page)
            except Exception as e:
                # 登记该页结局为异常中断，停止翻页；已收集的项目保留在 temp_links 中
                self.register_page_error(page, e)
                break

            if items is None:
                break  # 没有更多页，正常结束
            if not items:
                self.register_page_no_data(page)
                break

            before = len(self.temp_links)
            for it in items:
                if not any(d["link"] == it["link"] for d in self.temp_links):
                    self.temp_links.append(it)
            self.register_page_success(page, len(self.temp_links) - before)
            page += 1
            if max_page is not None and page > max_page:
                break

        # Phase 2: 逐条抓取详情，单条失败只标记该条，其余继续
        for item in self.temp_links:
            self.results.append(
                self.fetch_detail_safely(item, lambda r, it=item: self._fill_detail(it, r))
            )

        return self.results


class ExplodingSpider(FakeSpider):
    """run() 中途抛异常的假爬虫：已采集部分数据后模拟崩溃"""

    def run(self) -> List[Dict]:
        self.start_time = time.time()
        self.register_page_success(1, 1)
        self.results = [self.create_result_template("MSc Computer Science", "details/prog_alpha.html")]
        raise RuntimeError("模拟浏览器崩溃")
