"use client";

import type { AuthTokenOptions } from "../auth/auth-adapter";

/**
 * Coalesced token refresh for the shared API client (ISS-9701).
 *
 * When a session token ages out, every mounted query fails at once — a page can
 * have a dozen reads in flight. If each one asked the auth SDK for a fresh token
 * independently, one expiry would become a dozen simultaneous token mints
 * against the identity provider. This module collapses that burst: concurrent
 * callers share ONE in-flight refresh, so a storm of 401s costs a single
 * refresh, while each individual request still gets exactly one retry.
 *
 * The single flight is keyed on the `getToken` function itself rather than held
 * in one module-level slot. Two auth sources can be mounted at once (the shared
 * client is used by the web shell and by the desktop renderer, and tests mount
 * several adapters in one process), and coalescing across them would hand one
 * source's token to the other. A `WeakMap` also keeps nothing alive: when an
 * adapter is unmounted its entry is collectible.
 *
 * A refresh that REJECTS resolves to `null` rather than propagating. The caller
 * is already handling a failed request; a token source that cannot answer (an
 * offline browser, a provider outage) means we have no fresher credential to
 * retry with, which is exactly what `null` says. The original 401 is what the
 * caller then surfaces — the refresh never invents a second failure to report.
 *
 * In-flight sharing alone is NOT enough, because 401s from one expiry do not
 * arrive together. Requests A and B both leave carrying the same aged token T1;
 * A is rejected first, refreshes to T2, and retries successfully — and only THEN
 * does B's 401 land. By that point the shared flight has settled and been
 * cleaned up, so B would mint a second token for the very expiry A already
 * recovered from. That is a refresh per late 401, which under a page's worth of
 * in-flight reads is a burst of real token mints against the identity provider
 * — the storm this module exists to prevent, arriving a few milliseconds later
 * than the case it caught.
 *
 * So the recovery is remembered AGAINST THE TOKEN THAT WAS REJECTED, not merely
 * for the instant it takes to settle. A late 401 that carried T1 is answered
 * with the T2 that T1's refresh already produced; nothing is minted and the
 * caller retries with a credential known to be newer than the one the server
 * refused. Identity, not elapsed time, is what bounds the reuse: when T2 itself
 * ages out the rejected token is T2, which does not match the remembered T1, so
 * that genuinely later expiry refreshes as it should. No clock is involved and
 * no window can be mistuned.
 *
 * The record is kept only when the refresh returned a token DIFFERENT from the
 * rejected one. A shell whose `getToken` is not the real credential — the
 * desktop renderer resolves an opaque sentinel while the main process holds the
 * genuine token — hands back that same constant string forever, and remembering
 * it would answer every future 401 with the same already-rejected value and
 * suppress the refresh for good. "Nothing newer to offer" is the one answer this
 * memory must never give.
 */

type GetToken = (options?: AuthTokenOptions) => Promise<string | null>;

/** The token a completed refresh replaced, and the newer one it produced. */
type CompletedRefresh = {
  rejected: string;
  fresh: string;
};

const inFlightRefreshes = new WeakMap<GetToken, Promise<string | null>>();
const completedRefreshes = new WeakMap<GetToken, CompletedRefresh>();

/**
 * A token newer than `rejectedToken`, or `null` when none can be obtained.
 *
 * `rejectedToken` is the bearer the server just answered 401 to — the identity
 * this recovery is scoped to. Concurrent calls share one underlying refresh, and
 * a late 401 carrying an already-recovered token reuses that recovery instead of
 * minting again.
 */
export function refreshAuthToken(
  getToken: GetToken,
  rejectedToken: string | null
): Promise<string | null> {
  const completed = completedRefreshes.get(getToken);
  if (rejectedToken !== null && completed?.rejected === rejectedToken) {
    return Promise.resolve(completed.fresh);
  }

  const inFlight = inFlightRefreshes.get(getToken);
  if (inFlight) {
    return inFlight;
  }

  // The stored promise must be the SETTLED-and-cleaned one, not the raw call:
  // a caller that arrives while the cleanup is pending has to receive the same
  // result, and the entry has to be gone by the time a LATER expiry asks for a
  // genuinely new token. The record is written in `then`, which runs before the
  // `finally` clears the flight, so no caller can fall between the two and find
  // neither.
  const refresh = getToken({ forceRefresh: true })
    .catch(() => null)
    .then((fresh) => {
      if (rejectedToken !== null && fresh !== null && fresh !== rejectedToken) {
        completedRefreshes.set(getToken, { rejected: rejectedToken, fresh });
      }
      return fresh;
    })
    .finally(() => {
      inFlightRefreshes.delete(getToken);
    });
  inFlightRefreshes.set(getToken, refresh);
  return refresh;
}
