"use client";

import { useMemo } from "react";
// The tags slice owns the common picker and artifact mutation mechanics.
import { useBulkTagFamilyActions } from "../../tags/components/bulk-tag-action";
import {
  useBranchesDataSourceOptional,
  useBranchesQueryContext,
} from "../data-source/provider";
import {
  BranchRowPolicyAction,
  resolveBranchRowActionApplicability,
} from "../lib/branch-action-policy";
import type { BranchRow } from "../lib/branch-row";

/** Branch identities differ from cloud artifact IDs; refresh the Branch-owned cache. */
export function useBranchesBulkTagActions(
  rows: readonly BranchRow[],
  readOnly = false
) {
  const { queryClient } = useBranchesQueryContext();
  const source = useBranchesDataSourceOptional();
  const addTargets = useMemo(
    () =>
      rows.map((row) => {
        const applicability = resolveBranchRowActionApplicability({
          hasArtifactIdentity: Boolean(row.artifactId),
          hasDetailRoute: false,
          hasSessionsRoute: false,
          hostCanMutate: !readOnly,
          prNumber: row.prNumber,
          prUrl: row.prUrl,
          sessionCount: row.sessionCount,
          supportsTags: source?.supportsTags === true,
          tagAvailability: row.tagAvailability,
          tagPermissions: row.tagPermissions,
        });
        return {
          ...(row.artifactId ? { artifactId: row.artifactId } : {}),
          canApply: applicability[BranchRowPolicyAction.BulkTagApply],
          rowId: row.id,
        };
      }),
    [readOnly, rows, source?.supportsTags]
  );
  const removeTargets = useMemo(
    () =>
      rows.map((row) => ({
        ...(row.artifactId ? { artifactId: row.artifactId } : {}),
        // DOC-36 R16 gives the bulk remove action the write scope, unlike the
        // single-row DELETE route. `canApply` is the projected write scope.
        canApply: !readOnly && (row.tagPermissions?.canApply ?? false),
        rowId: row.id,
      })),
    [readOnly, rows]
  );
  return useBulkTagFamilyActions({
    addTargets,
    queryClient,
    removeTargets,
  });
}
