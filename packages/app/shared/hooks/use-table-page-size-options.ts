"use client";

import {
  resolveLegalTablePageSize,
  TABLE_PAGE_SIZE_OPTIONS,
  TABLE_PAGE_SIZE_OPTIONS_EXTENDED,
} from "@repo/design-system/components/ui/table-page-size-select";
import { useMemo } from "react";
import { useFeatureFlagGateOptional } from "../feature-flags/use-feature-flag-enabled";
import { TABLE_PAGE_SIZE_LADDER_FEATURE_FLAG_KEY } from "../lib/feature-flags";

/**
 * ISS-9692: the rows-per-page ladder this viewer is offered, and the page size
 * they may actually be shown.
 *
 * ONE read site for the `table-page-size-ladder` flag, for the reason ISS-9216
 * gave when it moved the ladder itself into a single component: Sessions and
 * Branches each asking the question separately is how two surfaces come to offer
 * different choices for the same control. `useFeatureFlagEnabledOptional`
 * (rather than the throwing variant) because these surfaces also mount in
 * Storybook and in tests with no flag provider, where the closed default is the
 * right answer.
 *
 * `pageSize` is the caller's stored/requested size RESOLVED against the ladder
 * in force. That is what keeps a persisted 500 from being sent as a `limit` the
 * moment the flag goes back off — the reader lands on 100, the largest rung the
 * surface can still serve, rather than on a 400 or on a silent reset to 25.
 *
 * ISS-9692 (whitlockk review): an UNRESOLVED flag is not a flag that answered
 * `false`, and this value keys the Sessions and Branches list reads. Reading the
 * bare `useFeatureFlagEnabledOptional` made an enabled viewer with 500 stored
 * fetch a 100-row page and then refetch at 500 — the FEA-1626 double read, with
 * the reader watching the wrong page in between. `isReady` is the distinction,
 * and a caller whose read depends on the size must AND it into that read's
 * `enabled`. `useFeatureFlagGateOptional` carries the
 * {@link FEATURE_FLAG_RESOLUTION_DEADLINE_MS} deadline, so a flag service that
 * never answers degrades to the closed ladder rather than to a list that never
 * loads.
 */
export function useTablePageSizeOptions(requestedPageSize: number): {
  options: readonly number[];
  pageSize: number;
  /**
   * Whether the extended ladder is in force for this viewer. Exposed so a
   * surface that must withhold the CONTROL itself while the gate is closed —
   * desktop Sessions, which has never rendered one — reads the same answer this
   * hook already resolved instead of asking a second time.
   */
  isExtendedLadderEnabled: boolean;
  /**
   * Whether the flag has RESOLVED (or its deadline has passed), so `pageSize`
   * is the size this viewer should actually be read at. False only during the
   * initial resolution window. Gate a page-size-keyed read on it; ignore it in a
   * surface that merely renders the ladder, which is correct either way because
   * the closed ladder is a subset of the open one.
   */
  isReady: boolean;
} {
  const { enabled: extendedLadderEnabled, isReady } =
    useFeatureFlagGateOptional(TABLE_PAGE_SIZE_LADDER_FEATURE_FLAG_KEY);
  const options = extendedLadderEnabled
    ? TABLE_PAGE_SIZE_OPTIONS_EXTENDED
    : TABLE_PAGE_SIZE_OPTIONS;
  const pageSize = useMemo(
    () => resolveLegalTablePageSize(requestedPageSize, options),
    [requestedPageSize, options]
  );
  return {
    isExtendedLadderEnabled: extendedLadderEnabled,
    isReady,
    options,
    pageSize,
  };
}
