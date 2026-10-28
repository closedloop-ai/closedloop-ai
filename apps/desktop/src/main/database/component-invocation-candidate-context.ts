/**
 * The shared per-derivation context every candidate producer reads, plus the
 * parser-subagent agent-id mint the context and the parent resolution share,
 * and the per-tool agent, parent and relationship reads over that context.
 *
 * ISS-5801: extracted from `component-invocations.ts` (a shrink-only
 * grandfathered file); the host and the candidate modules import FROM here.
 */
import { AgentComponentInvocationRelationship } from "@repo/api/src/types/agent-component-invocation";
import {
  foldSubagentTokenRecords,
  groupSubagentTokenRecords,
} from "@repo/lib/harness/component-usage";
import type {
  Harness,
  NormalizedComponentUsage,
  NormalizedInvocationDefinitionEvidence,
  NormalizedSession,
  NormalizedTokenRecord,
  NormalizedToolUse,
} from "@repo/lib/harness/types";
import { effectiveParsePolicy } from "../parse-policy/effective-parse-policy.js";
import type { ParsePolicy } from "../parse-policy/parse-policy.js";
import { sanitizeSubagentIdSegment } from "./import-metadata-builders.js";
import {
  buildSubagentAncestryIndex,
  type SubagentAncestry,
} from "./subagent-ancestry.js";

export type ToolCandidateContext = {
  session: NormalizedSession;
  mainAgentId: string;
  parserAgentIdById: ReadonlyMap<string, string>;
  externalAgentIdById: ReadonlyMap<string, string>;
  evidenceByInvocationId: ReadonlyMap<
    string,
    NormalizedInvocationDefinitionEvidence
  >;
  /** ISS-7261: measured usage per subagent id, folded once from `tokenSeries`
   * so both subagent producers resolve an id through the same answer. */
  subagentUsageById: ReadonlyMap<string, NormalizedComponentUsage>;
  /** ISS-7361: the round-trips each usage row was folded from, so the money
   * column can price them one at a time instead of pricing the fold. */
  subagentTokenRecordsById: ReadonlyMap<
    string,
    readonly NormalizedTokenRecord[]
  >;
  /**
   * ISS-10714: the reconstructed spawn tree, keyed by RAW parser subagent id.
   * The invocation lane and the `agents` write lane read the SAME derivation,
   * so `parent_agent_id` and `parent_external_invocation_id` cannot disagree
   * about which call reached a given subagent.
   */
  subagentAncestryById: ReadonlyMap<string, SubagentAncestry>;
  now: string;
  /** Codex tool verdicts read differently (`tool-result-outcome.ts`); null
   * when the caller does not know the session's harness. */
  harness: Harness | null;
  /** ISS-12552: the policy the session was parsed under. */
  parsePolicy: ParsePolicy;
};

export function buildToolCandidateContext(
  session: NormalizedSession,
  mainAgentId: string,
  now: string,
  harness: Harness | null,
  parsePolicy: ParsePolicy = effectiveParsePolicy()
): ToolCandidateContext {
  const parserSubagents = session.subagents ?? [];
  const subagentTokenRecordsById = groupSubagentTokenRecords(
    session.tokenSeries,
    session.tokenSeriesTruncation
  );
  // One mint, shared by the context and the ancestry derivation below. Two
  // constructions of the same map would be two places to drift, and this one
  // decides which `agents` row an invocation's parent points at.
  const parserAgentIdById = new Map(
    parserSubagents.map((subagent) => [
      subagent.id,
      parserAgentId(session.sessionId, subagent.id),
    ])
  );
  return {
    session,
    mainAgentId,
    parserAgentIdById,
    externalAgentIdById: new Map(
      parserSubagents.map((subagent) => [
        subagent.id,
        subagent.nativeSubagentId ?? subagent.id,
      ])
    ),
    evidenceByInvocationId: new Map(
      (session.invocationDefinitionEvidence ?? []).map((entry) => [
        entry.invocationId,
        entry,
      ])
    ),
    subagentUsageById: foldSubagentTokenRecords(subagentTokenRecordsById),
    subagentTokenRecordsById,
    subagentAncestryById: buildSubagentAncestryIndex(session, parserAgentIdById)
      .bySubagentId,
    now,
    harness,
    parsePolicy,
  };
}

export function parserAgentId(sessionId: string, subagentId: string): string {
  // The sanitize step is shared with write-core's `agents`-row minting
  // (`import-metadata-builders.ts`) so the two lanes cannot drift — a drift
  // here would point every paired invocation row's `agent_id` at an `agents`
  // row that does not exist.
  return `${sessionId}-parser-sub-${sanitizeSubagentIdSegment(subagentId)}`;
}

export function agentIdForTool(
  toolUse: NormalizedToolUse,
  context: ToolCandidateContext
): string {
  return toolUse.subagentId == null
    ? context.mainAgentId
    : (context.parserAgentIdById.get(toolUse.subagentId) ??
        context.mainAgentId);
}

export function parentAgentIdForTool(
  toolUse: NormalizedToolUse,
  context: ToolCandidateContext
): string | null {
  return toolUse.subagentId == null
    ? null
    : parentAgentIdFor(
        context.session,
        toolUse.subagentId,
        context.mainAgentId
      );
}

export function parentAgentIdFor(
  session: NormalizedSession,
  subagentId: string,
  mainAgentId: string
): string {
  const subagent = (session.subagents ?? []).find(
    (candidate) => candidate.id === subagentId
  );
  return subagent?.parentId
    ? parserAgentId(session.sessionId, subagent.parentId)
    : mainAgentId;
}

export function relationshipForTool(toolUse: NormalizedToolUse): string {
  return toolUse.subagentId == null
    ? AgentComponentInvocationRelationship.Direct
    : AgentComponentInvocationRelationship.Associated;
}
