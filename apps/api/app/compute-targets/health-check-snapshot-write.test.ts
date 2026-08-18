import { CheckSeverity } from "@closedloop-ai/loops-api/compute-target";
import {
  HEALTH_CHECK_SNAPSHOT_SCHEMA_VERSION,
  HealthCheckRepairAction,
  PluginUpdateOutcome,
} from "@repo/api/src/types/compute-target";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-5811: the storage schema version stamped on a persisted System Check
 * snapshot.
 *
 * The pre-loop provider now REFUSES a snapshot below the current version,
 * because rows written before this fix had `severity` stripped by the API
 * validator of the day and rehydrate as proven failures. That refusal is only
 * useful if the write actually stamps the current version — on BOTH upsert
 * branches, since the column's default is the version consumers reject, so a
 * `create` that omits it writes a snapshot that is dead on arrival.
 *
 * Lives beside `service.test.ts` rather than inside it, following
 * `find-owned-by-id-authz.test.ts`: a focused invariant of the real service
 * against a fake Prisma, in a right-sized file.
 */

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  isDesktopManagedPopEnforcementEnabled: vi.fn(),
  loadActiveDesktopManagedGatewayIds: vi.fn(),
  isAgentSessionSyncSupportedForUser: vi.fn(),
  deleteTranscriptObjects: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  ApiKeySource: {
    DESKTOP_MANAGED: "DESKTOP_MANAGED",
    USER_CREATED: "USER_CREATED",
  },
  withDb: mocks.withDb,
}));

vi.mock("@repo/aws", () => ({
  deleteTranscriptObjects: mocks.deleteTranscriptObjects,
}));

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock("@/lib/auth/desktop-managed-pop", () => ({
  isDesktopManagedPopEnforcementEnabled:
    mocks.isDesktopManagedPopEnforcementEnabled,
}));

vi.mock("@/lib/compute-target-signing-eligibility", () => ({
  CommandSigningEligibilityStatus: {
    Eligible: "eligible",
    Ineligible: "ineligible",
    Unknown: "unknown",
  },
  loadActiveDesktopManagedGatewayIds: mocks.loadActiveDesktopManagedGatewayIds,
}));

vi.mock("@/lib/agent-session-sync-feature", () => ({
  isAgentSessionSyncSupportedForUser: mocks.isAgentSessionSyncSupportedForUser,
}));

import { computeTargetsService } from "./service";
import { healthCheckSnapshotValidator } from "./validators";

const now = new Date("2026-08-10T17:00:00.000Z");

function buildTarget(overrides: Record<string, unknown> = {}) {
  return {
    id: "target-1",
    organizationId: "org-1",
    userId: "user-1",
    machineName: "machine-1",
    platform: "darwin",
    capabilities: {},
    supportedOperations: ["symphony_plan_loop"],
    lastSeenAt: now,
    isOnline: true,
    isSharedWithOrg: false,
    gatewayId: "gateway-1",
    createdAt: now,
    updatedAt: now,
    user: null,
    ...overrides,
  };
}

function installDb(db: unknown) {
  mocks.withDb.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(db)
  );
  mocks.withDb.tx.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(db)
  );
}

describe("upsertHealthCheckSnapshot schema version (ISS-5811)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isDesktopManagedPopEnforcementEnabled.mockResolvedValue(false);
    mocks.loadActiveDesktopManagedGatewayIds.mockResolvedValue(new Set());
    mocks.isAgentSessionSyncSupportedForUser.mockResolvedValue(false);
  });

  it("stamps the current schema version on both upsert branches", async () => {
    const upsert = vi.fn().mockResolvedValue({
      id: "snapshot-1",
      organizationId: "org-1",
      computeTargetId: "target-1",
      checkedAt: now,
      expectedMcpUrl: null,
      latestVersion: null,
      pluginAutoUpdateEnabled: false,
      result: { checks: [], allRequiredPassed: true },
      allRequiredPassed: true,
      requiredFailureIds: [],
      schemaVersion: HEALTH_CHECK_SNAPSHOT_SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now,
    });
    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue(buildTarget()),
        update: vi.fn(),
      },
      computeTargetHealthCheck: { upsert },
    });

    const snapshot = await computeTargetsService.upsertHealthCheckSnapshot(
      "org-1",
      "user-1",
      "target-1",
      {
        result: {
          checks: [{ id: "git", label: "Git", required: true, passed: true }],
          allRequiredPassed: true,
        },
      }
    );

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          schemaVersion: HEALTH_CHECK_SNAPSHOT_SCHEMA_VERSION,
        }),
        update: expect.objectContaining({
          schemaVersion: HEALTH_CHECK_SNAPSHOT_SCHEMA_VERSION,
        }),
      })
    );
    expect(snapshot?.schemaVersion).toBe(HEALTH_CHECK_SNAPSHOT_SCHEMA_VERSION);
  });
});

/**
 * ISS-5868 acceptance criterion 4 — persist→read round trip, asserted against
 * the value that actually reaches STORAGE.
 *
 * The in-process object never goes through `healthCheckSnapshotValidator`,
 * which is precisely why ISS-5811 stayed invisible: the producer's own tests
 * saw `severity` on the object it built while the stored snapshot had it
 * stripped on all 13 rows. So this drives the real wire payload through the
 * real boundary schema and then asserts on `upsert`'s `create.result` — the
 * JSON column write — not on the argument it was handed.
 */
describe("health-check snapshot persist round trip (ISS-5868)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isDesktopManagedPopEnforcementEnabled.mockResolvedValue(false);
    mocks.loadActiveDesktopManagedGatewayIds.mockResolvedValue(new Set());
    mocks.isAgentSessionSyncSupportedForUser.mockResolvedValue(false);
  });

  /** Exactly what a gateway PUTs, before any validation. */
  const wirePayload = {
    result: {
      checks: [
        {
          id: "plugin-code",
          label: "Symphony Plugin",
          required: true,
          passed: false,
          error: "Could not verify enabled state",
          severity: CheckSeverity.Blocked,
          blockedBy: "claude-cli",
          enableAttempted: true,
          enableOutcome: PluginUpdateOutcome.Failed,
          repair: {
            repairable: true,
            action: HealthCheckRepairAction.EnablePlugins,
          },
        },
        {
          id: "plugin-judges",
          label: "Judges Plugin",
          required: true,
          passed: false,
          // A skewed gateway sending an unusable value on ONE field must not
          // take the row — or its siblings — down with it.
          enableOutcome: null,
          severity: CheckSeverity.Unknown,
        },
        { id: "git", label: "Git", required: true, passed: true },
      ],
      allRequiredPassed: false,
    },
  };

  function installUpsertSpy(): ReturnType<typeof vi.fn> {
    const upsert = vi
      .fn()
      .mockImplementation((args: { create: Record<string, unknown> }) =>
        Promise.resolve({
          id: "snapshot-1",
          organizationId: "org-1",
          computeTargetId: "target-1",
          checkedAt: now,
          expectedMcpUrl: null,
          latestVersion: null,
          pluginAutoUpdateEnabled: false,
          requiredFailureIds: args.create.requiredFailureIds,
          allRequiredPassed: args.create.allRequiredPassed,
          schemaVersion: HEALTH_CHECK_SNAPSHOT_SCHEMA_VERSION,
          createdAt: now,
          updatedAt: now,
          // Round-trip through JSON, as the Prisma JSON column does.
          result: JSON.parse(JSON.stringify(args.create.result)),
        })
      );
    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue(buildTarget()),
        update: vi.fn(),
      },
      computeTargetHealthCheck: { upsert },
    });
    return upsert;
  }

  it("stores severity, blockedBy, repair and outcome, and reads them back", async () => {
    const parsed = healthCheckSnapshotValidator.safeParse(wirePayload);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    const upsert = installUpsertSpy();

    const snapshot = await computeTargetsService.upsertHealthCheckSnapshot(
      "org-1",
      "user-1",
      "target-1",
      parsed.data
    );

    const stored = (
      upsert.mock.calls[0][0] as {
        create: { result: { checks: Record<string, unknown>[] } };
      }
    ).create.result;
    const storedPluginRow = stored.checks[0];
    expect(storedPluginRow.severity).toBe(CheckSeverity.Blocked);
    expect(storedPluginRow.blockedBy).toBe("claude-cli");
    expect(storedPluginRow.enableOutcome).toBe(PluginUpdateOutcome.Failed);
    expect(storedPluginRow.repair).toEqual({
      repairable: true,
      action: HealthCheckRepairAction.EnablePlugins,
    });

    // And the same values survive the read back out of the column.
    const readBack = snapshot?.result.checks[0];
    expect(readBack?.severity).toBe(CheckSeverity.Blocked);
    expect(readBack?.blockedBy).toBe("claude-cli");
    expect(readBack?.repair?.action).toBe(
      HealthCheckRepairAction.EnablePlugins
    );
  });

  it("degrades one unusable field without dropping the payload", async () => {
    const parsed = healthCheckSnapshotValidator.safeParse(wirePayload);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    const upsert = installUpsertSpy();

    await computeTargetsService.upsertHealthCheckSnapshot(
      "org-1",
      "user-1",
      "target-1",
      parsed.data
    );

    const stored = (
      upsert.mock.calls[0][0] as {
        create: { result: { checks: Record<string, unknown>[] } };
      }
    ).create.result;
    expect(stored.checks).toHaveLength(3);
    expect(stored.checks[2].id).toBe("git");
    // The unusable field degrades to `undefined`, never to an explicit `null`
    // — and `undefined` is what the JSON column write DROPS, so the stored row
    // omits the key entirely rather than carrying a null an older desktop
    // reader would have to defend against.
    expect(stored.checks[1].enableOutcome).toBeUndefined();
    const columnJson = JSON.parse(JSON.stringify(stored)) as {
      checks: Record<string, unknown>[];
    };
    expect(Object.hasOwn(columnJson.checks[1], "enableOutcome")).toBe(false);
    expect(stored.checks[1].severity).toBe(CheckSeverity.Unknown);
  });
});

/**
 * ISS-5868 — the stored row must not contradict itself.
 *
 * The gateway mints `result.allRequiredPassed` through `isFailingRequiredCheck`,
 * so the sibling boolean COLUMN has to be derived the same way. Deriving it from
 * the raw `required && !passed` id list instead would make one stored snapshot
 * say `false` in the column beside `true` in its own `result` JSON on exactly
 * the machine state ISS-5811 describes.
 */
describe("persisted allRequiredPassed agrees with the gateway (ISS-5868)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isDesktopManagedPopEnforcementEnabled.mockResolvedValue(false);
    mocks.loadActiveDesktopManagedGatewayIds.mockResolvedValue(new Set());
    mocks.isAgentSessionSyncSupportedForUser.mockResolvedValue(false);
  });

  /** Required, not passed, and NOT determinable — never a proven failure. */
  const undeterminableRequiredRow = {
    id: "plugin-code",
    label: "Symphony Plugin",
    required: true,
    passed: false,
    error: "Could not verify enabled state",
    severity: CheckSeverity.Unknown,
  };

  function installUpsert(): ReturnType<typeof vi.fn> {
    const upsert = vi.fn().mockResolvedValue({
      id: "snapshot-1",
      organizationId: "org-1",
      computeTargetId: "target-1",
      checkedAt: now,
      expectedMcpUrl: null,
      latestVersion: null,
      pluginAutoUpdateEnabled: false,
      result: { checks: [], allRequiredPassed: true },
      allRequiredPassed: true,
      requiredFailureIds: [],
      schemaVersion: HEALTH_CHECK_SNAPSHOT_SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now,
    });
    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue(buildTarget()),
        update: vi.fn(),
      },
      computeTargetHealthCheck: { upsert },
    });
    return upsert;
  }

  it("stores true for an undeterminable required row, and still records its id", async () => {
    const upsert = installUpsert();

    await computeTargetsService.upsertHealthCheckSnapshot(
      "org-1",
      "user-1",
      "target-1",
      {
        result: {
          checks: [undeterminableRequiredRow],
          allRequiredPassed: true,
        },
      }
    );

    const create = storedCreate(upsert);
    expect(create.allRequiredPassed).toBe(true);
    // requiredFailureIds stays the RAW set on purpose — it records what the
    // gateway reported, not what blocks.
    expect(create.requiredFailureIds).toEqual(["plugin-code"]);
  });

  it("still stores false for a PROVEN required failure", async () => {
    const upsert = installUpsert();

    await computeTargetsService.upsertHealthCheckSnapshot(
      "org-1",
      "user-1",
      "target-1",
      {
        result: {
          checks: [{ id: "git", label: "Git", required: true, passed: false }],
          allRequiredPassed: false,
        },
      }
    );

    const create = storedCreate(upsert);
    expect(create.allRequiredPassed).toBe(false);
    expect(create.requiredFailureIds).toEqual(["git"]);
  });
});

/**
 * ISS-5868 — version skew between the Desktop gateway and this API.
 *
 * A Desktop older than ISS-5369 computes `result.allRequiredPassed` as bare
 * `required && !passed`, because it has no `severity` to consult, so it reports
 * `false` on a row a severity-aware build reads as merely undeterminable. The
 * boolean COLUMN is derived here through `isFailingRequiredCheck` and reads
 * `true` for that same row — and this build then stamps the current
 * `schemaVersion`, which is precisely the assertion that the row was written by
 * a build that understands severity.
 *
 * Persisting the client's `result` verbatim therefore stores a row that
 * contradicts itself under a stamp saying it does not. Both upsert branches must
 * write the SAME normalised result, or a `create` and an `update` of the same
 * skewed payload disagree with each other as well.
 */
describe("stored result agrees with the stored column under version skew (ISS-5868)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isDesktopManagedPopEnforcementEnabled.mockResolvedValue(false);
    mocks.loadActiveDesktopManagedGatewayIds.mockResolvedValue(new Set());
    mocks.isAgentSessionSyncSupportedForUser.mockResolvedValue(false);
  });

  /**
   * What a pre-ISS-5369 Desktop puts on the wire: an undeterminable required row
   * carrying `severity: "unknown"` from a newer gateway build, alongside the
   * `allRequiredPassed: false` an older one derived without reading it.
   */
  const skewedBody = {
    result: {
      checks: [
        {
          id: "plugin-code",
          label: "Symphony Plugin",
          required: true,
          passed: false,
          error: "Could not verify enabled state",
          severity: CheckSeverity.Unknown,
        },
        { id: "git", label: "Git", required: true, passed: true },
      ],
      allRequiredPassed: false,
    },
  };

  it("normalises result.allRequiredPassed to the derived value on BOTH branches", async () => {
    const upsert = vi.fn().mockResolvedValue({
      id: "snapshot-1",
      organizationId: "org-1",
      computeTargetId: "target-1",
      checkedAt: now,
      expectedMcpUrl: null,
      latestVersion: null,
      pluginAutoUpdateEnabled: false,
      result: { checks: [], allRequiredPassed: true },
      allRequiredPassed: true,
      requiredFailureIds: [],
      schemaVersion: HEALTH_CHECK_SNAPSHOT_SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now,
    });
    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue(buildTarget()),
        update: vi.fn(),
      },
      computeTargetHealthCheck: { upsert },
    });

    // Through the REAL boundary schema, so this is the value the route would
    // hand the service — not a hand-built in-process object.
    const parsed = healthCheckSnapshotValidator.safeParse(skewedBody);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    expect(parsed.data.result.allRequiredPassed).toBe(false);

    await computeTargetsService.upsertHealthCheckSnapshot(
      "org-1",
      "user-1",
      "target-1",
      parsed.data
    );

    const create = storedCreate(upsert);
    const update = storedUpdate(upsert);
    expect(create.allRequiredPassed).toBe(true);
    expect(create.result.allRequiredPassed).toBe(true);
    expect(update.allRequiredPassed).toBe(true);
    expect(update.result.allRequiredPassed).toBe(true);
    // The stamp asserts a severity-aware writer, so it may only ride a row whose
    // two copies of the value agree.
    expect(create.result.allRequiredPassed).toBe(create.allRequiredPassed);
    expect(update.result.allRequiredPassed).toBe(update.allRequiredPassed);
  });

  it("leaves every other result field the client sent untouched", async () => {
    const upsert = vi.fn().mockResolvedValue({
      id: "snapshot-1",
      organizationId: "org-1",
      computeTargetId: "target-1",
      checkedAt: now,
      expectedMcpUrl: null,
      latestVersion: null,
      pluginAutoUpdateEnabled: false,
      result: { checks: [], allRequiredPassed: true },
      allRequiredPassed: true,
      requiredFailureIds: [],
      schemaVersion: HEALTH_CHECK_SNAPSHOT_SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now,
    });
    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue(buildTarget()),
        update: vi.fn(),
      },
      computeTargetHealthCheck: { upsert },
    });

    const parsed = healthCheckSnapshotValidator.safeParse(skewedBody);
    if (!parsed.success) {
      throw new Error("fixture must parse");
    }

    await computeTargetsService.upsertHealthCheckSnapshot(
      "org-1",
      "user-1",
      "target-1",
      parsed.data
    );

    const stored = upsert.mock.calls[0][0].create.result;
    expect(stored).toEqual({
      ...parsed.data.result,
      allRequiredPassed: true,
    });
  });
});

/** The `create` half of the single `upsert` call — the row a first write stores. */
function storedCreate(upsert: ReturnType<typeof vi.fn>): {
  allRequiredPassed: boolean;
  requiredFailureIds: string[];
  result: { allRequiredPassed: boolean };
} {
  return upsert.mock.calls[0][0].create;
}

/** The `update` half — the row a refresh of an existing snapshot stores. */
function storedUpdate(upsert: ReturnType<typeof vi.fn>): {
  allRequiredPassed: boolean;
  result: { allRequiredPassed: boolean };
} {
  return upsert.mock.calls[0][0].update;
}
