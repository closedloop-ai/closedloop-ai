import "server-only";

import type { BranchLeadTimeActivity } from "@repo/api/src/types/branch";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import type { DeliveryPointWindow } from "@/lib/delivery-points/delivery-point-attribution";
import { penseroDeliveryWindow } from "@/lib/delivery-points/delivery-point-window";
import { earliestTimestamp, latestTimestamp } from "@/lib/iso-timestamp-bounds";
import { hasFailedPenseroBackfillDay } from "../cron/backfill-pensero-delivery/ledger";
import type {
  BranchPenseroAttributedPoints,
  BranchPenseroNumerator,
} from "./branch-pensero-numerator";

/**
 * ISS-10653, Perrin Upcott's ruling 2026-09-29 ("Narrow to the branch's
 * window"): the failed-day probe asks only about days inside this branch's own
 * activity window, the `leadTime` span the detail payload already carries.
 * Neither end measured is the org-wide probe (today's behaviour).
 *
 * Sequential, and asked only once a numerator exists: running it alongside the
 * delivery read spent a query on every branch with no numerator and put the
 * DISCLOSURE's input in the NUMBER's failure domain.
 */
export async function withBranchFailedAcquisitionDay(
  numerator: BranchPenseroAttributedPoints | null | undefined,
  organizationId: string,
  activity: BranchLeadTimeActivity
): Promise<BranchPenseroNumerator | null> {
  if (!numerator) {
    return null;
  }
  return {
    ...numerator,
    hasFailedAcquisitionDay: await failedAcquisitionDay(
      organizationId,
      activityWindow(activity)
    ),
  };
}

/**
 * Either end may be unmeasured, which leaves that side open. Cloud's two ends
 * come off two evidence lanes and can arrive reversed (ISS-8821); the window
 * still spans both measured instants.
 */
function activityWindow({
  firstActivityT,
  lastActivityT,
}: BranchLeadTimeActivity): DeliveryPointWindow | undefined {
  if (firstActivityT === null || lastActivityT === null) {
    return penseroDeliveryWindow({
      startDate: firstActivityT,
      endDate: lastActivityT,
    });
  }
  return penseroDeliveryWindow({
    startDate: earliestTimestamp(firstActivityT, lastActivityT),
    endDate: latestTimestamp(firstActivityT, lastActivityT),
  });
}

/**
 * The disclosure's input, and never the ratio's.
 *
 * A failure here must not cost the reader the number (root `AGENTS.md`, "Never
 * Delete a Capability You Cannot Compute"), so it degrades to the shortfall
 * every Pensero result carries anyway — history the backward walk has not
 * reached — rather than joining the throw that drops the metric to LOC/$.
 */
export async function failedAcquisitionDay(
  organizationId: string,
  window?: DeliveryPointWindow
): Promise<boolean> {
  try {
    return await hasFailedPenseroBackfillDay(organizationId, window);
  } catch (error) {
    log.warn("pensero_failed_backfill_day_probe_failed", {
      organizationId,
      error: parseError(error),
    });
    return false;
  }
}
