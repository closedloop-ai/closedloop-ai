import { SyncLane } from "@closedloop-ai/telemetry-contract/sync";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
  AgentComponentInvocationSyncAckState,
} from "@repo/api/src/types/agent-component-invocation";
import { DesktopAgentComponentInvocationSyncRestErrorCode } from "@repo/api/src/types/desktop-write-lane";
import { Result } from "@repo/api/src/types/result";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ISS-11426: every classification of `compute_target.ownership_refused`,
// driven through the two lanes' real ownership front doors
// (`desktopAgentComponentInvocationsSyncService.sync` and
// `authorizeTranscriptRequest`) and the real `findOwnedById`, against a DB fake
// holding two orgs and two users. The fake honours only the `where` keys the
// service actually sends, as Prisma does.

const mocks = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  readFails: false,
  findUnique: vi.fn(),
  ingestPart: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
  const original = await importOriginal<typeof import("@repo/database")>();
  const matches = (
    row: Record<string, unknown>,
    where: Record<string, unknown>
  ) => Object.entries(where).every(([key, value]) => row[key] === value);
  const db = {
    computeTarget: {
      findFirst: ({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(mocks.rows.find((row) => matches(row, where)) ?? null),
      findUnique: (args: { where: Record<string, unknown> }) => {
        mocks.findUnique(args);
        if (mocks.readFails) {
          return Promise.reject(new Error("read failed"));
        }
        return Promise.resolve(
          mocks.rows.find((row) => matches(row, args.where)) ?? null
        );
      },
    },
  };
  return {
    ...original,
    withDb: <T>(fn: (client: typeof db) => T) => fn(db),
  };
});

vi.mock("@/lib/auth/desktop-managed-pop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/desktop-managed-pop")>()),
  isDesktopManagedPopEnforcementEnabled: async () => false,
}));

vi.mock("@/app/agent-sessions/service/component-invocations", () => ({
  agentComponentInvocationsService: { ingestPart: mocks.ingestPart },
}));

vi.mock("@repo/observability/log", () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { log } from "@repo/observability/log";
import { desktopAgentComponentInvocationsSyncService } from "@/app/desktop/agent-sessions/invocations/sync/service";
import { TranscriptRateLimiter } from "@/app/desktop/transcripts/transcript-rate-limit";
import { authorizeTranscriptRequest } from "@/app/desktop/transcripts/transcript-request-context";
import {
  COMPUTE_TARGET_OWNERSHIP_REFUSED_EVENT,
  ComputeTargetOwnershipRefusalClassification,
  resetOwnershipRefusalEmissionWindowsForTest,
} from "./ownership-refusal-telemetry";

const ORG_A = "00000000-0000-4000-8000-00000000000a";
const ORG_B = "00000000-0000-4000-8000-00000000000b";
const USER_1 = "00000000-0000-4000-8000-000000000001";
const USER_2 = "00000000-0000-4000-8000-000000000002";
const TARGET_USER_1_ORG_A = "00000000-0000-4000-8000-0000000000a1";
const TARGET_USER_2_ORG_B = "00000000-0000-4000-8000-0000000000b2";
const TARGET_USER_1_ORG_B = "00000000-0000-4000-8000-0000000000b1";
const TARGET_MISSING = "00000000-0000-4000-8000-0000000000ff";
/** Distinct targets per pass: well past any sensible per-org budget. */
const ORG_BUDGET_PROBE = 50;

function row(id: string, organizationId: string, userId: string) {
  return {
    id,
    organizationId,
    userId,
    gatewayId: null,
    machineName: `machine-${id}`,
    platform: "darwin",
    capabilities: {},
    supportedOperations: [],
    isOnline: true,
    lastSeenAt: new Date("2026-10-05T12:00:00.000Z"),
    createdAt: new Date("2026-10-01T12:00:00.000Z"),
    updatedAt: new Date("2026-10-05T12:00:00.000Z"),
    isSharedWithOrg: false,
    selectedHarness: null,
    user: null,
  };
}

function refusalLogs(): Record<string, unknown>[] {
  return vi
    .mocked(log.warn)
    .mock.calls.filter(
      ([event]) => event === COMPUTE_TARGET_OWNERSHIP_REFUSED_EVENT
    )
    .map(([, fields]) => (fields ?? {}) as Record<string, unknown>);
}

function syncInvocation(
  computeTargetId: string,
  caller: { organizationId: string; userId: string }
) {
  return desktopAgentComponentInvocationsSyncService.sync({
    authMethod: "desktop_session",
    clerkUserId: null,
    computeTargetId,
    organizationId: caller.organizationId,
    userId: caller.userId,
    part: {
      protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
      externalSessionId: "session-1",
      externalGenerationId: "a".repeat(64),
      sourceUpdatedAt: "2026-10-05T12:00:00.000Z",
      dataRevision: 35,
      sourceSequence: 1,
      partIndex: 0,
      partCount: 1,
      partHash: "b".repeat(64),
      items: [],
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetOwnershipRefusalEmissionWindowsForTest();
  mocks.readFails = false;
  mocks.rows = [
    row(TARGET_USER_1_ORG_A, ORG_A, USER_1),
    row(TARGET_USER_2_ORG_B, ORG_B, USER_2),
    row(TARGET_USER_1_ORG_B, ORG_B, USER_1),
  ];
  mocks.ingestPart.mockResolvedValue(
    Result.ok({ state: AgentComponentInvocationSyncAckState.Activated })
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe("compute_target.ownership_refused on the invocation lane", () => {
  it("classifies the same user's target in ANOTHER org as target_org_mismatch (path 1/2)", async () => {
    const result = await syncInvocation(TARGET_USER_1_ORG_A, {
      organizationId: ORG_B,
      userId: USER_1,
    });

    expect(result).toEqual(
      Result.err(
        DesktopAgentComponentInvocationSyncRestErrorCode.TargetNotOwned
      )
    );
    expect(refusalLogs()).toEqual([
      {
        suppressedCount: 0,
        orgSuppressedCount: 0,
        lane: SyncLane.InvocationParts,
        computeTargetId: TARGET_USER_1_ORG_A,
        organizationId: ORG_B,
        userId: USER_1,
        authMethod: "desktop_session",
        targetOrganizationId: ORG_A,
        targetUserId: USER_1,
        classification:
          ComputeTargetOwnershipRefusalClassification.TargetOrgMismatch,
      },
    ]);
  });

  it("classifies ANOTHER user's target as target_user_mismatch", async () => {
    await syncInvocation(TARGET_USER_2_ORG_B, {
      organizationId: ORG_B,
      userId: USER_1,
    });

    expect(refusalLogs()).toEqual([
      expect.objectContaining({
        targetOrganizationId: ORG_B,
        targetUserId: USER_2,
        classification:
          ComputeTargetOwnershipRefusalClassification.TargetUserMismatch,
      }),
    ]);
  });

  it("classifies a target with no row as target_missing", async () => {
    await syncInvocation(TARGET_MISSING, {
      organizationId: ORG_B,
      userId: USER_1,
    });

    expect(refusalLogs()).toEqual([
      expect.objectContaining({
        targetOrganizationId: null,
        targetUserId: null,
        classification:
          ComputeTargetOwnershipRefusalClassification.TargetMissing,
      }),
    ]);
  });

  it("reports unknown, and still refuses, when the point read fails", async () => {
    mocks.readFails = true;

    const result = await syncInvocation(TARGET_USER_1_ORG_A, {
      organizationId: ORG_B,
      userId: USER_1,
    });

    expect(result).toEqual(
      Result.err(
        DesktopAgentComponentInvocationSyncRestErrorCode.TargetNotOwned
      )
    );
    expect(refusalLogs()).toEqual([
      expect.objectContaining({
        classification: ComputeTargetOwnershipRefusalClassification.Unknown,
      }),
    ]);
  });

  it("reads the target by id ALONE, so another tenant's row is visible to the classifier", async () => {
    await syncInvocation(TARGET_USER_1_ORG_A, {
      organizationId: ORG_B,
      userId: USER_1,
    });

    expect(mocks.findUnique).toHaveBeenCalledWith({
      where: { id: TARGET_USER_1_ORG_A },
      select: { organizationId: true, userId: true },
    });
  });

  it("emits nothing and reads nothing for an owned target", async () => {
    const result = await syncInvocation(TARGET_USER_1_ORG_B, {
      organizationId: ORG_B,
      userId: USER_1,
    });

    expect(result.ok).toBe(true);
    expect(refusalLogs()).toEqual([]);
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("bounds emission per (org, target) per window and counts what it suppressed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T12:00:00.000Z"));
    const caller = { organizationId: ORG_B, userId: USER_1 };

    await syncInvocation(TARGET_USER_1_ORG_A, caller);
    await syncInvocation(TARGET_USER_1_ORG_A, caller);
    await syncInvocation(TARGET_USER_1_ORG_A, caller);
    // A different target is its own key and is not suppressed by the first.
    await syncInvocation(TARGET_MISSING, caller);

    expect(refusalLogs().map((fields) => fields.computeTargetId)).toEqual([
      TARGET_USER_1_ORG_A,
      TARGET_MISSING,
    ]);
    expect(mocks.findUnique).toHaveBeenCalledTimes(2);

    vi.setSystemTime(new Date("2026-10-05T12:01:00.000Z"));
    await syncInvocation(TARGET_USER_1_ORG_A, caller);

    expect(refusalLogs().at(-1)).toEqual(
      expect.objectContaining({
        computeTargetId: TARGET_USER_1_ORG_A,
        suppressedCount: 2,
      })
    );
  });
});

describe("compute_target.ownership_refused emission bounds", () => {
  it("keys the window by lane and credential, so neither breakdown loses a race", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T12:00:00.000Z"));
    const caller = { organizationId: ORG_B, userId: USER_1 };

    await syncInvocation(TARGET_USER_1_ORG_A, caller);
    await authorizeTranscript(TARGET_USER_1_ORG_A, "api_key");
    await authorizeTranscript(TARGET_USER_1_ORG_A, "desktop_session");
    await authorizeTranscript(TARGET_USER_1_ORG_A, "api_key");

    expect(
      refusalLogs().map((fields) => [fields.lane, fields.authMethod])
    ).toEqual([
      [SyncLane.InvocationParts, "desktop_session"],
      [SyncLane.TranscriptArchive, "api_key"],
      [SyncLane.TranscriptArchive, "desktop_session"],
    ]);
  });

  it("caps lines and reads per org across distinct targets, and counts what it dropped", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T12:00:00.000Z"));
    const caller = { organizationId: ORG_B, userId: USER_1 };
    const targets = Array.from(
      { length: 2 * ORG_BUDGET_PROBE },
      (_, index) =>
        `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`
    );

    for (const target of [...targets, ...targets]) {
      await syncInvocation(target, caller);
    }
    const capped = refusalLogs().length;

    // Bounded by the org, not by how many targets the caller can name.
    expect(capped).toBeLessThan(targets.length);
    expect(mocks.findUnique).toHaveBeenCalledTimes(capped);

    // Another org has its own budget.
    await syncInvocation(TARGET_MISSING, {
      organizationId: ORG_A,
      userId: USER_1,
    });
    expect(refusalLogs()).toHaveLength(capped + 1);

    vi.setSystemTime(new Date("2026-10-05T12:01:00.000Z"));
    await syncInvocation(TARGET_MISSING, caller);
    expect(refusalLogs().at(-1)).toEqual(
      expect.objectContaining({
        organizationId: ORG_B,
        // Every refusal neither emitted nor folded into its own key's window:
        // the second pass's first `capped` targets are key-suppressed instead.
        orgSuppressedCount: 4 * ORG_BUDGET_PROBE - 2 * capped,
      })
    );
  });
});

describe("compute_target.ownership_refused on the transcript lane", () => {
  it("emits from the shared transcript front door with the transcript lane and the credential kind", async () => {
    const result = await authorizeTranscriptRequest(
      {
        authMethod: "api_key",
        clerkUserId: null,
        organizationId: ORG_B,
        userId: USER_1,
        request: {
          computeTargetId: TARGET_USER_1_ORG_A,
          externalSessionId: "session-1",
          fileKey: "file-1",
        },
      },
      {
        now: () => 0,
        rateLimiter: new TranscriptRateLimiter(),
        s3: {} as never,
      }
    );

    expect(result).toEqual({ error: expect.any(String) });
    expect(refusalLogs()).toEqual([
      expect.objectContaining({
        lane: SyncLane.TranscriptArchive,
        authMethod: "api_key",
        organizationId: ORG_B,
        targetOrganizationId: ORG_A,
        classification:
          ComputeTargetOwnershipRefusalClassification.TargetOrgMismatch,
      }),
    ]);
  });
});

function authorizeTranscript(
  computeTargetId: string,
  authMethod: "api_key" | "desktop_session"
) {
  return authorizeTranscriptRequest(
    {
      authMethod,
      clerkUserId: null,
      organizationId: ORG_B,
      userId: USER_1,
      request: {
        computeTargetId,
        externalSessionId: "session-1",
        fileKey: "file-1",
      },
    },
    {
      now: () => 0,
      rateLimiter: new TranscriptRateLimiter(),
      s3: {} as never,
    }
  );
}
