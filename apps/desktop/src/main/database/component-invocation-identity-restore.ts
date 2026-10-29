/**
 * ISS-6571: stable invocation identity across a re-derivation, extracted from
 * `component-invocations.ts` (grandfathered, shrink-only) so the delegation
 * single-claim invariant below lives in a cohesive module rather than growing
 * that file — see root AGENTS.md on touched grandfathered files.
 */

import { NORMALIZER_CONTRACT_VERSION } from "@repo/api/src/definition-fingerprint";
import type {
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
} from "@repo/api/src/types/agent-component-invocation";
import { invocationDurationFields } from "@repo/api/src/types/agent-component-invocation-duration";
import {
  preserveMeasuredFindings,
  preserveMeasuredTelemetry,
} from "./component-invocation-prior-measurements.js";
import {
  type AgentComponentInvocationCandidate,
  type EvidencePointer,
  evidenceRank,
} from "./component-invocation-row-writer.js";
import { parseEvidencePointer } from "./component-invocation-sync-item.js";
import type { Prisma } from "./generated/client.js";

type InvocationKind =
  (typeof AgentComponentInvocationKind)[keyof typeof AgentComponentInvocationKind];
type EvidenceClass =
  (typeof AgentComponentInvocationEvidenceClass)[keyof typeof AgentComponentInvocationEvidenceClass];

export type PriorInvocationEvidenceRow = {
  external_invocation_id: string;
  durationMs?: bigint | number | null;
  durationAmbiguous?: boolean | number | bigint;
  invokedAt?: string | null;
  external_source_id: string | null;
  child_session_id: string | null;
  component_kind: InvocationKind;
  component_key: string;
  relationship: string;
  anchor_kind: string;
  anchor_value: string;
  provider_tool_use_id: string | null;
  attribution_status: string;
  evidence_class: EvidenceClass;
  evidence_pointer: string | EvidencePointer | null;
  definition_hash: string | null;
  normalizer_contract_version: number | null;
  definition_content: string | null;
  local_component_version_id: string | null;
  // ISS-7795: telemetry is measurable ONLY at parse time, from the transcript's
  // per-turn attribution stamp. It is read back here so a rebuild that cannot
  // measure carries the prior measurement forward instead of erasing it.
  model: string | null;
  input_tokens: bigint | null;
  output_tokens: bigint | null;
  cache_read_tokens: bigint | null;
  cache_write_tokens: bigint | null;
  estimated_cost: number | null;
  usage_measurement: string | null;
  // ISS-10725: the funnel is attributed from the code-review runs on disk, which
  // the stored-row rebuild lane cannot reach, so it is read back for the same
  // reason the telemetry above is — a rebuild must not replace a measured funnel
  // with the NULL that means "nothing ever measured this".
  findings_emitted: bigint | null;
  findings_invalidated: bigint | null;
  created_at: string;
  updated_at: string;
};

/**
 * Carry a prior row's external invocation id onto the candidate that re-derives
 * the same anchored invocation, so a re-import or a stored-row rebuild REPLACES
 * a row instead of minting a second identity for it. This is what makes the
 * transcript-less bridge's `subagent:<agentId>` key and the live path's
 * `subagent:<rawSubagentId>` key converge whenever the session already has a
 * row at that anchor.
 */
export function restoreStableInvocationIdentities(
  candidates: AgentComponentInvocationCandidate[],
  priorRows: PriorInvocationEvidenceRow[]
): void {
  const priorByAnchor = new Map<string, PriorInvocationEvidenceRow[]>();
  const priorIds = new Set<string>();
  for (const row of priorRows) {
    priorIds.add(row.external_invocation_id);
    const key = anchorKey(
      row.anchor_kind,
      row.anchor_value,
      row.component_kind,
      row.component_key
    );
    const rows = priorByAnchor.get(key) ?? [];
    rows.push(row);
    priorByAnchor.set(key, rows);
  }
  const claimedDelegations = claimedDelegationKeys(candidates);
  const claimedPriorIds = new Set<string>();
  for (const candidate of candidates) {
    if (priorIds.has(candidate.externalInvocationId)) {
      claimedPriorIds.add(candidate.externalInvocationId);
      continue;
    }
    const prior = matchingPriorRow(candidate, priorByAnchor, claimedPriorIds);
    if (!prior) {
      continue;
    }
    claimedPriorIds.add(prior.external_invocation_id);
    candidate.externalInvocationId = prior.external_invocation_id;
    candidate.externalSourceId =
      prior.external_source_id ?? candidate.externalSourceId;
    candidate.childSessionId =
      prior.child_session_id ?? candidate.childSessionId;
    candidate.relationship = prior.relationship;
    inheritDelegationClaim(candidate, prior, claimedDelegations);
  }
}

function anchorKey(
  anchorKind: string,
  anchorValue: string,
  componentKind: string,
  componentKey: string
): string {
  return `${anchorKind}\u0000${anchorValue}\u0000${componentKind}\u0000${componentKey}`;
}

function matchingPriorRow(
  candidate: AgentComponentInvocationCandidate,
  priorByAnchor: ReadonlyMap<string, PriorInvocationEvidenceRow[]>,
  claimedPriorIds: ReadonlySet<string>
): PriorInvocationEvidenceRow | undefined {
  const anchorMatches =
    priorByAnchor
      .get(
        anchorKey(
          candidate.anchorKind,
          candidate.anchorValue,
          candidate.componentKind,
          candidate.componentKey
        )
      )
      ?.filter((row) => !claimedPriorIds.has(row.external_invocation_id)) ?? [];
  const sourceMatch = anchorMatches.find(
    (row) =>
      (candidate.externalSourceId !== null &&
        row.external_source_id === candidate.externalSourceId) ||
      (candidate.providerToolUseId !== null &&
        row.provider_tool_use_id === candidate.providerToolUseId)
  );
  return (
    sourceMatch ?? (anchorMatches.length === 1 ? anchorMatches[0] : undefined)
  );
}

/**
 * The delegations this re-derivation already resolved an owning row for, keyed
 * WITH the component kind.
 *
 * One delegating tool use legitimately produces two rows of different kinds —
 * the `Orchestration` row for the `Agent`/`Task` call itself and the `Subagent`
 * row for what it delegated to — and both carry the same
 * `delegationClaimKey`. On the live corpus every one of the 1,027 shared claims
 * is exactly that pair, and no two rows of the SAME kind ever share one. So the
 * single-owner rule is per kind: keying it on the claim alone would let the
 * orchestration row's claim block a subagent row from inheriting its own, and
 * leave the delegation with no subagent owner at all.
 */
function claimedDelegationKeys(
  candidates: readonly AgentComponentInvocationCandidate[]
): Set<string> {
  const claimed = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.providerToolUseId) {
      claimed.add(
        delegationOwnerKey(candidate.componentKind, candidate.providerToolUseId)
      );
    }
  }
  return claimed;
}

function delegationOwnerKey(
  componentKind: string,
  providerToolUseId: string
): string {
  return `${componentKind}\u0000${providerToolUseId}`;
}

/**
 * The FRESH derivation wins (ISS-5099, whitlockk review). This restores stable
 * IDENTITY, not stale pairing: when a candidate already resolved which
 * delegation it belongs to — from the transcript, or from the durable spawn
 * events via `applyStoredSpawnClaimKeys` — copying the stored value over it
 * would re-impose exactly the mispair the rebuild exists to correct, and the
 * bridge would then seal that. The prior value is still the fallback for a
 * candidate that resolved none.
 *
 * ISS-6571: but only while that delegation is still UNOWNED by a row of the
 * same kind — it is spoken for by exactly one row per component kind. When the
 * re-derivation MOVED a claim onto a different row — precisely what the ISS-5105 contested-claim
 * correction does, handing the delegation from a contested child to the
 * fallback `agents` row the spawn event anchors to — the losing row's prior
 * still carries the old claim, and inheriting it left BOTH rows speaking for
 * one delegation. The transcript-less bridge then sealed that duplicate at the
 * new revision, so nothing re-selected the session to notice.
 */
function inheritDelegationClaim(
  candidate: AgentComponentInvocationCandidate,
  prior: PriorInvocationEvidenceRow,
  claimedDelegations: Set<string>
): void {
  const inherited = prior.provider_tool_use_id;
  if (candidate.providerToolUseId !== null || inherited === null) {
    return;
  }
  const ownerKey = delegationOwnerKey(candidate.componentKind, inherited);
  if (claimedDelegations.has(ownerKey)) {
    return;
  }
  candidate.providerToolUseId = inherited;
  claimedDelegations.add(ownerKey);
}

/**
 * ISS-10720: moved here from `component-invocations.ts` (grandfathered,
 * shrink-only) with no behaviour change. It restores a PRIOR row's evidence
 * onto a freshly derived candidate, which is this module's own subject.
 */
export function preserveStrongerEvidence(
  candidate: AgentComponentInvocationCandidate,
  previous: PriorInvocationEvidenceRow | undefined
): void {
  if (!previous) {
    return;
  }
  candidate.createdAt = previous.created_at;
  // whitlockk on #8910: a delegation repair can keep the stable id while moving its
  // claim to another spawning call, whose timing the prior row does not hold.
  if (
    candidate.durationMs === undefined &&
    !candidate.durationRefusedInvalidEvidence &&
    previous.provider_tool_use_id === candidate.providerToolUseId
  ) {
    const timing = invocationDurationFields(previous.durationMs);
    if (timing.durationMs !== undefined && previous.invokedAt != null) {
      candidate.durationMs = timing.durationMs;
      candidate.invokedAt = previous.invokedAt;
    }
  }
  preserveMeasuredTelemetry(candidate, previous);
  preserveMeasuredFindings(candidate, previous);
  const previousPointer = parseEvidencePointer(previous.evidence_pointer);
  if (previousPointer) {
    candidate.evidencePointer = {
      ...previousPointer,
      ...(candidate.evidencePointer ?? {}),
    };
  }
  if (
    evidenceRank(previous.evidence_class) <
    evidenceRank(candidate.evidenceClass)
  ) {
    return;
  }
  if (previous.definition_hash) {
    candidate.attributionStatus = previous.attribution_status;
    // ISS-10720: this restores DEFINITION classes only, and it does so because
    // of the gate it sits inside rather than a test of its own. `otelCounter`
    // is the one class the producer can never write a `definition_hash` beside
    // — the stamp promotes it only from `none`, which only comes from an absent
    // evidence bundle, the same bundle that supplies the hash — so a prior OTel
    // attribution cannot reach this assignment and cannot stick across a
    // re-derivation. `stampOtelInvocationAttribution` re-applies it from the
    // live `claude_code_cost_event` rows immediately afterwards if the join
    // still matches. An explicit `otelCounter` guard here was unreachable and
    // untestable (tamsinb on #7731), so it is the invariant above that carries
    // the withdrawal, and `component-invocations-otel-attribution-wiring` pins
    // it.
    candidate.evidenceClass = previous.evidence_class;
    candidate.evidencePointer = parseEvidencePointer(previous.evidence_pointer);
    candidate.definitionHash = previous.definition_hash;
    candidate.normalizerContractVersion =
      previous.normalizer_contract_version == null
        ? NORMALIZER_CONTRACT_VERSION
        : Number(previous.normalizer_contract_version);
    candidate.definitionContent = previous.definition_content;
    candidate.localComponentVersionId = previous.local_component_version_id;
  }
}

/** Timing and its start travel together across transcript-less rebuilds. */
export function readPriorEvidence(
  tx: Prisma.TransactionClient,
  sessionId: string
): Promise<PriorInvocationEvidenceRow[]> {
  return tx.$queryRawUnsafe<PriorInvocationEvidenceRow[]>(
    `SELECT external_invocation_id, duration_ms AS durationMs, duration_ambiguous AS durationAmbiguous, invoked_at AS invokedAt, external_source_id, child_session_id,
            component_kind, component_key, relationship, anchor_kind,
            anchor_value, provider_tool_use_id, attribution_status,
            evidence_class, evidence_pointer, definition_hash,
            normalizer_contract_version, definition_content,
            local_component_version_id, model, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens, estimated_cost,
            usage_measurement, findings_emitted, findings_invalidated,
            created_at, updated_at
       FROM agent_component_invocations
      WHERE session_id = $1`,
    sessionId
  );
}

/** The event store may retain just one of contradictory same-start results.
 * Keep that loss of certainty durable until fresh transcript evidence resolves it. */
export function restoreStoredTimingAmbiguity(
  candidates: AgentComponentInvocationCandidate[],
  priorRows: PriorInvocationEvidenceRow[]
): void {
  const ambiguousIds = new Set(
    priorRows
      .filter((row) => Boolean(row.durationAmbiguous))
      .map((row) => row.external_invocation_id)
  );
  for (const candidate of candidates) {
    if (ambiguousIds.has(candidate.externalInvocationId)) {
      candidate.durationMs = null;
    }
  }
}
