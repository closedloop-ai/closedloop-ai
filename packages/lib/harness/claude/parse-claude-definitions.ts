/**
 * @file parse-claude-definitions.ts
 * @description The agent, skill, and command DEFINITIONS a transcript carries —
 * the prompt text a component was invoked with, snapshotted so an invocation can
 * later be shown as what it actually ran rather than as what the file on disk
 * says today.
 */
import { AGENT_COMPONENT_INVOCATION_DEFINITION_CONTENT_MAX_BYTES } from "@repo/api/src/types/agent-component-invocation";
import { asRecord, stringValue } from "../parser-utils";
import type {
  NormalizedDefinitionKind,
  NormalizedDefinitionSnapshot,
  NormalizedSkillUse,
  NormalizedToolUse,
} from "../types";
import { isoTs } from "./parse-claude";
import type { SessionAccumulator } from "./parse-claude-accumulator";
import { CLAUDE_DELEGATION_TOOL_NAMES } from "./parse-claude-delegations";

/**
 * Attach the exact definition body the harness embedded for a skill, sub-agent,
 * or slash command.
 *
 * The body arrives as its own `isMeta` record, wrapped in a base-directory
 * header. That wrapper is the ONLY proof the text is definition content rather
 * than ordinary injected context, so an unwrapped meta record is ignored. The
 * record then points back at what it describes: a tool call by id, or a slash
 * command by the turn that invoked it.
 */
export function attachDefinitionSnapshot(
  record: Record<string, unknown>,
  accumulator: SessionAccumulator
): void {
  const content = embeddedDefinitionContent(record);
  if (content === null) {
    return;
  }
  const capturedAt = isoTs(record.timestamp);

  const sourceToolUseId = stringValue(record.sourceToolUseID);
  if (sourceToolUseId) {
    attachToolDefinition(sourceToolUseId, content, capturedAt, accumulator);
    return;
  }

  const promptId = stringValue(record.promptId);
  const commandIndex =
    promptId === null
      ? undefined
      : accumulator.slashCommandIndexByTurnId.get(promptId);
  const command =
    commandIndex === undefined
      ? undefined
      : accumulator.slashCommands[commandIndex];
  if (!command) {
    return;
  }
  const rawName =
    command.rawName ??
    (command.name.startsWith("/") ? command.name.slice(1) : command.name);
  command.definitionSnapshot = {
    kind: "command",
    rawName,
    normalizedName: command.normalizedName ?? command.name,
    content,
    capturedAt,
  };
}

/** Attach a definition to the tool call that triggered it, and its agent row. */
function attachToolDefinition(
  sourceToolUseId: string,
  content: string,
  capturedAt: string | null,
  accumulator: SessionAccumulator
): void {
  const index = accumulator.toolUseIdIndex.get(sourceToolUseId);
  const toolUse = index === undefined ? undefined : accumulator.toolUses[index];
  if (!toolUse) {
    return;
  }
  if (toolUse.skillName) {
    toolUse.definitionSnapshot = definitionSnapshot(
      "skill",
      toolUse.skillName,
      toolUse.skillName,
      content,
      capturedAt
    );
    return;
  }
  if (!CLAUDE_DELEGATION_TOOL_NAMES.has(toolUse.name)) {
    return;
  }
  const input = asRecord(toolUse.input);
  const rawName =
    stringValue(input.subagent_type) ?? stringValue(input.agent_type);
  if (!rawName) {
    return;
  }
  toolUse.definitionSnapshot = definitionSnapshot(
    "subagent",
    rawName,
    rawName,
    content,
    capturedAt
  );
  // The agent this call spawned carries the same definition. Matched on the
  // type it was asked for, or on the call that spawned it.
  for (const agent of accumulator.subagents.values()) {
    if (
      agent.type === rawName ||
      agent.name === rawName ||
      agent.nativeSubagentId === sourceToolUseId
    ) {
      agent.definitionSnapshot = toolUse.definitionSnapshot;
      break;
    }
  }
}

function definitionSnapshot(
  kind: NormalizedDefinitionKind,
  rawName: string,
  normalizedName: string,
  content: string,
  capturedAt: string | null
): NormalizedDefinitionSnapshot {
  return { kind, rawName, normalizedName, content, capturedAt };
}

/**
 * The definition body a record carries, or null when it is not one.
 *
 * Requires the harness's base-directory wrapper: ordinary `isMeta` text is
 * deliberately ignored, because only that wrapper proves the body is a
 * definition. A trailing arguments block is dropped — it is the invocation, not
 * the definition — and an over-long body is rejected whole rather than stored
 * truncated, since a partial definition is worse than none.
 */
const DEFINITION_HEADER_RE =
  /^Base directory for this (?:skill|agent|command): [^\r\n]+\r?\n\r?\n/;
const DEFINITION_ARGUMENTS_MARKER = "\n\nARGUMENTS:";

function embeddedDefinitionContent(
  record: Record<string, unknown>
): string | null {
  if (record.isMeta !== true) {
    return null;
  }
  const content = asRecord(record.message).content;
  const parts: string[] = [];
  if (typeof content === "string") {
    parts.push(content);
  } else if (Array.isArray(content)) {
    for (const raw of content) {
      const block = asRecord(raw);
      if (block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
  }
  const expanded = parts.join("\n");
  if (!DEFINITION_HEADER_RE.test(expanded)) {
    return null;
  }
  let body = expanded.replace(DEFINITION_HEADER_RE, "");
  const argumentsIndex = body.lastIndexOf(DEFINITION_ARGUMENTS_MARKER);
  if (argumentsIndex >= 0) {
    body = body.slice(0, argumentsIndex);
  }
  // NOTE: a wrapper with no body, or nothing but an ARGUMENTS trailer, strips to
  // the empty string and is still returned as a snapshot. That is wrong — an
  // empty snapshot satisfies the exact-evidence path, gets hashed, and marks the
  // component Matched, while the stored-definition path resolves empty content
  // to nothing. The one-line refusal was written and then REVERTED (ISS-6574):
  // correcting the parser alone does not converge sessions imported before it,
  // because `preserveStrongerEvidence` sees the prior row's non-null
  // `definition_hash` — the hash OF THE EMPTY BODY — and restores it, after
  // which `relinkInvocationRows` re-derives Matched from the hash being
  // non-null. Fixing this needs the parser change AND a heal, shipped together.
  return new TextEncoder().encode(body).byteLength <=
    AGENT_COMPONENT_INVOCATION_DEFINITION_CONTENT_MAX_BYTES
    ? body
    : null;
}

/**
 * Project the session's Skill invocations out of its tool calls, carrying the
 * provider id and any captured definition through.
 */
export function deriveSkills(
  toolUses: readonly NormalizedToolUse[]
): NormalizedSkillUse[] {
  const skills: NormalizedSkillUse[] = [];
  for (const toolUse of toolUses) {
    if (!toolUse.skillName) {
      continue;
    }
    skills.push({
      name: toolUse.skillName,
      timestamp: toolUse.timestamp,
      subagentId: toolUse.subagentId ?? null,
      ...(toolUse.providerToolUseId
        ? { providerToolUseId: toolUse.providerToolUseId }
        : {}),
      ...(toolUse.definitionSnapshot
        ? { definitionSnapshot: toolUse.definitionSnapshot }
        : {}),
    });
  }
  return skills;
}
