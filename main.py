import json
import os
from uuid import uuid4

import nextcord
from nextcord.ext import commands

from cogs.admin_commands import AdminCommands
from logger import setup_logging
from permissions import check_permissions
from screenshot import ScreenshotError, ScreenshotHandler
from site_navigator import PageNavigator, SessionEndReason
from view import View

### Logging setup ###
log = setup_logging().log

### Bot setup ###
script_dir = os.path.dirname(os.path.abspath(__file__))
config_path = os.path.join(script_dir, "config.json")
with open(config_path) as config_file:
    config_data = json.load(config_file)

TOKEN = config_data["bot_token"]

CLIENT = commands.Bot(intents=nextcord.Intents().all())

CLIENT.add_cog(AdminCommands(CLIENT))

TOTAL_STEPS = 4


@CLIENT.event
async def on_ready():
    log.info("Bot Ready.")
    CLIENT.start_time = nextcord.utils.utcnow()
    await CLIENT.change_presence(activity=nextcord.Activity(type=nextcord.ActivityType.listening, name="/waifu"))


connected_users = []

SITE_ERROR_MESSAGE = (
    "Whoops! Something went wrong while I was creating your character, "
    "so this round wasn't finished :slight_frown:\n"
    "You had reached step **{step}/{total}**.\n"
    "This round is incomplete, but you can start a new /waifu to try again."
)


def _site_error_text(step):
    """Builds the message shown when the site interrupts a collection.

    ``step`` is the 1-based progress the user had reached, matching the
    "(_Progress: X/4)_" counter shown with every grid.
    """
    step = min(max(step, 1), TOTAL_STEPS)
    return SITE_ERROR_MESSAGE.format(step=step, total=TOTAL_STEPS)


def _current_step(stage):
    """Maps the internal 0-based stage to the 1-based progress shown to the user."""
    return min(stage + 1, TOTAL_STEPS)


def _mark_site_error(navi):
    """Records a site failure on the navigator and reports whether it was applied.

    A user exit or page timeout that was already recorded wins: a browser page
    closing mid-capture is an expected consequence of those, not a new site fault.
    """
    return navi.mark_site_error()


@CLIENT.slash_command(description="Build-a-waifu!")
async def waifu(
    interaction: nextcord.Interaction,
    co_operator: nextcord.Mentionable = nextcord.SlashOption(
        name="co-op",
        description="Allows other users to help you build your character.",
        default=None,
        required=False,
    ),
    privacy: bool | None = nextcord.SlashOption(
        name="private",
        description="Makes it so only you can see your characters.",
        default=False,
        required=False,
    ),
):
    """Starts the bot."""
    if co_operator and privacy:
        await interaction.response.send_message(
            "Whoops! You cannot use co-op mode and private mode at the same time.",
            ephemeral=True,
            delete_after=5,
        )
        return

    # check weather bot should start or not
    if not await check_permissions(interaction):
        return
    if interaction.user.id in connected_users:
        await interaction.response.send_message(
            "Whoops! One user cannot start me twice at the same time.You can continue making your character or press ❌ to exit.",
            ephemeral=True,
            delete_after=10,
        )
        return

    connected_users.append(interaction.user.id)

    session_id = uuid4()
    if co_operator:
        collaborator_type = "Role" if isinstance(co_operator, nextcord.Role) else "User"
        collaborator_info = f"Co-operator: {co_operator}. Co-operator type: ({collaborator_type})"
    else:
        collaborator_info = ""

    original_message = await interaction.response.send_message(
        ("Hi there! I'm WaifuBot!\nI create characters using [waifulabs.com](<https://www.waifulabs.com>). Let's get started!\n* You'll be presented with 4 grids of characters, each based on your previous choice. \n* Click the number corresponding to the character you like best in each grid or use these buttons:\n❌ to exit, ⬅ to undo, ➡ to skip a stage, 🎲 to choose randomly, or 🔄 to refresh the grid.\n_(Progress: 1/4)_"),
        ephemeral=privacy,
    )
    navi = await PageNavigator.create_navi()
    if navi is None:
        await original_message.edit(
            "Whoops! I'm having trouble connecting to the server right now.\nPlease try again later.\nFor now, you can use the official site instead: [waifulabs.com](<https://www.waifulabs.com>)",
            delete_after=60,
        )
        connected_users.remove(interaction.user.id)
        return

    log.info(f"Page started for user '{interaction.user.name}'. {collaborator_info}")

    screenshot_handler = ScreenshotHandler(navi, interaction, co_operator)

    View.stage.setdefault(session_id, 0)
    view_instance = View(navi, interaction, co_operator, session_id)
    try:
        # The loop shows the grid for the current stage; save_send_screenshot
        # blocks in the View until the user picks a button, so the stage is
        # re-read afterwards. Once all four choices are in, the final image is
        # fetched and only then announced.
        while view_instance.stage[session_id] < TOTAL_STEPS and not navi.page.isClosed():
            try:
                await screenshot_handler.save_send_screenshot(session_id, original_message)

                if view_instance.stage[session_id] < TOTAL_STEPS:
                    # Show the next grid and wait for the user's next choice.
                    await original_message.edit(
                        (f"Okay! lets continue. Here's another grid for you to choose from:\n(_Progress: {view_instance.stage[session_id] + 1}/4)_"),
                        view=None,
                    )

                # All four choices made: fetch the finished character once, then
                # announce it only after the image was actually sent.
                else:
                    await screenshot_handler.save_send_screenshot(session_id, original_message)
                    await original_message.edit(content="Here's your character! Thanks for playing :slight_smile:")
                    break

            except ScreenshotError:
                # The site broke mid-session (a closed page, a stale selector, a
                # failed screenshot). Never send a half-finished picture as the
                # final character. Record the cause and let the cleanup below tell
                # the user where this round stopped. A user exit or timeout that
                # was already recorded keeps its own behaviour.
                if _mark_site_error(navi):
                    log.error(
                        f"Collection interrupted for user '{interaction.user.name}' at stage "
                        f"{_current_step(view_instance.stage[session_id])}/{TOTAL_STEPS}. {collaborator_info}"
                    )
                break

            except nextcord.errors.NotFound:  # in case the message gets deleted, and timeout occurs.
                break

            except nextcord.errors.HTTPException:
                # Discord rejected a message edit (the screenshot itself was
                # fine). There is no way to keep the user informed, so stop and
                # let the cleanup below release the user.
                log.warning(f"Could not update the message for user '{interaction.user.name}'. {collaborator_info}")
                break

        # If the page disappeared without ❌ or a timeout being recorded, the site
        # (or the browser) dropped the session: treat it as a site error too.
        if navi.end_reason is None and navi.page.isClosed():
            _mark_site_error(navi)
            log.error(
                f"Page closed unexpectedly for user '{interaction.user.name}' at stage "
                f"{_current_step(view_instance.stage[session_id])}/{TOTAL_STEPS}. {collaborator_info}"
            )
    finally:
        # Cleanup: always release the user, and give the session a readable ending.
        if navi.end_reason is SessionEndReason.SITE_ERROR:
            # Keep the end reason on the navigator; tell the user the round is
            # incomplete and that they can start over. The progress grid and any
            # partial image are dropped, never sent as the final character.
            try:
                await original_message.edit(
                    _site_error_text(_current_step(view_instance.stage[session_id])),
                    attachments=[],
                    view=None,
                )
            except nextcord.errors.HTTPException:
                pass
            if not navi.page.isClosed():
                await navi.page.close()
            log.info(f"Page closed for user '{interaction.user.name}', site error. {collaborator_info}")

        elif not navi.page.isClosed():
            await navi.page.close()
            log.info(f"Page closed for user '{interaction.user.name}', finished. {collaborator_info}")

        elif navi.timed_out:
            log.info(f"Page closed for user '{interaction.user.name}', timed out. {collaborator_info}")
            try:
                await original_message.edit(
                    "Hey, anybody there? No? Okay, I'll shut down then :slight_frown:",
                    delete_after=10,
                    attachments=[],
                    view=None,
                )
            except nextcord.errors.HTTPException:
                pass

        else:
            try:
                await original_message.edit("Exiting...", delete_after=5, attachments=[], view=None)
            except nextcord.errors.HTTPException:
                pass
            log.info(f"Page closed for user '{interaction.user.name}'. {collaborator_info}")

        if interaction.user.id in connected_users:
            connected_users.remove(interaction.user.id)


@CLIENT.slash_command(description="Submit a bug report.")
async def feedback(interaction: nextcord.Interaction):
    """Link to the issues page."""
    await interaction.response.send_message(
        ("If you've encountered a bug or have a suggestion for Waifu Bot, please head over to the issues page on [Github](<https://github.com/ranshaa05/WaifuLabs-Bot/issues>).\nThere, you can report bugs, suggest features, or ask for help with any issues you're having.\nThanks for helping us make Waifu Bot better! :slight_smile:"),
        ephemeral=True,
    )


if __name__ == "__main__":
    CLIENT.run(TOKEN)
