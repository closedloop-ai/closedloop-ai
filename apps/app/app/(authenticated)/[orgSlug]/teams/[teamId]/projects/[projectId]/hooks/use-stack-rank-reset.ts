"use client";

import { GroupByMode } from "@repo/app/documents/lib/group-by";
import { useLinkedSearchWriter } from "@repo/app/shared/hooks/use-linked-search-writer";
import { writeTableGroupViewParams } from "@repo/app/shared/lib/table-group-view-params";
import { EMPTY_TABLE_GROUPING } from "@repo/design-system/components/ui/table-toolbar-model";
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
 * complexity limit and so the URL/state mutation logic can be unit-tested in
 * isolation.
 */
export function useStackRankReset(input: {
  clearSort: () => void;
  setGroupBy: (mode: GroupByMode) => void;
  searchParams: ReadonlySearchParams;
  navigation: NavigationActions;
  pathname: string;
}): () => void {
  const { clearSort, setGroupBy, searchParams, navigation, pathname } = input;
  const { readLatest, replaceSearch } = useLinkedSearchWriter(
    pathname,
    searchParams,
    navigation.replace
  );
  const handler = useCallback(() => {
    clearSort();
    setGroupBy(GroupByMode.None);
    const params = readLatest();
    params.delete("sortBy");
    params.delete("sortDir");
    // The ungrouped view is stated too: carrying the old `group` would
    // re-group the board, which reads its grouping from the link (PRD-720 AC3).
    writeTableGroupViewParams(params, EMPTY_TABLE_GROUPING, {});
    replaceSearch(params);
  }, [clearSort, setGroupBy, readLatest, replaceSearch]);

  return handler;
}
