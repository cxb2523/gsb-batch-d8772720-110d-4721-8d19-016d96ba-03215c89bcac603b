"""
Tests for the user-facing incomplete-collection warning.

The wording is assembled by a pure function (tested directly), and the
Streamlit widget wrapper is tested with ``st.warning`` monkeypatched so no
browser/runtime is required.
"""

from types import SimpleNamespace

import streamlit as st

from models.paginator import STOP_REASON_LABELS, StopReason
from widgets import messages
from widgets.messages import build_incomplete_collection_message


class TestIncompleteMessageWording:
    def test_fetch_failure_mentions_count_page_and_reason(self):
        text = build_incomplete_collection_message(
            fetched_count=42,
            stop_page=3,
            stop_reason=StopReason.FETCH_FAILED,
        )
        assert "**42**" in text
        assert "page **3**" in text
        assert STOP_REASON_LABELS[StopReason.FETCH_FAILED] in text
        assert "incomplete" in text.lower()

    def test_empty_page_reason(self):
        text = build_incomplete_collection_message(
            fetched_count=28,
            stop_page=2,
            stop_reason=StopReason.EMPTY_PAGE,
        )
        assert "**28**" in text
        assert "page **2**" in text
        assert STOP_REASON_LABELS[StopReason.EMPTY_PAGE] in text

    def test_no_new_items_reason(self):
        text = build_incomplete_collection_message(
            fetched_count=100,
            stop_page=5,
            stop_reason=StopReason.NO_NEW_ITEMS,
        )
        assert "page **5**" in text
        assert STOP_REASON_LABELS[StopReason.NO_NEW_ITEMS] in text

    def test_includes_total_when_known(self):
        text = build_incomplete_collection_message(
            fetched_count=10,
            stop_page=1,
            stop_reason=StopReason.FETCH_FAILED,
            total_count=72,
        )
        assert "**10** of **72**" in text

    def test_omits_total_when_unknown(self):
        text = build_incomplete_collection_message(
            fetched_count=10,
            stop_page=1,
            stop_reason=StopReason.FETCH_FAILED,
            total_count=None,
        )
        assert "of" not in text


class TestIncompleteWarningWidget:
    def test_warning_widget_renders_diagnostic_text(self, monkeypatch):
        captured = []
        monkeypatch.setattr(st, "warning", lambda msg: captured.append(msg))

        result = SimpleNamespace(
            items_collected=15,
            stop_page=2,
            stop_reason=StopReason.NO_NEW_ITEMS,
        )
        messages.incomplete_collection_warning(result)

        assert len(captured) == 1
        assert "**15**" in captured[0]
        assert "page **2**" in captured[0]

    def test_warning_passes_through_total(self, monkeypatch):
        captured = []
        monkeypatch.setattr(st, "warning", lambda msg: captured.append(msg))

        result = SimpleNamespace(
            items_collected=5,
            stop_page=1,
            stop_reason=StopReason.FETCH_FAILED,
        )
        messages.incomplete_collection_warning(result, total_count=40)
        assert "**5** of **40**" in captured[0]
