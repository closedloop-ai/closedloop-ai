/**
 * ISS-10720 — which source wins when the harness's OTel counter and this
 * device's transcript reconstruction disagree about an invocation, and what
 * taking the OTel label must NOT cost.
 */

import assert from "node:assert/strict";
import { AgentComponentInvocationEvidenceClass } from "@repo/api/src/types/agent-component-invocation";
import { test } from "vitest";
import {
  type PriorInvocationEvidenceRow,
  preserveStrongerEvidence,
} from "../src/main/database/component-invocation-identity-restore.js";
import {
  type AgentComponentInvocationCandidate,
  evidenceRank,
} from "../src/main/database/component-invocation-row-writer.js";

function priorRow(
  overrides: Partial<PriorInvocationEvidenceRow>
): PriorInvocationEvidenceRow {
  return {
    external_invocation_id: "inv-1",
    external_source_id: null,
    child_session_id: null,
    component_kind: "skill",
    component_key: "alpha",
    relationship: "direct",
    anchor_kind: "session",
    anchor_value: "{}",
    provider_tool_use_id: null,
    attribution_status: "matched",
    evidence_class: AgentComponentInvocationEvidenceClass.OtelCounter,
    evidence_pointer: null,
    definition_hash: "hash-from-transcript",
    normalizer_contract_version: 7,
    definition_content: "# alpha",
    local_component_version_id: "ver-1",
    created_at: "2026-09-01T00:00:00.000Z",
    model: null,
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    estimated_cost: null,
    usage_measurement: null,
    ...overrides,
  } as PriorInvocationEvidenceRow;
}

test("evidenceRank ranks the definition-less OTel class with none, never above a definition", () => {
  // DELIBERATE BEHAVIOUR CHANGE from this branch's first cut, which ranked
  // `otelCounter` at the top. `evidenceRank`'s two consumers both ask one
  // question — which DEFINITION is stronger — and an OTel counter carries no
  // file, hash or commit. At the top it let a stamped candidate with no
  // definition displace a colliding candidate's real one in
  // `mergeStrongerEvidenceInto`. Which SOURCE attributed a row is now its own
  // column and no longer competes here.
  assert.equal(
    evidenceRank(AgentComponentInvocationEvidenceClass.OtelCounter),
    evidenceRank(AgentComponentInvocationEvidenceClass.None)
  );
  assert.ok(
    evidenceRank(AgentComponentInvocationEvidenceClass.TranscriptSnapshot) >
      evidenceRank(AgentComponentInvocationEvidenceClass.OtelCounter)
  );
  // The rest of the order is untouched.
  assert.ok(
    evidenceRank(AgentComponentInvocationEvidenceClass.TranscriptSnapshot) >
      evidenceRank(AgentComponentInvocationEvidenceClass.CollectorSnapshot)
  );
});

test("a re-derivation restores prior definition evidence onto a candidate that has none", () => {
  // The function's own job, pinned here so the OTel carve-out below cannot be
  // read as having weakened it.
  const candidate = {
    externalInvocationId: "inv-1",
    evidenceClass: AgentComponentInvocationEvidenceClass.None,
    attributionStatus: "unresolved",
    definitionHash: null,
    normalizerContractVersion: null,
    definitionContent: null,
    localComponentVersionId: null,
    usageMeasurement: null,
    attributionSource: null,
    createdAt: "",
  } as unknown as AgentComponentInvocationCandidate;

  preserveStrongerEvidence(
    candidate,
    priorRow({
      evidence_class: AgentComponentInvocationEvidenceClass.CollectorSnapshot,
    })
  );

  assert.equal(
    candidate.evidenceClass,
    AgentComponentInvocationEvidenceClass.CollectorSnapshot
  );
  assert.equal(candidate.definitionHash, "hash-from-transcript");
  assert.equal(candidate.normalizerContractVersion, 7);
});

test("a re-derivation does NOT carry a prior OTel attribution class forward", () => {
  // DELIBERATE BEHAVIOUR CHANGE from this branch's first cut, which preserved
  // the class. `otelCounter` is re-derived from the live
  // `claude_code_cost_event` rows by `stampOtelInvocationAttribution` on every
  // pass, so preserving it would make a WITHDRAWN attribution stick rather
  // than preserve anything. The stamp re-applies immediately after when the
  // join still matches, so nothing is lost when it does.
  //
  // `definition_hash: null` is the only shape the producer can write this
  // class in — it moves `evidenceClass` only from `none`, which has no hash.
  const candidate = {
    externalInvocationId: "inv-1",
    evidenceClass: AgentComponentInvocationEvidenceClass.None,
    attributionStatus: "unresolved",
    definitionHash: null,
    normalizerContractVersion: null,
    definitionContent: null,
    localComponentVersionId: null,
    usageMeasurement: null,
    attributionSource: null,
    createdAt: "",
  } as unknown as AgentComponentInvocationCandidate;

  preserveStrongerEvidence(
    candidate,
    priorRow({
      evidence_class: AgentComponentInvocationEvidenceClass.OtelCounter,
      definition_hash: null,
    })
  );

  assert.equal(
    candidate.evidenceClass,
    AgentComponentInvocationEvidenceClass.None
  );
  // The attribution source is not carried forward either — same reason.
  assert.equal(candidate.attributionSource, null);
});
