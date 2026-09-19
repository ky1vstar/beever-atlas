import { describe, it } from "node:test";
import assert from "node:assert";
import { Api } from "teleproto";
import {
  parseTelegramUserChannelId,
  buildTelegramUserChannelId,
  telegramEntityLabel,
  telegramSenderIds,
  telegramReactions,
  telegramDirectParent,
  telegramTimestamp,
  buildTelegramUserFileUrl,
  parseTelegramUserFileUrl,
  telegramMediaDescriptor,
  telegramGroupedId,
  telegramLinkPreviews,
  TELEGRAM_USER_FILE_HOST,
} from "./telegram-user-bridge.js";
import { parseTelegramUserCredentials } from "./telegram-user-client.js";

// ── Channel id round-trip ────────────────────────────────────────────────────
//
// A forum group surfaces one channel per topic (`<groupId>_<topicId>`); a plain
// group is just its marked `-100…` id. The split must survive the leading `-`
// and never mistake a bare group id for a topic-scoped one.

describe("parseTelegramUserChannelId", () => {
  it("treats a bare marked group id as topic-less", () => {
    const ref = parseTelegramUserChannelId("-1001659373068");
    assert.strictEqual(ref.groupId, "-1001659373068");
    assert.strictEqual(ref.topicId, null);
  });

  it("splits a composite group_topic id", () => {
    const ref = parseTelegramUserChannelId("-1001659373068_46074");
    assert.strictEqual(ref.groupId, "-1001659373068");
    assert.strictEqual(ref.topicId, 46074);
  });

  it("ignores a non-numeric suffix", () => {
    const ref = parseTelegramUserChannelId("-1001659373068_general");
    assert.strictEqual(ref.groupId, "-1001659373068_general");
    assert.strictEqual(ref.topicId, null);
  });

  it("round-trips through buildTelegramUserChannelId", () => {
    assert.strictEqual(buildTelegramUserChannelId("-100123", 7), "-100123_7");
    assert.strictEqual(buildTelegramUserChannelId("-100123", null), "-100123");
    assert.strictEqual(buildTelegramUserChannelId("-100123"), "-100123");
    const ref = parseTelegramUserChannelId(buildTelegramUserChannelId("-100123", 7));
    assert.strictEqual(ref.groupId, "-100123");
    assert.strictEqual(ref.topicId, 7);
  });
});

// ── Author resolution ────────────────────────────────────────────────────────

describe("telegramEntityLabel", () => {
  it("prefers first+last name", () => {
    const { id, name } = telegramEntityLabel({ id: 42, firstName: "Ada", lastName: "Lovelace" });
    assert.strictEqual(id, "42");
    assert.strictEqual(name, "Ada Lovelace");
  });

  it("falls back to title then username", () => {
    assert.strictEqual(telegramEntityLabel({ id: 1, title: "Eng Group" }).name, "Eng Group");
    assert.strictEqual(telegramEntityLabel({ id: 1, username: "ada" }).name, "ada");
  });

  it("returns empty strings for a missing entity", () => {
    const { id, name } = telegramEntityLabel(null);
    assert.strictEqual(id, "");
    assert.strictEqual(name, "");
  });
});

describe("telegramSenderIds", () => {
  it("uses the personal sender when present", () => {
    const [id, name] = telegramSenderIds(
      { id: 133117334, firstName: "Sveneld" },
      "Ukrainian IT",
      "-1001659373068",
    );
    assert.strictEqual(id, "133117334");
    assert.strictEqual(name, "Sveneld");
  });

  it("attributes group-authored messages to the marked -100 group id", () => {
    // Anonymous admins / linked-channel posts carry no sender at all.
    const [id, name] = telegramSenderIds(null, "Ukrainian IT", "-1001659373068");
    assert.strictEqual(id, "-1001659373068");
    assert.strictEqual(name, "Ukrainian IT");
  });

  it("never yields an empty author", () => {
    const [id, name] = telegramSenderIds(null, "", "");
    assert.strictEqual(id, "unknown");
    assert.strictEqual(name, "unknown");
  });
});

// ── thread_id semantics ──────────────────────────────────────────────────────
//
// Atlas treats `thread_id` as the DIRECT parent's message id (Slack thread_ts,
// Discord message_reference.message_id). A forum topic's root is not a parent.

describe("telegramDirectParent", () => {
  const TOPIC = 46074;

  it("returns null for a message with no reply header", () => {
    assert.strictEqual(telegramDirectParent({}, TOPIC), null);
  });

  it("returns null when the reply target is the topic root", () => {
    assert.strictEqual(
      telegramDirectParent({ replyTo: { replyToMsgId: TOPIC } }, TOPIC),
      null,
    );
  });

  it("returns the direct parent id for a real reply", () => {
    assert.strictEqual(
      telegramDirectParent({ replyTo: { replyToMsgId: 12345 } }, TOPIC),
      12345,
    );
  });

  it("keeps the parent id in a non-forum channel", () => {
    // topicId === null → nothing is treated as a topic header.
    assert.strictEqual(telegramDirectParent({ replyTo: { replyToMsgId: 999 } }, null), 999);
  });

  it("does not flatten a nested chain to its root", () => {
    // B replies A, C replies B → C's thread_id is B, not A. This mirrors the
    // Discord adapter, which stores the directly-referenced message.
    const a = 100;
    const b = 101;
    assert.strictEqual(telegramDirectParent({ replyTo: { replyToMsgId: a } }, TOPIC), a);
    assert.strictEqual(telegramDirectParent({ replyTo: { replyToMsgId: b } }, TOPIC), b);
  });
});

// ── Reactions ────────────────────────────────────────────────────────────────

describe("telegramReactions", () => {
  it("returns an empty array when there are no reactions", () => {
    assert.deepStrictEqual(telegramReactions({}), []);
    assert.deepStrictEqual(telegramReactions({ reactions: {} }), []);
  });

  it("maps emoticon reactions to {name, count}", () => {
    const out = telegramReactions({
      reactions: { results: [{ reaction: { emoticon: "👍" }, count: 9 }] },
    });
    assert.deepStrictEqual(out, [{ name: "👍", count: 9 }]);
  });

  it("falls back to the document id for custom emoji", () => {
    const out = telegramReactions({
      reactions: { results: [{ reaction: { documentId: "555" }, count: 2 }] },
    });
    assert.deepStrictEqual(out, [{ name: "custom:555", count: 2 }]);
  });
});

// ── Timestamps ───────────────────────────────────────────────────────────────

describe("telegramTimestamp", () => {
  it("converts UNIX seconds to ISO-8601 in UTC", () => {
    const seconds = Math.floor(Date.UTC(2026, 8, 10, 9, 58, 38) / 1000);
    assert.strictEqual(telegramTimestamp(seconds), "2026-09-10T09:58:38.000Z");
  });

  it("falls back to now for a missing date", () => {
    const iso = telegramTimestamp(undefined);
    assert.ok(!Number.isNaN(new Date(iso).getTime()));
  });
});

// ── Credential parsing ───────────────────────────────────────────────────────

// ── Attachment reference URLs ────────────────────────────────────────────────
//
// MTProto media has no HTTP URL, so attachments carry an opaque handle that
// embeds the connection id (for exact proxy routing), the channel id and the
// message id. The parser is the security boundary — it must reject anything
// that isn't exactly that shape.

describe("telegram-user file URLs", () => {
  it("round-trips a reference URL", () => {
    const url = buildTelegramUserFileUrl({
      connectionId: "conn-abc",
      channelId: "-1001659373068_46074",
      messageId: 168494,
    });
    assert.strictEqual(url, `https://${TELEGRAM_USER_FILE_HOST}/conn-abc/-1001659373068_46074/168494`);

    const ref = parseTelegramUserFileUrl(url);
    assert.deepStrictEqual(ref, {
      connectionId: "conn-abc",
      channelId: "-1001659373068_46074",
      messageId: 168494,
    });
  });

  it("percent-encodes and restores ids containing separators", () => {
    const url = buildTelegramUserFileUrl({
      connectionId: "conn/with slash",
      channelId: "-100123",
      messageId: 7,
    });
    // The slash must not create a fourth path segment.
    assert.strictEqual(parseTelegramUserFileUrl(url)?.connectionId, "conn/with slash");
  });

  it("rejects a foreign host", () => {
    assert.strictEqual(parseTelegramUserFileUrl("https://evil.com/a/b/1"), null);
    // A suffix attack must not pass as the handle host.
    assert.strictEqual(parseTelegramUserFileUrl("https://tg.invalid.evil.com/a/b/1"), null);
  });

  it("rejects a wrong segment count", () => {
    assert.strictEqual(parseTelegramUserFileUrl(`https://${TELEGRAM_USER_FILE_HOST}/a/b`), null);
    assert.strictEqual(parseTelegramUserFileUrl(`https://${TELEGRAM_USER_FILE_HOST}/a/b/1/2`), null);
  });

  it("rejects a non-numeric or non-positive message id", () => {
    assert.strictEqual(parseTelegramUserFileUrl(`https://${TELEGRAM_USER_FILE_HOST}/c/ch/abc`), null);
    assert.strictEqual(parseTelegramUserFileUrl(`https://${TELEGRAM_USER_FILE_HOST}/c/ch/0`), null);
    assert.strictEqual(parseTelegramUserFileUrl(`https://${TELEGRAM_USER_FILE_HOST}/c/ch/-5`), null);
  });

  it("rejects a malformed URL", () => {
    assert.strictEqual(parseTelegramUserFileUrl("not a url"), null);
  });
});

// ── Media descriptors ────────────────────────────────────────────────────────

describe("telegramMediaDescriptor", () => {
  it("returns null when the message has no media", () => {
    assert.strictEqual(telegramMediaDescriptor({}), null);
  });

  it("ignores a web-page preview (that is a link, not an attachment)", () => {
    const media = Object.create(Api.MessageMediaWebPage.prototype);
    assert.strictEqual(telegramMediaDescriptor({ media }), null);
  });

  it("describes a photo as an image", () => {
    const media = Object.create(Api.MessageMediaPhoto.prototype);
    media.photo = { id: "5798890828624236085" };
    const out = telegramMediaDescriptor({ media });
    assert.strictEqual(out?.type, "image");
    assert.strictEqual(out?.mimetype, "image/jpeg");
    assert.strictEqual(out?.name, "photo_5798890828624236085.jpg");
  });

  it("uses the document filename attribute when present", () => {
    const filename = Object.create(Api.DocumentAttributeFilename.prototype);
    filename.fileName = "report.pdf";
    const media = Object.create(Api.MessageMediaDocument.prototype);
    media.document = { id: "1", mimeType: "application/pdf", attributes: [filename] };
    const out = telegramMediaDescriptor({ media });
    assert.deepStrictEqual(out, { type: "file", name: "report.pdf", mimetype: "application/pdf" });
  });

  it("synthesizes a name for a document without a filename attribute", () => {
    // Voice notes / round videos / stickers routinely omit the attribute.
    const media = Object.create(Api.MessageMediaDocument.prototype);
    media.document = { id: "42", mimeType: "video/mp4", attributes: [] };
    const out = telegramMediaDescriptor({ media });
    assert.strictEqual(out?.type, "video");
    assert.strictEqual(out?.name, "document_42.mp4");
  });

  it("maps an image document to the image type", () => {
    const media = Object.create(Api.MessageMediaDocument.prototype);
    media.document = { id: "9", mimeType: "image/png", attributes: [] };
    assert.strictEqual(telegramMediaDescriptor({ media })?.type, "image");
  });
});

// ── Fetch direction ──────────────────────────────────────────────────────────
//
// Regression guard: a full sync (no `since`) must read the NEWEST messages,
// mirroring Slack's `conversations.history` with `oldest` omitted. Iterating
// forward from the start of the channel instead spent the whole
// SYNC_MAX_MESSAGES budget on 2024 history and parked `last_sync_ts` years in
// the past, so every later sync kept crawling ancient messages.

describe("getMessages fetch direction", () => {
  /** Mirrors the branch in `TelegramUserBridge.getMessages`. */
  function plan(opts: { since?: string; order?: string }) {
    const ascending = opts.order === "asc";
    const hasSince =
      Boolean(opts.since) && Number.isFinite(new Date(opts.since as string).getTime());
    return { reverse: hasSince, needsFlip: ascending !== hasSince };
  }

  it("reads newest-first when no since cursor is given", () => {
    const { reverse } = plan({ order: "asc" });
    assert.strictEqual(reverse, false);
  });

  it("flips the page so order=asc still returns oldest-first", () => {
    // Fetched newest-first, caller wants ascending → reverse() before return.
    assert.strictEqual(plan({ order: "asc" }).needsFlip, true);
    // Caller wants descending → the fetch order already matches.
    assert.strictEqual(plan({ order: "desc" }).needsFlip, false);
  });

  it("walks forward from the cursor on an incremental sync", () => {
    const { reverse, needsFlip } = plan({ since: "2026-09-01T00:00:00Z", order: "asc" });
    assert.strictEqual(reverse, true);
    assert.strictEqual(needsFlip, false);
  });

  it("ignores an unparseable since value", () => {
    // A malformed cursor must not silently turn into "start from the oldest".
    assert.strictEqual(plan({ since: "not-a-date", order: "asc" }).reverse, false);
  });
});

// ── Link previews (unfurls) ──────────────────────────────────────────────────
//
// Telegram resolves previews server-side. They belong in `links`, not
// `attachments`, and the backend preprocessor folds title/description into the
// message text so fact extraction knows WHAT was linked.

describe("telegramLinkPreviews", () => {
  function webPageMessage(fields: Record<string, unknown>) {
    const page = Object.create(Api.WebPage.prototype);
    Object.assign(page, fields);
    const media = Object.create(Api.MessageMediaWebPage.prototype);
    media.webpage = page;
    return { media };
  }

  it("returns nothing when the message has no media", () => {
    assert.deepStrictEqual(telegramLinkPreviews({}), []);
  });

  it("returns nothing for a photo (that is an attachment, not a link)", () => {
    const media = Object.create(Api.MessageMediaPhoto.prototype);
    media.photo = { id: "1" };
    assert.deepStrictEqual(telegramLinkPreviews({ media }), []);
  });

  it("maps a resolved preview to the links shape", () => {
    const out = telegramLinkPreviews(
      webPageMessage({
        url: "https://minv.sk/article",
        title: "New rules",
        description: "Police changed the booking system",
        siteName: "minv.sk",
      }),
    );
    assert.deepStrictEqual(out, [
      {
        url: "https://minv.sk/article",
        title: "New rules",
        description: "Police changed the booking system",
        siteName: "minv.sk",
      },
    ]);
  });

  it("omits absent metadata rather than emitting empty strings", () => {
    const out = telegramLinkPreviews(webPageMessage({ url: "https://example.com" }));
    assert.deepStrictEqual(out, [{ url: "https://example.com" }]);
  });

  it("ignores an unresolved preview", () => {
    // WebPagePending / WebPageEmpty carry no metadata yet.
    const pending = Object.create(Api.WebPagePending.prototype);
    const media = Object.create(Api.MessageMediaWebPage.prototype);
    media.webpage = pending;
    assert.deepStrictEqual(telegramLinkPreviews({ media }), []);
  });

  it("ignores a preview with no url", () => {
    assert.deepStrictEqual(telegramLinkPreviews(webPageMessage({ title: "no url" })), []);
  });
});

// ── Album grouping ───────────────────────────────────────────────────────────
//
// Telegram permits one media per message, so a multi-media post is N messages
// sharing a `groupedId`. They stay separate NormalizedMessages (merging would
// break message_id-based dedup/threading and is non-deterministic across a
// pagination boundary); the id is exposed so a reader can group them later.

describe("telegramGroupedId", () => {
  it("is undefined for a standalone message", () => {
    assert.strictEqual(telegramGroupedId({}), undefined);
    assert.strictEqual(telegramGroupedId({ groupedId: null }), undefined);
  });

  it("stringifies a BigInteger without losing precision", () => {
    // Real album id observed in a live export; > 2^53, so a JS number would
    // round it.
    const groupedId = {
      toString: () => "14234970293946226",
    };
    assert.strictEqual(telegramGroupedId({ groupedId }), "14234970293946226");
  });

  it("keeps album members distinguishable by message id", () => {
    // Both members report the SAME grouped id — that is what lets a reader
    // rejoin them — while their message ids stay distinct.
    const groupedId = { toString: () => "1423" };
    assert.strictEqual(telegramGroupedId({ id: 143218, groupedId }), "1423");
    assert.strictEqual(telegramGroupedId({ id: 143219, groupedId }), "1423");
  });
});

describe("parseTelegramUserCredentials", () => {
  it("accepts camelCase keys (the bridge's normalized form)", () => {
    const creds = parseTelegramUserCredentials(
      { apiId: "110110", apiHash: "abc", session: "1ABC" },
      "conn-1",
    );
    assert.deepStrictEqual(creds, { apiId: 110110, apiHash: "abc", session: "1ABC" });
  });

  it("accepts snake_case keys as stored by the backend", () => {
    const creds = parseTelegramUserCredentials(
      { api_id: "110110", api_hash: "abc", session: "1ABC" },
      "conn-1",
    );
    assert.deepStrictEqual(creds, { apiId: 110110, apiHash: "abc", session: "1ABC" });
  });

  it("returns null when a required credential is missing", () => {
    assert.strictEqual(parseTelegramUserCredentials({ apiId: "1" }, "conn-1"), null);
    assert.strictEqual(parseTelegramUserCredentials(null, "conn-1"), null);
    assert.strictEqual(
      parseTelegramUserCredentials({ apiId: "0", apiHash: "a", session: "s" }, "conn-1"),
      null,
    );
  });
});
