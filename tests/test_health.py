# -*- coding: utf-8 -*-
"""离线单元测试：源健康度账本 + 抓取失败/过滤为空的区分 + 告警文案 + 落盘规则。

全程不碰真实外网、不发真实 Webhook：
  · 账本逻辑直接调 health.update_health / health.failure_notice（纯函数）
  · fetcher 用 monkeypatch 的假 http_get
  · main 主循环用假 fetch_all、假推送、假时钟走端到端

运行（仓库根目录）：
    python -m unittest discover -s tests -v
"""

import datetime
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

import config          # noqa: E402
import fetcher         # noqa: E402
import health          # noqa: E402
import main as app     # noqa: E402
import state           # noqa: E402


# --------------------------------------------------------------------------
# 1. 账本累加 / 清零 / 同日去重 / 原因保留
# --------------------------------------------------------------------------
class TestUpdateHealth(unittest.TestCase):

    def test_first_failure_counts_one_day(self):
        # 首日失败：记 1 天，原因和最后失败日期一起落账本
        h = {}
        health.update_health(h, {"甲源": "抓取失败：超时"}, "2026-11-01")
        self.assertEqual(h, {
            "甲源": {"count": 1, "reason": "抓取失败：超时", "last": "2026-11-01"},
        })

    def test_second_day_failure_counts_two_days(self):
        # 次日再失败：在原账本上累加
        h = {"甲源": {"count": 1, "reason": "抓取失败：超时", "last": "2026-11-01"}}
        health.update_health(h, {"甲源": "抓取失败：403"}, "2026-11-02")
        self.assertEqual(h["甲源"]["count"], 2)
        self.assertEqual(h["甲源"]["last"], "2026-11-02")
        # 原因随账本刷新保留（排查不用翻历史日志）
        self.assertEqual(h["甲源"]["reason"], "抓取失败：403")

    def test_recovery_resets_to_zero(self):
        # 第三日恢复：账本记录整个移除 —— 连续天数清零，之后不再出现在告警里
        h = {"甲源": {"count": 2, "reason": "抓取失败：403", "last": "2026-11-02"}}
        health.update_health(h, {}, "2026-11-03")
        self.assertNotIn("甲源", h)
        self.assertEqual(health.failure_notice(h), "")

    def test_recovery_then_failure_again_starts_from_one(self):
        # 清零之后再坏，按首日重新计数，不能接着上次的 2 天往上加
        h = {"甲源": {"count": 2, "reason": "旧故障", "last": "2026-11-02"}}
        health.update_health(h, {}, "2026-11-03")
        health.update_health(h, {"甲源": "新故障：500"}, "2026-11-04")
        self.assertEqual(h["甲源"]["count"], 1)
        self.assertEqual(h["甲源"]["reason"], "新故障：500")

    def test_same_day_rerun_does_not_stack(self):
        # 同一天内重复运行：count 不叠加
        h = {"甲源": {"count": 1, "reason": "抓取失败：超时", "last": "2026-11-01"}}
        health.update_health(h, {"甲源": "抓取失败：超时"}, "2026-11-01")
        self.assertEqual(h["甲源"]["count"], 1)
        self.assertEqual(h["甲源"]["last"], "2026-11-01")
        # 同日再来一次仍然是 1
        health.update_health(h, {"甲源": "抓取失败：又超时"}, "2026-11-01")
        self.assertEqual(h["甲源"]["count"], 1)
        # 但原因要刷新成最新的
        self.assertEqual(h["甲源"]["reason"], "抓取失败：又超时")

    def test_mixed_sources_only_failures_counted(self):
        # 一轮里有失败有成功：失败的累加、成功的清零，互不干扰
        h = {
            "甲源": {"count": 2, "reason": "r1", "last": "2026-11-01"},
            "乙源": {"count": 1, "reason": "r2", "last": "2026-11-01"},
        }
        health.update_health(h, {"甲源": "r3"}, "2026-11-02")
        self.assertEqual(h["甲源"]["count"], 3)
        self.assertNotIn("乙源", h)          # 乙源这轮成功 -> 清零

    def test_mutates_in_place_and_returns_same_dict(self):
        h = {}
        self.assertIs(health.update_health(h, {"甲": "r"}, "2026-11-01"), h)

    def test_corrupt_count_is_tolerated(self):
        # 老账本被手滑改坏时不能崩，按 0 重新起步
        h = {"甲源": {"count": "x", "last": "2026-11-01"}}
        health.update_health(h, {"甲源": "r"}, "2026-11-02")
        self.assertEqual(h["甲源"]["count"], 1)


# --------------------------------------------------------------------------
# 2. 告警行：阈值、排序、截断文案
# --------------------------------------------------------------------------
class TestFailureNotice(unittest.TestCase):

    def test_no_health_means_empty_notice(self):
        self.assertEqual(health.failure_notice({}), "")
        self.assertEqual(health.failure_notice(None), "")

    def test_below_threshold_silent(self):
        # 只连续失败 1 天：偶发抖动，不告警
        h = {"甲源": {"count": 1, "reason": "r", "last": "2026-11-01"}}
        self.assertEqual(health.failure_notice(h), "")

    def test_threshold_boundary(self):
        h = {"甲源": {"count": 2, "reason": "r", "last": "2026-11-01"}}
        self.assertEqual(
            health.failure_notice(h),
            "⚠️ 抓取异常：甲源 连续 2 天",
        )

    def test_sorted_by_count_then_name(self):
        # 天数不同按天数降序；天数相同按源名升序
        h = {
            "源B": {"count": 2, "reason": "r", "last": "d"},
            "源D": {"count": 5, "reason": "r", "last": "d"},
            "源A": {"count": 2, "reason": "r", "last": "d"},
            "源C": {"count": 3, "reason": "r", "last": "d"},
        }
        notice = health.failure_notice(h)
        self.assertEqual(
            notice,
            "⚠️ 抓取异常：源D 连续 5 天、源C 连续 3 天、源A 连续 2 天、源B 连续 2 天",
        )

    def test_truncated_to_four_with_total_suffix(self):
        # 5 个源都达阈值：只展示前 4 个，末尾补总数
        h = {
            "源A": {"count": 2, "reason": "r", "last": "d"},
            "源B": {"count": 2, "reason": "r", "last": "d"},
            "源C": {"count": 2, "reason": "r", "last": "d"},
            "源D": {"count": 2, "reason": "r", "last": "d"},
            "源E": {"count": 2, "reason": "r", "last": "d"},
        }
        notice = health.failure_notice(h)
        self.assertTrue(notice.startswith("⚠️ 抓取异常：源A 连续 2 天、源B 连续 2 天、"
                                          "源C 连续 2 天、源D 连续 2 天 等共 5 个源"))
        # 第五个源不出现在展示部分
        self.assertNotIn("源E", notice.split("等共")[0])

    def test_exactly_four_has_no_suffix(self):
        h = {("源%d" % i): {"count": 2, "reason": "r", "last": "d"}
             for i in range(4)}
        notice = health.failure_notice(h)
        self.assertNotIn("等共", notice)


# --------------------------------------------------------------------------
# 3. 「抓取/解析失败」与「抓到了但被过滤为空」必须区分开
# --------------------------------------------------------------------------
def _page(links):
    """拼一个假列表页 HTML。links 为 [(href, 标题文本), ...]。"""
    anchors = "".join('<a href="%s">%s</a>' % (href, title)
                      for href, title in links)
    return "<html><body>%s</body></html>" % anchors


class TestFetcherFailureClassification(unittest.TestCase):

    def _src(self, **over):
        src = {"name": "测试源", "url": "https://example.test/list.html",
               "pattern": r"/article/[\w/-]+\.html", "max": 10}
        src.update(over)
        return src

    def test_http_error_is_a_failure(self):
        # 抓取失败：必须带原因
        with mock.patch.object(fetcher, "http_get",
                               side_effect=RuntimeError("请求失败：timeout")):
            items, reason = fetcher.fetch_source(self._src())
        self.assertEqual(items, [])
        self.assertIsNotNone(reason)
        self.assertIn("抓取失败", reason)

    def test_parse_empty_is_a_failure(self):
        # 页面拿到了但一个条目都解析不出来（pattern 失效/改版）：算解析失败
        with mock.patch.object(fetcher, "http_get",
                               return_value=(_page([("https://other.test/1.html",
                                                     "这是一个足够长的中文标题哦")]), 128)):
            items, reason = fetcher.fetch_source(self._src())
        self.assertEqual(items, [])
        self.assertIsNotNone(reason)

    def test_all_filtered_by_age_is_not_a_failure(self):
        # 抓到了条目，但全被日期窗口过滤成空：源本身正常，不算失败、不进告警
        old = "https://example.test/article/20200101/old-news.html"
        page = _page([(old, "这是一篇发布于很久以前的旧文章标题")])
        with mock.patch.object(fetcher, "http_get", return_value=(page, 128)):
            items, reason = fetcher.fetch_source(self._src(max_age_days=3))
        self.assertEqual(items, [])
        self.assertIsNone(reason)

    def test_all_filtered_by_keywords_is_not_a_failure(self):
        # 抓到了条目，但全被源关键词黑名单过滤成空：同样不算失败
        link = "https://example.test/article/%s-01.html" % datetime.date.today().strftime("%Y%m%d")
        page = _page([(link, "招标公告：某某单位采购项目公示信息")])
        with mock.patch.object(fetcher, "http_get", return_value=(page, 128)):
            items, reason = fetcher.fetch_source(
                self._src(max_age_days=0, exclude=["招标", "采购"]))
        self.assertEqual(items, [])
        self.assertIsNone(reason)

    def test_success_returns_items_without_reason(self):
        link = "https://example.test/article/%s-01.html" % datetime.date.today().strftime("%Y%m%d")
        page = _page([(link, "国务院部署进一步稳就业的最新政策举措")])
        with mock.patch.object(fetcher, "http_get", return_value=(page, 128)):
            items, reason = fetcher.fetch_source(self._src(max_age_days=0))
        self.assertIsNone(reason)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["source"], "测试源")


# --------------------------------------------------------------------------
# 4. 落盘规则：账本随去重索引持久化，内容没变就不写盘
# --------------------------------------------------------------------------
class TestStatePersistence(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "seen.json")
        config.STATE_FILE = self.path

    def tearDown(self):
        self.tmp.cleanup()

    def _read(self):
        with open(self.path, "r", encoding="utf-8") as fp:
            return json.load(fp)

    def _read_bytes(self):
        with open(self.path, "rb") as fp:
            return fp.read()

    def test_health_roundtrip_with_seen_index(self):
        st = state.load_state(self.path)
        st["seen"] = ["https://example.test/a.html"]
        health.update_health(st.setdefault("source_health", {}),
                             {"甲源": "抓取失败：超时"}, "2026-11-01")
        state.save_state(st, self.path)

        again = state.load_state(self.path)
        self.assertEqual(again["seen"], ["https://example.test/a.html"])
        self.assertEqual(again["source_health"],
                         {"甲源": {"count": 1, "reason": "抓取失败：超时",
                                   "last": "2026-11-01"}})

    def test_unchanged_health_does_not_rewrite(self):
        # 同日重跑：count / reason / last 全没变 -> 连 seen 也没变 -> 不产生写盘
        st = state.load_state(self.path)
        health.update_health(st.setdefault("source_health", {}),
                             {"甲源": "抓取失败：超时"}, "2026-11-01")
        state.save_state(st, self.path)
        bytes_after_first = self._read_bytes()
        mtime_after_first = os.path.getmtime(self.path)

        st2 = state.load_state(self.path)
        health.update_health(st2.setdefault("source_health", {}),
                             {"甲源": "抓取失败：超时"}, "2026-11-01")
        state.save_state(st2, self.path)

        self.assertEqual(self._read_bytes(), bytes_after_first)
        self.assertEqual(os.path.getmtime(self.path), mtime_after_first)

    def test_changed_count_does_rewrite(self):
        st = state.load_state(self.path)
        health.update_health(st.setdefault("source_health", {}),
                             {"甲源": "r"}, "2026-11-01")
        state.save_state(st, self.path)
        first = self._read_bytes()

        st2 = state.load_state(self.path)
        health.update_health(st2.setdefault("source_health", {}),
                             {"甲源": "r"}, "2026-11-02")   # 次日 count 变化
        state.save_state(st2, self.path)
        self.assertNotEqual(self._read_bytes(), first)

    def test_reason_change_alone_does_rewrite(self):
        # 同日重跑但原因变了：reason 属于账本内容，必须写盘
        st = state.load_state(self.path)
        health.update_health(st.setdefault("source_health", {}),
                             {"甲源": "原因一"}, "2026-11-01")
        state.save_state(st, self.path)
        first = self._read_bytes()

        st2 = state.load_state(self.path)
        health.update_health(st2.setdefault("source_health", {}),
                             {"甲源": "原因二"}, "2026-11-01")
        state.save_state(st2, self.path)
        self.assertNotEqual(self._read_bytes(), first)


# --------------------------------------------------------------------------
# 5. 端到端：假抓取 + 假推送 + 假时钟，跑通 main() 的多日账本演化
# --------------------------------------------------------------------------
class TestMainFlowEndToEnd(unittest.TestCase):

    SOURCES = [
        {"name": "健康源", "url": "https://a.test/list", "pattern": r"/x\.html",
         "max_age_days": 0},
        {"name": "故障源", "url": "https://b.test/list", "pattern": r"/x\.html",
         "max_age_days": 0},
    ]

    def setUp(self):
        app.setup_logging()
        self.tmp = tempfile.TemporaryDirectory()
        config.STATE_FILE = os.path.join(self.tmp.name, "seen.json")
        config.SOURCES = self.SOURCES
        config.FORCE_IPV4 = False
        config.FIRST_RUN_PUSH = True
        config.DRY_RUN = False
        config.NEWS_DAY = "yesterday"
        # 预置一条历史索引，保证不是"首次运行"分支
        state.save_state({"last_run": "", "seen": ["https://old.test/seen.html"],
                          "source_health": {}}, config.STATE_FILE)
        self.pushed = []

    def tearDown(self):
        self.tmp.cleanup()

    def _fake_item(self, day, n):
        url = "https://a.test/%s/x-%d.html" % (day.strftime("%Y%m%d"), n)
        return {"title": "国务院发布稳就业稳增长的最新政策举措第%d条" % n,
                "url": url, "source": "健康源"}

    def _run_day(self, day, failing):
        """在指定北京时间日期下跑一次 main()。failing=本轮故障源集合。"""
        yday = day - datetime.timedelta(days=1)

        def fake_fetch_all(sources):
            items, failures = [], {}
            for src in sources:
                if src["name"] in failing:
                    failures[src["name"]] = "抓取失败：模拟超时"
                else:
                    items.extend([self._fake_item(yday, 1),
                                  self._fake_item(yday, 2)])
            return items, failures

        pushed = self.pushed

        def fake_push(text, is_success=True):
            pushed.append(text)
            return True

        with mock.patch.object(app, "fetch_all", side_effect=fake_fetch_all), \
             mock.patch.object(app, "safe_push", side_effect=fake_push), \
             mock.patch.object(app, "bj_today", return_value=day):
            ok = app.main()
        self.assertTrue(ok)
        return state.load_state(config.STATE_FILE)

    def test_three_day_arc_rerun_and_recovery(self):
        d1, d2, d3 = (datetime.date(2026, 11, 1),
                      datetime.date(2026, 11, 2),
                      datetime.date(2026, 11, 3))

        # ---- 第 1 天：故障源首日失败，记 1 天（未达阈值，无告警）----
        st = self._run_day(d1, {"故障源"})
        self.assertEqual(st["source_health"]["故障源"]["count"], 1)
        self.assertEqual(st["source_health"]["故障源"]["last"], "2026-11-01")
        self.assertTrue(all("⚠️" not in msg for msg in self.pushed))

        # ---- 同一天再跑一次：不叠加，且账本内容没变 -> 文件不重写 ----
        with open(config.STATE_FILE, "rb") as fp:
            before = fp.read()
        st = self._run_day(d1, {"故障源"})
        with open(config.STATE_FILE, "rb") as fp:
            after = fp.read()
        self.assertEqual(st["source_health"]["故障源"]["count"], 1)
        self.assertEqual(before, after)

        # ---- 第 2 天：再失败记 2 天，告警出现 ----
        st = self._run_day(d2, {"故障源"})
        self.assertEqual(st["source_health"]["故障源"]["count"], 2)
        self.assertTrue(any("⚠️ 抓取异常：故障源 连续 2 天" in msg
                            for msg in self.pushed))

        # ---- 第 3 天：恢复，清零（账本里移除），告警消失 ----
        pushed_before_recovery = len(self.pushed)
        st = self._run_day(d3, set())
        self.assertNotIn("故障源", st["source_health"])
        self.assertTrue(all("⚠️" not in msg
                            for msg in self.pushed[pushed_before_recovery:]))

    def test_all_sources_failing_still_persists_ledger(self):
        # 所有源都失败时 main 会抛 RuntimeError 走失败推送分支，
        # 但账本必须已经落盘（修复点：以前 raise 在 save_state 之前，连续天数丢失）。
        day = datetime.date(2026, 11, 5)
        with mock.patch.object(app, "fetch_all",
                               return_value=([], {"故障源": "抓取失败：模拟超时"})), \
             mock.patch.object(app, "safe_push",
                               side_effect=lambda text, is_success=True:
                                   self.pushed.append(text) or True), \
             mock.patch.object(app, "bj_today", return_value=day):
            self.assertFalse(app.main())

        st = state.load_state(config.STATE_FILE)
        self.assertEqual(st["source_health"]["故障源"]["count"], 1)
        # 失败通知确实发出去了
        self.assertTrue(any("运行失败" in msg for msg in self.pushed))


if __name__ == "__main__":
    unittest.main(verbosity=2)
