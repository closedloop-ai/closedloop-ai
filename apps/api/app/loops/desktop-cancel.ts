import { log } from "@repo/observability/log";
import type { DesktopUserIntentSignature } from "@/lib/loops/compute-provider";
import { stopDesktopLoop } from "@/lib/loops/loop-desktop";

/**
 * Sends a best-effort Desktop kill command while preserving the API cancellation
 * contract: database cancellation still proceeds if Desktop is offline, unsigned
 * kill is unsupported, or signed immediate delivery fails.
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
