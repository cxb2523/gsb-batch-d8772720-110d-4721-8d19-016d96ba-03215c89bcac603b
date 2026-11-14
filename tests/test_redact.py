from __future__ import annotations

import logging

import pytest

from mecha.core.redact import redact, redact_text
from tests.fakes import body, fake, fake_aiza, fake_jwt


def test_redact_format_matches_spec_example_shape() -> None:
    key = "sk-ant-api03-R2D" + "x" * 80 + "igAA"
    assert redact(key) == "sk-ant-api03-R2D…igAA"


@pytest.mark.parametrize(
    ("secret", "expected"),
    [
        ("sk-ant-api03-" + "a" * 12, "sk-ant-api03-…aaaa"),
        ("sk-ant-api03-" + "a" * 5, "sk-ant-api03-…"),
        ("short", "…"),
    ],
)
def test_redact_short(secret: str, expected: str) -> None:
    assert redact(secret) == expected


def test_redact_never_reveals_most_of_the_body() -> None:
    key = fake("sk-proj-", 100)
    red = redact(key)
    assert len(red) < len("sk-proj-") + 10
    assert key[len("sk-proj-") + 3 : -4] not in red


@pytest.mark.parametrize(
    "secret",
    [fake("sk-ant-api03-"), fake("sk-proj-", 120), fake("xai-"), fake_aiza(), fake("sk-or-v1-")],
)
def test_redact_text_scrubs_known_formats(secret: str) -> None:
    text = f"calling api with key={secret}, failed"
    scrubbed = redact_text(text)
    assert secret not in scrubbed
    assert redact(secret) in scrubbed


def test_redact_text_scrubs_jwt() -> None:
    token = fake_jwt({"iss": "https://auth.openai.com"})
    assert token not in redact_text(f"Authorization: Bearer {token}")


def test_redact_text_extra_literals() -> None:
    secret = body(40)
    assert secret not in redact_text(f"boom {secret}", (secret,))


def test_log_records_are_redacted(caplog: pytest.LogCaptureFixture) -> None:
    secret = fake("sk-ant-api03-", 90)
    logger = logging.getLogger("mecha.test")
    with caplog.at_level(logging.DEBUG):
        logger.warning("key %s", secret)
        logger.info(f"inline {secret}")
        try:
            raise RuntimeError(f"exploded with {secret}")
        except RuntimeError:
            logger.exception("failure")
    assert secret not in caplog.text
    assert "sk-ant-api03-" in caplog.text
    formatted = "\n".join(logging.Formatter().format(r) for r in caplog.records)
    assert secret not in formatted
    assert "RuntimeError" in formatted


def test_redaction_keeps_args_shape_for_uvicorn_access_log() -> None:
    """uvicorn's AccessFormatter unpacks record.args; redaction must not collapse them."""
    from uvicorn.logging import AccessFormatter

    secret = fake("sk-ant-api03-", 90)
    logger = logging.getLogger("uvicorn.access.test")
    records: list[logging.LogRecord] = []

    class Keep(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            records.append(record)

    handler = Keep()
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    try:
        logger.info(
            '%s - "%s %s HTTP/%s" %d', "127.0.0.1:5000", "GET", f"/x?k={secret}", "1.1", 200
        )
    finally:
        logger.removeHandler(handler)
    [record] = records
    line = AccessFormatter('%(client_addr)s - "%(request_line)s" %(status_code)s').format(record)
    assert "GET /x?k=" in line
    assert "200" in line
    assert secret not in line


def test_redaction_of_mapping_args_and_objects(caplog: pytest.LogCaptureFixture) -> None:
    secret = fake("xai-", 60)

    class Leaky:
        def __str__(self) -> str:
            return f"obj({secret})"

    logger = logging.getLogger("mecha.test.args")
    with caplog.at_level(logging.INFO):
        logger.info("%(key)s and %(n)d", {"key": secret, "n": 3})
        logger.info("object %s", Leaky())
    assert secret not in caplog.text
    assert "and 3" in caplog.text
