/**
 * @file session-projection-replaceability.ts
 * @description ISS-8741: the one precondition `rebuildSessionFromParse` applies
 * to a candidate BEFORE it opens the replacement transaction.
 *
 * It is a module of its own because two callers must agree on it and neither can
 * import the other. The facade uses it as the guard it always had. The promotion
 * gate uses it to decide that a candidate is unbuildable rather than promotable
 * — without it the gate claims, promotes, and gets back a resolved
 * `{ rebuilt: false }` from a replacement that never opened a transaction, which
 * is indistinguishable at that layer from an interrupted one and leaves the
 * in-flight marker standing on a session where nothing was ever in flight
 * (whitlockk, PR #6507).
 *
 * NOT a second required-field list. It restates nothing the derived-record
 * schema decides; `startedAt` is nullable there and stays nullable, because a
 * session with no start is a well-formed record that this particular WRITE
 * cannot act on. Validity and replaceability are different questions and this
 * file answers only the second one.
 */

import type { NormalizedSession } from "../collectors/types.js";

/**
 * True when `rebuildSessionFromParse` will actually attempt a replacement for
 * this candidate. `started_at` is NOT NULL on `sessions` and the session id is
 * its primary key, so a candidate missing either can only be declined.
 */
export function canReplaceSessionProjection(
  session: Pick<NormalizedSession, "sessionId" | "startedAt">
): boolean {
  return Boolean(session.sessionId && session.startedAt);
}
