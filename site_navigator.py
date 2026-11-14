import asyncio
from enum import Enum
from random import randint

from pyppeteer import launch
from pyppeteer.errors import NetworkError, PageError, TimeoutError

UNDO_BUTTON_SELECTOR = ".sc-bdvvtL:nth-child(1)"
KEEP_BUTTON_SELECTOR = ".sc-bdvvtL:nth-child(2)"
WAIFU_GRID_SELECTOR = ".waifu-grid > div"
LOADING_SELECTOR = ".loading-callout"
FINAL_IMAGE_LOADING_SELECTOR = ".waifu-preview-loading"
MAX_GRID_CHOICES = 15
REFRESH_BUTTON_INDEX = 15  # The 16th element is the refresh button


class SessionEndReason(str, Enum):
    """How a collecting session ended.

    The value is kept on the navigator after the browser page is gone so callers
    can tell the user what actually happened instead of leaving the message
    stuck on an old progress grid. Being a ``str`` enum it also compares equal
    to its plain string value (e.g. ``"site_error"``).
    """

    USER_EXIT = "user_exit"  # the user pressed ❌
    PAGE_TIMEOUT = "page_timeout"  # the view expired without an answer
    SITE_ERROR = "site_error"  # screenshots/selectors failed, session aborted

    # Alias for readers that think of this as the timeout state.
    TIMEOUT = "page_timeout"


class PageNavigator:
    browser = None
    SessionEndReason = SessionEndReason

    def __init__(self):
        self.page = None
        # None while the session is still running; one SessionEndReason once it
        # is over. Kept after the page is closed so the end cause stays readable.
        self.end_reason = None

    @property
    def timed_out(self):
        """True when the session ended because the view timed out."""
        return self.end_reason is SessionEndReason.PAGE_TIMEOUT

    @timed_out.setter
    def timed_out(self, value):
        if value:
            self.end_reason = SessionEndReason.PAGE_TIMEOUT
        elif self.end_reason is SessionEndReason.PAGE_TIMEOUT:
            self.end_reason = None

    @property
    def user_exited(self):
        """True when the user ended the session by pressing ❌."""
        return self.end_reason is SessionEndReason.USER_EXIT

    @property
    def site_error(self):
        """True when the session was aborted because the site stopped cooperating."""
        return self.end_reason is SessionEndReason.SITE_ERROR

    def mark_site_error(self):
        """Records that the site (selectors/screenshots) broke this session.

        A user exit or a page timeout that was already recorded wins: a browser
        page closing mid-capture is an expected consequence of those, not a new
        site fault. Returns True when the session is considered a site error.
        """
        if self.end_reason is None:
            self.end_reason = SessionEndReason.SITE_ERROR
        return self.end_reason is SessionEndReason.SITE_ERROR

    @staticmethod
    async def _initialize_browser():
        """Initializes the pyppeteer browser instance if it hasn't been already."""
        if PageNavigator.browser is None or PageNavigator.browser.process.poll() is not None:
            PageNavigator.browser = await launch(headless=True, autoClose=True)

    @staticmethod
    async def create_navi():
        await PageNavigator._initialize_browser()
        navi = PageNavigator()
        navi.page = await PageNavigator.browser.newPage()
        await navi.page.setViewport({"width": 1200, "height": 600})

        try:
            await navi.page.goto("https://waifulabs.com/generate", {"timeout": 10000})
            return navi

        except (NetworkError, TimeoutError, PageError) as e:
            print(f"[Error] Connection failed. The site might be offline: {e}")
            await navi.page.close()
            return None

    async def click_by_index(self, index):
        girls = await self.find_all_girls()
        await girls[index - 1].click()

    async def exit(self):
        # A user pressing ❌ is the only caller of this, so record it unless a more
        # specific reason (e.g. a page timeout) has already been set.
        if self.end_reason is None:
            self.end_reason = SessionEndReason.USER_EXIT
        if self.page and not self.page.isClosed():
            await self.page.close()

    async def undo(self):
        await self.page.click(UNDO_BUTTON_SELECTOR)

    async def keep(self):
        await self.page.click(KEEP_BUTTON_SELECTOR)

    async def rand(self):
        random_index = randint(1, MAX_GRID_CHOICES)
        await self.page.click(f"{WAIFU_GRID_SELECTOR}:nth-child({random_index})")

    async def refresh(self):
        await (await self.find_all_girls())[REFRESH_BUTTON_INDEX].click()

    async def wait_for_not_load_screen(self):
        while await self.page.querySelector(LOADING_SELECTOR):
            await asyncio.sleep(0.01)

    async def wait_for_final_image(self):
        while await self.page.querySelector(FINAL_IMAGE_LOADING_SELECTOR):
            await asyncio.sleep(0.01)

    async def screenshot(self, selector):
        element = await self.page.querySelector(selector)
        screenshot_bytes = await element.screenshot()
        return screenshot_bytes

    async def find_all_girls(self):
        return await self.page.querySelectorAll(WAIFU_GRID_SELECTOR)

    async def page_timeout(self):
        # this is to differentiate between a timeout and a user exiting.
        self.timed_out = True
        await self.exit()
