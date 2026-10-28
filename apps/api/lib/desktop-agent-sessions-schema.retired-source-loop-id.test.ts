import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
} from "@repo/api/src/types/agent-session";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { describe, expect, it } from "vitest";
import { toNonNullAttributionPatch } from "@/app/agent-sessions/service/persist-session-children";
import { toIndexBoundAttributionColumns } from "@/app/agent-sessions/service/session-slice-detail-columns";
import { parseDesktopAgentSessionsPayload } from "./desktop-agent-sessions-schema";

/**
 * ISS-12435: a Desktop build older than the Loops removal still sends
 * `attribution.sourceLoopId`. The batch must parse, and the value must reach
 * neither arm of the session detail upsert.
 */

const OLD_DESKTOP_SOURCE_LOOP_ID = "0199e7a2-1243-4000-a000-000000012435";
const SOURCE_ARTIFACT_ID = "0199e7a2-1243-4000-a000-000000000001";

function parsedOldDesktopSession() {
  const parsed = parseDesktopAgentSessionsPayload({
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: "0199e7a2-1243-4000-a000-000000000002",
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: 1,
    sessions: [
      {
        externalSessionId: "iss-12435-session",
        name: "iss-12435-session",
        status: SESSION_STATUS.INACTIVE,
        startedAt: "2026-10-01T12:00:00.000Z",
        updatedAt: "2026-10-01T12:00:00.000Z",
        agents: [],
        events: [],
        tokenUsageByModel: [],
        attribution: {
          repositoryFullName: null,
          worktreePath: null,
          sourceArtifactId: SOURCE_ARTIFACT_ID,
          sourceLoopId: OLD_DESKTOP_SOURCE_LOOP_ID,
          baseBranch: null,
        },
      },
    ],
  });
  if (!parsed.ok) {
    throw new Error(`expected the payload to parse: ${parsed.reason}`);
  }
  if (parsed.kind !== "batch") {
    throw new Error(`expected a batch payload, got ${parsed.kind}`);
  }
  return parsed.payload.sessions[0];
}

describe("ISS-12435 old Desktop attribution.sourceLoopId", () => {
  it("accepts a batch whose session carries a non-null sourceLoopId uuid", () => {
    const session = parsedOldDesktopSession();

    expect(session.attribution?.sourceArtifactId).toBe(SOURCE_ARTIFACT_ID);
  });

  it("keeps the value out of the create and update arms of the detail upsert", () => {
    const session = parsedOldDesktopSession();

    const { columns } = toIndexBoundAttributionColumns(session);
    const updatePatch = toNonNullAttributionPatch(columns);

    expect(columns).not.toHaveProperty("sourceLoopId");
    expect(updatePatch).not.toHaveProperty("sourceLoopId");
    expect(Object.values(columns)).not.toContain(OLD_DESKTOP_SOURCE_LOOP_ID);
    expect(updatePatch).toEqual({ sourceArtifactId: SOURCE_ARTIFACT_ID });
  });
});
