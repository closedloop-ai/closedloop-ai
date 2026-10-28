/**
 * @file component-invocation-identity-restore.test.ts
 * @description ISS-6571 — the single-owner rule that stops a re-derivation from
 * re-imposing a delegation claim it just MOVED is scoped PER COMPONENT KIND,
 * because one delegating tool use legitimately owns two rows of different kinds.
 * The end-to-end rebuild witness (`data-revision-contested-claim-rebuild.test.ts`)
 * reads only `subagent:%` rows, so it cannot see this collapse.
 */
import assert from "node:assert/strict";
import {
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
} from "@repo/api/src/types/agent-component-invocation";
import { test } from "vitest";
import type { PriorInvocationEvidenceRow } from "../src/main/database/component-invocation-identity-restore.js";
import {
  preserveStrongerEvidence,
  restoreStableInvocationIdentities,
} from "../src/main/database/component-invocation-identity-restore.js";
import { storedBaseCandidate } from "../src/main/database/component-invocation-stored-candidates.js";

const SID = "iss6571-shared-claim";
const CLAIM = "toolu_shared_claim";
const AGENT_ID = `${SID}-sub-${CLAIM}`;
const NOW = "2026-06-07T10:00:00.000Z";

function candidate(input: {
  externalInvocationId: string;
  componentKind: (typeof AgentComponentInvocationKind)[keyof typeof AgentComponentInvocationKind];
  anchorValue: string;
  providerToolUseId: string | null;
}) {
  return storedBaseCandidate({
    sessionId: SID,
    externalInvocationId: input.externalInvocationId,
    externalSourceId: null,
    agentId: AGENT_ID,
    parentAgentId: null,
    componentKind: input.componentKind,
    componentKey: "general-purpose",
    rawName: "general-purpose",
    normalizedName: "general-purpose",
    invokedAt: NOW,
    sourceOrder: 1,
    anchorKind: AgentComponentInvocationAnchorKind.Agent,
    anchorValue: input.anchorValue,
    providerToolUseId: input.providerToolUseId,
    gitBranch: null,
    repositoryFullName: null,
    now: NOW,
  });
}

function priorSubagentRow(): PriorInvocationEvidenceRow {
  return {
    external_invocation_id: `subagent:${CLAIM}`,
    external_source_id: null,
    estimated_cost: null,
    findings_emitted: null,
    findings_invalidated: null,
    child_session_id: null,
    component_kind: AgentComponentInvocationKind.Subagent,
    component_key: "general-purpose",
    relationship: AgentComponentInvocationRelationship.Direct,
    anchor_kind: AgentComponentInvocationAnchorKind.Agent,
    anchor_value: AGENT_ID,
    provider_tool_use_id: CLAIM,
    attribution_status: AgentComponentInvocationAttributionStatus.Unresolved,
    evidence_class: AgentComponentInvocationEvidenceClass.None,
    evidence_pointer: null,
    definition_hash: null,
    normalizer_contract_version: null,
    definition_content: null,
    local_component_version_id: null,
    model: null,
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    usage_measurement: null,
    created_at: NOW,
    updated_at: NOW,
  };
}

test("the orchestration row's claim does not strip the subagent row of the same delegation", () => {
  // The `Agent`/`Task` call and what it delegated to are two rows carrying ONE
  // `delegationClaimKey`. Only the orchestration row re-derives a fresh claim
  // here; the subagent row must still recover its own from its prior.
  const subagent = candidate({
    externalInvocationId: `subagent:${AGENT_ID}`,
    componentKind: AgentComponentInvocationKind.Subagent,
    anchorValue: AGENT_ID,
    providerToolUseId: null,
  });
  const orchestration = candidate({
    externalInvocationId: CLAIM,
    componentKind: AgentComponentInvocationKind.Orchestration,
    anchorValue: `${SID}-main`,
    providerToolUseId: CLAIM,
  });

  restoreStableInvocationIdentities(
    [orchestration, subagent],
    [priorSubagentRow()]
  );

  assert.equal(subagent.providerToolUseId, CLAIM);
  assert.equal(subagent.externalInvocationId, `subagent:${CLAIM}`);
  assert.equal(orchestration.providerToolUseId, CLAIM);
});

test("a prior measured span is restored only onto the same spawning call", () => {
  // whitlockk on #8910: a delegation repair can keep the stable subagent id while
  // moving its claim from completed call A to unfinished call B. A's timing is
  // not B's, so B stays unmeasured; the unmoved control still recovers it.
  const prior = {
    ...priorSubagentRow(),
    durationMs: 10_000,
    invokedAt: NOW,
  };
  const moved = candidate({
    externalInvocationId: `subagent:${CLAIM}`,
    componentKind: AgentComponentInvocationKind.Subagent,
    anchorValue: AGENT_ID,
    providerToolUseId: "toolu_unfinished_b",
  });
  const unmoved = candidate({
    externalInvocationId: `subagent:${CLAIM}`,
    componentKind: AgentComponentInvocationKind.Subagent,
    anchorValue: AGENT_ID,
    providerToolUseId: CLAIM,
  });

  preserveStrongerEvidence(moved, prior);
  preserveStrongerEvidence(unmoved, prior);

  assert.equal(moved.durationMs, undefined);
  assert.equal(unmoved.durationMs, 10_000);
  assert.equal(unmoved.invokedAt, NOW);
});
