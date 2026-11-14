"""
Message widgets for displaying notifications.

These widgets display status messages, warnings, and errors.
"""

import streamlit as st

from models.paginator import STOP_REASON_LABELS, StopReason


def build_incomplete_collection_message(
    fetched_count: int,
    stop_page: int,
    stop_reason: StopReason,
    total_count: int | None = None,
) -> str:
    """
    Build the human-readable warning shown when a collection run is incomplete.

    Pure string assembly (no Streamlit calls) so the wording can be unit tested
    directly. Always states how many films were collected and on which page the
    run stopped, plus the underlying reason and the requested URL context.
    """
    reason_label = STOP_REASON_LABELS.get(stop_reason, stop_reason.value)
    of_total = f" of **{total_count}**" if total_count else ""
    return (
        f"Collection is incomplete: **{fetched_count}**{of_total} movies collected, "
        f"stopped on page **{stop_page}** — {reason_label}. "
        "Retry later or relax the filters/sort to collect the remaining pages."
    )


def incomplete_collection_warning(result, total_count: int | None = None):
    """
    Display a visible warning for a partial/aborted pagination run.

    Args:
        result: A ``PaginationResult`` (or compatible object) carrying the
            collected count, stop page and stop reason.
        total_count: Optional expected total, when known.
    """
    st.warning(
        build_incomplete_collection_message(
            fetched_count=result.items_collected,
            stop_page=result.stop_page,
            stop_reason=result.stop_reason,
            total_count=total_count,
        )
    )


def user_not_found(username):
    """Display user not found error message"""
    st.error(f"User '[{username}](https://letterboxd.com/{username}/)' not found.")


def access_denied(username=None):
    """Display Cloudflare / IP block message"""
    target = (
        f" for [{username}](https://letterboxd.com/{username}/)" if username else ""
    )
    st.error(
        f"Letterboxd Cloudflare protection blocked the cloud server IP{target} (403 Forbidden). "
        "Direct list or watchlist URLs may still be accessible."
    )


def network_error(details=None):
    """Display network or timeout error"""
    msg = f": {details}" if details else "."
    st.error(f"Network error communicating with Letterboxd{msg}")


def invalid_list_url():
    """Display invalid list URL warning"""
    st.warning("The address is not a Letterboxd list.", icon="💡")
    invalid_input()


def invalid_input():
    """Display invalid input warning"""
    st.warning(
        "Please enter a valid **username**, **list url** or **username/list-title.**",
        icon="💡",
    )


def watchlist_empty(username):
    """Display watchlist empty message"""
    st.info(f"**{username}**'s watchlist is empty.")


def watchlist_private(username):
    """Display watchlist private/inaccessible message"""
    st.info(f"**{username}**'s watchlist is not accessible or private.")


def only_watchlist(username):
    """Display only watchlist available message"""
    st.info(
        f"**[{username}](https://letterboxd.com/{username}/)** has only a watchlist (no public lists)."
    )


def hq_user_status(username):
    """Display HQ user status message"""
    st.info(
        f"**[{username}](https://letterboxd.com/{username}/)** is an HQ user (no watchlist available)."
    )


def lists_no_watchlist(username):
    """Display lists available but no watchlist message"""
    st.info(
        f"**[{username}](https://letterboxd.com/{username}/)** has public lists. Watchlist might be private or empty."
    )


def no_public_lists(username):
    """Display no public lists message"""
    st.info(
        f"**[{username}](https://letterboxd.com/{username}/)** has no public lists."
    )


def hq_no_watchlist():
    """Display HQ users don't have watchlists message"""
    st.info("HQ users do not have watchlists.")


def watchlist_might_be_private():
    """Display watchlist might be private message"""
    st.info("The user's watchlist might be private or empty.")


def list_unavailable():
    """Display list unavailable warning"""
    st.warning("List is not available.")


def partial_lists_warning(username, fetched_count, expected_pages):
    """Display warning when Cloudflare blocks page 2+ of user lists."""
    st.warning(
        f"Only the first **{fetched_count}** lists (Page 1 of {expected_pages}) could be loaded "
        "because Letterboxd blocked deeper list pagination from the cloud server IP. "
        f"To download any other list, paste its direct URL or **`{username}/list-slug`** in the input box above."
    )


def no_filtered_movies():
    """Display info message when no movies match the active filters."""
    st.info("No movies found matching the selected filters.")


def error(message):
    """Display generic error message"""
    st.error(f"Error: {message}")


def awaiting_input():
    """Display awaiting input message"""
    st.write("_Awaiting input.._")
