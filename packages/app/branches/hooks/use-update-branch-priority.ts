"use client";

import type { ArtifactPriorityEditSurface } from "@repo/api/src/types/priority-contract";
import {
  type ArtifactPriorityMutation,
  useArtifactPriorityMutation,
} from "../../shared/hooks/use-artifact-priority-mutation";
import {
  useBranchesDataSource,
  useBranchesQueryContext,
} from "../data-source/provider";
import { branchesKeys } from "./use-branches";

/**
 * ISS-10332: set or clear a branch's priority through the active data source
 * (`PATCH /branches/[id]` on the HTTP source), optimistic over the cached
 * Branches reads that carry it (list, page data, detail) in the Branch-owned
 * query client, rolled back on refusal. See
 * `useArtifactPriorityMutation`.
 *
 * Requires the same providers every other Branches write hook does; the cell
 * that mounts it (`BranchPriorityCell`) checks the source can write first,
 * through `useBranchesDataSourceOptional`, and renders read-only otherwise.
 */
export function useUpdateBranchPriority(
  surface: ArtifactPriorityEditSurface
): ArtifactPriorityMutation {
  const dataSource = useBranchesDataSource();
  const { queryClient } = useBranchesQueryContext();
  return useArtifactPriorityMutation({
    queryClient,
    queryKeyRoots: [
      branchesKeys.lists(),
      branchesKeys.pageDataRoot(),
      branchesKeys.details(),
    ],
    surface,
    write: dataSource.updatePriority?.bind(dataSource),
  });
}
