import assert from "node:assert/strict";
import {
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
} from "@repo/api/src/types/agent-component-invocation";
import { describe, it } from "vitest";
import {
  type StoredInvocationRow,
  storedRowToSyncItem,
} from "../src/main/database/component-invocation-sync-item.js";

/**
 * ISS-10725 producer half. The funnel columns are a PAIR, so unlike the token
 * counts beside them a row holding one and not the other must emit NEITHER: half
 * a pair fails the cloud's `.strict()` item schema, which rejects the whole part
 * and re-rejects it on every retry rather than dropping the one field.
 */
describe("stored invocation row -> sync item findings funnel", () => {
  it("emits a complete stored pair", () => {
    const item = storedRowToSyncItem(
      row({ findings_emitted: 10n, findings_invalidated: 3n })
    );

    assert.equal(item.findingsEmitted, 10);
    assert.equal(item.findingsInvalidated, 3);
  });

  it("emits a measured zero, which is not the same fact as an absent pair", () => {
    const measuredZero = storedRowToSyncItem(
      row({ findings_emitted: 0n, findings_invalidated: 0n })
    );

    assert.equal(measuredZero.findingsEmitted, 0);
    assert.equal(measuredZero.findingsInvalidated, 0);
    assert.equal(
      Object.hasOwn(storedRowToSyncItem(row({})), "findingsEmitted"),
      false
    );
  });

  it("omits an unmeasured pair rather than sending null", () => {
    const item = storedRowToSyncItem(row({}));

    assert.equal(Object.hasOwn(item, "findingsEmitted"), false);
    assert.equal(Object.hasOwn(item, "findingsInvalidated"), false);
    // A legacy row must serialize exactly as it did before the fields existed,
    // or its generation identity changes and the whole set re-syncs.
    assert.equal(
      JSON.stringify(item),
      JSON.stringify(storedRowToSyncItem(row({})))
    );
  });

  it("omits BOTH halves of a half-set pair, in either direction", () => {
    for (const stored of [
      { findings_emitted: 10n, findings_invalidated: null },
      { findings_emitted: null, findings_invalidated: 3n },
    ]) {
      const item = storedRowToSyncItem(row(stored));

      assert.equal(Object.hasOwn(item, "findingsEmitted"), false);
      assert.equal(Object.hasOwn(item, "findingsInvalidated"), false);
    }
  });

  it("omits a pair the ingest boundary would reject outright", () => {
    for (const stored of [
      // `invalidated > emitted` would make the derived `confirmed` negative.
      { findings_emitted: 2n, findings_invalidated: 3n },
      { findings_emitted: -1n, findings_invalidated: 0n },
      {
        findings_emitted: BigInt(Number.MAX_SAFE_INTEGER) + 2n,
        findings_invalidated: 0n,
      },
    ]) {
      const item = storedRowToSyncItem(row(stored));

      assert.equal(Object.hasOwn(item, "findingsEmitted"), false);
      assert.equal(Object.hasOwn(item, "findingsInvalidated"), false);
    }
  });
});

function row(overrides: Partial<StoredInvocationRow>): StoredInvocationRow {
  return {
    succeeded: null,
    attribution_source: null,
    session_id: "session-1",
    external_invocation_id: "invocation-1",
    external_source_id: null,
    child_session_id: null,
    agent_id: null,
    parent_agent_id: null,
    component_kind: AgentComponentInvocationKind.Tool,
    component_key: "Read",
    raw_name: null,
    normalized_name: null,
    relationship: AgentComponentInvocationRelationship.Direct,
    invoked_at: "2026-09-21T16:00:00.000Z",
    sequence: 0,
    anchor_kind: AgentComponentInvocationAnchorKind.Event,
    anchor_value: "event-1",
    provider_tool_use_id: null,
    attribution_status: AgentComponentInvocationAttributionStatus.Unresolved,
    evidence_class: AgentComponentInvocationEvidenceClass.None,
    evidence_pointer: null,
    definition_hash: null,
    normalizer_contract_version: null,
    definition_content: null,
    git_branch: null,
    repository_full_name: null,
    model: null,
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    estimated_cost: null,
    footprint_tokens: null,
    usage_measurement: null,
    // ISS-10730: a findings fixture carries no line delta; the merge that added
    // these columns must not make this row's wire shape change.
    lines_added: null,
    lines_removed: null,
    findings_emitted: null,
    findings_invalidated: null,
    // ISS-11325: no disposition recorded on a fixture the findings ingest never reached.
    findings_disposition: null,
    ...overrides,
  };
}
