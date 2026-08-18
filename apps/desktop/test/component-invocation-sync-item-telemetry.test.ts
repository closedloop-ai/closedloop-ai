import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
} from "@repo/api/src/types/agent-component-invocation";
import {
  type StoredInvocationRow,
  storedRowToSyncItem,
} from "../src/main/database/component-invocation-sync-item.js";

/**
 * FEA-3981 (ISS-4976) producer half. These local columns existed as schema-only
 * before this change, so nothing on the wire could ever populate the cloud's
 * matching columns. The projection now emits them — under the same omission
 * contract as every other optional field, because the generation identity is a
 * hash of the item set and a stray `null` would change it.
 */
describe("stored invocation row -> sync item telemetry", () => {
  it("emits captured per-invocation telemetry", () => {
    const item = storedRowToSyncItem(
      row({
        component_kind: AgentComponentInvocationKind.Subagent,
        model: "claude-opus-5",
        input_tokens: 12_345n,
        output_tokens: 678n,
        cache_read_tokens: 90_123n,
        cache_write_tokens: 0n,
        estimated_cost: 1.234_567,
        footprint_tokens: 4096n,
      })
    );

    assert.equal(item.model, "claude-opus-5");
    assert.equal(item.inputTokens, 12_345);
    assert.equal(item.outputTokens, 678);
    assert.equal(item.cacheReadTokens, 90_123);
    assert.equal(item.cacheWriteTokens, 0);
    assert.equal(item.estimatedCost, 1.234_567);
    assert.equal(item.footprintTokens, 4096);
  });

  it("omits every uncaptured field rather than sending null", () => {
    const item = storedRowToSyncItem(row({}));

    for (const key of [
      "model",
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
      "estimatedCost",
      "footprintTokens",
    ]) {
      assert.equal(Object.hasOwn(item, key), false, key);
    }
    // A legacy row must serialize exactly as it did before the fields existed.
    assert.equal(
      JSON.stringify(item),
      JSON.stringify(storedRowToSyncItem(row({})))
    );
  });

  it("omits values the ingest boundary would reject outright", () => {
    const item = storedRowToSyncItem(
      row({
        component_kind: AgentComponentInvocationKind.Subagent,
        input_tokens: -1n,
        output_tokens: BigInt(Number.MAX_SAFE_INTEGER) + 2n,
        estimated_cost: 100_000_000,
        footprint_tokens: BigInt(Number.MAX_SAFE_INTEGER),
      })
    );

    assert.equal(Object.hasOwn(item, "inputTokens"), false);
    assert.equal(Object.hasOwn(item, "outputTokens"), false);
    assert.equal(Object.hasOwn(item, "estimatedCost"), false);
    assert.equal(item.footprintTokens, Number.MAX_SAFE_INTEGER);
  });

  it("rounds a captured cost only for the kind allowed to carry one", () => {
    assert.equal(
      storedRowToSyncItem(
        row({
          component_kind: AgentComponentInvocationKind.Subagent,
          estimated_cost: 0.123_456_789,
        })
      ).estimatedCost,
      0.123_457
    );
  });

  /**
   * ISS-4976 (@wongk review): both Prisma schemas define the model, the four
   * token counts, and the cost as per-SUBAGENT-TURN usage — "other kinds leave
   * them NULL" — so a non-subagent row holding one must not reach the wire, or
   * the shared ingest boundary rejects the whole part. `footprintTokens` is the
   * one kind-agnostic field and still rides along.
   */
  it("omits subagent-only usage on a non-subagent kind but keeps footprint", () => {
    for (const kind of [
      AgentComponentInvocationKind.Tool,
      AgentComponentInvocationKind.Skill,
      AgentComponentInvocationKind.Hook,
      AgentComponentInvocationKind.Command,
    ]) {
      const item = storedRowToSyncItem(
        row({
          component_kind: kind,
          model: "claude-opus-5",
          input_tokens: 10n,
          output_tokens: 20n,
          cache_read_tokens: 30n,
          cache_write_tokens: 40n,
          estimated_cost: 0.5,
          footprint_tokens: 4096n,
        })
      );

      for (const key of [
        "model",
        "inputTokens",
        "outputTokens",
        "cacheReadTokens",
        "cacheWriteTokens",
        "estimatedCost",
      ]) {
        assert.equal(Object.hasOwn(item, key), false, `${kind}.${key}`);
      }
      assert.equal(item.footprintTokens, 4096, kind);
    }
  });
});

function row(overrides: Partial<StoredInvocationRow>): StoredInvocationRow {
  return {
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
    invoked_at: "2026-08-03T16:00:00.000Z",
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
    ...overrides,
  };
}
