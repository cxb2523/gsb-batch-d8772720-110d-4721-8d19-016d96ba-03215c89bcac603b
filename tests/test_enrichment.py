"""Admin and management keys enrich the stored keys of their provider (phase 4 criteria)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import httpx
import pytest
import respx

from mecha.core.config import parse_config
from mecha.core.models import Budget, CredentialKind, FundsState, Overall, Validity
from mecha.core.paths import db_path
from mecha.core.service import MechaService
from mecha.providers.xai.errors import team_balance
from mecha.store.db import open_store
from tests.fakes import body, fake
from tests.test_check import Clock
from tests.test_error_map import fixture

pytestmark = pytest.mark.anyio

OA = "https://api.openai.com"
NOW = datetime(2026, 11, 4, 12, 0, tzinfo=UTC)


@pytest.fixture
def clock() -> Clock:
    return Clock()


def service(clock: Clock) -> MechaService:
    config = parse_config("[http]\nretries = 0\nbackoff_seconds = 0\n")
    return MechaService(lambda: open_store(db_path(), None), now=clock, config=config)


def page(data: list[dict[str, Any]], **extra: Any) -> dict[str, Any]:
    return {
        "object": "list",
        "data": data,
        "has_more": False,
        "first_id": None,
        "last_id": None,
        **extra,
    }


def project_key(
    secret: str, *, expires: int | None, last_used: int | None, **extra: Any
) -> dict[str, Any]:
    # Shape: GET /v1/organization/projects/{project_id}/api_keys (official reference)
    return {
        "object": "organization.project.api_key",
        "id": f"key_{secret[-6:]}",
        "name": "Production",
        "created_at": 1767225600,
        "last_used_at": last_used,
        "expires_at": expires,
        "redacted_value": f"{secret[:11]}...{secret[-4:]}",
        "owner": {"type": "user", "user": {"id": "user_1", "name": "Ada"}},
        "owner_project_access": "active",
        **extra,
    }


def openai_routes(
    router: respx.MockRouter,
    admin: str,
    keys: list[dict[str, Any]],
    costs: list[dict[str, Any]] | None = None,
) -> None:
    router.get(f"{OA}/v1/organization/admin_api_keys").mock(
        return_value=httpx.Response(
            200,
            json=page(
                [
                    {
                        **fixture("openai", "admin_api_keys_ok")["body"]["data"][0],
                        "redacted_value": f"{admin[:9]}...{admin[-4:]}",
                        "expires_at": int((NOW + timedelta(days=200)).timestamp()),
                    }
                ]
            ),
        )
    )
    router.get(f"{OA}/v1/organization/projects").mock(
        return_value=httpx.Response(
            200,
            json=page(
                [
                    {
                        "id": "proj_abc",
                        "object": "organization.project",
                        "name": "Main",
                        "status": "active",
                    }
                ]
            ),
        )
    )
    router.get(f"{OA}/v1/organization/projects/proj_abc/api_keys").mock(
        return_value=httpx.Response(200, json=page(keys))
    )
    router.get(f"{OA}/v1/organization/costs").mock(
        return_value=httpx.Response(
            200, json={"object": "page", "data": costs or [], "has_more": False, "next_page": None}
        )
    )


async def test_openai_admin_fills_expires_and_last_used_of_stored_project_keys(
    clock: Clock,
) -> None:
    svc = service(clock)
    admin = fake("sk-admin-", 80)
    k1, k2 = fake("sk-proj-", 120), fake("sk-proj-", 120)
    c1 = svc.add(k1).credential.id
    c2 = svc.add(k2).credential.id
    admin_id = svc.add(admin).credential.id
    expires = int((NOW + timedelta(days=10)).timestamp())
    last_used = int((NOW - timedelta(hours=3)).timestamp())
    with respx.mock as router:
        openai_routes(
            router,
            admin,
            [
                project_key(k1, expires=expires, last_used=last_used),
                project_key(k2, expires=None, last_used=None),  # never expires
                project_key(fake("sk-proj-", 120), expires=expires, last_used=None),  # not stored
            ],
        )
        await svc.check([admin_id])
    one, two = svc.get(c1), svc.get(c2)
    assert one.result.expiry.value.expires_at == datetime.fromtimestamp(expires, tz=UTC)
    assert one.result.expiry.source == "api"
    assert one.result.overall is Overall.amber  # expires in 10 days
    assert one.result.last_used_at is not None
    assert one.result.last_used_at.value == datetime.fromtimestamp(last_used, tz=UTC)
    assert one.credential.parent_id == admin_id
    assert two.result.expiry.value.state.value == "none"
    own = svc.get(admin_id)
    assert own.result.expiry.value.expires_at is not None  # its own expires_at
    svc.close()


async def test_a_hint_matching_two_stored_keys_enriches_neither(clock: Clock) -> None:
    svc = service(clock)
    admin = fake("sk-admin-", 80)
    head, tail = "sk-proj-AAA", "ZZZZ"
    a = svc.add(head + body(60) + tail).credential.id
    b = svc.add(head + body(60) + tail).credential.id
    admin_id = svc.add(admin).credential.id
    with respx.mock as router:
        openai_routes(
            router,
            admin,
            [
                {
                    **project_key(head + "x" * 60 + tail, expires=1, last_used=1),
                    "redacted_value": f"{head}...{tail}",
                }
            ],
        )
        await svc.check([admin_id])
    for cid in (a, b):
        assert svc.get(cid).result.expiry.value.expires_at is None
        assert svc.get(cid).credential.parent_id is None
    svc.close()


async def test_openai_estimated_org_balance_is_informational(clock: Clock) -> None:
    svc = service(clock)
    admin = fake("sk-admin-", 80)
    k1 = fake("sk-proj-", 120)
    c1 = svc.add(k1).credential.id
    admin_id = svc.add(admin).credential.id
    bought = NOW - timedelta(days=3)
    svc.update(
        admin_id, manual_budget=Budget(amount=Decimal("10"), currency="USD", purchased_at=bought)
    )
    day = int(bought.replace(hour=0, minute=0).timestamp())
    costs = [
        {
            "object": "bucket",
            "start_time": day + i * 86400,
            "end_time": day + (i + 1) * 86400,
            "results": [
                {"object": "organization.costs.result", "amount": {"value": v, "currency": "usd"}}
            ],
        }
        for i, v in enumerate([4.0, 4.5, 3.0])
    ]
    with respx.mock as router:
        openai_routes(router, admin, [project_key(k1, expires=None, last_used=None)], costs)
        await svc.check([admin_id])
    child, own = svc.get(c1), svc.get(admin_id)
    for item in (child, own):
        info = item.result.funds_info
        assert info is not None
        assert info.value.amount == Decimal("-1.5")  # 10 - 11.5: estimated, below zero
        assert info.value.until == datetime.fromtimestamp(day + 2 * 86400, tz=UTC)
        assert info.source == "inferred"
    assert child.result.overall is not Overall.red, "an estimate never colours the card"
    svc.close()


async def test_anthropic_admin_status_and_expiry(clock: Clock) -> None:
    svc = service(clock)
    admin = fake("sk-ant-admin01-", 90)
    k1 = "sk-ant-api03-R2D" + body(80) + "igAA"
    c1 = svc.add(k1).credential.id
    admin_id = svc.add(admin).credential.id
    item = fixture("anthropic", "admin_api_keys_ok")["body"]["data"][0]
    with respx.mock as router:
        router.get("https://api.anthropic.com/v1/organizations/api_keys").mock(
            return_value=httpx.Response(
                200,
                json={
                    "data": [{**item, "status": "archived", "expires_at": None}],
                    "has_more": False,
                    "first_id": "x",
                    "last_id": "x",
                },
            )
        )
        await svc.check([admin_id])
    r = svc.get(c1).result
    assert r.validity.value is Validity.revoked
    assert r.overall is Overall.red
    assert r.expiry.value.state.value == "none"
    svc.close()


def xai_routes(
    router: respx.MockRouter, team: str, key_id: str, prepaid: str, limit: str, used: str
) -> None:
    m = "https://management-api.x.ai"
    router.get(f"{m}/auth/management-keys/validation").mock(
        return_value=httpx.Response(
            200,
            json={
                **fixture("xai", "management_validation_ok")["body"],
                "scopeId": team,
                "teamId": team,
            },
        )
    )
    router.get(f"{m}/auth/teams/{team}/api-keys").mock(
        return_value=httpx.Response(
            200,
            json={
                "apiKeys": [
                    {
                        "apiKeyId": key_id,
                        "teamId": team,
                        "disabled": False,
                        "expireTime": "2026-11-15T00:00:00Z",
                        "redactedApiKey": "xai-...b14o",
                    }
                ]
            },
        )
    )
    router.get(f"{m}/v1/billing/teams/{team}/prepaid/balance").mock(
        return_value=httpx.Response(200, json={"changes": [], "total": {"val": prepaid}})
    )
    router.get(f"{m}/v1/billing/teams/{team}/postpaid/spending-limits").mock(
        return_value=httpx.Response(
            200, json={"spendingLimits": {"effectiveSl": {"val": limit}, "softSl": {"val": limit}}}
        )
    )
    router.get(f"{m}/v1/billing/teams/{team}/postpaid/invoice/preview").mock(
        return_value=httpx.Response(
            200, json={"coreInvoice": {"amountBeforeVat": used}, "effectiveSpendingLimit": limit}
        )
    )


async def test_xai_management_key_shows_prepaid_balance_in_usd(clock: Clock) -> None:
    svc = service(clock)
    team = "5ea6f6bd-7815-4b8a-9135-28b2d7ba6722"
    key_id = "ae1e1841-4326-4b36-a8a9-8a1a7237db11"
    child = svc.add(fake("xai-")).credential.id
    mgmt = svc.add(
        fake("xai-"),
        kind=CredentialKind.management_key,
    ).credential.id
    with respx.mock as router:
        router.get("https://api.x.ai/v1/api-key").mock(
            return_value=httpx.Response(200, json=fixture("xai", "api_key_ok")["body"])
        )
        xai_routes(router, team, key_id, prepaid="-1240", limit="0", used="0")
        await svc.check([child])
        clock.advance(minutes=1)
        await svc.check([mgmt])
        assert all(c.request.method == "GET" for c in router.calls), "enrichment only reads"
    own = svc.get(mgmt).result
    assert own.funds.value.amount == Decimal("12.40")
    assert own.funds.value.currency == "USD"
    assert own.account["prepaid_usd"].value == "12.40"
    kid = svc.get(child).result
    assert kid.funds.value.amount == Decimal("12.40")  # the team's balance, on its keys too
    assert kid.expiry.value.expires_at == datetime(2026, 11, 15, tzinfo=UTC)
    assert kid.overall is Overall.amber  # expires in < 14 days
    svc.close()


@pytest.mark.parametrize(
    ("prepaid", "limit", "used", "state", "amount"),
    [
        ("-1000", "0", "0", FundsState.ok, "10"),  # prepaid only
        ("0", "20000", "5000", FundsState.ok, "150"),  # prepaid empty but postpaid margin: works
        ("0", "20000", "19800", FundsState.low, "2"),
        ("0", "20000", "20000", FundsState.empty, "0"),  # neither: red
        ("0", "0", "0", FundsState.empty, "0"),
    ],
)
def test_xai_team_balance_counts_postpaid_margin(
    prepaid: str, limit: str, used: str, state: FundsState, amount: str
) -> None:
    funds, account = team_balance(
        {"total": {"val": prepaid}},
        {"spendingLimits": {"effectiveSl": {"val": limit}}},
        {"coreInvoice": {"amountBeforeVat": used}},
        Decimal("5"),
    )
    assert funds.state is state
    assert funds.amount == Decimal(amount)
    assert set(account) == {"prepaid_usd", "postpaid_margin_usd"}


async def test_openrouter_reports_funds_and_expiry_with_its_own_key(clock: Clock) -> None:
    svc = service(clock)
    cid = svc.add(fake("sk-or-v1-", 64)).credential.id
    with respx.mock as router:
        router.get("https://openrouter.ai/api/v1/key").mock(
            return_value=httpx.Response(200, json=fixture("openrouter", "key_ok")["body"])
        )
        [r] = await svc.check([cid])
    assert r.result.funds.value.amount == Decimal("74.5")
    assert r.result.funds.value.state is FundsState.ok
    assert r.result.expiry.value.expires_at == datetime(2027, 12, 31, 23, 59, 59, tzinfo=UTC)
    clock.advance(hours=7)
    with respx.mock as router:  # a later failed check keeps what the API reported
        router.get("https://openrouter.ai/api/v1/key").mock(side_effect=httpx.ConnectError("down"))
        [r] = await svc.check([cid])
    assert r.result.overall is Overall.grey
    assert r.result.expiry.value.expires_at is not None
    assert r.result.funds.value.amount == Decimal("74.5")
    svc.close()


async def test_openrouter_exhausted_key_is_red(clock: Clock) -> None:
    svc = service(clock)
    cid = svc.add(fake("sk-or-v1-", 64)).credential.id
    with respx.mock as router:
        router.get("https://openrouter.ai/api/v1/key").mock(
            return_value=httpx.Response(200, json=fixture("openrouter", "key_exhausted")["body"])
        )
        [r] = await svc.check([cid])
    assert r.result.overall is Overall.red
    svc.close()


async def test_inactive_owner_is_an_amber_warning_and_removing_the_admin_cleans_up(
    clock: Clock,
) -> None:
    svc = service(clock)
    admin = fake("sk-admin-", 80)
    k1 = fake("sk-proj-", 120)
    c1 = svc.add(k1).credential.id
    admin_id = svc.add(admin).credential.id
    expires = int((NOW + timedelta(days=60)).timestamp())
    with respx.mock as router:
        openai_routes(
            router,
            admin,
            [project_key(k1, expires=expires, last_used=None, owner_project_access="inactive")],
        )
        await svc.check([admin_id])
    r = svc.get(c1).result
    assert r.overall is Overall.amber
    assert "owner_no_project_access" in [x.code for x in r.reasons]
    assert r.validity.value is not Validity.blocked
    svc.remove(admin_id)
    child = svc.get(c1)
    assert child.credential.facts.reasons == []
    assert child.credential.facts.expires_at is None
    assert child.result.overall is Overall.grey  # back to its own (not yet checked) state
    svc.close()


async def test_removing_an_admin_key_clears_a_stale_revoked(clock: Clock) -> None:
    svc = service(clock)
    admin = fake("sk-ant-admin01-", 90)
    k1 = "sk-ant-api03-R2D" + body(80) + "igAA"
    c1 = svc.add(k1).credential.id
    admin_id = svc.add(admin).credential.id
    item = fixture("anthropic", "admin_api_keys_ok")["body"]["data"][0]
    with respx.mock as router:
        router.get("https://api.anthropic.com/v1/organizations/api_keys").mock(
            return_value=httpx.Response(
                200,
                json={
                    "data": [{**item, "status": "archived"}],
                    "has_more": False,
                    "first_id": "x",
                    "last_id": "x",
                },
            )
        )
        await svc.check([admin_id])
    assert svc.get(c1).result.overall is Overall.red
    svc.remove(admin_id)
    assert svc.get(c1).result.overall is not Overall.red
    svc.close()
