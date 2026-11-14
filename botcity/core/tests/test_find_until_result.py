"""Tests for ``DesktopBot.find_until_result``.

The tests use small synthetic images and replace the actual screen capture with a
list of pre-built frames, so no display is required.
"""

import time

import numpy as np
import pytest
from PIL import Image

from botcity.base import State
from botcity.core import cv2find
from botcity.core.bot import DesktopBot, FindResult


TEMPLATE_LEFT = 30
TEMPLATE_TOP = 20
TEMPLATE_WIDTH = 50
TEMPLATE_HEIGHT = 30
HAYSTACK_WIDTH = 160
HAYSTACK_HEIGHT = 120


def _random_image(seed, width=HAYSTACK_WIDTH, height=HAYSTACK_HEIGHT):
    rng = np.random.default_rng(seed)
    data = rng.integers(0, 256, (height, width, 3), dtype=np.uint8)
    return Image.fromarray(data, mode="RGB")


def _haystack_with_template(seed):
    """Return (haystack, template) where the template is an exact crop."""
    haystack = _random_image(seed)
    data = np.array(haystack)
    template = data[
        TEMPLATE_TOP: TEMPLATE_TOP + TEMPLATE_HEIGHT,
        TEMPLATE_LEFT: TEMPLATE_LEFT + TEMPLATE_WIDTH,
    ].copy()
    return haystack, Image.fromarray(template, mode="RGB")


def _distorted_template(template, seed=99, amplitude=255):
    """Return a heavily distorted version of the template.

    The distortion lowers the match score to a value well below the default 0.9
    threshold, while still keeping some correlation with the original.
    """
    rng = np.random.default_rng(seed)
    data = np.array(template).astype(np.int16)
    noise = rng.integers(-amplitude, amplitude + 1, data.shape)
    distorted = np.clip(data + noise, 0, 255).astype(np.uint8)
    return Image.fromarray(distorted, mode="RGB")


class StubBot(DesktopBot):
    """DesktopBot whose screen is a fixed list of frames.

    The last frame is reused once the list is exhausted.
    """

    def __init__(self, screenshots, poll_interval=5):
        # Intentionally skip DesktopBot.__init__: it creates pynput controllers and
        # touches the clipboard, none of which is needed here.
        self.state = State()
        self._screenshots = list(screenshots)
        self._screenshot_calls = 0
        self._find_result_poll_interval = poll_interval
        self.sleep_calls = []

    def get_screenshot(self, filepath=None, region=None):
        index = min(self._screenshot_calls, len(self._screenshots) - 1)
        self._screenshot_calls += 1
        return self._screenshots[index]

    def _fix_display_size(self):
        width, height = self._screenshots[0].size
        return width, height

    def sleep(self, interval):
        self.sleep_calls.append(interval)
        if interval:
            time.sleep(interval / 1000.0)


@pytest.fixture
def missing_label():
    return "definitely-not-a-registered-template"


def _register(bot, tmp_path, label, image, filename=None):
    path = tmp_path / (filename or f"{label}.png")
    image.save(path)
    bot.add_image(label, str(path))
    return path


def test_returns_result_type_and_hit(tmp_path):
    haystack, template = _haystack_with_template(seed=1)
    blank = _random_image(seed=2)

    bot = StubBot([blank, haystack])
    _register(bot, tmp_path, "button", template)

    result = bot.find_until_result("button", matching=0.9, waiting_time=10000)

    assert isinstance(result, FindResult)
    assert result.found is True
    assert result.element is not None
    assert result.element.left == TEMPLATE_LEFT
    assert result.element.top == TEMPLATE_TOP
    assert result.element.width == TEMPLATE_WIDTH
    assert result.element.height == TEMPLATE_HEIGHT
    assert result.best_score >= 0.9
    assert 0.0 <= result.best_score <= 1.0
    # The first frame does not contain the template, so it can only be found on
    # the second screenshot - and the search must stop right there instead of
    # waiting for the full timeout.
    assert result.attempts == 2
    assert result.elapsed_ms >= 0
    assert result.elapsed_ms < 2000
    # The element is also exposed through the regular bot state.
    assert bot.state.element == result.element


def test_hit_on_first_frame_stops_immediately(tmp_path):
    haystack, template = _haystack_with_template(seed=3)

    bot = StubBot([haystack])
    _register(bot, tmp_path, "button", template)

    result = bot.find_until_result("button", matching=0.9, waiting_time=10000)

    assert result.found is True
    assert result.attempts == 1
    assert result.elapsed_ms < 2000


def test_timeout_with_low_score_candidate(tmp_path):
    haystack = _random_image(seed=4)
    _, template = _haystack_with_template(seed=4)
    low_score_template = _distorted_template(template)

    bot = StubBot([haystack], poll_interval=5)
    _register(bot, tmp_path, "button", low_score_template)

    waiting_time = 150
    started = time.perf_counter()
    result = bot.find_until_result("button", matching=0.9, waiting_time=waiting_time)
    wall_elapsed_ms = (time.perf_counter() - started) * 1000

    assert result.found is False
    assert result.element is None
    # A similar-but-not-good-enough template must report its real score, not 0.
    assert 0.0 < result.best_score < 0.9
    # Sanity check against a direct match computation, proving the score comes from
    # the actual template matching rather than from the threshold.
    direct_element, direct_score = cv2find.locate_best_opencv(
        low_score_template, haystack, confidence=0.9
    )
    assert direct_element is None
    assert result.best_score == pytest.approx(direct_score, abs=1e-6)
    # The search must keep taking screenshots until the timeout.
    assert result.attempts >= 2
    assert result.elapsed_ms >= waiting_time * 0.8
    assert result.elapsed_ms <= wall_elapsed_ms + 50
    # No hit, so the bot state must not hold a stale element.
    assert bot.state.element is None


def test_timeout_with_no_candidate(tmp_path):
    haystack = _random_image(seed=5)
    unrelated = _random_image(
        seed=6, width=TEMPLATE_WIDTH, height=TEMPLATE_HEIGHT
    )

    bot = StubBot([haystack], poll_interval=5)
    _register(bot, tmp_path, "button", unrelated)

    waiting_time = 100
    result = bot.find_until_result("button", matching=0.9, waiting_time=waiting_time)

    assert result.found is False
    assert result.element is None
    # Nothing similar on screen: the score is essentially zero...
    assert 0.0 <= result.best_score < 0.3
    # ...but the search still happened.
    assert result.attempts >= 2
    assert result.elapsed_ms >= waiting_time * 0.8


def test_grayscale_search_reports_hit(tmp_path):
    haystack, template = _haystack_with_template(seed=7)
    gray_haystack = haystack.convert("L")
    gray_template = template.convert("L")

    bot = StubBot([gray_haystack])
    _register(bot, tmp_path, "button", gray_template)

    result = bot.find_until_result("button", matching=0.9, grayscale=True)

    assert result.found is True
    assert result.element.left == TEMPLATE_LEFT
    assert result.element.top == TEMPLATE_TOP
    assert result.best_score >= 0.9


def test_region_is_honored(tmp_path):
    haystack, template = _haystack_with_template(seed=8)

    bot = StubBot([haystack])
    _register(bot, tmp_path, "button", template)

    # A region that does not contain the template must not find it.
    region_x = TEMPLATE_LEFT + TEMPLATE_WIDTH + 5
    result = bot.find_until_result(
        "button",
        x=region_x,
        y=0,
        width=HAYSTACK_WIDTH - region_x,
        height=HAYSTACK_HEIGHT,
        matching=0.9,
        waiting_time=50,
    )
    assert result.found is False

    # The full region finds it again.
    result = bot.find_until_result("button", matching=0.9)
    assert result.found is True
    assert result.element.left == TEMPLATE_LEFT


def test_best_score_is_maximum_across_screenshots(tmp_path):
    haystack = _random_image(seed=12)
    _, template = _haystack_with_template(seed=12)
    # A close-but-not-enough template (score between 0.9 and 1.0 would be a hit, so
    # use a heavier distortion) and an unrelated frame that scores worse.
    near_template = _distorted_template(template, seed=13, amplitude=150)
    unrelated_frame = _random_image(seed=14)

    bot = StubBot([unrelated_frame, haystack], poll_interval=5)
    _register(bot, tmp_path, "button", near_template)

    direct_element, direct_score = cv2find.locate_best_opencv(
        near_template, haystack, confidence=0.9
    )
    assert direct_element is None

    result = bot.find_until_result("button", matching=0.9, waiting_time=120)

    assert result.found is False
    assert result.element is None
    # The best score must come from the frame where the template was closest,
    # not from the unrelated frame nor from the 0.9 threshold.
    assert result.best_score == pytest.approx(direct_score, abs=1e-6)
    assert 0.0 < result.best_score < 0.9
    assert result.attempts >= 2


def test_timeout_attempts_and_elapsed_are_reasonable(tmp_path):
    unrelated_frame = _random_image(seed=16)

    bot = StubBot([unrelated_frame], poll_interval=5)
    # Use a template that is not present in the frame we serve.
    _, other_template = _haystack_with_template(seed=17)
    _register(bot, tmp_path, "button", other_template)

    waiting_time = 80
    result = bot.find_until_result("button", matching=0.9, waiting_time=waiting_time)

    assert result.found is False
    assert result.attempts == bot._screenshot_calls
    assert result.attempts >= 2
    assert result.elapsed_ms >= waiting_time * 0.8
    # Sleep never exceeds the remaining budget and never goes negative.
    assert all(0 <= interval <= bot._find_result_poll_interval for interval in bot.sleep_calls)


def test_locate_all_opencv_still_respects_confidence():
    haystack = _random_image(seed=18)
    _, template = _haystack_with_template(seed=18)

    matches = list(cv2find.locate_all_opencv(template, haystack, confidence=0.9))
    assert matches
    assert (matches[0].left, matches[0].top) == (TEMPLATE_LEFT, TEMPLATE_TOP)

    # Above any possible score: nothing is yielded, exactly like before.
    assert list(cv2find.locate_all_opencv(template, haystack, confidence=1.0)) == []


def test_missing_template_raises(tmp_path, missing_label):
    bot = StubBot([_random_image(seed=9)])

    with pytest.raises(FileNotFoundError, match=missing_label):
        bot.find_until_result(missing_label, waiting_time=50)


def test_template_path_that_no_longer_exists_raises(tmp_path):
    bot = StubBot([_random_image(seed=9)])
    vanished = tmp_path / "vanished.png"
    _random_image(seed=9, width=TEMPLATE_WIDTH, height=TEMPLATE_HEIGHT).save(vanished)
    bot.add_image("vanished", str(vanished))
    vanished.unlink()

    with pytest.raises(FileNotFoundError, match="vanished"):
        bot.find_until_result("vanished", waiting_time=50)


def test_unreadable_template_raises(tmp_path):
    bot = StubBot([_random_image(seed=10)])
    broken = tmp_path / "broken.png"
    broken.write_text("this is not an image")
    bot.add_image("broken", str(broken))

    with pytest.raises(ValueError, match="broken"):
        bot.find_until_result("broken", waiting_time=50)


def test_legacy_methods_are_unchanged(tmp_path):
    haystack, template = _haystack_with_template(seed=11)

    bot = StubBot([haystack])
    _register(bot, tmp_path, "button", template)

    # find_until keeps returning a Box (not the new result object).
    assert bot.find_until("button", waiting_time=50).left == TEMPLATE_LEFT
    # find_text keeps its grayscale behavior.
    assert bot.find_text("button", waiting_time=50).left == TEMPLATE_LEFT


def test_legacy_aliases_are_unchanged():
    # Instantiating a real bot needs a display/clipboard backend, so skip gracefully
    # where those are unavailable.
    try:
        real_bot = DesktopBot()
    except Exception as exc:  # pragma: no cover - environment dependent
        pytest.skip(f"Cannot instantiate DesktopBot here: {exc}")

    # `find` remains an alias of `find_until` and `findText` of `find_text`.
    assert real_bot.find.__func__ is DesktopBot.find_until
    assert real_bot.findText.__func__ is DesktopBot.find_text
    assert real_bot.findUntil.__func__ is DesktopBot.find_until
    # The new method is available under its own name.
    assert callable(getattr(real_bot, "find_until_result", None))
