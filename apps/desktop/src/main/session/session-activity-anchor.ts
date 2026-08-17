/**
 * ISS-6270 (wongk, #5111): the ONE timestamp projection behind a Local Sessions
 * row — the activity instant `mapListItem` actually SERVES, and therefore the
 * only anchor a main-process consumer may fold a displayed status against.
 *
 * It exists because the producer and the mirror had two projections that agreed
 * only by coincidence. `mapListItem` served
 * `parseSessionDate(lastActivityAt ?? startedAt)`, whose NaN→epoch(0) fallback
 * means a MALFORMED `lastActivityAt` reaches the renderer as `1970-01-01` and
 * folds to Stale (blank Duration cell). The main-process mirror passed the RAW
 * strings to `resolveDisplayedSessionStatus`, which resolves the first PARSEABLE
 * of the two and so skipped the malformed value entirely, landing on a recent
 * `startedAt`, reading `active`, and keying Duration on a span that grows against
 * the clock. One row, a blank cell, and a growing sort key — the exact
 * cell-disagrees-with-sort defect ISS-6270 exists to close, one field over from
 * where it was first found.
 *
 * The epoch-floored reading it composes over lives in `session-instant.ts`
 * (ISS-6455), which is the one home for "how this producer reads a stored
 * timestamp string". This module owns only WHICH instant a row is judged from,
 * not how a string becomes one.
 */

import type { SyncedAgentSession } from "../agent-sync/agent-session-sync-contract.js";
import { parseSessionDate } from "./session-instant.js";

/**
 * The activity instant a Local list row is SERVED with — `lastActivityAt`
 * floored at the start time for event-less sessions (PLN-1034), parsed through
 * {@link parseSessionDate}.
 *
 * Read by `mapListItem` (the producer) and by
 * `resolveDisplayedSharedSessionStatus` (the main-process mirror of what the
 * renderer then displays), so the two cannot disagree about which instant a row
 * is judged silent from. A second copy of this expression is how a consumer ends
 * up folding a status against a timestamp the renderer never saw.
 */
export function servedSessionActivityAt(
  session: Pick<SyncedAgentSession, "lastActivityAt" | "startedAt">
): Date {
  return parseSessionDate(session.lastActivityAt ?? session.startedAt);
}
