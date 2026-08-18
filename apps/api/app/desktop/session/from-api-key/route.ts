import "server-only";

import { desktopContractError } from "@/app/desktop/contract";

/**
 * Compatibility tombstone for the removed non-interactive API-key →
 * desktop-session mint (PRD-532 M6 "silent migrate").
 *
 * The mint let a Desktop install trade its `DESKTOP_MANAGED` `sk_live_*` key for
 * a first-party session with no user involvement. Desktop ran it on every
 * signed-out transition, so it re-authenticated users who had just signed out —
 * and again on every relaunch — because "no session right now" is not the same
 * as "never had a session". Signing in is now always an explicit user action;
 * existing users are offered the one-time "Sign in with GitHub to sync" prompt
 * instead.
 *
 * Already-installed Desktop builds still call this until they age out. Answering
 * 410 (rather than deleting the route) gives them a non-retryable signal, and
 * their client maps any non-2xx to `unresolved` — no session is minted and the
 * prompt path takes over. The response keeps the desktop `{ code, retryable }`
 * envelope those clients parse. No credential is read: the handler returns
 * before touching the Authorization header or PoP material.
 */

export const DesktopSessionFromApiKeyRemoval = {
  Code: "DESKTOP_SESSION_FROM_API_KEY_REMOVED",
  /** Non-retryable: no amount of retrying will bring the mint back. */
  Retryable: false,
} as const;

export function POST() {
  return desktopContractError(
    410,
    DesktopSessionFromApiKeyRemoval.Code,
    DesktopSessionFromApiKeyRemoval.Retryable
  );
}
