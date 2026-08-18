import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  withDb: vi.fn(),
  emitTelemetryMetric: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
}));

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitTelemetryMetric: mocks.emitTelemetryMetric,
}));

import { FilterToken } from "@repo/observability/telemetry/filter-tokens";
import { SessionIngestionDenialReason } from "./observability/session-ingestion-metrics";
import { sessionIngestionPolicyDeniedThrottle } from "./observability/session-ingestion-policy-denied-throttle";
import { isOrgSessionSyncPolicyEnabled } from "./org-session-sync-policy";

const ORG_ID = "org-1";
const WINDOW_MS = 60_000;

beforeEach(() => {
  vi.clearAllMocks();
  // ISS-4707: the production choke point shares one process-local throttle.
  // Clear it and pin time so each test starts from an empty window and the
  // time-based TTL/window is deterministic.
  sessionIngestionPolicyDeniedThrottle.clear();
  vi.useFakeTimers();
  vi.setSystemTime(0);
  mocks.withDb.mockImplementation(
    (
      fn: (db: {
        organization: { findUnique: typeof mocks.findUnique };
      }) => unknown
    ) => fn({ organization: { findUnique: mocks.findUnique } })
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe("isOrgSessionSyncPolicyEnabled", () => {
  it("returns true only for an explicitly-enabled org, scoped to that org id", async () => {
    mocks.findUnique.mockResolvedValue({ sessionSyncPolicyEnabled: true });

    await expect(isOrgSessionSyncPolicyEnabled(ORG_ID)).resolves.toBe(true);
    expect(mocks.findUnique).toHaveBeenCalledWith({
      where: { id: ORG_ID },
      select: { sessionSyncPolicyEnabled: true },
    });
  });

  it("returns false when the org's policy is explicitly off", async () => {
    mocks.findUnique.mockResolvedValue({ sessionSyncPolicyEnabled: false });

    await expect(isOrgSessionSyncPolicyEnabled(ORG_ID)).resolves.toBe(false);
  });

  it("fails closed (false) when the org cannot be resolved", async () => {
    // A deleted / unknown org id must degrade to deny, never allow — the
    // version-skew-safe default that keeps an unresolved lookup from opening an
    // egress path.
    mocks.findUnique.mockResolvedValue(null);

    await expect(isOrgSessionSyncPolicyEnabled(ORG_ID)).resolves.toBe(false);
  });

  it("emits no denial metric when the policy allows ingestion", async () => {
    mocks.findUnique.mockResolvedValue({ sessionSyncPolicyEnabled: true });

    await isOrgSessionSyncPolicyEnabled(ORG_ID);

    expect(mocks.emitTelemetryMetric).not.toHaveBeenCalled();
  });

  it("emits a policy_disabled denial metric when the org gate is off (ISS-4543)", async () => {
    // The signal that would have caught ISS-4537 in minutes: a fail-closed org
    // whose desktops keep trying to sync must be loud, not silent.
    mocks.findUnique.mockResolvedValue({ sessionSyncPolicyEnabled: false });

    await isOrgSessionSyncPolicyEnabled(ORG_ID);

    expect(mocks.emitTelemetryMetric).toHaveBeenCalledWith({
      metric: FilterToken.SessionIngestionPolicyDenied,
      orgId: ORG_ID,
      reason: SessionIngestionDenialReason.PolicyDisabled,
      count: 1,
    });
  });

  it("distinguishes an unresolvable org from a disabled policy", async () => {
    mocks.findUnique.mockResolvedValue(null);

    await isOrgSessionSyncPolicyEnabled(ORG_ID);

    expect(mocks.emitTelemetryMetric).toHaveBeenCalledWith({
      metric: FilterToken.SessionIngestionPolicyDenied,
      orgId: ORG_ID,
      reason: SessionIngestionDenialReason.OrgNotFound,
      count: 1,
    });
  });

  it("bounds emission under replay: a burst of denials for one (org, reason) emits ONCE per window (ISS-4707)", async () => {
    // The replay-amplification kill: an authenticated member of a policy-off org
    // hammering an unlimited caller must not inflate Datadog with one metric per
    // request. Within a single window the first denial emits and the rest are
    // suppressed.
    mocks.findUnique.mockResolvedValue({ sessionSyncPolicyEnabled: false });

    for (let i = 0; i < 200; i += 1) {
      vi.setSystemTime(i);
      // Every request still DENIES — the answer is never throttled.
      await expect(isOrgSessionSyncPolicyEnabled(ORG_ID)).resolves.toBe(false);
    }

    expect(mocks.emitTelemetryMetric).toHaveBeenCalledTimes(1);
    expect(mocks.emitTelemetryMetric).toHaveBeenCalledWith({
      metric: FilterToken.SessionIngestionPolicyDenied,
      orgId: ORG_ID,
      reason: SessionIngestionDenialReason.PolicyDisabled,
      count: 1,
    });
  });

  it("re-emits after the throttle window elapses (does not suppress forever)", async () => {
    mocks.findUnique.mockResolvedValue({ sessionSyncPolicyEnabled: false });

    vi.setSystemTime(0);
    await isOrgSessionSyncPolicyEnabled(ORG_ID);
    // Same window: suppressed.
    vi.setSystemTime(1);
    await isOrgSessionSyncPolicyEnabled(ORG_ID);
    expect(mocks.emitTelemetryMetric).toHaveBeenCalledTimes(1);

    // Next window: the rollover both flushes the one suppressed denial as an
    // aggregate AND emits its own count:1, so two more emits land.
    vi.setSystemTime(WINDOW_MS);
    await isOrgSessionSyncPolicyEnabled(ORG_ID);
    expect(mocks.emitTelemetryMetric).toHaveBeenCalledTimes(3);
  });

  it("flushes the suppressed count as an aggregate rollup so the denial volume is preserved (ISS-4707)", async () => {
    mocks.findUnique.mockResolvedValue({ sessionSyncPolicyEnabled: false });

    // Window 1: first emits count:1, then 3 suppressed.
    for (let i = 0; i < 4; i += 1) {
      vi.setSystemTime(i);
      await isOrgSessionSyncPolicyEnabled(ORG_ID);
    }
    expect(mocks.emitTelemetryMetric).toHaveBeenCalledTimes(1);

    // Window 2 first denial: flushes the 3 suppressed as one aggregate event
    // AND emits its own count:1. Total denial volume across the two windows is
    // 1 + 3 + 1 = 5, exactly the sum of the emitted counts.
    vi.setSystemTime(WINDOW_MS);
    await isOrgSessionSyncPolicyEnabled(ORG_ID);

    expect(mocks.emitTelemetryMetric).toHaveBeenCalledTimes(3);
    expect(mocks.emitTelemetryMetric).toHaveBeenCalledWith({
      metric: FilterToken.SessionIngestionPolicyDenied,
      orgId: ORG_ID,
      reason: SessionIngestionDenialReason.PolicyDisabled,
      count: 3,
    });

    const totalEmittedCount = mocks.emitTelemetryMetric.mock.calls.reduce(
      (sum, [payload]) => sum + (payload as { count: number }).count,
      0
    );
    expect(totalEmittedCount).toBe(5);
  });
});
