/** ISS-8735: integration coverage for the Postgres timestamp-floor pre-pass.
 * Split from service.test.ts, which is at the 1000-line Biome ceiling; both
 * share the harness under `@/__tests__/support/desktop/components/sync/`. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/desktop/components/sync/service.test-mocks"
  );
  return databaseModuleMock();
});

vi.mock("@/app/compute-targets/service", async () => {
  const { computeTargetsModuleMock } = await import(
    "@/__tests__/support/desktop/components/sync/service.test-mocks"
  );
  return computeTargetsModuleMock();
});

vi.mock("@repo/observability/log", async () => {
  const { logModuleMock } = await import(
    "@/__tests__/support/desktop/components/sync/service.test-mocks"
  );
  return logModuleMock();
});

vi.mock("@repo/observability/telemetry/metrics", async () => {
  const { telemetryModuleMock } = await import(
    "@/__tests__/support/desktop/components/sync/service.test-mocks"
  );
  return telemetryModuleMock();
});

vi.mock("@/app/agent-sessions/service/component-invocations", async () => {
  const { componentInvocationsModuleMock } = await import(
    "@/__tests__/support/desktop/components/sync/service.test-mocks"
  );
  return componentInvocationsModuleMock();
});

vi.mock("@/app/definition-registry/service", async () => {
  const { definitionRegistryModuleMock } = await import(
    "@/__tests__/support/desktop/components/sync/service.test-mocks"
  );
  return definitionRegistryModuleMock();
});

vi.mock("@/app/search/search-index-service", async (importOriginal) => {
  const { searchIndexModuleMock } = await import(
    "@/__tests__/support/desktop/components/sync/service.test-mocks"
  );
  return searchIndexModuleMock(
    await importOriginal<typeof import("@/app/search/search-index-service")>()
  );
});

import {
  buildComponent,
  buildInput,
  installOwnedTarget,
} from "@/__tests__/support/desktop/components/sync/service.test-harness";
import { mocks } from "@/__tests__/support/desktop/components/sync/service.test-mocks";
import {
  EmissionRollupCause,
  FIXED_WINDOW_EMISSION_WINDOW_MS,
} from "@/lib/observability/fixed-window-emission-throttle";
import { desktopComponentsSyncService } from "./service";
import {
  COMPONENT_TIMESTAMP_DEGRADED_EVENT,
  DEGRADED_COMPONENT_TIMESTAMP_ORG_BUDGET,
  degradedComponentTimestampOrgBudget,
  degradedComponentTimestampThrottle,
} from "./timestamp-floor-telemetry";

// Tests

const POISON = "-100000-01-01T00:00:00.000Z";
const HEALTHY_LAST_SEEN = "2026-01-10T00:00:00.000Z";
const DEGRADED_WARN =
  "Degraded desktop component timestamps below the Postgres floor";

/**
 * The fixture's `SyncedComponentInput` predates `contentFirstSeenAt` and
 * `variants`, so this widens it for the sinks those two feed.
 */
function poisoned(overrides: Record<string, unknown>) {
  return { ...buildComponent(), ...overrides } as never;
}

function createArg() {
  return mocks.upsert.mock.calls[0]?.[0]?.create;
}

function updateArg() {
  return mocks.upsert.mock.calls[0]?.[0]?.update;
}

describe("desktopComponentsSyncService.sync — Postgres timestamp floor (ISS-8735)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The emission throttle is module-level state keyed on the harness's fixed
    // (org, compute target). Without this reset the FIRST case here would spend
    // the window's budget and every later one would assert against a suppressed
    // emission — green in file order, red run alone.
    degradedComponentTimestampThrottle.clear();
    degradedComponentTimestampOrgBudget.clear();
    installOwnedTarget();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes null on the create arm for a below-floor firstSeenAt and warns once", async () => {
    await desktopComponentsSyncService.sync(
      buildInput([
        poisoned({ firstSeenAt: POISON, lastSeenAt: HEALTHY_LAST_SEEN }),
      ])
    );

    expect(createArg()?.firstSeenAt).toBeNull();
    expect(createArg()?.lastSeenAt).toEqual(new Date(HEALTHY_LAST_SEEN));
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn).toHaveBeenCalledWith(
      DEGRADED_WARN,
      expect.objectContaining({ degraded: { firstSeenAt: 1 } })
    );
  });

  it("leaves a tombstone untouched when uninstalledAt is below the floor", async () => {
    await desktopComponentsSyncService.sync(
      buildInput([poisoned({ uninstalledAt: POISON })])
    );

    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(updateArg()?.uninstalledAt).toBeUndefined();
  });

  it("makes the update arm a no-op when lastSeenAt is below the floor", async () => {
    await desktopComponentsSyncService.sync(
      buildInput([poisoned({ lastSeenAt: POISON })])
    );

    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(updateArg()?.lastSeenAt).toBeUndefined();
  });

  it("falls the version row's firstSeenAt back to lastSeenAt when contentFirstSeenAt is below the floor", async () => {
    await desktopComponentsSyncService.sync(
      buildInput([
        poisoned({
          content: "BODY",
          contentHash: "hash-primary",
          contentFirstSeenAt: POISON,
          lastSeenAt: HEALTHY_LAST_SEEN,
        }),
      ])
    );

    const versionCreate = mocks.versionUpsert.mock.calls[0]?.[0]?.create;
    expect(versionCreate?.firstSeenAt).toEqual(new Date(HEALTHY_LAST_SEEN));
  });

  it("falls a variant's observed time back to the component's lastSeenAt", async () => {
    await desktopComponentsSyncService.sync(
      buildInput([
        poisoned({
          lastSeenAt: HEALTHY_LAST_SEEN,
          variants: [
            {
              contentHash: "hash-variant",
              content: "VARIANT BODY",
              format: "md",
              lastSeenAt: POISON,
            },
          ],
        }),
      ])
    );

    const [variantRow] = mocks.versionCreateMany.mock.calls[0]?.[0]?.data ?? [];
    expect(variantRow?.lastSeenAt).toEqual(new Date(HEALTHY_LAST_SEEN));
    expect(variantRow?.firstSeenAt).toEqual(new Date(HEALTHY_LAST_SEEN));
  });

  it("falls the registry observation back to lastSeenAt when scannedAt is below the floor", async () => {
    await desktopComponentsSyncService.sync(
      buildInput([
        poisoned({
          content: "BODY",
          contentHash: "hash-primary",
          scannedAt: POISON,
          lastSeenAt: HEALTHY_LAST_SEEN,
        }),
      ])
    );

    expect(
      mocks.registerDefinitionVersion.mock.calls[0]?.[1]?.observedAt
    ).toEqual(new Date(HEALTHY_LAST_SEEN));
  });

  it("collapses every chain to null/absent rather than throwing when all four are below the floor", async () => {
    const result = await desktopComponentsSyncService.sync(
      buildInput([
        poisoned({
          content: "BODY",
          contentHash: "hash-primary",
          firstSeenAt: POISON,
          lastSeenAt: POISON,
          scannedAt: POISON,
          contentFirstSeenAt: POISON,
        }),
      ])
    );

    expect(result.ok).toBe(true);
    expect(createArg()?.firstSeenAt).toBeNull();
    expect(createArg()?.lastSeenAt).toBeNull();
    const versionCreate = mocks.versionUpsert.mock.calls[0]?.[0]?.create;
    expect(versionCreate?.firstSeenAt).toBeNull();
    expect(versionCreate?.lastSeenAt).toBeNull();
    // The registry chain has no third link, so an all-poison component records
    // no observation instant at all.
    expect(
      mocks.registerDefinitionVersion.mock.calls[0]?.[1]?.observedAt
    ).toBeUndefined();
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn).toHaveBeenCalledWith(
      DEGRADED_WARN,
      expect.objectContaining({
        degraded: {
          firstSeenAt: 1,
          lastSeenAt: 1,
          scannedAt: 1,
          contentFirstSeenAt: 1,
        },
      })
    );
  });

  it("warns exactly once for a payload carrying two poisoned components", async () => {
    await desktopComponentsSyncService.sync(
      buildInput([
        poisoned({ externalId: "skill::a", firstSeenAt: POISON }),
        poisoned({ externalId: "skill::b", firstSeenAt: POISON }),
      ])
    );

    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn).toHaveBeenCalledWith(
      DEGRADED_WARN,
      expect.objectContaining({ degraded: { firstSeenAt: 2 } })
    );
  });

  it("suppresses the warn when the same compute target replays a poisoned batch inside one window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-01T00:00:00.000Z"));

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await desktopComponentsSyncService.sync(
        buildInput([poisoned({ firstSeenAt: POISON })])
      );
      vi.setSystemTime(
        new Date(Date.now() + Math.floor(FIXED_WINDOW_EMISSION_WINDOW_MS / 10))
      );
    }

    // The replay is what an authenticated desktop can drive without limit, so
    // the bound is on the EMISSION, not on the degrade: all three requests still
    // degraded and still answered.
    expect(mocks.upsert).toHaveBeenCalledTimes(3);
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
  });

  it("rolls the suppressed replays up into one aggregate event once the window closes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-01T00:00:00.000Z"));

    await desktopComponentsSyncService.sync(
      buildInput([poisoned({ firstSeenAt: POISON })])
    );
    await desktopComponentsSyncService.sync(
      buildInput([poisoned({ firstSeenAt: POISON })])
    );
    await desktopComponentsSyncService.sync(
      buildInput([poisoned({ firstSeenAt: POISON })])
    );
    vi.setSystemTime(new Date(Date.now() + FIXED_WINDOW_EMISSION_WINDOW_MS));
    await desktopComponentsSyncService.sync(
      buildInput([poisoned({ firstSeenAt: POISON })])
    );

    // One first-occurrence event, then the rollup carrying the two the closed
    // window swallowed, then the new window's own first occurrence.
    expect(mocks.logWarn).toHaveBeenCalledTimes(3);
    expect(mocks.logWarn).toHaveBeenCalledWith(
      DEGRADED_WARN,
      expect.objectContaining({
        event: COMPONENT_TIMESTAMP_DEGRADED_EVENT,
        occurrences: 2,
        aggregated: true,
        flushedBy: EmissionRollupCause.Window,
      })
    );
  });

  it("holds the org budget when one tenant churns compute target ids", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-01T00:00:00.000Z"));

    // Every request carries a DISTINCT computeTargetId, so the per-target key is
    // never reused and each request is a first occurrence for it. Only the
    // coarse org key, which the caller cannot vary, bounds this.
    const churnedRequests = DEGRADED_COMPONENT_TIMESTAMP_ORG_BUDGET * 3;
    for (let attempt = 0; attempt < churnedRequests; attempt += 1) {
      await desktopComponentsSyncService.sync({
        ...buildInput([poisoned({ firstSeenAt: POISON })]),
        computeTargetId: `target-${attempt}`,
      });
    }

    expect(mocks.upsert).toHaveBeenCalledTimes(churnedRequests);
    expect(mocks.logWarn).toHaveBeenCalledTimes(
      DEGRADED_COMPONENT_TIMESTAMP_ORG_BUDGET
    );
  });

  it("rolls the churn the org budget refused up under the org alone, with no compute target attributed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-01T00:00:00.000Z"));

    const churnedRequests = DEGRADED_COMPONENT_TIMESTAMP_ORG_BUDGET + 2;
    for (let attempt = 0; attempt < churnedRequests; attempt += 1) {
      await desktopComponentsSyncService.sync({
        ...buildInput([poisoned({ firstSeenAt: POISON })]),
        computeTargetId: `target-${attempt}`,
      });
    }
    vi.setSystemTime(new Date(Date.now() + FIXED_WINDOW_EMISSION_WINDOW_MS));
    await desktopComponentsSyncService.sync({
      ...buildInput([poisoned({ firstSeenAt: POISON })]),
      computeTargetId: "target-after-window",
    });

    const rollup = mocks.logWarn.mock.calls.find(
      (call: unknown[]) =>
        (call[1] as { aggregated?: boolean } | undefined)?.aggregated === true
    );
    expect(rollup?.[1]).toEqual(
      expect.objectContaining({
        event: COMPONENT_TIMESTAMP_DEGRADED_EVENT,
        occurrences: 2,
        flushedBy: EmissionRollupCause.Window,
      })
    );
    // The total spans every target the org owns, so naming one would attribute
    // it to whichever happened to be last.
    expect(rollup?.[1]).not.toHaveProperty("computeTargetId");
  });
});
