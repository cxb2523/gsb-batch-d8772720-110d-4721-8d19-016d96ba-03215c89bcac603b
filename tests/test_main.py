import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest

import main
from screenshot import ScreenshotError
from site_navigator import PageNavigator, SessionEndReason
from tests.helpers import make_interaction
from view import View


@pytest.fixture
def site_gate(monkeypatch):
    """Sessions block at the "connecting to the site" step until this event is set."""
    monkeypatch.setattr(main, "connected_users", [])
    return asyncio.Event()


@pytest.fixture
def create_navi(monkeypatch, site_gate):
    """Mocks the site connection. Once the gate opens it returns None (site offline),
    so the session exits right away without a browser."""

    async def wait_for_gate():
        await site_gate.wait()
        return None

    mock = AsyncMock(side_effect=wait_for_gate)
    monkeypatch.setattr(main.PageNavigator, "create_navi", mock)
    return mock


def start_interaction(user_id):
    interaction = make_interaction(user_id=user_id)
    interaction.response.send_message = AsyncMock(return_value=AsyncMock())
    return interaction


async def run_waifu(interaction):
    await main.waifu.callback(interaction, None, False)


def sent_text(interaction):
    return interaction.response.send_message.call_args.args[0]


# --- session helpers ---


class FakeSession:
    """A controllable browser session for the collection loop."""

    def __init__(self, navi):
        self.navi = navi
        self.original_message = MagicMock()
        self.original_message.edit = AsyncMock()
        self.interaction = start_interaction(user_id=1)
        self.interaction.response.send_message = AsyncMock(return_value=self.original_message)


def make_page(page_closed=False):
    """A mock page whose isClosed() reflects close(), like a real pyppeteer page."""
    closed = {"value": page_closed}
    page = MagicMock()
    page.isClosed = MagicMock(side_effect=lambda: closed["value"])

    async def close():
        closed["value"] = True

    page.close = AsyncMock(side_effect=close)
    return page


def make_navi(page_closed=False):
    """A real PageNavigator so the end-reason state machine is exercised."""
    navi = PageNavigator()
    navi.page = make_page(page_closed)
    return navi


async def run_session(monkeypatch, navi, screenshot_side_effect):
    """Runs the /waifu loop with a supplied navigator and screenshot behaviour."""
    session = FakeSession(navi)

    monkeypatch.setattr(main, "connected_users", [])
    monkeypatch.setattr(main.PageNavigator, "create_navi", AsyncMock(return_value=navi))

    handler = MagicMock()

    async def save_send_screenshot(session_id, message):
        # Each successful call advances one stage, mirroring View._button_logic.
        if isinstance(screenshot_side_effect, list):
            if not screenshot_side_effect:
                raise AssertionError("ran out of scripted screenshots")
            outcome = screenshot_side_effect.pop(0)
        else:
            outcome = screenshot_side_effect

        if outcome == "advance":
            View.stage[session_id] = View.stage.get(session_id, 0) + 1
            return
        if outcome == "send":
            # A successful send that does not change the stage (e.g. the final image).
            return
        if outcome == "fail":
            raise ScreenshotError("site broke", stage=View.stage.get(session_id, 0))
        if outcome == "fail_and_close":
            await navi.page.close()
            raise ScreenshotError("page vanished", stage=View.stage.get(session_id, 0))
        if outcome == "closed":
            await navi.page.close()
            return

        raise AssertionError(f"unknown screenshot outcome {outcome}")

    handler.save_send_screenshot = AsyncMock(side_effect=save_send_screenshot)

    session.handler = handler
    monkeypatch.setattr(main, "ScreenshotHandler", MagicMock(return_value=handler))

    await run_waifu(session.interaction)
    return session


def edited_texts(message):
    """All text passed to message.edit(), whether positionally or as ``content=``."""
    texts = []
    for call in message.edit.await_args_list:
        if call.args and isinstance(call.args[0], str):
            texts.append(call.args[0])
        elif isinstance(call.kwargs.get("content"), str):
            texts.append(call.kwargs["content"])
    return texts


def edit_call_with(message, needle):
    """The message.edit() call whose text contains ``needle``."""
    for call in message.edit.await_args_list:
        text = call.args[0] if call.args and isinstance(call.args[0], str) else call.kwargs.get("content")
        if isinstance(text, str) and needle in text:
            return call
    raise AssertionError(f"no edit call containing {needle!r}; edits: {edited_texts(message)}")


# --- lifecycle tests ---


async def test_user_cannot_start_bot_while_running(create_navi, site_gate):
    first = start_interaction(user_id=1)
    session = asyncio.create_task(run_waifu(first))
    await asyncio.sleep(0)  # let the first session register and block on the site
    assert main.connected_users == [1]

    second = start_interaction(user_id=1)
    # A rejected start returns immediately; without the guard it would block on the site.
    await asyncio.wait_for(run_waifu(second), timeout=1)

    assert "cannot start me twice" in sent_text(second)
    assert second.response.send_message.call_args.kwargs["ephemeral"] is True
    create_navi.assert_awaited_once()  # only the first session reached the site

    site_gate.set()
    await session


async def test_user_can_start_again_after_session_ends(create_navi, site_gate):
    site_gate.set()
    await run_waifu(start_interaction(user_id=1))
    assert main.connected_users == []

    again = start_interaction(user_id=1)
    await run_waifu(again)

    assert "cannot start me twice" not in sent_text(again)
    assert create_navi.await_count == 2


async def test_other_users_can_start_while_one_is_running(create_navi, site_gate):
    session = asyncio.create_task(run_waifu(start_interaction(user_id=1)))
    await asyncio.sleep(0)

    other = start_interaction(user_id=2)
    other_session = asyncio.create_task(run_waifu(other))
    await asyncio.sleep(0)

    assert "cannot start me twice" not in sent_text(other)
    assert sorted(main.connected_users) == [1, 2]
    assert create_navi.await_count == 2

    site_gate.set()
    await asyncio.gather(session, other_session)
    assert main.connected_users == []


# --- collection outcomes ---


async def test_four_rounds_send_the_final_image(monkeypatch):
    navi = make_navi()

    # Stages 0-3 send grids, then the final image is sent once all four are done.
    session = await run_session(
        monkeypatch,
        navi,
        ["advance", "advance", "advance", "advance", "send"],
    )

    assert session.handler.save_send_screenshot.await_count == 5
    assert navi.page.close.await_count == 1
    assert navi.end_reason is None
    # The last call is the final character image, sent only after all four grids.
    final_send = session.handler.save_send_screenshot.await_args_list[-1]
    assert View.stage[final_send.args[0]] == main.TOTAL_STEPS
    texts = edited_texts(session.original_message)
    assert any("Here's your character!" in text for text in texts)
    assert not any("wasn't finished" in text for text in texts)
    assert main.connected_users == []


async def test_screenshot_error_edits_failure_message_and_releases_user(monkeypatch):
    navi = make_navi()

    session = await run_session(monkeypatch, navi, ["advance", "advance", "fail"])

    assert navi.end_reason is SessionEndReason.SITE_ERROR
    assert navi.page.close.await_count == 1
    assert main.connected_users == []
    texts = edited_texts(session.original_message)
    assert any("wasn't finished" in text for text in texts)
    assert any("step **3/4**" in text for text in texts)
    assert any("start a new /waifu" in text for text in texts)
    # The final-character message must never be sent on a broken round.
    assert not any("Here's your character!" in text for text in texts)
    for call in session.original_message.edit.await_args_list:
        assert call.kwargs.get("attachments") == [] or "attachments" not in call.kwargs


async def test_final_image_failure_is_reported_and_not_sent(monkeypatch):
    navi = make_navi()

    session = await run_session(monkeypatch, navi, ["advance", "advance", "advance", "advance", "fail"])

    assert navi.end_reason is SessionEndReason.SITE_ERROR
    assert main.connected_users == []
    texts = edited_texts(session.original_message)
    # The half-finished progress grid is not presented as a finished character.
    assert any("step **4/4**" in text for text in texts)
    assert any("start a new /waifu" in text for text in texts)
    assert not any("Here's your character!" in text for text in texts)


async def test_closed_page_without_exit_or_timeout_is_a_site_error(monkeypatch):
    # No ❌ and no view timeout: the browser page simply disappeared mid-round.
    navi = make_navi()

    session = await run_session(monkeypatch, navi, ["advance", "fail_and_close"])

    assert navi.end_reason is SessionEndReason.SITE_ERROR
    assert main.connected_users == []
    texts = edited_texts(session.original_message)
    assert any("wasn't finished" in text for text in texts)
    assert any("start a new /waifu" in text for text in texts)


async def test_page_timeout_keeps_existing_message_and_releases_user(monkeypatch):
    navi = make_navi()
    # This is what View.on_timeout() does.
    await navi.page_timeout()

    session = await run_session(monkeypatch, navi, [])

    assert main.connected_users == []
    texts = edited_texts(session.original_message)
    assert "Hey, anybody there? No? Okay, I'll shut down then :slight_frown:" in texts
    timeout_call = edit_call_with(session.original_message, "anybody there")
    assert timeout_call.kwargs["delete_after"] == 10
    assert timeout_call.kwargs["attachments"] == []
    assert timeout_call.kwargs["view"] is None
    assert not any("wasn't finished" in text for text in texts)


async def test_user_exit_keeps_existing_exiting_message_and_releases_user(monkeypatch):
    navi = make_navi()
    # This is what View's ❌ button does.
    await navi.exit()

    session = await run_session(monkeypatch, navi, [])

    assert main.connected_users == []
    texts = edited_texts(session.original_message)
    exit_call = edit_call_with(session.original_message, "Exiting...")
    assert exit_call.kwargs["delete_after"] == 5
    assert exit_call.kwargs["attachments"] == []
    assert exit_call.kwargs["view"] is None
    assert not any("wasn't finished" in text for text in texts)


@pytest.mark.parametrize(
    ("reason", "expected"),
    [
        (SessionEndReason.USER_EXIT, "Exiting..."),
        (SessionEndReason.PAGE_TIMEOUT, "anybody there"),
    ],
)
async def test_screenshot_failure_does_not_override_an_earlier_end_reason(monkeypatch, reason, expected):
    # e.g. the user pressed ❌ (or the view timed out) while a screenshot was in
    # flight: the resulting capture error must not turn an intentional ending
    # into a "site broke" message, and the original copy/cleanup behaviour stays.
    navi = make_navi()
    navi.end_reason = reason

    session = await run_session(monkeypatch, navi, ["fail_and_close"])

    assert navi.end_reason is reason
    texts = edited_texts(session.original_message)
    assert not any("wasn't finished" in text for text in texts)
    matching = edit_call_with(session.original_message, expected)
    assert matching.kwargs["attachments"] == []
    assert main.connected_users == []
