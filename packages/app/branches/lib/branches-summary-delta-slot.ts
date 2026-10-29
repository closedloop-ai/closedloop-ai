import type { DateRange } from "../../shared/lib/format-utils";

/**
 * Whether the approved Branches shell must reserve a prior-period delta slot
 * while its exact producer bundle is still loading.
 */
export function branchesSummaryReservesDeltaSlot(
  dateRange: DateRange
): boolean {
  return dateRange !== "all";
}
