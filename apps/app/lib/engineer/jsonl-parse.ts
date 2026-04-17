/**
 * Shared JSONL parsing helpers for claude-output.jsonl.
 *
 * Used by both JsonlLogViewer (UI) and jsonl-activity (status API).
 */

/**
 * Parsed content block from a message
 */
export type ContentBlock = {
  type: "text" | "tool_use" | "tool_result" | "thinking";
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  content?: string | unknown[];
  is_error?: boolean;
};

/**
 * Entry types emitted by the Claude CLI JSONL output
 */
export const LogEntryType = {
  User: "user",
  Assistant: "assistant",
  System: "system",
  Progress: "progress",
  QueueOperation: "queue-operation",
  FileHistorySnapshot: "file-history-snapshot",
} as const;

export type LogEntryType = (typeof LogEntryType)[keyof typeof LogEntryType];

/**
 * Lightweight parsed JSONL entry (no uuid/rawLine — those are viewer-only)
 */
export type ParsedLogEntry = {
  type: LogEntryType;
  uuid?: string;
  timestamp?: string;
  parentToolUseId?: string;
  message?: {
    role?: string;
    content?: string | ContentBlock[];
  };
  data?: {
    type?: string;
    subtype?: string;
    hookEvent?: string;
    hookName?: string;
    command?: string;
    resultText?: string;
    durationMs?: number;
    durationApiMs?: number;
    numTurns?: number;
    stopReason?: string | null;
    totalCostUsd?: number;
    isError?: boolean;
  };
};

/**
 * Parse a single JSONL line into a ParsedLogEntry.
 * Returns null for malformed JSON or unknown entry types.
 */
export function parseJsonlLine(line: string): ParsedLogEntry | null {
  try {
    const parsed = JSON.parse(line);
    const entryType = parsed.type;

    // Result entries are lifecycle/system-like metadata emitted at turn/session boundaries.
    // Normalize to system so they render in viewer progress streams instead of being dropped.
    if (entryType === "result") {
      return {
        type: LogEntryType.System,
        uuid: parsed.uuid,
        timestamp: parsed.timestamp || "",
        parentToolUseId: parsed.parent_tool_use_id,
        message: undefined,
        data: {
          type: entryType,
          subtype: parsed.subtype,
          resultText:
            typeof parsed.result === "string" ? parsed.result : undefined,
          durationMs:
            typeof parsed.duration_ms === "number"
              ? parsed.duration_ms
              : undefined,
          durationApiMs:
            typeof parsed.duration_api_ms === "number"
              ? parsed.duration_api_ms
              : undefined,
          numTurns:
            typeof parsed.num_turns === "number" ? parsed.num_turns : undefined,
          stopReason:
            typeof parsed.stop_reason === "string" ||
            parsed.stop_reason === null
              ? parsed.stop_reason
              : undefined,
          totalCostUsd:
            typeof parsed.total_cost_usd === "number"
              ? parsed.total_cost_usd
              : undefined,
          isError:
            typeof parsed.is_error === "boolean" ? parsed.is_error : undefined,
        },
      };
    }

    // Map system entries
    if (entryType === LogEntryType.System) {
      return {
        type: LogEntryType.System,
        uuid: parsed.uuid,
        timestamp: parsed.timestamp || "",
        parentToolUseId: parsed.parent_tool_use_id,
        message: undefined,
        data: {
          type: entryType,
          subtype: parsed.subtype,
          hookEvent: parsed.hook_event,
          hookName: parsed.hook_name,
        },
      };
    }

    // Skip unknown types (e.g. content_block_delta)
    if (!isSupportedLogEntryType(entryType)) {
      return null;
    }

    return {
      type: entryType,
      uuid: parsed.uuid,
      timestamp: parsed.timestamp || "",
      parentToolUseId: parsed.parent_tool_use_id,
      message: parsed.message,
      data: parsed.data,
    };
  } catch {
    return null;
  }
}

/**
 * Check if a parsed entry is a tool result (vs an actual user prompt).
 */
export function isToolResultEntry(entry: ParsedLogEntry): boolean {
  if (entry.type !== LogEntryType.User) {
    return false;
  }
  const content = entry.message?.content;
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some((block) => block.type === "tool_result");
}

const SUPPORTED_LOG_ENTRY_TYPES = new Set<LogEntryType>([
  LogEntryType.User,
  LogEntryType.Assistant,
  LogEntryType.Progress,
  LogEntryType.QueueOperation,
  LogEntryType.FileHistorySnapshot,
]);

function isSupportedLogEntryType(value: unknown): value is LogEntryType {
  return (
    typeof value === "string" &&
    SUPPORTED_LOG_ENTRY_TYPES.has(value as LogEntryType)
  );
}
