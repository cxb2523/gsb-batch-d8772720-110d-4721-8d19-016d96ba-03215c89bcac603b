"""Shared pytest fixtures for orchestrator + API tests."""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import pytest


@dataclass
class FakeContainer:
    """Stand-in for docker.models.containers.Container."""
    id: str = field(default_factory=lambda: f"fake_{uuid.uuid4().hex[:8]}")
    _logs: bytes = b""
    _exit_code: int = 0
    _killed: bool = False
    _removed: bool = False
    _side_effect_on_wait: Callable[[], None] | None = None

    def logs(self, **kwargs) -> bytes:
        return self._logs

    def wait(self, **kwargs) -> dict:
        if self._side_effect_on_wait:
            self._side_effect_on_wait()
        return {"StatusCode": self._exit_code, "Error": None}

    def kill(self, **kwargs):
        self._killed = True

    def remove(self, **kwargs):
        self._removed = True


class FakeContainersAPI:
    def __init__(self):
        self.last_run_kwargs: dict | None = None
        self.run_raises: Exception | None = None
        self._to_return: FakeContainer | None = None

    def run(self, image: str, **kwargs) -> FakeContainer:
        if self.run_raises:
            raise self.run_raises
        self.last_run_kwargs = {"image": image, **kwargs}
        c = self._to_return or FakeContainer()
        return c

    def get(self, cid: str) -> FakeContainer:
        if self._to_return and self._to_return.id == cid:
            return self._to_return
        raise KeyError(cid)

    def prepare(self, container: FakeContainer) -> None:
        self._to_return = container


class FakeDockerClient:
    def __init__(self):
        self.containers = FakeContainersAPI()


@pytest.fixture
def fake_docker() -> FakeDockerClient:
    return FakeDockerClient()


@pytest.fixture
def tmp_jobs_dir(tmp_path) -> Path:
    d = tmp_path / "jobs"
    d.mkdir()
    return d


@pytest.fixture
def orch_config(tmp_jobs_dir):
    """Canonical orchestrator constructor kwargs. Tests override as needed."""
    return dict(
        hermes_image="test/hermes:latest",
        skills=[
            "searcharvester-deep-research",
            "searcharvester-search",
            "searcharvester-extract",
        ],
        jobs_dir=tmp_jobs_dir,
        env={"OPENAI_API_KEY": "test", "OPENAI_BASE_URL": "http://vllm"},
        adapter_url_for_hermes="http://host.docker.internal:8000",
        timeout_sec=5,
    )
