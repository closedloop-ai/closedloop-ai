"use client";

import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag";
import { SessionStatusGroupIcon } from "@repo/app/agents/components/sessions/session-group-icons";
import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import { buildUniversalSessionStatusBands } from "@repo/app/agents/lib/universal-session-status-grouping";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import type { TableGroupingState } from "@repo/design-system/components/ui/table-toolbar-model";
import type { GridTableV2Group } from "@repo/design-system/lib/grid-table-v2-types";

/** Selects canonical Session band labels and marks for Grid Table v2. */
export function useUniversalSessionGridGroups(
  groups: GridTableV2Group<SessionTableRow>[] | undefined,
  grouping: TableGroupingState
): GridTableV2Group<SessionTableRow>[] | undefined {
  const champion = useFeatureFlagEnabledOptional(
    UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY
  );
  return champion
    ? presentUniversalSessionGridGroups(groups, grouping)
    : groups;
}

/** Rebuilds status bands from the champion facet at either grouping depth. */
export function presentUniversalSessionGridGroups(
  groups: GridTableV2Group<SessionTableRow>[] | undefined,
  grouping: TableGroupingState
): GridTableV2Group<SessionTableRow>[] | undefined {
  if (grouping.primary.fieldId === "status") {
    return presentPrimaryStatusGroups(
      groups,
      grouping.secondary.fieldId !== null
    );
  }
  if (grouping.secondary.fieldId !== "status") {
    return groups;
  }
  return groups?.map((group) => ({
    ...group,
    subgroups: presentStatusGroups(group.subgroups),
  }));
}

function presentPrimaryStatusGroups(
  groups: GridTableV2Group<SessionTableRow>[] | undefined,
  hasSecondaryGrouping: boolean
): GridTableV2Group<SessionTableRow>[] | undefined {
  const presented = presentStatusGroups(groups);
  if (!(presented && groups && hasSecondaryGrouping)) {
    return presented;
  }
  return presented.map((group) => ({
    ...group,
    subgroups: collectSubgroups(groups, new Set(group.items)),
  }));
}

function presentStatusGroups(
  groups: GridTableV2Group<SessionTableRow>[] | undefined
): GridTableV2Group<SessionTableRow>[] | undefined {
  if (!groups) {
    return groups;
  }
  const rows = groups.flatMap((group) => group.items);
  return buildUniversalSessionStatusBands(rows).map((band) => {
    const firstRow = band.items[0];
    return {
      ...band,
      icon: (
        <SessionStatusGroupIcon
          rawStatus={firstRow.rawStatus}
          status={firstRow.status}
        />
      ),
    };
  });
}

function collectSubgroups(
  groups: GridTableV2Group<SessionTableRow>[],
  includedItems: ReadonlySet<SessionTableRow>
): GridTableV2Group<SessionTableRow>[] {
  const collected = new Map<string, GridTableV2Group<SessionTableRow>>();
  for (const group of groups) {
    for (const subgroup of group.subgroups ?? []) {
      const items = subgroup.items.filter((item) => includedItems.has(item));
      if (items.length === 0) {
        continue;
      }
      const existing = collected.get(subgroup.key);
      if (!existing) {
        collected.set(subgroup.key, { ...subgroup, items });
        continue;
      }
      existing.items.push(...items);
      existing.droppable =
        existing.droppable !== false && subgroup.droppable !== false;
      if (existing.value !== subgroup.value) {
        existing.value = undefined;
        existing.droppable = false;
      }
    }
  }
  return [...collected.values()];
}
