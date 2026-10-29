/**
 * ISS-7265: the wire contract accepts `activitySegmentRowsStripped`, the flag a
 * desktop stamps when it OMITTED a session's activity tiling to fit the byte cap.
 *
 * Both skew directions matter and are covered here. An old desktop omits the
 * field, which must keep parsing and must read as "nothing stripped" — the flag
 * may never make absence ambiguous, because absence is what every installed
 * build sends. A new desktop sets it, and the parsed payload must preserve the
 * value rather than drop it, or the signal dies at the ingress boundary.
 *
 * DB-free: exercises only `parseDesktopAgentSessionsPayload`.
 */
import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import { describe, expect, it } from "vitest";
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  parseDesktopAgentSessionsPayload,
} from "./desktop-agent-sessions-schema";

function buildPayload(session: Record<string, unknown>): unknown {
  return {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: "00000000-0000-4000-8000-000000000002",
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: 1,
    sessions: [
      {
        externalSessionId: "sess-strip",
        status: "active",
        startedAt: "2026-06-10T10:00:00.000Z",
        updatedAt: "2026-06-10T11:00:00.000Z",
        agents: [],
        events: [],
        tokenUsageByModel: [],
        ...session,
      },
    ],
  };
}

describe("desktop sync schema — tiling-stripped flag (ISS-7265)", () => {
  it("preserves the flag a stripping desktop set", () => {
    const parsed = parseDesktopAgentSessionsPayload(
      buildPayload({ activitySegmentRowsStripped: true })
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.payload.sessions[0].activitySegmentRowsStripped).toBe(true);
    }
  });

  it("accepts an old desktop that omits the flag, and reads it as not stripped", () => {
    const parsed = parseDesktopAgentSessionsPayload(buildPayload({}));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(
        parsed.payload.sessions[0].activitySegmentRowsStripped ?? false
      ).toBe(false);
    }
  });

  it("keeps the stripped flag independent of the truncated one", () => {
    // The two describe different states — an omitted tiling versus a partial
    // prefix — so the schema must let a payload carry either without the other.
    const parsed = parseDesktopAgentSessionsPayload(
      buildPayload({
        activitySegmentRowsStripped: true,
        activitySegmentRowsTruncated: false,
      })
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.payload.sessions[0].activitySegmentRowsStripped).toBe(true);
      expect(parsed.payload.sessions[0].activitySegmentRowsTruncated).toBe(
        false
      );
    }
  });

  it("rejects a non-boolean flag", () => {
    const parsed = parseDesktopAgentSessionsPayload(
      buildPayload({ activitySegmentRowsStripped: "yes" })
    );
    expect(parsed.ok).toBe(false);
  });
});
