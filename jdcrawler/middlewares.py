# -*- coding: utf-8 -*-
"""
jdcrawler Spider Middlewares

DrissionPage 下载中间件：负责用浏览器渲染单页搜索结果。

职责划分：
    - 中间件：只渲染当前页面（打开/翻页），返回单页 HTML
    - Spider：每页解析后 yield item 立即存库，再发下一页请求
    
翻页控制权在 Spider 手中，保证每页数据立即入库，不丢失。
"""

import time
import random
import logging
import threading

from scrapy import signals
from scrapy.exceptions import IgnoreRequest
from scrapy.http import HtmlResponse

logger = logging.getLogger('jdcrawler.middlewares')

# 全局停止事件，用于处理 Ctrl+C
_stop_event = threading.Event()


def interruptible_sleep(seconds):
    """
    可中断的睡眠函数，响应 Ctrl+C 信号。
    
    参数:
        seconds: 睡眠时长（秒）
    """
    end_time = time.time() + seconds
    while time.time() < end_time:
        remaining = end_time - time.time()
        if remaining <= 0:
            break
        _stop_event.wait(timeout=min(0.5, remaining))
        if _stop_event.is_set():
            logger.info("[中断检测] 检测到停止信号，中断等待")
            raise KeyboardInterrupt("用户中断")


class DrissionPageMiddleware:
    """
    ChromiumPage 下载中间件
    
    只负责渲染单页，不循环翻页。
    通过 request.meta 中的标记区分操作类型：
        - 无特殊标记：打开新标签页加载 URL
        - 'dp_next_page': True：在当前标签页点击下一页
    """

    def __init__(self):
        self.browser = None
        self.current_tab = None
        self.min_delay = 8
        self.max_delay = 15
        self.scroll_stable_rounds = 5
        self.max_scroll_times = 30

    @classmethod
    def from_crawler(cls, crawler):
        middleware = cls()
        middleware.min_delay = crawler.settings.getfloat('MIN_DELAY', 8)
        middleware.max_delay = crawler.settings.getfloat('MAX_DELAY', 15)
        middleware.scroll_stable_rounds = crawler.settings.getint('SCROLL_STABLE_ROUNDS', 3)
        middleware.max_scroll_times = crawler.settings.getint('MAX_SCROLL_TIMES', 20)
        middleware.edge_address = crawler.settings.get('EDGE_ADDRESS', '127.0.0.1:9222')
        
        # 翻页延迟配置
        middleware.min_page_delay = crawler.settings.getfloat('MIN_PAGE_DELAY', 30)
        middleware.max_page_delay = crawler.settings.getfloat('MAX_PAGE_DELAY', 60)
        
        middleware._crawler = crawler
        
        crawler.signals.connect(middleware.spider_closed, signal=signals.spider_closed)
        return middleware

    def process_request(self, request, spider=None):
        """处理请求：只渲染单页，返回 HtmlResponse"""
        url = request.url
        if "search.jd.com" not in url and "list.jd.com" not in url:
            return None

        is_next_page = request.meta.get('dp_next_page', False)
        page_num = request.meta.get('dp_page_num', 1)

        try:
            if is_next_page:
                logger.info(f"[翻页] 正在翻到第 {page_num} 页...")
                return self._render_next_page(request, page_num)
            elif page_num and page_num > 1:
                # 续爬：部分完成分类的断点页 > 1，先打开首页，再连续翻到目标页
                logger.info(f"[续爬] 正在从断点页第 {page_num} 页继续...")
                return self._render_resume_page(request, page_num)
            else:
                logger.info(f"[渲染] 正在渲染: {url}")
                return self._render_first_page(request)

        except IgnoreRequest:
            # 渲染明确失败（如续爬时无法到达断点页）：交给 errback_handler 决定状态，
            # 不能降级为普通下载，否则会把首页内容当成目标页重复解析
            raise
        except Exception as e:
            logger.error(f"[中间件错误] 渲染失败: {e}", exc_info=True)
            return None

    def _render_first_page(self, request):
        """
        渲染首页：打开新标签页 → 等待加载 → 滚动 → 返回单页HTML。
        
        参数:
            request: Scrapy 请求对象
            
        返回:
            HtmlResponse: 单页完整 HTML
        """
        tab = self._open_new_tab(request.url)

        # 重定向检测
        self._handle_redirect(tab, request.url)

        # 验证码检测
        self._handle_captcha(tab)

        # 等待商品列表加载
        self._wait_for_products(tab)

        # 滚动加载
        self._scroll_to_load(tab)

        # 返回当前页的完整 HTML（只含一页，不会有重复标签问题）
        logger.info("[首页] 渲染完成")
        return HtmlResponse(
            url=request.url,
            body=tab.html.encode("utf-8"),
            encoding="utf-8",
            request=request,
        )

    def _render_resume_page(self, request, page_num):
        """
        续爬渲染：先打开首页建立标签页，再连续点击"下一页"直到目标页。

        用于"部分完成(4)"分类从断点页继续（page_num > 1）。任何一次点击失败
        都抛出 IgnoreRequest 触发 errback_handler，由其保留成果并维持部分完成，
        不会把首页内容当作断点页解析。
        """
        self._render_first_page(request)

        for target in range(2, page_num + 1):
            logger.info(f"[续爬] 正在翻到第 {target}/{page_num} 页...")
            page_delay = random.uniform(self.min_page_delay, self.max_page_delay)
            logger.info(f"[续爬延迟] 翻页前等待 {page_delay:.1f} 秒")
            interruptible_sleep(page_delay)

            if not self._click_next_page(self.current_tab):
                logger.info(f"[续爬] 第 {target} 页：无法翻页，放弃本次续爬")
                raise IgnoreRequest(f"续爬失败：未能到达第 {page_num} 页")

            post_delay = random.uniform(1, 30)
            interruptible_sleep(post_delay)

            try:
                self.current_tab.wait.ele_displayed("css:div[data-sku]", timeout=15)
                logger.info(f"[续爬] 第 {target} 页加载完成")
            except Exception as e:
                logger.warning(f"[续爬] 等待第 {target} 页超时: {e}")

            self._scroll_to_load(self.current_tab)

        logger.info(f"[续爬] 已到达断点页第 {page_num} 页")
        return HtmlResponse(
            url=request.url,
            body=self.current_tab.html.encode("utf-8"),
            encoding="utf-8",
            request=request,
        )

    def _render_next_page(self, request, page_num):
        """
        翻到下一页：在当前标签页点击下一页 → 等待 → 滚动 → 返回单页HTML。
        
        参数:
            request: Scrapy 请求对象
            page_num: 目标页码
            
        返回:
            HtmlResponse: 单页完整 HTML，如果翻页失败返回 None
        """
        tab = self.current_tab
        if not tab:
            logger.error("[翻页] 没有活跃的标签页，无法翻页")
            return None

        # 翻页前延迟 30-60秒
        page_delay = random.uniform(self.min_page_delay, self.max_page_delay)
        logger.info(f"[翻页延迟] 翻页前等待 {page_delay:.1f} 秒")
        interruptible_sleep(page_delay)

        # 点击下一页
        if not self._click_next_page(tab):
            logger.info(f"[翻页] 第 {page_num} 页：没有下一页了")
            return None

        # 翻页后延迟 1-30秒
        post_delay = random.uniform(1, 30)
        logger.info(f"[翻页延迟] 翻页后等待 {post_delay:.1f} 秒")
        interruptible_sleep(post_delay)

        logger.info(f"[翻页] 第 {page_num} 页加载中...")

        # 等待新页面加载
        try:
            tab.wait.ele_displayed("css:div[data-sku]", timeout=15)
            logger.info(f"[翻页] 第 {page_num} 页加载完成")
        except Exception as e:
            logger.warning(f"[翻页] 等待第 {page_num} 页超时: {e}")

        # 滚动加载
        self._scroll_to_load(tab)

        logger.info(f"[翻页] 第 {page_num} 页渲染完成")
        return HtmlResponse(
            url=request.url,
            body=tab.html.encode("utf-8"),
            encoding="utf-8",
            request=request,
        )

    # ==================== 浏览器管理 ====================

    def _get_browser(self):
        """获取或创建浏览器实例（单例）"""
        if self.browser is None:
            from DrissionPage import ChromiumPage, ChromiumOptions

            options = ChromiumOptions()
            options.set_address(self.edge_address)
            options.set_argument('--start-maximized')
            
            self.browser = ChromiumPage(options)
            logger.info(f"[浏览器] ChromiumPage 已连接: {self.edge_address}")

            tab = self.browser.latest_tab
            tab.get("https://www.jd.com")
            interruptible_sleep(random.uniform(3, 5))
            logger.info("[浏览器] 浏览器会话初始化完成")
        return self.browser

    def _open_new_tab(self, url):
        """打开新标签页并加载URL"""
        browser = self._get_browser()
        if self.current_tab:
            try:
                self.current_tab.close()
            except Exception:
                pass
            self.current_tab = None

        tab = browser.new_tab()
        self.current_tab = tab
        tab.get(url)

        delay = random.uniform(self.min_delay, self.max_delay)
        logger.info(f"[页面加载] 等待 {delay:.2f} 秒")
        interruptible_sleep(delay)
        return tab

    # ==================== 页面状态检测 ====================

    def _handle_redirect(self, tab, original_url):
        """处理重定向：如果不是搜索页则重试"""
        redirect_count = 0
        max_retries = 3

        while ("search.jd.com" not in tab.url and "list.jd.com" not in tab.url) and redirect_count < max_retries:
            redirect_count += 1
            logger.warning(f"[重定向] 被重定向: {tab.url} (尝试 {redirect_count})")

            wait_time = random.uniform(5, 10)
            logger.info(f"[重定向] 等待 {wait_time:.2f} 秒后重试...")
            interruptible_sleep(wait_time)

            tab.get(original_url)
            interruptible_sleep(random.uniform(self.min_delay, self.max_delay))
            logger.info(f"[重定向] 重试后URL: {tab.url}")

        if "search.jd.com" not in tab.url and "list.jd.com" not in tab.url:
            logger.error("[重定向] 仍然被重定向，可能被反爬拦截")

    def _handle_captcha(self, tab):
        """处理验证码：等待手动验证"""
        if "risk_handler" not in tab.url and "passport.jd.com" not in tab.url:
            return

        logger.warning("[验证码] 检测到验证码，等待手动验证...")
        start = time.time()
        while time.time() - start < 120:
            if "search.jd.com" in tab.url and "risk_handler" not in tab.url:
                logger.info("[验证码] 验证通过")
                break
            interruptible_sleep(4)
        else:
            logger.error("[验证码] 验证超时")
        interruptible_sleep(6)

    def _wait_for_products(self, tab):
        """等待商品列表加载"""
        logger.info("[页面等待] 等待商品列表加载...")
        try:
            tab.wait.ele_displayed("css:div[data-sku]", timeout=15)
            logger.info("[页面等待] 商品列表加载完成")
        except Exception as e:
            logger.warning(f"[页面等待] 等待商品超时: {e}")
            with open("debug_page.html", "w", encoding="utf-8") as f:
                f.write(tab.html[:10000])
            logger.info("[调试] 已保存页面内容到 debug_page.html")

    # ==================== 翻页 ====================

    def _click_next_page(self, tab):
        """
        点击下一页按钮。
        
        参数:
            tab: 当前标签页
            
        返回:
            bool: 是否成功翻到下一页
        """
        logger.info("[翻页按钮] 正在查找下一页按钮...")

        next_button = None
        selectors = [
            'css:div[class*="_pagination_next_"]',
            'css:[class*="_pagination_next_"]',
            'css:a.pn-next',
            'css:a[class*="pn-next"]',
            'css:.pn-next',
            'css:button[class*="next"]',
            'css:a[title="next"]',
            'css:div[class*="pagination"] a:last-child',
            'css:div[class*="page"] a',
        ]

        for selector in selectors:
            try:
                elements = tab.eles(selector, timeout=2)
                for element in elements:
                    if not element:
                        continue
                    class_attr = element.attr('class') or ''
                    if 'disabled' in class_attr.lower():
                        continue
                    is_next = (
                        '_pagination_next_' in class_attr or
                        'pn-next' in class_attr or
                        'next' in class_attr.lower()
                    )
                    if is_next:
                        next_button = element
                        logger.info(f"[翻页按钮] 找到: class={class_attr[:80]}")
                        break
                if next_button:
                    break
            except Exception:
                continue

        if not next_button:
            # 尝试 JS 点击
            try:
                clicked = tab.run_js(
                    "const btn = document.querySelector('div[class*=\"_pagination_next_\"]');"
                    "if (btn && !btn.className.includes('disabled')) { btn.scrollIntoView(); btn.click(); return true; }"
                    "return false;"
                )
                if clicked:
                    logger.info("[翻页按钮] JS 点击成功")
                    interruptible_sleep(random.uniform(self.min_delay, self.max_delay))
                    return True
                else:
                    logger.info("[翻页按钮] 未找到下一页按钮")
                    return False
            except Exception as e:
                logger.error(f"[翻页按钮] JS 点击失败: {e}")
                return False

        try:
            next_button.click()
            logger.info("[翻页按钮] 点击成功")
            interruptible_sleep(random.uniform(self.min_delay, self.max_delay))
            return True
        except Exception as e:
            logger.error(f"[翻页按钮] 点击失败: {e}")
            return False

    def _has_next_page(self, tab):
        """
        检查是否有下一页（在 spider 中调用前先判断）。
        
        参数:
            tab: 当前标签页
            
        返回:
            bool: 是否存在下一页
        """
        selectors = [
            'css:div[class*="_pagination_next_"]',
            'css:.pn-next',
        ]
        for selector in selectors:
            try:
                elements = tab.eles(selector, timeout=2)
                for element in elements:
                    class_attr = (element.attr('class') or '').lower()
                    if 'disabled' not in class_attr:
                        return True
            except Exception:
                continue
        return False

    # ==================== 滚动 ====================

    def _scroll_to_load(self, tab):
        """滚动页面加载所有内容"""
        prev_count = 0
        stable_rounds = 0

        for i in range(self.max_scroll_times):
            if self._is_at_bottom(tab):
                logger.info(f"[滚动] 第{i+1}次: 已到底部")
                break

            # 10% 概率向上滚动
            if random.random() < 0.1:
                tab.scroll.up(random.randint(50, 150))
                interruptible_sleep(random.uniform(0.8, 1.5))

            scroll_distance = random.randint(200, 500)
            segments = random.randint(3, 5)
            seg_distance = scroll_distance // segments

            for seg in range(segments):
                tab.scroll.down(seg_distance)
                if seg < segments - 1:
                    interruptible_sleep(random.uniform(0.3, 0.6))

            scroll_delay = random.uniform(3.0, 6.0)
            if random.random() < 0.2:
                scroll_delay += random.uniform(2.0, 4.0)
            interruptible_sleep(scroll_delay)

            count = len(set(
                s for item in tab.eles("css:div[data-sku]", timeout=3)
                if (s := item.attr("data-sku"))
            ))

            if count > prev_count:
                logger.info(f"[滚动] 第{i+1}次: {count} 个商品")
                prev_count = count
                stable_rounds = 0
            else:
                stable_rounds += 1

            if stable_rounds >= self.scroll_stable_rounds:
                logger.info(f"[滚动] 第{i+1}次: 数量稳定，停止")
                break

        # 确保分页按钮可见
        self._scroll_to_pagination(tab)

        interruptible_sleep(random.uniform(3.0, 5.0))
        final_count = len(set(
            s for item in tab.eles("css:div[data-sku]", timeout=3)
            if (s := item.attr("data-sku"))
        ))
        logger.info(f"[滚动完成] 共 {final_count} 个商品")

    def _is_at_bottom(self, tab):
        """检查是否已滚动到底部"""
        try:
            scroll_height = tab.run_js("return document.body.scrollHeight")
            scroll_top = tab.run_js("return window.scrollY || document.documentElement.scrollTop")
            window_height = tab.run_js("return window.innerHeight")
            return (scroll_height - scroll_top - window_height) < 300
        except Exception:
            return False

    def _scroll_to_pagination(self, tab):
        """滚动到分页区域"""
        logger.info("[分页检测] 确保分页可见...")
        selectors = [
            'css:[class*="_pagination_next_"]',
            'css:div[class*="_pagination_"]',
            'css:div.pagination',
            'css:.pn-next',
        ]
        for selector in selectors:
            try:
                if tab.ele(selector, timeout=2):
                    logger.info("[分页检测] 分页已找到")
                    return
            except Exception:
                continue

        for attempt in range(5):
            tab.scroll.down(300)
            interruptible_sleep(random.uniform(2.0, 3.0))
            for selector in selectors:
                try:
                    if tab.ele(selector, timeout=2):
                        logger.info(f"[分页检测] 滚动 {attempt+1} 次后找到")
                        return
                except Exception:
                    continue
            if self._is_at_bottom(tab):
                logger.info("[分页检测] 已到底部，无分页")
                return
        logger.warning("[分页检测] 未找到分页")

    # ==================== 生命周期 ====================

    def spider_closed(self, spider):
        """爬虫关闭时清理浏览器资源"""
        if self.current_tab:
            try:
                self.current_tab.close()
            except Exception:
                pass
        if self.browser:
            logger.info("[浏览器关闭] 正在关闭 ChromiumPage")
            self.browser.quit()
            self.browser = None
