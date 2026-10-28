/**
 * ISS-12552: a token event's agent owner is correctable
 * evidence, not identity. A later slice that re-attributes a stored token
 * event to another agent must commit, and the operation evidence it carries
 * must persist in that same slice transaction.
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
import { afterEach, describe, expect, it, vi } from "vitest";
import { createComputeTarget } from "@/__tests__/utils/chunked-sync-test-helpers";
import {
  createCommittedTestOrganizationTracker,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { SessionSyncMetric } from "./session-sync-metrics";
import { upsertSessionsBatch } from "./upsert-sessions-batch";

const emitTelemetryMetric = vi.hoisted(() => vi.fn());

vi.mock("@repo/observability/telemetry/metrics", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@repo/observability/telemetry/metrics")
  >()),
  emitTelemetryMetric,
}));
// ISS-12552: owner correction runs while the sync request read the
// organization's flag as on; these cases call the batch directly.
vi.mock(
  "@/lib/attribution-evidence-policy-feature",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/lib/attribution-evidence-policy-feature")
    >()),
    isAttributionEvidenceReadOnForOrganization: vi.fn(() => true),
  })
);

const EXTERNAL_SESSION_ID = "iss12552-owner-session";
const EXTERNAL_EVENT_ID = "iss12552-owner-event";
const STARTED_AT = "2026-10-16T10:00:00.000Z";

describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 token-event owner correction at ingest",
  () => {
    const tracker = createCommittedTestOrganizationTracker();

    afterEach(async () => {
      await tracker.cleanup();
    });

    it("stores a re-attributed owner and persists the slice's operation evidence", async () => {
      const organizationId = await tracker.create();
      const user = await createTestUser(organizationId);
      const computeTargetId = await createComputeTarget(
        organizationId,
        user.id,
        "iss12552-owner-machine"
      );
      const context = { organizationId, userId: user.id, computeTargetId };

      await upsertSessionsBatch(
        context,
        payload(
          session("2026-10-16T11:00:00.000Z", "agent-a", [claim("toolu_a")])
        )
      );
      await upsertSessionsBatch(
        context,
        payload(
          session("2026-10-16T12:00:00.000Z", "agent-b", [
            claim("toolu_a"),
            claim("toolu_b"),
          ])
        )
      );

      const stored = await withDb((db) =>
        db.sessionDetail.findFirstOrThrow({
          where: { computeTargetId, externalSessionId: EXTERNAL_SESSION_ID },
          select: {
            artifactId: true,
            tokenEvents: {
              where: { externalEventId: EXTERNAL_EVENT_ID },
              select: { agentExternalId: true },
            },
          },
        })
      );
      const evidence = await withDb((db) =>
        db.agentSessionOperationEvidence.findMany({
          where: { agentSessionId: stored.artifactId },
          orderBy: { claimKey: "asc" },
          select: { claimKey: true },
        })
      );
      expect(stored.tokenEvents).toEqual([{ agentExternalId: "agent-b" }]);
      expect(evidence).toEqual([
        { claimKey: "claude:toolu_a" },
        { claimKey: "claude:toolu_b" },
      ]);
    });

    it("logs every owner change, a move to the main agent and the subagent claim after it (PRD-800)", async () => {
      const organizationId = await tracker.create();
      const user = await createTestUser(organizationId);
      const computeTargetId = await createComputeTarget(
        organizationId,
        user.id,
        "iss12552-owner-log-machine"
      );
      const context = { organizationId, userId: user.id, computeTargetId };
      const owners: (string | null)[] = [];
      const changesLogged: unknown[] = [];

      for (const [hour, owner] of [
        [11, "agent-a"],
        [12, PARENT_AGENT_EXTERNAL_ID],
        [13, "agent-a"],
      ] as const) {
        emitTelemetryMetric.mockClear();
        await upsertSessionsBatch(
          context,
          payload(
            session(`2026-10-16T${hour}:00:00.000Z`, owner, [claim("toolu_a")])
          )
        );
        const stored = await withDb((db) =>
          db.agentSessionTokenEvent.findFirstOrThrow({
            where: {
              externalEventId: EXTERNAL_EVENT_ID,
              session: { computeTargetId },
            },
            select: { agentExternalId: true },
          })
        );
        owners.push(stored.agentExternalId);
        changesLogged.push(
          emitTelemetryMetric.mock.calls
            .map(([event]) => event)
            .filter(
              (event) =>
                event.metric === SessionSyncMetric.TokenEventAgentOwnerChanged
            )
            .map((event) => event.count)
        );
      }

      expect(owners).toEqual(["agent-a", null, "agent-a"]);
      expect(changesLogged).toEqual([[], [1], [1]]);
    });
  }
);

function claim(callId: string): OperationClaim {
  return {
    claimKey: `claude:${callId}`,
    providerCallId: callId,
    source: OperationClaimSource.ClosedloopMcp,
    toolName: "get-document",
    operationKind: OperationKind.Read,
    resultState: ToolResultState.Present,
    invokedAt: STARTED_AT,
    resultAt: STARTED_AT,
  };
}

function session(
  updatedAt: string,
  agentExternalId: string,
  claims: OperationClaim[]
): SyncedAgentSession {
  return {
    externalSessionId: EXTERNAL_SESSION_ID,
    name: "ISS-12552 owner correction",
    status: SESSION_STATUS.ACTIVE,
    harness: Harness.Claude,
    cwd: "/tmp/iss12552-owner",
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
        agentExternalId,
      },
    ],
    operationEvidence: {
      extractorVersion: OPERATION_EVIDENCE_EXTRACTOR_VERSION,
      digest: claims.length.toString(16).padStart(64, "0"),
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

function payload(synced: SyncedAgentSession): DesktopAgentSessionsPayload {
  return {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: crypto.randomUUID(),
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: 1,
    sessions: [synced],
  };
}
