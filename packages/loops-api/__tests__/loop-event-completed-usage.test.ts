/**
 * @file loop-event-completed-usage.test.ts
 * @description Boundary coverage for the `usageReconciliation` block the
 * desktop gateway attaches to the completed loop event (PRD-538 R1/R2,
 * ISS-5349). This schema is the cross-repo contract: the payload is persisted
 * verbatim in `loop_events.data`, so a field the schema does not know is a
 * field no consumer can trust.
 */
import { describe, expect, it } from "vitest";
import {
  LoopEventCompletedSchema,
  LoopReconciliationStatus,
  LoopSessionOrigin,
  LoopUsageReconciliationSchema,
} from "../src/events.js";

const BASE_COMPLETED = {
  type: "completed",
  result: { success: true },
  tokensUsed: { input: 100, output: 50 },
  timestamp: "2026-08-06T00:00:00.000Z",
} as const;

/** The full harness-stdout block, exactly as the desktop finalizer emits it. */
const FULL_RECONCILIATION = {
  sessionOrigin: LoopSessionOrigin.HarnessStdout,
  authoritativeCostUsd: 1.2345,
  derivedCostUsd: 1.23,
  reconciliationStatus: LoopReconciliationStatus.Matched,
  reconciliationDeltaUsd: -0.0045,
  harnessNumTurns: 7,
  harnessDurationMs: 42_000,
  harnessDurationApiMs: 30_000,
  harnessStopReason: "end_turn",
  harnessUsage: {
    input: 100,
    output: 50,
    cacheRead: 900,
    cacheWrite: 200,
    webSearchRequests: 3,
  },
  harnessModelUsage: {
    "claude-opus-4-5": {
      input: 100,
      output: 50,
      cacheRead: 900,
      cacheCreation: 200,
      costUsd: 1.2345,
    },
  },
  harnessPermissionDenials: [{ toolName: "Bash", toolUseId: "toolu_01" }],
};

describe("LoopUsageReconciliationSchema", () => {
  it("accepts the full authoritative block from a harness stdout capture", () => {
    const parsed = LoopUsageReconciliationSchema.safeParse(FULL_RECONCILIATION);

    expect(parsed.success).toBe(true);
    // Every field survives the boundary — none is silently stripped.
    expect(parsed.success && parsed.data).toEqual(FULL_RECONCILIATION);
  });

  it("accepts an imported transcript's block, where authoritative fields are omitted", () => {
    const parsed = LoopUsageReconciliationSchema.safeParse({
      sessionOrigin: LoopSessionOrigin.PersistentTranscript,
      authoritativeCostUsd: null,
      derivedCostUsd: 0.005,
      reconciliationStatus: LoopReconciliationStatus.Unavailable,
      reconciliationDeltaUsd: null,
      harnessNumTurns: null,
      harnessDurationMs: null,
    });

    expect(parsed.success).toBe(true);
    // Unknown stays unknown: the optional keys are absent, not zeroed.
    expect(parsed.success && Object.hasOwn(parsed.data, "harnessUsage")).toBe(
      false
    );
    expect(parsed.success && parsed.data.authoritativeCostUsd).toBeNull();
  });

  it("rejects an unrecognized session origin rather than storing it", () => {
    const parsed = LoopUsageReconciliationSchema.safeParse({
      ...FULL_RECONCILIATION,
      sessionOrigin: "guessed_from_vibes",
    });

    expect(parsed.success).toBe(false);
  });

  it("keeps a permission denial valid-or-absent: a denial without a tool name drops the aggregate, not the block", () => {
    const parsed = LoopUsageReconciliationSchema.safeParse({
      ...FULL_RECONCILIATION,
      harnessPermissionDenials: [{ toolUseId: "toolu_01" }],
    });

    expect(parsed.success).toBe(true);
    // The nameless denial is never stored...
    expect(
      parsed.success && parsed.data.harnessPermissionDenials
    ).toBeUndefined();
    // ...but the accounting that DID validate still survives.
    expect(parsed.success && parsed.data.authoritativeCostUsd).toBe(1.2345);
    expect(parsed.success && parsed.data.harnessUsage?.input).toBe(100);
  });

  it("drops a harnessUsage carrying a negative or fractional count instead of storing it", () => {
    for (const bad of [
      { ...FULL_RECONCILIATION.harnessUsage, input: -1 },
      { ...FULL_RECONCILIATION.harnessUsage, output: 12.5 },
      { ...FULL_RECONCILIATION.harnessUsage, cacheRead: Number.NaN },
      {
        ...FULL_RECONCILIATION.harnessUsage,
        cacheWrite: Number.POSITIVE_INFINITY,
      },
    ]) {
      const parsed = LoopUsageReconciliationSchema.safeParse({
        ...FULL_RECONCILIATION,
        harnessUsage: bad,
      });

      expect(parsed.success).toBe(true);
      // Corrupt counters must not become plausible authoritative accounting:
      // the aggregate is omitted, never coerced or partially kept.
      expect(parsed.success && parsed.data.harnessUsage).toBeUndefined();
      expect(parsed.success && parsed.data.reconciliationStatus).toBe(
        LoopReconciliationStatus.Matched
      );
    }
  });

  it("reads an absent webSearchRequests as zero, keeping a pre-PRD-538 desktop's usage block", () => {
    const { webSearchRequests: _omitted, ...preIss5368Usage } =
      FULL_RECONCILIATION.harnessUsage;

    const parsed = LoopUsageReconciliationSchema.safeParse({
      ...FULL_RECONCILIATION,
      harnessUsage: preIss5368Usage,
    });

    expect(parsed.success).toBe(true);
    // ISS-5368: absent means the harness never reported the counter, which for
    // this per-request line item is KNOWN-ZERO — not unknown. The four token
    // counters the old build DID send must survive; dropping the whole block
    // over one additive field is the version-skew failure this pins against.
    expect(parsed.success && parsed.data.harnessUsage).toEqual({
      ...preIss5368Usage,
      webSearchRequests: 0,
    });
  });

  it("makes an absent webSearchRequests indistinguishable from an explicit zero", () => {
    const { webSearchRequests: _omitted, ...preIss5368Usage } =
      FULL_RECONCILIATION.harnessUsage;

    const absent = LoopUsageReconciliationSchema.safeParse({
      ...FULL_RECONCILIATION,
      harnessUsage: preIss5368Usage,
    });
    const explicitZero = LoopUsageReconciliationSchema.safeParse({
      ...FULL_RECONCILIATION,
      harnessUsage: { ...preIss5368Usage, webSearchRequests: 0 },
    });

    expect(absent.success).toBe(true);
    expect(explicitZero.success).toBe(true);
    // A session that ran no web search and a build that never reported the
    // field price identically downstream, so the boundary must not distinguish
    // them. This is the whole of the ISS-5368 ruling; it is scoped to this one
    // field and widens to no other counter.
    expect(absent.success && absent.data.harnessUsage).toEqual(
      explicitZero.success && explicitZero.data.harnessUsage
    );
  });

  it("still refuses to zero-fill a genuinely unknown token counter", () => {
    for (const missing of [
      "input",
      "output",
      "cacheRead",
      "cacheWrite",
    ] as const) {
      const partial = { ...FULL_RECONCILIATION.harnessUsage };
      Reflect.deleteProperty(partial, missing);

      const parsed = LoopUsageReconciliationSchema.safeParse({
        ...FULL_RECONCILIATION,
        harnessUsage: partial,
      });

      expect(parsed.success).toBe(true);
      // The ISS-5368 default is deliberately NOT a general missing-metric rule:
      // an absent token total is UNKNOWN, so the aggregate is dropped rather
      // than reported as a session that consumed nothing.
      expect(parsed.success && parsed.data.harnessUsage).toBeUndefined();
    }
  });

  it("drops a per-model breakdown carrying a negative cost or fractional count", () => {
    for (const bad of [
      { input: 1.5, output: 50, cacheRead: 0, cacheCreation: 0, costUsd: 1 },
      { input: 1, output: 50, cacheRead: 0, cacheCreation: 0, costUsd: -1 },
      { input: 1, output: -50, cacheRead: 0, cacheCreation: 0, costUsd: null },
    ]) {
      const parsed = LoopUsageReconciliationSchema.safeParse({
        ...FULL_RECONCILIATION,
        harnessModelUsage: { "claude-opus-4-5": bad },
      });

      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data.harnessModelUsage).toBeUndefined();
    }
  });

  it("rejects the whole block when a load-bearing scalar is corrupt", () => {
    for (const bad of [
      { authoritativeCostUsd: -1 },
      { derivedCostUsd: Number.NaN },
      { harnessNumTurns: 2.5 },
      { harnessDurationMs: -1 },
      { harnessDurationApiMs: -1 },
    ]) {
      const parsed = LoopUsageReconciliationSchema.safeParse({
        ...FULL_RECONCILIATION,
        ...bad,
      });

      // Valid-or-absent: a headline figure we cannot stand behind takes the
      // whole block down rather than being persisted half-trustworthy.
      expect(parsed.success).toBe(false);
    }
  });

  it("keeps a SIGNED reconciliation delta, which is derived minus authoritative", () => {
    const parsed = LoopUsageReconciliationSchema.safeParse({
      ...FULL_RECONCILIATION,
      reconciliationDeltaUsd: -0.5,
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.reconciliationDeltaUsd).toBe(-0.5);
  });
});

describe("LoopEventCompletedSchema", () => {
  it("carries the usageReconciliation block through the completed event", () => {
    const parsed = LoopEventCompletedSchema.safeParse({
      ...BASE_COMPLETED,
      usageReconciliation: FULL_RECONCILIATION,
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.usageReconciliation).toEqual(
      FULL_RECONCILIATION
    );
  });

  it("still accepts a completed event from an older desktop build that sends none", () => {
    const parsed = LoopEventCompletedSchema.safeParse(BASE_COMPLETED);

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.usageReconciliation).toBeUndefined();
  });

  it("drops an unusable reconciliation block WITHOUT failing the completion it rides on", () => {
    const parsed = LoopEventCompletedSchema.safeParse({
      ...BASE_COMPLETED,
      usageReconciliation: {
        ...FULL_RECONCILIATION,
        authoritativeCostUsd: -1,
      },
    });

    // Losing accounting is recoverable; losing the loop's completion because a
    // peer build sent one bad counter is not.
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.usageReconciliation).toBeUndefined();
    expect(parsed.success && parsed.data.result).toEqual({ success: true });
  });

  it("strips keys the contract does not declare, so an unvalidated field cannot be persisted", () => {
    const parsed = LoopEventCompletedSchema.safeParse({
      ...BASE_COMPLETED,
      usageReconciliation: {
        ...FULL_RECONCILIATION,
        speculativeFutureField: { anything: "at all" },
      },
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.usageReconciliation).toEqual(
      FULL_RECONCILIATION
    );
  });
});
