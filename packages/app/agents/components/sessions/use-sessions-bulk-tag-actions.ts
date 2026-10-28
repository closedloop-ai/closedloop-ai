"use client";

import { SESSIONS_ARTIFACT_TAGS_FLAG_KEY } from "@repo/api/src/types/sessions-artifact-tags-flag";
import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import { useMemo } from "react";
import { useFeatureFlagEnabledOptional } from "../../../shared/feature-flags/use-feature-flag-enabled";
// The tags slice owns the common picker and artifact mutation mechanics.
import { useBulkTagFamilyActions } from "../../../tags/components/bulk-tag-action";

/**
 * Cloud Session row IDs are their canonical taggable artifact IDs. `readOnly`
 * withholds the write the same way the Branches adapter does (Desktop offline).
 */
export function useSessionsBulkTagActions(
  rows: readonly SessionTableRow[],
  readOnly = false
) {
  const addTargets = useMemo(
    () =>
      rows.map((row) => ({
        artifactId: row.id,
        canApply: !readOnly && (row.tagPermissions?.canApply ?? false),
        rowId: row.id,
      })),
    [readOnly, rows]
  );
  const removeTargets = useMemo(
    () =>
      rows.map((row) => ({
        artifactId: row.id,
        // DOC-36 R16 gives the bulk remove action the write scope, unlike the
        // single-row DELETE route. `canApply` is the projected write scope.
        canApply: !readOnly && (row.tagPermissions?.canApply ?? false),
        rowId: row.id,
      })),
    [readOnly, rows]
  );
  const actions = useBulkTagFamilyActions({
    addTargets,
    removeTargets,
  });
  const enabled = useFeatureFlagEnabledOptional(
    SESSIONS_ARTIFACT_TAGS_FLAG_KEY
  );
  return enabled && !readOnly ? actions : [];
}
