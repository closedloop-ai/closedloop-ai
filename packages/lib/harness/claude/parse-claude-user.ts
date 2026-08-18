import {
  asRecord,
  stringValue,
  toolResultText,
  truncateText,
} from "../parser-utils";
import { captureDiffStatsReadResult } from "./diff-stats-tool-handlers";
import { isoTs } from "./parse-claude";
import {
  ClaudeRecordType,
  type SessionAccumulator,
  TOOL_RESULT_ERROR_MAX_CHARS,
} from "./parse-claude-accumulator";
import {
  CLAUDE_DELEGATION_TOOL_NAMES,
  delegationFromToolUseResult,
} from "./parse-claude-delegations";
import {
  collectUnknownAttributes,
  USER_ATTRIBUTES,
} from "./parse-claude-drift";
import { extractModelSwitchLabel } from "./parse-claude-model-switch-label";
import { collectSlashCommands } from "./parse-claude-slash-commands";
import {
  isAutomatedPromptInjection,
  isLocalCommandStdout,
} from "./prompt-injection";

/**
 * Decode a `user` record.
 *
 * The `user` role is OVERLOADED: it carries genuine human turns and several
 * kinds of synthetic turn the runtime writes under the same role. Counting them
 * all as human inflates every downstream measure that keys on human steering, so
 * the classification below is the point of this handler, not an aside.
 *
 * A turn is human unless it is one of:
 *   - tool-result only — the runtime's reply to a tool call, no human text;
 *   - a synthetic turn — meta expansion, compaction summary, or a non-human
 *     `origin.kind` such as a background-task notification;
 *   - an automated injection — a system-reminder block, a teammate message, a
 *     local command's echoed stdout, or a scheduled wake-up firing.
 *
 * The echoed stdout is kept rather than dropped: it is not human input, but it
 * is part of the transcript, so it lands as a `system` message with no
 * human-turn credit.
 */
export function processUserRecord(
  record: Record<string, unknown>,
  accumulator: SessionAccumulator
): void {
  const { text, hasToolResult } = readUserContent(record, accumulator);
  const timestamp = isoTs(record.timestamp);
  const toolResultOnly = hasToolResult && text.trim().length === 0;

  if (
    toolResultOnly ||
    isSyntheticUserRecord(record) ||
    isAutomatedPromptInjection(accumulator, text)
  ) {
    if (isLocalCommandStdout(text)) {
      accumulator.messages.push({
        role: "system",
        timestamp,
        text: truncateText(text),
      });
      // A `/model` switch echoes its new model here as a DISPLAY name. Last-wins,
      // so a session that switched twice reports the one left in effect.
      accumulator.modelSwitchLabel =
        extractModelSwitchLabel(text) ?? accumulator.modelSwitchLabel;
    }
  } else {
    accumulator.userMessageCount++;
    accumulator.messages.push({
      role: "human",
      timestamp,
      text: truncateText(text),
    });
    collectSlashCommands(record, text, timestamp, accumulator);
  }

  // A failed tool result is reported on the record's own `toolUseResult`, which
  // is separate from the content blocks above and survives whichever branch the
  // turn took.
  const toolUseResult = asRecord(record.toolUseResult);
  if (toolUseResult.is_error) {
    accumulator.toolResultErrors.push({
      content: errorContent(toolUseResult.content),
      timestamp,
    });
  }

  collectUnknownAttributes(
    ClaudeRecordType.User,
    record,
    USER_ATTRIBUTES,
    accumulator
  );
}

/**
 * A user record's visible text, and whether it answered a tool call. Applies
 * each `tool_result` to its originating tool along the way — the result arrives
 * on a later record than the call, so this is where the two are joined.
 */
function readUserContent(
  record: Record<string, unknown>,
  accumulator: SessionAccumulator
): {
  text: string;
  hasToolResult: boolean;
} {
  const content = asRecord(record.message).content;
  if (typeof content === "string") {
    return { text: content, hasToolResult: false };
  }
  const parts: string[] = [];
  let hasToolResult = false;
  for (const raw of Array.isArray(content) ? content : []) {
    const block = asRecord(raw);
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
    if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
      hasToolResult = true;
      applyToolResult(record, block, accumulator);
    }
  }
  return { text: parts.join("\n"), hasToolResult };
}

/**
 * Attach a tool result to the call it answers.
 *
 * Beyond the output itself this records the result's timestamp — a tool's real
 * duration is spawn-to-result, and only the result knows the end — and caches a
 * successful `Read` body so a later `Write` of the same path is diffed against
 * it rather than counted as an all-new file.
 */
function applyToolResult(
  record: Record<string, unknown>,
  block: Record<string, unknown>,
  accumulator: SessionAccumulator
): void {
  const index = accumulator.toolUseIdIndex.get(block.tool_use_id as string);
  const toolUse = index === undefined ? undefined : accumulator.toolUses[index];
  if (!toolUse) {
    // Source two, recovered: this line alone carries the child's id, type, and
    // prompt, so a transcript whose matching call line is missing or malformed
    // can still yield the kickoff instead of losing it. The helper self-gates on
    // the child id, so an ordinary tool result yields nothing.
    const orphan = delegationFromToolUseResult(
      stringValue(block.tool_use_id),
      record.toolUseResult
    );
    if (orphan) {
      accumulator.delegations.push(orphan);
    }
    return;
  }
  const resultText = toolResultText(block);
  toolUse.output = truncateText(resultText);
  if (block.is_error) {
    toolUse.isError = true;
  }
  if (!block.is_error && toolUse.name === "Read") {
    captureDiffStatsReadResult(accumulator, toolUse.input, resultText);
  }
  const resultTimestamp = isoTs(record.timestamp);
  if (resultTimestamp) {
    toolUse.resultTimestamp = resultTimestamp;
  }

  // Source two: the answering result names the spawned child on the same line as
  // the join key, so this is the only place the two can be tied together.
  if (CLAUDE_DELEGATION_TOOL_NAMES.has(toolUse.name)) {
    const delegation = delegationFromToolUseResult(
      stringValue(block.tool_use_id) ?? toolUse.id ?? null,
      record.toolUseResult,
      toolUse.input
    );
    if (delegation) {
      accumulator.delegations.push(delegation);
    }
  }
}

/**
 * Whether the runtime wrote this `user` record itself.
 *
 * `origin.kind` is the subtle one: newer harnesses stamp it on GENUINELY typed
 * prompts too, so only a kind other than `human` marks a synthetic turn — an
 * absent origin and an explicitly human one both mean a real person.
 */
function isSyntheticUserRecord(record: Record<string, unknown>): boolean {
  if (record.isMeta === true || record.isCompactSummary === true) {
    return true;
  }
  const kind = asRecord(record.origin).kind;
  return typeof kind === "string" && kind.length > 0 && kind !== "human";
}

/** The reportable text of a failed tool result, bounded for storage. */
function errorContent(content: unknown): string {
  const text =
    typeof content === "string" ? content : JSON.stringify(content ?? "");
  return text.slice(0, TOOL_RESULT_ERROR_MAX_CHARS);
}
