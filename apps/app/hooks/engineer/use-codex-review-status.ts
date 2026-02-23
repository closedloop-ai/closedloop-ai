import { useQuery } from "@tanstack/react-query";

export type CodexReviewStatus = {
  hasReview: boolean;
  worktreeDir?: string;
  status?: "running" | "completed" | "failed" | "stopped";
  processRunning?: boolean;
  pid?: number;
  startedAt?: string;
  completedAt?: string;
  exitCode?: number;
  config?: {
    model: string;
    reasoningEffort: string;
    reviewMode: "uncommitted" | "base";
    baseBranch: string;
    instructions?: string;
  };
  log?: string;
  logSize?: number;
  message?: string;
  error?: string;
};

export function useCodexReviewStatus(
  ticketId: string | null,
  repoPath: string | null
) {
  return useQuery({
    queryKey: ["codex-review-status", ticketId, repoPath],
    queryFn: async (): Promise<CodexReviewStatus> => {
      if (!(ticketId && repoPath)) {
        return { hasReview: false };
      }
      const res = await fetch(
        `/api/engineer/codex/status/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}`
      );
      return res.json();
    },
    enabled: !!ticketId && !!repoPath,
    refetchInterval: (query) => {
      // Poll every 2 seconds while review is running
      const data = query.state.data;
      if (data?.status === "running" && data?.processRunning) {
        return 2000;
      }
      return false;
    },
    staleTime: 1000,
  });
}
