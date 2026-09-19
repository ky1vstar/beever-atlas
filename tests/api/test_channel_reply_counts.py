"""Tests for the read-path ``reply_count`` derivation.

``reply_count`` is a platform-reported field, so it only arrives populated from
platforms whose history API includes it (Slack, Mattermost). Discord and
``telegram-user`` return thread parents AND their replies in one pass and
persist 0 — and the UI hides a reply unless its parent advertises
``reply_count > 0``, which made whole threads invisible.

``_with_real_reply_counts`` fixes that by counting the stored rows: a reply
carries its parent's id in ``thread_id``.
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from beever_atlas.api import channels as channels_mod
from beever_atlas.api.channels import MessageResponse, _with_real_reply_counts

pytestmark = pytest.mark.asyncio

_CHANNEL_ID = "-1001659373068_46074"


def _msg(
    message_id: str,
    *,
    thread_id: str | None = None,
    reply_count: int = 0,
    platform: str = "telegram-user",
) -> MessageResponse:
    return MessageResponse(
        content="hi",
        author="u1",
        author_name="User One",
        author_image=None,
        platform=platform,
        channel_id=_CHANNEL_ID,
        channel_name="Group / Topic",
        message_id=message_id,
        timestamp="2026-09-18T10:00:00+00:00",
        thread_id=thread_id,
        attachments=[],
        reactions=[],
        reply_count=reply_count,
        is_bot=False,
        links=[],
    )


def _patch_counts(monkeypatch, counts: dict[str, int]) -> AsyncMock:
    stores = channels_mod.get_stores()
    spy = AsyncMock(return_value=counts)
    monkeypatch.setattr(stores.mongodb, "count_replies_for_messages", spy)
    return spy


async def test_fills_reply_count_from_stored_rows(monkeypatch):
    """A parent whose replies exist in the store gets the real count, even
    though the platform persisted 0."""
    spy = _patch_counts(monkeypatch, {"100": 2})
    messages = [
        _msg("100"),
        _msg("101", thread_id="100"),
        _msg("102", thread_id="100"),
    ]

    out = await _with_real_reply_counts(messages, _CHANNEL_ID)

    assert out[0].reply_count == 2
    # Replies themselves are untouched — only parents are counted.
    assert out[1].reply_count == 0
    assert out[2].reply_count == 0
    # Only top-level ids are queried; a reply can't be a thread parent here.
    spy.assert_awaited_once_with(_CHANNEL_ID, ["100"])


async def test_ignores_non_telegram_user_platforms(monkeypatch):
    """Slack/Discord/etc. report ``reply_count`` through their own history API
    (and read threads live from the bridge), so their persisted value is
    authoritative — the store aggregation must not run for them."""
    spy = _patch_counts(monkeypatch, {"100": 5})
    messages = [
        _msg("100", reply_count=3, platform="slack"),
        _msg("101", thread_id="100", platform="slack"),
    ]

    out = await _with_real_reply_counts(messages, _CHANNEL_ID)

    # Slack's own count is preserved; no aggregation query fired.
    assert out[0].reply_count == 3
    spy.assert_not_called()


async def test_leaves_parents_without_replies_at_zero(monkeypatch):
    _patch_counts(monkeypatch, {"100": 1})
    messages = [_msg("100"), _msg("200")]

    out = await _with_real_reply_counts(messages, _CHANNEL_ID)

    assert out[0].reply_count == 1
    assert out[1].reply_count == 0


async def test_skips_the_query_when_there_are_no_parents(monkeypatch):
    """A page containing only replies needs no aggregation round-trip."""
    spy = _patch_counts(monkeypatch, {})
    messages = [_msg("101", thread_id="100")]

    out = await _with_real_reply_counts(messages, _CHANNEL_ID)

    assert out[0].reply_count == 0
    spy.assert_not_called()


async def test_keeps_platform_counts_when_the_query_fails(monkeypatch):
    """Best-effort: a failed aggregation must not break the message list, and
    a platform-reported count (Slack) stays intact."""
    stores = channels_mod.get_stores()
    monkeypatch.setattr(
        stores.mongodb,
        "count_replies_for_messages",
        AsyncMock(side_effect=RuntimeError("mongo down")),
    )
    messages = [_msg("100", reply_count=7)]

    out = await _with_real_reply_counts(messages, _CHANNEL_ID)

    assert out[0].reply_count == 7


async def test_empty_page_is_a_noop(monkeypatch):
    spy = _patch_counts(monkeypatch, {})
    assert await _with_real_reply_counts([], _CHANNEL_ID) == []
    spy.assert_not_called()
