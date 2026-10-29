import { randomUUID } from "node:crypto";
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  type SyncedAgentSession,
} from "@repo/api/src/types/agent-session";
import {
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  desktopLaneRequest,
  seedOwnedComputeTarget,
} from "@/__tests__/support/desktop/desktop-sync-receipt.test-helpers";
import {
  countReceipts,
  createReceiptRouteHarness,
  readReceipts,
  receiptRouteParams,
  turnAttributionFlagOff,
} from "@/__tests__/support/lib/operation-receipt-route.test-helpers";
import { countTransactions } from "@/__tests__/support/lib/transaction-count.test-helpers";
import type { recordOperationReceipt as RecordOperationReceipt } from "@/lib/operation-receipts/operation-receipt-writer";

/**
 * Fails exactly one receipt insert, by call order, so one session's slice
 * rolls back while the others in the same request commit. The shared writer
 * mock fails every insert, which cannot show per-slice isolation.
 */
const failOne = vi.hoisted(() => ({ failOnCall: 0, calls: 0, forced: 0 }));

vi.mock("@/lib/attribution-evidence-policy-feature", async (importOriginal) =>
  (
    await import("@/__tests__/support/lib/operation-receipt-route.test-mocks")
  ).receiptRouteFlagMock(await importOriginal())
);
vi.mock("@/lib/auth/with-any-auth", async () =>
  (
    await import("@/__tests__/support/lib/operation-receipt-route.test-mocks")
  ).receiptRouteAuthMock()
);
vi.mock("@vercel/functions", async () =>
  (
    await import("@/__tests__/support/lib/operation-receipt-route.test-mocks")
  ).receiptRouteWaitUntilMock()
);
vi.mock(
  "@/lib/operation-receipts/operation-receipt-writer",
  async (importOriginal) => {
    const actual = await importOriginal<{
      recordOperationReceipt: typeof RecordOperationReceipt;
    }>();
    return {
      ...actual,
      recordOperationReceipt: async (
        params: Parameters<typeof RecordOperationReceipt>[0]
      ) => {
        if (params.request) {
          failOne.calls += 1;
          if (failOne.calls === failOne.failOnCall) {
            failOne.forced += 1;
            await params.tx.$queryRaw`SELECT 1 / 0`;
          }
        }
        return actual.recordOperationReceipt(params);
      },
    };
  }
);

import { POST as syncSessions } from "@/app/desktop/agent-sessions/sync/route";
import { desktopAgentSessionsSyncService } from "@/app/desktop/agent-sessions/sync/service";

const harness = createReceiptRouteHarness();
const SESSIONS_ROUTE = "/desktop/agent-sessions/sync";
const SESSION_IDS = ["iss12552-s1", "iss12552-s2", "iss12552-s3"];

/**
 * ISS-12552: an API-key session sync records one Desktop sync
 * receipt per session, inside that session's own slice transaction.
 */
describe.skipIf(!keys().DATABASE_URL)("ISS-12552 session sync receipts", () => {
  afterEach(async () => {
    failOne.failOnCall = 0;
    failOne.calls = 0;
    failOne.forced = 0;
    vi.restoreAllMocks();
    await harness.cleanup();
  });

  it("rolls back only the session whose receipt cannot be stored", async () => {
    const world = await harness.seedWorld();
    const computeTargetId = await seedOwnedComputeTarget(world);
    failOne.failOnCall = 2;

    const response = await syncSessions(
      sessionsRequest(computeTargetId),
      receiptRouteParams({})
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(failOne.forced).toBe(1);
    expect(body.data).toEqual({
      synced: true,
      acceptedSessionIds: ["iss12552-s1", "iss12552-s3"],
    });
    expect(await storedSessionIds(computeTargetId)).toEqual([
      "iss12552-s1",
      "iss12552-s3",
    ]);
    expect(await readReceipts(world.organizationId)).toEqual([
      sessionReceipt(),
      sessionReceipt(),
    ]);
  });

  it("records one committed receipt per session", async () => {
    const world = await harness.seedWorld();
    const computeTargetId = await seedOwnedComputeTarget(world);

    const response = await syncSessions(
      sessionsRequest(computeTargetId),
      receiptRouteParams({})
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({
      synced: true,
      acceptedSessionIds: SESSION_IDS,
    });
    expect(await storedSessionIds(computeTargetId)).toEqual(SESSION_IDS);
    expect(await readReceipts(world.organizationId)).toEqual([
      sessionReceipt(),
      sessionReceipt(),
      sessionReceipt(),
    ]);
  });

  it("writes no receipt with attribution-evidence-policy off", async () => {
    const world = await harness.seedWorld();
    const computeTargetId = await seedOwnedComputeTarget(world);
    turnAttributionFlagOff();

    const response = await syncSessions(
      sessionsRequest(computeTargetId),
      receiptRouteParams({})
    );

    expect(response.status).toBe(200);
    expect(await storedSessionIds(computeTargetId)).toEqual(SESSION_IDS);
    expect(await countReceipts(world.organizationId)).toBe(0);
  });

  it("with the flag off the ingest is handed no record and runs main's slice transactions", async () => {
    const world = await harness.seedWorld();
    const computeTargetId = await seedOwnedComputeTarget(world);
    turnAttributionFlagOff();
    const sync = vi.spyOn(desktopAgentSessionsSyncService, "sync");
    const transactions = countTransactions();

    const response = await syncSessions(
      sessionsRequest(computeTargetId),
      receiptRouteParams({})
    );

    expect(response.status).toBe(200);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync.mock.calls[0]?.[1]).toBeUndefined();
    expect(transactions.opened).toBe(SESSION_IDS.length);
    expect(await storedSessionIds(computeTargetId)).toEqual(SESSION_IDS);
  });
});

function sessionReceipt() {
  return {
    operationKind: OperationKind.DesktopSync,
    outcome: OperationReceiptOutcome.Committed,
    source: OperationSource.Api,
    targetArtifactId: null,
    createdArtifactId: null,
    changedFields: [],
    route: SESSIONS_ROUTE,
  };
}

function sessionsRequest(computeTargetId: string) {
  return desktopLaneRequest(SESSIONS_ROUTE, computeTargetId, {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: randomUUID(),
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: SESSION_IDS.length,
    wantsAcceptedSessionIds: true,
    sessions: SESSION_IDS.map(session),
  });
}

function session(externalSessionId: string): SyncedAgentSession {
  return {
    externalSessionId,
    name: externalSessionId,
    status: SESSION_STATUS.ACTIVE,
    harness: "claude",
    startedAt: "2026-06-12T09:00:00.000Z",
    updatedAt: "2026-06-12T11:00:00.000Z",
    agents: [],
    events: [],
    tokenUsageByModel: [],
  };
}

async function storedSessionIds(computeTargetId: string): Promise<string[]> {
  const rows = await withDb((db) =>
    db.sessionDetail.findMany({
      where: { computeTargetId },
      select: { externalSessionId: true },
      orderBy: { externalSessionId: "asc" },
    })
  );
  return rows.map((row) => row.externalSessionId);
}
