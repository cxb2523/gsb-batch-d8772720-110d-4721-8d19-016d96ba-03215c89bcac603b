import asyncio
import base64 as b64
from io import BytesIO

import nextcord
from PIL import Image

from view import View


class ScreenshotError(Exception):
    """A screenshot or the final character image could not be captured.

    Callers can catch this to tell the user the round was interrupted instead of
    letting the failure bubble up and silently abandon the message. ``stage`` is
    the stage the session had reached (0-based) when the failure happened.
    """

    def __init__(self, message="Could not capture the site's image.", stage=None):
        super().__init__(message)
        self.stage = stage


class ScreenshotHandler:
    """Handles the screenshotting and sending of the screenshot."""

    def __init__(self, navi, interaction, co_operator):
        self.navi = navi
        self.interaction = interaction
        self.co_operator = co_operator
        self.view = None

    async def save_send_screenshot(self, session_id, original_message):
        """saves a screenshot of the current page and sends it to the user."""
        stage = View.stage.get(session_id, 0)

        try:
            await self.navi.wait_for_not_load_screen()
            (
                selector,
                crop,
                self.view,
                b64_string,
            ) = await self._get_screenshot_info_by_stage(stage, session_id)
            image_bytes = await self._read_image_bytes(selector, b64_string)
            file_bytes = self._convert_image(image_bytes, crop)
        except ScreenshotError as error:
            self._mark_site_error()
            if error.stage is None:
                error.stage = stage
            raise
        except Exception as error:
            self._mark_site_error()
            raise ScreenshotError(f"Could not capture the image for stage {stage}.", stage) from error

        file = nextcord.File(BytesIO(file_bytes), filename="image.webp")
        await original_message.edit(
            file=file,
            view=self.view if self.view else None,
        )

        original_message = await original_message.fetch()

        asyncio.create_task(self.remove_reactions(original_message))
        if self.view:
            await self.view.wait()
            asyncio.create_task(self.add_reaction(original_message))

    async def _read_image_bytes(self, selector, b64_string):
        """Returns the raw image bytes for a grid screenshot or the final image."""
        if b64_string:
            try:
                return b64.b64decode(b64_string)
            except (TypeError, ValueError) as error:
                raise ScreenshotError("The final image data could not be decoded.") from error

        image_bytes = await self.navi.screenshot(selector)
        if not image_bytes:
            raise ScreenshotError(f"The screenshot for '{selector}' came back empty.")
        return image_bytes

    @staticmethod
    def _convert_image(image_bytes, crop):
        """Decodes the image and returns WEBP bytes, cropping the stage container if needed."""
        try:
            with Image.open(BytesIO(image_bytes)) as pil_image:
                if crop:
                    width, height = pil_image.size
                    pil_image = pil_image.crop((0, height - 630, width, height))

                with BytesIO() as byte_arr:
                    pil_image.save(byte_arr, format="WEBP")
                    return byte_arr.getvalue()
        except Exception as error:
            raise ScreenshotError("The captured image could not be processed.") from error

    def _mark_site_error(self):
        """Records on the navigator that this session failed because of the site."""
        marker = getattr(self.navi, "mark_site_error", None)
        if callable(marker):
            marker()

    def _is_message_reactable(self, message: nextcord.Message) -> bool:
        """
        Checks if a message can have reactions added to it.
        Reactions are only possible on non-ephemeral messages in guild channels.
        """
        # An InteractionMessage (from an ephemeral response) is not a full Message object and cannot have reactions.
        if not isinstance(message, nextcord.Message):
            return False

        return isinstance(message.channel, nextcord.abc.GuildChannel) and not message.flags.ephemeral

    async def remove_reactions(self, original_message):
        """Removes all reactions from the original message."""
        if self._is_message_reactable(original_message):
            await original_message.clear_reactions()

    async def add_reaction(self, original_message):
        """Adds a reaction to the original message based on the button pressed in the view."""
        if self._is_message_reactable(original_message):
            if self.view.current_label == "❓":
                return
            # if the label is a single emoji (3 chars), it can be added directly.
            # if it is a string of emojis, it must be split into chunks of 3 chars.
            elif len(self.view.current_label) > 3:
                for emoji in [self.view.current_label[i : i + 3] for i in range(0, len(self.view.current_label), 3)]:
                    await original_message.add_reaction(emoji)
            else:
                await original_message.add_reaction(self.view.current_label)
            await original_message.add_reaction("⏳")

    async def _get_screenshot_info_by_stage(self, stage, session_id):
        """Returns the selector, crop, view, and base64 image based on the stage of the grid."""
        stage_configs = {
            0: {"selector": ".waifu-grid", "crop": False},
            1: {"selector": ".waifu-container", "crop": True},
            2: {"selector": ".waifu-container", "crop": True},
            3: {"selector": ".waifu-container", "crop": True},
        }

        if stage in stage_configs:
            config = stage_configs[stage]
            selector = config["selector"]
            crop = config["crop"]
            view = View(self.navi, self.interaction, self.co_operator, session_id)
            b64_string = None
        else:
            # this is a bit of a hack, but it works
            # the final image is not a screenshot, but a base64 image taken from the element's src attribute
            # this is done because of an issue with pyppeteer's screenshot func
            selector = None
            crop = False
            view = None
            await self.navi.wait_for_final_image()

            final_image_element = await self.navi.page.querySelector(".waifu-preview > img")
            final_image_url = await self.navi.page.evaluate("(element) => element.src", final_image_element)
            b64_string = final_image_url.split(",")[1]

        return selector, crop, view, b64_string
