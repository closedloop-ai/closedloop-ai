/**
 * FEA-3788 (PRD-536 D3): the wire contract accepts the optional per-chunk
 * `{ index, total }` marker used to make a chunked apply repairable, and rejects
 * a malformed marker (index >= total) so a bad marker can never mis-gate the
 * cloud's first-chunk delete / last-chunk revision-commit logic.
 *
 * DB-free: exercises only `parseDesktopAgentSessionsPayload` (the pure ingress
 * contract), so it runs without a Postgres connection.
 */
import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import { describe, expect, it } from "vitest";
import { parseDesktopAgentSessionsPayload } from "./desktop-agent-sessions-schema";

const AGENT_SESSION_SYNC_SCHEMA_VERSION = 2 as const;

function buildPayload(chunk: unknown): unknown {
  return {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: "00000000-0000-4000-8000-000000000001",
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: 1,
    sessions: [
      {
        externalSessionId: "sess-1",
        status: "active",
        startedAt: "2026-06-10T10:00:00.000Z",
        updatedAt: "2026-06-10T11:00:00.000Z",
        dataRevision: 7,
        ...(chunk === undefined ? {} : { chunk }),
        agents: [],
        events: [],
        tokenUsageByModel: [],
      },
    ],
  };
}

describe("desktop sync schema — chunk marker (FEA-3788)", () => {
  it("accepts a valid chunk marker (index < total)", () => {
    const parsed = parseDesktopAgentSessionsPayload(
      buildPayload({ index: 0, total: 3 })
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.payload.sessions[0].chunk).toEqual({ index: 0, total: 3 });
    }
  });

  it("accepts the last chunk (index === total - 1)", () => {
    const parsed = parseDesktopAgentSessionsPayload(
      buildPayload({ index: 2, total: 3 })
    );
    expect(parsed.ok).toBe(true);
  });

  it("treats an omitted chunk marker as a valid unchunked whole session", () => {
    const parsed = parseDesktopAgentSessionsPayload(buildPayload(undefined));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      // No marker: the cloud treats it as first AND last chunk (0 of 1).
      expect(parsed.payload.sessions[0].chunk ?? null).toBeNull();
    }
  });

  it("rejects a marker whose index is not strictly less than total", () => {
    const parsed = parseDesktopAgentSessionsPayload(
      buildPayload({ index: 3, total: 3 })
    );
    expect(parsed.ok).toBe(false);
  });

  it("rejects a negative chunk index", () => {
    const parsed = parseDesktopAgentSessionsPayload(
      buildPayload({ index: -1, total: 2 })
    );
    expect(parsed.ok).toBe(false);
  });
});
