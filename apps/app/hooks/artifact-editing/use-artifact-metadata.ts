"use client";

import type {
  ArtifactStatus,
  ArtifactWithWorkstream,
} from "@repo/api/src/types/artifact";
import type { Priority } from "@repo/api/src/types/common";
import { toast } from "@repo/design-system/components/ui/sonner";
import type { User } from "@repo/design-system/components/ui/user-select-popover";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useUpdateArtifact } from "@/hooks/queries/use-artifacts";
import { useTeamMembers } from "@/hooks/use-team-members";
import { transformApiUserToSelectUser } from "@/lib/user-utils";

type UseArtifactMetadataConfig = {
  artifact: ArtifactWithWorkstream;
};

/**
 * Convert an assignee (from the API) to the User shape expected by UserSelectPopover.
 * Returns null if no assignee is provided.
 */
function assigneeToUser(
  assignee: ArtifactWithWorkstream["assignee"]
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
  approver: ArtifactWithWorkstream["approver"]
): User | null {
  if (!approver) {
    return null;
  }
  return transformApiUserToSelectUser(approver);
}

/**
 * Hook to manage artifact metadata updates (status, approver, targetRepo, targetBranch).
 *
 * **Use this hook when:** Your component needs to display/edit artifact metadata (metadata panel, status badge).
 *
 * **What it provides:**
 * - Local state management with optimistic updates
 * - Debounced saves on blur (for text inputs like targetRepo, targetBranch)
 * - Immediate saves on change (for selects like status, approver, owner)
 * - State synchronization when artifact changes
 *
 * **Example usage:**
 * ```tsx
 * const { status, handleStatusChange, approver, handleApproverSelect } =
 *   useArtifactMetadata({ artifact });
 *
 * <Select value={status} onValueChange={handleStatusChange}>...</Select>
 * <UserSelectPopover value={approver} onSelect={handleApproverSelect} />
 * ```
 *
 * **Important:** Text input changes are local until blur event triggers save. Select/dropdown changes save immediately.
 */
export function useArtifactMetadata(config: UseArtifactMetadataConfig) {
  const { artifact } = config;

  // TanStack Query mutation for updating artifact
  const updateArtifact = useUpdateArtifact();

  // Metadata state - tracks local edits
  const [status, setStatus] = useState(artifact.status);
  const [priority, setPriority] = useState<Priority>(artifact.priority);
  const [targetRepo, setTargetRepo] = useState(artifact.targetRepo ?? "");
  const [targetBranch, setTargetBranch] = useState(
    artifact.targetBranch ?? "main"
  );
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
    setTargetRepo(artifact.targetRepo ?? "");
    setTargetBranch(artifact.targetBranch ?? "main");
    setAssignee(assigneeToUser(artifact.assignee));
  }, [
    artifact.status,
    artifact.priority,
    artifact.targetRepo,
    artifact.targetBranch,
    artifact.assignee,
  ]);

  /**
   * Generic metadata update handler.
   * Triggers mutation to update artifact on the server.
   */
  const handleMetadataUpdate = useCallback(
    (
      updates: Partial<{
        status: ArtifactStatus;
        priority: Priority;
        parentId: string | null;
        approverId: string | null;
        targetRepo: string | null;
        targetBranch: string | null;
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
    (newStatus: ArtifactStatus) => {
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
   * Handle target repository blur event.
   * Saves to server only if value has changed.
   * Accepts optional override value to avoid stale closure when called
   * immediately after a state setter in the same event handler.
   */
  const handleTargetRepoBlur = useCallback(
    (overrideValue?: string) => {
      const value = overrideValue ?? targetRepo;
      if (value !== (artifact.targetRepo ?? "")) {
        handleMetadataUpdate({
          targetRepo: value.trim() === "" ? null : value,
        });
      }
    },
    [targetRepo, artifact.targetRepo, handleMetadataUpdate]
  );

  /**
   * Handle target branch blur event.
   * Saves to server only if value has changed.
   * Accepts optional override value to avoid stale closure when called
   * immediately after a state setter in the same event handler.
   */
  const handleTargetBranchBlur = useCallback(
    (overrideValue?: string) => {
      const value = overrideValue ?? targetBranch;
      if (value !== (artifact.targetBranch ?? "main")) {
        handleMetadataUpdate({
          targetBranch: value.trim() === "" ? null : value,
        });
      }
    },
    [targetBranch, artifact.targetBranch, handleMetadataUpdate]
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
    targetRepo,
    targetBranch,
    assignee,
    teamMembers,

    // Status handlers
    handleStatusChange,

    // Priority handlers
    handlePriorityChange,

    // Approver handlers
    handleApproverSelect,

    // Target repository handlers (setTargetRepo is stable, no useCallback needed)
    handleTargetRepoChange: setTargetRepo,
    handleTargetRepoBlur,

    // Target branch handlers (setTargetBranch is stable, no useCallback needed)
    handleTargetBranchChange: setTargetBranch,
    handleTargetBranchBlur,

    // Parent handlers
    handleParentChange,

    // Assignee handlers
    handleAssigneeChange,

    // Loading state
    isUpdating,
  };
}
