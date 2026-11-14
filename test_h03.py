# coding=utf-8
"""h03.collect 采集器的离线测试（不发任何真实网络请求）。

用本地伪造的 HTML 响应与假取页函数覆盖：
1. 多页正常走到末页；
2. 中间某页请求失败，但后续页仍被尝试；
3. 页数上限截断，并列出未采页；
4. 从断点续采与一次采完结果一致；
以及首页请求失败、页面找不到下一页标识等边界。

运行：python -I -m unittest -v test_h03
"""
import os
import tempfile
import unittest

import h03
from h03 import (
    collect, build_url, extract_next_token, default_fetch,
    STATUS_SUCCESS, STATUS_FAILED, STATUS_PENDING,
)

MARKER_ID = h03.MARKER_DIV_ID


def make_html(next_token):
    """构造一页伪造 HTML，下一页标识放在指定 div 的文本里。

    next_token=None 表示不放标识 div（模拟标识缺失）；''表示空标识（末页）。
    """
    if next_token is None:
        return '<html><body><div>no marker here</div></body></html>'
    return ('<html><body><div id="%s">%s</div></body></html>'
            % (MARKER_ID, next_token))


class FakeFetcher:
    """按 token 链提供本地伪造 HTML 的取页器。

    pages: {token: html}，token 为空串表示首页。
    fail_once: 这些 token 的第一次请求抛异常（模拟瞬时故障，可被重试恢复）。
    fail_always: 这些 token 的所有请求都抛异常（模拟持续故障）。
    """

    def __init__(self, pages, fail_once=None, fail_always=None):
        self.pages = pages
        self.fail_once = set(fail_once or [])
        self.fail_always = set(fail_always or [])
        self.calls = []  # (url, attempt_token)

    def __call__(self, url):
        # 由 url 反查 token：首页 url 不含末段
        token = '' if url == build_url('') else url.rsplit('/', 1)[-1]
        self.calls.append(url)
        if token in self.fail_always:
            raise RuntimeError('simulated permanent failure for %r' % token)
        if token in self.fail_once:
            self.fail_once.discard(token)
            raise ConnectionError('simulated transient failure for %r' % token)
        if token not in self.pages:
            raise KeyError('no fake page for token %r' % token)
        return self.pages[token]


def make_chain(tokens):
    """tokens 为每一页的页面标识，首页标识恒为 ''；末页 div 给空标识。"""
    pages = {}
    for index, token in enumerate(tokens):
        next_token = tokens[index + 1] if index + 1 < len(tokens) else ''
        pages[token] = make_html(next_token)
    return pages


def status_map(summary):
    return {item['page']: item['status'] for item in summary['pages']}


class H03CollectorTest(unittest.TestCase):

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.data_dir = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    @staticmethod
    def _rmtree(path):
        import shutil
        shutil.rmtree(path, ignore_errors=True)

    def run_collect(self, fetcher, **kwargs):
        kwargs.setdefault('data_dir', self.data_dir)
        kwargs.setdefault('fetcher', fetcher)
        return collect(**kwargs)

    # 场景 1：多页正常走到末页 ------------------------------------------
    def test_multi_pages_walk_to_natural_end(self):
        tokens = ['', 'p1', 'p2', 'p3']
        fetcher = FakeFetcher(make_chain(tokens))

        summary = self.run_collect(fetcher, max_pages=10)

        self.assertEqual(summary['success_count'], 4)
        self.assertEqual(summary['failed_count'], 0)
        self.assertEqual(summary['pending_count'], 0)
        self.assertEqual(summary['end_reason'], 'natural_end')
        self.assertIsNone(summary['resume_token'])
        self.assertEqual(summary['pending_pages'], [])

        # 逐页明细：页码、地址、结局、下一页标识
        expected_status = {1: STATUS_SUCCESS, 2: STATUS_SUCCESS,
                           3: STATUS_SUCCESS, 4: STATUS_SUCCESS}
        self.assertEqual(status_map(summary), expected_status)
        for page_no, token in enumerate(tokens, start=1):
            record = summary['pages'][page_no - 1]
            self.assertEqual(record['page'], page_no)
            self.assertEqual(record['token'], token)
            self.assertEqual(record['url'], build_url(token))
            self.assertEqual(record['status'], STATUS_SUCCESS)
            self.assertEqual(record['reason'], '')
        self.assertEqual(summary['pages'][0]['next_token'], 'p1')
        self.assertEqual(summary['pages'][-1]['next_token'], '')

        # 请求顺序沿标识链逐页推进，每页恰好请求一次
        self.assertEqual(fetcher.calls, [build_url(t) for t in tokens])

        # 每页 HTML 都落盘
        self.assertTrue(os.path.isfile(os.path.join(self.data_dir, 'h03.html')))
        for token in tokens[1:]:
            self.assertTrue(os.path.isfile(
                os.path.join(self.data_dir, 'h03_%s.html' % token)))

        # 末页空标识与标识缺失语义不同
        self.assertEqual(extract_next_token(make_html('')), '')
        self.assertIsNone(extract_next_token(make_html(None)))

    # 场景 2a：中间页瞬时失败，重试后继续，后续页仍被尝试 ---------------
    def test_middle_page_transient_failure_retried_and_continues(self):
        tokens = ['', 'p1', 'p2', 'p3']
        fetcher = FakeFetcher(make_chain(tokens), fail_once={'p2'})

        summary = self.run_collect(fetcher, max_pages=10, max_retries=1)

        self.assertEqual(summary['success_count'], 4)
        self.assertEqual(summary['failed_count'], 0)
        self.assertEqual(summary['pending_count'], 0)
        self.assertEqual(summary['end_reason'], 'natural_end')
        self.assertEqual(status_map(summary),
                         {1: STATUS_SUCCESS, 2: STATUS_SUCCESS,
                          3: STATUS_SUCCESS, 4: STATUS_SUCCESS})

        # p2 被请求了两次（首次失败 + 重试），后续 p3 仍被尝试
        self.assertEqual(fetcher.calls.count(build_url('p2')), 2)
        self.assertIn(build_url('p3'), fetcher.calls)
        # 成功页明细里如实保留了首次失败的原因痕迹
        p2_record = summary['pages'][2]
        self.assertIn('第1次请求失败', p2_record['reason'])
        self.assertIn('重试后成功', p2_record['reason'])

    # 场景 2b：中间页持续失败不中断，该页记失败，链路中断 ---------------
    def test_middle_page_permanent_failure_marked_not_faked(self):
        tokens = ['', 'p1', 'p2', 'p3']
        fetcher = FakeFetcher(make_chain(tokens), fail_always={'p2'})

        summary = self.run_collect(fetcher, max_pages=10)

        self.assertEqual(summary['success_count'], 2)   # 首页、p1 已成功
        self.assertEqual(summary['failed_count'], 1)    # p2 失败
        self.assertEqual(summary['pending_count'], 0)
        self.assertEqual(summary['end_reason'], 'request_failed')
        self.assertEqual(summary['resume_token'], 'p2')

        statuses = status_map(summary)
        self.assertEqual(statuses[1], STATUS_SUCCESS)
        self.assertEqual(statuses[2], STATUS_SUCCESS)
        self.assertEqual(statuses[3], STATUS_FAILED)
        failed = summary['pages'][2]
        self.assertEqual(failed['token'], 'p2')
        self.assertEqual(failed['url'], build_url('p2'))
        self.assertIn('simulated permanent failure', failed['reason'])
        self.assertNotIn(4, statuses)  # 未采页不得伪装成成功
        # 失败页不写 HTML
        self.assertFalse(os.path.isfile(
            os.path.join(self.data_dir, 'h03_p2.html')))

        # 用 resume_token 续采：恢复后集合与一次采完一致、不重复计入
        fetcher2 = FakeFetcher(make_chain(tokens))
        resumed = self.run_collect(
            fetcher2, start_token=summary['resume_token'],
            prior_pages=summary['pages'], max_pages=10)
        self.assertEqual(resumed['end_reason'], 'natural_end')
        self.assertEqual(resumed['success_count'], 4)
        self.assertEqual(resumed['failed_count'], 0)
        self.assertEqual(resumed['pending_count'], 0)
        pages = resumed['pages']
        self.assertEqual([p['page'] for p in pages], [1, 2, 3, 4])
        self.assertEqual([p['status'] for p in pages],
                         [STATUS_SUCCESS] * 4)
        # 历史成功页未被重新请求
        self.assertNotIn(build_url(''), fetcher2.calls)
        self.assertNotIn(build_url('p1'), fetcher2.calls)
        self.assertEqual(fetcher2.calls,
                         [build_url('p2'), build_url('p3')])

    # 场景 3：页数上限截断，并列出未采页 -------------------------------
    def test_limit_truncation_lists_pending_pages(self):
        tokens = ['', 'p1', 'p2', 'p3', 'p4']
        fetcher = FakeFetcher(make_chain(tokens))

        summary = self.run_collect(fetcher, max_pages=3)

        self.assertEqual(summary['success_count'], 3)
        self.assertEqual(summary['failed_count'], 0)
        self.assertEqual(summary['pending_count'], 1)
        self.assertEqual(summary['end_reason'], 'limit_truncated')

        statuses = status_map(summary)
        self.assertEqual(statuses, {1: STATUS_SUCCESS, 2: STATUS_SUCCESS,
                                    3: STATUS_SUCCESS, 4: STATUS_PENDING})
        pending = summary['pages'][3]
        self.assertEqual(pending['token'], 'p3')
        self.assertEqual(pending['url'], build_url('p3'))
        self.assertIn('页数上限', pending['reason'])

        # 未采页面清单
        self.assertEqual(len(summary['pending_pages']), 1)
        self.assertEqual(summary['pending_pages'][0]['page'], 4)
        self.assertEqual(summary['resume_token'], 'p3')

        # 截断后再续采，最终与一次采完一致
        fetcher2 = FakeFetcher(make_chain(tokens))
        resumed = self.run_collect(
            fetcher2, start_token=summary['resume_token'],
            prior_pages=summary['pages'], max_pages=10)
        self.assertEqual(resumed['end_reason'], 'natural_end')
        self.assertEqual(resumed['success_count'], 5)
        self.assertEqual(resumed['failed_count'], 0)
        self.assertEqual(resumed['pending_count'], 0)

    # 场景 4：从断点续采与一次性采完的页面集合一致 ----------------------
    def test_resume_matches_one_shot_collection(self):
        tokens = ['', 'p1', 'p2', 'p3', 'p4']
        pages = make_chain(tokens)

        # 一次性采完（独立临时目录，与续采目录平级）
        one_shot_dir = tempfile.mkdtemp()
        self.addCleanup(self._rmtree, one_shot_dir)
        one_shot = collect(max_pages=10, data_dir=one_shot_dir,
                           fetcher=FakeFetcher(pages))

        # 分两段采：先采 3 页（被上限截断），再从断点续采
        resumed_dir = tempfile.mkdtemp()
        self.addCleanup(self._rmtree, resumed_dir)
        first = collect(max_pages=3, data_dir=resumed_dir,
                        fetcher=FakeFetcher(pages))
        self.assertEqual(first['end_reason'], 'limit_truncated')
        second = collect(
            max_pages=10, data_dir=resumed_dir, fetcher=FakeFetcher(pages),
            start_token=first['resume_token'],
            prior_pages=first['pages'])

        # 计数、结束原因、逐页（页码/标识/结局/下一页标识）完全一致
        self.assertEqual(second['end_reason'], one_shot['end_reason'])
        for key in ('success_count', 'failed_count', 'pending_count'):
            self.assertEqual(second[key], one_shot[key], key)
        self.assertEqual(len(second['pages']), len(one_shot['pages']))
        for got, expected in zip(second['pages'], one_shot['pages']):
            self.assertEqual(got['page'], expected['page'])
            self.assertEqual(got['token'], expected['token'])
            self.assertEqual(got['url'], expected['url'])
            self.assertEqual(got['status'], expected['status'])
            self.assertEqual(got['next_token'], expected['next_token'])

        # 页面集合一致且不重复：每页恰好一个 HTML 文件
        one_shot_files = sorted(os.listdir(one_shot_dir))
        resumed_files = sorted(os.listdir(resumed_dir))
        self.assertEqual(resumed_files, one_shot_files)
        self.assertEqual(len(resumed_files), len(tokens))
        for name in resumed_files:
            with open(os.path.join(one_shot_dir, name), encoding='utf-8') as f:
                expected_html = f.read()
            with open(os.path.join(resumed_dir, name), encoding='utf-8') as f:
                resumed_html = f.read()
            self.assertEqual(resumed_html, expected_html)

        # 自然到末页后没有可续采标识，也不产生重复明细
        self.assertIsNone(second['resume_token'])
        self.assertEqual(len(second['pages']), len(tokens))
        self.assertEqual(len(set(p['token'] for p in second['pages'])),
                         len(tokens))

    # 边界 A：首页请求失败，正常返回汇总，不抛异常 ----------------------
    def test_homepage_request_failure_returns_summary(self):
        fetcher = FakeFetcher(make_chain(['', 'p1']), fail_always={''})

        summary = self.run_collect(fetcher, max_pages=10)

        self.assertEqual(summary['success_count'], 0)
        self.assertEqual(summary['failed_count'], 1)
        self.assertEqual(summary['pending_count'], 0)
        self.assertEqual(summary['end_reason'], 'homepage_request_failed')
        self.assertEqual(summary['resume_token'], '')
        record = summary['pages'][0]
        self.assertEqual(record['page'], 1)
        self.assertEqual(record['url'], build_url(''))
        self.assertEqual(record['status'], STATUS_FAILED)
        self.assertIn('simulated permanent failure', record['reason'])

    # 边界 B：页面找不到下一页标识，正常返回汇总，不抛异常 --------------
    def test_marker_missing_returns_summary(self):
        pages = {'': make_html('p1'), 'p1': make_html(None)}
        fetcher = FakeFetcher(pages)

        summary = self.run_collect(fetcher, max_pages=10)

        self.assertEqual(summary['success_count'], 2)
        self.assertEqual(summary['failed_count'], 0)
        self.assertEqual(summary['pending_count'], 0)
        self.assertEqual(summary['end_reason'], 'marker_not_found')
        last = summary['pages'][-1]
        self.assertEqual(last['status'], STATUS_SUCCESS)
        self.assertIsNone(last['next_token'])
        self.assertIn('找不到下一页标识', last['reason'])

    # 边界 C：默认取页函数确实使用 base_url 与 myheaders（离线拦截） ----
    def test_default_fetcher_uses_base_url_and_headers(self):
        captured = {}

        class FakeResponse:
            text = make_html('')

            def raise_for_status(self):
                return None

        def fake_get(url, headers=None, timeout=None):
            captured['url'] = url
            captured['headers'] = headers
            captured['timeout'] = timeout
            return FakeResponse()

        original_get = h03.requests.get
        h03.requests.get = fake_get
        try:
            html = default_fetch(build_url(''))
        finally:
            h03.requests.get = original_get

        self.assertEqual(html, make_html(''))
        self.assertEqual(captured['url'], build_url(''))
        self.assertEqual(captured['headers'], h03.myheaders)


if __name__ == '__main__':
    unittest.main(verbosity=2)
