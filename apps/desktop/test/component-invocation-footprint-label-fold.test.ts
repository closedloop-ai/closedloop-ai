/**
 * @file component-invocation-footprint-label-fold.test.ts
 * @description ISS-10736: `usage_measurement` is ONE column labelling the whole
 * row's telemetry, and a row can now carry two populations arrived at two
 * different ways — ISS-7795's provider-reported turn counts and this ticket's
 * derived context footprint. These cases pin which label wins, because getting
 * it backwards publishes a derived number under a `measured` label, which is the
 * plausible-but-wrong measurement AGENTS.md forbids outright.
 */
import assert from "node:assert/strict";
import {
  AgentComponentInvocationKind,
  AgentComponentInvocationUsageMeasurement,
} from "@repo/api/src/types/agent-component-invocation";
import { describe, it } from "vitest";
import { storedResultPayloadFootprint } from "../src/main/database/component-invocation-footprint-sources.js";
import { preserveMeasuredTelemetry } from "../src/main/database/component-invocation-prior-measurements.js";
import { invocationFootprintColumns } from "../src/main/database/component-invocation-row-writer.js";
import { applyStoredSpawnClaimKeys } from "../src/main/database/component-invocation-stored-candidates.js";
import { importToolEventData } from "../src/main/database/import-metadata-builders.js";
import { DELEGATION_TOOL_NAMES } from "../src/main/database/subagent-dedup.js";

const ESTIMATED_FOOTPRINT = {
  footprintTokens: 512,
  usageMeasurement: AgentComponentInvocationUsageMeasurement.Estimated,
} as const;

describe("ISS-10736 footprint / usage-measurement label fold", () => {
  it("labels a lone footprint with its own derivation", () => {
    assert.deepEqual(
      invocationFootprintColumns({
        footprint: ESTIMATED_FOOTPRINT,
        telemetry: { usageMeasurement: null },
      }),
      {
        footprintTokens: 512,
        usageMeasurement: AgentComponentInvocationUsageMeasurement.Estimated,
      }
    );
  });

  it("withholds a derived footprint rather than wearing a measured label", () => {
    assert.deepEqual(
      invocationFootprintColumns({
        footprint: ESTIMATED_FOOTPRINT,
        telemetry: {
          usageMeasurement: AgentComponentInvocationUsageMeasurement.Measured,
        },
      }),
      {
        footprintTokens: null,
        // The provider-reported counts keep the label they earned; demoting
        // them would be a different wrong answer, not a safer one.
        usageMeasurement: AgentComponentInvocationUsageMeasurement.Measured,
        footprintRefusedUnlabelled: true,
      }
    );
  });

  it("leaves a measured row's label alone when no footprint was resolved", () => {
    assert.deepEqual(
      invocationFootprintColumns({
        footprint: undefined,
        telemetry: {
          usageMeasurement: AgentComponentInvocationUsageMeasurement.Measured,
        },
      }),
      {
        footprintTokens: null,
        usageMeasurement: AgentComponentInvocationUsageMeasurement.Measured,
      }
    );
  });

  it("writes no label on a row with no telemetry at all", () => {
    assert.deepEqual(
      invocationFootprintColumns({
        footprint: undefined,
        telemetry: { usageMeasurement: null },
      }),
      { footprintTokens: null, usageMeasurement: null }
    );
  });

  it("keeps the footprint when both derivations agree", () => {
    assert.deepEqual(
      invocationFootprintColumns({
        footprint: ESTIMATED_FOOTPRINT,
        telemetry: {
          usageMeasurement: AgentComponentInvocationUsageMeasurement.Estimated,
        },
      }),
      {
        footprintTokens: 512,
        usageMeasurement: AgentComponentInvocationUsageMeasurement.Estimated,
      }
    );
  });

  it("marks a withheld footprint so the NULL is not read as never-computed", () => {
    assert.equal(
      invocationFootprintColumns({
        footprint: ESTIMATED_FOOTPRINT,
        telemetry: {
          usageMeasurement: AgentComponentInvocationUsageMeasurement.Measured,
        },
      }).footprintRefusedUnlabelled,
      true
    );
    // The flag describes a refusal, so it must not appear on a row that kept it.
    assert.equal(
      invocationFootprintColumns({
        footprint: ESTIMATED_FOOTPRINT,
        telemetry: { usageMeasurement: null },
      }).footprintRefusedUnlabelled,
      undefined
    );
  });
});

/**
 * ISS-10736. The stored-row rebuild lane reads ONE persisted count,
 * `toolFootprintTokens`, which `importToolEventData` writes from the tool RESULT
 * for every tool_use uniformly — including the ones `classifyStoredTool` later
 * resolves to `skill`, whose footprint is declared to be its DEFINITION BODY.
 * Attaching it there would publish one source's number under another's name, so
 * the gate reads the declaration rather than the row.
 */
describe("ISS-10736 stored-rebuild footprint is gated on the declared source", () => {
  const STORED = { toolFootprintTokens: 4096 };

  it("carries the stored count for every result-payload kind", () => {
    for (const kind of [
      AgentComponentInvocationKind.Tool,
      AgentComponentInvocationKind.Mcp,
      AgentComponentInvocationKind.Orchestration,
    ]) {
      assert.deepEqual(
        storedResultPayloadFootprint(kind, STORED),
        {
          footprint: {
            footprintTokens: 4096,
            usageMeasurement:
              AgentComponentInvocationUsageMeasurement.Estimated,
          },
        },
        kind
      );
    }
  });

  it("refuses the result-payload count for every other kind", () => {
    for (const kind of [
      AgentComponentInvocationKind.Skill,
      AgentComponentInvocationKind.Command,
      AgentComponentInvocationKind.Subagent,
      AgentComponentInvocationKind.Hook,
    ]) {
      assert.deepEqual(storedResultPayloadFootprint(kind, STORED), {}, kind);
    }
  });

  it("carries nothing when the stored row holds no count", () => {
    assert.deepEqual(
      storedResultPayloadFootprint(AgentComponentInvocationKind.Tool, {}),
      {}
    );
    assert.deepEqual(
      storedResultPayloadFootprint(AgentComponentInvocationKind.Tool, null),
      {}
    );
  });

  it("refuses a stored cell that is not a usable count", () => {
    for (const value of ["4096", 1.5, -1, Number.NaN]) {
      assert.deepEqual(
        storedResultPayloadFootprint(AgentComponentInvocationKind.Tool, {
          toolFootprintTokens: value,
        }),
        {}
      );
    }
  });
});

/**
 * ISS-10736: the stored-rebuild lane's two halves, JOINED.
 *
 * `importToolEventData` is the only writer of the persisted count and
 * `storedResultPayloadFootprint` the only reader, and they agree on a key name
 * nothing else checks. The cases above hand the reader a fixture built by hand,
 * which agrees with itself on both sides and so pins nothing across the
 * persistence boundary: rename the writer's key and they stay green while the
 * rebuild lane silently returns to a NULL footprint on every row — the exact
 * state this ticket exists to end, on the one lane with no transcript to
 * recount from. This case round-trips the real payload instead.
 */
describe("ISS-10736 stored footprint survives the real persistence round trip", () => {
  it("reads back the count the import writer actually persisted", () => {
    const persisted = importToolEventData({
      name: "Read",
      normalizedName: "Read",
      kind: "builtin",
      timestamp: "2026-09-23T12:00:00.000Z",
      output: "short prefix",
      outputFootprintTokens: 4096,
    });

    assert.ok(persisted, "the writer must persist a payload");
    const data = JSON.parse(persisted) as Record<string, unknown>;
    assert.deepEqual(
      storedResultPayloadFootprint(AgentComponentInvocationKind.Tool, data),
      {
        footprint: {
          footprintTokens: 4096,
          usageMeasurement: AgentComponentInvocationUsageMeasurement.Estimated,
        },
      }
    );
  });

  it("survives the row-size cap that drops the heavy detail keys", () => {
    // The cap drops `tool_input`/`tool_response` wholesale, and the rows that
    // trip it are exactly the big-result ones whose footprint matters most —
    // which is why the count rides the small analytics keys instead.
    const persisted = importToolEventData({
      name: "Read",
      normalizedName: "Read",
      kind: "builtin",
      timestamp: "2026-09-23T12:00:00.000Z",
      output: "x".repeat(200_000),
      outputFootprintTokens: 50_000,
    });

    assert.ok(persisted);
    const data = JSON.parse(persisted) as Record<string, unknown>;
    assert.equal(
      Object.hasOwn(data, "tool_response"),
      false,
      "the oversized detail must have been dropped for this case to mean anything"
    );
    assert.deepEqual(
      storedResultPayloadFootprint(AgentComponentInvocationKind.Tool, data),
      {
        footprint: {
          footprintTokens: 50_000,
          usageMeasurement: AgentComponentInvocationUsageMeasurement.Estimated,
        },
      }
    );
  });

  it("reads back nothing when the writer saw no result to count", () => {
    const persisted = importToolEventData({
      name: "Read",
      normalizedName: "Read",
      kind: "builtin",
      timestamp: "2026-09-23T12:00:00.000Z",
      input: { file_path: "/x" },
    });

    assert.ok(persisted);
    assert.deepEqual(
      storedResultPayloadFootprint(
        AgentComponentInvocationKind.Tool,
        JSON.parse(persisted) as Record<string, unknown>
      ),
      {}
    );
  });
});

/**
 * ISS-10736 (tamsinb review of #7816): the rebuild lane must attribute a
 * delegation's footprint to the SAME KIND the transcript lane does.
 *
 * `importToolEventData` persists `toolFootprintTokens` for every tool_use
 * uniformly, and `classifyStoredTool` resolves a stored `Task`/`Agent` row to
 * `tool` (or `orchestration`) — both result-payload kinds — so the stored row
 * picked the count up while the transcript lane deliberately gives it to the
 * `subagent` row. The session total reconciled either way; the PER-KIND totals
 * flipped the moment a transcript rotated away and the session rebuilt.
 */
describe("ISS-10736 the rebuild lane gives a delegation footprint to its subagent", () => {
  function delegationEvent() {
    return {
      agentId: "agent-7",
      providerToolUseId: "toolu_deleg",
      rawName: "Task",
      footprintTokens: 4096,
      usageMeasurement: AgentComponentInvocationUsageMeasurement.Estimated,
    } as Parameters<typeof applyStoredSpawnClaimKeys>[1][number];
  }

  function subagentRow(
    usageMeasurement: AgentComponentInvocationUsageMeasurement | null = null
  ) {
    return {
      agentId: "agent-7",
      footprintTokens: null,
      usageMeasurement,
    } as Parameters<typeof applyStoredSpawnClaimKeys>[0][number];
  }

  it("moves the count off the delegating event and onto the subagent", () => {
    const event = delegationEvent();
    const subagent = subagentRow();
    applyStoredSpawnClaimKeys([subagent], [event], DELEGATION_TOOL_NAMES);

    // The pairing itself still happens.
    assert.equal(subagent.providerToolUseId, "toolu_deleg");
    // The delegating `tool` row carries none — matching the transcript lane.
    assert.equal(event.footprintTokens, null);
    // …and the `subagent` row, whose declared source IS the returned text, owns
    // it, with its own derivation stated.
    assert.equal(subagent.footprintTokens, 4096);
    assert.equal(
      subagent.usageMeasurement,
      AgentComponentInvocationUsageMeasurement.Estimated
    );
  });

  it("releases the count even when no subagent claims it", () => {
    // Parity, not thrift: the transcript lane drops it from the delegating row
    // whether or not a `subagent` row ends up existing, so a rebuild must not
    // leave a delegation footprint on a `tool` row just because pairing missed.
    const event = delegationEvent();
    applyStoredSpawnClaimKeys([], [event], DELEGATION_TOOL_NAMES);

    assert.equal(event.footprintTokens, null);
  });

  it("leaves a non-delegating event's own footprint alone", () => {
    const event = {
      ...delegationEvent(),
      rawName: "Read",
    } as Parameters<typeof applyStoredSpawnClaimKeys>[1][number];
    const subagent = subagentRow();
    applyStoredSpawnClaimKeys([subagent], [event], DELEGATION_TOOL_NAMES);

    assert.equal(event.footprintTokens, 4096);
    assert.equal(subagent.footprintTokens, null);
  });

  it("withholds rather than relabels when the subagent row already measured", () => {
    const event = delegationEvent();
    const subagent = subagentRow(
      AgentComponentInvocationUsageMeasurement.Measured
    );
    applyStoredSpawnClaimKeys([subagent], [event], DELEGATION_TOOL_NAMES);

    assert.equal(subagent.footprintTokens, null);
    assert.equal(
      subagent.usageMeasurement,
      AgentComponentInvocationUsageMeasurement.Measured
    );
    assert.equal(subagent.footprintRefusedUnlabelled, true);
  });
});

/**
 * ISS-10736 regression on ISS-7795's preservation rule.
 *
 * `preserveMeasuredTelemetry` used to decide "this candidate already measured"
 * by reading `usageMeasurement`, which was a faithful proxy only because
 * `invocationTelemetryColumns` writes that label if and only if it writes real
 * counts. A derived FOOTPRINT now carries the same column, so a candidate that
 * measured nothing labels itself `estimated` — and reading the label would let
 * that disarm the guard and replace a prior row's real counts with NULL, the
 * value that means "never measured".
 */
describe("ISS-10736 a footprint label does not disarm measured-telemetry preservation", () => {
  const priorRow = {
    external_invocation_id: "inv-1",
    external_source_id: null,
    child_session_id: null,
    component_kind: AgentComponentInvocationKind.Skill,
    component_key: "logical-qa",
    relationship: "direct",
    anchor_kind: "timestamp",
    anchor_value: "anchor",
    provider_tool_use_id: null,
    attribution_status: "matched",
    evidence_class: "none",
    evidence_pointer: null,
    definition_hash: null,
    normalizer_contract_version: null,
    definition_content: null,
    local_component_version_id: null,
    model: "claude-opus-5",
    input_tokens: 41n,
    output_tokens: 7n,
    cache_read_tokens: null,
    cache_write_tokens: null,
    estimated_cost: 0.5,
    usage_measurement: AgentComponentInvocationUsageMeasurement.Measured,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
  } as Parameters<typeof preserveMeasuredTelemetry>[1];

  function footprintOnlyCandidate() {
    return {
      model: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      estimatedCost: null,
      // The footprint's own label, on a row that measured no turn usage.
      usageMeasurement: AgentComponentInvocationUsageMeasurement.Estimated,
      footprintTokens: 40,
    } as Parameters<typeof preserveMeasuredTelemetry>[0];
  }

  it("carries the prior measurement forward onto a footprint-only candidate", () => {
    const candidate = footprintOnlyCandidate();
    preserveMeasuredTelemetry(candidate, priorRow);

    assert.equal(candidate.model, "claude-opus-5");
    assert.equal(candidate.inputTokens, 41);
    assert.equal(candidate.outputTokens, 7);
    assert.equal(candidate.estimatedCost, 0.5);
    assert.equal(
      candidate.usageMeasurement,
      AgentComponentInvocationUsageMeasurement.Measured
    );
  });

  /**
   * tamsinb + whitlockk, review of #7816. Promoting the prior `measured` label is
   * the one place a derived footprint can end up wearing it: the candidate went
   * through `invocationFootprintColumns` BEFORE this runs, so the fold's refusal
   * has already happened and cannot happen again. Without the withholding here
   * the row reaches the writer as footprint_tokens=40 under
   * usage_measurement=measured — the exact pair that fold exists to refuse.
   */
  it("withholds the derived footprint it would otherwise label `measured`", () => {
    const candidate = footprintOnlyCandidate();
    preserveMeasuredTelemetry(candidate, priorRow);

    assert.equal(
      candidate.usageMeasurement,
      AgentComponentInvocationUsageMeasurement.Measured
    );
    assert.equal(candidate.footprintTokens, null);
    // The NULL has to stay distinguishable from "nothing ever computed one".
    assert.equal(candidate.footprintRefusedUnlabelled, true);
  });

  it("keeps the footprint when the prior row states the same derivation", () => {
    const candidate = footprintOnlyCandidate();
    preserveMeasuredTelemetry(candidate, {
      ...priorRow,
      usage_measurement: AgentComponentInvocationUsageMeasurement.Estimated,
    } as Parameters<typeof preserveMeasuredTelemetry>[1]);

    // Real prior counts were still promoted, so the preservation rule ran.
    assert.equal(candidate.inputTokens, 41);
    // Both populations are `estimated`, so one column states both truthfully.
    assert.equal(candidate.footprintTokens, 40);
    assert.equal(candidate.footprintRefusedUnlabelled, undefined);
  });

  it("still lets a candidate that DID measure keep its own value", () => {
    const candidate = {
      ...footprintOnlyCandidate(),
      model: "claude-sonnet-4-5",
      inputTokens: 9,
      usageMeasurement: AgentComponentInvocationUsageMeasurement.Measured,
    } as Parameters<typeof preserveMeasuredTelemetry>[0];
    preserveMeasuredTelemetry(candidate, priorRow);

    assert.equal(candidate.model, "claude-sonnet-4-5");
    assert.equal(candidate.inputTokens, 9);
  });

  it("promotes nothing from a prior row that carried only a footprint label", () => {
    // Such a row states `estimated` over all-NULL counts; copying its label onto
    // a candidate with no telemetry would assert a label about nothing, which
    // the wire boundary rejects as `usage_measurement_requires_telemetry`.
    const candidate = {
      ...footprintOnlyCandidate(),
      usageMeasurement: null,
      footprintTokens: null,
    } as Parameters<typeof preserveMeasuredTelemetry>[0];
    preserveMeasuredTelemetry(candidate, {
      ...priorRow,
      model: null,
      input_tokens: null,
      output_tokens: null,
      estimated_cost: null,
      usage_measurement: AgentComponentInvocationUsageMeasurement.Estimated,
    } as Parameters<typeof preserveMeasuredTelemetry>[1]);

    assert.equal(candidate.usageMeasurement, null);
    assert.equal(candidate.model, null);
  });
});
