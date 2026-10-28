import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
} from "@repo/api/src/types/agent-session";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { withDb } from "@repo/database";
import { NextRequest } from "next/server";
import { createComputeTarget } from "@/__tests__/utils/chunked-sync-test-helpers";
import { agentSessionsService } from "@/app/agent-sessions/service";
import { parseDesktopAgentSessionsPayload } from "@/lib/desktop-agent-sessions-schema";

/**
 * ISS-12552: setup shared by the Desktop sync receipt route tests. Pair with
 * `createReceiptRouteHarness`, whose world owns the organization and user.
 */
export type DesktopReceiptWorld = {
  organizationId: string;
  userId: string;
};

/** A compute target the world's user owns, the scope every sync lane checks. */
export function seedOwnedComputeTarget(
  world: DesktopReceiptWorld
): Promise<string> {
  return createComputeTarget(
    world.organizationId,
    world.userId,
    "iss12552-desktop-receipts"
  );
}

/**
 * A synced session row on the target, written through the real session
 * ingest, so lanes that hang off a session have a parent. Returns the
 * session's artifact id.
 */
export async function seedSyncedSession(
  world: DesktopReceiptWorld,
  computeTargetId: string,
  externalSessionId: string
): Promise<string> {
  const parsed = parseDesktopAgentSessionsPayload({
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: "00000000-0000-4000-8000-000000012552",
    syncMode: AgentSessionSyncMode.Backfill,
    sessionCount: 1,
    sessions: [
      {
        externalSessionId,
        name: externalSessionId,
        status: SESSION_STATUS.ACTIVE,
        harness: "claude",
        startedAt: "2026-06-12T09:00:00.000Z",
        updatedAt: "2026-06-12T11:00:00.000Z",
        agents: [],
        events: [],
        tokenUsageByModel: [],
      },
    ],
  });
  if (!parsed.ok) {
    throw new Error(`ISS-12552 session fixture rejected: ${parsed.reason}`);
  }
  await agentSessionsService.upsertSessions(
    { ...world, computeTargetId },
    parsed.payload
  );
  const session = await withDb((db) =>
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
  if (!session) {
    throw new Error("ISS-12552 session fixture was not stored");
  }
  return session.artifactId;
}

/** An API-key request to a Desktop lane that names its compute target. */
export function desktopLaneRequest(
  path: string,
  computeTargetId: string,
  body: unknown
): NextRequest {
  return new NextRequest(
    `http://localhost:3002${path}?computeTargetId=${computeTargetId}`,
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }
  );
}
