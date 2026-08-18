/**
 * ISS-4586: the desktop sync wire contract accepts the optional `endsWithError`
 * boolean the desktop stamps at import, and round-trips it intact so the cloud
 * upsert can persist it into `SessionDetail.ends_with_error` (which the stale-
 * session reaper reads to declare an orphan ERROR vs INACTIVE). Also pins that
 * omission is preserved (older desktop builds send nothing → the parsed session
 * carries neither, so the upsert never nulls a stored value).
 *
 * DB-free: exercises only `parseDesktopAgentSessionsPayload` (the pure ingress
 * contract). The compile-time keys-covered guard in the schema module
 * (`endsWithErrorSyncKeyCovered`) is proven by `tsc`, not here — this test proves
 * the runtime round-trip, and that the plain (non-strict) session object does not
 * silently strip the field.
 */
import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import { describe, expect, it } from "vitest";
import { parseDesktopAgentSessionsPayload } from "./desktop-agent-sessions-schema";

const AGENT_SESSION_SYNC_SCHEMA_VERSION = 2 as const;

function buildPayload(sessionExtras: Record<string, unknown>): unknown {
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
        agents: [],
        events: [],
        tokenUsageByModel: [],
        ...sessionExtras,
      },
    ],
  };
}

describe("desktop sync schema — endsWithError (ISS-4586)", () => {
  it("round-trips true intact", () => {
    const parsed = parseDesktopAgentSessionsPayload(
      buildPayload({ endsWithError: true })
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.payload.sessions[0].endsWithError).toBe(true);
    }
  });

  it("round-trips false intact (a not-error terminal run)", () => {
    const parsed = parseDesktopAgentSessionsPayload(
      buildPayload({ endsWithError: false })
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.payload.sessions[0].endsWithError).toBe(false);
    }
  });

  it("carries an explicit null through", () => {
    const parsed = parseDesktopAgentSessionsPayload(
      buildPayload({ endsWithError: null })
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.payload.sessions[0].endsWithError).toBeNull();
    }
  });

  it("preserves omission for an older desktop build that sends nothing", () => {
    const parsed = parseDesktopAgentSessionsPayload(buildPayload({}));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      // Absent (undefined), NOT null — so the cloud upsert leaves any stored
      // value untouched rather than clearing it.
      expect(parsed.payload.sessions[0].endsWithError).toBeUndefined();
    }
  });

  it("rejects a non-boolean endsWithError", () => {
    const parsed = parseDesktopAgentSessionsPayload(
      buildPayload({ endsWithError: "yes" })
    );
    expect(parsed.ok).toBe(false);
  });
});
