/**
 * @file sync-lane-kicks.ts
 * @description The `AuthSessionLaneKicks` implementation bound to the desktop
 * app's live lanes: which lane each recovery seam kicks, and which of them first
 * re-arms a lane that gave up on its 24h ceiling.
 *
 * A collaborator `app.ts` constructs and hands off, not wiring inline in that
 * file — it is over the 1,000-line ceiling and grandfathered, so new lane wiring
 * lands here instead (the same reason `transcript-sweep-kick.ts` exists). The
 * identity diff that decides WHEN these fire stays in
 * `auth-session-lane-recovery.ts`, which owns the contract.
 */

import { kickTranscriptSweepAfterTierChange } from "../transcript-sync/transcript-sweep-kick.js";
import type { TranscriptSyncService } from "../transcript-sync/transcript-sync-service.js";
import type { AuthSessionLaneKicks } from "./auth-session-lane-recovery.js";

/**
 * The lanes, as the narrow views these kicks actually use — so a caller hands
 * over the services structurally and a test hands over plain objects.
 */
export type SyncLaneKickTargets = {
  agentSessionSync: {
    noteLaneRecoverySignal: () => void;
    noteCredentialsRefreshed: () => void;
  };
  /**
   * Resolved per call, not captured: the transcript lane is CONSTRUCTED on a
   * tier change (`reconcileTranscriptSyncLane`), so a reference taken at wiring
   * time would kick a lane the app has since replaced — or nothing at all.
   */
  getTranscriptSync: () => TranscriptSyncService | null;
};

export function createAuthSessionLaneKicks(
  targets: SyncLaneKickTargets
): AuthSessionLaneKicks {
  return {
    // ISS-9418: the sign-in / identity-change recovery door. Fired by
    // `onAuthSessionChange` behind its identity diff, because that callback
    // also runs on every routine same-account token refresh.
    noteLaneRecoverySignal: () => {
      targets.agentSessionSync.noteLaneRecoverySignal();
      // ISS-9884 (PLN-1986 §5): the transcript lane gives up on the same 24h
      // ceiling, and the credentials it gave up under may be what changed. It is
      // re-armed and then swept: a sign-in is when a startup sweep that found no
      // consented org gets its first chance, and the org-policy resolution that
      // used to kick that sweep is gone with the policy (ISS-11449).
      kickTranscriptSweepAfterTierChange(targets.getTranscriptSync());
    },
    // ISS-8610: the OTHER side of that same diff — a routine same-account token
    // renewal, which is the ordinary event that fixes a 401 and the only thing
    // the session lane's environmental pacing may be ended by this often.
    noteCredentialsRefreshed: () =>
      targets.agentSessionSync.noteCredentialsRefreshed(),
  };
}
