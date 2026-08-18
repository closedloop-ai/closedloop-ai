"use client";

import type { DocumentWithProject } from "@repo/api/src/types/document";
import type { ProjectTreeResponse } from "@repo/api/src/types/project-tree";
import { useBranchList } from "@repo/app/branches/hooks/use-branches";
import { useAssignedArtifactTree } from "@repo/app/projects/hooks/use-assigned-artifact-tree";
import { useMergedProjectTrees } from "@repo/app/projects/hooks/use-merged-project-trees";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { MY_TASKS_ASSIGNED_ARTIFACT_TREE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { useCallback, useMemo } from "react";
import { useFeatureFlagsSettledForUser } from "@/components/feature-flags-settled";
import { collectMyTasksTreeProjectIds } from "../utils";

type MyTasksTreeSourceParams = {
  assigneeId: string | null;
  isListView: boolean;
  isUserLoading: boolean;
  artifacts: DocumentWithProject[];
};

export type MyTasksTreeSource = {
  treeData: ProjectTreeResponse | null;
  isTreeLoading: boolean;
  isTreeError: boolean;
  /** Refetch whichever reads this source is actually driving. */
  refetchTree: () => void;
};

/**
 * Resolve the My Tasks tree from exactly ONE of the two reads, and never from
 * both (FEA-1651, parent FEA-908).
 *
 * Extracted from `page.tsx` so the flag-transition rules live in one testable
 * place instead of as four `enabled` expressions in a 700-line component.
 *
 * THE FLAG IS NOT READ UNTIL IT HAS RESOLVED. The web adapter collapses an
 * unresolved PostHog value to `false`, so keying the reads on the raw flag
 * starts the LEGACY per-project fan-out during the anonymous bootstrap window,
 * and then starts the new request as well when the flag resolves true — the
 * already-issued reads are not cancelled, so a flagged-on user pays for both
 * (wongk, PR #4461). Both paths therefore stay disabled until the flags have
 * loaded FOR THE IDENTIFIED USER, reusing the same readiness signals the route
 * gate uses rather than a parallel notion of "ready".
 */
export function useMyTasksTreeSource({
  assigneeId,
  isListView,
  isUserLoading,
  artifacts,
}: MyTasksTreeSourceParams): MyTasksTreeSource {
  const assignedTreeEndpointEnabled = useFeatureFlagEnabled(
    MY_TASKS_ASSIGNED_ARTIFACT_TREE_FEATURE_FLAG_KEY
  );
  const flagReady = useFeatureFlagsSettledForUser();

  const useAssignedEndpoint = flagReady && assignedTreeEndpointEnabled;
  const useProjectFanOut = flagReady && !assignedTreeEndpointEnabled;

  // Only the fan-out needs this read, and only to discover which projects to
  // ask. The assigned-tree endpoint resolves contributor branches server-side,
  // so under the flag this request buys nothing — and its loading flag would
  // hold the table in a skeleton waiting on a read the page no longer uses
  // (closedloop-ai-stage, PR #4461).
  const contributorBranchFilters = useMemo(
    () => (assigneeId ? { contributorUserId: assigneeId } : {}),
    [assigneeId]
  );
  const {
    data: contributorBranchList,
    isLoading: isContributorBranchLoading,
    isError: isContributorBranchError,
    refetch: refetchContributorBranches,
  } = useBranchList(contributorBranchFilters, {
    enabled: useProjectFanOut && !!assigneeId && !isUserLoading,
  });

  const projectIds = useMemo(
    () =>
      collectMyTasksTreeProjectIds(
        artifacts,
        contributorBranchList?.items ?? []
      ),
    [artifacts, contributorBranchList?.items]
  );

  // Both hooks are called unconditionally (rules of hooks); their `enabled`
  // flags are mutually exclusive, so at most one ever issues a request.
  const mergedProjectTrees = useMergedProjectTrees(projectIds, {
    enabled: isListView && useProjectFanOut,
    filters: assigneeId ? { contributorUserId: assigneeId } : undefined,
  });
  const assignedArtifactTree = useAssignedArtifactTree(assigneeId, {
    enabled: isListView && useAssignedEndpoint,
  });

  const active = useAssignedEndpoint
    ? assignedArtifactTree
    : mergedProjectTrees;

  // The branch read only belongs to the fan-out's loading and error state. Under
  // the flag it is not issued, so folding it in would report a stream the page
  // is not reading.
  const isTreeLoading =
    active.isLoading || (useProjectFanOut && isContributorBranchLoading);
  const isTreeError =
    active.isError || (useProjectFanOut && isContributorBranchError);

  // "Try again" has to retry the read that actually failed. Retrying the ACTIVE
  // tree read plus the branch read the fan-out depends on covers every stream
  // this source can put the page into an error state for; the inactive path is
  // disabled, so retrying it would be a no-op at best.
  const { refetch: refetchActiveTree } = active;
  const refetchTree = useCallback(() => {
    refetchActiveTree();
    refetchContributorBranches();
  }, [refetchActiveTree, refetchContributorBranches]);

  return {
    treeData: active.data,
    isTreeLoading,
    isTreeError,
    refetchTree,
  };
}
