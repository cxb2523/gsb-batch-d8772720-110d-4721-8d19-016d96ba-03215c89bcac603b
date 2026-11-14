"""In-memory keyring backends for tests. The real system keyring is never used."""

from __future__ import annotations

import keyring.backend
import keyring.errors


class MemoryKeyring(keyring.backend.KeyringBackend):
    priority = 1  # type: ignore[assignment]

    def __init__(self) -> None:
        super().__init__()
        self.data: dict[tuple[str, str], str] = {}

    def get_password(self, service: str, username: str) -> str | None:
        return self.data.get((service, username))

    def set_password(self, service: str, username: str, password: str) -> None:
        self.data[(service, username)] = password

    def delete_password(self, service: str, username: str) -> None:
        if self.data.pop((service, username), None) is None:
            raise keyring.errors.PasswordDeleteError("not found")


class NoKeyring(keyring.backend.KeyringBackend):
    """Behaves like a headless Linux box without a secret service."""

    priority = 0  # type: ignore[assignment]

    def get_password(self, service: str, username: str) -> str | None:
        raise keyring.errors.NoKeyringError("no keyring")

    def set_password(self, service: str, username: str, password: str) -> None:
        raise keyring.errors.NoKeyringError("no keyring")

    def delete_password(self, service: str, username: str) -> None:
        raise keyring.errors.NoKeyringError("no keyring")
