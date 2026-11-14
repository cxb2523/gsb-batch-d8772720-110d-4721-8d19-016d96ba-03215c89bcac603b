from unittest.mock import AsyncMock, MagicMock

import pytest

import site_navigator
from site_navigator import MAX_GRID_CHOICES, REFRESH_BUTTON_INDEX, PageNavigator, SessionEndReason


@pytest.fixture
def navi():
    navi = PageNavigator()
    navi.page = MagicMock()
    navi.page.isClosed.return_value = False
    navi.page.close = AsyncMock()
    navi.page.click = AsyncMock()
    navi.grid = [MagicMock(click=AsyncMock()) for _ in range(REFRESH_BUTTON_INDEX + 1)]
    navi.page.querySelectorAll = AsyncMock(return_value=navi.grid)
    return navi


async def test_click_by_index_is_one_based(navi):
    await navi.click_by_index(1)
    navi.grid[0].click.assert_awaited_once()


async def test_refresh_clicks_refresh_button(navi):
    await navi.refresh()
    navi.grid[REFRESH_BUTTON_INDEX].click.assert_awaited_once()


async def test_rand_clicks_a_grid_cell_in_range(navi, monkeypatch):
    monkeypatch.setattr(site_navigator, "randint", lambda a, b: b)
    await navi.rand()
    navi.page.click.assert_awaited_once_with(f".waifu-grid > div:nth-child({MAX_GRID_CHOICES})")


async def test_exit_closes_open_page(navi):
    await navi.exit()
    navi.page.close.assert_awaited_once()


async def test_exit_skips_already_closed_page(navi):
    navi.page.isClosed.return_value = True
    await navi.exit()
    navi.page.close.assert_not_called()


async def test_page_timeout_marks_timed_out_and_closes(navi):
    await navi.page_timeout()
    assert navi.timed_out
    assert navi.end_reason is SessionEndReason.PAGE_TIMEOUT
    navi.page.close.assert_awaited_once()


async def test_user_exit_keeps_reason_after_page_closes(navi):
    await navi.exit()

    assert navi.end_reason is SessionEndReason.USER_EXIT
    assert navi.user_exited
    assert not navi.timed_out
    assert not navi.site_error


async def test_page_timeout_is_not_overwritten_by_exit(navi):
    # page_timeout() calls exit(); the timeout must stay the recorded cause.
    await navi.page_timeout()

    assert navi.end_reason is SessionEndReason.PAGE_TIMEOUT
    assert not navi.user_exited
    # A later capture error caused by the page having closed must not override it.
    assert navi.mark_site_error() is False


async def test_site_error_reason_is_kept(navi):
    assert navi.mark_site_error() is True

    assert navi.end_reason is SessionEndReason.SITE_ERROR
    assert navi.site_error
    assert not navi.user_exited


async def test_site_error_does_not_replace_a_finished_or_user_chosen_reason(navi):
    navi.end_reason = SessionEndReason.USER_EXIT

    assert navi.mark_site_error() is False
    assert navi.end_reason is SessionEndReason.USER_EXIT


async def test_end_reason_survives_after_page_is_closed(navi):
    navi.end_reason = None
    navi.mark_site_error()
    navi.page.isClosed.return_value = True

    assert navi.end_reason is SessionEndReason.SITE_ERROR


def test_session_end_reasons_are_distinct():
    reasons = {
        SessionEndReason.USER_EXIT,
        SessionEndReason.PAGE_TIMEOUT,
        SessionEndReason.SITE_ERROR,
    }
    assert len(reasons) == 3
    assert {reason.value for reason in reasons} == {"user_exit", "page_timeout", "site_error"}
    # The alias points at the same member instead of adding a new reason.
    assert SessionEndReason.TIMEOUT is SessionEndReason.PAGE_TIMEOUT


def test_end_reason_values_read_as_plain_strings():
    assert SessionEndReason.SITE_ERROR == "site_error"
    assert SessionEndReason.USER_EXIT == "user_exit"
