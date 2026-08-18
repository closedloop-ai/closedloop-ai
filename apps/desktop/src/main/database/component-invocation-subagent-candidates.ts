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
import type { NormalizedSubagent } from "@repo/lib/harness/types";
import type { AgentComponentInvocationCandidate } from "./component-invocation-row-writer.js";
import type {
  MarkdownCandidateFn,
  ToolCandidateContext,
} from "./component-invocations.js";

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
    parentAgentId: subagent.parentId
      ? (context.parserAgentIdById.get(subagent.parentId) ?? mainAgentId)
      : mainAgentId,
    relationship: subagent.childSessionId
      ? AgentComponentInvocationRelationship.ChildSession
      : AgentComponentInvocationRelationship.Direct,
    anchorKind: agentId
      ? AgentComponentInvocationAnchorKind.Agent
      : AgentComponentInvocationAnchorKind.Session,
    anchorValue: agentId ?? session.sessionId,
    snapshot: subagent.definitionSnapshot,
    focusedEvidence: context.evidenceByInvocationId.get(externalInvocationId),
    externalAgentId: subagent.nativeSubagentId ?? subagent.id,
    transcriptFileId: subagent.id,
    parentExternalInvocationId: subagent.parentId
      ? `subagent:${subagent.parentId}`
      : null,
    now,
  });
}
