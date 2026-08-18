import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  SyncPayloadEncoding,
} from "@repo/api/src/types/agent-session";
import { describe, expect, it } from "vitest";
import { parseDesktopAgentSessionsPayload } from "./desktop-agent-sessions-schema";

function basePayload(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: "7bf9fe88-9a77-471d-a0ce-2b14a7fd5f4a",
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: 0,
    sessions: [],
    ...overrides,
  };
}

describe("FEA-4138 batch encoding field (additive + skew-safe)", () => {
  // Skew direction: a legacy desktop that omits `encoding` still parses — the
  // field is optional, so the batch is accepted exactly as before.
  it("accepts a batch that omits encoding (legacy uncompressed)", () => {
    const result = parseDesktopAgentSessionsPayload(basePayload());
    expect(result.ok).toBe(true);
  });

  // Skew direction: a compression-aware desktop stamps `encoding: "gzip"` and
  // the batch still parses (the body was already decompressed at the route).
  it("accepts and preserves an explicit gzip encoding", () => {
    const result = parseDesktopAgentSessionsPayload(
      basePayload({ encoding: SyncPayloadEncoding.Gzip })
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.encoding).toBe(SyncPayloadEncoding.Gzip);
    }
  });

  it("accepts the identity encoding", () => {
    const result = parseDesktopAgentSessionsPayload(
      basePayload({ encoding: SyncPayloadEncoding.Identity })
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.encoding).toBe(SyncPayloadEncoding.Identity);
    }
  });

  it("rejects an unknown encoding value", () => {
    const result = parseDesktopAgentSessionsPayload(
      basePayload({ encoding: "brotli" })
    );
    expect(result.ok).toBe(false);
  });
});
