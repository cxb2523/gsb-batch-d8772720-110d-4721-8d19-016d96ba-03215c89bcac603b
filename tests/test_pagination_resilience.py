# -*- coding: utf-8 -*-
"""
分页结局 / 断点续跑验收测试

场景:
    1. 第一页正常、第二页超时、第三页有项目
       -> 第二页结局为「异常中断」且带原因、第三页未执行、第一页项目保留
    2. 详情中一条抛异常
       -> 只标记该条为异常并保留模板字段，其余条目继续，摘要含失败条数
    3. 只重跑上次异常中断的页码
       -> 重跑结果与首次采集合并去重，无重复
    4. 全部页面正常但无项目
       -> 结局为「无数据」，而非笼统报错
    5. main.run_spider 捕获爬虫异常，仍用已采集数据走预览与保存

运行方式（仓库根目录）:
    python -I -m pytest tests/test_pagination_resilience.py -v
"""

import functools
import os
import sys
from unittest import mock

import pytest

# 将仓库根目录加入 sys.path（兼容 python -I 隔离模式）
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from spiders.base_spider import BaseSpider
from tests.fake_spider import FakeSpider, ExplodingSpider

# main.py 在 win32 下导入时会重包装 sys.stdout，干扰 pytest 捕获，导入时绕过
with mock.patch.object(sys, "platform", "linux"):
    import main


# ----------------------------------------------------------------------
# 场景 1+2: 第二页超时中断、第三页未执行、第一页项目保留、详情单条失败
# ----------------------------------------------------------------------

def test_page_timeout_interrupts_and_preserves_results():
    spider = FakeSpider(fail_pages={2: "第 2 页加载超时"})
    results = spider.run()

    # 分页结局清单：只有第 1、2 页，第三页未执行
    assert len(spider.page_outcomes) == 2

    page1, page2 = spider.page_outcomes
    assert page1["page"] == 1
    assert page1["status"] == BaseSpider.PAGE_STATUS_SUCCESS
    assert page1["new_items"] == 2

    # 第二页结局为异常中断且带原因
    assert page2["page"] == 2
    assert page2["status"] == BaseSpider.PAGE_STATUS_ERROR
    assert page2["error"] and "超时" in page2["error"]

    # 第三页未执行（结局清单中没有第 3 页）
    assert all(o["page"] != 3 for o in spider.page_outcomes)

    # 第一页项目保留在 results 中
    assert len(results) == 2
    names = [r["项目名称"] for r in results]
    assert "MSc Computer Science" in names
    assert "MSc Data Science" in names

    # 详情阶段：prog_beta.html 故意缺失 -> 恰好 1 条失败
    assert len(spider.failed_details) == 1
    failed = spider.failed_details[0]
    assert failed["name"] == "MSc Data Science"
    assert failed["error"]

    # 失败条目保留模板字段，只标记为异常
    beta = next(r for r in results if r["项目名称"] == "MSc Data Science")
    assert beta["项目deadline"] == "N/A"          # 模板字段保留
    assert beta["详情状态"].startswith("异常")     # 标记为异常

    # 成功条目正常抓取
    alpha = next(r for r in results if r["项目名称"] == "MSc Computer Science")
    assert alpha["项目deadline"] == "2026-01-15"
    assert alpha["详情状态"] == "正常"

    # 失败页码清单可供重跑使用
    assert spider.get_failed_pages() == [2]


def test_summary_lists_outcomes_and_failed_detail_count(capsys):
    spider = FakeSpider(fail_pages={2: "第 2 页加载超时"})
    results = spider.run()

    main.print_collection_summary(spider, results)
    out = capsys.readouterr().out

    # 摘要包含总项目数、各页结局、失败详情条数
    assert "总项目数: 2" in out
    assert "第 1 页" in out and "成功" in out
    assert "第 2 页" in out and "异常中断" in out and "超时" in out
    assert "第 3 页" not in out
    assert "详情抓取失败: 1 条" in out

    # 基类 print_summary 同样可用（冒烟）
    spider.print_summary()


# ----------------------------------------------------------------------
# 场景 3: 只重跑异常中断的页码，合并去重
# ----------------------------------------------------------------------

def test_retry_failed_pages_and_merge_without_duplicates():
    # 首次采集：第二页超时
    first = FakeSpider(fail_pages={2: "第 2 页加载超时"})
    first_results = first.run()
    assert first.get_failed_pages() == [2]

    # 只重跑失败页（第二页已恢复）
    retry = FakeSpider()
    retry.retry_pages = first.get_failed_pages()
    retry_results = retry.run()

    # 重跑只登记了第 2 页的结局
    assert [o["page"] for o in retry.page_outcomes] == [2]
    assert retry.page_outcomes[0]["status"] == BaseSpider.PAGE_STATUS_SUCCESS
    assert retry.page_outcomes[0]["new_items"] == 2

    # 重跑只拿到第二页的项目
    assert {r["项目名称"] for r in retry_results} == {"MSc Finance", "MSc Marketing"}

    # 合并去重：无重复
    merged = BaseSpider.merge_results(first_results, retry_results)
    assert len(merged) == 4
    names = [r["项目名称"] for r in merged]
    assert len(names) == len(set(names))
    assert set(names) == {
        "MSc Computer Science", "MSc Data Science", "MSc Finance", "MSc Marketing",
    }

    # 再次合并相同数据也不产生重复（幂等）
    merged2 = BaseSpider.merge_results(merged, retry_results)
    assert len(merged2) == 4


# ----------------------------------------------------------------------
# 场景 4: 全部页面正常但无项目 -> 结局为「无数据」
# ----------------------------------------------------------------------

def test_all_pages_empty_reports_no_data(capsys):
    spider = FakeSpider(empty=True)
    results = spider.run()

    assert results == []
    assert len(spider.page_outcomes) == 1
    outcome = spider.page_outcomes[0]
    assert outcome["page"] == 1
    assert outcome["status"] == BaseSpider.PAGE_STATUS_NO_DATA
    assert outcome["new_items"] == 0
    assert spider.get_failed_pages() == []

    main.print_collection_summary(spider, results)
    out = capsys.readouterr().out
    # 明确说明是「无数据」而非笼统报错
    assert "无数据" in out
    assert "异常中断" not in out


# ----------------------------------------------------------------------
# 场景 5: main.run_spider 捕获爬虫异常，仍用已采集数据走预览与保存
# ----------------------------------------------------------------------

def test_run_spider_catches_exception_and_still_saves(tmp_path, monkeypatch, capsys):
    saved = {}
    monkeypatch.setattr(main, "save_excel",
                        lambda results, **kw: saved.setdefault("results", results) or "fake.xlsx")
    monkeypatch.setattr(main.config, "OUTPUT_DIR", str(tmp_path))
    monkeypatch.setitem(main.SPIDER_REGISTRY, "fake_uni", ExplodingSpider)

    main.run_spider("fake_uni", auto_confirm=True)

    # 已采集的数据仍然走了保存流程
    assert len(saved["results"]) == 1
    assert saved["results"][0]["项目名称"] == "MSc Computer Science"

    out = capsys.readouterr().out
    assert "爬虫抛出异常" in out
    assert "模拟浏览器崩溃" in out
    assert "总项目数: 1" in out

    # 采集状态已持久化
    state = main.load_spider_state("fake_uni")
    assert state is not None
    assert len(state["results"]) == 1


# ----------------------------------------------------------------------
# 场景 6 (端到端): 通过 main.run_spider 完成 首次中断 -> 重跑失败页 -> 合并
# ----------------------------------------------------------------------

def test_run_spider_retry_failed_end_to_end(tmp_path, monkeypatch, capsys):
    saved = {}
    monkeypatch.setattr(main, "save_excel",
                        lambda results, **kw: saved.setdefault("results", results) or "fake.xlsx")
    monkeypatch.setattr(main.config, "OUTPUT_DIR", str(tmp_path))

    # 首次采集：第二页超时
    monkeypatch.setitem(
        main.SPIDER_REGISTRY, "fake_uni",
        functools.partial(FakeSpider, fail_pages={2: "第 2 页加载超时"}),
    )
    main.run_spider("fake_uni", auto_confirm=True)
    assert len(saved["results"]) == 2  # 第一页项目保留

    state = main.load_spider_state("fake_uni")
    assert state["failed_pages"] == [2]
    assert state["page_outcomes"][1]["status"] == BaseSpider.PAGE_STATUS_ERROR

    out = capsys.readouterr().out
    assert "第 2 页" in out and "异常中断" in out
    assert "详情抓取失败: 1 条" in out

    # 只重跑失败页（第二页已恢复），结果与首次采集合并去重
    monkeypatch.setitem(main.SPIDER_REGISTRY, "fake_uni", FakeSpider)
    saved.clear()
    main.run_spider("fake_uni", retry_failed=True, auto_confirm=True)

    merged = saved["results"]
    assert len(merged) == 4
    names = [r["项目名称"] for r in merged]
    assert len(names) == len(set(names))  # 无重复

    # 状态更新：失败页已清空
    state = main.load_spider_state("fake_uni")
    assert state["failed_pages"] == []

    out = capsys.readouterr().out
    assert "只重跑上次异常中断的页码: [2]" in out
    assert "合并" in out


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
