import { describe, expect, it } from "vitest";
import type { HealthCheckResponse } from "@/lib/engineer/queries/health-check";
import { HEALTH_CHECK_DEFAULT_FRESHNESS_MS } from "../health-check-freshness";
import {
  buildPreLoopAnalyticsProperties,
  getFailingRequiredCheckIds,
  getFailingRequiredFingerprint,
  getPreLoopTargetKey,
  getRequiredFailureSummary,
  isPreLoopHealthCheckFresh,
  PreLoopAnalyticsEvent,
  PreLoopCommand,
} from "../pre-loop-health-check";

const failingHealthCheck: HealthCheckResponse = {
  checks: [
    { id: "zeta", label: "Zeta", required: true, passed: false },
    { id: "optional", label: "Optional", required: false, passed: false },
    { id: "alpha", label: "Alpha", required: true, passed: false },
    { id: "healthy", label: "Healthy", required: true, passed: true },
  ],
  allRequiredPassed: false,
};

describe("pre-loop health-check helpers", () => {
  it("builds registered compute target keys", () => {
    expect(getPreLoopTargetKey("target-123")).toBe("cloud-relay:target-123");
  });

  it("treats the one day required non-CLI cache boundary as fresh", () => {
    const now = new Date("2026-05-04T15:00:30.000Z").getTime();
    const entry = {
      data: failingHealthCheck,
      checkedAt: now - HEALTH_CHECK_DEFAULT_FRESHNESS_MS,
    };

    expect(
      isPreLoopHealthCheckFresh({
        entry,
        expectedMcpUrl: null,
        now,
      })
    ).toBe(true);
    expect(
      isPreLoopHealthCheckFresh({
        entry: {
          ...entry,
          checkedAt: now - HEALTH_CHECK_DEFAULT_FRESHNESS_MS - 1,
        },
        expectedMcpUrl: null,
        now,
      })
    ).toBe(false);
  });

  it("extracts sorted required failures and stable fingerprints", () => {
    expect(getFailingRequiredCheckIds(failingHealthCheck, null)).toEqual([
      "alpha",
      "zeta",
    ]);
    expect(getFailingRequiredFingerprint(["zeta", "alpha"])).toBe(
      JSON.stringify(["alpha", "zeta"])
    );
    expect(getRequiredFailureSummary(failingHealthCheck, null)).toMatchObject({
      checkIds: ["alpha", "zeta"],
      fingerprint: JSON.stringify(["alpha", "zeta"]),
    });
  });

  it("builds stable analytics properties for failures", () => {
    const properties = buildPreLoopAnalyticsProperties({
      attemptId: "attempt-1",
      metadata: {
        command: PreLoopCommand.ExecutePlan,
        documentId: "doc-1",
        documentType: "implementation_plan",
        ownerKey: "owner-1",
      },
      target: {
        targetKey: "cloud-relay:target-1",
        computeTargetId: "target-1",
        label: "Laptop",
        isOnline: true,
        mode: "local_compute_target",
      },
      failingChecks: getRequiredFailureSummary(failingHealthCheck, null).checks,
      failingRequiredFingerprint: JSON.stringify(["alpha", "zeta"]),
      usedCachedHealthCheck: true,
      healthCheckCacheAgeMs: 250,
    });

    expect(PreLoopAnalyticsEvent.SystemCheckBlocked).toBe(
      "pre_loop_system_check_blocked"
    );
    expect(properties).toMatchObject({
      attemptId: "attempt-1",
      loopCommand: "execute_plan",
      documentId: "doc-1",
      ownerKey: "owner-1",
      computeTargetId: "target-1",
      failingCheckIds: ["alpha", "zeta"],
      failingCheckLabels: ["Alpha", "Zeta"],
      failingRequiredCount: 2,
      failingRequiredFingerprint: JSON.stringify(["alpha", "zeta"]),
      usedCachedHealthCheck: true,
      healthCheckCacheAgeMs: 250,
    });
  });
});
