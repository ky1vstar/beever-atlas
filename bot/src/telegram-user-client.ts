/**
 * teleproto (MTProto) client registry for `telegram-user` connections.
 *
 * Unlike every other platform, `telegram-user` is a USER account speaking
 * MTProto, not a Chat SDK adapter wrapping a bot token. Bot API cannot read
 * group history at all (see `TelegramBridge` in bridge.ts — every history
 * method there throws NOT_SUPPORTED), so historical ingestion requires a user
 * session. This module owns the lifecycle of those clients.
 *
 * Ingest-only: these clients never register message handlers and are not part
 * of the Chat SDK `Chat` adapter set, so they cannot reply in Telegram.
 *
 * Credentials (from the connection wizard, stored encrypted in Mongo by the
 * backend and normalized to camelCase by the bridge's register handler):
 *   - `apiId`   — my.telegram.org API id
 *   - `apiHash` — my.telegram.org API hash
 *   - `session` — StringSession produced by `scripts/telegram_login.py`
 */

import { TelegramClient, sessions } from "teleproto";
import { safeErrorMessage } from "./http-utils.js";
import { logger } from "./logger.js";

const { StringSession } = sessions;

/** Auto-sleep FloodWaits up to this many seconds inside teleproto; longer
 *  waits surface as FloodWaitError so the caller can decide. Mirrors the
 *  tolerance used by the standalone exporter in `tgtest/`. */
const FLOOD_SLEEP_THRESHOLD_SECONDS = 120;

/** Connection attempts before teleproto gives up on a transient network blip. */
const CONNECTION_RETRIES = 5;

export interface TelegramUserCredentials {
  apiId: number;
  apiHash: string;
  session: string;
}

/** Per-connection client cache. Connecting costs a full MTProto handshake, so
 *  clients are reused across bridge calls and only dropped on
 *  `disconnectTelegramUserClient` (adapter unregister / recycle). */
const clientCache = new Map<string, TelegramClient>();

/** In-flight connect promises, so concurrent bridge calls for the same
 *  connection share one handshake instead of racing several. */
const connectInFlight = new Map<string, Promise<TelegramClient>>();

/**
 * Validate and coerce raw credentials. Returns null (with a warning) when a
 * required field is missing, so a half-configured connection degrades to
 * "no bridge" instead of throwing deep inside a history fetch.
 */
export function parseTelegramUserCredentials(
  config: Record<string, string> | null | undefined,
  connectionId: string,
): TelegramUserCredentials | null {
  if (!config) return null;
  const apiIdRaw = config.apiId ?? config.api_id ?? "";
  const apiHash = config.apiHash ?? config.api_hash ?? "";
  const session = config.session ?? config.sessionString ?? config.session_string ?? "";

  const apiId = Number.parseInt(String(apiIdRaw), 10);
  const missing: string[] = [];
  if (!Number.isInteger(apiId) || apiId <= 0) missing.push("apiId");
  if (!apiHash) missing.push("apiHash");
  if (!session) missing.push("session");
  if (missing.length > 0) {
    console.warn(
      `TelegramUserClient: connection ${connectionId} missing credentials: ${missing.join(", ")}`,
    );
    return null;
  }
  return { apiId, apiHash, session };
}

/**
 * Return a connected client for `connectionId`, creating it on first use.
 *
 * The session is already authorized (the wizard takes a StringSession minted
 * by `scripts/telegram_login.py`), so this never prompts for a phone/code —
 * it only performs the MTProto handshake. Throws when the session has been
 * revoked, which the bridge surfaces as a platform error so the backend can
 * mark the connection unhealthy.
 */
export async function getTelegramUserClient(
  connectionId: string,
  creds: TelegramUserCredentials,
): Promise<TelegramClient> {
  const cached = clientCache.get(connectionId);
  if (cached?.connected) return cached;

  const inFlight = connectInFlight.get(connectionId);
  if (inFlight) return inFlight;

  const connectPromise = (async () => {
    // A cached-but-disconnected client cannot be reused reliably; drop it.
    if (cached) clientCache.delete(connectionId);

    const client = new TelegramClient(
      new StringSession(creds.session),
      creds.apiId,
      creds.apiHash,
      {
        connectionRetries: CONNECTION_RETRIES,
        floodSleepThreshold: FLOOD_SLEEP_THRESHOLD_SECONDS,
        // teleproto logs at "info" by default, which is noisy in the bot's
        // shared stdout; warnings still surface.
        baseLogger: undefined,
      },
    );
    await client.connect();
    clientCache.set(connectionId, client);
    logger.debug(`TelegramUserClient: connected for connection ${connectionId}`);
    return client;
  })();

  connectInFlight.set(connectionId, connectPromise);
  try {
    return await connectPromise;
  } finally {
    connectInFlight.delete(connectionId);
  }
}

/**
 * Disconnect and forget a connection's client. Called when the adapter is
 * unregistered and on the RES-286 scheduled recycle, so a long-lived MTProto
 * socket cannot accumulate state for the process lifetime.
 */
export async function disconnectTelegramUserClient(connectionId: string): Promise<void> {
  const client = clientCache.get(connectionId);
  clientCache.delete(connectionId);
  connectInFlight.delete(connectionId);
  if (!client) return;
  try {
    await client.disconnect();
  } catch (err) {
    console.warn(
      `TelegramUserClient: disconnect failed for ${connectionId}:`,
      safeErrorMessage(err),
    );
  }
}

/** Disconnect every cached client. Used by the bridge's rebuild hook. */
export async function disconnectAllTelegramUserClients(): Promise<void> {
  const ids = [...clientCache.keys()];
  await Promise.all(ids.map((id) => disconnectTelegramUserClient(id)));
}

/** Test-only: how many clients are currently cached. */
export function telegramUserClientCacheSize(): number {
  return clientCache.size;
}
