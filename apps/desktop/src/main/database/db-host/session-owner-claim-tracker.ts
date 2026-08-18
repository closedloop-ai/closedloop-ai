/**
 * @file session-owner-claim-tracker.ts
 * @description ISS-6168: the db host's retry policy for the unowned-session
 * owner claim, extracted from `db-host-worker.ts` so it is directly testable —
 * the worker module registers `process.parentPort` listeners at import time and
 * cannot be loaded by a suite.
 *
 * The claim repairs sessions written before the identity columns were bound. It
 * has to run when an identity arrives AFTER the store opened, which is the
 * normal case rather than the exception: the child opens with a snapshot, and on
 * a cold start main's resolver answers null on its first call and only warms
 * `/me` in the background.
 *
 * The whole point of the tracker is WHICH key suppresses a repeat. Recording the
 * transition when the identity is merely SEEN makes one transient rejection
 * permanent — main re-posts the same cached identity on its own schedule, every
 * later post matches the suppression key, and the corpus stays unattributed
 * until the next restart (PR #4947 review, wongk). So the key is the last
 * SETTLED user, marked in the promise's `then`, and a failure is reported rather
 * than swallowed. A settled-but-skipped claim (nobody signed in, or a foreign
 * owner present) still counts as settled: neither outcome can change without a
 * different identity arriving, which is itself a cache miss here.
 */
import type { DbHostUserIdentity } from "./db-host-protocol.js";

export type SessionOwnerClaimTrackerDeps = {
  /**
   * Run the claim. Returns late-bound so the tracker can be constructed before
   * the store is open; a null store means "not yet", which must NOT settle the
   * identity.
   */
  claim: (
    identity: DbHostUserIdentity
  ) => Promise<{ claimed: number }> | undefined;
  /** The worker's own log channel back to main. */
  log: (message: string) => void;
};

export type SessionOwnerClaimTracker = {
  /** Handle one identity push from main. Fire-and-forget; never throws. */
  onIdentity: (identity: DbHostUserIdentity) => void;
};

export function createSessionOwnerClaimTracker(
  deps: SessionOwnerClaimTrackerDeps
): SessionOwnerClaimTracker {
  let settledUserId: string | null = null;
  return {
    onIdentity(identity: DbHostUserIdentity): void {
      const userId = identity?.userId ?? null;
      if (!userId || userId === settledUserId) {
        return;
      }
      deps
        .claim(identity)
        ?.then(({ claimed }) => {
          settledUserId = userId;
          if (claimed > 0) {
            deps.log(
              `identity: attributed ${claimed} previously unowned session(s)`
            );
          }
        })
        .catch((error: unknown) => {
          deps.log(
            `identity: unowned-session claim failed, will retry on the next identity post: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        });
    },
  };
}
