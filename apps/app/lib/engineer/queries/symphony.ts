import { queryOptions } from "@tanstack/react-query";
import type { ChatMessage } from "@/components/engineer/chat";
import { queryKeys } from "./keys";

// Re-export shared chat types
export type { ChatMessage, ContentBlock } from "@/components/engineer/chat";

/* ---------- Response types ---------- */

export type ActiveAgent = {
  agentId: string;
  agentType: string;
  agentName: string;
  startedAt: string;
};

export type SymphonyStatusResponse = {
  exists: boolean;
  stateExists?: boolean;
  phase?: string | null;
  status?: string | null;
  timestamp?: string;
  message?: string;
  error?: string;
  activeAgents?: ActiveAgent[];
  currentTaskId?: string;
  planExists?: boolean;
  taskProgress?: { pending: number; completed: number; total: number };
  pid?: number | null;
  processRunning?: boolean;
};

export type PlanResponse = {
  exists: boolean;
  planExists: boolean;
  content?: string;
  error?: string;
  worktreeDir?: string;
};

export type ChatHistory = {
  messages: ChatMessage[];
  ticketId: string;
  repoPath: string;
};

export type CommentChatHistory = {
  messages: ChatMessage[];
  ticketId: string;
  repoPath: string;
  commentId: string;
  commentContext: {
    author: string;
    body: string;
    path?: string;
    line?: number;
  };
};

export type LogResponse = {
  exists: boolean;
  format: "jsonl" | "text";
  content?: string; // For text format
  lines?: string[]; // For jsonl format - raw JSONL strings
  totalLines?: number;
  returnedLines?: number;
};

export const EvalStatus = {
  Failed: 1,
  NeedsImprovement: 2,
  Passed: 3,
} as const;
export type EvalStatus = (typeof EvalStatus)[keyof typeof EvalStatus];

export type MetricStatistics = {
  metric_name: string;
  threshold: number;
  score: number;
  justification: string;
};

export type CaseScore = {
  type: "case_score";
  case_id: string;
  final_status: EvalStatus;
  metrics: MetricStatistics[];
};

export type EvaluationReport = {
  report_id: string;
  timestamp: string;
  stats: CaseScore[];
};

export type SymphonyJudgesResponse = {
  exists: boolean;
  isMock: boolean;
  data?: EvaluationReport;
  error?: string;
  message?: string;
  worktreeDir?: string;
};

/* ---------- Query option factories ---------- */

export function symphonyStatusOptions(
  ticketId: string,
  repoPath: string | null
) {
  return queryOptions<SymphonyStatusResponse>({
    queryKey: queryKeys.symphonyStatus(ticketId, repoPath),
    queryFn: async () => {
      const response = await fetch(
        `/api/engineer/symphony/status/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath || "")}`
      );
      return response.json();
    },
    enabled: !!repoPath,
  });
}

export function symphonyPlanOptions(ticketId: string, repoPath: string) {
  return queryOptions<PlanResponse>({
    queryKey: queryKeys.symphonyPlan(ticketId, repoPath),
    queryFn: async () => {
      const response = await fetch(
        `/api/engineer/symphony/plan/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}`
      );
      return response.json();
    },
  });
}

export function symphonyChatHistoryOptions(ticketId: string, repoPath: string) {
  return queryOptions<ChatHistory>({
    queryKey: queryKeys.symphonyChatHistory(ticketId, repoPath),
    queryFn: async () => {
      const response = await fetch(
        `/api/engineer/symphony/chat-history/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}`
      );
      return response.json();
    },
  });
}

export function symphonyLogsOptions(ticketId: string, repoPath: string) {
  return queryOptions<LogResponse>({
    queryKey: queryKeys.symphonyLogs(ticketId, repoPath),
    queryFn: async () => {
      const response = await fetch(
        `/api/engineer/symphony/logs/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}&lines=1000`
      );
      return response.json();
    },
  });
}

export function commentChatHistoryOptions(
  ticketId: string,
  commentId: string,
  repoPath: string,
  commentContext: { author: string; body: string; path?: string; line?: number }
) {
  return queryOptions<CommentChatHistory>({
    queryKey: queryKeys.commentChatHistory(ticketId, commentId, repoPath),
    queryFn: async () => {
      const response = await fetch(
        `/api/engineer/symphony/comment-chat/${encodeURIComponent(commentId)}?ticketId=${encodeURIComponent(ticketId)}&repo=${encodeURIComponent(repoPath)}`
      );
      if (!response.ok) {
        return {
          messages: [],
          ticketId,
          repoPath,
          commentId,
          commentContext,
        };
      }
      return response.json();
    },
  });
}

export type FindingChatHistory = {
  messages: ChatMessage[];
  ticketId: string;
  repoPath: string;
  findingId: string;
  findingContext?: {
    severity: string;
    priority?: string;
    file?: string;
    line?: number;
    message: string;
    suggestion?: string;
  };
  sessionId?: string;
};

export function findingChatHistoryOptions(
  ticketId: string,
  findingId: string,
  repoPath: string
) {
  return queryOptions<FindingChatHistory>({
    queryKey: queryKeys.findingChatHistory(ticketId, findingId, repoPath),
    queryFn: async () => {
      const response = await fetch(
        `/api/engineer/codex/finding-chat/${encodeURIComponent(findingId)}?ticketId=${encodeURIComponent(ticketId)}&repo=${encodeURIComponent(repoPath)}`
      );
      if (!response.ok) {
        return { messages: [], ticketId, repoPath, findingId };
      }
      return response.json();
    },
  });
}

export function symphonyJudgesOptions(ticketId: string, repoPath: string) {
  return queryOptions<SymphonyJudgesResponse>({
    queryKey: queryKeys.symphonyJudges(ticketId, repoPath),
    queryFn: async () => {
      const response = await fetch(
        `/api/engineer/symphony/judges/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}`
      );
      return response.json();
    },
  });
}
