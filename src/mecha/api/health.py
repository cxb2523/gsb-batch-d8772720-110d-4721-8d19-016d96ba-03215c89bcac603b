"""Health endpoint."""

from typing import Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel

from mecha import __version__

router = APIRouter()


class Health(BaseModel):
    status: Literal["ok"]
    version: str
    demo: bool = False
    store_open: bool = False


@router.get("/health")
async def health(request: Request) -> Health:
    api = getattr(request.app.state, "api", None)
    return Health(
        status="ok",
        version=__version__,
        demo=bool(api and api.demo),
        store_open=api is not None,
    )
