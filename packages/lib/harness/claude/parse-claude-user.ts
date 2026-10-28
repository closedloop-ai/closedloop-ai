import { estimateAgentComponentFootprintTokens } from "@repo/api/src/types/agent-component-footprint";
import {
  asRecord,
  stringValue,
  toIso,
  toolResultText,
  truncateText,
} from "../parser-utils";
import { recordToolResultFacts } from "../tool-result-facts";
import { captureDiffStatsReadResult } from "./diff-stats-tool-handlers";
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
  accumulator: SessionAccumulator,
  replayed: boolean
): void {
  const { text, hasToolResult } = readUserContent(record, accumulator);
  const timestamp = toIso(record.timestamp);
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
        ...(replayed ? { isForkReplayed: true } : {}),
      });
      // A `/model` switch echoes its new model here as a DISPLAY name. Last-wins,
      // so a session that switched twice reports the one left in effect.
      accumulator.modelSwitchLabel =
        extractModelSwitchLabel(text) ?? accumulator.modelSwitchLabel;
    }
  } else {
    // ISS-8659: the message is kept either way — it is the fork's inherited
    // conversation, and dropping it opens session detail mid-thread. What a
    // replayed record must not do is credit the fork with a human turn the
    // PARENT typed, or with the command that turn ran.
    pushHumanTurn(accumulator, timestamp, text, replayed);
    if (!replayed) {
      collectSlashCommands(record, text, timestamp, accumulator);
    }
  }

  // A failed tool result is reported on the record's own `toolUseResult`, which
  // is separate from the content blocks above and survives whichever branch the
  // turn took.
  // ISS-8659: a replayed failure is the PARENT's. Counting it reported errors
  // against a session in which nothing failed.
  const toolUseResult = replayed ? {} : asRecord(record.toolUseResult);
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
  let hasToolResult = false;
  for (const raw of Array.isArray(content) ? content : []) {
    const block = asRecord(raw);
    if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
      hasToolResult = true;
      applyToolResult(record, block, accumulator);
    }
  }
  return { text: contentBlockText(content), hasToolResult };
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
  if (accumulator.attributionEvidence) {
    recordToolResultFacts(toolUse, resultText, block.is_error === true);
  }
  toolUse.output = truncateText(resultText);
  // ISS-10736: counted from the UNTRUNCATED text, above the cap `output` takes.
  if (resultText !== null && resultText !== undefined) {
    toolUse.outputFootprintTokens =
      estimateAgentComponentFootprintTokens(resultText);
  }
  if (block.is_error) {
    toolUse.isError = true;
  }
  if (!block.is_error && toolUse.name === "Read") {
    captureDiffStatsReadResult(accumulator, toolUse.input, resultText);
  }
  const resultTimestamp = toIso(record.timestamp);
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

/** Whether the runtime wrote this `user` record itself. */
function isSyntheticUserRecord(record: Record<string, unknown>): boolean {
  if (record.isMeta === true || record.isCompactSummary === true) {
    return true;
  }
  return !isHumanOrigin(record.origin);
}

/** The reportable text of a failed tool result, bounded for storage. */
function errorContent(content: unknown): string {
  const text =
    typeof content === "string" ? content : JSON.stringify(content ?? "");
  return text.slice(0, TOOL_RESULT_ERROR_MAX_CHARS);
}

/**
 * Whether an `origin` marks a turn a person typed.
 *
 * Newer harnesses stamp `origin.kind` on GENUINELY typed prompts too, so only a
 * kind other than `human` marks a synthetic turn: an absent origin and an
 * explicitly human one both mean a real person. Two record shapes carry the
 * field in different places — a `user` record's own `origin`, and a
 * `queued_command` attachment's (ISS-12625) — so the convention lives here
 * rather than once per reader.
 */
export function isHumanOrigin(origin: unknown): boolean {
  const kind = asRecord(origin).kind;
  if (typeof kind === "string" && kind.length > 0) {
    return kind === "human";
  }
  return true;
}

/**
 * ISS-8659: a replayed turn is kept but not counted — it is the fork's
 * inherited conversation, and crediting the child with the parent's typing is
 * what the flag exists to prevent.
 */
export function pushHumanTurn(
  accumulator: SessionAccumulator,
  timestamp: string | null,
  text: string,
  replayed: boolean
): void {
  if (!replayed) {
    accumulator.userMessageCount++;
  }
  accumulator.messages.push({
    role: "human",
    timestamp,
    text: truncateText(text),
    ...(replayed ? { isForkReplayed: true } : {}),
  });
}

/**
 * The visible text of a `content`-shaped value: the plain string form, or the
 * `text` blocks of the block-array form joined.
 *
 * Both shapes reach a human turn. ISS-12625 (PR #8942 review, tamsinb): a
 * queued prompt arrives as blocks whenever something was pasted alongside it,
 * so reading only the string form dropped those prompts with no turn and no
 * drift line — the same silent loss the ticket was filed for. Non-text blocks
 * are skipped rather than flattened: an image block's payload is base64, not
 * something a person typed.
 */
export function contentBlockText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  const parts: string[] = [];
  for (const raw of Array.isArray(content) ? content : []) {
    const block = asRecord(raw);
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}
