/**
 * Shared utilities for chat components
 */

import { readNdjsonLines } from "./stream-utils";

/**
 * Check if text looks like terminal/CLI output.
 * Detects box-drawing characters, ANSI codes, and common CLI patterns.
 */
export function isTerminalOutput(text: string): boolean {
  // Box-drawing characters commonly used in CLI output
  const terminalPatterns =
    /[━│┃┄┅┆┇┈┉┊┋╌╍╎╏═║╒╓╔╕╖╗╘╙╚╛╜╝╞╟╠╡╢╣╤╥╦╧╨╩╪╫╬─├┤┬┴┼]/;
  // ANSI escape codes (may be partially stripped)
  const ansiPattern = /\x1b\[|\u001b\[/;
  // Common CLI tool output patterns (biome, eslint, etc.)
  const cliPatterns = /(?:✖|✓|⚠|ℹ|›)\s|^\s*>\s*\d+\s*│/m;

  return (
    terminalPatterns.test(text) ||
    ansiPattern.test(text) ||
    cliPatterns.test(text)
  );
}

/**
 * Format timestamp for display in chat messages
 */
export function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

/**
 * Suggested action parsed from assistant message content
 */
export type SuggestedAction = {
  label: string;
  message: string;
  /** Optional semantic type parsed from the action tag (e.g., "accept-changes") */
  type?: string;
};

/**
 * Parse suggested action buttons from assistant message content.
 * Looks for <suggested-actions><action label="...">message</action></suggested-actions> blocks.
 * Returns the actions and the content with the action block removed.
 */
export function parseSuggestedActions(content: string): {
  actions: SuggestedAction[];
  contentWithoutActions: string;
} {
  const actionsMatch =
    /<suggested-actions>([\s\S]*?)<\/suggested-actions>/.exec(content);
  if (!actionsMatch) {
    return { actions: [], contentWithoutActions: content };
  }

  const actionsBlock = actionsMatch[1];
  const actions: SuggestedAction[] = [];

  // Parse individual action tags (with optional type attribute)
  for (const match of actionsBlock.matchAll(
    /<action\s+label="([^"]*)"(?:\s+type="([^"]*)")?\s*>([\s\S]*?)<\/action>/g
  )) {
    actions.push({
      label: match[1],
      message: match[3].trim(),
      ...(match[2] ? { type: match[2] } : {}),
    });
  }

  // Remove the entire suggested-actions block from the content
  const contentWithoutActions = content
    .replace(/<suggested-actions>[\s\S]*?<\/suggested-actions>/, "")
    .trim();

  return { actions, contentWithoutActions };
}

/**
 * Stream event types that can be received from chat API responses
 */
export type StreamEvent = {
  type: string;
  pid?: number;
  content?: string;
  status?: string;
  error?: string;
  name?: string;
  input?: unknown;
  id?: string;
  is_error?: boolean;
  contextPercent?: number;
};

/**
 * Handlers for processing stream events
 */
export type StreamEventHandlers = {
  onText: (content: string) => void;
  onToolUse?: (tool: { name: string; input: unknown; id: string }) => void;
  onToolResult?: (result: {
    id: string;
    content: string;
    is_error: boolean;
  }) => void;
  onThinking?: (content: string) => void;
  onError: (error: string) => void;
  onComplete: () => void;
  onPid?: (pid: number) => void;
  onLearnings?: () => void;
  onUsage?: (contextPercent: number) => void;
  /** Called for every raw parsed JSON event before dispatch. */
  onEvent?: (event: Record<string, unknown>) => void;
};

/**
 * Read streaming response from chat API and dispatch events to handlers
 */
function dispatchStreamEvent(
  event: StreamEvent,
  handlers: StreamEventHandlers,
  accumulated: string
): string {
  if (event.type === "status" && event.pid && handlers.onPid) {
    handlers.onPid(event.pid);
  } else if (event.type === "text" && event.content) {
    const next = accumulated + event.content;
    handlers.onText(next);
    return next;
  } else if (
    event.type === "tool_use" &&
    handlers.onToolUse &&
    event.name &&
    event.id
  ) {
    handlers.onToolUse({ name: event.name, input: event.input, id: event.id });
  } else if (
    event.type === "tool_result" &&
    handlers.onToolResult &&
    event.id
  ) {
    handlers.onToolResult({
      id: event.id,
      content: formatToolResultContent(event.content),
      is_error: event.is_error ?? false,
    });
  } else if (
    event.type === "thinking" &&
    event.content &&
    handlers.onThinking
  ) {
    handlers.onThinking(event.content);
  } else if (
    event.type === "reasoning" &&
    event.content &&
    handlers.onThinking
  ) {
    handlers.onThinking(event.content);
  } else if (
    event.type === "learnings" &&
    event.status === "triggered" &&
    handlers.onLearnings
  ) {
    handlers.onLearnings();
  } else if (
    event.type === "usage" &&
    event.contextPercent != null &&
    handlers.onUsage
  ) {
    handlers.onUsage(event.contextPercent);
  } else if (event.type === "error" && event.error) {
    handlers.onError(event.error);
  } else if (event.type === "result" || event.type === "done") {
    handlers.onComplete();
  }
  return accumulated;
}

export async function readChatStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  handlers: StreamEventHandlers
): Promise<void> {
  let accumulated = "";

  for await (const line of readNdjsonLines(reader)) {
    try {
      const parsed = JSON.parse(line);
      handlers.onEvent?.(parsed);
      accumulated = dispatchStreamEvent(parsed, handlers, accumulated);
    } catch {
      // Not JSON - ignore
    }
  }
}

/**
 * Construct worktree path from base repo path and ticket ID.
 *
 * @param worktreeParentDir - The configured worktree parent directory (e.g. "~/Source").
 *   When provided, the worktree is resolved as `{worktreeParentDir}/{repoName}-{ticketId}`.
 *   When omitted, falls back to assuming the worktree is a sibling of the repo (legacy behavior).
 */
export function getWorktreePath(
  baseRepoPath: string,
  ticketId: string,
  worktreeParentDir?: string
): string {
  const repoName = baseRepoPath.split("/").pop() || "";
  if (worktreeParentDir) {
    const dir = worktreeParentDir.endsWith("/")
      ? worktreeParentDir.slice(0, -1)
      : worktreeParentDir;
    return `${dir}/${repoName}-${ticketId}`;
  }
  const sourceDir = baseRepoPath.replace(/\/[^/]+$/, "");
  return `${sourceDir}/${repoName}-${ticketId}`;
}

/**
 * Strip <context>...</context> blocks from message content.
 * These blocks carry review/ticket data for Claude but should be hidden in the UI.
 */
export function stripContextBlocks(content: string): string {
  return content
    .replaceAll(/<context(?:\s+[^>]*)?>[\s\S]*?<\/context>/g, "")
    .trim();
}

/**
 * Structured debate status parsed from <debate-status> blocks.
 */
export type DebateStatus = {
  pendingIssues: { id: string; summary: string }[];
  resolvedIssues: { id: string; summary: string; resolution: string }[];
};

/**
 * Extract and parse a <debate-status> JSON block from content.
 * Returns the cleaned content (with the block stripped) and the parsed status (or null).
 */
export function parseDebateStatus(content: string): {
  cleanContent: string;
  status: DebateStatus | null;
} {
  const match = /<debate-status>([\s\S]*?)<\/debate-status>/.exec(content);
  if (!match) {
    return { cleanContent: content, status: null };
  }
  const cleanContent = content
    .replace(/<debate-status>[\s\S]*?<\/debate-status>/, "")
    .trim();
  try {
    return { cleanContent, status: JSON.parse(match[1]) as DebateStatus };
  } catch {
    return { cleanContent, status: null };
  }
}

/**
 * A single extracted <context> block from user message content.
 */
export type ExtractedContextBlock = {
  id: string;
  title: string;
  body: string;
  source?: string;
  file?: string;
};

/**
 * Extract all <context>...</context> blocks from user message content.
 * Supports blocks anywhere in the message, with optional source/file attributes.
 * Returns the extracted blocks and the remaining text with blocks removed.
 */
export function extractContextBlocks(content: string): {
  blocks: ExtractedContextBlock[];
  remaining: string;
} {
  const blocks: ExtractedContextBlock[] = [];
  const regex =
    /<context(?:\s+source="([^"]*)")?(?:\s+file="([^"]*)")?>(?:\n?)([\s\S]*?)(?:\n?)<\/context>/g;
  let idx = 0;
  for (const match of content.matchAll(regex)) {
    const source = match[1] || undefined;
    const file = match[2] || undefined;
    const body = match[3].trim();
    const headingMatch = /^#+\s+(.+)$/m.exec(body);
    const title = source
      ? source.charAt(0).toUpperCase() + source.slice(1)
      : headingMatch
        ? headingMatch[1].slice(0, 60)
        : "Context";
    blocks.push({ id: `ctx-${idx}`, title, body, source, file });
    idx++;
  }
  const remaining =
    blocks.length > 0
      ? content
          .replaceAll(/<context(?:\s+[^>]*)?>[\s\S]*?<\/context>/g, "")
          .trim()
      : content;
  return { blocks, remaining };
}

/**
 * A learning that was applied by the assistant in its response.
 */
export type LearningUsed = {
  id: string;
  source: string;
  category: string;
  summary: string;
  confidence?: string;
  context?: string[];
};

/**
 * Strip complete <learnings-used>...</learnings-used> blocks AND any incomplete
 * opening tag at the end of streaming content (e.g. `<learnings-used>[{"id":...`).
 * This prevents raw tag text from flashing during streaming.
 */
function stripLearningsBlock(text: string): string {
  // First strip complete blocks
  let result = text.replaceAll(
    /<learnings-used>[\s\S]*?<\/learnings-used>/g,
    ""
  );
  // Then truncate any incomplete opening tag still being streamed
  const partialIdx = result.indexOf("<learnings-used>");
  if (partialIdx !== -1) {
    result = result.slice(0, partialIdx);
  }
  return result.trim();
}

/**
 * Extract and parse a <learnings-used> JSON block from content.
 * Returns the cleaned content (with complete and partial blocks stripped) and the parsed learnings.
 */
export function parseLearningsUsed(content: string): {
  cleanContent: string;
  learnings: LearningUsed[];
} {
  const match = /<learnings-used>([\s\S]*?)<\/learnings-used>/.exec(content);
  if (!match) {
    return { cleanContent: stripLearningsBlock(content), learnings: [] };
  }
  const cleanContent = stripLearningsBlock(content);
  try {
    const parsed = JSON.parse(match[1]) as LearningUsed[];
    return { cleanContent, learnings: Array.isArray(parsed) ? parsed : [] };
  } catch {
    return { cleanContent, learnings: [] };
  }
}

/**
 * Strip <learnings-used> blocks from content without parsing.
 * Handles both complete and incomplete (mid-stream) blocks.
 */
export function stripLearningsUsed(content: string): string {
  return stripLearningsBlock(content);
}

/**
 * Format tool result content for display.
 * Handles strings, arrays, objects, and primitives.
 */
export function formatToolResultContent(content: unknown): string {
  if (content === null || content === undefined) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "string" ? c : JSON.stringify(c, null, 2)))
      .join("\n");
  }
  return JSON.stringify(content, null, 2);
}

export const MAX_CONFERRAL_DEPTH = 3;

/**
 * Sentinel strings used as user message content to mark status transitions.
 * These are never displayed as chat text — they render as StatusNote indicators.
 */
export const CHAT_SENTINEL = {
  DEBATE_STARTED: "__debate_started__",
  DEBATE_ENDED: "__debate_ended__",
  FORWARDED_TO_CLAUDE: "__forwarded_to_claude__",
  FORWARDED_TO_CODEX: "__forwarded_to_codex__",
  CLAUDE_CONFERRED_TO_CODEX: "__claude_conferred_to_codex__",
  CODEX_CONFERRED_TO_CLAUDE: "__codex_conferred_to_claude__",
} as const;

export type ChatSentinel = (typeof CHAT_SENTINEL)[keyof typeof CHAT_SENTINEL];

/**
 * Detect an @codex or @claude conferral mention near the end of an LLM response.
 * Only detects the *other* LLM (Claude → @codex, Codex → @claude).
 *
 * Returns the mention info with cleaned content, or null if no mention found.
 */
export function parseConferralMention(
  content: string,
  currentSender: "claude" | "codex"
): { target: "claude" | "codex"; prompt: string; cleanContent: string } | null {
  const targetTag = currentSender === "claude" ? "@codex" : "@claude";
  const target: "claude" | "codex" =
    currentSender === "claude" ? "codex" : "claude";

  // Strip fenced code blocks before scanning to avoid false positives
  const stripped = content.replaceAll(/```[\s\S]*?```/g, "");

  // Only scan the last 500 chars (LLMs are instructed to put conferrals at end)
  const tail = stripped.slice(-500);

  // Line-start anchor: the @mention must start at the beginning of a line
  const pattern = new RegExp(`(?:^|\\n)${targetTag}\\s+(.{5,})`, "i");
  const match = pattern.exec(tail);
  if (!match) {
    return null;
  }

  const prompt = match[1].trim();

  // Remove the @mention line from original content
  const mentionLinePattern = new RegExp(
    `\\n?${targetTag}\\s+${match[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
    "i"
  );
  const cleanContent = content.replace(mentionLinePattern, "").trim();

  return { target, prompt, cleanContent };
}

/**
 * Strip protocol metadata (context blocks, learnings, conferral) but NOT suggested actions.
 * Use when you've already called parseSuggestedActions separately.
 */
export function stripProtocolMetadata(content: string): string {
  let cleaned = stripContextBlocks(content);
  cleaned = stripLearningsUsed(cleaned);
  for (const sender of ["claude", "codex"] as const) {
    const mention = parseConferralMention(cleaned, sender);
    if (mention) {
      cleaned = mention.cleanContent;
    }
  }
  return cleaned.trim();
}

/**
 * Strip all protocol metadata from assistant content.
 * Removes suggested actions, context blocks, learnings, and conferral mentions.
 */
export function stripAssistantProtocol(content: string): string {
  const { contentWithoutActions } = parseSuggestedActions(content);
  return stripProtocolMetadata(contentWithoutActions);
}

export const SENTINEL_VALUES: Set<string> = new Set(
  Object.values(CHAT_SENTINEL)
);

/**
 * Sanitize persisted message arrays before sending as context to Claude/Codex.
 * Drops sentinel-only user messages and strips protocol from assistant content.
 */
export function sanitizeHistoryForModel(
  messages: { role: string; content: string; sender?: string }[]
): { role: string; content: string; sender?: string }[] {
  return messages
    .filter((m) => !(m.role === "user" && SENTINEL_VALUES.has(m.content)))
    .map((m) =>
      m.role === "assistant"
        ? { ...m, content: stripAssistantProtocol(m.content) }
        : m
    );
}
