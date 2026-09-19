"""Tests for ``DELETE /api/channels/{channel_id}`` (delete-channel-v2 Wave 3).

This is the DESTRUCTIVE full delete — distinct from
``DELETE /api/channels/{channel_id}/data`` (reset). These tests focus on the
ENDPOINT'S responsibilities: authz-first ordering, 404 resolution, and
status → HTTP mapping. The store fan-out is unit-tested in Wave 2, so we
monkeypatch ``purge_channel`` to a fake and assert routing — not the fan-out.

Type-to-confirm is enforced by the UI dialog, not this endpoint: it is
anti-accidental friction rather than an authz control, and server-side
enforcement coupled the endpoint to whichever label the UI rendered.

Acceptance criteria covered:
  * AC#6  authz / IDOR — ``assert_channel_delete_access`` enforced FIRST.
  * AC#7  honest partial-failure — service ``status="partial"`` → HTTP 207.
  * happy path — ``status="completed"`` → 200 with counts.
  * 404 — channel referenced nowhere → 404 (purge NOT called).
  * already_in_progress — CAS loser → 200 without assuming counts.
"""

from __future__ import annotations

from typing import Literal
from unittest.mock import AsyncMock

import pytest
from httpx import ASGITransport, AsyncClient

import beever_atlas.api.channels as channels_mod
import beever_atlas.infra.channel_access as channel_access_mod
import beever_atlas.services.channel_deletion as deletion_mod
from beever_atlas.infra.auth import Principal, require_user
from beever_atlas.server.app import app

_CHANNEL_ID = "C-delete-me"
_DISPLAY_NAME = "General"


@pytest.fixture
async def client(mock_stores):  # noqa: ARG001 — wires the global stores
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


def _patch_purge(monkeypatch, *, status="completed", extra=None):
    """Install a fake ``purge_channel`` and return the AsyncMock spy.

    The service is imported lazily inside the endpoint
    (``from beever_atlas.services.channel_deletion import purge_channel``), so
    we patch the symbol on the source module — the import resolves to it.
    """
    if status == "already_in_progress":
        body = {"channel_id": _CHANNEL_ID, "status": "already_in_progress"}
    else:
        body = {
            "channel_id": _CHANNEL_ID,
            "counts": {"channel_messages": 3, "weaviate_facts": 7},
            "errors": ({"weaviate": "boom"} if status == "partial" else {}),
            "unlinked_from": ["conn-1"],
            "sync_cancelled": True,
            "purge_run_id": "run-abc",
            "status": status,
        }
    if extra:
        body.update(extra)
    spy = AsyncMock(return_value=body)
    monkeypatch.setattr(deletion_mod, "purge_channel", spy)
    return spy


def _make_referenced(monkeypatch, *, referenced=True):
    """Make ``_channel_is_referenced_anywhere`` resolve to ``referenced``.

    Patches the helper on the channels module so the 404 branch is
    deterministic without wiring full connection / synced-id fakes.
    """
    monkeypatch.setattr(
        channels_mod,
        "_channel_is_referenced_anywhere",
        AsyncMock(return_value=referenced),
    )


def _patch_display_name(monkeypatch, name: str | None = _DISPLAY_NAME):
    monkeypatch.setattr(
        channels_mod.get_stores().mongodb,
        "get_channel_display_name",
        AsyncMock(return_value=name),
    )


def _allow_delete(monkeypatch):
    """Bypass the destructive authz guard (default-allow) so non-authz tests
    isolate the behaviour under test."""
    monkeypatch.setattr(
        channel_access_mod,
        "assert_channel_delete_access",
        AsyncMock(return_value=None),
    )
    # The endpoint imports it at module load — patch the bound name too.
    monkeypatch.setattr(
        channels_mod,
        "assert_channel_delete_access",
        AsyncMock(return_value=None),
    )


# ---------------------------------------------------------------------------
# Happy path — completed → 200
# ---------------------------------------------------------------------------


async def test_delete_completed_returns_200_with_counts(client, monkeypatch):
    _allow_delete(monkeypatch)
    _patch_display_name(monkeypatch)
    _make_referenced(monkeypatch, referenced=True)
    spy = _patch_purge(monkeypatch, status="completed")

    resp = await client.request(
        "DELETE",
        f"/api/channels/{_CHANNEL_ID}",
        params={"confirm": _DISPLAY_NAME},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "completed"
    assert body["counts"]["channel_messages"] == 3
    assert body["errors"] == {}
    spy.assert_awaited_once_with(_CHANNEL_ID, principal_id="user:test")


async def test_delete_needs_no_confirm_param(client, monkeypatch):
    """Type-to-confirm is a UI-only guard now, so the endpoint purges without
    any ``confirm`` query param. Server-side enforcement compared against the
    activity-log display name, which could differ from the label the dialog
    rendered (the summary endpoint 404s until the first consolidation), so a
    user typing exactly what they saw got a 400."""
    _allow_delete(monkeypatch)
    _patch_display_name(monkeypatch)  # a display name IS stored
    _make_referenced(monkeypatch, referenced=True)
    spy = _patch_purge(monkeypatch, status="completed")

    resp = await client.request("DELETE", f"/api/channels/{_CHANNEL_ID}")
    assert resp.status_code == 200, resp.text
    spy.assert_awaited_once_with(_CHANNEL_ID, principal_id="user:test")


async def test_delete_ignores_a_stray_confirm_param(client, monkeypatch):
    """A stale client still sending ``?confirm=`` is not rejected — the value
    is simply unused, so old callers keep working."""
    _allow_delete(monkeypatch)
    _patch_display_name(monkeypatch)
    _make_referenced(monkeypatch, referenced=True)
    spy = _patch_purge(monkeypatch, status="completed")

    resp = await client.request(
        "DELETE",
        f"/api/channels/{_CHANNEL_ID}",
        params={"confirm": "anything-at-all"},
    )
    assert resp.status_code == 200, resp.text
    spy.assert_awaited_once()


# ---------------------------------------------------------------------------
# AC#7 — partial → 207
# ---------------------------------------------------------------------------


async def test_delete_partial_returns_207_with_errors(client, monkeypatch):
    _allow_delete(monkeypatch)
    _patch_display_name(monkeypatch)
    _make_referenced(monkeypatch, referenced=True)
    _patch_purge(monkeypatch, status="partial")

    resp = await client.request(
        "DELETE",
        f"/api/channels/{_CHANNEL_ID}",
        params={"confirm": _DISPLAY_NAME},
    )
    assert resp.status_code == 207, resp.text
    body = resp.json()
    assert body["status"] == "partial"
    assert body["errors"] == {"weaviate": "boom"}


# ---------------------------------------------------------------------------
# 404 — referenced nowhere
# ---------------------------------------------------------------------------


async def test_delete_unknown_channel_returns_404(client, monkeypatch):
    _allow_delete(monkeypatch)
    _patch_display_name(monkeypatch, name=None)
    _make_referenced(monkeypatch, referenced=False)
    spy = _patch_purge(monkeypatch, status="completed")

    resp = await client.request(
        "DELETE",
        f"/api/channels/{_CHANNEL_ID}",
        # display name is None, so the channel_id itself confirms.
        params={"confirm": _CHANNEL_ID},
    )
    assert resp.status_code == 404, resp.text
    spy.assert_not_called()


# ---------------------------------------------------------------------------
# already_in_progress — CAS loser → 200 without counts
# ---------------------------------------------------------------------------


async def test_delete_already_in_progress_returns_200_without_counts(client, monkeypatch):
    _allow_delete(monkeypatch)
    _patch_display_name(monkeypatch)
    _make_referenced(monkeypatch, referenced=True)
    _patch_purge(monkeypatch, status="already_in_progress")

    resp = await client.request(
        "DELETE",
        f"/api/channels/{_CHANNEL_ID}",
        params={"confirm": _DISPLAY_NAME},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "already_in_progress"
    assert body["channel_id"] == _CHANNEL_ID
    # The endpoint must NOT fabricate counts/errors for the CAS-loser body.
    assert "counts" not in body
    assert "errors" not in body
    assert "message" in body


# ---------------------------------------------------------------------------
# AC#6 — authz / IDOR: assert_channel_delete_access enforced FIRST
# ---------------------------------------------------------------------------


def _override_principal(pid: str, kind: Literal["user", "bridge", "mcp"] = "user"):
    """Override ``require_user`` for one test to a specific principal."""
    return lambda: Principal(pid, kind=kind)


def _force_single_tenant(monkeypatch, value: bool):
    from beever_atlas.infra.config import get_settings as real_get_settings

    base = real_get_settings()

    class _S:
        beever_single_tenant = value

        def __getattr__(self, item):  # pragma: no cover - passthrough
            return getattr(base, item)

    monkeypatch.setattr(channel_access_mod, "get_settings", lambda: _S())


async def test_authz_multi_tenant_non_owner_denied_403(client, monkeypatch):
    """A non-owner principal in multi-tenant mode is denied (403) and the
    purge fan-out never runs (authz is enforced before confirm/lookup)."""
    _force_single_tenant(monkeypatch, False)
    # Real connection list: channel owned by someone else.
    stores = channels_mod.get_stores()
    from datetime import UTC, datetime

    from beever_atlas.models.platform_connection import PlatformConnection

    owned_by_other = PlatformConnection(
        id="c1",
        platform="slack",
        source="ui",
        display_name="c1",
        status="connected",
        selected_channels=[_CHANNEL_ID],
        encrypted_credentials=b"",
        credential_iv=b"",
        credential_tag=b"",
        created_at=datetime.now(UTC),
        updated_at=datetime.now(UTC),
        owner_principal_id="user:owner",
    )
    stores.platform.list_connections = AsyncMock(return_value=[owned_by_other])
    spy = _patch_purge(monkeypatch, status="completed")
    _patch_display_name(monkeypatch)

    app.dependency_overrides[require_user] = _override_principal("user:intruder")
    try:
        resp = await client.request(
            "DELETE",
            f"/api/channels/{_CHANNEL_ID}",
            # Even with a correct confirm, authz must reject first.
            params={"confirm": _DISPLAY_NAME},
        )
    finally:
        app.dependency_overrides.pop(require_user, None)

    assert resp.status_code == 403, resp.text
    spy.assert_not_called()


async def test_authz_multi_tenant_owner_allowed_200(client, monkeypatch):
    _force_single_tenant(monkeypatch, False)
    stores = channels_mod.get_stores()
    from datetime import UTC, datetime

    from beever_atlas.models.platform_connection import PlatformConnection

    owned = PlatformConnection(
        id="c1",
        platform="slack",
        source="ui",
        display_name="c1",
        status="connected",
        selected_channels=[_CHANNEL_ID],
        encrypted_credentials=b"",
        credential_iv=b"",
        credential_tag=b"",
        created_at=datetime.now(UTC),
        updated_at=datetime.now(UTC),
        owner_principal_id="user:owner",
    )
    stores.platform.list_connections = AsyncMock(return_value=[owned])
    spy = _patch_purge(monkeypatch, status="completed")
    _patch_display_name(monkeypatch)
    _make_referenced(monkeypatch, referenced=True)

    app.dependency_overrides[require_user] = _override_principal("user:owner")
    try:
        resp = await client.request(
            "DELETE",
            f"/api/channels/{_CHANNEL_ID}",
            params={"confirm": _DISPLAY_NAME},
        )
    finally:
        app.dependency_overrides.pop(require_user, None)

    assert resp.status_code == 200, resp.text
    spy.assert_awaited_once_with(_CHANNEL_ID, principal_id="user:owner")


async def test_authz_single_tenant_user_allowed(client, monkeypatch):
    """In single-tenant (OSS default) any user principal may delete."""
    _force_single_tenant(monkeypatch, True)
    spy = _patch_purge(monkeypatch, status="completed")
    _patch_display_name(monkeypatch)
    _make_referenced(monkeypatch, referenced=True)

    # Default _auth_bypass principal is Principal("user:test", kind="user").
    resp = await client.request(
        "DELETE",
        f"/api/channels/{_CHANNEL_ID}",
        params={"confirm": _DISPLAY_NAME},
    )
    assert resp.status_code == 200, resp.text
    spy.assert_awaited_once()


async def test_authz_enforced_before_any_lookup(client, monkeypatch):
    """AC#6 ordering: a denied principal gets 403 before any store is read, so
    the destructive fan-out never runs and no channel metadata is resolved."""
    _force_single_tenant(monkeypatch, False)
    stores = channels_mod.get_stores()
    from datetime import UTC, datetime

    from beever_atlas.models.platform_connection import PlatformConnection

    owned_by_other = PlatformConnection(
        id="c1",
        platform="slack",
        source="ui",
        display_name="c1",
        status="connected",
        selected_channels=[_CHANNEL_ID],
        encrypted_credentials=b"",
        credential_iv=b"",
        credential_tag=b"",
        created_at=datetime.now(UTC),
        updated_at=datetime.now(UTC),
        owner_principal_id="user:owner",
    )
    stores.platform.list_connections = AsyncMock(return_value=[owned_by_other])
    spy = _patch_purge(monkeypatch, status="completed")
    dn = AsyncMock(return_value=_DISPLAY_NAME)
    monkeypatch.setattr(stores.mongodb, "get_channel_display_name", dn)

    app.dependency_overrides[require_user] = _override_principal("user:intruder")
    try:
        resp = await client.request("DELETE", f"/api/channels/{_CHANNEL_ID}")
    finally:
        app.dependency_overrides.pop(require_user, None)

    assert resp.status_code == 403, resp.text
    spy.assert_not_called()
    # Authz short-circuits before any channel metadata is read.
    dn.assert_not_called()
