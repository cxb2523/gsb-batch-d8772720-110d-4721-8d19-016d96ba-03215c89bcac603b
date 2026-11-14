"""Credentials — named secret resolution for steps and notifiers.

Providers resolve secrets by logical name and never persist or log the values
they return. The environment provider uses only the standard library; the
keyring provider requires the optional ``rpacore[keyring]`` extra.
"""

from __future__ import annotations

import os
from typing import Protocol, runtime_checkable

from rpacore._validation import type_error, value_error

SUPPORTED_CREDENTIAL_PROVIDERS = frozenset({"env", "keyring"})

_ENV_PREFIX = "RPACORE_CRED_"


class CredentialNotFoundError(KeyError):
    """Raised when a provider cannot resolve a requested credential name."""


@runtime_checkable
class CredentialProvider(Protocol):
    """Protocol for named credential resolution backends."""

    def get(self, name: str) -> str:
        """Return the secret registered for ``name``."""
        ...


class EnvCredentialProvider:
    """Resolve credentials from ``RPACORE_CRED_<NAME>`` environment variables.

    Names are case-insensitive and normalized to uppercase, so ``sap_password``
    reads ``RPACORE_CRED_SAP_PASSWORD``.
    """

    def get(self, name: str) -> str:
        env_key = _env_key(name)
        value = os.environ.get(env_key)
        if value is None:
            raise CredentialNotFoundError(
                f"Credential {name!r} not found: EnvCredentialProvider expected "
                f"environment variable {env_key}"
            )
        return value


class KeyringCredentialProvider:
    """Resolve credentials from the OS credential store via ``keyring``.

    The optional ``keyring`` package is imported lazily so the default install
    stays standard-library only. ``service`` defaults to ``rpacore``.
    """

    def __init__(self, *, service: str = "rpacore") -> None:
        self.service = service

    def get(self, name: str) -> str:
        try:
            import keyring
        except ImportError as exc:
            raise ImportError(
                "KeyringCredentialProvider requires the optional keyring package; "
                "install it with: pip install rpacore[keyring]"
            ) from exc
        value = keyring.get_password(self.service, name)
        if value is None:
            raise CredentialNotFoundError(
                f"Credential {name!r} not found: KeyringCredentialProvider expected "
                f"an entry in service {self.service!r}"
            )
        return value


def build_credential_provider(credential_provider: str) -> CredentialProvider:
    """Return the configured credential provider without reading any secret."""
    if not isinstance(credential_provider, str):
        raise type_error("credential_provider", "str", credential_provider)
    if credential_provider not in SUPPORTED_CREDENTIAL_PROVIDERS:
        raise value_error(
            "credential_provider",
            "one of env, keyring",
            credential_provider,
        )
    if credential_provider == "keyring":
        return KeyringCredentialProvider()
    return EnvCredentialProvider()


def _env_key(name: str) -> str:
    return f"{_ENV_PREFIX}{name.upper()}"
