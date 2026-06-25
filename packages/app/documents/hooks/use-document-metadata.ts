"use client";

import type { Priority } from "@repo/api/src/types/common";
import type {
  DocumentStatus,
  DocumentWithProject,
} from "@repo/api/src/types/document";
import { transformApiUserToSelectUser } from "@repo/app/shared/lib/user-utils";
import { useTeamMembers } from "@repo/app/teams/hooks/use-team-members";
import { toast } from "@repo/design-system/components/ui/sonner";
import type { User } from "@repo/design-system/components/ui/user-select-popover";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useUpdateDocument } from "./use-documents";

type UseArtifactMetadataConfig = {
  artifact: DocumentWithProject;
};

/**
 * Convert an assignee (from the API) to the User shape expected by UserSelectPopover.
 * Returns null if no assignee is provided.
 */
function assigneeToUser(
  assignee: DocumentWithProject["assignee"]
): User | null {
  if (!assignee) {
    return null;
  }
  return transformApiUserToSelectUser(assignee);
}

/**
 * Convert an Approver (from the API) to the User shape expected by UserSelectPopover.
 * Returns null if no approver is provided.
 */
function approverToUser(
  approver: DocumentWithProject["approver"]
): User | null {
  if (!approver) {
    return null;
  }
  return transformApiUserToSelectUser(approver);
}

/**
 * Hook to manage artifact metadata updates (status, priority, assignee,
 * approver, parent). Read-only access to `repositorySnapshot` is also
 * exposed so the metadata bar can render the immutable repo summary.
 *
 * **Use this hook when:** Your component needs to display/edit artifact
 * metadata (metadata panel, status badge).
 *
 * **What it provides:**
 * - Local state management with optimistic updates
 * - Immediate saves on change (for selects like status, approver, owner)
 * - State synchronization when artifact changes
 *
 * **Example usage:**
 * ```tsx
 * const { status, handleStatusChange, approver, handleApproverSelect } =
 *   useDocumentMetadata({ artifact });
 *
 * <Select value={status} onValueChange={handleStatusChange}>...</Select>
 * <UserSelectPopover value={approver} onSelect={handleApproverSelect} />
 * ```
 */
export function useDocumentMetadata(config: UseArtifactMetadataConfig) {
  const { artifact } = config;

  // TanStack Query mutation for updating artifact
  const updateArtifact = useUpdateDocument();

  // Metadata state - tracks local edits
  const [status, setStatus] = useState(artifact.status);
  const [priority, setPriority] = useState<Priority>(artifact.priority);
  const [assignee, setAssignee] = useState<User | null>(() =>
    assigneeToUser(artifact.assignee)
  );

  // Derived state from artifact
  const approver = useMemo(
    () => approverToUser(artifact.approver),
    [artifact.approver]
  );

  // Fetch team members from artifact's project teams
  const teamIds = useMemo(
    () => artifact.project?.teams?.map((team) => team.id) ?? [],
    [artifact.project?.teams]
  );
  const { members: teamMembers } = useTeamMembers({ teamIds });

  // Derived state
  const isUpdating = updateArtifact.isPending;

  // Sync state when artifact prop changes (e.g., after update, navigation)
  useEffect(() => {
    setStatus(artifact.status);
    setPriority(artifact.priority);
    setAssignee(assigneeToUser(artifact.assignee));
  }, [artifact.status, artifact.priority, artifact.assignee]);

  /**
   * Generic metadata update handler.
   * Triggers mutation to update artifact on the server.
   */
  const handleMetadataUpdate = useCallback(
    (
      updates: Partial<{
        status: DocumentStatus;
        priority: Priority;
        parentId: string | null;
        approverId: string | null;
        assigneeId: string | null;
      }>
    ) => {
      updateArtifact.mutate(
        { id: artifact.id, ...updates },
        {
          onSuccess: () => {
            toast.success("Changes saved");
          },
        }
      );
    },
    [artifact.id, updateArtifact]
  );

  /**
   * Handle status change.
   * Updates local state and immediately saves to server.
   */
  const handleStatusChange = useCallback(
    (newStatus: DocumentStatus) => {
      setStatus(newStatus);
      handleMetadataUpdate({ status: newStatus });
    },
    [handleMetadataUpdate]
  );

  /**
   * Handle priority change.
   * Updates local state and immediately saves to server.
   */
  const handlePriorityChange = useCallback(
    (newPriority: Priority) => {
      setPriority(newPriority);
      handleMetadataUpdate({ priority: newPriority });
    },
    [handleMetadataUpdate]
  );

  /**
   * Handle approver selection from dropdown.
   * Updates immediately on select (not on blur).
   */
  const handleApproverSelect = useCallback(
    (user: User | null) => {
      handleMetadataUpdate({ approverId: user?.id ?? null });
    },
    [handleMetadataUpdate]
  );

  /**
   * Handle parent artifact change.
   * Immediately saves to server.
   */
  const handleParentChange = useCallback(
    (parentId: string | null) => {
      handleMetadataUpdate({ parentId });
    },
    [handleMetadataUpdate]
  );

  /**
   * Handle assignee change.
   * Updates local state and immediately saves to server.
   */
  const handleAssigneeChange = useCallback(
    (user: User | null) => {
      setAssignee(user);
      handleMetadataUpdate({ assigneeId: user?.id ?? null });
    },
    [handleMetadataUpdate]
  );

  return {
    // Metadata state
    status,
    priority,
    approver,
    repositorySnapshot: artifact.repositorySnapshot,
    assignee,
    teamMembers,

    // Status handlers
    handleStatusChange,

    // Priority handlers
    handlePriorityChange,

    // Approver handlers
    handleApproverSelect,

    // Parent handlers
    handleParentChange,

    // Assignee handlers
    handleAssigneeChange,

    // Loading state
    isUpdating,
  };
}
