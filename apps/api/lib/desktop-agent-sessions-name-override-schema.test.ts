/**
 * ISS-8717: the desktop sync wire contract carries the owner-authored
 * `nameOverride` beside the collector-derived `name`.
 *
 * DB-free — this exercises only `parseDesktopAgentSessionsPayload`, the pure
 * ingress contract. What it pins is the VERSION-SKEW half of the acceptance:
 * an older desktop omits the field entirely and must still be accepted, and the
 * parsed session must not carry a value that the upsert would then write. The
 * survives-a-re-import half is proven against Postgres in
 * `app/agent-sessions/session-rename.integration.test.ts`.
 */
import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import { describe, expect, it } from "vitest";
import { parseDesktopAgentSessionsPayload } from "./desktop-agent-sessions-schema";

const SCHEMA_VERSION = 2 as const;
// The contract ceiling, spelled as a literal on purpose: importing the constant
// this schema is built from would make the bound assert itself.
const NAME_MAX_CHARS = 200;

function buildPayload(sessionExtras: Record<string, unknown>): unknown {
  return {
    schemaVersion: SCHEMA_VERSION,
    batchId: "00000000-0000-4000-8000-000000000001",
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: 1,
    sessions: [
      {
        externalSessionId: "sess-1",
        name: "collector-derived",
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

function parseSession(sessionExtras: Record<string, unknown>) {
  const parsed = parseDesktopAgentSessionsPayload(buildPayload(sessionExtras));
  if (!parsed.ok) {
    throw new Error(`payload rejected: ${parsed.reason}`);
  }
  return parsed.payload.sessions[0];
}

describe("desktop sync schema — nameOverride (ISS-8717)", () => {
  it("round-trips a desktop-authored override intact", () => {
    expect(parseSession({ nameOverride: "Ledger rewrite" }).nameOverride).toBe(
      "Ledger rewrite"
    );
  });

  it("PRESERVES the omission of an older desktop payload rather than nulling it", () => {
    const session = parseSession({});
    // Not `toBeNull`: manufacturing a null here would make an old client's
    // parsed payload differ from what it actually sent, which is the shape the
    // repo's cross-repo rule forbids.
    expect(session.nameOverride).toBeUndefined();
    // The collector's own name is untouched by the absence — the two channels
    // are independent, which is what lets one survive the other.
    expect(session.name).toBe("collector-derived");
  });

  it("treats an explicit null and a whitespace-only value as no override", () => {
    expect(parseSession({ nameOverride: null }).nameOverride).toBeNull();
    expect(parseSession({ nameOverride: "   " }).nameOverride).toBeNull();
  });

  it("truncates an over-long override instead of rejecting the whole session", () => {
    const session = parseSession({ nameOverride: "x".repeat(500) });
    expect(session.nameOverride).toBe("x".repeat(NAME_MAX_CHARS));
  });
});
