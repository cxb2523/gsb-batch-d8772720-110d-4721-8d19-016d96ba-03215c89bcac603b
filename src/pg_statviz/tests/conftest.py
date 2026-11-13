"""Shared pytest configuration for the pg_statviz test suite.

Every module computes ``getpass.getuser()`` as an argument default at import
time. On Windows that falls back to the ``pwd`` module, which does not exist,
so collection fails before any test runs. Supplying ``USER`` from the standard
Windows account name keeps the suite runnable there; on POSIX platforms this
is a no-op because ``getpass`` already resolves the user.
"""

import os
import sys

if sys.platform == "win32" and not os.environ.get("USER"):
    os.environ["USER"] = os.environ.get("USERNAME", "test")
