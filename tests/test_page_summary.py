# -*- coding: utf-8 -*-
"""
三大平台采集器【单页采集小结】的离线测试。

全部使用本地自造的假列表 / 假详情 / 假入库函数，不依赖网络、真实 Cookie 或浏览器。
覆盖五种情形：
  1. 部分新增部分跳过
  2. 整页重复（新增 0、跳过=捕获、状态仍为正常完成）
  3. 翻到最后一页（空列表）
  4. 列表获取失败（页面加载失败 / 数据包未捕获）
  5. 详情获取失败（放弃计数，且不入库）
另验证三个平台的小结字段与状态取值完全一致。

运行方式（仓库根目录）：
    python -m unittest discover -s tests -v
"""

import io
import json
import os
import sys
import unittest
from contextlib import redirect_stdout

# 把仓库根目录加入 sys.path，以便导入 common 包
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from common.page_summary import (
    PageSummary, process_page_jobs, emit_page_summary, abort_page,
    SUMMARY_PREFIX, ALL_STATUSES,
    STATUS_OK, STATUS_LAST_PAGE, STATUS_LOAD_FAILED, STATUS_PACKET_MISSING,
)

PLATFORMS = ["BOSS直聘", "51job", "猎聘"]


def make_fake_jobs(n, prefix="岗位"):
    """自造假列表：n 个岗位条目。"""
    return [
        {"company": f"公司{i}", "title": f"{prefix}{i}", "city": "深圳", "id": f"J{i:03d}"}
        for i in range(n)
    ]


class FakeStore:
    """假数据库：用 (公司, 职位, 城市) 集合模拟查重键与入库。"""

    def __init__(self, existing=()):
        self.existing = set(existing)   # 已存在的 (company, title, city)
        self.saved = []                 # 实际写入的 job_data

    def exists_fn(self, company, title, city):
        return (company, title, city) in self.existing

    def save_fn(self, job_data):
        key = (job_data["company_name"], job_data["job_title"], job_data["city"])
        if key in self.existing:
            return False
        self.existing.add(key)
        self.saved.append(job_data)
        return True


def identity_fn(job):
    return job["company"], job["title"], job["city"]


def make_detail_fn(fail_ids=()):
    """假详情函数：对指定 id 返回 None（模拟详情获取失败），其余返回完整 job_data。"""
    def detail_fn(job):
        if job["id"] in fail_ids:
            return None
        company, title, city = identity_fn(job)
        return {
            "job_link": f"https://fake.local/{job['id']}",
            "job_title": title,
            "company_name": company,
            "city": city,
            "jd_text": "假 JD 描述",
        }
    return detail_fn


def run_page(platform, page, jobs, store, detail_fn=None):
    """模拟采集器单页处理：空列表 => 已到最后一页；否则走统一流水线。"""
    return process_page_jobs(
        platform, page, jobs,
        identity_fn=identity_fn,
        exists_fn=store.exists_fn,
        detail_fn=detail_fn or make_detail_fn(),
        save_fn=store.save_fn,
        sleep_fn=None,
        logger=lambda *a, **k: None,   # 测试中静音逐条日志
    )


class TestPartialInsertAndSkip(unittest.TestCase):
    """情形 1：部分新增部分跳过。"""

    def test_partial_insert_and_skip(self):
        jobs = make_fake_jobs(5)
        # 预先让其中 2 个岗位“已存在”
        store = FakeStore(existing={("公司1", "岗位1", "深圳"), ("公司3", "岗位3", "深圳")})
        summary = run_page("BOSS直聘", 2, jobs, store)

        self.assertEqual(summary.captured, 5)
        self.assertEqual(summary.skipped, 2)
        self.assertEqual(summary.inserted, 3)
        self.assertEqual(summary.detail_failed, 0)
        self.assertEqual(summary.status, STATUS_OK)
        self.assertTrue(summary.is_success_page)
        # 已存在的岗位不应触发详情函数之外的入库
        self.assertEqual(len(store.saved), 3)


class TestWholePageDuplicated(unittest.TestCase):
    """情形 2：整页重复 => 新增 0、跳过=捕获、状态仍为正常完成。"""

    def test_whole_page_duplicated(self):
        jobs = make_fake_jobs(4)
        store = FakeStore(existing={(j["company"], j["title"], j["city"]) for j in jobs})
        summary = run_page("51job", 1, jobs, store)

        self.assertEqual(summary.captured, 4)
        self.assertEqual(summary.inserted, 0)
        self.assertEqual(summary.skipped, summary.captured)
        self.assertEqual(summary.status, STATUS_OK)   # 不是报错
        self.assertTrue(summary.is_success_page)
        self.assertEqual(len(store.saved), 0)


class TestLastPage(unittest.TestCase):
    """情形 3：翻到最后一页（空列表）。"""

    def test_last_page(self):
        store = FakeStore()
        summary = run_page("猎聘", 6, [], store)

        self.assertEqual(summary.captured, 0)
        self.assertEqual(summary.inserted, 0)
        self.assertEqual(summary.skipped, 0)
        self.assertEqual(summary.status, STATUS_LAST_PAGE)
        self.assertTrue(summary.reason)                # 必须写明触发原因
        self.assertFalse(summary.is_success_page)      # 不计入成功页


class TestListFetchFailed(unittest.TestCase):
    """情形 4：列表获取失败（页面加载失败 / 数据包未捕获），必须带原因且不计入成功页。"""

    def test_page_load_failed(self):
        # 模拟 BOSS export 命令失败 / 51job 页面渲染超时：采集器走 abort_page 分支
        buf = io.StringIO()
        with redirect_stdout(buf):
            summary = abort_page("BOSS直聘", 3, STATUS_LOAD_FAILED,
                                 "boss export 命令执行失败: exit code 1", logger=print)
        self.assertEqual(summary.status, STATUS_LOAD_FAILED)
        self.assertTrue(summary.reason)
        self.assertFalse(summary.is_success_page)
        self.assertIn(SUMMARY_PREFIX, buf.getvalue())

    def test_packet_missing(self):
        # 模拟 51job / 猎聘 拦截不到数据包
        summary = abort_page("51job", 1, STATUS_PACKET_MISSING,
                             "未捕获到 api/job/search 数据包", logger=lambda *a: None)
        self.assertEqual(summary.status, STATUS_PACKET_MISSING)
        self.assertTrue(summary.reason)
        self.assertFalse(summary.is_success_page)

    def test_abnormal_status_must_have_reason(self):
        # 非“正常完成”状态若不给原因，模块会自动兜底，保证原因字段非空
        summary = PageSummary("猎聘", 2, status=STATUS_LOAD_FAILED)
        self.assertTrue(summary.reason)
        self.assertFalse(summary.is_success_page)


class TestDetailFetchFailed(unittest.TestCase):
    """情形 5：详情获取失败 => 放弃计数，且这些岗位不入库。"""

    def test_detail_fetch_failed(self):
        jobs = make_fake_jobs(4)
        store = FakeStore()
        detail_fn = make_detail_fn(fail_ids={"J001", "J002"})  # 2 个岗位详情失败
        summary = run_page("BOSS直聘", 1, jobs, store, detail_fn=detail_fn)

        self.assertEqual(summary.captured, 4)
        self.assertEqual(summary.detail_failed, 2)
        self.assertEqual(summary.inserted, 2)
        self.assertEqual(summary.skipped, 0)
        self.assertEqual(summary.status, STATUS_OK)
        # 详情失败的岗位不得入库
        saved_ids = {d["job_link"] for d in store.saved}
        self.assertEqual(saved_ids, {"https://fake.local/J000", "https://fake.local/J003"})


class TestCrossPlatformConsistency(unittest.TestCase):
    """三个平台的小结字段与状态取值必须一致。"""

    EXPECTED_KEYS = {"平台", "页码", "捕获岗位数", "新增入库数", "已存在跳过数",
                     "详情失败放弃数", "结束状态", "触发原因", "计入成功页"}

    def parse_summary_line(self, line):
        self.assertTrue(line.startswith(SUMMARY_PREFIX))
        return json.loads(line[len(SUMMARY_PREFIX):].strip())

    def test_fields_identical_across_platforms(self):
        for platform in PLATFORMS:
            with self.subTest(platform=platform):
                store = FakeStore()
                summary = run_page(platform, 1, make_fake_jobs(3), store)
                buf = io.StringIO()
                with redirect_stdout(buf):
                    emit_page_summary(summary)
                line = buf.getvalue().strip()
                data = self.parse_summary_line(line)
                self.assertEqual(set(data.keys()), self.EXPECTED_KEYS)
                self.assertEqual(data["平台"], platform)
                self.assertIn(data["结束状态"], ALL_STATUSES)
                self.assertIsInstance(data["计入成功页"], bool)

    def test_status_values_limited(self):
        self.assertEqual(set(ALL_STATUSES),
                         {"正常完成", "已到最后一页", "页面加载失败", "数据包未捕获"})
        with self.assertRaises(ValueError):
            PageSummary("51job", 1, status="未知状态")


if __name__ == "__main__":
    unittest.main()
