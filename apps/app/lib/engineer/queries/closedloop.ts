import {
  type CaseScore as EvaluationCaseScore,
  type MetricStatistics as EvaluationMetricStatistics,
  EvalStatus as EvaluationStatus,
  type EvalStatus as EvaluationStatusType,
  type JudgesReport,
} from "@repo/api/src/types/evaluation";
import { queryOptions } from "@tanstack/react-query";
import type {
  ChatMessage as EngineerChatMessage,
  ContentBlock as EngineerContentBlock,
} from "@/components/chat/types";
import { queryKeys } from "./keys";

export type ChatMessage = EngineerChatMessage;
export type ContentBlock = EngineerContentBlock;

/* ---------- Response types ---------- */

export type ActiveAgent = {
  agentId: string;
  agentType: string;
  agentName: string;
  startedAt: string;
};

export type ClosedLoopStatusResponse = {
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
  liveActivity?: string;
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
  contextPercent?: number | null;
  sessionId?: string;
  codexSessionExists?: boolean;
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
  contextPercent?: number | null;
};

export type LogResponse = {
  exists: boolean;
  format: "jsonl" | "text";
  content?: string; // For text format
  lines?: string[]; // For jsonl format - raw JSONL strings
  totalLines?: number;
  returnedLines?: number;
};

export const EvalStatus = EvaluationStatus;
export type EvalStatus = EvaluationStatusType;
export type CaseScore = EvaluationCaseScore;
export type MetricStatistics = EvaluationMetricStatistics;
export type EvaluationReport = JudgesReport;

export type ClosedLoopJudgesResponse = {
  exists: boolean;
  isMock: boolean;
  data?: EvaluationReport;
  error?: string;
  message?: string;
  worktreeDir?: string;
};

/* ---------- Query option factories ---------- */

export function closedloopStatusOptions(
  ticketId: string,
  repoPath: string | null
) {
  return queryOptions<ClosedLoopStatusResponse>({
    queryKey: queryKeys.closedloopStatus(ticketId, repoPath),
    queryFn: async () => {
      const response = await fetch(
        `/api/gateway/symphony/status/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath || "")}`
      );
      if (!response.ok) {
        throw new Error(`Failed to fetch symphony status: ${response.status}`);
      }
      return response.json();
    },
    enabled: !!repoPath,
  });
}

export function closedloopPlanOptions(ticketId: string, repoPath: string) {
  return queryOptions<PlanResponse>({
    queryKey: queryKeys.closedloopPlan(ticketId, repoPath),
    queryFn: async () => {
      const response = await fetch(
        `/api/gateway/symphony/plan/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}`
      );
      if (!response.ok) {
        throw new Error(`Failed to fetch symphony plan: ${response.status}`);
      }
      return response.json();
    },
  });
}

export function closedloopChatHistoryOptions(
  ticketId: string,
  repoPath: string,
  provider?: string
) {
  return queryOptions<ChatHistory>({
    queryKey: queryKeys.closedloopChatHistory(ticketId, repoPath, provider),
    queryFn: async () => {
      let url = `/api/gateway/symphony/chat-history/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}`;
      if (provider) {
        url += `&provider=${encodeURIComponent(provider)}`;
      }
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch chat history: ${response.status}`);
      }
      return response.json();
    },
  });
}

export function closedloopLogsOptions(ticketId: string, repoPath: string) {
  return queryOptions<LogResponse>({
    queryKey: queryKeys.closedloopLogs(ticketId, repoPath),
    queryFn: async () => {
      const response = await fetch(
        `/api/gateway/symphony/logs/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}&lines=1000`
      );
      if (!response.ok) {
        throw new Error(`Failed to fetch symphony logs: ${response.status}`);
      }
      return response.json();
    },
  });
}

export function commentChatHistoryOptions(
  ticketId: string,
  commentId: string,
  repoPath: string,
  commentContext: {
    author: string;
    body: string;
    path?: string;
    line?: number;
  },
  branchName?: string,
  prNumber?: number
) {
  return queryOptions<CommentChatHistory>({
    queryKey: queryKeys.commentChatHistory(ticketId, commentId, repoPath),
    queryFn: async () => {
      let url = `/api/gateway/symphony/comment-chat/${encodeURIComponent(commentId)}?ticketId=${encodeURIComponent(ticketId)}&repo=${encodeURIComponent(repoPath)}`;
      if (branchName && prNumber != null) {
        url += `&branch=${encodeURIComponent(branchName)}&prNumber=${prNumber}`;
      }
      const response = await fetch(url);
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
  contextPercent?: number | null;
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
        `/api/gateway/codex/finding-chat/${encodeURIComponent(findingId)}?ticketId=${encodeURIComponent(ticketId)}&repo=${encodeURIComponent(repoPath)}`
      );
      if (!response.ok) {
        return { messages: [], ticketId, repoPath, findingId };
      }
      return response.json();
    },
  });
}

export function closedloopJudgesOptions(ticketId: string, repoPath: string) {
  return queryOptions<ClosedLoopJudgesResponse>({
    queryKey: queryKeys.closedloopJudges(ticketId, repoPath),
    queryFn: async () => {
      const response = await fetch(
        `/api/gateway/symphony/judges/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}`
      );
      if (!response.ok) {
        throw new Error(`Failed to fetch judges: ${response.status}`);
      }
      return response.json();
    },
  });
}
