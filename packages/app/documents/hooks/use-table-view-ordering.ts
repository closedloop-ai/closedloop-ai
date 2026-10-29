"use client";

import { ArtifactSectionOrdering } from "@repo/api/src/types/artifact-group-by-mode";
import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag";
import {
  SERVED_SESSION_STATUS_ROW_OPTIONS,
  STORED_SESSION_STATUS_ROW_OPTIONS,
} from "@repo/app/documents/lib/row-artifact-status";
import {
  DEFAULT_TABLE_VIEW_ORDERING,
  retainedStatusTableViewOrdering,
  rootFirstTableViewOrdering,
  type TableViewOrdering,
} from "@repo/app/documents/lib/table-view-pipeline";
import { useFeatureFlagGateOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import {
  ARTIFACT_STATUS_ROOT_ORDER_FEATURE_FLAG_KEY,
  ARTIFACT_TABLE_DISPLAYED_SESSION_STATUS_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";

/**
 * ISS-9437 — the resolved sort/section order a Documents table renders and pages
 * with.
 *
 * ONE owner for a decision two call sites make: `DocumentsView` orders the rows
 * and `useTableViewPagination` slices membership, and if those two ever answered
 * differently a section would repeat or vanish across a page boundary. They used
 * to hold byte-identical copies of this body, each docstring pointing at the
 * other — which is the thing that must never drift living in two files
 * (marisolashgrove review on #6928). Every consumer still calls this hook ITSELF, so
 * the keys are read at each site and no boolean travels
 * (`no-threaded-feature-flag`).
 *
 * Two independent keys, each picking between two whole shapes:
 *
 * - ISS-8694 decides which session display status a row speaks. Its only other
 *   production read is the per-row leaf cell (`cells/name-cell.tsx`), which is
 *   rendered DOWNSTREAM of sorting — so the fold cannot resolve a served `stale`
 *   unconditionally without making a row sort in a band its own badge denies
 *   while that key is OFF.
 * - ISS-9437 decides root-first ordering, and takes the ISS-8694 shape as its
 *   input, so one row is folded exactly once per surface.
 *
 * `…Optional` because these consumers also mount under sites with no
 * `FeatureFlagAdapterProvider` (Storybook, mini-table tests), where the plain hook
 * throws. The GATE form because a value acted on before resolution would order
 * the page in one shape and re-order it when the flag lands; the gate's latch is
 * also what keeps a resolved flag going unresolved again from re-sorting a
 * settled table.
 *
 * ISS-10472 — `named` OVERRIDES the two ordering keys when the SERVER already
 * decided. A server-sectioned read NAMES the ordering it packed the page with
 * (operator ruling 2026-10-20), and the browser re-deciding it from its own
 * gates disagrees in real cases: a PostHog failure on the server falls back to
 * vocabulary while the browser has root-first latched, and an unresolved gate
 * uses the default while the server may not. When they disagree a status
 * section is keyed on the COERCED value by one side and the RAW value by the
 * other, so a header's total misses its key and sections render in an order the
 * page was not packed in. Not a threaded flag: it is a value off the response.
 *
 * The per-row session-status options are NOT part of that decision — ISS-8694
 * is an independent key the row's own badge reads — so they stay resolved here
 * either way.
 */
export function useTableViewOrdering(
  named?: ArtifactSectionOrdering
): TableViewOrdering {
  const servedSessionStatus = useFeatureFlagGateOptional(
    ARTIFACT_TABLE_DISPLAYED_SESSION_STATUS_FEATURE_FLAG_KEY
  );
  const rootOrder = useFeatureFlagGateOptional(
    ARTIFACT_STATUS_ROOT_ORDER_FEATURE_FLAG_KEY
  );
  const universalStatus = useFeatureFlagGateOptional(
    UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY
  );
  const rowOptions =
    servedSessionStatus.isReady && servedSessionStatus.enabled
      ? SERVED_SESSION_STATUS_ROW_OPTIONS
      : STORED_SESSION_STATUS_ROW_OPTIONS;
  if (named !== undefined) {
    return namedTableViewOrdering(named, rowOptions);
  }
  if (rootOrder.isReady && rootOrder.enabled) {
    return rootFirstTableViewOrdering(rowOptions);
  }
  if (universalStatus.isReady && universalStatus.enabled) {
    return retainedStatusTableViewOrdering(rowOptions);
  }
  return DEFAULT_TABLE_VIEW_ORDERING;
}

/** The three orderings, selected by the name the server put on the response. */
function namedTableViewOrdering(
  named: ArtifactSectionOrdering,
  rowOptions: Parameters<typeof rootFirstTableViewOrdering>[0]
): TableViewOrdering {
  if (named === ArtifactSectionOrdering.RootFirst) {
    return rootFirstTableViewOrdering(rowOptions);
  }
  if (named === ArtifactSectionOrdering.Retained) {
    return retainedStatusTableViewOrdering(rowOptions);
  }
  return DEFAULT_TABLE_VIEW_ORDERING;
}
