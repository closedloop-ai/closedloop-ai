/**
 * @file claude-subagent-meta.ts
 * @description ISS-4592: desktop-only enrichment of sidecar-created Claude
 * subagent records with their delegation kickoff (`type`, `task`,
 * `metadata.spawnedByToolUseId`, `metadata.description`). Three raw sources
 * compose, strongest first:
 *
 * 1. The sidecar's sibling `agent-<hex>.meta.json`
 *    (`{agentType, description, toolUseId}`) — a direct FK from the child file
 *    to the delegating tool_use.
 * 2. That tool_use's own `input` (`prompt`, `subagent_type`, `description`),
 *    resolved through a session-wide index spanning the main transcript AND
 *    every subagent's tool uses — a NESTED delegation's `Agent` call lives in
 *    its parent subagent's transcript. The index is built once per parse pass
 *    (collectors AGENTS.md parent-scan caching).
 * 3. Delegation `toolUseResult` payloads collected while streaming the sidecar
 *    files (`{agentId, agentType, prompt}`) — this is what recovers the full
 *    kickoff prompt for nested delegations, whose scanned tool_use `input` is
 *    bounded at 1000 JSON chars and so fails to re-parse for real prompts.
 *
 * Fail-silent throughout: a missing/corrupt meta file or an unresolvable join
 * degrades to partial or no enrichment, never an error — version-skewed
 * transcripts must parse exactly as before (repo cross-repo guardrail).
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  applyDelegationToSubagent,
  boundedDelegationType,
  buildDelegationToolUseIndex,
  CLAUDE_DELEGATION_TASK_MAX_BYTES,
  type ClaudeDelegation,
  mergeDelegations,
} from "@repo/lib/harness/claude/parse-claude-delegations";
import { normalizeSidechainSubagentId } from "@repo/lib/harness/claude/parse-claude-subagents";
import {
  asRecord,
  stringValue,
  truncateText,
} from "@repo/lib/harness/parser-utils";
import type {
  NormalizedSession,
  NormalizedSubagent,
} from "@repo/lib/harness/types";

/** One sidecar subagent awaiting post-merge enrichment. */
export type SidecarSubagentPending = {
  subagent: NormalizedSubagent;
  /** The sidecar transcript path; the meta file sits beside it. */
  subFile: string;
  /** First `attributionAgent` seen on the sidecar's lines (type-only fallback). */
  attributionAgent: string | null;
};

type SubagentMeta = {
  agentType: string | null;
  description: string | null;
  toolUseId: string | null;
};

const SUBAGENT_TRANSCRIPT_EXT = ".jsonl";
const SUBAGENT_META_EXT = ".meta.json";

/**
 * Read the sidecar's sibling meta file (extension swap on the transcript path,
 * which also holds for any nested `workflows/<wf>/agent-*.jsonl` layout).
 * Fail-silent: absent or corrupt meta returns null.
 */
function readSubagentMeta(subFile: string): SubagentMeta | null {
  const metaPath = subagentMetaPathFor(subFile);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(metaPath, "utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const meta = parsed as Record<string, unknown>;
  return {
    agentType: stringValue(meta.agentType),
    description: stringValue(meta.description),
    toolUseId: stringValue(meta.toolUseId),
  };
}

/**
 * Enrich every sidecar-created subagent record with its delegation kickoff.
 * Runs AFTER the sidecar merge loop so the tool-use index sees every
 * subagent's merged tool uses (nested delegations resolve through a sibling
 * subagent's transcript). Application is strictly additive — an inline-lane
 * record the core already enriched is never overwritten.
 */
export function enrichSidecarSubagents(
  session: NormalizedSession,
  pending: readonly SidecarSubagentPending[],
  delegations: readonly ClaudeDelegation[]
): void {
  if (pending.length === 0) {
    return;
  }
  const toolUseIndex = buildDelegationToolUseIndex(session);
  // Every source is partial, so fold them into one record per call site:
  // the tool_use input carries the prompt, the tool_result payload carries the
  // spawned child's id, and either may be the only one present.
  const byToolUseId = new Map<string, ClaudeDelegation>();
  const byAgentId = new Map<string, ClaudeDelegation>();
  for (const delegation of delegations) {
    if (delegation.toolUseId) {
      const existing = byToolUseId.get(delegation.toolUseId);
      byToolUseId.set(
        delegation.toolUseId,
        existing ? mergeDelegations(existing, delegation) : delegation
      );
    }
    if (delegation.agentId) {
      const childId = normalizeSidechainSubagentId(
        delegation.agentId,
        delegation.agentId
      );
      const existing = byAgentId.get(childId);
      byAgentId.set(
        childId,
        existing ? mergeDelegations(existing, delegation) : delegation
      );
    }
  }
  for (const { subagent, subFile, attributionAgent } of pending) {
    const meta = readSubagentMeta(subFile);
    // The child→parent join: the sidecar's own meta FK first, else the
    // tool_result payload that named this child.
    // ISS-4592 (review): join on the PROVIDER agent id — the sidecar's own
    // basename — not `subagent.id`. A NESTED workflow agent's id is its
    // collision-free path-qualified relId (`workflows__<wf>__agent-<hex>`)
    // while `byAgentId` is keyed on the normalized bare `agent-<hex>`, so
    // keying this on `subagent.id` silently missed every nested workflow agent,
    // losing the result-side join whenever its meta file carried no
    // `toolUseId`. The basename is the bare provider id for direct AND nested
    // sidecars alike.
    const providerAgentId = basename(subFile, SUBAGENT_TRANSCRIPT_EXT);
    const byChild = byAgentId.get(providerAgentId);
    const toolUseId = meta?.toolUseId ?? byChild?.toolUseId ?? null;
    const byCall = toolUseId ? byToolUseId.get(toolUseId) : undefined;
    const input = asRecord(toolUseIndex.get(toolUseId ?? "")?.input);
    applyDelegationToSubagent(subagent, {
      toolUseId,
      agentId: null,
      // Bounded at the worker-boundary cap: `meta.agentType` and
      // `attributionAgent` are parsed JSON off disk, and one over-long value
      // would fail the strict schema and drop the entire session.
      type: boundedDelegationType(
        meta?.agentType ??
          stringValue(input.subagent_type) ??
          stringValue(input.agent_type) ??
          byCall?.type ??
          byChild?.type ??
          attributionAgent
      ),
      task:
        truncateText(
          stringValue(input.prompt),
          CLAUDE_DELEGATION_TASK_MAX_BYTES
        ) ??
        byCall?.task ??
        byChild?.task ??
        null,
      description:
        meta?.description ??
        truncateText(stringValue(input.description)) ??
        byCall?.description ??
        byChild?.description ??
        null,
    });
  }
}

/**
 * The sidecar transcript's sibling meta path (extension swap). Exported as the
 * single definition of that relationship: the catchup-cache freshness scan
 * (`maxSubagentMtime`) must stat exactly the file this module reads, or a
 * meta-only write would leave a session's enrichment stale.
 */
export function subagentMetaPathFor(subFile: string): string {
  return subFile.slice(0, -SUBAGENT_TRANSCRIPT_EXT.length) + SUBAGENT_META_EXT;
}

/**
 * First `attributionAgent` across a sidecar's own lines — the type-only
 * last resort when neither the meta file nor a tool_use join resolves the
 * delegation. Lives here rather than inline in `parseSessionFile`, which
 * already carries well past the house cognitive-complexity limit.
 */
export function firstAttributionAgent(
  entries: readonly { entry: Record<string, unknown> }[]
): string | null {
  for (const { entry } of entries) {
    const agent = stringValue(entry.attributionAgent);
    if (agent != null) {
      return agent;
    }
  }
  return null;
}
