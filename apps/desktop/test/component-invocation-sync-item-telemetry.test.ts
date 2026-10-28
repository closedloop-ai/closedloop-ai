import assert from "node:assert/strict";
import {
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
  AgentComponentInvocationUsageMeasurement,
} from "@repo/api/src/types/agent-component-invocation";
import { agentComponentInvocationSyncItemSchema } from "@repo/api/src/types/agent-component-invocation-schema";
import { describe, it } from "vitest";
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
        // ISS-10736: the footprint is telemetry, so the label the boundary
        // requires alongside any telemetry now rides with it. This fixture used
        // to omit it and still expect the footprint on the wire — a shape that
        // could never have shipped, because the part schema fails an unlabelled
        // telemetry item as `telemetry_requires_usage_measurement`.
        usage_measurement: AgentComponentInvocationUsageMeasurement.Estimated,
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

  /**
   * ISS-10736. The footprint is telemetry, so the part schema fails any item
   * carrying it without a label as `telemetry_requires_usage_measurement` — and
   * that verdict kills the WHOLE part, every sibling row with it. So an
   * unlabelled stored footprint degrades to no footprint, exactly as an
   * unreadable label already costs a row its counts.
   */
  it("drops a footprint the stored row cannot label", () => {
    const item = storedRowToSyncItem(
      row({
        component_kind: AgentComponentInvocationKind.Tool,
        footprint_tokens: 4096n,
        usage_measurement: null,
      })
    );

    assert.equal(Object.hasOwn(item, "footprintTokens"), false);
    assert.equal(Object.hasOwn(item, "usageMeasurement"), false);
  });

  it("drops a footprint whose stored label this build cannot read", () => {
    const item = storedRowToSyncItem(
      row({
        component_kind: AgentComponentInvocationKind.Tool,
        footprint_tokens: 4096n,
        usage_measurement: "counted-by-a-newer-build",
      })
    );

    assert.equal(Object.hasOwn(item, "footprintTokens"), false);
  });

  it("emits a labelled footprint on a kind that measures no turn usage", () => {
    const item = storedRowToSyncItem(
      row({
        component_kind: AgentComponentInvocationKind.Tool,
        footprint_tokens: 1024n,
        usage_measurement: AgentComponentInvocationUsageMeasurement.Estimated,
      })
    );

    assert.equal(item.footprintTokens, 1024);
    assert.equal(
      item.usageMeasurement,
      AgentComponentInvocationUsageMeasurement.Estimated
    );
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
        usage_measurement: AgentComponentInvocationUsageMeasurement.Estimated,
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
   * ISS-4976 kept these columns off any kind that could not have computed them,
   * because the shared ingest boundary rejects the whole part over one.
   * `footprintTokens` is the one kind-agnostic field and still rides along.
   *
   * ISS-7795 removed `skill` and `command` from this list — a deliberate
   * behavior change, not a weakened expectation. Both now have a producer (the
   * harness's per-turn attribution stamp measures them), so their usage is a
   * real measurement rather than a value nothing computed. `tool` and `hook`
   * stay here because nothing measures them, which is what this case still
   * guards; the sibling case below asserts the two newly-admitted kinds DO carry
   * their counts, so the narrowing cannot pass by the gate simply going quiet.
   */
  it("omits usage on a kind nothing measures but keeps footprint", () => {
    for (const kind of [
      AgentComponentInvocationKind.Tool,
      AgentComponentInvocationKind.Hook,
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
          usage_measurement: AgentComponentInvocationUsageMeasurement.Estimated,
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

  /**
   * The opposite state of the case above, over the two kinds ISS-7795 admitted.
   * Without this, deleting `skill`/`command` from that list would look identical
   * to the gate having stopped emitting them at all.
   */
  it("carries measured usage on the kinds ISS-7795 admitted", () => {
    for (const kind of [
      AgentComponentInvocationKind.Skill,
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
          usage_measurement: AgentComponentInvocationUsageMeasurement.Measured,
          attribution_source: null,
        })
      );

      assert.equal(item.model, "claude-opus-5", kind);
      assert.equal(item.inputTokens, 10, kind);
      assert.equal(item.outputTokens, 20, kind);
      assert.equal(item.cacheReadTokens, 30, kind);
      assert.equal(item.cacheWriteTokens, 40, kind);
      assert.equal(
        item.usageMeasurement,
        AgentComponentInvocationUsageMeasurement.Measured,
        kind
      );
    }
  });

  /**
   * The label describes the counts, so alone it describes nothing. Emitting it
   * on a row with no telemetry would fail the shared boundary as
   * `usage_measurement_requires_telemetry` and dead-letter the whole part.
   */
  it("drops a measurement label on a row carrying no telemetry", () => {
    const item = storedRowToSyncItem(
      row({
        component_kind: AgentComponentInvocationKind.Skill,
        usage_measurement: AgentComponentInvocationUsageMeasurement.Measured,
        attribution_source: null,
      })
    );

    assert.equal(Object.hasOwn(item, "usageMeasurement"), false);
  });

  /**
   * ISS-10730 row -> wire round trip. TWO rows with DIFFERENT deltas, so the
   * assertion cannot pass on a shared number, and the boundary is re-checked on
   * what the projection actually emits rather than on a hand-built item.
   */
  it("projects each row's own line delta onto the wire item", () => {
    const first = storedRowToSyncItem(
      row({ lines_added: 12, lines_removed: 4 })
    );
    const second = storedRowToSyncItem(
      row({
        external_invocation_id: "invocation-2",
        lines_added: 0,
        lines_removed: 37,
      })
    );

    assert.equal(first.linesAdded, 12);
    assert.equal(first.linesRemoved, 4);
    assert.equal(second.linesAdded, 0);
    assert.equal(second.linesRemoved, 37);
    assert.equal(
      agentComponentInvocationSyncItemSchema.safeParse(first).success,
      true
    );
  });

  /**
   * A half-written delta is corruption, not a smaller measurement: emitting the
   * good half would publish a confident wrong number, and an absent optional is
   * an OMITTED key so the wire stays byte-identical to a pre-ISS-10730 build's.
   */
  it("omits BOTH keys when only one line column was written", () => {
    const item = storedRowToSyncItem(
      row({ lines_added: 12, lines_removed: null })
    );

    assert.equal(Object.hasOwn(item, "linesAdded"), false);
    assert.equal(Object.hasOwn(item, "linesRemoved"), false);
  });

  /** A kind the wire boundary refuses lines on must never be handed one. */
  it("drops a line delta stored on a kind nothing measures lines for", () => {
    const item = storedRowToSyncItem(
      row({
        component_kind: AgentComponentInvocationKind.Skill,
        lines_added: 12,
        lines_removed: 4,
      })
    );

    assert.equal(Object.hasOwn(item, "linesAdded"), false);
  });

  /**
   * ISS-10718 (@whitlockk review): `succeeded` rides only a kind something
   * adjudicates, the way the usage fields ride only a kind something measures.
   * Hook firings are the only producer of a verdict, and the shared boundary now
   * refuses one anywhere else as `succeeded_requires_success_bearing_kind` — a
   * verdict `assertPartSatisfiesWireContract` would raise ON THE DEVICE, so this
   * projection must never build such an item in the first place.
   */
  it("emits a hook verdict in both directions", () => {
    for (const stored of [true, false, 1, 0] as const) {
      const item = storedRowToSyncItem(
        row({
          component_kind: AgentComponentInvocationKind.Hook,
          succeeded: stored,
        })
      );
      assert.equal(item.succeeded, stored === true || stored === 1);
    }
  });

  it("carries a stored tool-result verdict on every tool-result kind", () => {
    for (const kind of [
      AgentComponentInvocationKind.Tool,
      AgentComponentInvocationKind.Mcp,
      AgentComponentInvocationKind.Orchestration,
    ]) {
      for (const [stored, succeeded] of [
        [0, false],
        [1, true],
      ] as const) {
        const item = storedRowToSyncItem(
          row({ component_kind: kind, succeeded: stored })
        );
        assert.equal(item.succeeded, succeeded, kind);
      }
      const unknown = storedRowToSyncItem(
        row({ component_kind: kind, succeeded: null })
      );
      assert.equal(Object.hasOwn(unknown, "succeeded"), false, kind);
    }
  });

  it("omits a verdict on a kind nothing adjudicates", () => {
    for (const kind of [
      AgentComponentInvocationKind.Command,
      AgentComponentInvocationKind.Subagent,
      AgentComponentInvocationKind.Skill,
    ]) {
      const item = storedRowToSyncItem(
        row({ component_kind: kind, succeeded: true })
      );
      assert.equal(Object.hasOwn(item, "succeeded"), false, kind);
    }
  });

  it("omits a verdict outside the closed two-value domain", () => {
    // A 2 in a boolean column is corruption; rendering it as a confident
    // `false` is worse than not answering.
    const item = storedRowToSyncItem(
      row({ component_kind: AgentComponentInvocationKind.Hook, succeeded: 2 })
    );
    assert.equal(Object.hasOwn(item, "succeeded"), false);
  });
});

function row(overrides: Partial<StoredInvocationRow>): StoredInvocationRow {
  return {
    succeeded: null,
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
    usage_measurement: null,
    lines_added: null,
    lines_removed: null,
    findings_emitted: null,
    findings_invalidated: null,
    // ISS-11325: no disposition recorded on a fixture the findings ingest never reached.
    findings_disposition: null,
    attribution_source: null,
    ...overrides,
  };
}
