"use client";

import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import {
  type EntityListCustomFieldsController,
  type EntityListCustomFieldsItem,
  useEntityListCustomFieldsController,
} from "@repo/app/custom-fields/hooks/use-entity-list-custom-fields-controller";
import { useMemo } from "react";
import { useBranchesQueryContext } from "../data-source/provider";
import type { BranchRow } from "../lib/branch-row";
import { branchRowQueryKeys } from "./branch-query-keys";

/**
 * ISS-12663 — the Branches list's custom-field columns, through the same shared
 * controller the Sessions list reads (`useEntityListCustomFieldsController`).
 *
 * A Branch's values hang off its ARTIFACT, so a row is addressed by
 * `artifactId`. A row with no artifact has no values to hold and is left out,
 * so it cannot hide the columns from the rows that do; an artifact row without
 * the `customFields` projection (an older API, a failed read) withholds the
 * controller, the same "values not loaded" rule Sessions applies.
 */
export function useBranchesCustomFieldsController(
  rows: readonly BranchRow[],
  options?: { enabled?: boolean }
): EntityListCustomFieldsController | undefined {
  const { queryClient } = useBranchesQueryContext();
  const items = useMemo(
    () => rows.flatMap(toEntityListCustomFieldsItem),
    [rows]
  );
  return useEntityListCustomFieldsController({
    // A page whose rows ALL lack an artifact has nothing to hold a value, which
    // is not the same as an empty page; without this the shared controller
    // would read the empty item list as "values available".
    enabled:
      (options?.enabled ?? true) && !(rows.length > 0 && items.length === 0),
    entityType: CustomFieldEntityType.Branch,
    invalidateQueryKeys: BRANCHES_CUSTOM_FIELD_INVALIDATION_KEYS,
    items,
    queryClient,
  });
}

/** Both Branches list read shapes a value write changes. */
const BRANCHES_CUSTOM_FIELD_INVALIDATION_KEYS = [
  branchRowQueryKeys.lists,
  branchRowQueryKeys.pageData,
];

function toEntityListCustomFieldsItem(
  row: BranchRow
): EntityListCustomFieldsItem[] {
  if (row.artifactId === undefined) {
    return [];
  }
  return Object.hasOwn(row, "customFields")
    ? [{ entityId: row.artifactId, customFields: row.customFields }]
    : [{ entityId: row.artifactId }];
}
