# -*- coding: utf-8 -*-
"""
jd_product_detail.py 白盒测试（不依赖真实浏览器）。

通过 mock DrissionPage 与 requests，覆盖：
- M7 审计后的异常分层：容错步骤失败可见、关键路径返回 None 信号
- 纯逻辑回归：SKU 构建、图片/JSON 保存的失败容错

运行：
    PYTHONDONTWRITEBYTECODE=1 python -m unittest tests.test_jd_product_detail -v
"""

import os
import sys
import unittest
from unittest.mock import MagicMock, patch, mock_open

# 在导入 jd_product_detail 之前 mock 掉 DrissionPage，避免任何浏览器依赖
sys.modules['DrissionPage'] = MagicMock()

# 将 scripts 目录加入路径，确保能从 tests 目录导入
_SCRIPTS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts'
)
if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)

import jd_product_detail


class TestJdProductDetailPure(unittest.TestCase):
    """纯逻辑与容错分支（不触发浏览器主流程）。"""

    def setUp(self):
        self.spider = jd_product_detail.JdProductDetailSpider(
            product_url='https://item.jd.com/100012043978.html'
        )
        # page 用 MagicMock，绝大多数方法不依赖其实例
        self.spider.page = MagicMock()

    # ---- _build_sku_list 回归 ----
    def test_build_sku_list_with_groups(self):
        js_data = {
            'sku_groups': [
                {'label': '颜色', 'options': [{'name': '红'}, {'name': '蓝'}]}
            ]
        }
        skus = self.spider._build_sku_list(js_data, 100.0)
        self.assertEqual(len(skus), 1)
        self.assertEqual(skus[0]['sku_name'], '颜色')
        self.assertEqual(len(skus[0]['attributes_json']), 2)

    def test_build_sku_list_fallback(self):
        # 空分组应回退生成默认 SKU，而非崩溃或返回空
        skus = self.spider._build_sku_list({'sku_groups': []}, 50.0)
        self.assertEqual(len(skus), 1)
        self.assertEqual(skus[0]['sku_name'], '默认')

    # ---- _download_image 容错 ----
    def test_download_image_success(self):
        fake_resp = MagicMock()
        fake_resp.status_code = 200
        fake_resp.content = b'x' * 2000
        with patch('jd_product_detail.requests.get', return_value=fake_resp), \
             patch('jd_product_detail.os.makedirs'), \
             patch('jd_product_detail.os.path.exists', return_value=False), \
             patch('builtins.open', mock_open()):
            path = self.spider._download_image('http://x/y.jpg', 'fake_images/y.jpg')
        self.assertEqual(path, 'fake_images/y.jpg')

    def test_download_image_failure_returns_empty(self):
        # 下载异常不应中断流程，应返回空字符串（由上层容错）
        with patch('jd_product_detail.requests.get', side_effect=Exception('network')):
            path = self.spider._download_image('http://x/y.jpg', 'fake_images/y.jpg')
        self.assertEqual(path, '')

    # ---- _save_to_json 容错 ----
    def test_save_to_json_success(self):
        with patch('jd_product_detail.os.makedirs'), \
             patch('jd_product_detail.os.path.exists', return_value=True), \
             patch('builtins.open', mock_open()):
            # 不应抛出异常
            self.spider._save_to_json({'sku_id': '123', 'title': 't'})

    def test_save_to_json_failure_does_not_raise(self):
        # 保存失败时只打印，不应向上抛（避免主流程被意外打断）
        with patch('jd_product_detail.os.makedirs'), \
             patch('jd_product_detail.os.path.exists', return_value=True), \
             patch('builtins.open', side_effect=Exception('disk full')):
            self.spider._save_to_json({'sku_id': '123'})

    # ---- _extract_all_by_js 失败分支 ----
    def test_extract_all_by_js_invalid_json_returns_empty(self):
        # run_js 返回非法 JSON 时应容错返回 {}，不抛异常
        self.spider.page.run_js.return_value = 'not-json{'
        result = self.spider._extract_all_by_js()
        self.assertEqual(result, {})

    # ---- _check_for_verification 选择器容错（M7 审计点）----
    def test_check_for_verification_selector_error_tolerated(self):
        # 单个验证选择器查询抛异常应被容错跳过，不崩溃，最终返回 False
        self.spider.page.eles.side_effect = Exception('bad selector')
        self.spider.page.title = ''
        with patch.object(self.spider, '_check_page_redirected', return_value=False):
            result = self.spider._check_for_verification()
        self.assertFalse(result)


class TestJdProductDetailRunFailureSignal(unittest.TestCase):
    """关键路径：核心数据提取失败时 run() 必须返回 None（避免假数据入库）。"""

    def test_run_returns_none_when_extract_empty(self):
        spider = jd_product_detail.JdProductDetailSpider(
            product_url='https://item.jd.com/100012043978.html'
        )
        with patch('jd_product_detail.time.sleep'), \
             patch.object(spider, '_init_browser', return_value=MagicMock()), \
             patch.object(spider, '_random_delay'), \
             patch.object(spider, '_warm_up'), \
             patch.object(spider, '_check_page_redirected', return_value=False), \
             patch.object(spider, '_check_for_verification', return_value=False), \
             patch.object(spider, '_simulate_human_behavior'), \
             patch.object(spider, '_extract_all_by_js', return_value={}):
            result = spider.run()
        # 关键修复：提取彻底失败必须返回 None，让上层标记为爬取失败
        self.assertIsNone(result)


if __name__ == '__main__':
    unittest.main()
