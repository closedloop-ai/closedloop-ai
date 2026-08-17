/**
 * @file parse-claude-delegations.ts
 * @description ISS-4592: the Claude delegation-kickoff join. A spawned
 * subagent's declared intent — the `Agent`/`Task` tool_use `input`
 * (`subagent_type`/`agent_type`, `prompt`, `description`) — exists in the raw
 * transcript but historically never survived onto the `NormalizedSubagent`
 * record. No single raw source is complete, so this module models each one
 * partially and folds them (`mergeDelegations`):
 *
 * 1. The `Agent`/`Task` tool_use `input` — the richest source (full prompt),
 *    but it names no child (`delegationsFromEntryToolUses`).
 * 2. The answering tool_result line's top-level `toolUseResult`
 *    (`{agentId, agentType, prompt}`) — the only source carrying BOTH the join
 *    key and the spawned child's id (`delegationFromToolUseResult`).
 * 3. The desktop-only sidecar `agent-<hex>.meta.json`
 *    (`{agentType, description, toolUseId}`) — a direct child→parent FK, read
 *    by the shell, but `toolUseId` is not always present.
 *
 * The join runs through `buildDelegationToolUseIndex`, which spans the main
 * transcript AND every subagent's tool uses: a nested delegation's kickoff
 * lives in its parent SUBAGENT's transcript, not the session's.
 *
 * Semantics note: on Claude records `task` is the delegation kickoff prompt —
 * matching the live-hook lane (`spawnSubagent` prompt → task) and write-core's
 * fallback tool_use lane. The Codex parser's `task` is the child rollout's own
 * session name; that divergence is documented here, not resolved.
 *
 * Application is strictly additive: `applyDelegationToSubagent` never
 * overwrites a non-empty field and omits absent values entirely (no `null`
 * assignment), so unenriched records stay byte-identical to the pre-ISS-4592
 * parser output.
 */
import { stringValue, truncateText } from "../parser-utils";
import type { NormalizedSession, NormalizedSubagent } from "../types";

/**
 * Producer-side byte cap for the kickoff prompt stored as `task`. Keeps the
 * normalized record far below the historical-parse-worker strict boundary's
 * long-text cap while preserving the DB layer's `task.slice(0, 500)` prefix
 * exactly (500 UTF-16 chars ≤ 2000 UTF-8 bytes < 4096), so the live-hook
 * `matchSubagent` prefix comparison is unaffected by this truncation.
 */
export const CLAUDE_DELEGATION_TASK_MAX_BYTES = 4096;

/**
 * Producer-side cap for the promoted `type`, mirroring the historical-parse
 * worker's strict boundary (`HistoricalParseWorkerLimits.maxShortTextLength`,
 * which `subagentSchema.type` enforces as a Zod `.max()`). Duplicated as a
 * literal because that limit lives in `apps/desktop`, which `@repo/lib` cannot
 * import.
 *
 * Over-cap values are OMITTED, not truncated: `type` is an identifier, so a
 * truncated one is a confidently wrong label while an absent one is honest.
 * Enforcing it at the producer matters because every source is parsed JSON at a
 * trust boundary (a `.meta.json` file, a tool_use `input`), and one over-long
 * value would fail the strict boundary schema and drop the ENTIRE session —
 * re-dropping it on every retry — rather than losing a single field.
 */
export const CLAUDE_DELEGATION_TYPE_MAX_CHARS = 8192;

/** `value` when it fits the boundary cap for `type`, else null. */
export function boundedDelegationType(
  value: string | null | undefined
): string | null {
  if (value == null) {
    return null;
  }
  return value.length <= CLAUDE_DELEGATION_TYPE_MAX_CHARS ? value : null;
}

/** The Claude delegation tool: `Agent` today, `Task` on older harness versions. */
export const CLAUDE_DELEGATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Agent",
  "Task",
]);

/**
 * One delegation kickoff, as recoverable from a single raw source. Fields are
 * null when that source did not carry them; `agentId` is the provider's BARE
 * child id (no `agent-` prefix) — callers join it to `NormalizedSubagent.id`
 * via `normalizeSidechainSubagentId`.
 */
export type ClaudeDelegation = {
  toolUseId: string | null;
  agentId: string | null;
  type: string | null;
  task: string | null;
  description: string | null;
};

/**
 * Build a delegation from a parent tool_result line: the top-level
 * `toolUseResult` payload (`agentId`, `agentType`, `prompt`) plus, when the
 * caller has already resolved the delegating tool_use, its `input`
 * (`subagent_type`/`agent_type`, `prompt`, `description`). Returns null when
 * the payload identifies no child agent — a delegation that cannot be joined
 * enriches nothing.
 */
export function delegationFromToolUseResult(
  toolUseId: string | null,
  toolUseResult: unknown,
  input?: unknown
): ClaudeDelegation | null {
  if (!toolUseResult || typeof toolUseResult !== "object") {
    return null;
  }
  const tur = toolUseResult as Record<string, unknown>;
  const agentId = stringValue(tur.agentId);
  if (!agentId) {
    return null;
  }
  const inp =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  return {
    toolUseId,
    agentId,
    type: boundedDelegationType(
      stringValue(inp.subagent_type) ??
        stringValue(inp.agent_type) ??
        stringValue(tur.agentType)
    ),
    task: truncateText(
      stringValue(inp.prompt) ?? stringValue(tur.prompt),
      CLAUDE_DELEGATION_TASK_MAX_BYTES
    ),
    description: truncateText(stringValue(inp.description)),
  };
}

/**
 * Extract delegation kickoffs from a raw assistant line's `Agent`/`Task`
 * tool_use blocks. The desktop shell needs this for sidecar transcripts: a
 * NESTED delegation's kickoff lives in its parent SUBAGENT's transcript, and
 * the subagent scanner bounds each tool input at 1000 JSON chars, so the
 * merged record's `input` no longer re-parses. Reading the raw line here
 * recovers the untruncated prompt. `agentId` is null — this source names the
 * delegating call, not the spawned child.
 */
export function delegationsFromEntryToolUses(
  entry: Record<string, unknown>
): ClaudeDelegation[] {
  const message = entry.message;
  if (!message || typeof message !== "object") {
    return [];
  }
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) {
    return [];
  }
  const delegations: ClaudeDelegation[] = [];
  for (const rawBlock of content) {
    if (!rawBlock || typeof rawBlock !== "object") {
      continue;
    }
    const block = rawBlock as Record<string, unknown>;
    if (
      block.type !== "tool_use" ||
      typeof block.name !== "string" ||
      !CLAUDE_DELEGATION_TOOL_NAMES.has(block.name)
    ) {
      continue;
    }
    const input =
      block.input && typeof block.input === "object"
        ? (block.input as Record<string, unknown>)
        : {};
    delegations.push({
      toolUseId: stringValue(block.id),
      agentId: null,
      type: boundedDelegationType(
        stringValue(input.subagent_type) ?? stringValue(input.agent_type)
      ),
      task: truncateText(
        stringValue(input.prompt),
        CLAUDE_DELEGATION_TASK_MAX_BYTES
      ),
      description: truncateText(stringValue(input.description)),
    });
  }
  return delegations;
}

/**
 * Merge a delegation's fields into an accumulated one for the same call:
 * every source is partial (the tool_use input has the prompt but no child id,
 * the tool_result payload has the child id and may have neither), so the first
 * non-null value for each field wins.
 */
export function mergeDelegations(
  base: ClaudeDelegation,
  incoming: ClaudeDelegation
): ClaudeDelegation {
  return {
    toolUseId: base.toolUseId ?? incoming.toolUseId,
    agentId: base.agentId ?? incoming.agentId,
    type: base.type ?? incoming.type,
    task: base.task ?? incoming.task,
    description: base.description ?? incoming.description,
  };
}

/**
 * Extract the `tool_use_id` a raw tool_result line answers, from its
 * `message.content` blocks. Used by the desktop shell, which sees sidecar
 * lines outside the core's block dispatch.
 */
export function toolResultIdFromEntry(
  entry: Record<string, unknown>
): string | null {
  const message = entry.message;
  if (!message || typeof message !== "object") {
    return null;
  }
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) {
    return null;
  }
  for (const rawBlock of content) {
    if (!rawBlock || typeof rawBlock !== "object") {
      continue;
    }
    const block = rawBlock as Record<string, unknown>;
    if (block.type === "tool_result") {
      return stringValue(block.tool_use_id);
    }
  }
  return null;
}

/**
 * Apply a delegation to a subagent record, strictly additively: each field is
 * assigned only when the delegation carries a value AND the record does not
 * already have one, and metadata keys are merged without clobbering. A record
 * with nothing to gain is left untouched (no empty `metadata` object is
 * created), preserving byte-identical output for unenriched sessions.
 */
export function applyDelegationToSubagent(
  subagent: NormalizedSubagent,
  delegation: ClaudeDelegation
): void {
  if (delegation.type && subagent.type == null) {
    subagent.type = delegation.type;
  }
  if (delegation.task && subagent.task == null) {
    subagent.task = delegation.task;
  }
  const metadataAdditions: Record<string, unknown> = {};
  if (delegation.toolUseId && subagent.metadata?.spawnedByToolUseId == null) {
    metadataAdditions.spawnedByToolUseId = delegation.toolUseId;
  }
  if (delegation.description && subagent.metadata?.description == null) {
    metadataAdditions.description = delegation.description;
  }
  if (Object.keys(metadataAdditions).length > 0) {
    subagent.metadata = { ...subagent.metadata, ...metadataAdditions };
  }
}

/**
 * Index every delegation tool_use in the session — main transcript AND all
 * subagents' tool uses (a nested delegation's `Agent` call lives in its parent
 * SUBAGENT's transcript, not the session's) — by tool_use id. Built once per
 * parse pass, per the collectors' parent-scan caching convention.
 */
export function buildDelegationToolUseIndex(
  session: NormalizedSession
): Map<string, { input?: unknown }> {
  const index = new Map<string, { input?: unknown }>();
  const addAll = (toolUses: NormalizedSession["toolUses"]): void => {
    for (const toolUse of toolUses) {
      if (
        typeof toolUse.id === "string" &&
        CLAUDE_DELEGATION_TOOL_NAMES.has(toolUse.name)
      ) {
        index.set(toolUse.id, toolUse);
      }
    }
  };
  addAll(session.toolUses);
  for (const subagent of session.subagents ?? []) {
    addAll(subagent.toolUses ?? []);
  }
  return index;
}
