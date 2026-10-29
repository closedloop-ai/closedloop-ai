/**
 * ISS-10721 review: one malformed optional rollup must not reject the batch it
 * rode in on.
 *
 * `parseDesktopAgentSessionsPayload` validates the WHOLE envelope, so a bound
 * that rejects rather than degrades takes up to `MAX_SESSIONS_PER_BATCH`
 * otherwise-valid sessions down with the one bad measure — and the desktop
 * retries the same poison value forever. Every bound on
 * `syncedSessionActivityMetricsSchema` therefore carries `.catch(null)`, which
 * maps an impossible value onto the "SENT and judged impossible" side of the
 * omitted-vs-sent distinction `persistSessionActivityMetrics` acts on, rather
 * than onto a parse failure.
 *
 * The omission half is asserted alongside it: `.catch()` must NOT materialize a
 * key the producer never sent, because that would collapse the same distinction
 * from the other direction and let a skewed producer erase measures it merely
 * stopped reporting.
 */
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
} from "@repo/api/src/types/agent-session";
import {
  MAX_ROLLUP_COUNT,
  MAX_TIER_SPEND_USD,
} from "@repo/api/src/types/session-activity-metrics-normalize";
import { describe, expect, it } from "vitest";
import { parseDesktopAgentSessionsPayload } from "@/lib/desktop-agent-sessions-schema";

const TEST_BATCH_ID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

function buildSession(id: string, activityMetrics?: unknown) {
  return {
    externalSessionId: id,
    status: "completed",
    harness: "claude",
    cwd: "/tmp",
    model: "claude-sonnet-4",
    startedAt: "2026-06-01T10:00:00.000Z",
    updatedAt: "2026-06-01T10:05:00.000Z",
    agents: [],
    events: [],
    tokenUsageByModel: [],
    ...(activityMetrics === undefined ? {} : { activityMetrics }),
  };
}

function parse(sessions: unknown[]) {
  return parseDesktopAgentSessionsPayload({
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: TEST_BATCH_ID,
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: sessions.length,
    sessions,
  });
}

describe("ISS-10721 activity-metrics ingest bounds degrade, never reject", () => {
  it.each([
    ["coverage above 1", { coverage: 1.01, segmentCount: 3 }, "coverage"],
    [
      "a tier past Decimal(14, 6)",
      { spendMediumConfUsd: MAX_TIER_SPEND_USD + 1, segmentCount: 3 },
      "spendMediumConfUsd",
    ],
    [
      "a count past int4",
      { segmentCount: MAX_ROLLUP_COUNT + 1, coverage: 0.5 },
      "segmentCount",
    ],
    [
      "a fractional count",
      { classifierVersion: 1.5, coverage: 0.5 },
      "classifierVersion",
    ],
  ])(
    "%s degrades that one measure and keeps every other session",
    (_name, activityMetrics, poisonedKey) => {
      const result = parse([
        buildSession("sess-good"),
        buildSession("sess-poison", activityMetrics),
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.payload.sessions).toHaveLength(2);
      const metrics = result.payload.sessions[1]?.activityMetrics;
      expect(metrics?.[poisonedKey as keyof typeof metrics]).toBeNull();
      // The sibling measure the same payload carried is untouched, so the
      // degrade is per-measure and not a blanket wipe of the rollup.
      const survivors = Object.entries(activityMetrics).filter(
        ([key]) => key !== poisonedKey
      );
      for (const [key, value] of survivors) {
        expect(metrics?.[key as keyof typeof metrics]).toBe(value);
      }
    }
  );

  it("does not materialize a key the producer omitted", () => {
    const result = parse([buildSession("sess-partial", { segmentCount: 3 })]);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const metrics = result.payload.sessions[0]?.activityMetrics;
    expect(metrics).toEqual({ segmentCount: 3 });
    expect(metrics).not.toHaveProperty("coverage");
    expect(metrics).not.toHaveProperty("autonomyBand");
  });

  it("carries an explicit null through as the retraction it is", () => {
    const result = parse([buildSession("sess-retract", null)]);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const session = result.payload.sessions[0];
    expect(session).toHaveProperty("activityMetrics");
    expect(session?.activityMetrics).toBeNull();
  });
});
