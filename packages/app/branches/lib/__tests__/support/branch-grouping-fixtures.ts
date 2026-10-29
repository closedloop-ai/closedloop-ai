import { tableGroupingAxisKey } from "@repo/app/shared/lib/table-collapsed-groups";
import {
  EMPTY_TABLE_GROUPING,
  type TableGroupingState,
  TableGroupOrder,
} from "@repo/design-system/components/ui/table-toolbar-model";

/**
 * ISS-9582 — grouping fixtures and the throw-on-null axis-key unwrap shared by
 * every Branches band-collapse test (hooks, components, and the desktop
 * renderer). One `TableGroupingState` shape and one `tableGroupingAxisKey`
 * unwrap, so a fixture typo or an axis-composition drift shows up once instead
 * of once per file.
 */

export function branchGrouping(
  fieldId: string,
  order: TableGroupOrder
): TableGroupingState {
  return {
    primary: { fieldId, order, showEmptyGroups: false },
    secondary: EMPTY_TABLE_GROUPING.secondary,
  };
}

export const GROUPED_BY_OWNER: TableGroupingState = branchGrouping(
  "owner",
  TableGroupOrder.Ascending
);
export const GROUPED_BY_REPO: TableGroupingState = branchGrouping(
  "repo",
  TableGroupOrder.Ascending
);

/**
 * `tableGroupingAxisKey` types its return `string | null` because an
 * ungrouped state has no axis — every fixture here is always grouped, so a
 * `null` would be a fixture bug worth failing loudly on rather than smuggling
 * into a computed object key.
 */
export function requiredAxisKey(grouping: TableGroupingState): string {
  const key = tableGroupingAxisKey(grouping);
  if (key === null) {
    throw new Error("expected grouping to resolve to a real axis key");
  }
  return key;
}
