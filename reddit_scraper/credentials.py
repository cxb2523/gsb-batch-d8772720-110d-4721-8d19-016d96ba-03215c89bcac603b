"""Credential loading, the non-ASCII encoding guard, and PRAW authentication.

Credentials come from credentials.json (written by the web UI), falling back to
environment variables when the file is absent. The module keeps the loaded dict in
`CREDENTIALS` so long-running bot threads can read it without re-hitting disk; bot.py
reloads it (via detect_auth_capability) when the file's mtime changes.

Layering: credentials -> config only (see package __init__). Anything that needs to
push credential-derived state into `sources` (e.g. the Sylvia key) imports it lazily
inside the function to avoid an import cycle.
"""

import json
import logging
import os

from . import config

# Module-level runtime state. CREDENTIALS is the last loaded credentials dict (None
# until first load); CREDENTIAL_WARNING carries a human-readable encoding problem for
# the status file / UI (None when the loaded credentials are clean).
CREDENTIALS = None
CREDENTIAL_WARNING = None

# Credential fields that are secrets sent to Reddit — a lookalike-character typo in any
# of these silently breaks auth, so they're the ones the encoding guard checks.
ENCODING_CHECKED_FIELDS = (
    'reddit_client_id',
    'reddit_client_secret',
    'reddit_username',
    'reddit_password',
    'reddit_user_agent',
    'sylvia_api_key',
)

_ENV_MAP = {
    'reddit_client_id': 'REDDIT_CLIENT_ID',
    'reddit_client_secret': 'REDDIT_CLIENT_SECRET',
    'reddit_username': 'REDDIT_USERNAME',
    'reddit_password': 'REDDIT_PASSWORD',
    'reddit_user_agent': 'REDDIT_USER_AGENT',
    'sylvia_api_key': 'SYLVIA_API_KEY',
}


def find_non_ascii(value):
    """Return [(index, char), ...] for each non-ASCII character in `value`.

    Lookalike characters (e.g. Cyrillic 'І' for Latin 'I') pasted from a document are a
    common cause of "my credentials are correct but auth fails". Empty/None -> []."""
    if not value:
        return []
    return [(i, c) for i, c in enumerate(value) if ord(c) > 127]


def check_credential_encoding(creds):
    """Scan the secret fields for non-ASCII characters. Sets CREDENTIAL_WARNING to a
    readable message when any are found (clearing it when clean) and returns the list
    of offending field descriptions."""
    global CREDENTIAL_WARNING
    offenders = []
    for field in ENCODING_CHECKED_FIELDS:
        hits = find_non_ascii((creds or {}).get(field))
        if hits:
            i, c = hits[0]
            offenders.append(f"{field} (position {i}: '{c}' {hex(ord(c))})")
    if offenders:
        CREDENTIAL_WARNING = (
            "Non-ASCII characters found in credentials: " + "; ".join(offenders) + ". Please re-type them."
        )
        logging.warning(CREDENTIAL_WARNING)
    else:
        CREDENTIAL_WARNING = None
    return offenders


def read_credentials_file():
    """Read credentials.json as a dict. Returns {} when the file is missing or invalid."""
    try:
        with open(config.get_credentials_path(), 'r') as f:
            return json.load(f)
    except FileNotFoundError:
        return {}
    except json.JSONDecodeError as e:
        logging.error(f"Error decoding credentials file: {e}")
        return {}


def save_credentials_file(credentials):
    """Write credentials.json (and refresh the in-memory copy)."""
    global CREDENTIALS
    with open(config.get_credentials_path(), 'w') as f:
        json.dump(credentials, f, indent=4)
    CREDENTIALS = credentials
    check_credential_encoding(credentials)


def _env_credentials():
    """Build a credentials dict from environment variables (used when no file exists)."""
    creds = {field: os.getenv(env) for field, env in _ENV_MAP.items()}
    creds['notification_urls'] = []
    return creds


def load_credentials():
    """Load credentials from credentials.json, falling back to env vars when the file
    doesn't exist. Updates CREDENTIALS and the encoding warning; returns the dict."""
    global CREDENTIALS
    path = config.get_credentials_path()
    if os.path.exists(path):
        creds = read_credentials_file()
    else:
        creds = _env_credentials()
    CREDENTIALS = creds
    check_credential_encoding(creds)
    return creds


def detect_auth_capability():
    """(Re)load credentials and push credential-derived settings into the fetch layer.

    Called at startup and whenever credentials.json changes, so a Sylvia API key entered
    via the UI takes effect without a restart. Returns the loaded credentials dict."""
    creds = load_credentials() or {}
    sylvia_key = creds.get('sylvia_api_key')
    if sylvia_key:
        # Lazy import: sources -> notifications -> credentials, so a module-level import
        # here would cycle.
        from . import sources

        sources.SYLVIA_API_KEY = sylvia_key

    has_app = bool(creds.get('reddit_client_id') and creds.get('reddit_client_secret'))
    has_login = has_app and bool(creds.get('reddit_username') and creds.get('reddit_password'))
    if has_login:
        logging.info("Reddit auth: full login (read/write) available")
    elif has_app:
        logging.info("Reddit auth: app-only (read-only) available")
    else:
        logging.warning("Reddit auth: no app credentials; anonymous sources only")
    return creds


def authenticate_reddit():
    """Build a PRAW instance from the loaded credentials, or None when no Reddit app is
    configured. App-only credentials give a read-only instance; adding username/password
    upgrades to a full (script) login."""
    creds = CREDENTIALS or {}
    client_id = creds.get('reddit_client_id')
    client_secret = creds.get('reddit_client_secret')
    if not (client_id and client_secret):
        logging.warning("No Reddit app credentials configured; skipping OAuth source")
        return None

    import praw

    user_agent = creds.get('reddit_user_agent') or 'RedditMonitor/1.0'
    username = creds.get('reddit_username')
    password = creds.get('reddit_password')
    try:
        if username and password:
            return praw.Reddit(
                client_id=client_id,
                client_secret=client_secret,
                user_agent=user_agent,
                username=username,
                password=password,
            )
        return praw.Reddit(
            client_id=client_id,
            client_secret=client_secret,
            user_agent=user_agent,
            read_only=True,
        )
    except Exception as e:
        logging.error(f"Failed to authenticate with Reddit: {e}")
        return None


# Populate CREDENTIALS at import so long-lived readers (health, monitor, status) see a
# value without an explicit load. Failures leave CREDENTIALS as None rather than
# breaking the import.
try:
    load_credentials()
except Exception as e:
    logging.warning(f"Could not load credentials at startup: {e}")
