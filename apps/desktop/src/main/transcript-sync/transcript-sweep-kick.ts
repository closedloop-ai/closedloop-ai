import { gatewayLog } from "../logging/gateway-logger.js";
import type { TranscriptSyncService } from "./transcript-sync-service.js";

/**
 * FEA-3463 follow-up: when the sync-observability tier is (re)chosen — or, since
 * ISS-4623, when the org sync policy resolves and reopens the outer gate — kick
 * an immediate transcript sweep. While the gate was closed the sweep was
 * suppressed and nothing was queued, so a just-reopened lane would otherwise wait
 * up to 30 min for the next periodic sweep before any transcript is
 * discovered/uploaded.
 *
 * Safe to call unconditionally: `sweepOnce` re-checks the gate internally (a
 * cheap no-op when the new tier/policy is still closed), a null `service` means
 * the transcript lane is off entirely, and a rejected sweep is logged rather than
 * propagated so a kick can never fault its caller's tick.
 *
 * Lives here rather than inline in `app.ts` so the transcript lane owns its own
 * tier/policy-change kick (and the grandfathered `app.ts` sheds a responsibility
 * instead of carrying it).
 */
export function kickTranscriptSweepAfterTierChange(
  service: TranscriptSyncService | null
): void {
  const sweep = service?.sweepOnce();
  if (!sweep) {
    return;
  }
  sweep.catch((error: unknown) => {
    gatewayLog.warn(
      "transcript-sync",
      `sweep after tier change failed: ${String(error)}`
    );
  });
}
