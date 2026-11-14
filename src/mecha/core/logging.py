"""Log redaction: every log record is scrubbed of credential-looking strings at creation.

Installed as a LogRecord factory so it covers every logger and handler (uvicorn, httpx,
third parties), including exception text, which is pre-rendered and redacted.

The message template and each argument are redacted separately and the shape of
``record.args`` is kept (tuple or mapping): formatters such as uvicorn's access log unpack
``record.args`` and break if it is collapsed.
"""

from __future__ import annotations

import logging
import traceback
from collections.abc import Mapping
from typing import Any

from mecha.core.redact import redact_text

_installed = False
_PLAIN = (int, float, bool, type(None))


def _scrub(value: Any) -> Any:
    if isinstance(value, _PLAIN):
        return value
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, bytes):
        return redact_text(value.decode("utf-8", "replace"))
    # Anything else is rendered now, so a secret inside its __str__ cannot slip through.
    return redact_text(str(value))


def install_log_redaction() -> None:
    global _installed
    if _installed:
        return
    previous = logging.getLogRecordFactory()

    def factory(*args: Any, **kwargs: Any) -> logging.LogRecord:
        record = previous(*args, **kwargs)
        record.msg = redact_text(str(record.msg))
        if isinstance(record.args, Mapping):
            record.args = {k: _scrub(v) for k, v in record.args.items()}
        elif isinstance(record.args, tuple):
            record.args = tuple(_scrub(a) for a in record.args)
        if record.exc_info and record.exc_info[1] is not None:
            rendered = "".join(traceback.format_exception(*record.exc_info))
            record.exc_text = redact_text(rendered.rstrip("\n"))
            record.exc_info = None
        if record.stack_info:
            record.stack_info = redact_text(record.stack_info)
        return record

    logging.setLogRecordFactory(factory)
    _installed = True
