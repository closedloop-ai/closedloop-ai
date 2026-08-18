/**
 * FEA-4022 (PLN-1481): the desktop sync wire contract accepts the optional
 * `frustrationRaw` / `frustrationScoreVersion` fields the desktop computes, and
 * round-trips them intact so the cloud upsert can persist them. Also pins that
 * omission is preserved (older desktop builds send neither → the parsed session
 * carries neither, so the upsert never nulls a stored value) and that the raw
 * signal is bounded to the int4-safe ceiling so a pathological value can never
 * overflow the persisted column and reject the whole batch.
 *
 * DB-free: exercises only `parseDesktopAgentSessionsPayload` (the pure ingress
 * contract). The compile-time keys-covered guard in the schema module
 * (`frustrationSyncKeysCovered`) is proven by `tsc`, not here — this test proves
 * the runtime round-trip.
 */
import { FRUSTRATION_RAW_MAX } from "@repo/api/src/frustration-score-contract";
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

describe("desktop sync schema — frustration (FEA-4022)", () => {
  it("round-trips the raw signal + scorer version intact", () => {
    const parsed = parseDesktopAgentSessionsPayload(
      buildPayload({ frustrationRaw: 42, frustrationScoreVersion: 1 })
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.payload.sessions[0].frustrationRaw).toBe(42);
      expect(parsed.payload.sessions[0].frustrationScoreVersion).toBe(1);
    }
  });

  it("preserves omission for an older desktop build that sends neither field", () => {
    const parsed = parseDesktopAgentSessionsPayload(buildPayload({}));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      // Absent (undefined), NOT null — so the cloud upsert leaves any stored
      // value untouched rather than clearing it.
      expect(parsed.payload.sessions[0].frustrationRaw).toBeUndefined();
      expect(
        parsed.payload.sessions[0].frustrationScoreVersion
      ).toBeUndefined();
    }
  });

  it("accepts a raw signal saturated at the int4-safe ceiling", () => {
    const parsed = parseDesktopAgentSessionsPayload(
      buildPayload({
        frustrationRaw: FRUSTRATION_RAW_MAX,
        frustrationScoreVersion: 1,
      })
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.payload.sessions[0].frustrationRaw).toBe(
        FRUSTRATION_RAW_MAX
      );
    }
  });

  it("rejects a raw signal above the int4-safe ceiling", () => {
    const parsed = parseDesktopAgentSessionsPayload(
      buildPayload({
        frustrationRaw: FRUSTRATION_RAW_MAX + 1,
        frustrationScoreVersion: 1,
      })
    );
    expect(parsed.ok).toBe(false);
  });

  it("rejects a negative raw signal", () => {
    const parsed = parseDesktopAgentSessionsPayload(
      buildPayload({ frustrationRaw: -1, frustrationScoreVersion: 1 })
    );
    expect(parsed.ok).toBe(false);
  });
});
