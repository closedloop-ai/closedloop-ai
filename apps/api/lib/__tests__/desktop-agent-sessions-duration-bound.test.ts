import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
} from "@repo/api/src/types/agent-session";
import { TRACE_DURATION_MAX_CHARS } from "@repo/api/src/utils/trace-duration";
import { describe, expect, it } from "vitest";
import { parseDesktopAgentSessionsPayload } from "../desktop-agent-sessions-schema";

/**
 * ISS-4675: the sync boundary's LENGTH BOUND on the three pre-formatted duration
 * fields (`wallClock`, `activeAgent`, `waitingUser`).
 *
 * Its own suite rather than another block in the 1,500-line handler test,
 * because it pins one narrow contract: these fields are bulk-read into the
 * 10,000-row `?sortBy=duration` candidate scan
 * (`app/agent-sessions/service/session-display-sort.ts`), so an unbounded value
 * is a read-path memory amplifier, not merely an unreadable one.
 */

const validPayload = {
  schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
  batchId: "7bf9fe88-9a77-471d-a0ce-2b14a7fd5f4a",
  syncMode: AgentSessionSyncMode.Incremental,
  sessionCount: 1,
  sessions: [
    {
      externalSessionId: "sess-1",
      name: "Session One",
      status: "active",
      harness: "claude",
      cwd: "/tmp/worktree",
      model: "claude-sonnet-4",
      startedAt: "2026-05-20T17:00:00.000Z",
      updatedAt: "2026-05-20T17:05:00.000Z",
      metadata: { source: "desktop" },
      attribution: {
        repositoryFullName: "closedloop-ai/symphony-alpha",
        worktreePath: null,
        sourceArtifactId: "artifact-1",
        sourceLoopId: null,
        baseBranch: null,
      },
      agents: [],
      events: [],
      tokenUsageByModel: [],
    },
  ],
};

function parseWithSessionFields(fields: Record<string, unknown>) {
  return parseDesktopAgentSessionsPayload({
    ...validPayload,
    sessions: [{ ...validPayload.sessions[0], ...fields }],
  });
}

describe("ISS-4675 duration-field ingest bound", () => {
  it("rejects an over-long duration string before it can be stored and bulk-read", () => {
    // The cap is checked BEFORE the trim transform, so the payload is rejected
    // rather than trimmed and stored.
    const overLong = "9".repeat(TRACE_DURATION_MAX_CHARS + 1);

    expect(parseWithSessionFields({ wallClock: overLong }).ok).toBe(false);
    expect(parseWithSessionFields({ activeAgent: overLong }).ok).toBe(false);
    expect(parseWithSessionFields({ waitingUser: overLong }).ok).toBe(false);
  });

  it("still accepts every duration value a real producer emits, including the legacy idle suffix", () => {
    // The bound must not clip a legitimate row. Version-skew safety also means
    // an UNREADABLE-but-short value is still accepted and stored — the readers
    // degrade to their own calendar fallback, the ingest boundary does not 400
    // the whole batch because one peer is on a newer build.
    const result = parseWithSessionFields({
      wallClock: "2d 4h",
      activeAgent: "4h 54m",
      waitingUser: "41s idle",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.sessions[0]).toMatchObject({
        wallClock: "2d 4h",
        activeAgent: "4h 54m",
        waitingUser: "41s idle",
      });
    }
  });

  it("keeps omission distinct from an explicit clear", () => {
    // The cloud patch preserves omitted trace fields, while an explicit `null`
    // (ISS-4569: the UNMEASURED component — a measured zero arrives as `"0s"`)
    // CLEARS a stale value. The bounded schema must not collapse those two.
    const cleared = parseWithSessionFields({ wallClock: null });

    expect(cleared.ok).toBe(true);
    if (cleared.ok) {
      expect(cleared.payload.sessions[0]).toMatchObject({ wallClock: null });
      expect(cleared.payload.sessions[0]).not.toHaveProperty("activeAgent");
    }
    // A blank string is not a measurement either — it normalizes to a clear.
    const blank = parseWithSessionFields({ wallClock: "  " });
    expect(blank.ok).toBe(true);
    if (blank.ok) {
      expect(blank.payload.sessions[0]).toMatchObject({ wallClock: null });
    }
  });
});
