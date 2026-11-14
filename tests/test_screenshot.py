from io import BytesIO
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

import pytest
from PIL import Image

from screenshot import ScreenshotError, ScreenshotHandler
from site_navigator import PageNavigator, SessionEndReason
from tests.helpers import make_interaction
from view import View


def image_bytes(size=(80, 700), color="red"):
    """Creates a valid PNG for the handler to process."""
    with BytesIO() as buffer:
        Image.new("RGB", size, color).save(buffer, format="PNG")
        return buffer.getvalue()


@pytest.fixture
def handler():
    # A real navigator so the end-reason state machine is exercised.
    navi = PageNavigator()
    navi.page = MagicMock()
    navi.wait_for_final_image = AsyncMock()
    navi.wait_for_not_load_screen = AsyncMock()
    navi.screenshot = AsyncMock(return_value=image_bytes())
    navi.page.querySelector = AsyncMock()
    navi.page.evaluate = AsyncMock(return_value="data:image/png;base64,QUJD")
    return ScreenshotHandler(navi, make_interaction(), None)


@pytest.fixture
def session_id():
    session_id = uuid4()
    View.stage[session_id] = 0
    yield session_id
    View.stage.pop(session_id, None)


def original_message():
    message = MagicMock()
    message.edit = AsyncMock()
    message.fetch = AsyncMock(return_value=message)
    return message


# --- _get_screenshot_info_by_stage ---


async def test_stage_zero_screenshots_full_grid(handler):
    session_id = uuid4()
    View.stage[session_id] = 0
    try:
        selector, crop, view, b64_string = await handler._get_screenshot_info_by_stage(0, session_id)
    finally:
        View.stage.pop(session_id)

    assert (selector, crop, b64_string) == (".waifu-grid", False, None)
    assert isinstance(view, View)


@pytest.mark.parametrize("stage", [1, 2, 3])
async def test_middle_stages_crop_container(handler, stage):
    session_id = uuid4()
    View.stage[session_id] = stage
    try:
        selector, crop, view, b64_string = await handler._get_screenshot_info_by_stage(stage, session_id)
    finally:
        View.stage.pop(session_id)

    assert (selector, crop, b64_string) == (".waifu-container", True, None)
    assert isinstance(view, View)


async def test_final_stage_returns_base64_without_view(handler):
    selector, crop, view, b64_string = await handler._get_screenshot_info_by_stage(4, uuid4())

    assert (selector, crop, view, b64_string) == (None, False, None, "QUJD")
    handler.navi.wait_for_final_image.assert_awaited_once()


# --- failure handling ---


async def test_screenshot_failure_raises_screenshot_error_and_marks_site_error(handler, session_id):
    handler.navi.screenshot = AsyncMock(side_effect=RuntimeError("page was closed"))
    message = original_message()

    with pytest.raises(ScreenshotError) as error:
        await handler.save_send_screenshot(session_id, message)

    assert error.value.stage == 0
    assert handler.navi.end_reason is SessionEndReason.SITE_ERROR
    message.edit.assert_not_called()


async def test_empty_screenshot_raises_screenshot_error(handler, session_id):
    handler.navi.screenshot = AsyncMock(return_value=b"")

    with pytest.raises(ScreenshotError):
        await handler.save_send_screenshot(session_id, original_message())

    assert handler.navi.end_reason is SessionEndReason.SITE_ERROR


async def test_final_image_fetch_failure_raises_screenshot_error(handler, session_id):
    View.stage[session_id] = 4
    handler.navi.page.querySelector = AsyncMock(return_value=None)
    handler.navi.page.evaluate = AsyncMock(return_value=None)

    with pytest.raises(ScreenshotError):
        await handler.save_send_screenshot(session_id, original_message())


async def test_successful_send_edits_message_with_image(handler, session_id, monkeypatch):
    message = original_message()
    # The grid view normally blocks until the user clicks a button.
    monkeypatch.setattr(View, "wait", AsyncMock())

    await handler.save_send_screenshot(session_id, message)

    message.edit.assert_awaited_once()
    file = message.edit.call_args.kwargs["file"]
    assert file.filename == "image.webp"
    assert handler.navi.end_reason is None


async def test_screenshots_are_not_swallowed_as_plain_exceptions(handler, session_id):
    handler.navi.wait_for_not_load_screen = AsyncMock(side_effect=RuntimeError("selector gone"))

    with pytest.raises(ScreenshotError):
        await handler.save_send_screenshot(session_id, original_message())
