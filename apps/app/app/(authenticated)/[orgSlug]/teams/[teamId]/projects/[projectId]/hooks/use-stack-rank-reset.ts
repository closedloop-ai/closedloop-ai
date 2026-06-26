"use client";

import { GroupByMode } from "@repo/app/documents/lib/group-by";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { STACK_RANK_PROJECT_PAGE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import type {
  NavigationActions,
  ReadonlySearchParams,
} from "@repo/navigation/navigation-adapter";
import { useCallback } from "react";

/**
 * Build the "Reset to stack rank" handler for the project page's view menu
 * (PRD-421 / PLN-755 Phase D).
 *
 * Lives in its own hook so the page component stays under Biome's cognitive
 * complexity limit and so the flag check + URL/state mutation logic can be
 * unit-tested in isolation.
 *
 * Returns `undefined` when the `stack-rank-project-page` flag is off so the
 * caller can conditionally hide the menu item without an explicit
 * `?? undefined`.
 */
export function useStackRankReset(input: {
  clearSort: () => void;
  setGroupBy: (mode: GroupByMode) => void;
  searchParams: ReadonlySearchParams;
  navigation: NavigationActions;
  pathname: string;
}): (() => void) | undefined {
  const { clearSort, setGroupBy, searchParams, navigation, pathname } = input;
  const isEnabled = useFeatureFlagEnabled(
    STACK_RANK_PROJECT_PAGE_FEATURE_FLAG_KEY
  );
  const handler = useCallback(() => {
    clearSort();
    setGroupBy(GroupByMode.None);
    const params = new URLSearchParams(searchParams.toString());
    params.delete("sortBy");
    params.delete("sortDir");
    const qs = params.toString();
    navigation.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [clearSort, setGroupBy, searchParams, navigation, pathname]);

  return isEnabled ? handler : undefined;
}
