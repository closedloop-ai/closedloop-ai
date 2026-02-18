"use client";

import { useCallback, useState } from "react";

/**
 * Git status information returned from the API
 */
export type GitStatus = {
  currentBranch: string;
  hasChanges: boolean;
  files?: {
    modified: string[];
    created: string[];
    deleted: string[];
    staged: string[];
  };
};

/**
 * Result from the useGitOperations hook
 */
export type UseGitOperationsResult = {
  createBranch: (branchName: string) => Promise<void>;
  createBranchForTicket: (ticketId: string) => Promise<string>;
  commit: (message: string) => Promise<void>;
  push: () => Promise<void>;
  getStatus: () => Promise<GitStatus>;
  isLoading: boolean;
  error: string | null;
  currentBranch: string | null;
  hasChanges: boolean;
};

/**
 * Extract error message from unknown error
 */
function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error occurred";
}

/**
 * Hook to perform git operations via server-side API routes
 *
 * This hook provides functions for common git operations (branch, commit, push, status).
 * Since git operations require Node.js child processes, they execute server-side via
 * the /api/git endpoint using the simple-git library.
 *
 * @example
 * ```tsx
 * const { createBranch, commit, push, getStatus, isLoading, error, currentBranch, hasChanges } = useGitOperations();
 *
 * // Create and checkout a new branch
 * await createBranch("feature/new-feature");
 *
 * // Commit all changes
 * await commit("Add new feature");
 *
 * // Push to remote
 * await push();
 *
 * // Check status
 * const status = await getStatus();
 * console.log(status.currentBranch, status.hasChanges);
 * ```
 */
export function useGitOperations(): UseGitOperationsResult {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentBranch, setCurrentBranch] = useState<string | null>(null);
  const [hasChanges, setHasChanges] = useState(false);

  /**
   * Execute a git API request with common error handling
   */
  const executeGitAction = useCallback(
    async <T>(
      body: Record<string, unknown>,
      errorPrefix: string
    ): Promise<T> => {
      setIsLoading(true);
      setError(null);

      try {
        const response = await fetch("/api/engineer/git", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || `${errorPrefix}`);
        }

        return data as T;
      } catch (err) {
        setError(getErrorMessage(err));
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    []
  );

  const createBranch = useCallback(
    async (branchName: string) => {
      const data = await executeGitAction<{ branchName: string }>(
        { action: "branch", branchName },
        "Failed to create/checkout branch"
      );
      setCurrentBranch(data.branchName);
    },
    [executeGitAction]
  );

  const commit = useCallback(
    async (message: string) => {
      await executeGitAction(
        { action: "commit", message },
        "Failed to commit changes"
      );
      setHasChanges(false);
    },
    [executeGitAction]
  );

  const push = useCallback(async () => {
    await executeGitAction({ action: "push" }, "Failed to push changes");
  }, [executeGitAction]);

  const getStatus = useCallback(async (): Promise<GitStatus> => {
    const data = await executeGitAction<GitStatus>(
      { action: "status" },
      "Failed to get git status"
    );

    setCurrentBranch(data.currentBranch);
    setHasChanges(data.hasChanges);

    return data;
  }, [executeGitAction]);

  const createBranchForTicket = useCallback(
    async (ticketId: string): Promise<string> => {
      // Use ticket ID directly as branch name (e.g., "AI-117")
      const branchName = ticketId;

      // Use existing createBranch function to create/checkout the branch
      await createBranch(branchName);

      return branchName;
    },
    [createBranch]
  );

  return {
    createBranch,
    createBranchForTicket,
    commit,
    push,
    getStatus,
    isLoading,
    error,
    currentBranch,
    hasChanges,
  };
}
