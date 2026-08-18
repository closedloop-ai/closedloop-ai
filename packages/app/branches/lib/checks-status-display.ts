// Display vocabulary for a branch's CI-check rollup (`ChecksStatus`).
//
// Lightweight by design: the enum plus a type, no parsers or validators, so the
// broad `"use client"` surfaces that render checks can import these constants
// without dragging a heavier module into their bundle.
//
// Two surfaces read them. `renderBranchChecks` (branches-table.tsx) tones the
// `passed/total` tally, and `BranchPrStatusPanel` renders the rollup on its own
// when that tally is unavailable. Keeping the maps here stops the tone and the
// label from drifting between the list and the detail view.

import { ChecksStatus } from "@repo/api/src/types/branch-checks";
import type { ToneLabelVariant } from "@repo/design-system/components/ui/tone-label";

// FEA-4066: the CI-check rollup takes its color from the SAME `Badge`/`Chip`
// variant vocabulary the Status column uses (SSOT), so a failing build reads as
// destructive and a green one as success instead of the same neutral gray.
// Unknown/absent status falls through to the neutral `default` tone.
export const CHECKS_STATUS_VARIANT: Record<ChecksStatus, ToneLabelVariant> = {
  [ChecksStatus.Passing]: "success",
  [ChecksStatus.Failing]: "destructive",
  [ChecksStatus.Pending]: "warning",
  [ChecksStatus.Unknown]: "default",
};

/**
 * User-facing label for a rollup rendered WITHOUT a tally.
 *
 * `Unknown` is deliberately absent: it means the rollup itself has not synced,
 * which is the "nothing to say" case rather than a state worth naming on screen.
 * `describeChecksRollup` returns null for it so callers fall back to their own
 * not-yet-synced copy instead of printing the word "Unknown" at a user.
 */
const CHECKS_STATUS_LABEL: Record<
  Exclude<ChecksStatus, typeof ChecksStatus.Unknown>,
  string
> = {
  [ChecksStatus.Passing]: "Passing",
  [ChecksStatus.Failing]: "Failing",
  [ChecksStatus.Pending]: "Running",
};

export type ChecksRollupDisplay = {
  label: string;
  variant: ToneLabelVariant;
};

/**
 * The rollup as a labelled, toned value, or null when there is nothing to say.
 *
 * Null covers both a missing status and `Unknown` — the two cases where the
 * producer has not recorded a check state, and where naming one would assert
 * more than the record holds.
 */
export function describeChecksRollup(
  status: ChecksStatus | null | undefined
): ChecksRollupDisplay | null {
  if (status == null || status === ChecksStatus.Unknown) {
    return null;
  }
  return {
    label: CHECKS_STATUS_LABEL[status],
    variant: CHECKS_STATUS_VARIANT[status],
  };
}
