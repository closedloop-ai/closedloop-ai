/**
 * ISS-12552 (PRD-800 "Rollout"): sync ingest reads the attribution flag
 * once per request, for the sync caller's organization, before any slice
 * transaction opens. For an organization the flag is off for, the batch stores
 * what the server stored before PRD-800: no operation evidence, no evidence
 * snapshot and no implementation derivation, a new token event's owner as sent
 * and no owner correction, while the batch is still acknowledged.
 */
import { Harness } from "@repo/api/src/types/agent-component";
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  type DesktopAgentSessionsPayload,
  type SyncedAgentSession,
} from "@repo/api/src/types/agent-session";
import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import {
  OPERATION_EVIDENCE_EXTRACTOR_VERSION,
  type OperationClaim,
  OperationClaimSource,
  ToolResultState,
} from "@repo/api/src/types/operation-claims";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { PARENT_AGENT_EXTERNAL_ID } from "@repo/api/src/types/token-event-agent-owner";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createComputeTarget } from "@/__tests__/utils/chunked-sync-test-helpers";
import {
  createCommittedTestOrganizationTracker,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { agentSessionsService } from "../../service";
import { deriveCommittedImplementationEvidence } from "./derive-committed-implementation-evidence";
import { deriveImplementationEvidence } from "./derive-implementation-evidence";

const flag = vi.hoisted(() => ({
  onClerkOrganizationIds: new Set<string>(),
  reads: 0,
  openTransactions: 0,
  readInsideTransaction: false,
}));
vi.mock(
  "@/lib/feature-flags/server-feature-flag-evaluation",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/lib/feature-flags/server-feature-flag-evaluation")
    >()),
    evaluateServerFeatureFlagForOrganization: vi.fn(
      (_flag: unknown, clerkOrganizationId: string) => {
        flag.reads += 1;
        if (flag.openTransactions > 0) {
          flag.readInsideTransaction = true;
        }
        return Promise.resolve(
          flag.onClerkOrganizationIds.has(clerkOrganizationId)
        );
      }
    ),
  })
);
vi.mock("./derive-implementation-evidence", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./derive-implementation-evidence")>();
  return {
    ...actual,
    deriveImplementationEvidence: vi.fn(actual.deriveImplementationEvidence),
  };
});

const EXTERNAL_SESSION_ID = "iss12552-ingest-gate";
const EXTERNAL_EVENT_ID = "iss12552-ingest-gate-event";
const STARTED_AT = "2026-10-21T10:00:00.000Z";
const tracker = createCommittedTestOrganizationTracker();

describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 attribution flag at sync ingest",
  () => {
    beforeEach(() => {
      vi.mocked(deriveImplementationEvidence).mockClear();
      flag.onClerkOrganizationIds.clear();
      flag.reads = 0;
      flag.openTransactions = 0;
      flag.readInsideTransaction = false;
      const tx = withDb.tx;
      vi.spyOn(withDb, "tx").mockImplementation(async (fn, options) => {
        flag.openTransactions += 1;
        try {
          return await tx(fn, options);
        } finally {
          flag.openTransactions -= 1;
        }
      });
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      await tracker.cleanup();
    });

    it("captures for the organization the flag is on for and stores the pre-PRD-800 rows for the other", async () => {
      const on = await seed(true);
      const off = await seed(false);

      flag.reads = 0;
      const onAck = await agentSessionsService.upsertSessions(
        on.context,
        payload()
      );
      expect(flag.reads).toBe(1);
      flag.reads = 0;
      const offAck = await agentSessionsService.upsertSessions(
        off.context,
        payload()
      );
      expect(flag.reads).toBe(1);

      expect(flag.readInsideTransaction).toBe(false);
      expect(onAck.persistedSessionIds).toEqual([EXTERNAL_SESSION_ID]);
      expect(offAck.persistedSessionIds).toEqual([EXTERNAL_SESSION_ID]);
      expect(await stored(on)).toEqual({
        evidenceRows: 1,
        snapshots: 1,
        owners: ["agent-sub"],
      });
      expect(await stored(off)).toEqual({
        evidenceRows: 0,
        snapshots: 0,
        owners: ["agent-sub"],
      });
      const derivedOrganizations = vi
        .mocked(deriveImplementationEvidence)
        .mock.calls.map(([, scope]) => scope.organizationId);
      expect(derivedOrganizations).toEqual([on.organizationId]);
    });

    it("keeps a changed token-event owner and acks where the flag is off, and applies it where on", async () => {
      const on = await seed(true);
      const off = await seed(false);
      const acks: string[][] = [];
      for (const fixture of [on, off]) {
        await agentSessionsService.upsertSessions(fixture.context, payload());
        const resync = payload("agent-other", "2026-10-21T12:00:00.000Z");
        const ack = await agentSessionsService.upsertSessions(
          fixture.context,
          resync
        );
        acks.push(ack.persistedSessionIds);
      }

      expect(acks).toEqual([[EXTERNAL_SESSION_ID], [EXTERNAL_SESSION_ID]]);
      expect((await stored(on)).owners).toEqual(["agent-other"]);
      expect((await stored(off)).owners).toEqual(["agent-sub"]);
    });

    it("stores a new event sent as the main agent with no owner, whether the flag is on or off", async () => {
      const on = await seed(true);
      const off = await seed(false);

      for (const fixture of [on, off]) {
        await agentSessionsService.upsertSessions(
          fixture.context,
          payload(PARENT_AGENT_EXTERNAL_ID)
        );
      }

      expect((await stored(on)).owners).toEqual([null]);
      expect((await stored(off)).owners).toEqual([null]);
    });

    it("moves a stored owner to the main agent where the flag is on, and keeps it and acks where off", async () => {
      const on = await seed(true);
      const off = await seed(false);
      const acks: string[][] = [];
      for (const fixture of [on, off]) {
        await agentSessionsService.upsertSessions(fixture.context, payload());
        const ack = await agentSessionsService.upsertSessions(
          fixture.context,
          payload(PARENT_AGENT_EXTERNAL_ID, "2026-10-21T12:00:00.000Z")
        );
        acks.push(ack.persistedSessionIds);
      }

      expect(acks).toEqual([[EXTERNAL_SESSION_ID], [EXTERNAL_SESSION_ID]]);
      expect((await stored(on)).owners).toEqual([null]);
      expect((await stored(off)).owners).toEqual(["agent-sub"]);
    });

    it("derives committed sessions only for the organization the flag is on for", async () => {
      const on = await seed(true);
      const off = await seed(false);
      vi.mocked(deriveImplementationEvidence).mockClear();

      await deriveCommittedImplementationEvidence(off.organizationId, [
        crypto.randomUUID(),
      ]);
      await deriveCommittedImplementationEvidence(on.organizationId, [
        crypto.randomUUID(),
      ]);

      expect(
        vi
          .mocked(deriveImplementationEvidence)
          .mock.calls.map(([, scope]) => scope.organizationId)
      ).toEqual([on.organizationId]);
      expect(flag.readInsideTransaction).toBe(false);
    });
  }
);

type Fixture = {
  organizationId: string;
  context: { organizationId: string; userId: string; computeTargetId: string };
};

async function seed(flagOn: boolean): Promise<Fixture> {
  const organizationId = await tracker.create();
  const user = await createTestUser(organizationId);
  const computeTargetId = await createComputeTarget(
    organizationId,
    user.id,
    "iss12552-ingest-gate-machine"
  );
  if (flagOn) {
    const organization = await withDb((db) =>
      db.organization.findUniqueOrThrow({
        where: { id: organizationId },
        select: { clerkId: true },
      })
    );
    flag.onClerkOrganizationIds.add(organization.clerkId);
  }
  return {
    organizationId,
    context: { organizationId, userId: user.id, computeTargetId },
  };
}

async function stored(fixture: Fixture) {
  const session = await withDb((db) =>
    db.sessionDetail.findFirstOrThrow({
      where: {
        computeTargetId: fixture.context.computeTargetId,
        externalSessionId: EXTERNAL_SESSION_ID,
      },
      select: {
        artifactId: true,
        tokenEvents: { select: { agentExternalId: true } },
      },
    })
  );
  const [evidenceRows, snapshots] = await withDb((db) =>
    Promise.all([
      db.agentSessionOperationEvidence.count({
        where: { agentSessionId: session.artifactId },
      }),
      db.agentSessionOperationEvidenceSnapshot.count({
        where: { agentSessionId: session.artifactId },
      }),
    ])
  );
  return {
    evidenceRows,
    snapshots,
    owners: session.tokenEvents.map((event) => event.agentExternalId),
  };
}

function readClaim(): OperationClaim {
  return {
    claimKey: "claude:toolu_read",
    providerCallId: "toolu_read",
    source: OperationClaimSource.ClosedloopMcp,
    toolName: "get-document",
    operationKind: OperationKind.Read,
    resultState: ToolResultState.Present,
    invokedAt: STARTED_AT,
    resultAt: STARTED_AT,
  };
}

function session(owner: string, updatedAt: string): SyncedAgentSession {
  const claims = [readClaim()];
  return {
    externalSessionId: EXTERNAL_SESSION_ID,
    name: "ISS-12552 ingest gate",
    status: SESSION_STATUS.ACTIVE,
    harness: Harness.Claude,
    cwd: "/tmp/iss12552-ingest-gate",
    startedAt: STARTED_AT,
    updatedAt,
    agents: [],
    events: [],
    tokenUsageByModel: [],
    tokenEvents: [
      {
        externalEventId: EXTERNAL_EVENT_ID,
        model: "claude-opus-4",
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheWriteTokens: 40,
        estimatedCostUsd: 0.5,
        createdAt: STARTED_AT,
        agentExternalId: owner,
      },
    ],
    operationEvidence: {
      extractorVersion: OPERATION_EVIDENCE_EXTRACTOR_VERSION,
      digest: "c".repeat(64),
      coverage: {
        harness: "claude",
        evidencePathSupported: true,
        closedloopMcpCalls: claims.length,
        shellCallsWithOperationIds: 0,
        directApiShellCommands: 0,
        unsupportedToolNames: {},
        claimsDroppedByCap: 0,
      },
      claims,
    },
  };
}

function payload(
  owner = "agent-sub",
  updatedAt = "2026-10-21T11:00:00.000Z"
): DesktopAgentSessionsPayload {
  return {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: crypto.randomUUID(),
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: 1,
    sessions: [session(owner, updatedAt)],
    wantsAcceptedSessionIds: true,
  };
}
