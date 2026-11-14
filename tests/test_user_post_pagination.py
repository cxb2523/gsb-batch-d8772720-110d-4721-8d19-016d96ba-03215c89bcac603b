# -*- coding: utf-8 -*-
"""博主主页笔记采集链路测试。

全部基于本地假接口 mock_xhs_api.MockXhsApiClient，不依赖真实平台凭据，
也不发起任何真实网络请求。覆盖：
- 成功页 / 空页 / 请求异常 / 详情失败 四种情况；
- CSV 行数与成功页条数一致；
- 日志中每页恰好一条结局；
- 失败页不被计为成功；
- 图片下载失败不影响 CSV 行；
- wait_sec 配置校验（<1 秒、文件缺失报错退出）；
- 中途中断时已完成页仍保留在 CSV 中。
"""
import csv
import json
import logging
import time

import pytest

from xhs_user_post_tool import XhsUserPosted
from mock_xhs_api import MockXhsApiClient, MockXhsApiError


class FakeText:
    """模拟 tkinter Text 控件，只记录界面日志文本。"""

    def __init__(self):
        self.content = ''

    def delete(self, *args):
        self.content = ''

    def insert(self, _pos, text):
        self.content += text

    def see(self, _where):
        pass


@pytest.fixture
def work_dir(tmp_path):
    """每个测试独立的工作目录，写入合法 config_pub.json。"""
    cfg = tmp_path / 'config_pub.json'
    cfg.write_text(json.dumps({'wait_sec': 1}), encoding='utf-8')
    return tmp_path


@pytest.fixture
def logger():
    log = logging.getLogger('test_xhs_user_post')
    log.handlers.clear()
    log.addHandler(logging.NullHandler())
    return log


def make_spider(work_dir, logger, api_client, *, max_page=5,
                detail_tag=False, pic_tag=False, top_num=3,
                user_links=None, wait_sec=1, config_name='config_pub.json'):
    """构造一个不依赖 tkinter 界面的采集器，并把等待间隔压到 0。"""
    spider = XhsUserPosted(
        user_link_list=user_links if user_links is not None else [
            'https://www.xiaohongshu.com/user/profile/user_a'
        ],
        top_num=top_num,
        pic_tag=pic_tag,
        detail_tag=detail_tag,
        txt_msglist=FakeText(),
        logger=logger,
        max_page=max_page,
        api_client=api_client,
        config_path=str(work_dir / config_name),
        result_file=str(work_dir / 'result.csv'),
    )
    # 测试不等待，避免分页 sleep 拖慢用例
    spider._wait = lambda: None
    return spider


def read_csv_rows(path):
    with open(path, 'r', encoding='utf-8-sig', newline='') as f:
        return list(csv.reader(f))


def page_endings(spider):
    """从界面日志中提取逐页结局行（成功/空页/请求失败）。"""
    lines = [line.strip() for line in spider.describe]
    return [line for line in lines if ('采集成功' in line
                                        or '空页' in line
                                        or '请求失败' in line)]


# ---------------------------------------------------------------------------
# 1. 成功页 + 空页：CSV 行数与成功页条数一致，空页正常结束，每页恰一条结局
# ---------------------------------------------------------------------------
def test_success_then_empty_page(work_dir, logger):
    # 共 2 页真实数据，每页 3 条；第 3 页为空页
    api = MockXhsApiClient(notes_per_page=3, total_pages=2)
    spider = make_spider(work_dir, logger, api, max_page=5)

    spider.get_user_posted()

    rows = read_csv_rows(work_dir / 'result.csv')
    # 表头 + 2 个成功页 * 3 条
    assert len(rows) == 1 + 2 * 3

    statuses = [o['status'] for o in spider.page_outcomes]
    assert statuses == ['success', 'success', 'empty']

    endings = page_endings(spider)
    # 每页恰好一条结局（3 个请求页 = 3 条结局）
    assert len(endings) == len(spider.page_outcomes) == 3
    # 结局可判读：成功含页码与写入条数，空页含页码与“无更多数据”
    assert endings[0] == '第1页 采集成功，本页写入3条'
    assert endings[1] == '第2页 采集成功，本页写入3条'
    assert '第3页' in endings[2] and '空页' in endings[2] and '无更多数据' in endings[2]

    # CSV 中页码列与成功页对应
    page_col = [r[0] for r in rows[1:]]
    assert page_col == ['1', '1', '1', '2', '2', '2']


# ---------------------------------------------------------------------------
# 2. 请求异常：失败页不记成功、不静默跳过，后续页继续，进程不终止
# ---------------------------------------------------------------------------
def test_request_failure_continues_later_pages(work_dir, logger):
    # 3 页数据，第 2 页请求异常
    api = MockXhsApiClient(notes_per_page=2, total_pages=3, fail_pages={2})
    spider = make_spider(work_dir, logger, api, max_page=4)

    spider.get_user_posted()  # 不应抛异常

    rows = read_csv_rows(work_dir / 'result.csv')
    # 仅第 1、3 成功页写入，每页 2 条；第 2 失败页零行；第 4 页为空页
    assert len(rows) == 1 + 2 * 2

    statuses = [o['status'] for o in spider.page_outcomes]
    assert statuses == ['success', 'failed', 'success', 'empty']

    endings = page_endings(spider)
    assert len(endings) == 4  # 每页恰好一条结局
    failed_line = endings[1]
    assert '第2页' in failed_line and '请求失败' in failed_line
    assert '失败原因' in failed_line and '后续页将继续' in failed_line
    # 失败页绝不能出现成功措辞
    assert '采集成功' not in failed_line

    # 失败页没有任何 CSV 行，成功页条数与 CSV 行数一致
    assert all(r[0] != '2' for r in rows[1:])
    success_count = sum(1 for o in spider.page_outcomes if o['status'] == 'success')
    assert len(rows) - 1 == success_count * 2


# ---------------------------------------------------------------------------
# 3. 详情失败：单条详情失败按笔记 id 记录，列表字段照常写入，不影响其他笔记
# ---------------------------------------------------------------------------
def test_detail_failure_is_isolated_per_note(work_dir, logger):
    api = MockXhsApiClient(notes_per_page=3, total_pages=1,
                           fail_detail_note_ids={'note_user_a_p1_1'})
    spider = make_spider(work_dir, logger, api, max_page=2, detail_tag=True)

    spider.get_user_posted()

    rows = read_csv_rows(work_dir / 'result.csv')
    # 详情失败不影响列表行：本页 3 条全部写入
    assert len(rows) == 1 + 3
    assert [o['status'] for o in spider.page_outcomes] == ['success', 'empty']

    log_text = '\n'.join(spider.describe)
    assert '笔记id:note_user_a_p1_1 详情采集失败' in log_text
    assert '模拟详情请求失败' in log_text
    # 另两条笔记的详情仍被正常请求
    assert 'note_user_a_p1_0' in api.detail_call_log
    assert 'note_user_a_p1_2' in api.detail_call_log
    assert api.detail_call_log.count('note_user_a_p1_1') == 1


# ---------------------------------------------------------------------------
# 4. 图片下载失败：不影响 CSV 行写入
# ---------------------------------------------------------------------------
def test_image_failure_does_not_affect_csv(work_dir, logger):
    fail_url = 'https://img.example.com/note_user_a_p1_0.jpg'
    api = MockXhsApiClient(notes_per_page=2, total_pages=1,
                           fail_image_urls={fail_url})
    spider = make_spider(work_dir, logger, api, max_page=1, pic_tag=True)

    spider.get_user_posted()

    rows = read_csv_rows(work_dir / 'result.csv')
    assert len(rows) == 1 + 2  # 两条行均保留
    log_text = '\n'.join(spider.describe)
    assert '笔记id:note_user_a_p1_0 图片下载失败' in log_text
    assert '不影响CSV行写入' in log_text


# ---------------------------------------------------------------------------
# 5. 配置校验：wait_sec < 1 秒、配置文件缺失均按既有做法 exit(1)
# ---------------------------------------------------------------------------
def test_wait_sec_below_one_exits(work_dir, logger):
    (work_dir / 'bad.json').write_text(json.dumps({'wait_sec': 0}),
                                       encoding='utf-8')
    api = MockXhsApiClient()
    with pytest.raises(SystemExit) as exc:
        make_spider(work_dir, logger, api, config_name='bad.json')
    assert exc.value.code == 1


def test_missing_config_exits(work_dir, logger):
    api = MockXhsApiClient()
    with pytest.raises(SystemExit) as exc:
        make_spider(work_dir, logger, api, config_name='not_exist.json')
    assert exc.value.code == 1


# ---------------------------------------------------------------------------
# 6. 多个博主链接：各自独立从第 1 页翻页，结局按博主+页累计
# ---------------------------------------------------------------------------
def test_multiple_bloggers(work_dir, logger):
    api = MockXhsApiClient(notes_per_page=1, total_pages=1)
    spider = make_spider(work_dir, logger, api, max_page=3, user_links=[
        'https://www.xiaohongshu.com/user/profile/user_a',
        'https://www.xiaohongshu.com/user/profile/user_b?x=1',
    ])

    spider.get_user_posted()

    rows = read_csv_rows(work_dir / 'result.csv')
    # 两个博主各 1 个成功页、每页 1 条
    assert len(rows) == 1 + 2
    # 每个博主：第 1 页成功、第 2 页空页，共 4 条结局，每页恰好一条
    assert len(page_endings(spider)) == 4
    statuses = [(o['user_link'], o['page'], o['status'])
                for o in spider.page_outcomes]
    assert statuses == [
        (spider.user_link_list[0], 1, 'success'),
        (spider.user_link_list[0], 2, 'empty'),
        (spider.user_link_list[1], 1, 'success'),
        (spider.user_link_list[1], 2, 'empty'),
    ]


# ---------------------------------------------------------------------------
# 7. 中途中断：已完成页已经 flush 落盘，仍保留在结果文件中
# ---------------------------------------------------------------------------
def test_interrupted_run_keeps_finished_pages(work_dir, logger):
    api = MockXhsApiClient(notes_per_page=2, total_pages=5)
    spider = make_spider(work_dir, logger, api, max_page=5)

    real_sleep = time.sleep
    call = {'n': 0}

    def interrupt_after_two_pages():
        call['n'] += 1
        if call['n'] == 2:  # 前两页完成后，第 3 页等待时模拟进程中断
            raise KeyboardInterrupt()

    spider._wait = interrupt_after_two_pages

    with pytest.raises(KeyboardInterrupt):
        spider.get_user_posted()

    rows = read_csv_rows(work_dir / 'result.csv')
    # 中断前已完成 2 页 * 2 条，全部保留；表头仍在
    assert len(rows) == 1 + 2 * 2
    assert [r[0] for r in rows[1:]] == ['1', '1', '2', '2']


# ---------------------------------------------------------------------------
# 8. 连续两页失败后仍能恢复成功，且失败原因被如实记录
# ---------------------------------------------------------------------------
def test_consecutive_failures_then_recovery(work_dir, logger):
    api = MockXhsApiClient(notes_per_page=1, total_pages=4, fail_pages={2, 3})
    spider = make_spider(work_dir, logger, api, max_page=5)

    spider.get_user_posted()

    statuses = [o['status'] for o in spider.page_outcomes]
    assert statuses == ['success', 'failed', 'failed', 'success', 'empty']
    for outcome in spider.page_outcomes:
        if outcome['status'] == 'failed':
            assert '模拟列表请求失败' in outcome['message']
            assert str(outcome['page']) in outcome['message']

    rows = read_csv_rows(work_dir / 'result.csv')
    # 仅第 1、4 页成功，各 1 条
    assert len(rows) == 1 + 2
