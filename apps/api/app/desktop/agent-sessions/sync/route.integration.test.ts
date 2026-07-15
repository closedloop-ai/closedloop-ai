import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  type DesktopAgentSessionsPayload,
  type SyncedAgentSession,
} from "@repo/api/src/types/agent-session";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestUser,
} from "@/__tests__/utils/db-helpers";

const mocks = vi.hoisted(() => ({
  auth: {
    clerkUserId: "clerk-route-fragment-user",
    user: {
      id: "user-route-fragment",
      organizationId: "org-route-fragment",
    },
  },
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest) =>
      handler(mocks.auth, request),
}));

vi.mock("@/lib/agent-session-sync-feature", () => ({
  isAgentMonitoringEnabledForUser: vi.fn().mockResolvedValue(true),
  isAgentSessionSyncSupportedForUser: vi.fn().mockResolvedValue(true),
}));

import { POST } from "./route";

const env = keys();
const hasDatabase = !!env.DATABASE_URL;
const describeIfDb = hasDatabase ? describe : describe.skip;

describeIfDb(
  "POST /desktop/agent-sessions/sync numeric fidelity (FEA-2728)",
  () => {
    // Token counts above the old int4 ceiling (2,147,483,647) and a cost above the
    // old Decimal(10,6) $9,999.999999 cap must round-trip byte-exact through
    // parse -> handler -> service -> Postgres. Tokens travel the wire as JSON
    // numbers (deliberately kept within the 2^53 safe-integer envelope, not
    // stringified) and land in BigInt (int8) columns; cost lands in Decimal(14,6).
    // This guards against any Number()/parseInt narrowing hop the widened columns
    // alone would not catch.
    it("carries >2^31 token counts and >$10k cost without truncation", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const user = await createTestUser(organizationId, {
          clerkId: mocks.auth.clerkUserId,
        });
        mocks.auth.user = { id: user.id, organizationId };
        const computeTarget = await createComputeTarget(
          organizationId,
          user.id
        );

        const session = buildSyncedSession({
          externalSessionId: "route-numeric-fidelity-session",
          tokenUsageByModel: [
            {
              model: "claude-opus-4",
              inputTokens: 2_500_000_000,
              outputTokens: 1_000_000,
              cacheReadTokens: 3_000_000_000,
              cacheWriteTokens: 4_000_000_000,
              estimatedCostUsd: 12_345.678_901,
            },
          ],
        });

        const response = await POST(
          batchRequest(buildBatchPayload(session), computeTarget.id),
          routeContext()
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body).toEqual({ success: true, data: { synced: true } });

        const detail = await readSessionTotals(
          computeTarget.id,
          session.externalSessionId
        );
        expect(detail).not.toBeNull();
        // Session-level totals (summed across models) land in BigInt columns
        // exactly — no int4 truncation at 3e9 / 4e9.
        expect(detail?.inputTokens).toBe(2_500_000_000n);
        expect(detail?.cacheReadTokens).toBe(3_000_000_000n);
        expect(detail?.cacheWriteTokens).toBe(4_000_000_000n);
        // Decimal(14,6) preserves a cost above the old $9,999.999999 cap.
        expect(Number(detail?.estimatedCost)).toBe(12_345.678_901);

        const usage = await readTokenUsageRow(
          detail?.artifactId ?? "",
          "claude-opus-4"
        );
        expect(usage).not.toBeNull();
        expect(usage?.inputTokens).toBe(2_500_000_000n);
        expect(usage?.cacheReadTokens).toBe(3_000_000_000n);
        expect(usage?.cacheWriteTokens).toBe(4_000_000_000n);
        expect(Number(usage?.estimatedCost)).toBe(12_345.678_901);
      });
    });
  }
);

describeIfDb(
  "POST /desktop/agent-sessions/sync legacy field tolerance (FEA-2728)",
  () => {
    it("ingests old-desktop payloads carrying removed issues / attribution.issueId", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const user = await createTestUser(organizationId, {
          clerkId: mocks.auth.clerkUserId,
        });
        mocks.auth.user = { id: user.id, organizationId };
        const computeTarget = await createComputeTarget(
          organizationId,
          user.id
        );

        const session = buildSyncedSession({
          externalSessionId: "route-legacy-issue-fields-session",
        });
        // Simulate a pre-FEA-2728 Desktop build still emitting the removed wire
        // fields. Built as an untyped literal (not DesktopAgentSessionsPayload)
        // so it mirrors an old client without an unsafe cast; the route parses
        // raw JSON and the ingest Zod schema strips these unknown keys. FEA-2728
        // requires this to succeed, never reject with validation_failed.
        const legacyBody = {
          schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
          batchId: "d4b6b0a2-6a3e-4f9c-8b1d-2c3e4f5a6b7d",
          syncMode: AgentSessionSyncMode.Incremental,
          sessionCount: 1,
          sessions: [
            {
              ...session,
              issues: ["FEA-9999"],
              attribution: {
                issueId: "FEA-9999",
                repositoryFullName: "acme/legacy",
              },
            },
          ],
        };

        const response = await POST(
          new NextRequest(
            `https://api.example.test/desktop/agent-sessions/sync?computeTargetId=${computeTarget.id}`,
            { body: JSON.stringify(legacyBody), method: "POST" }
          ),
          routeContext()
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          success: true,
          data: { synced: true },
        });

        // The session lands; the stripped legacy fields simply aren't persisted
        // (their columns are gone), while other attribution still applies.
        const detail = await readSessionRepository(
          computeTarget.id,
          session.externalSessionId
        );
        expect(detail?.repositoryFullName).toBe("acme/legacy");
      });
    });
  }
);

describeIfDb(
  "POST /desktop/agent-sessions/sync org isolation (FEA-2734 FR11)",
  () => {
    it("rejects a sync that targets another org's compute target and never cross-writes", async () => {
      await autoRollbackTransaction(async () => {
        // Org A is the authenticated caller.
        const orgA = await createTestOrganization();
        const userA = await createTestUser(orgA, {
          clerkId: mocks.auth.clerkUserId,
        });
        mocks.auth.user = { id: userA.id, organizationId: orgA };
        const targetA = await createComputeTarget(orgA, userA.id);

        // Org B is a different tenant with its own compute target.
        const orgB = await createTestOrganization();
        const userB = await createTestUser(orgB);
        const targetB = await createComputeTarget(orgB, userB.id);

        const session = buildSyncedSession({
          externalSessionId: "fr11-cross-write-session",
        });

        // Authenticated as org A but pointing at org B's compute target. Org is
        // derived from the API key (orgA), never the payload/query, so the
        // service resolves the target via findOwnedById(targetB, orgA) → not
        // owned → Forbidden. A forged foreign target cannot cross-write.
        const forgedResponse = await POST(
          batchRequest(buildBatchPayload(session), targetB.id),
          routeContext()
        );
        expect(forgedResponse.status).toBe(403);

        // Nothing was written under org B's target, and org B has zero sessions.
        await expect(
          findSessionArtifact(targetB.id, session.externalSessionId)
        ).resolves.toBeNull();
        await expect(countOrgSessions(orgB)).resolves.toBe(0);

        // Positive control: the identical payload against org A's OWN target
        // succeeds and the resulting session is owned by org A (the auth org).
        const okResponse = await POST(
          batchRequest(buildBatchPayload(session), targetA.id),
          routeContext()
        );
        expect(okResponse.status).toBe(200);
        const owner = await findSessionArtifactOrg(
          targetA.id,
          session.externalSessionId
        );
        expect(owner).toBe(orgA);
        await expect(countOrgSessions(orgB)).resolves.toBe(0);
      });
    });
  }
);

function countOrgSessions(organizationId: string) {
  return withDb((db) =>
    db.sessionDetail.count({
      where: { artifact: { is: { organizationId } } },
    })
  );
}

function findSessionArtifact(
  computeTargetId: string,
  externalSessionId: string
) {
  return withDb((db) =>
    db.sessionDetail.findUnique({
      where: {
        computeTargetId_externalSessionId: {
          computeTargetId,
          externalSessionId,
        },
      },
      select: { artifactId: true },
    })
  );
}

function findSessionArtifactOrg(
  computeTargetId: string,
  externalSessionId: string
) {
  return withDb(async (db) => {
    const row = await db.sessionDetail.findUnique({
      where: {
        computeTargetId_externalSessionId: {
          computeTargetId,
          externalSessionId,
        },
      },
      select: { artifact: { select: { organizationId: true } } },
    });
    return row?.artifact.organizationId ?? null;
  });
}

function batchRequest(
  body: DesktopAgentSessionsPayload,
  computeTargetId: string
): NextRequest {
  return new NextRequest(
    `https://api.example.test/desktop/agent-sessions/sync?computeTargetId=${computeTargetId}`,
    {
      body: JSON.stringify(body),
      method: "POST",
    }
  );
}

function buildBatchPayload(
  session: SyncedAgentSession
): DesktopAgentSessionsPayload {
  return {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: "d4b6b0a2-6a3e-4f9c-8b1d-2c3e4f5a6b7c",
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: 1,
    sessions: [session],
  };
}

function readSessionRepository(
  computeTargetId: string,
  externalSessionId: string
) {
  return withDb((db) =>
    db.sessionDetail.findUnique({
      where: {
        computeTargetId_externalSessionId: {
          computeTargetId,
          externalSessionId,
        },
      },
      select: { repositoryFullName: true },
    })
  );
}

function readSessionTotals(computeTargetId: string, externalSessionId: string) {
  return withDb((db) =>
    db.sessionDetail.findUnique({
      where: {
        computeTargetId_externalSessionId: {
          computeTargetId,
          externalSessionId,
        },
      },
      select: {
        artifactId: true,
        inputTokens: true,
        cacheReadTokens: true,
        cacheWriteTokens: true,
        estimatedCost: true,
      },
    })
  );
}

function readTokenUsageRow(agentSessionId: string, model: string) {
  return withDb((db) =>
    db.agentSessionTokenUsage.findUnique({
      where: { agentSessionId_model: { agentSessionId, model } },
      select: {
        inputTokens: true,
        cacheReadTokens: true,
        cacheWriteTokens: true,
        estimatedCost: true,
      },
    })
  );
}

function routeContext(): { params: Promise<Record<string, string>> } {
  return { params: Promise.resolve({}) };
}

function createComputeTarget(organizationId: string, userId: string) {
  return withDb((db) =>
    db.computeTarget.create({
      data: {
        organizationId,
        userId,
        machineName: "route-fragment-machine",
        platform: "darwin",
      },
      select: { id: true },
    })
  );
}

function buildSyncedSession(
  overrides: Partial<SyncedAgentSession> = {}
): SyncedAgentSession {
  return {
    externalSessionId: "route-session",
    status: "active",
    harness: "codex",
    cwd: "/tmp/route-fragment",
    startedAt: "2026-06-10T10:00:00.000Z",
    updatedAt: "2026-06-10T11:00:00.000Z",
    agents: [],
    events: [],
    tokenUsageByModel: [],
    ...overrides,
  };
}
