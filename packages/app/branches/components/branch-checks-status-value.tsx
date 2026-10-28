"use client";

import type { ChecksStatus } from "@repo/api/src/types/branch-checks";
import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table";
import { ToneLabel } from "@repo/design-system/components/ui/tone-label";
import {
  CHECKS_STATUS_LABEL,
  CHECKS_STATUS_VARIANT,
} from "../lib/checks-status-display";

/** The rollup scalars a Branches row and the Branch detail both carry. */
export type BranchChecksRollup = {
  checksPassed: number | null;
  checksStatus: ChecksStatus | null;
  checksTotal: number | null;
};

/**
 * Whether the rollup counted anything: both halves, or no count at all. A
 * present total beside a null passed count is never `0/N passing` (FEA-4066).
 */
export function hasBranchChecksCount(
  rollup: BranchChecksRollup
): rollup is BranchChecksRollup & {
  checksPassed: number;
  checksTotal: number;
} {
  return rollup.checksPassed != null && rollup.checksTotal != null;
}

export function hasBranchChecksStatusValue(
  rollup: BranchChecksRollup
): boolean {
  return rollup.checksStatus != null || hasBranchChecksCount(rollup);
}

/**
 * The CI-check rollup as one value (PLN-2169 M4), shared by the Branches
 * grid's Checks cell and the Branch Details "Checks status" row. A reported
 * `Unknown` keeps its own word, because it is a measured answer, not an
 * absence (`checks-status-display.ts`).
 */
export function BranchChecksStatusValue(rollup: BranchChecksRollup) {
  const { checksStatus } = rollup;
  const variant = checksStatus
    ? CHECKS_STATUS_VARIANT[checksStatus]
    : "default";
  if (hasBranchChecksCount(rollup)) {
    return (
      <ToneLabel className="tabular-nums" variant={variant}>
        {rollup.checksPassed}/{rollup.checksTotal} passing
      </ToneLabel>
    );
  }
  if (checksStatus == null) {
    return <GridEmptyValue />;
  }
  return (
    <ToneLabel variant={variant}>{CHECKS_STATUS_LABEL[checksStatus]}</ToneLabel>
  );
}
