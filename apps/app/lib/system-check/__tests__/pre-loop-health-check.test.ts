import { EngineerRoutingMode } from "@repo/api/src/types/relay";
import { CheckSeverity } from "@closedloop-ai/loops-api/compute-target";
import { describe, expect, it } from "vitest";
import type { HealthCheckResponse } from "@/lib/engineer/queries/health-check";
import { healthCheckOptions } from "@/lib/engineer/queries/health-check";
import {
  classifyHealthCheckFailure,
  describeHealthCheckFailure,
  HealthCheckFailureKind,
  HealthCheckHttpError,
  HealthCheckTimeoutError,
  isUnreachableHealthCheckFailure,
} from "../health-check-failure";
import { HEALTH_CHECK_DEFAULT_FRESHNESS_MS } from "../health-check-freshness";
import {
  getPreLoopHealthCheckMaxAttempts,
  getPreLoopHealthCheckOverallTimeoutMs,
  getPreLoopHealthCheckTimeoutMs,
  PRE_LOOP_HEALTH_CHECK_TIMEOUT_MS,
  PRE_LOOP_PLUGIN_UPDATE_HEALTH_CHECK_TIMEOUT_MS,
  PRE_LOOP_RELAY_HEALTH_CHECK_MAX_ATTEMPTS,
  PRE_LOOP_RELAY_HEALTH_CHECK_TIMEOUT_MS,
} from "../health-check-timeouts";
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

/**
 * The 2026-08-10 snapshot shape, trimmed to the rows that matter: every CLI
 * green, and the Closedloop plugin rows installed-but-undeterminable. The
 * gateway reports `allRequiredPassed: false` for these, which is why the gate
 * reads the rows rather than that flag.
 */
const undeterminablePluginHealthCheck: HealthCheckResponse = {
  checks: [
    {
      id: "git",
      label: "Git",
      required: true,
      passed: true,
      version: "2.39.5",
    },
    {
      id: "claude-cli",
      label: "Claude CLI",
      required: true,
      passed: true,
      version: "2.1.220",
    },
    {
      id: "plugin-code",
      label: "Symphony Plugin",
      required: true,
      passed: false,
      severity: CheckSeverity.Unknown,
      version: "1.14.7",
      error: "Could not verify enabled state",
      repair: { repairable: false },
    },
    {
      id: "plugin-judges",
      label: "Judges Plugin",
      required: true,
      passed: false,
      severity: CheckSeverity.Blocked,
      blockedBy: "claude-cli",
      version: "1.7.1",
      error: "Not checked, Claude CLI unavailable",
      repair: { repairable: false },
    },
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

  /**
   * ISS-5811, at the gate's own input boundary rather than the badge's.
   * `pre-loop-system-check-provider` executes the command only when
   * `getRequiredFailureSummary(...).checkIds.length === 0`, so this list IS the
   * launch decision. `undeterminablePluginHealthCheck` is the shape the
   * reported machine actually produced (four green CLIs, five plugin rows the
   * gateway could not determine); before the fix it yielded five ids and the
   * command was never issued to the API at all.
   */
  it("does not block the launch on undeterminable required plugin rows", () => {
    expect(
      getFailingRequiredCheckIds(undeterminablePluginHealthCheck, null)
    ).toEqual([]);
    expect(
      getRequiredFailureSummary(undeterminablePluginHealthCheck, null)
    ).toMatchObject({ checkIds: [], fingerprint: JSON.stringify([]) });
  });

  it("still blocks the launch on a plugin row proven disabled", () => {
    const proven: HealthCheckResponse = {
      ...undeterminablePluginHealthCheck,
      checks: [
        ...undeterminablePluginHealthCheck.checks,
        {
          id: "plugin-platform",
          label: "Platform Plugin",
          required: true,
          passed: false,
          severity: CheckSeverity.Error,
          error: "Disabled",
        },
      ],
    };

    expect(getFailingRequiredCheckIds(proven, null)).toEqual([
      "plugin-platform",
    ]);
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
        isOwnedByCurrentUser: true,
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

  it("selects the longer timeout only for plugin auto-update mode", () => {
    expect(
      getPreLoopHealthCheckTimeoutMs({ pluginAutoUpdateEnabled: false })
    ).toBe(PRE_LOOP_HEALTH_CHECK_TIMEOUT_MS);
    expect(getPreLoopHealthCheckTimeoutMs()).toBe(
      PRE_LOOP_HEALTH_CHECK_TIMEOUT_MS
    );
    expect(
      getPreLoopHealthCheckTimeoutMs({ pluginAutoUpdateEnabled: true })
    ).toBe(PRE_LOOP_PLUGIN_UPDATE_HEALTH_CHECK_TIMEOUT_MS);
  });

  // ISS-5169: the request forks on relayTargetId but the budget did not, so a
  // relay round trip was held to a localhost number.
  it("gives a relay-targeted check a larger budget than a loopback one", () => {
    expect(getPreLoopHealthCheckTimeoutMs({ relayTarget: true })).toBe(
      PRE_LOOP_RELAY_HEALTH_CHECK_TIMEOUT_MS
    );
    expect(PRE_LOOP_RELAY_HEALTH_CHECK_TIMEOUT_MS).toBeGreaterThan(
      PRE_LOOP_HEALTH_CHECK_TIMEOUT_MS
    );
  });

  it("retries a relay check but never a loopback or auto-update one", () => {
    expect(getPreLoopHealthCheckMaxAttempts({ relayTarget: true })).toBe(
      PRE_LOOP_RELAY_HEALTH_CHECK_MAX_ATTEMPTS
    );
    expect(getPreLoopHealthCheckMaxAttempts({ relayTarget: false })).toBe(1);
    // Auto-update remediation mutates the target; replaying it is not safe.
    expect(
      getPreLoopHealthCheckMaxAttempts({
        relayTarget: true,
        pluginAutoUpdateEnabled: true,
      })
    ).toBe(1);
  });

  // The two timeouts (queryFn AbortSignal + provider withTimeout wrapper) used
  // to be the same number, so whichever fired first produced identical opaque
  // text. The backstop must be strictly larger so the specific reason wins.
  it("keeps the overall backstop strictly above one relay attempt", () => {
    const scope = { relayTarget: true };
    expect(getPreLoopHealthCheckOverallTimeoutMs(scope)).toBeGreaterThan(
      getPreLoopHealthCheckTimeoutMs(scope)
    );
    expect(getPreLoopHealthCheckOverallTimeoutMs(scope)).toBeGreaterThanOrEqual(
      getPreLoopHealthCheckTimeoutMs(scope) *
        getPreLoopHealthCheckMaxAttempts(scope)
    );
  });
});

describe("health-check failure classification (ISS-5169)", () => {
  it("distinguishes a relay timeout from a loopback timeout", () => {
    const abort = new DOMException("aborted", "TimeoutError");
    expect(classifyHealthCheckFailure(abort, { relayTarget: true })).toBe(
      HealthCheckFailureKind.RelayTimeout
    );
    expect(classifyHealthCheckFailure(abort, { relayTarget: false })).toBe(
      HealthCheckFailureKind.LocalTimeout
    );
  });

  it("classifies a bare fetch TypeError as unreachable", () => {
    expect(classifyHealthCheckFailure(new TypeError("Failed to fetch"))).toBe(
      HealthCheckFailureKind.Unreachable
    );
  });

  it("treats an answered-but-failing responder as a real verdict, not unreachable", () => {
    const kind = classifyHealthCheckFailure(
      new Error("Gateway health check failed with HTTP 500"),
      { relayTarget: true }
    );
    expect(kind).toBe(HealthCheckFailureKind.Unknown);
    expect(isUnreachableHealthCheckFailure(kind)).toBe(false);
  });

  it("self-reports the kind carried by HealthCheckTimeoutError", () => {
    const error = new HealthCheckTimeoutError(
      HealthCheckFailureKind.OverallTimeout,
      42_000
    );
    expect(classifyHealthCheckFailure(error)).toBe(
      HealthCheckFailureKind.OverallTimeout
    );
    expect(isUnreachableHealthCheckFailure(error.kind)).toBe(true);
  });

  it("names the target once and reports unreachability in relay-timeout copy", () => {
    const relay = describeHealthCheckFailure(
      HealthCheckFailureKind.RelayTimeout,
      "sassadmins-MacBook-Pro.local"
    );
    // The title carries the target; the description says we could not get to
    // it, without re-naming the target or explaining our transport wiring.
    expect(relay.title).toContain("sassadmins-MacBook-Pro.local");
    expect(relay.description).toContain("Couldn't reach it");
    expect(relay.description).not.toContain("sassadmins-MacBook-Pro.local");

    // Unknown is also what a failed release lookup or a throw during target
    // resolution produces, so its copy must not blame the machine or claim we
    // failed to reach it.
    const unhealthy = describeHealthCheckFailure(
      HealthCheckFailureKind.Unknown,
      "sassadmins-MacBook-Pro.local"
    );
    expect(unhealthy.description).not.toContain("Couldn't reach");
    expect(unhealthy.title).not.toContain("sassadmins-MacBook-Pro.local");
    expect(unhealthy.title).not.toBe(relay.title);
  });
});

describe("relay reachability verdicts (ISS-5169/5171)", () => {
  it("treats the relay's own 503 as the target being offline, not an unknown failure", () => {
    // `/api/gateway-relay` answers 503 when the heartbeat says the target is
    // gone. That is our own infrastructure reporting reachability, so it must
    // reach the retry and the Cloud fallback rather than collapsing to Unknown.
    const kind = classifyHealthCheckFailure(
      new HealthCheckHttpError("Compute target offline", 503),
      { relayTarget: true }
    );

    expect(kind).toBe(HealthCheckFailureKind.TargetOffline);
    expect(isUnreachableHealthCheckFailure(kind)).toBe(true);
  });

  it("keeps a non-503 HTTP answer a real verdict from the responder", () => {
    // A 500 means something answered and failed the check; replaying it would
    // return the same thing, so it must not become an unreachable retry.
    const kind = classifyHealthCheckFailure(
      new HealthCheckHttpError(
        "Gateway health check failed with HTTP 500",
        500
      ),
      { relayTarget: true }
    );

    expect(kind).toBe(HealthCheckFailureKind.Unknown);
    expect(isUnreachableHealthCheckFailure(kind)).toBe(false);
  });

  it("gives a CloudRelay routing selection the relay retry budget without a relayTargetId", () => {
    // Document and Branch chat pass only the routing-derived scope, and the
    // fetch interceptor rewrites the gateway path to the relay. Budgeting those
    // as loopback is the mis-budgeting ISS-5169 is about.
    const relayRetry = healthCheckOptions({
      mode: EngineerRoutingMode.CloudRelay,
      computeTargetId: "target-1",
    }).retry;
    const localRetry = healthCheckOptions({
      mode: EngineerRoutingMode.LocalElectron,
      computeTargetId: null,
    }).retry;
    const timeout = new HealthCheckTimeoutError(
      HealthCheckFailureKind.RelayTimeout,
      20_000
    );

    // The loopback budget is a single attempt, so the same unreachable failure
    // retries on the relay scope and does not on the loopback one.
    expect(typeof relayRetry).toBe("function");
    expect(typeof localRetry).toBe("function");
    expect(typeof relayRetry === "function" && relayRetry(0, timeout)).toBe(
      true
    );
    expect(typeof localRetry === "function" && localRetry(0, timeout)).toBe(
      false
    );
  });
});
