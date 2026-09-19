"""Telegram user-session login — mints the StringSession for a `telegram-user` connection.

Usage:
    python scripts/telegram_login.py

Requires telethon: pip install telethon

Reads TELEGRAM_API_ID / TELEGRAM_API_HASH from the environment and prompts for
whatever is missing. Then walks the interactive MTProto login (phone number →
login code → 2FA password when the account has one) and prints the resulting
StringSession.

Why this exists: the `telegram-user` platform ingests group history through an
MTProto **user** session, because a Telegram bot token cannot read history at
all. Logging in is inherently interactive (Telegram sends a code out-of-band),
so it happens here — in a terminal, where the phone number and 2FA password stay
local — rather than in the connection wizard. Paste the printed session into the
wizard's "Session string" field; it is encrypted at rest like every other
credential.

The session is long-lived: Telegram keeps it valid until it is revoked (from the
account's device list, by a 2FA password change, or after a long inactivity
window). Re-run this script and update the connection's credentials if that
happens.

Security notes:
  * The session string grants full access to the account. Treat it like a
    password: never commit it, never paste it into a chat or issue tracker.
  * Nothing is written to disk — an in-memory session is used, so no `.session`
    file is left behind.
  * The 2FA password is read with `getpass`, so it is not echoed and does not
    land in shell history.
"""
from __future__ import annotations

import asyncio
import os
import sys
from getpass import getpass


"""Attempts allowed for the login code and the 2FA password.

Bounded rather than unlimited: Telegram counts failed sign-ins against the
account, and an unbounded loop in a non-interactive shell (piped stdin at EOF)
would spin forever.
"""
_MAX_ATTEMPTS = 3


def _prompt(label: str, *, secret: bool = False) -> str:
    """Prompt on stderr so stdout carries only the session string.

    Exits on EOF (closed / piped-empty stdin) instead of raising, so a retry
    loop cannot spin on an input stream that will never yield anything.
    """
    print(label, end="", file=sys.stderr, flush=True)
    try:
        value = getpass("") if secret else input()
    except EOFError:
        print("\nERROR: no input available (stdin closed).", file=sys.stderr)
        sys.exit(1)
    return value.strip()


def _resolve_api_credentials() -> tuple[int, str]:
    """Return (api_id, api_hash) from the environment, prompting for gaps."""
    api_id_raw = os.environ.get("TELEGRAM_API_ID", "").strip()
    api_hash = os.environ.get("TELEGRAM_API_HASH", "").strip()

    if not api_id_raw:
        api_id_raw = _prompt("API id (from https://my.telegram.org): ")
    if not api_hash:
        api_hash = _prompt("API hash: ")

    try:
        api_id = int(api_id_raw)
    except ValueError:
        print(f"ERROR: API id must be an integer, got {api_id_raw!r}", file=sys.stderr)
        sys.exit(1)
    if api_id <= 0 or not api_hash:
        print("ERROR: both API id and API hash are required.", file=sys.stderr)
        sys.exit(1)
    return api_id, api_hash


async def _login(api_id: int, api_hash: str) -> str:
    from telethon import TelegramClient
    from telethon.errors import (
        PhoneCodeExpiredError,
        PhoneCodeInvalidError,
        SessionPasswordNeededError,
    )
    from telethon.sessions import StringSession

    # StringSession("") keeps everything in memory: no `.session` file to clean
    # up, and the only artefact is the string we print.
    client = TelegramClient(StringSession(), api_id, api_hash)
    await client.connect()
    try:
        phone = _prompt("Phone number (international format, e.g. +421...): ")
        await client.send_code_request(phone)

        # Retry the code and the 2FA password separately: a typo in either is
        # the common case, and a single wrong keystroke should not force a
        # restart (which would also burn another Telegram code request and
        # count against the account's rate limit).
        needs_password = False
        for attempt in range(1, _MAX_ATTEMPTS + 1):
            code = _prompt("Login code Telegram just sent you: ")
            try:
                await client.sign_in(phone=phone, code=code)
                break
            except SessionPasswordNeededError:
                needs_password = True
                break
            except PhoneCodeExpiredError:
                # A fresh code is required; asking again for the old one is
                # pointless, so request a new one and keep going.
                print("Code expired — requesting a new one.", file=sys.stderr)
                await client.send_code_request(phone)
            except PhoneCodeInvalidError:
                if attempt == _MAX_ATTEMPTS:
                    raise
                print(
                    f"Invalid code ({attempt}/{_MAX_ATTEMPTS}). Try again.",
                    file=sys.stderr,
                )

        if needs_password:
            # Account has two-step verification enabled.
            for attempt in range(1, _MAX_ATTEMPTS + 1):
                password = _prompt("2FA password (not echoed): ", secret=True)
                try:
                    await client.sign_in(password=password)
                    break
                except Exception as exc:  # noqa: BLE001 — message is the platform's
                    # Telethon raises a generic error for a bad password, so it
                    # cannot be matched on type; retry on anything here and let
                    # the final attempt surface the real message.
                    if attempt == _MAX_ATTEMPTS:
                        raise
                    print(
                        f"{exc} ({attempt}/{_MAX_ATTEMPTS}). Try again.",
                        file=sys.stderr,
                    )

        me = await client.get_me()
        display = getattr(me, "username", None) or getattr(me, "first_name", None) or "account"
        print(f"\nLogged in as {display}.", file=sys.stderr)
        return StringSession.save(client.session)
    finally:
        await client.disconnect()


def main() -> None:
    try:
        import telethon  # noqa: F401
    except ImportError:
        print("ERROR: telethon not installed. Run: pip install telethon", file=sys.stderr)
        sys.exit(1)

    api_id, api_hash = _resolve_api_credentials()

    try:
        session = asyncio.run(_login(api_id, api_hash))
    except KeyboardInterrupt:
        print("\nAborted.", file=sys.stderr)
        sys.exit(130)
    except Exception as exc:  # noqa: BLE001 — surface the platform's own message
        print(f"ERROR: login failed: {exc}", file=sys.stderr)
        sys.exit(1)

    print(
        "\nSession string below — paste it into the connection wizard.\n"
        "Keep it secret; it grants full access to the account.\n",
        file=sys.stderr,
    )
    # stdout carries ONLY the session, so `... > session.txt` captures it cleanly.
    print(session)


if __name__ == "__main__":
    main()
