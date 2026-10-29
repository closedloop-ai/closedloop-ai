import { describe, expect, it } from "vitest";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_SUPPORTED_PROTOCOL_VERSIONS,
  AgentComponentInvocationKind,
  AgentComponentInvocationUsageMeasurement,
  agentComponentInvocationSyncProtocolVersionForItems,
} from "./agent-component-invocation.ts";
import {
  AGENT_COMPONENT_INVOCATION_TELEMETRY_READ_KEYS,
  agentComponentInvocationTelemetryFields,
} from "./agent-component-invocation-telemetry.ts";

const COST_PER_FINDING_KEY = /perFinding|findingCost|costPerFinding/i;

/**
 * ISS-10718 (@whitlockk, @tamsinb review): no ONE kind carries every key. The
 * labelled usage rides a kind something measures and `succeeded` a kind
 * something adjudicates, and those populations do not overlap — so the full
 * projection is the union of two sources, not one row.
 */
const MEASURED_SOURCE = {
  kind: AgentComponentInvocationKind.Subagent,
  model: "claude-opus-4",
  inputTokens: 1200,
  outputTokens: 340,
  cacheReadTokens: 5000,
  cacheWriteTokens: 64,
  estimatedCost: 0.123_456,
  footprintTokens: 4096,
  usageMeasurement: AgentComponentInvocationUsageMeasurement.Measured,
};

const ADJUDICATED_SOURCE = {
  kind: AgentComponentInvocationKind.Hook,
  succeeded: true,
};

/** A usage-bearing kind, for the cases whose subject is not the kind gate. */
const MEASURES = { kind: AgentComponentInvocationKind.Subagent } as const;

describe("agentComponentInvocationTelemetryFields", () => {
  it("publishes every stored value, and only the declared keys", () => {
    const measured = agentComponentInvocationTelemetryFields(MEASURED_SOURCE);
    expect(measured).toEqual({
      model: "claude-opus-4",
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 5000,
      cacheWriteTokens: 64,
      estimatedCost: 0.123_456,
      footprintTokens: 4096,
      // Literal, not the constant: renaming the wire value must redden here.
      usageMeasurement: "measured",
    });
    const adjudicated =
      agentComponentInvocationTelemetryFields(ADJUDICATED_SOURCE);
    expect(adjudicated).toEqual({ succeeded: true });
    expect(
      [...Object.keys(measured), ...Object.keys(adjudicated)].sort()
    ).toEqual([...AGENT_COMPONENT_INVOCATION_TELEMETRY_READ_KEYS].sort());
  });

  it("withholds a value from a kind whose write side calls it corruption", () => {
    // The desktop store can hold either column on any kind; the wire projection
    // and the ingest boundary both refuse them off-population, so a read that
    // published them would put a number on one surface the other never has.
    const hookUsage = agentComponentInvocationTelemetryFields({
      kind: AgentComponentInvocationKind.Hook,
      model: "claude-opus-4",
      inputTokens: 1200,
      estimatedCost: 0.5,
      usageMeasurement: AgentComponentInvocationUsageMeasurement.Measured,
      footprintTokens: 4096,
    });
    // footprintTokens is kind-agnostic by design and survives.
    expect(hookUsage).toEqual({ footprintTokens: 4096 });

    const subagentVerdict = agentComponentInvocationTelemetryFields({
      kind: AgentComponentInvocationKind.Subagent,
      succeeded: false,
    });
    expect(Object.hasOwn(subagentVerdict, "succeeded")).toBe(false);

    for (const kind of [
      AgentComponentInvocationKind.Tool,
      AgentComponentInvocationKind.Mcp,
      AgentComponentInvocationKind.Orchestration,
    ]) {
      expect(
        agentComponentInvocationTelemetryFields({ kind, succeeded: false })
      ).toEqual({ succeeded: false });
    }

    // A source that cannot state its kind gets neither gate's fields.
    expect(
      agentComponentInvocationTelemetryFields({
        inputTokens: 10,
        succeeded: true,
        footprintTokens: 1,
      })
    ).toEqual({ footprintTokens: 1 });
  });

  it("omits every absent value rather than serializing null or zero", () => {
    const fields = agentComponentInvocationTelemetryFields({
      model: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      estimatedCost: null,
      footprintTokens: null,
      usageMeasurement: null,
      succeeded: null,
    });
    expect(fields).toEqual({});
    expect(JSON.stringify(fields)).toBe("{}");
    // The one that matters most: a confident $0 for a cost nobody computed.
    expect(Object.hasOwn(fields, "estimatedCost")).toBe(false);
    expect(agentComponentInvocationTelemetryFields({})).toEqual({});
  });

  it("distinguishes a measured zero from an absent value", () => {
    const measuredZero = agentComponentInvocationTelemetryFields({
      ...MEASURES,
      inputTokens: 0,
      estimatedCost: 0,
      footprintTokens: 0,
      usageMeasurement: AgentComponentInvocationUsageMeasurement.Measured,
    });
    expect(measuredZero).toEqual({
      inputTokens: 0,
      estimatedCost: 0,
      footprintTokens: 0,
      usageMeasurement: "measured",
    });
    expect(JSON.stringify(measuredZero)).not.toBe(
      JSON.stringify(agentComponentInvocationTelemetryFields({}))
    );
  });

  it("carries the measurement label with the counts it describes", () => {
    for (const measurement of Object.values(
      AgentComponentInvocationUsageMeasurement
    )) {
      const fields = agentComponentInvocationTelemetryFields({
        ...MEASURES,
        inputTokens: 10,
        usageMeasurement: measurement,
      });
      expect(fields.usageMeasurement).toBe(measurement);
      expect(fields.inputTokens).toBe(10);
    }
  });

  it("drops the counts a label it cannot read would have described", () => {
    // A measured count and a session-average share must not arrive
    // indistinguishable, so an unreadable label takes its counts with it.
    const fields = agentComponentInvocationTelemetryFields({
      ...MEASURES,
      model: "claude-opus-4",
      inputTokens: 10,
      outputTokens: 20,
      estimatedCost: 1.5,
      footprintTokens: 4096,
      usageMeasurement: "guessed",
    });
    expect(fields).toEqual({ footprintTokens: 4096 });
  });

  it("keeps unlabelled counts written before the label existed", () => {
    const fields = agentComponentInvocationTelemetryFields({
      ...MEASURES,
      inputTokens: 10,
      outputTokens: 20,
    });
    expect(fields).toEqual({ inputTokens: 10, outputTokens: 20 });
    expect(Object.hasOwn(fields, "usageMeasurement")).toBe(false);
  });

  it("never publishes a label with nothing to describe", () => {
    expect(
      agentComponentInvocationTelemetryFields({
        ...MEASURES,
        usageMeasurement: AgentComponentInvocationUsageMeasurement.Estimated,
        footprintTokens: 4096,
      })
    ).toEqual({ footprintTokens: 4096 });
  });

  it("refuses a count that cannot describe a real run", () => {
    for (const value of [-1, 1.5, Number.POSITIVE_INFINITY, Number.NaN]) {
      const fields = agentComponentInvocationTelemetryFields({
        ...MEASURES,
        inputTokens: value,
        footprintTokens: value,
      });
      expect(fields).toEqual({});
    }
    expect(
      agentComponentInvocationTelemetryFields({
        ...MEASURES,
        estimatedCost: -0.01,
      })
    ).toEqual({});
  });

  it("keeps succeeded three-valued", () => {
    const adjudicates = { kind: AgentComponentInvocationKind.Hook } as const;
    expect(
      agentComponentInvocationTelemetryFields({
        ...adjudicates,
        succeeded: true,
      }).succeeded
    ).toBe(true);
    expect(
      agentComponentInvocationTelemetryFields({
        ...adjudicates,
        succeeded: false,
      }).succeeded
    ).toBe(false);
    const unknown = agentComponentInvocationTelemetryFields({
      ...adjudicates,
      succeeded: null,
    });
    expect(Object.hasOwn(unknown, "succeeded")).toBe(false);
    // "not a fact this kind records" and "this failed" are different rows.
    expect(JSON.stringify(unknown)).not.toContain("succeeded");
  });

  it("carries no cost-per-finding value", () => {
    for (const key of Object.keys(
      agentComponentInvocationTelemetryFields(MEASURED_SOURCE)
    )) {
      expect(key).not.toMatch(COST_PER_FINDING_KEY);
    }
  });
});

describe("succeeded protocol gate", () => {
  it("declares a version an older API refuses retryably", () => {
    // Non-circular literals: a sibling changed a version constant and every
    // test stayed green because they all read it through the constant.
    expect([
      ...AGENT_COMPONENT_INVOCATION_SYNC_SUPPORTED_PROTOCOL_VERSIONS,
      // ISS-10726 added v5 for the findings funnel, ISS-10730 added v6 for line
      // attribution, ISS-10720 added v7 for the OTel evidence class and
      // attribution source and ISS-11325 added v8 for the findings disposition;
      // v4 stays `succeeded`.
      // v10 is `succeeded` on a tool-result kind.
    ]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(
      agentComponentInvocationSyncProtocolVersionForItems([{ succeeded: true }])
    ).toBe(4);
    expect(
      agentComponentInvocationSyncProtocolVersionForItems([
        { succeeded: false },
      ])
    ).toBe(4);
  });

  it("leaves every older part on the version it already declared", () => {
    expect(agentComponentInvocationSyncProtocolVersionForItems([{}])).toBe(1);
    expect(
      agentComponentInvocationSyncProtocolVersionForItems([{ inputTokens: 1 }])
    ).toBe(2);
    expect(
      agentComponentInvocationSyncProtocolVersionForItems([
        {
          inputTokens: 1,
          usageMeasurement: AgentComponentInvocationUsageMeasurement.Measured,
        },
      ])
    ).toBe(3);
  });

  it("lifts the whole part when any one item carries succeeded", () => {
    expect(
      agentComponentInvocationSyncProtocolVersionForItems([
        { inputTokens: 1 },
        { succeeded: true },
      ])
    ).toBe(4);
  });

  it("keeps a hook verdict on v4 and lifts a tool-result verdict to v10", () => {
    expect(
      agentComponentInvocationSyncProtocolVersionForItems([
        { kind: AgentComponentInvocationKind.Hook, succeeded: false },
      ])
    ).toBe(4);
    for (const kind of [
      AgentComponentInvocationKind.Tool,
      AgentComponentInvocationKind.Mcp,
      AgentComponentInvocationKind.Orchestration,
    ]) {
      expect(
        agentComponentInvocationSyncProtocolVersionForItems([
          { kind: AgentComponentInvocationKind.Hook, succeeded: true },
          { kind, durationMs: 5, succeeded: false },
        ])
      ).toBe(10);
      expect(
        agentComponentInvocationSyncProtocolVersionForItems([{ kind }])
      ).toBe(1);
    }
  });
});
