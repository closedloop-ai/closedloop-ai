import { log } from "@repo/observability/log";
import type { DesktopUserIntentSignature } from "@/lib/loops/compute-provider";
import { stopDesktopLoop } from "@/lib/loops/loop-desktop";

/**
 * Serverless ceiling the cancel routes must declare.
 *
 * ISS-6046 made the kill replay a not-delivered answer, so a cancel against an
 * unreachable desktop now spends up to ~15s in dispatch before the database
 * cancellation that follows it. On the platform default the function would be
 * terminated inside that window, leaving the loop RUNNING with no `cancelled`
 * event and an opaque 504 in place of the route's own answer -- strictly worse
 * than the unchecked kill this replaced. Same reasoning, and same 60s, as
 * `LAUNCH_REQUEST_BUDGET_SECONDS` on the launch route (ISS-5708); it also
 * matches the client's default deadline, so the two stay in step.
 *
 * Next.js route-segment config must be statically analysable, so each route
 * writes the literal and `cancel-route-max-duration.test.ts` pins it here.
 */
export const CANCEL_REQUEST_BUDGET_SECONDS = 60;

/**
 * Sends a best-effort Desktop kill command while preserving the API cancellation
 * contract: database cancellation still proceeds if Desktop is offline, unsigned
 * kill is unsupported, or delivery fails after its replays are spent.
 */
export async function stopDesktopLoopBestEffort(input: {
  loopId: string;
  computeTargetId: string;
  desktopUserIntentSignature?: DesktopUserIntentSignature;
}): Promise<void> {
  try {
    await stopDesktopLoop(
      input.loopId,
      input.computeTargetId,
      input.desktopUserIntentSignature
    );
  } catch (stopError) {
    log.warn("Failed to stop Desktop loop before DB cancellation", {
      loopId: input.loopId,
      computeTargetId: input.computeTargetId,
      stopError,
    });
  }
}
