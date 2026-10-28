import { gatewayLog } from "../logging/gateway-logger.js";
import type { TranscriptSyncService } from "./transcript-sync-service.js";

/**
 * FEA-3463 follow-up: when the sync-observability tier is (re)chosen, kick an
 * immediate transcript sweep. The second trigger is a genuine sign-in or
 * account switch (`sync-lane-kicks.ts`); ISS-4623 had wired that through an
 * org-policy resolution, and ISS-11449 moved it onto the identity door when it
 * retired the policy. While the gate was closed the sweep was suppressed and
 * nothing was queued, so a just-reopened lane would otherwise wait up to 30 min
 * for the next periodic sweep before any transcript is discovered/uploaded.
 *
 * ISS-9884 (PLN-1986 §5): both triggers are PRECONDITION changes, so the lane's
 * give-up is re-armed BEFORE the sweep. The sweep's closing drain is what spends
 * the attempt the re-arm buys and revives the rows the give-up paused; a sweep
 * kicked first would find the lane still given up and do nothing. Kept here, and
 * not at each caller, so the identity door and the tier IPC cannot disagree
 * about that order.
 *
 * Safe to call unconditionally: `sweepOnce` re-checks the gate internally (a
 * cheap no-op when the gate is still closed), a null `service` means
 * the transcript lane is off entirely, and a rejected sweep is logged rather than
 * propagated so a kick can never fault its caller's tick.
 *
 * Lives here rather than inline in `app.ts` so the transcript lane owns its own
 * precondition-change kick (and the grandfathered `app.ts` sheds a responsibility
 * instead of carrying it).
 */
export function kickTranscriptSweepAfterTierChange(
  service: TranscriptSyncService | null
): void {
  if (!service) {
    return;
  }
  service.noteLaneRecoverySignal();
  service.sweepOnce().catch((error: unknown) => {
    gatewayLog.warn(
      "transcript-sync",
      `sweep after tier change failed: ${String(error)}`
    );
  });
}
