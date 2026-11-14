"""逐页结局（page_outcomes）测试：用构造的响应字典覆盖五类结局，不依赖真实浏览器。

覆盖：
  - classify_page_outcome 纯函数：成功、空结果、受限、登录失效、响应缺失/无效
  - build_page_summary 汇总口径
  - scrape_list 集成（FakeCaptureCDP + mock）：
      * 多页混合结局随结果文件落盘
      * 受限/登录失效在翻页途中终止且不伪造后续页结局
      * 响应缺失按既有逻辑继续翻页
      * hasMore=false 提前结束时未抓的页没有结局
      * 某页失败不丢前面页已抓数据
"""

import importlib.util
import io
import json
import pathlib
import random
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest import mock


# Windows GBK 控制台无法编码 emoji，统一重配 UTF-8（与 test_chrome_setup.py 一致）。
for _stream in (sys.stdout, sys.stderr):
    if _stream is not None and hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")


SCRIPT_PATH = pathlib.Path(__file__).resolve().parents[1] / "scripts" / "boss_cdp_raw.py"


def load_module():
    sys.modules.setdefault("websocket", mock.Mock())
    sys.modules.setdefault("requests", mock.Mock())
    spec = importlib.util.spec_from_file_location("boss_cdp_raw_outcomes", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def joblist_response(jobs, has_more=True, code=0, message=""):
    """构造一个 BOSS joblist.json 响应字典。"""
    return {
        "code": code,
        "message": message,
        "zpData": {"hasMore": has_more, "jobList": jobs},
    }


def job(name="A", salary="20-40K", encrypt_job_id="e1"):
    return {
        "jobName": name,
        "salaryDesc": salary,
        "encryptJobId": encrypt_job_id,
    }


class ClassifyPageOutcomeTests(unittest.TestCase):
    def setUp(self):
        self.module = load_module()
        self.P = self.module.PageOutcomeType

    def test_success_with_plaintext_salary_jobs(self):
        data = joblist_response([job(salary="20-40K")])

        outcome, probe, description = self.module.classify_page_outcome(data)

        self.assertIs(outcome, self.P.SUCCESS)
        self.assertIs(probe.status, self.module.LoginProbeStatus.AVAILABLE)
        self.assertIsInstance(description, str) and description

    def test_empty_when_api_ok_but_no_jobs(self):
        data = joblist_response([])

        outcome, _probe, description = self.module.classify_page_outcome(data)

        self.assertIs(outcome, self.P.EMPTY)
        self.assertIn("空", description)

    def test_restricted_on_risk_control_code(self):
        data = {"code": 37, "message": "您的环境存在异常."}

        outcome, probe, _description = self.module.classify_page_outcome(data)

        self.assertIs(outcome, self.P.RESTRICTED)
        self.assertIs(probe.status, self.module.LoginProbeStatus.RESTRICTED)
        self.assertEqual(probe.code, 37)

    def test_restricted_on_http_403_and_429(self):
        for status in (403, 429):
            with self.subTest(http_status=status):
                outcome, probe, _ = self.module.classify_page_outcome({}, http_status=status)
                self.assertIs(outcome, self.P.RESTRICTED)
                self.assertIs(probe.status, self.module.LoginProbeStatus.RESTRICTED)

    def test_login_invalid_when_jobs_have_no_plaintext_salary(self):
        # code=0 且有职位但 salaryDesc 全空 = 未登录（沿用 classify_login_probe_response）
        data = joblist_response([job(salary="")])

        outcome, probe, _ = self.module.classify_page_outcome(data)

        self.assertIs(outcome, self.P.LOGIN_INVALID)
        self.assertIs(probe.status, self.module.LoginProbeStatus.UNAUTHENTICATED)

    def test_login_invalid_on_http_401(self):
        outcome, probe, _ = self.module.classify_page_outcome({}, http_status=401)

        self.assertIs(outcome, self.P.LOGIN_INVALID)
        self.assertIs(probe.status, self.module.LoginProbeStatus.UNAUTHENTICATED)

    def test_response_error_when_no_response_captured(self):
        # 超时 / 未捕获到响应：wait_next_response 返回 None
        outcome, probe, description = self.module.classify_page_outcome(None)

        self.assertIs(outcome, self.P.RESPONSE_ERROR)
        self.assertIsNone(probe)
        self.assertIn("未捕获", description)

    def test_response_error_on_non_dict_body(self):
        outcome, _probe, _ = self.module.classify_page_outcome("not-a-json-object")

        self.assertIs(outcome, self.P.RESPONSE_ERROR)

    def test_response_error_on_business_error_code(self):
        data = {"code": 7, "message": "业务异常"}

        outcome, probe, _ = self.module.classify_page_outcome(data)

        self.assertIs(outcome, self.P.RESPONSE_ERROR)
        self.assertIs(probe.status, self.module.LoginProbeStatus.RESPONSE_ERROR)

    def test_terminal_outcome_set_only_contains_login_and_restricted(self):
        self.assertEqual(
            set(self.module.TERMINAL_PAGE_OUTCOMES),
            {self.P.LOGIN_INVALID, self.P.RESTRICTED},
        )

    def test_build_page_summary_counts_each_bucket(self):
        module = self.module
        outcomes = [
            {"page": 1, "outcome": module.PageOutcomeType.SUCCESS.value,
             "description": "", "job_count": 2},
            {"page": 2, "outcome": module.PageOutcomeType.EMPTY.value,
             "description": "", "job_count": 0},
            {"page": 3, "outcome": module.PageOutcomeType.RESPONSE_ERROR.value,
             "description": "", "job_count": 0},
            {"page": 4, "outcome": module.PageOutcomeType.RESTRICTED.value,
             "description": "", "job_count": 0},
        ]

        summary = module.build_page_summary(outcomes)

        self.assertEqual(summary, {
            "total_pages": 4,
            "success_pages": 1,
            "empty_pages": 1,
            "failed_pages": 2,  # 响应异常 + 受限；空结果不计失败
        })
        # 三类结局之和恒等于总页数
        self.assertEqual(
            summary["success_pages"] + summary["empty_pages"] + summary["failed_pages"],
            summary["total_pages"],
        )

    def test_print_report_lists_every_page_and_stop_reason(self):
        module = self.module
        outcomes = [
            {"page": 1, "outcome": module.PageOutcomeType.SUCCESS.value,
             "description": "ok", "job_count": 3},
            {"page": 2, "outcome": module.PageOutcomeType.RESTRICTED.value,
             "description": "风控", "job_count": 0},
        ]
        summary = module.build_page_summary(outcomes)
        buffer = io.StringIO()

        with redirect_stdout(buffer):
            module.print_page_outcome_report(
                outcomes, summary, stop_line="  已终止后续翻页"
            )

        text = buffer.getvalue()
        self.assertIn("第 1 页", text)
        self.assertIn("第 2 页", text)
        self.assertIn("受限", text)
        self.assertIn("成功", text)
        self.assertIn("已终止后续翻页", text)
        self.assertIn("共 2 页", text)


class FakeCaptureCDP:
    """支持 Network 事件被动捕获的最小 CDP stub（与 test_chrome_setup.py 同款思路）。"""

    def __init__(self, pending_batches=None, responses=None):
        self.events = []
        self.pending = list(pending_batches or [])
        self.responses = dict(responses or {})
        self.sent = []

    @property
    def sent_methods(self):
        return [method for method, _ in self.sent]

    def send(self, method, params=None, sid=None):
        self.sent.append((method, params or {}))
        if method == "Network.getResponseBody":
            request_id = params["requestId"]
            return {"result": {"body": self.responses[request_id], "base64Encoded": False}}
        if method == "Target.createTarget":
            return {"result": {"targetId": "fake-target"}}
        if method == "Target.attachToTarget":
            return {"result": {"sessionId": "fake-session"}}
        return {"result": {}}

    def drain_events(self, duration):
        # 与真实 CDPSession 一致：只有缓冲里没有已完成的待消费 joblist 时，
        # wait_next_response 才会调 drain_events；这里按调用即交付一个批次建模。
        if self.pending:
            self.events.extend(self.pending.pop(0))

    def eval_js(self, js, sid):
        self.sent.append(("Runtime.evaluate", {"expression": js}))
        return None

    def close(self):
        pass


def make_joblist_events(request_id,
                        url="https://www.zhipin.com/wapi/zpgeek/search/joblist.json?_=1"):
    return [
        {"method": "Network.requestWillBeSent",
         "params": {"requestId": request_id, "request": {"url": url}}},
        {"method": "Network.responseReceived",
         "params": {"requestId": request_id, "response": {"url": url, "status": 200}}},
        {"method": "Network.loadingFinished",
         "params": {"requestId": request_id}},
    ]


class ScrapeListPageOutcomeTests(unittest.TestCase):
    def _run(self, module, cdp, output_path, pages=3, **kwargs):
        module._request_counter = 0
        with mock.patch.object(module, "CDPSession", lambda port=9222: cdp), \
                mock.patch.object(module, "resolve_city",
                                  return_value=("上海", "101020100")), \
                mock.patch("time.sleep", lambda s: None), \
                mock.patch.object(module, "random", random.Random(7)), \
                redirect_stdout(io.StringIO()) as stdout:
            result = module.scrape_list(
                "Java", "上海", pages, {}, output_path, cdp_port=9333, **kwargs
            )
        return result, stdout.getvalue()

    def _read_output(self, path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)

    def test_mixed_outcomes_are_recorded_and_persisted(self):
        module = load_module()
        page1 = joblist_response([job("A", "10K", "e1"), job("B", "20K", "e2")],
                                 has_more=True)
        # 第 2 页超时未捕获；第 3 页恢复并到最后一页
        page3 = joblist_response([job("C", "30K", "e3")], has_more=False)
        scripted_responses = [page1, None, page3]
        cdp = FakeCaptureCDP()

        # 直接脚本化捕获结果，避免事件批次时序与 drain 细节耦合
        with mock.patch.object(
            module.NetworkJoblistCapture,
            "wait_next_response",
            autospec=True,
            side_effect=lambda instance, timeout, trigger=None, poll=0.5:
                scripted_responses.pop(0),
        ):
            with tempfile.TemporaryDirectory() as tmp:
                output_path = str(pathlib.Path(tmp) / "jobs.json")
                result, text = self._run(module, cdp, output_path, pages=3)
                saved = self._read_output(output_path)

        outcomes = result["page_outcomes"]
        self.assertEqual([item["page"] for item in outcomes], [1, 2, 3])
        self.assertEqual(
            [item["outcome"] for item in outcomes],
            [
                module.PageOutcomeType.SUCCESS.value,
                module.PageOutcomeType.RESPONSE_ERROR.value,
                module.PageOutcomeType.SUCCESS.value,
            ],
        )
        self.assertEqual(outcomes[0]["job_count"], 2)
        self.assertEqual(outcomes[1]["job_count"], 0)
        self.assertEqual(outcomes[2]["job_count"], 1)
        # 响应缺失不终止：第 3 页照常抓到，前面页数据不丢
        self.assertEqual(result["total"], 3)
        self.assertEqual([j["title"] for j in result["jobs"]], ["A", "B", "C"])
        # 汇总口径
        self.assertEqual(result["page_summary"], {
            "total_pages": 3,
            "success_pages": 2,
            "empty_pages": 0,
            "failed_pages": 1,
        })
        # 结果文件同步落盘逐页结局与汇总
        self.assertEqual(saved["page_outcomes"], outcomes)
        self.assertEqual(saved["page_summary"], result["page_summary"])
        # 终端清单逐页可见，并标明停在最后一页
        self.assertIn("逐页结局", text)
        self.assertIn("第 2 页", text)
        self.assertIn("响应异常", text)

    def test_restricted_mid_pagination_stops_and_keeps_prior_pages(self):
        module = load_module()
        page1 = joblist_response([job("A", "10K", "e1")], has_more=True)
        page2 = {"code": 37, "message": "您的环境存在异常."}
        cdp = FakeCaptureCDP(
            pending_batches=[make_joblist_events("r1"), make_joblist_events("r2")],
            responses={"r1": json.dumps(page1), "r2": json.dumps(page2)},
        )

        with tempfile.TemporaryDirectory() as tmp:
            output_path = str(pathlib.Path(tmp) / "jobs.json")
            result, text = self._run(module, cdp, output_path, pages=5)
            saved = self._read_output(output_path)

        # 受限在第 2 页终止，只记录 2 条结局，未抓的 3-5 页不伪造
        self.assertEqual([item["page"] for item in result["page_outcomes"]], [1, 2])
        self.assertEqual(result["page_outcomes"][1]["outcome"],
                         module.PageOutcomeType.RESTRICTED.value)
        self.assertEqual(result["page_summary"]["failed_pages"], 1)
        self.assertEqual(result["page_summary"]["success_pages"], 1)
        # 前面页已抓数据保留
        self.assertEqual(result["total"], 1)
        self.assertEqual([j["title"] for j in result["jobs"]], ["A"])
        # 终止信息落盘 + 上终端
        self.assertEqual(saved["page_outcomes"], result["page_outcomes"])
        self.assertIn("已终止后续翻页", text)
        self.assertIn("受限", text)
        # 受限后不再发起任何翻页滚动/导航
        self.assertEqual(cdp.sent_methods.count("Page.navigate"), 1)

    def test_login_invalid_mid_pagination_stops_further_pages(self):
        module = load_module()
        page1 = joblist_response([job("A", "10K", "e1")], has_more=True)
        # 第 2 页 code=0 但职位薪资全空 -> 登录失效
        page2 = joblist_response([job("B", "", "e2")], has_more=True)
        cdp = FakeCaptureCDP(
            pending_batches=[make_joblist_events("r1"), make_joblist_events("r2")],
            responses={"r1": json.dumps(page1), "r2": json.dumps(page2)},
        )

        with tempfile.TemporaryDirectory() as tmp:
            output_path = str(pathlib.Path(tmp) / "jobs.json")
            result, _text = self._run(module, cdp, output_path, pages=4)

        self.assertEqual([item["page"] for item in result["page_outcomes"]], [1, 2])
        self.assertEqual(result["page_outcomes"][1]["outcome"],
                         module.PageOutcomeType.LOGIN_INVALID.value)
        self.assertEqual(result["total"], 1)

    def test_first_page_login_gate_records_outcome_before_raising(self):
        """首屏登录墙仍抛 LoginGateError（既有退出语义），但结局要先落盘。"""
        module = load_module()
        restricted = {"code": 37, "message": "您的环境存在异常."}
        cdp = FakeCaptureCDP(
            pending_batches=[make_joblist_events("r1")],
            responses={"r1": json.dumps(restricted)},
        )

        with tempfile.TemporaryDirectory() as tmp:
            output_path = str(pathlib.Path(tmp) / "jobs.json")
            with self.assertRaises(module.LoginGateError):
                self._run(module, cdp, output_path, pages=3)
            saved = self._read_output(output_path)

        self.assertEqual(len(saved["page_outcomes"]), 1)
        self.assertEqual(saved["page_outcomes"][0]["page"], 1)
        self.assertEqual(saved["page_outcomes"][0]["outcome"],
                         module.PageOutcomeType.RESTRICTED.value)
        self.assertEqual(saved["page_summary"]["failed_pages"], 1)
        self.assertEqual(saved["total"], 0)

    def test_empty_result_page_is_not_counted_as_failure(self):
        module = load_module()
        page1 = joblist_response([], has_more=False)
        cdp = FakeCaptureCDP(
            pending_batches=[make_joblist_events("r1")],
            responses={"r1": json.dumps(page1)},
        )

        with tempfile.TemporaryDirectory() as tmp:
            output_path = str(pathlib.Path(tmp) / "jobs.json")
            result, text = self._run(module, cdp, output_path, pages=3)
            saved = self._read_output(output_path)

        # 空结果 + hasMore=false：只抓 1 页，后两页不伪造结局
        self.assertEqual(len(result["page_outcomes"]), 1)
        self.assertEqual(result["page_outcomes"][0]["outcome"],
                         module.PageOutcomeType.EMPTY.value)
        self.assertEqual(result["page_summary"], {
            "total_pages": 1,
            "success_pages": 0,
            "empty_pages": 1,
            "failed_pages": 0,
        })
        self.assertEqual(result["total"], 0)
        # 零职位也落盘了结局文件
        self.assertEqual(saved["page_outcomes"], result["page_outcomes"])
        self.assertIn("空结果", text)

    def test_has_more_false_does_not_fabricate_outcomes_for_unfetched_pages(self):
        module = load_module()
        page1 = joblist_response([job("A", "10K", "e1")], has_more=False)
        cdp = FakeCaptureCDP(
            pending_batches=[make_joblist_events("r1")],
            responses={"r1": json.dumps(page1)},
        )

        with tempfile.TemporaryDirectory() as tmp:
            output_path = str(pathlib.Path(tmp) / "jobs.json")
            result, _ = self._run(module, cdp, output_path, pages=5)

        self.assertEqual([item["page"] for item in result["page_outcomes"]], [1])
        self.assertEqual(result["page_summary"]["total_pages"], 1)

    def test_missing_response_on_every_page_leaves_error_outcomes(self):
        module = load_module()
        cdp = FakeCaptureCDP()  # 永远不交付 joblist 事件
        with mock.patch.object(module.NetworkJoblistCapture,
                               "wait_next_response", return_value=None):
            with tempfile.TemporaryDirectory() as tmp:
                output_path = str(pathlib.Path(tmp) / "jobs.json")
                result, text = self._run(module, cdp, output_path, pages=3)

        self.assertEqual(len(result["page_outcomes"]), 3)
        self.assertTrue(
            all(item["outcome"] == module.PageOutcomeType.RESPONSE_ERROR.value
                for item in result["page_outcomes"])
        )
        self.assertEqual(result["page_summary"]["failed_pages"], 3)
        self.assertIn("响应异常", text)


if __name__ == "__main__":
    unittest.main()
