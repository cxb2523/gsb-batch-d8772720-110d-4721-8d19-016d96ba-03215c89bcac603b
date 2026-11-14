"""Domain errors. Messages must never contain a secret."""

from __future__ import annotations


class MechaError(Exception):
    """Base error. ``code`` is stable and machine readable; ``exit_code`` is for the CLI."""

    code = "mecha_error"
    exit_code = 3

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class StoreLockedError(MechaError):
    """No usable key for the store (keyring empty, no passphrase, no TTY)."""

    code = "store_locked"


class WrongKeyError(MechaError):
    """A key or passphrase was found but does not open this store."""

    code = "wrong_key"


class UnsupportedKdfError(MechaError):
    code = "unsupported_kdf"


class StoreCorruptError(MechaError):
    code = "store_corrupt"


class PassphraseFileError(MechaError):
    code = "passphrase_file"


class DetectionError(MechaError):
    """The secret cannot be stored as given (unknown format, refresh token, session file…)."""

    code = "detection"
    exit_code = 2


class AmbiguousProviderError(DetectionError):
    code = "ambiguous_provider"

    def __init__(self, message: str, candidates: list[str]) -> None:
        super().__init__(message)
        self.candidates = candidates


class DuplicateCredentialError(MechaError):
    code = "duplicate"
    exit_code = 2

    def __init__(self, message: str, existing_id: str) -> None:
        super().__init__(message)
        self.existing_id = existing_id


class NotFoundError(MechaError):
    code = "not_found"
    exit_code = 2
