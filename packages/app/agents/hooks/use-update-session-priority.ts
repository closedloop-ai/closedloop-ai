"use client";

import type { ArtifactPriorityEditSurface } from "@repo/api/src/types/priority-contract";
import {
  type ArtifactPriorityMutation,
  useArtifactPriorityMutation,
} from "../../shared/hooks/use-artifact-priority-mutation";
import { useAgentSessionsDataSource } from "../data-source/provider";
import {
  agentSessionDetailRowFilter,
  agentSessionKeys,
} from "./agent-session-keys";

/**
 * ISS-10332: set or clear a session's priority through the active data source
 * (`PATCH /agent-sessions/[id]` on the HTTP source), optimistic over the cached
 * Sessions reads that carry it (list, page data, detail), rolled back on
 * refusal. See
 * `useArtifactPriorityMutation` for the write's shape.
 *
 * Requires the same providers every other Sessions hook does; the cell that
 * mounts it (`SessionPriorityCell`) checks the source can write first, through
 * `useAgentSessionsDataSourceOptional`, and renders read-only otherwise.
 */
export function useUpdateSessionPriority(
  surface: ArtifactPriorityEditSurface
): ArtifactPriorityMutation {
  const dataSource = useAgentSessionsDataSource();
  return useArtifactPriorityMutation({
    queryKeyRoots: [
      agentSessionKeys.lists(),
      agentSessionKeys.pageDataRoot(),
      // `detailRow`, not `details()`: the broad prefix refetched every loaded
      // events page of every cached session for a one-field write (tamsinb
      // review, PR #8315). One narrowing serves this write and the rename.
      agentSessionDetailRowFilter,
    ],
    surface,
    write: dataSource.updatePriority?.bind(dataSource),
  });
}
