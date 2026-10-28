import {
  type DisplayedSessionStatus,
  resolveDisplayedSessionStatus,
} from "@repo/api/src/types/session-status";

/**
 * ISS-5818 (#4739 review, whitlockk): the DISPLAYED status of the session whose
 * DETAIL page is open — the value the title chip badges.
 *
 * ISS-10364 (operator ruling, 2026-09-23/24) retired the Waiting/Unknown
 * projection this function used to run ahead of {@link resolveDisplayedSessionStatus}:
 * `awaitingInputSince` no longer has a display word, and an unreadable
 * `endedAt` folds through the ordinary unrecognized-value path like everything
 * else. This is now a thin, surface-independent wrapper over the shared
 * resolver, kept as its own name so the many call sites that ask specifically
 * for "the detail chip's status" do not need to know that.
 *
 * `now` stays on the signature because the shared resolver still accepts one,
 * but NO caller should feed it a ticking clock: the resolver ignores the value,
 * so a tick re-renders the detail shell for a chip that cannot change. The
 * predicate that used to gate such a clock here was deleted with the staleness
 * fold it answered for.
 */
export function resolveSessionDetailDisplayStatus(input: {
  status: string;
  awaitingInputSince?: Date | string | null;
  endedAt?: Date | string | null;
  lastActivityAt?: Date | string | null;
  startedAt?: Date | string | null;
  now?: Date;
}): DisplayedSessionStatus {
  return resolveDisplayedSessionStatus({
    lastActivityAt: input.lastActivityAt,
    now: input.now,
    startedAt: input.startedAt,
    status: input.status,
  });
}
