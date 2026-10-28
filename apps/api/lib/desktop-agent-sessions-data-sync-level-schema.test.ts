import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
} from "@repo/api/src/types/agent-session";
import {
  DATA_SYNC_LEVELS,
  DataSyncLevel,
} from "@repo/api/src/types/data-sync-level";
import { describe, expect, it } from "vitest";
import { parseDesktopAgentSessionsPayload } from "./desktop-agent-sessions-schema";

/**
 * ISS-7516 — the batch-level `dataSyncLevel` must SURVIVE the ingest boundary.
 *
 * This schema is deliberately non-strict, which makes the failure mode here
 * silent rather than loud: an undeclared field is STRIPPED before persistence
 * with no rejection and no log, so the desktop keeps sending a level, the column
 * stays NULL forever, and the web transcript panel keeps telling a
 * transcript-excluding machine's reader that an upload is on its way. Nothing in
 * the producer's own tests crosses this boundary, so nothing else catches it.
 * `dataSyncLevelKeyCovered` is the compile-time half; this is the behavioural
 * half, and it asserts the parsed VALUE rather than merely that the parse
 * succeeded — a stripped field parses fine.
 */

function basePayload(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: "5c2f0e5a-3c1e-4a4b-9f4e-0c9d1b7a2e31",
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: 0,
    sessions: [],
    ...overrides,
  };
}

describe("ISS-7516 batch dataSyncLevel (additive + skew-safe)", () => {
  it.each(DATA_SYNC_LEVELS)(
    "preserves the level %s through the boundary instead of stripping it",
    (level) => {
      const result = parseDesktopAgentSessionsPayload(
        basePayload({ dataSyncLevel: level })
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        // The load-bearing assertion. `result.ok` alone would stay true for a
        // schema that never declared the key at all.
        expect(result.payload.dataSyncLevel).toBe(level);
      }
    }
  );

  it("accepts a batch that omits the level, and reports it as absent", () => {
    // Skew direction: a desktop build that predates the field. It must parse,
    // and the absence must survive AS an absence — not as a default level,
    // which the read side would then serve as a verdict.
    const result = parseDesktopAgentSessionsPayload(basePayload());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.dataSyncLevel).toBeUndefined();
    }
  });

  it("rejects a level outside the contract", () => {
    // Defense in depth on a trusted-sender boundary: a partial or tampered
    // renderer must not be able to persist a value the read-side narrowing
    // would then have to discard.
    const result = parseDesktopAgentSessionsPayload(
      basePayload({ dataSyncLevel: "transcripts-only" })
    );

    expect(result.ok).toBe(false);
  });

  it("does not accept the legacy observability-tier spelling", () => {
    // `local` is a `SyncObservabilityTier` value, not a `DataSyncLevel` one (it
    // maps to `off`). Accepting it here would let two vocabularies into one
    // column and make `toDataSyncLevel` silently drop rows on read.
    const result = parseDesktopAgentSessionsPayload(
      basePayload({ dataSyncLevel: "local" })
    );

    expect(result.ok).toBe(false);
    // The positive sibling, proving the rejection above is about THIS value and
    // not a broken fixture.
    expect(
      parseDesktopAgentSessionsPayload(
        basePayload({ dataSyncLevel: DataSyncLevel.Off })
      ).ok
    ).toBe(true);
  });
});
