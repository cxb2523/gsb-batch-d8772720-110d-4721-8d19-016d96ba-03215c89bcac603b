"""Typed check-time failures so a run can report *why* a record failed."""


class SubscriptionCheckError(Exception):
    """Base class for errors that should be reported as a per-record failure."""


class CursorNotFoundError(SubscriptionCheckError, ValueError):
    """The stored ``latest_chapter`` cursor is absent from the current list."""


class MissingFieldsError(SubscriptionCheckError, ValueError):
    """The updater.json record is missing fields the site requires."""


class InvalidRecordError(SubscriptionCheckError, ValueError):
    """The record has all fields but fails site specific validation."""
