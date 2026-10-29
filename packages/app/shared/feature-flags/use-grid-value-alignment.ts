"use client";

import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { GRID_TABLE_V2_NUMBER_CELL_ALIGN_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";

/**
 * ISS-9821 — whether a `GridTableV2` column's declared alignment moves the VALUE
 * as well as its header.
 *
 * ONE read for the whole repo, in the module that owns the question.
 * `packages/design-system` is gated from importing `@repo/app`, so `GridTableV2`
 * cannot read the key itself and each v2 host answers it here — one hook rather
 * than a flag read per mount, for the same reason `useMetricCardHideUnavailable`
 * is one hook. What a host passes on is this hook's answer, never the key: the
 * flag is read once and steers exactly one prop on one component, so there is no
 * second derivation to settle at its own moment
 * (`scripts/lint/rules/no-threaded-feature-flag.ts`).
 *
 * TRUE ⇒ each data cell publishes its column's alignment to the value primitive
 * inside, which takes it as a default. FALSE — the closed gate, and what every
 * v2 table has always done — ⇒ a column's alignment stops at its header and the
 * data cell's own free space.
 *
 * `useFeatureFlagEnabledOptional` resolves false with no provider mounted, so a
 * Storybook or package-test mount reads the gate closed instead of throwing.
 */
export function useGridValueAlignment(): boolean {
  return useFeatureFlagEnabledOptional(
    GRID_TABLE_V2_NUMBER_CELL_ALIGN_FEATURE_FLAG_KEY
  );
}
