#!/usr/bin/env python3
"""WeFlowPipeline._sync_incremental 单元测试（假 WeFlowClient，不依赖真实服务与微信）。

覆盖：
  - 正常多页拉完且水位线推进；
  - 第二页抛异常时保留第一页新消息、结局为部分失败、水位线只推进到已保留消息；
  - 重复 local_id 跨页出现时结果去重且条数正确；
  - 无新消息时结局为 no_new 且水位线不变；
  - 中途失败后 check_unread_all 仍能发现未读（水位线语义一致）；
  - perceive() 把同步结局写入 debug_info，失败时 new_messages 仍为实际保留条数。

每个用例都构造全新的 WeFlowPipeline 实例，_last_local_ids 与 _history_cache
状态天然隔离，互不影响。
"""

import sys
from unittest.mock import MagicMock

import pytest

# weflow_pipeline 顶层依赖 macOS 专属模块（AppKit/Quartz/Vision/Foundation），
# 在非 macOS 环境用 stub 代替，保证测试可跨平台运行。
for _mod in ("AppKit", "Quartz", "Vision", "Foundation"):
    sys.modules.setdefault(_mod, MagicMock())

from src.layout.profile import PROFILE_WECHAT_MAC_1760X1280
from src.models.base import Rect
from src.perception.weflow_client import WeFlowContact, WeFlowMessage
from src.perception.weflow_pipeline import (
    SYNC_STATUS_COMPLETE,
    SYNC_STATUS_NO_NEW,
    SYNC_STATUS_PARTIAL,
    SyncResult,
    WeFlowPipeline,
)

TALKER = "wxid_test_peer"


def make_msg(local_id: int, content: str = "msg") -> WeFlowMessage:
    return WeFlowMessage(
        local_id=local_id,
        server_id=str(local_id),
        local_type=1,
        create_time=1700000000 + local_id,
        sort_seq=local_id,
        is_send=False,
        sender_username=TALKER,
        content=f"{content}_{local_id}",
        raw_content="",
    )


class FakeWeFlowClient:
    """按页脚本化返回的假 WeFlowClient。

    pages: 列表，每项为 (messages, has_more) 元组或 Exception 实例（抛出）。
    页数耗尽后返回空页。
    """

    def __init__(self, pages):
        self._pages = list(pages)
        self.calls: list[dict] = []

    def get_messages(self, talker, limit=20, offset=0, contact_name=None):
        self.calls.append({"talker": talker, "limit": limit, "offset": offset})
        if not self._pages:
            return [], False
        page = self._pages.pop(0)
        if isinstance(page, Exception):
            raise page
        return page


def make_pipeline(pages, last_ids=None, history=None):
    """构造全新 pipeline：每个用例独立的 _last_local_ids / _history_cache。"""
    client = FakeWeFlowClient(pages)
    pipeline = WeFlowPipeline(PROFILE_WECHAT_MAC_1760X1280, weflow_client=client)
    pipeline._last_local_ids = dict(last_ids or {})
    pipeline._history_cache = dict(history or {})
    return pipeline, client


class TestSyncIncremental:
    def test_multi_page_complete_advances_watermark(self):
        """正常多页拉完：全部新消息保留，结局 complete，水位线推进到最大 local_id。"""
        page1 = ([make_msg(i) for i in (11, 12, 13, 14, 15)], True)
        page2 = ([make_msg(16), make_msg(17)], False)
        pipeline, client = make_pipeline([page1, page2], last_ids={TALKER: 10})

        result = pipeline._sync_incremental(TALKER)

        assert isinstance(result, SyncResult)
        assert result.status == SYNC_STATUS_COMPLETE
        assert result.error is None
        assert [m.local_id for m in result.messages] == [11, 12, 13, 14, 15, 16, 17]
        assert result.kept_count == 7
        # 水位线推进到已纳入消息的最大 local_id
        assert pipeline._last_local_ids[TALKER] == 17
        # 确实翻页了（offset 累加）
        assert [c["offset"] for c in client.calls] == [0, 5]

    def test_second_page_failure_keeps_first_page(self):
        """第二页抛异常：保留第一页新消息，结局 partial，水位线只推进到已保留消息。"""
        page1 = ([make_msg(11), make_msg(12), make_msg(13)], True)
        pipeline, _ = make_pipeline(
            [page1, RuntimeError("connection reset")],
            last_ids={TALKER: 10},
        )

        result = pipeline._sync_incremental(TALKER)

        assert result.status == SYNC_STATUS_PARTIAL
        assert result.error is not None and "connection reset" in result.error
        # 已拿到的消息不丢弃
        assert [m.local_id for m in result.messages] == [11, 12, 13]
        assert result.kept_count == 3
        # 水位线只推进到已保留消息的最大 local_id，不覆盖未确认位置
        assert pipeline._last_local_ids[TALKER] == 13

    def test_first_page_failure_keeps_nothing_and_watermark_unchanged(self):
        """第一页就失败：结局 partial、保留 0 条、水位线不变。"""
        pipeline, _ = make_pipeline(
            [RuntimeError("service down")],
            last_ids={TALKER: 10},
        )

        result = pipeline._sync_incremental(TALKER)

        assert result.status == SYNC_STATUS_PARTIAL
        assert result.kept_count == 0
        assert pipeline._last_local_ids[TALKER] == 10

    def test_duplicate_local_ids_across_pages_deduped(self):
        """跨页重复 local_id（服务端返回重复页）：结果去重，条数正确。"""
        page1 = ([make_msg(11), make_msg(12), make_msg(13)], True)
        # 服务端重复返回了 12、13，并夹带一条新消息 14
        page2 = ([make_msg(12), make_msg(13), make_msg(14)], False)
        pipeline, _ = make_pipeline([page1, page2], last_ids={TALKER: 10})

        result = pipeline._sync_incremental(TALKER)

        assert result.status == SYNC_STATUS_COMPLETE
        assert [m.local_id for m in result.messages] == [11, 12, 13, 14]
        assert result.kept_count == 4
        assert pipeline._last_local_ids[TALKER] == 14

    def test_repeated_identical_page_stops_without_duplicates(self):
        """服务端反复返回同一页：去重后第二页整页重复即停止，不会重复计入。"""
        page = ([make_msg(11), make_msg(12)], True)
        pipeline, client = make_pipeline([page, page], last_ids={TALKER: 10})

        result = pipeline._sync_incremental(TALKER)

        assert [m.local_id for m in result.messages] == [11, 12]
        assert result.kept_count == 2
        assert pipeline._last_local_ids[TALKER] == 12
        # 第二页整页重复 → 停止，不会打满 max_rounds
        assert len(client.calls) == 2

    def test_no_new_messages(self):
        """无新消息：结局 no_new，水位线不变。"""
        page1 = ([make_msg(8), make_msg(9), make_msg(10)], False)
        pipeline, _ = make_pipeline([page1], last_ids={TALKER: 10})

        result = pipeline._sync_incremental(TALKER)

        assert result.status == SYNC_STATUS_NO_NEW
        assert result.error is None
        assert result.kept_count == 0
        assert pipeline._last_local_ids[TALKER] == 10

    def test_first_sync_initializes_watermark_from_history_cache(self):
        """首次处理：从历史缓存初始化水位线，只拉比缓存更新的消息。"""
        history = [make_msg(5), make_msg(6), make_msg(7)]
        page1 = ([make_msg(7), make_msg(8)], False)
        pipeline, _ = make_pipeline([page1], history={TALKER: history})

        result = pipeline._sync_incremental(TALKER)

        assert result.status == SYNC_STATUS_COMPLETE
        assert [m.local_id for m in result.messages] == [8]
        assert pipeline._last_local_ids[TALKER] == 8

    def test_partial_failure_unread_still_detected_next_round(self):
        """中途失败后水位线语义与 check_unread_all 一致：未确认消息后续仍被发现。"""
        page1 = ([make_msg(11), make_msg(12), make_msg(13)], True)
        # 后续 check_unread_all 拉最新 5 条：包含失败时未确认的 14、15
        unread_page = ([make_msg(i) for i in (11, 12, 13, 14, 15)], False)
        pipeline, _ = make_pipeline(
            [page1, RuntimeError("boom"), unread_page],
            last_ids={TALKER: 10},
        )
        pipeline._contacts_cache = [
            WeFlowContact(username=TALKER, display_name="测试", type="friend")
        ]

        result = pipeline._sync_incremental(TALKER)
        assert result.status == SYNC_STATUS_PARTIAL
        assert pipeline._last_local_ids[TALKER] == 13

        unread = pipeline.check_unread_all()
        assert len(unread) == 1
        assert unread[0]["talker"] == TALKER
        # 14、15 未被水位线覆盖，仍被判定为未读
        assert unread[0]["unread_count"] == 2


class TestPerceiveDebugInfo:
    def _setup_perceive_mocks(self, pipeline):
        """mock 截图/OCR/布局，让 perceive 走到增量同步分支。"""
        pipeline._initialized = True
        pipeline._chat_name_to_talker = {"测试聊天": TALKER}
        pipeline._talker_to_contact = {
            TALKER: {"username": TALKER, "name": "测试聊天", "type": "friend", "is_group": False}
        }
        pipeline.capture = MagicMock()
        pipeline.capture.capture.return_value = MagicMock(
            image_path="dummy.png",
            window_rect=Rect(0, 0, 1760, 1280),
            scale_factor=1.0,
        )
        pipeline.ocr = MagicMock()
        pipeline.ocr.recognize.return_value = []
        pipeline.layout = MagicMock()
        pipeline.layout.parse.return_value = MagicMock(
            chat_name="测试聊天",
            chat_list_items=[],
            is_service_account_list=False,
        )

    def test_perceive_debug_info_on_partial_failure(self):
        """perceive 把结局写入 debug_info；失败时 new_messages 仍为实际保留条数。"""
        page1 = ([make_msg(11), make_msg(12)], True)
        pipeline, _ = make_pipeline(
            [page1, RuntimeError("boom")],
            last_ids={TALKER: 10},
        )
        self._setup_perceive_mocks(pipeline)

        result = pipeline.perceive()

        assert result is not None
        debug = result.debug_info
        # 既有字段保留
        assert debug["source"] == "weflow"
        assert debug["talker"] == TALKER
        assert "total_history" in debug
        # 失败时 new_messages 反映实际保留条数，不被清空
        assert debug["new_messages"] == 2
        assert len(result.messages) == 2
        # 同步结局写入 debug_info
        assert debug["sync_status"] == SYNC_STATUS_PARTIAL
        assert "boom" in debug["sync_error"]
        assert debug["sync_kept"] == 2

    def test_perceive_debug_info_on_complete(self):
        """完整拉完时 debug_info 标记 complete。"""
        page1 = ([make_msg(11)], False)
        pipeline, _ = make_pipeline([page1], last_ids={TALKER: 10})
        self._setup_perceive_mocks(pipeline)

        result = pipeline.perceive()

        debug = result.debug_info
        assert debug["sync_status"] == SYNC_STATUS_COMPLETE
        assert debug["sync_error"] is None
        assert debug["new_messages"] == 1
        assert debug["sync_kept"] == 1
