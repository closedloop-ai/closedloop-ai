import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type ContentBlock,
  isToolResultEntry,
  LogEntryType,
  type ParsedLogEntry,
  parseJsonlLine,
} from "./jsonl-parse";

/** Read window size in bytes (64 KB) */
const READ_WINDOW = 64 * 1024;

/**
 * Human-friendly labels for tool_use block names.
 */
const TOOL_LABELS: Record<string, string> = {
  Read: "Reading files...",
  Glob: "Searching for files...",
  Grep: "Searching codebase...",
  Write: "Writing files...",
  Edit: "Editing files...",
  Bash: "Running commands...",
  Agent: "Running sub-agent...",
  Task: "Running sub-agent...",
  TaskCreate: "Managing tasks...",
  TaskUpdate: "Managing tasks...",
  WebFetch: "Researching...",
  WebSearch: "Researching...",
};

/**
 * Derive a user-facing activity label from an assistant entry's content blocks.
 */
function labelFromAssistant(blocks: ContentBlock[]): string {
  // Check for tool_use first
  for (const block of blocks) {
    if (block.type === "tool_use" && block.name) {
      return TOOL_LABELS[block.name] ?? "Working...";
    }
  }

  // Then thinking
  for (const block of blocks) {
    if (block.type === "thinking") {
      return "Analyzing...";
    }
  }

  // Then text
  for (const block of blocks) {
    if (block.type === "text") {
      return "Processing...";
    }
  }

  return "Working...";
}

/**
 * Derive a user-facing activity label from a single parsed entry.
 */
function labelFromEntry(entry: ParsedLogEntry): string {
  if (entry.type === LogEntryType.Assistant) {
    const content = entry.message?.content;
    if (Array.isArray(content)) {
      return labelFromAssistant(content);
    }
    return "Processing...";
  }

  if (entry.type === LogEntryType.User && isToolResultEntry(entry)) {
    return "Processing tool results...";
  }

  // system, progress, queue-operation
  return "Working...";
}

/**
 * Read the tail of claude-output.jsonl and derive a live activity label.
 *
 * Returns undefined if the file doesn't exist or no parseable entries are found.
 */
export async function readLiveActivity(
  worktreeDir: string
): Promise<string | undefined> {
  const jsonlPath = join(
    worktreeDir,
    ".closedloop-ai",
    "work",
    "claude-output.jsonl"
  );

  let fileSize: number;
  try {
    const st = await stat(jsonlPath);
    fileSize = st.size;
  } catch {
    return undefined;
  }

  if (fileSize === 0) {
    return undefined;
  }

  const readSize = Math.min(fileSize, READ_WINDOW);
  const offset = fileSize - readSize;

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(jsonlPath, "r");
    const buffer = Buffer.alloc(readSize);
    await handle.read(buffer, 0, readSize, offset);
    const text = buffer.toString("utf-8");

    const rawLines = text.split("\n");

    // When reading from the middle of the file, the first line is likely truncated
    const lines = offset > 0 ? rawLines.slice(1) : rawLines;

    // Walk in reverse, skip subagent noise
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) {
        continue;
      }

      const entry = parseJsonlLine(line);
      if (!entry) {
        continue;
      }

      // Skip subagent entries
      if (entry.parentToolUseId) {
        continue;
      }

      // Skip file-history-snapshot (not meaningful for activity)
      if (entry.type === LogEntryType.FileHistorySnapshot) {
        continue;
      }

      // Skip real user prompts — only tool_result user entries are interesting
      if (entry.type === LogEntryType.User && !isToolResultEntry(entry)) {
        continue;
      }

      return labelFromEntry(entry);
    }

    return undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}
