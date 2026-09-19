/**
 * TelegramUserBridge — read-only ingestion bridge for `telegram-user`
 * connections (MTProto user account via teleproto).
 *
 * Why a second Telegram platform: the Bot API `telegram` adapter cannot read
 * group history or enumerate chats (see `TelegramBridge` in bridge.ts, whose
 * history methods all throw NOT_SUPPORTED). A user session can, so
 * `telegram-user` is the ingestion path while `telegram` stays the reply path.
 *
 * Channel model (groups only — DMs and broadcast channels are never listed):
 *   - Plain group / supergroup → one channel, id = the marked `-100…` peer id.
 *   - Forum group             → one channel PER TOPIC, id = `<groupId>_<topicId>`.
 *     The forum group itself is NOT listed; its topics carry the messages.
 *
 * Message mapping mirrors the platform adapters already in bridge.ts:
 *   - `thread_id` is the id of the message this one DIRECTLY replies to, i.e.
 *     Atlas' `thread_ts` semantics, matching the Discord adapter's
 *     `message_reference.message_id`. A forum topic's root is not a parent, so
 *     plain topic posts (whose `replyToMsgId` is the topic id) are top-level.
 *   - Group-authored messages (anonymous admins, linked-channel posts) have no
 *     personal sender, so they are attributed to the group with its marked
 *     `-100…` id rather than an "unknown" placeholder.
 *   - `reply_count` stays 0, same as the Discord adapter: this bridge returns
 *     roots AND replies from `getMessages`, so the sync runner never needs the
 *     Slack-style thread dozagruzka that field drives.
 */

import { Api, utils } from "teleproto";
import type { TelegramClient } from "teleproto";
import type { NormalizedChannel, NormalizedMessage } from "./bridge.js";
import {
  getTelegramUserClient,
  type TelegramUserCredentials,
} from "./telegram-user-client.js";
import { safeErrorMessage } from "./http-utils.js";

/** Local mirror of bridge.ts's `GetMessagesOpts`. That interface is private to
 *  bridge.ts; re-declaring the shape here keeps this file additive instead of
 *  requiring an export change in the shared module. */
interface GetMessagesOpts {
  limit: number;
  since?: string;
  before?: string;
  order?: string;
}

/** Telegram's own cap for a single `messages.GetForumTopics` page. */
const FORUM_TOPICS_PAGE_SIZE = 100;

/** Safety cap on total topics enumerated for one forum group. */
const FORUM_TOPICS_MAX = 1000;

/** Safety cap on dialogs scanned when listing channels. A user account can
 *  have thousands of dialogs (most of them DMs we skip), and the listing runs
 *  synchronously inside an HTTP request, so it must stay bounded. */
const DIALOG_SCAN_MAX = 500;

/** Separator between the group id and the topic id in a composite channel id.
 *  `_` is safe because a marked peer id is `-100` + digits and a topic id is
 *  digits, so the split is unambiguous. `:` is avoided — the bot's thread-id
 *  scheme (`platform:channel:thread`) already uses it. */
const TOPIC_ID_SEPARATOR = "_";

/**
 * Synthetic host for Telegram attachment references.
 *
 * MTProto media has no HTTP URL at all — bytes are only reachable through an
 * authenticated `downloadMedia` call. But every consumer downstream (the
 * `NormalizedMessage.attachments[].url` field, the backend media processor,
 * the bot's `/bridge/files` proxy) is URL-shaped, so we mint a reference URL
 * that carries everything needed to re-fetch the media and route it back to
 * the right connection.
 *
 * `.invalid` is reserved by RFC 2606 and never resolves in DNS, which is the
 * point: the URL is an opaque handle, and any code path that tried to fetch it
 * directly fails closed instead of reaching a real host.
 */
export const TELEGRAM_USER_FILE_HOST = "tg.invalid";

export interface TelegramUserChannelRef {
  /** Marked `-100…` supergroup id. */
  groupId: string;
  /** Forum topic id, or null for a plain (non-forum) group. */
  topicId: number | null;
}

/**
 * Split a channel id into its group and (optional) topic parts.
 * `-1001659373068`        → { groupId: "-1001659373068", topicId: null }
 * `-1001659373068_46074`  → { groupId: "-1001659373068", topicId: 46074 }
 */
export function parseTelegramUserChannelId(channelId: string): TelegramUserChannelRef {
  const raw = String(channelId).trim();
  // Only split on a separator that is followed by digits, so a bare negative
  // id (which contains no `_`) and a malformed suffix both fall back cleanly.
  const idx = raw.lastIndexOf(TOPIC_ID_SEPARATOR);
  if (idx > 0) {
    const suffix = raw.slice(idx + 1);
    if (/^\d+$/.test(suffix)) {
      return { groupId: raw.slice(0, idx), topicId: Number.parseInt(suffix, 10) };
    }
  }
  return { groupId: raw, topicId: null };
}

/** Build the channel id for a group, optionally scoped to a forum topic. */
export function buildTelegramUserChannelId(groupId: string | number, topicId?: number | null): string {
  return topicId ? `${groupId}${TOPIC_ID_SEPARATOR}${topicId}` : String(groupId);
}

export interface TelegramUserFileRef {
  connectionId: string;
  channelId: string;
  messageId: number;
}

/**
 * Mint the reference URL for a message's media.
 *
 * Shape: `https://tg.invalid/<connectionId>/<channelId>/<messageId>`
 *
 * The connection id is embedded so the file proxy routes straight to the
 * owning adapter instead of probing every Telegram connection in turn. Unlike
 * issue #47's Telegram bot-token routing key, a connection id is not a secret
 * — it is already visible in the backend's own `/bridge/connections/...` URLs.
 */
export function buildTelegramUserFileUrl(ref: TelegramUserFileRef): string {
  const conn = encodeURIComponent(ref.connectionId);
  const channel = encodeURIComponent(ref.channelId);
  return `https://${TELEGRAM_USER_FILE_HOST}/${conn}/${channel}/${ref.messageId}`;
}

/**
 * Parse a reference URL back into its parts, or null when it isn't one.
 *
 * Validates the host and the exact segment count so a malformed or
 * attacker-supplied URL cannot smuggle a different shape through.
 */
export function parseTelegramUserFileUrl(rawUrl: string): TelegramUserFileRef | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.hostname.toLowerCase() !== TELEGRAM_USER_FILE_HOST) return null;
  const segments = parsed.pathname.split("/").filter((s) => s.length > 0);
  if (segments.length !== 3) return null;
  const [connRaw, channelRaw, messageRaw] = segments;
  const messageId = Number.parseInt(messageRaw, 10);
  if (!Number.isInteger(messageId) || messageId <= 0) return null;
  let connectionId: string;
  let channelId: string;
  try {
    connectionId = decodeURIComponent(connRaw);
    channelId = decodeURIComponent(channelRaw);
  } catch {
    return null;
  }
  if (!connectionId || !channelId) return null;
  return { connectionId, channelId, messageId };
}

/**
 * Describe a message's media as an Atlas attachment, or null when the message
 * carries none.
 *
 * Only real media counts: `MessageMediaWebPage` is a link preview, which the
 * platform adapters surface through `links`, not `attachments`.
 */
export function telegramMediaDescriptor(
  message: unknown,
): { type: string; name: string; mimetype: string } | null {
  const media = (message as { media?: unknown })?.media;
  if (!media) return null;
  if (media instanceof Api.MessageMediaWebPage) return null;

  if (media instanceof Api.MessageMediaPhoto) {
    const photoId = (media.photo as { id?: unknown })?.id;
    return {
      type: "image",
      name: photoId ? `photo_${photoId}.jpg` : "photo.jpg",
      mimetype: "image/jpeg",
    };
  }

  if (media instanceof Api.MessageMediaDocument) {
    const doc = media.document as
      | { id?: unknown; mimeType?: string; attributes?: unknown[] }
      | undefined;
    const mimetype = doc?.mimeType || "application/octet-stream";
    let name = "";
    for (const attr of doc?.attributes ?? []) {
      if (attr instanceof Api.DocumentAttributeFilename) {
        name = attr.fileName;
        break;
      }
    }
    if (!name) {
      // Voice notes, round videos and stickers often ship without a filename
      // attribute; fall back to the document id plus a mime-derived extension.
      const ext = mimetype.includes("/") ? mimetype.split("/")[1] : "bin";
      name = doc?.id ? `document_${doc.id}.${ext}` : `document.${ext}`;
    }
    const type = mimetype.startsWith("image/")
      ? "image"
      : mimetype.startsWith("video/")
        ? "video"
        : "file";
    return { type, name, mimetype };
  }

  // Contacts, polls, geo, dice, invoices … carry no downloadable bytes.
  return null;
}

export interface TelegramLinkPreview {
  url: string;
  title?: string;
  description?: string;
  imageUrl?: string;
  siteName?: string;
}

/**
 * Extract the link preview (unfurl) a message carries, if any.
 *
 * Telegram resolves link previews server-side and attaches them as
 * `MessageMediaWebPage`, which is a preview rather than a downloadable file —
 * so it belongs in `links`, not `attachments` (mirrors how the Slack and
 * Discord bridges split unfurls out of their attachment lists).
 *
 * The backend's preprocessor folds these into the message text as
 * `[Link: <title> — <description> (<url>)]` and persists them as
 * `source_link_urls`, so populating the title/description here is what lets
 * fact extraction reason about WHAT was linked. Without it, the preprocessor's
 * bare-URL fallback still records the URL, but with no context.
 *
 * `WebPageEmpty` / `WebPagePending` carry no metadata (Telegram hasn't
 * resolved the target yet), so they yield no preview.
 */
export function telegramLinkPreviews(message: unknown): TelegramLinkPreview[] {
  const media = (message as { media?: unknown })?.media;
  if (!(media instanceof Api.MessageMediaWebPage)) return [];
  const page = media.webpage;
  if (!(page instanceof Api.WebPage)) return [];
  if (!page.url) return [];

  const preview: TelegramLinkPreview = { url: page.url };
  if (page.title) preview.title = page.title;
  if (page.description) preview.description = page.description;
  if (page.siteName) preview.siteName = page.siteName;
  // The preview thumbnail is a Photo object, not a URL — it would need a
  // separate download, so only its presence is recorded via the media
  // descriptor path. Left unset rather than fabricating a URL.
  return [preview];
}

/** Display name for a user/chat/channel entity — first+last, else title, else username. */
export function telegramEntityLabel(entity: unknown): { id: string; name: string } {
  const e = entity as
    | { id?: unknown; firstName?: string; lastName?: string; username?: string; title?: string }
    | null
    | undefined;
  const id = e?.id !== undefined && e?.id !== null ? String(e.id) : "";
  const parts = [e?.firstName, e?.lastName].filter(Boolean) as string[];
  const name = parts.length > 0 ? parts.join(" ") : e?.title || e?.username || "";
  return { id, name };
}

/**
 * Resolve `[authorId, authorName]` for any sender shape.
 *
 * Messages posted on behalf of the group have no personal sender; attribute
 * those to the group itself using its marked `-100…` id so provenance stays
 * meaningful instead of collapsing to "unknown".
 */
export function telegramSenderIds(
  sender: unknown,
  groupLabelName: string,
  groupMarkedId: string,
): [string, string] {
  let { id: authorId, name: authorName } = telegramEntityLabel(sender);
  if (!authorId && !authorName) {
    authorName = groupLabelName;
    authorId = groupMarkedId;
  }
  if (!authorName) authorName = authorId || "unknown";
  if (!authorId) authorId = authorName;
  return [authorId, authorName];
}

/** Reactions as `{name, count}` pairs; custom emoji fall back to their doc id. */
export function telegramReactions(message: unknown): Array<{ name: string; count: number }> {
  const results = (message as { reactions?: { results?: unknown[] } })?.reactions?.results;
  if (!Array.isArray(results)) return [];
  const out: Array<{ name: string; count: number }> = [];
  for (const entry of results) {
    const r = entry as { reaction?: { emoticon?: string; documentId?: unknown }; count?: number };
    let name = r.reaction?.emoticon ?? "";
    if (!name) {
      const docId = r.reaction?.documentId;
      name = docId ? `custom:${docId}` : "custom";
    }
    out.push({ name, count: r.count ?? 0 });
  }
  return out;
}

/**
 * Id of the message this one directly replies to, or null when top-level.
 *
 * In a forum topic every plain post technically "replies" to the topic header
 * (`replyToMsgId === topicId`); that is not a thread parent, so it maps to null.
 */
export function telegramDirectParent(message: unknown, topicId: number | null): number | null {
  const reply = (message as { replyTo?: { replyToMsgId?: number } })?.replyTo;
  const parent = reply?.replyToMsgId;
  if (parent === undefined || parent === null) return null;
  if (topicId !== null && Number(parent) === Number(topicId)) return null;
  return Number(parent);
}

/**
 * Album id for a multi-media post, or undefined when the message is standalone.
 *
 * `groupedId` arrives as a BigInteger (it exceeds 2^53), so it is stringified
 * rather than coerced to a JS number, which would silently lose precision.
 */
export function telegramGroupedId(message: unknown): string | undefined {
  const grouped = (message as { groupedId?: unknown })?.groupedId;
  if (grouped === undefined || grouped === null) return undefined;
  const asString = String(grouped);
  return asString.length > 0 ? asString : undefined;
}

/** teleproto exposes `message.date` as UNIX seconds; Atlas wants ISO-8601. */
export function telegramTimestamp(dateSeconds: unknown): string {
  const seconds = Number(dateSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return new Date().toISOString();
  return new Date(seconds * 1000).toISOString();
}

/** Structurally satisfies bridge.ts's private `PlatformBridge` interface; the
 *  compiler checks the shape at the factory call site in bridge.ts. */
export class TelegramUserBridge {
  private connectionId: string;
  private creds: TelegramUserCredentials;
  /** Cache of channel_id → display name so per-message normalization doesn't
   *  re-resolve the entity for every batch. */
  private channelNameCache = new Map<string, string>();
  /** Cache of group id → description ("about"). Fetching it costs one extra
   *  `GetFullChannel`/`GetFullChat` round-trip per group, so it is resolved
   *  once and reused across every topic of a forum. */
  private groupAboutCache = new Map<string, string>();

  constructor(connectionId: string, creds: TelegramUserCredentials) {
    this.connectionId = connectionId;
    this.creds = creds;
  }

  private client(): Promise<TelegramClient> {
    return getTelegramUserClient(this.connectionId, this.creds);
  }

  /** MTProto exposes no per-user profile lookup that is cheap enough to do
   *  per message; names already arrive on the message sender. */
  async resolveUser(userId: string): Promise<{ name: string; image: string | null }> {
    return { name: userId, image: null };
  }

  /**
   * List groups the account belongs to, expanding forum groups into one
   * channel per topic. DMs and broadcast channels are skipped — Atlas ingests
   * team conversations, and a user account's DM list is personal.
   */
  async listChannels(): Promise<NormalizedChannel[]> {
    const client = await this.client();
    const channels: NormalizedChannel[] = [];

    let scanned = 0;
    for await (const dialog of client.iterDialogs({ limit: DIALOG_SCAN_MAX })) {
      if (++scanned > DIALOG_SCAN_MAX) break;
      const entity = dialog.entity;
      if (!entity) continue;
      // Groups only: legacy `Chat` (basic group) or a `Channel` flagged
      // `megagroup` (supergroup). A `Channel` without `megagroup` is a
      // broadcast channel — not a conversation, so it is skipped.
      const isBasicGroup = entity instanceof Api.Chat;
      const isSupergroup = entity instanceof Api.Channel && entity.megagroup === true;
      if (!isBasicGroup && !isSupergroup) continue;

      const markedId = String(utils.getPeerId(entity));
      const title = (entity as { title?: string }).title || markedId;
      const isForum = isSupergroup && (entity as { forum?: boolean }).forum === true;

      // NB: the group description is deliberately NOT fetched here. It needs a
      // per-group `GetFullChannel`/`GetFullChat`, and Telegram rate-limits
      // those hard — on an account with many dialogs the listing spent minutes
      // in back-to-back FloodWaits and never returned. `getChannel` fetches it
      // for the single channel the UI actually opens; the listing only reuses a
      // value that is already cached from such a call.
      const about = this.groupAboutCache.get(markedId) || "";

      if (!isForum) {
        this.channelNameCache.set(markedId, title);
        channels.push({
          channel_id: markedId,
          name: title,
          platform: "telegram-user",
          is_member: true,
          member_count: (entity as { participantsCount?: number }).participantsCount ?? null,
          topic: about || null,
          purpose: null,
        });
        continue;
      }

      // Forum: surface each topic as its own channel and omit the group. A
      // topic is the unit of discussion, so it maps to Atlas' channel concept.
      const topics = await this.listForumTopics(client, entity);
      for (const topic of topics) {
        const channelId = buildTelegramUserChannelId(markedId, topic.id);
        const name = `${title} / ${topic.title}`;
        this.channelNameCache.set(channelId, name);
        channels.push({
          channel_id: channelId,
          name,
          platform: "telegram-user",
          is_member: true,
          member_count: (entity as { participantsCount?: number }).participantsCount ?? null,
          topic: topic.title,
          // Group context for a topic channel: title plus description when the
          // group has one, so the sidebar can explain where the topic lives.
          purpose: about ? `${title} — ${about}` : title,
        });
      }
    }

    return channels;
  }

  /**
   * Resolve a group's description ("about" in MTProto), cached per group.
   *
   * The dialog list only carries the entity, not the full record, so the
   * description needs a separate `GetFullChannel` (supergroup) or
   * `GetFullChat` (legacy group) call. Best-effort: a failure yields "" so a
   * missing description never fails channel listing.
   */
  private async resolveGroupAbout(
    client: TelegramClient,
    entity: unknown,
    groupKey: string,
  ): Promise<string> {
    const cached = this.groupAboutCache.get(groupKey);
    if (cached !== undefined) return cached;

    let about = "";
    try {
      if (entity instanceof Api.Channel) {
        const full = await client.invoke(
          new Api.channels.GetFullChannel({ channel: entity }),
        );
        about = (full.fullChat as { about?: string }).about || "";
      } else if (entity instanceof Api.Chat) {
        const full = await client.invoke(
          new Api.messages.GetFullChat({ chatId: entity.id }),
        );
        about = (full.fullChat as { about?: string }).about || "";
      }
    } catch (err) {
      console.warn(
        "TelegramUserBridge: group description lookup failed:",
        safeErrorMessage(err),
      );
    }
    this.groupAboutCache.set(groupKey, about);
    return about;
  }

  /** Enumerate every topic of a forum group, paginating on `offsetTopic`. */
  private async listForumTopics(
    client: TelegramClient,
    entity: unknown,
  ): Promise<Array<{ id: number; title: string }>> {
    const topics: Array<{ id: number; title: string }> = [];
    let offsetTopic = 0;
    let offsetId = 0;
    let offsetDate = 0;

    while (topics.length < FORUM_TOPICS_MAX) {
      let result: Api.messages.TypeForumTopics;
      try {
        result = await client.invoke(
          new Api.messages.GetForumTopics({
            peer: entity as Api.TypeEntityLike,
            offsetDate,
            offsetId,
            offsetTopic,
            limit: FORUM_TOPICS_PAGE_SIZE,
          }),
        );
      } catch (err) {
        console.warn(
          "TelegramUserBridge: GetForumTopics failed:",
          safeErrorMessage(err),
        );
        break;
      }

      const page = (result as { topics?: unknown[] }).topics ?? [];
      if (page.length === 0) break;

      let lastTopicId = offsetTopic;
      for (const raw of page) {
        // `ForumTopicDeleted` carries only an id — skip it.
        if (!(raw instanceof Api.ForumTopic)) continue;
        topics.push({ id: raw.id, title: raw.title });
        lastTopicId = raw.id;
        offsetId = raw.topMessage;
        offsetDate = raw.date;
      }

      if (page.length < FORUM_TOPICS_PAGE_SIZE) break;
      // Guard against a non-advancing cursor (mirrors the sync runner's
      // pagination stall check) so a server quirk can't spin forever.
      if (lastTopicId === offsetTopic) break;
      offsetTopic = lastTopicId;
    }

    return topics;
  }

  async getChannel(id: string): Promise<NormalizedChannel> {
    const { groupId, topicId } = parseTelegramUserChannelId(id);
    const client = await this.client();

    let groupTitle = groupId;
    let memberCount: number | null = null;
    let about = "";
    try {
      const entity = await client.getEntity(groupId);
      groupTitle = (entity as { title?: string }).title || groupId;
      memberCount = (entity as { participantsCount?: number }).participantsCount ?? null;
      about = await this.resolveGroupAbout(client, entity, groupId);
    } catch (err) {
      console.warn(
        "TelegramUserBridge: getChannel entity lookup failed:",
        safeErrorMessage(err),
      );
    }

    if (topicId === null) {
      return {
        channel_id: id,
        name: groupTitle,
        platform: "telegram-user",
        is_member: true,
        member_count: memberCount,
        topic: about || null,
        purpose: null,
      };
    }

    // Resolve the topic title so the UI shows "Group / Topic" rather than a
    // bare composite id. Falls back to the cached name, then the raw id.
    let topicTitle = "";
    try {
      const byId = await client.invoke(
        new Api.messages.GetForumTopicsByID({
          peer: groupId,
          topics: [topicId],
        }),
      );
      const first = ((byId as { topics?: unknown[] }).topics ?? [])[0];
      if (first instanceof Api.ForumTopic) topicTitle = first.title;
    } catch (err) {
      console.warn(
        "TelegramUserBridge: GetForumTopicsByID failed:",
        safeErrorMessage(err),
      );
    }

    const name = topicTitle
      ? `${groupTitle} / ${topicTitle}`
      : this.channelNameCache.get(id) || id;
    this.channelNameCache.set(id, name);
    return {
      channel_id: id,
      name,
      platform: "telegram-user",
      is_member: true,
      member_count: memberCount,
      topic: topicTitle || null,
      purpose: about ? `${groupTitle} — ${about}` : groupTitle,
    };
  }

  /**
   * Fetch history for a channel (group, or one forum topic).
   *
   * `since` maps to teleproto's `offsetDate` and `order=asc` to `reverse`, so
   * the sync runner's incremental cursor (`ChannelSyncState.last_sync_ts`)
   * advances chronologically exactly as it does for Slack's `oldest`.
   */
  async getMessages(channelId: string, opts: GetMessagesOpts): Promise<NormalizedMessage[]> {
    const { groupId, topicId } = parseTelegramUserChannelId(channelId);
    const client = await this.client();
    const entity = await client.getEntity(groupId);
    const groupMarkedId = String(utils.getPeerId(entity));
    const { name: groupLabelName } = telegramEntityLabel(entity);
    const channelName = this.channelNameCache.get(channelId)
      || (entity as { title?: string }).title
      || channelId;

    const ascending = opts.order === "asc";
    // `since` present → walk FORWARD from that timestamp (incremental sync
    // catching up). No `since` → read the NEWEST messages, matching what
    // Slack's `conversations.history` returns when `oldest` is omitted.
    //
    // This distinction matters: iterating forward from the beginning of a
    // channel would spend the whole `SYNC_MAX_MESSAGES` budget on the oldest
    // history and leave `last_sync_ts` parked years in the past, so every
    // later sync would keep crawling ancient messages instead of ingesting
    // current ones.
    const hasSince = Boolean(opts.since) && Number.isFinite(new Date(opts.since as string).getTime());
    const iterParams: Record<string, unknown> = {
      limit: opts.limit,
      // Only iterate oldest→newest when we have a starting point to walk from.
      reverse: hasSince,
    };
    // A topic channel reads only that topic's messages; `replyTo` is how
    // MTProto scopes a forum topic (same call the standalone exporter uses).
    if (topicId !== null) iterParams.replyTo = topicId;
    if (hasSince) {
      // teleproto takes seconds; `offsetDate` is exclusive, and combined with
      // `reverse` it means "newer than this".
      iterParams.offsetDate = Math.floor(new Date(opts.since as string).getTime() / 1000);
    }
    if (opts.before) {
      const beforeId = Number.parseInt(opts.before, 10);
      if (Number.isFinite(beforeId)) iterParams.maxId = beforeId;
    }

    const messages: NormalizedMessage[] = [];
    for await (const message of client.iterMessages(entity, iterParams)) {
      if (!(message instanceof Api.Message)) continue;
      messages.push(
        this.normalizeMessage(message, {
          channelId,
          channelName,
          topicId,
          groupLabelName,
          groupMarkedId,
        }),
      );
    }
    // The iteration order above is driven by `hasSince`, not by the caller's
    // requested order, so normalize at the end — same as the Slack and Discord
    // bridges, which always fetch newest-first and flip for `order=asc`.
    const iteratedAscending = hasSince;
    if (ascending !== iteratedAscending) messages.reverse();
    return messages;
  }

  /** Replies to one message, used by the UI's thread expander. */
  async getThreadMessages(channelId: string, threadId: string): Promise<NormalizedMessage[]> {
    const { groupId, topicId } = parseTelegramUserChannelId(channelId);
    const rootId = Number.parseInt(threadId, 10);
    if (!Number.isFinite(rootId)) return [];

    const client = await this.client();
    const entity = await client.getEntity(groupId);
    const groupMarkedId = String(utils.getPeerId(entity));
    const { name: groupLabelName } = telegramEntityLabel(entity);
    const channelName = this.channelNameCache.get(channelId)
      || (entity as { title?: string }).title
      || channelId;

    const messages: NormalizedMessage[] = [];
    for await (const message of client.iterMessages(entity, { replyTo: rootId, reverse: true })) {
      if (!(message instanceof Api.Message)) continue;
      // `replyTo` includes the root itself on some paths; the caller only
      // wants replies (mirrors the Slack bridge dropping the parent).
      if (message.id === rootId) continue;
      messages.push(
        this.normalizeMessage(message, {
          channelId,
          channelName,
          topicId,
          groupLabelName,
          groupMarkedId,
        }),
      );
    }
    return messages;
  }

  /**
   * Total message count for a channel (whole group, or one forum topic).
   *
   * The server reports the count alongside a history page, so a single
   * `limit: 1` request is enough — `TotalList.total` carries it. No history
   * walk, which keeps the account's rate budget intact even when the UI polls
   * sync status. Scoping by `replyTo` makes the count topic-specific.
   */
  async getMessageCount(channelId: string): Promise<number> {
    const { groupId, topicId } = parseTelegramUserChannelId(channelId);
    const client = await this.client();
    const entity = await client.getEntity(groupId);

    const params: Record<string, unknown> = { limit: 1 };
    if (topicId !== null) params.replyTo = topicId;
    const page = await client.getMessages(entity, params);
    // `total` is absent only when the server returned a non-sliced result
    // (a chat small enough to fit in one page), in which case the page length
    // IS the total.
    return page.total ?? page.length;
  }

  /**
   * Resolve a `tg.invalid` reference URL into the media's bytes.
   *
   * No HTTP fetch happens here, so the SSRF guards the other bridges apply
   * (`assertHostAllowedAndPublic`) have nothing to protect: the URL is an
   * opaque handle, and the only egress is teleproto's authenticated MTProto
   * download. The parse below is the security boundary — a URL that isn't
   * exactly `https://tg.invalid/<conn>/<channel>/<msgId>` is rejected, and the
   * embedded connection id must match THIS bridge so one connection can never
   * be used to read another's media.
   */
  async proxyFile(url: string): Promise<{ contentType: string; buffer: Buffer }> {
    const ref = parseTelegramUserFileUrl(url);
    if (!ref) {
      throw new Error("invalid Telegram user file URL");
    }
    if (ref.connectionId !== this.connectionId) {
      // The proxy route may probe sibling adapters; refuse rather than serve
      // another connection's bytes.
      throw Object.assign(
        new Error("Telegram user file URL belongs to a different connection"),
        { data: { error: "not_found" }, code: "NOT_FOUND" },
      );
    }

    const { groupId } = parseTelegramUserChannelId(ref.channelId);
    const client = await this.client();
    const entity = await client.getEntity(groupId);

    const found = await client.getMessages(entity, { ids: [ref.messageId] });
    const message = found[0];
    if (!(message instanceof Api.Message) || !message.media) {
      throw Object.assign(
        new Error(`Telegram message ${ref.messageId} has no downloadable media`),
        { data: { error: "not_found" }, code: "NOT_FOUND" },
      );
    }

    const descriptor = telegramMediaDescriptor(message);
    // Omitting `outputFile` makes teleproto buffer the download and return it,
    // which matches the `PlatformBridge.proxyFile` contract used by every
    // other platform.
    const downloaded = await client.downloadMedia(message);
    if (!downloaded || typeof downloaded === "string") {
      throw new Error(`Telegram media download returned no bytes for ${ref.messageId}`);
    }

    return {
      contentType: descriptor?.mimetype || "application/octet-stream",
      buffer: Buffer.from(downloaded),
    };
  }

  private normalizeMessage(
    message: Api.Message,
    ctx: {
      channelId: string;
      channelName: string;
      topicId: number | null;
      groupLabelName: string;
      groupMarkedId: string;
    },
  ): NormalizedMessage {
    const [authorId, authorName] = telegramSenderIds(
      message.sender,
      ctx.groupLabelName,
      ctx.groupMarkedId,
    );
    const directParent = telegramDirectParent(message, ctx.topicId);
    const media = telegramMediaDescriptor(message);
    // Album membership, when this message is part of a multi-media post. See
    // the `grouped_id` docs on NormalizedMessage for why album members stay
    // separate messages instead of being merged here.
    const groupedId = telegramGroupedId(message);

    return {
      content: message.message || "",
      author: authorId,
      author_name: authorName,
      author_image: null,
      platform: "telegram-user",
      channel_id: ctx.channelId,
      channel_name: ctx.channelName,
      message_id: String(message.id),
      timestamp: telegramTimestamp(message.date),
      thread_id: directParent !== null ? String(directParent) : null,
      // MTProto media has no HTTP URL, so the attachment carries a reference
      // URL that `proxyFile` resolves back into bytes via downloadMedia.
      attachments: media
        ? [
            {
              type: media.type,
              url: buildTelegramUserFileUrl({
                connectionId: this.connectionId,
                channelId: ctx.channelId,
                messageId: message.id,
              }),
              name: media.name,
              mimetype: media.mimetype,
            },
          ]
        : [],
      reactions: telegramReactions(message),
      // 0 by design — see the file header. Same as the Discord adapter.
      reply_count: 0,
      is_bot: (message.sender as { bot?: boolean } | null)?.bot === true,
      subtype: null,
      links: telegramLinkPreviews(message),
      // Only set for album members, so a non-album message keeps the field
      // absent rather than carrying a null through to `raw_metadata`.
      ...(groupedId ? { grouped_id: groupedId } : {}),
    };
  }
}
