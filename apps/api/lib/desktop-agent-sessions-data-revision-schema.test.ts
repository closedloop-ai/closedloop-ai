/**
 * FEA-3595: `dataRevision` is bounded on the sync wire.
 *
 * Revision gating is forward-only (`chunk-revision-gating.ts`): a payload below
 * a session's committed/pending high-water mark is rejected as stale. That makes
 * the accepted revision an effectively IRREVERSIBLE, client-supplied high-water
 * mark — so an unbounded field is a per-session denial of service. One payload
 * carrying Postgres `Int` max commits, and from then on every genuine repair
 * from a real desktop is stale forever while the next integer cannot even be
 * stored. Bounding it at `MAX_SUPPORTED_DATA_REVISION` keeps the poison values
 * out at the ingress instead.
 *
 * DB-free: exercises only `parseDesktopAgentSessionsPayload` (the pure ingress
 * contract).
 */
import {
  AgentSessionSyncMode,
  MAX_SUPPORTED_DATA_REVISION,
} from "@repo/api/src/types/agent-session";
import { describe, expect, it } from "vitest";
import { parseDesktopAgentSessionsPayload } from "./desktop-agent-sessions-schema";

const AGENT_SESSION_SYNC_SCHEMA_VERSION = 2 as const;

/** Postgres `int4` max — the value that permanently strands a session. */
const POSTGRES_INT_MAX = 2_147_483_647;

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

describe("desktop sync schema — dataRevision bound (FEA-3595)", () => {
  it("round-trips a real desktop revision intact", () => {
    const parsed = parseDesktopAgentSessionsPayload(
      buildPayload({ dataRevision: 50 })
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.payload.sessions[0].dataRevision).toBe(50);
    }
  });

  it("preserves omission for an older desktop build that sends no revision", () => {
    const parsed = parseDesktopAgentSessionsPayload(buildPayload({}));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      // Absent (undefined), NOT null — the upsert must leave any stored value
      // untouched rather than clearing it.
      expect(parsed.payload.sessions[0].dataRevision).toBeUndefined();
    }
  });

  it("accepts a revision exactly at the supported ceiling", () => {
    const parsed = parseDesktopAgentSessionsPayload(
      buildPayload({ dataRevision: MAX_SUPPORTED_DATA_REVISION })
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.payload.sessions[0].dataRevision).toBe(
        MAX_SUPPORTED_DATA_REVISION
      );
    }
  });

  it("rejects a revision above the supported ceiling", () => {
    const parsed = parseDesktopAgentSessionsPayload(
      buildPayload({ dataRevision: MAX_SUPPORTED_DATA_REVISION + 1 })
    );
    expect(parsed.ok).toBe(false);
  });

  it("rejects the int4-max poison value that would permanently strand the session", () => {
    const parsed = parseDesktopAgentSessionsPayload(
      buildPayload({ dataRevision: POSTGRES_INT_MAX })
    );
    expect(parsed.ok).toBe(false);
  });

  it("keeps the ceiling clear of any reachable real revision", () => {
    // Guards the headroom claim in MAX_SUPPORTED_DATA_REVISION's doc: the bound
    // must stay far above the live desktop DATA_REVISION, so a legitimate bump
    // can never be silently rejected as poison.
    expect(MAX_SUPPORTED_DATA_REVISION).toBeGreaterThan(1000);
    expect(MAX_SUPPORTED_DATA_REVISION).toBeLessThan(POSTGRES_INT_MAX);
  });

  it("still rejects a non-positive revision", () => {
    const parsed = parseDesktopAgentSessionsPayload(
      buildPayload({ dataRevision: 0 })
    );
    expect(parsed.ok).toBe(false);
  });
});
