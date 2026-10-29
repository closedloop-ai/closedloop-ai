/**
 * @file copilot-cli-events.ts
 * @description The Copilot CLI (`gh copilot`) event-stream handlers: one small
 * named function per `events.jsonl` event type, plus the alias→handler table
 * `parseCliEventFile` dispatches through.
 *
 * Extracted from `copilot-parser.ts` (ISS-6885), which owns two unrelated
 * on-disk formats — the VS Code chat session JSON and this JSONL event stream.
 * Splitting the CLI half out keeps each module to one format and brings the
 * parser back under the 1,000-logical-line ceiling. Pure move: no handler
 * behavior changed.
 */
import {
  isMeaningfulCwd,
  pushTurnDuration,
  safeJson,
  truncateText,
} from "../parsing/parser-utils.js";
import type { BaseSessionAccumulator } from "./copilot-session-accumulator.js";
import { extractText } from "./copilot-text.js";
import { hasTokenFields, readCopilotUsage } from "./copilot-token-fields.js";

/**
 * Mutable per-session accumulator shared by the Copilot CLI event handlers.
 * Mirrors the chat-loop accumulator pattern: bundling the running state lets each
 * event handler be a small named function instead of an inline `if (type === …)`
 * branch in `parseCliEventFile`.
 */
export type CliEventAccumulator = BaseSessionAccumulator & {
  cwd: string | null;
  model: string | null;
  version: string | null;
};

/** Per-event context resolved once and passed to each CLI event handler. */
export type CliEventContext = {
  type: string;
  payload: Record<string, unknown>;
  iso: string | null;
  /** CR-5: Per-event model override (`payload.model ?? rec.model`), null if absent. */
  eventModel: string | null;
  /** Synthetic-model flag for the resolved per-event model. */
  synthetic: true | undefined;
};

/** Capture session metadata (cwd/version/model) from a session-start event. */
function handleCliSessionMeta(
  acc: CliEventAccumulator,
  { payload }: CliEventContext
): void {
  if (!acc.cwd) {
    const candidate = (payload.cwd || payload.workdir || null) as string | null;
    if (isMeaningfulCwd(candidate)) {
      acc.cwd = candidate;
    }
  }
  if (!acc.version) {
    acc.version = (payload.version || payload.cli_version || null) as
      | string
      | null;
  }
  if (!acc.model) {
    acc.model = (payload.model || null) as string | null;
  }
}

/** Handle a user/prompt event: count it, open a turn, emit the human message. */
function handleCliUserMessage(
  acc: CliEventAccumulator,
  { payload, iso, eventModel, synthetic }: CliEventContext
): void {
  acc.userMessageCount++;
  if (iso) {
    acc.pendingTurnStartedAt = iso;
  }
  // CR-1: User message with text content
  const userText = extractText(
    payload.content ??
      payload.message ??
      payload.text ??
      payload.prompt ??
      payload
  );
  acc.normalizedMessages.push({
    role: "human",
    timestamp: iso,
    text: truncateText(userText),
    model: eventModel,
    ...(synthetic ? { isSynthetic: true } : {}),
  });
}

/** Handle an assistant/response event: count it, close the turn, emit the message. */
function handleCliAssistantMessage(
  acc: CliEventAccumulator,
  { payload, iso, eventModel, synthetic }: CliEventContext
): void {
  acc.assistantMessageCount++;
  if (iso) {
    acc.messageTimestamps.push(iso);
  }
  pushTurnDuration(acc.turnDurations, acc.pendingTurnStartedAt, iso);
  acc.pendingTurnStartedAt = null;
  // CR-1: Assistant message with text content
  const assistantText = extractText(
    payload.content ??
      payload.message ??
      payload.text ??
      payload.response ??
      payload
  );
  acc.normalizedMessages.push({
    role: "assistant",
    timestamp: iso,
    text: truncateText(assistantText),
    model: eventModel,
    ...(synthetic ? { isSynthetic: true } : {}),
  });
}

/** Handle a tool/function/command call event. */
function handleCliToolCall(
  acc: CliEventAccumulator,
  { payload, iso }: CliEventContext
): void {
  acc.toolUses.push({
    name: String(
      payload.name || payload.tool || payload.command || "copilot_tool"
    ),
    timestamp: iso || acc.firstTimestamp,
    input: safeJson(payload.arguments || payload.input),
  });
}

/**
 * CR-3: Back-link a tool result to the most recent matching tool use that is
 * still missing output.
 */
function handleCliToolResult(
  acc: CliEventAccumulator,
  { payload }: CliEventContext
): void {
  const resultName = String(payload.name || payload.tool || "copilot_tool");
  const rawContent =
    payload.content ?? payload.result ?? payload.output ?? null;
  const contentText =
    typeof rawContent === "string" ? truncateText(rawContent) : rawContent;
  const resultIsError = Boolean(
    payload.isError || payload.is_error || payload.error
  );
  const matchIdx = acc.toolUses.findLastIndex(
    (tu) => tu.name === resultName && tu.output == null
  );
  if (matchIdx >= 0) {
    if (contentText != null) {
      acc.toolUses[matchIdx].output = contentText;
    }
    if (resultIsError) {
      acc.toolUses[matchIdx].isError = true;
    }
  }
}

/**
 * Handle a usage/token_count/metrics event: replace the running token totals
 * (last event wins) and append a tokenSeries point.
 */
function handleCliUsage(
  acc: CliEventAccumulator,
  { payload, iso, eventModel }: CliEventContext
): void {
  const info = (payload.usage || payload) as Record<string, unknown>;
  const tokens = readCopilotUsage(info, "copilot.cli_usage");
  acc.tokenFields.input = tokens.input;
  acc.tokenFields.output = tokens.output;
  acc.tokenFields.cacheRead = tokens.cacheRead;
  acc.tokenFields.cacheWrite = tokens.cacheWrite;
  if (payload.model) {
    acc.model = payload.model as string;
  }

  // CR-2: Push per-event token record for time-series
  if (iso) {
    const usageModel = eventModel || acc.model || "copilot-default";
    if (hasTokenFields(tokens)) {
      acc.tokenSeries.push({
        timestamp: iso,
        model: usageModel,
        input: tokens.input,
        output: tokens.output,
        cacheRead: tokens.cacheRead,
        cacheWrite: tokens.cacheWrite,
      });
    }
  }
}

/** Handle an error/api_error event. */
function handleCliError(
  acc: CliEventAccumulator,
  { type, payload, iso }: CliEventContext
): void {
  acc.apiErrors.push({
    type: String(type),
    message: String(payload.message || payload.error || "Copilot CLI error"),
    timestamp: iso,
  });
}

/**
 * Handle a reasoning/thinking event. Copilot provides a boolean-only thinking
 * flag, so emit a thinking indicator message with null text.
 */
function handleCliReasoning(
  acc: CliEventAccumulator,
  { iso, eventModel, synthetic }: CliEventContext
): void {
  acc.thinkingBlockCount++;
  // CR-1: Thinking indicator as message with null text
  acc.normalizedMessages.push({
    role: "assistant",
    timestamp: iso,
    text: null,
    model: eventModel,
    isThinking: true,
    ...(synthetic ? { isSynthetic: true } : {}),
  });
}

/** Event-type alias → handler for the CLI event loop (aliases share a handler). */
export const CLI_EVENT_HANDLERS = new Map<
  string,
  (acc: CliEventAccumulator, ctx: CliEventContext) => void
>([
  ["session_start", handleCliSessionMeta],
  ["session_created", handleCliSessionMeta],
  ["init", handleCliSessionMeta],
  ["user_message", handleCliUserMessage],
  ["user_input", handleCliUserMessage],
  ["prompt", handleCliUserMessage],
  ["assistant_message", handleCliAssistantMessage],
  ["response", handleCliAssistantMessage],
  ["completion", handleCliAssistantMessage],
  ["tool_call", handleCliToolCall],
  ["function_call", handleCliToolCall],
  ["command", handleCliToolCall],
  ["tool_result", handleCliToolResult],
  ["function_result", handleCliToolResult],
  ["command_result", handleCliToolResult],
  ["usage", handleCliUsage],
  ["token_count", handleCliUsage],
  ["metrics", handleCliUsage],
  ["error", handleCliError],
  ["api_error", handleCliError],
  ["reasoning", handleCliReasoning],
  ["thinking", handleCliReasoning],
]);
