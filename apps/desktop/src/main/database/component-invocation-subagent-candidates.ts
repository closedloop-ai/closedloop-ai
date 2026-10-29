/**
 * @file component-invocation-subagent-candidates.ts
 * @description Invocation candidates for subagents the PARSER found, as opposed
 * to those a spawning tool call already represents.
 *
 * Split out of `component-invocations.ts` (grandfathered shrink-only under the
 * root AGENTS.md line-count contract) so this lane owns its own contract —
 * chiefly the question of which parser subagents are delegations at all, which
 * the unattributed provenance anchor forced.
 */
import {
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
} from "@repo/api/src/types/agent-component-invocation";
import { UNATTRIBUTED_SUBAGENT_ID } from "@repo/lib/harness/claude/parse-claude-subagents";
import type {
  NormalizedComponentUsage,
  NormalizedSubagent,
  NormalizedTokenRecord,
  NormalizedToolUse,
} from "@repo/lib/harness/types";
import type { ToolCandidateContext } from "./component-invocation-candidate-context.js";
import { withCandidateFootprint } from "./component-invocation-footprint-sources.js";
import { asRecord, stringValue } from "./component-invocation-json.js";
import type { MarkdownCandidateFn } from "./component-invocation-markdown-candidate.js";
import type { AgentComponentInvocationCandidate } from "./component-invocation-row-writer.js";
import { delegationClaimKey } from "./subagent-dedup.js";
import { pairDelegationsWithSubagents } from "./subagent-spawn-matching.js";

export function parserSubagentCandidates(
  context: ToolCandidateContext,
  markdownCandidate: MarkdownCandidateFn,
  representedSubagentIds: ReadonlySet<string>
): AgentComponentInvocationCandidate[] {
  const { session, mainAgentId, now } = context;
  const candidates: AgentComponentInvocationCandidate[] = [];
  for (const [index, subagent] of (session.subagents ?? []).entries()) {
    /**
     * The unattributed row is a PROVENANCE anchor, not a delegation: it exists
     * so a turn stamped with the sentinel resolves to a listed subagent.
     * Nothing spawned it and nobody chose it, so counting it here would report
     * a delegated agent — named `general-purpose` by the fallback below — that
     * the session never made.
     */
    if (
      representedSubagentIds.has(subagent.id) ||
      subagent.id === UNATTRIBUTED_SUBAGENT_ID
    ) {
      continue;
    }
    candidates.push(
      parserSubagentCandidate(
        context,
        markdownCandidate,
        subagent,
        index,
        mainAgentId,
        now
      )
    );
  }
  return candidates;
}

function parserSubagentCandidate(
  context: ToolCandidateContext,
  markdownCandidate: MarkdownCandidateFn,
  subagent: NormalizedSubagent,
  index: number,
  mainAgentId: string,
  now: string
): AgentComponentInvocationCandidate {
  const { session } = context;
  const externalInvocationId = `subagent:${subagent.id}`;
  const agentId = context.parserAgentIdById.get(subagent.id) ?? null;
  const parent = resolvedInvocationParent(context, subagent.id, mainAgentId);
  return markdownCandidate({
    session,
    mainAgentId,
    externalInvocationId,
    externalSourceId: subagent.nativeSubagentId ?? subagent.id,
    providerToolUseId: null,
    childSessionId: subagent.childSessionId ?? null,
    componentKind: AgentComponentInvocationKind.Subagent,
    componentKey: subagent.normalizedName ?? subagent.type ?? "general-purpose",
    rawName: subagent.rawName ?? subagent.type ?? subagent.name,
    normalizedName:
      subagent.normalizedName ?? subagent.type ?? "general-purpose",
    invokedAt: subagent.startedAt ?? null,
    sourceOrder: 350_000 + index,
    agentId,
    parentAgentId: parent.parentAgentId,
    relationship: subagent.childSessionId
      ? AgentComponentInvocationRelationship.ChildSession
      : AgentComponentInvocationRelationship.Direct,
    anchorKind: agentId
      ? AgentComponentInvocationAnchorKind.Agent
      : AgentComponentInvocationAnchorKind.Session,
    anchorValue: agentId ?? session.sessionId,
    snapshot: subagent.definitionSnapshot,
    ...subagentUsage(context, subagent.id),
    focusedEvidence: context.evidenceByInvocationId.get(externalInvocationId),
    externalAgentId: subagent.nativeSubagentId ?? subagent.id,
    transcriptFileId: subagent.id,
    parentExternalInvocationId: parent.parentExternalInvocationId,
    now,
  });
}

/**
 * ISS-7261: the measured usage for one subagent, shaped for `markdownCandidate`,
 * with the round-trips it was folded from riding along so pricing can charge
 * each at its own tier (ISS-7361).
 *
 * Returns an EMPTY object rather than `{ usage: undefined }` when nothing was
 * measured, so the optional key stays absent — "no telemetry" and "measured
 * zero" are different facts and only the absent key preserves the first.
 */
function subagentUsage(
  context: ToolCandidateContext,
  subagentId: string | undefined
): {
  usage?: NormalizedComponentUsage;
  usageRecords?: readonly NormalizedTokenRecord[];
} {
  if (subagentId === undefined) {
    return {};
  }
  const usage = context.subagentUsageById.get(subagentId);
  if (!usage) {
    return {};
  }
  const usageRecords = context.subagentTokenRecordsById.get(subagentId);
  return usageRecords ? { usage, usageRecords } : { usage };
}

export function spawnedSubagentCandidates(
  context: ToolCandidateContext,
  markdownCandidate: MarkdownCandidateFn
): {
  candidates: AgentComponentInvocationCandidate[];
  representedSubagentIds: Set<string>;
} {
  const { session, mainAgentId, now } = context;
  // ISS-5099: pairing lives in `subagent-spawn-matching.ts` so the invocation
  // lane and the `agents` write lane settle exact spawn claims from ONE
  // correlation; see `pairDelegationsWithSubagents` for why order matters.
  const { pairs, representedSubagentIds } = pairDelegationsWithSubagents(
    session,
    context.parserAgentIdById
  );
  const candidates = pairs.map(({ index, toolUse, parserSubagent }) =>
    spawnedSubagentCandidate(
      context,
      markdownCandidate,
      toolUse,
      index,
      parserSubagent,
      mainAgentId,
      now
    )
  );
  return { candidates, representedSubagentIds };
}

function spawnedSubagentCandidate(
  context: ToolCandidateContext,
  markdownCandidate: MarkdownCandidateFn,
  toolUse: NormalizedToolUse,
  index: number,
  parserSubagent: NormalizedSubagent | null,
  mainAgentId: string,
  now: string
): AgentComponentInvocationCandidate {
  const { session } = context;
  // The canonical delegation key, shared with tier-0, the whole-session
  // pre-pass, and write-core's twin retirement — never re-derived here.
  const providerId = delegationClaimKey(toolUse);
  // This branch emits the subagents `parserSubagentCandidates` skipped, so it
  // reads the SAME reconstructed parent — a nested delegation whose spawning
  // call sits on `session.toolUses` with `subagentId` set lands here, and the
  // main-agent default would disagree with the `agents` row the write lane
  // nested.
  const parent = resolvedInvocationParent(
    context,
    parserSubagent?.id ?? null,
    mainAgentId
  );
  const externalInvocationId = parserSubagent
    ? `subagent:${parserSubagent.id}`
    : `subagent:${providerId ?? `${index}:${toolUse.timestamp ?? "unknown"}`}`;
  const input = asRecord(toolUse.input);
  const rawName =
    parserSubagent?.rawName ??
    stringValue(input?.subagent_type) ??
    stringValue(input?.agent_type) ??
    parserSubagent?.type ??
    "general-purpose";
  const normalizedName =
    parserSubagent?.normalizedName ?? parserSubagent?.type ?? rawName;
  const agentId = parserSubagent
    ? (context.parserAgentIdById.get(parserSubagent.id) ?? null)
    : `${session.sessionId}-sub-${toolUse.id ?? index}`;
  return markdownCandidate({
    session,
    mainAgentId,
    externalInvocationId,
    externalSourceId: parserSubagent?.nativeSubagentId ?? providerId ?? null,
    providerToolUseId: providerId,
    childSessionId: parserSubagent?.childSessionId ?? null,
    componentKind: AgentComponentInvocationKind.Subagent,
    componentKey: normalizedName,
    rawName,
    normalizedName,
    invokedAt: parserSubagent?.startedAt ?? toolUse.timestamp,
    sourceOrder: 300_000 + index,
    agentId,
    parentAgentId: parent.parentAgentId,
    relationship: parserSubagent?.childSessionId
      ? AgentComponentInvocationRelationship.ChildSession
      : AgentComponentInvocationRelationship.Direct,
    anchorKind: agentId
      ? AgentComponentInvocationAnchorKind.Agent
      : AgentComponentInvocationAnchorKind.Session,
    anchorValue: agentId ?? session.sessionId,
    snapshot: parserSubagent?.definitionSnapshot ?? toolUse.definitionSnapshot,
    // ISS-10736: a subagent's footprint is the text it RETURNED to its parent —
    // the only part of a subagent that enters the parent's context — which is the
    // delegating call's own result payload, counted at parse time before the size
    // cap. `parserSubagentCandidate` has no counterpart on purpose: a parser-only
    // subagent is reconstructed from the CHILD transcript, which records what it
    // did and never the text it handed back (`NormalizedSubagent` carries no
    // result field), so its footprint is genuinely not recoverable and stays NULL.
    // Counting the child's own transcript instead would measure a different
    // population under a label claiming context injected into the PARENT.
    ...withCandidateFootprint(toolUse.outputFootprintTokens),
    ...subagentUsage(context, parserSubagent?.id),
    focusedEvidence: context.evidenceByInvocationId.get(externalInvocationId),
    externalAgentId:
      parserSubagent?.nativeSubagentId ?? parserSubagent?.id ?? providerId,
    transcriptFileId: parserSubagent?.id ?? null,
    parentExternalInvocationId: parent.parentExternalInvocationId,
    now,
  });
}

/**
 * ISS-10714: the reconstructed parent, shaped for both invocation producers so
 * the two cannot disagree about which call reached a subagent.
 *
 * The two fields are deliberately NOT the same fallback. `parentAgentId` keeps
 * the main agent when nothing resolves, because the agent-tree rollups read a
 * NULL parent as a session root. `parentExternalInvocationId` stays null unless
 * the parent is a resolved SUBAGENT, because only a subagent has an invocation
 * row to point at — the main agent has none.
 */
function resolvedInvocationParent(
  context: ToolCandidateContext,
  subagentId: string | null,
  mainAgentId: string
): { parentAgentId: string; parentExternalInvocationId: string | null } {
  const parentSubagentId = subagentId
    ? (context.subagentAncestryById.get(subagentId)?.parentSubagentId ?? null)
    : null;
  if (!parentSubagentId) {
    return { parentAgentId: mainAgentId, parentExternalInvocationId: null };
  }
  return {
    parentAgentId:
      context.parserAgentIdById.get(parentSubagentId) ?? mainAgentId,
    parentExternalInvocationId: `subagent:${parentSubagentId}`,
  };
}
