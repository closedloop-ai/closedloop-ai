/**
 * ISS-12251 (PLN-2176 T-6.7): the desktop sync wire contract carries the
 * session's `createdAt`. DB-free — the ingress contract only, in both
 * version-skew directions: an OLDER desktop omits the field and claims nothing,
 * and a NEWER desktop's payload is not rejected by a cloud that predates the
 * field (modelled as this schema without the key, which strips it). A value
 * that does not parse is kept as text for the ingest to drop, never a batch
 * rejection. The write is proven against Postgres in
 * `app/agent-sessions/service/session-ingest-created-at.integration.test.ts`.
 */
import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import { describe, expect, it } from "vitest";
import {
  parseDesktopAgentSessionsPayload,
  syncedAgentSessionSchema,
} from "./desktop-agent-sessions-schema";

const SCHEMA_VERSION = 2 as const;
const CREATED_AT = "2026-09-22T09:00:00.000Z";

function buildSession(
  extras: Record<string, unknown>
): Record<string, unknown> {
  return {
    externalSessionId: "sess-1",
    name: "collector-derived",
    status: "active",
    startedAt: "2026-09-22T10:00:00.000Z",
    updatedAt: "2026-09-22T11:00:00.000Z",
    agents: [],
    events: [],
    tokenUsageByModel: [],
    ...extras,
  };
}

function parseSession(extras: Record<string, unknown>) {
  const parsed = parseDesktopAgentSessionsPayload({
    schemaVersion: SCHEMA_VERSION,
    batchId: "00000000-0000-4000-8000-000000000001",
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: 1,
    sessions: [buildSession(extras)],
  });
  if (!parsed.ok) {
    throw new Error(`payload rejected: ${parsed.reason}`);
  }
  const [session] = parsed.payload.sessions;
  if (!session) {
    throw new Error("expected one session");
  }
  return session;
}

describe("desktop sync schema — createdAt (ISS-12251)", () => {
  it("round-trips a desktop-sent createdAt", () => {
    expect(parseSession({ createdAt: CREATED_AT }).createdAt).toBe(CREATED_AT);
  });

  it("accepts an older desktop's payload, which omits it, and claims nothing", () => {
    expect(Object.hasOwn(parseSession({}), "createdAt")).toBe(false);
  });

  it("keeps a value that does not parse rather than rejecting the batch", () => {
    expect(parseSession({ createdAt: "not-a-timestamp" }).createdAt).toBe(
      "not-a-timestamp"
    );
  });

  it("lets a cloud that predates the field accept a newer desktop's session", () => {
    const predating = syncedAgentSessionSchema.omit({ createdAt: true });
    const parsed = predating.safeParse(buildSession({ createdAt: CREATED_AT }));
    expect(parsed.success).toBe(true);
    expect(parsed.success && "createdAt" in parsed.data).toBe(false);
  });
});
