// Execution log types for API contract
// These types represent parsed agent execution traces from JSONL logs

// Tool call within a conversation entry
export type ToolCall = {
  name: string;
  input: Record<string, unknown>;
  result: string | null;
  truncated?: boolean;
};

// Parsed JSONL conversation entry
export type ConversationEntry = {
  role: "user" | "assistant";
  content: string;
  timestamp: string; // ISO 8601
  toolCalls?: ToolCall[];
};

// Statistics for a single agent session
export type SessionStats = {
  messageCount: number;
  toolCallCount: number;
  duration: number | null; // milliseconds
};

// Single agent conversation session
export type AgentSession = {
  sessionId: string;
  agentLabel: string; // derived from firstPrompt
  parentSessionId: string | null; // for sub-agents
  entries: ConversationEntry[];
  stats: SessionStats;
};

// Session metadata from sessions-index.json
export type SessionIndexEntry = {
  sessionId: string;
  path: string;
  created: string; // ISO 8601
};

// Top-level execution trace response
export type ExecutionTrace = {
  sessions: AgentSession[];
  totalSessions: number;
  totalMessages: number;
  totalToolCalls: number;
  overallDuration: number | null; // milliseconds
};
