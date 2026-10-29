/**
 * `adaptAgentComponentSessions` is a pass-through: `DetailSessionsTab` applies
 * the only cap, and computes its truncation notice from the array handed IN,
 * not from what the adapter returned. So an adapter that filtered, capped,
 * reordered, or deduped would double-truncate the tab silently.
 *
 * The unknown-usage-vs-genuine-zero copy contract is owned at the render
 * boundary by `detail-sessions-tab-unknown-usage.test.tsx`, not restated here.
 */

import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { createAgentSessionListItemFixture } from "@repo/app/agents/components/sessions/session-list-fixtures";
import { makeComponent } from "@repo/app/agents/components/workspace/agent-component-fixtures";
import { describe, expect, it } from "vitest";
import { adaptAgentComponentSessions } from "../agent-component-session-adapter";

describe("adaptAgentComponentSessions — pass-through cardinality and order", () => {
  it.each([0, 1, 3])(
    "emits exactly one row per delivered session (%i)",
    (count) => {
      const sessions = Array.from({ length: count }, (_unused, index) =>
        createAgentSessionListItemFixture({
          id: `session-${index}`,
          name: `Session ${index}`,
        })
      );

      const rows = adaptAgentComponentSessions(COMPONENT, sessions);

      expect(rows.map((row) => row.id)).toEqual(
        sessions.map((session) => session.id)
      );
    }
  );

  it("keeps a session whose optional references are all absent", () => {
    // Records mid-sync are the ones most likely to dangle every reference; a
    // mapper that filtered on any of them would silently shrink the tab.
    const dangling = createAgentSessionListItemFixture({
      id: "dangling-session",
      name: null,
      project: null,
      repositoryFullName: null,
      sourceArtifact: null,
      sourceArtifactId: null,
      sourceLoopId: null,
    });

    const rows = adaptAgentComponentSessions(COMPONENT, [dangling]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("dangling-session");
    // The Name cell is painted from this; empty leaves an unidentifiable row.
    expect(rows[0]?.name).not.toBe("");
  });
});

describe("adaptAgentComponentSessions — row options reach the row mapper", () => {
  it("resolves a running session's Duration against the injected clock (ISS-4979)", () => {
    const sessions = [runningSession()];

    const early = adaptAgentComponentSessions(COMPONENT, sessions, {
      now: NOW_EARLY,
    });
    const late = adaptAgentComponentSessions(COMPONENT, sessions, {
      now: NOW_LATE,
    });

    // Dropping the third argument falls both back to the real wall clock, so
    // both print the same label — a running session's Duration frozen at mount.
    expect(early[0]?.durationLabel).not.toBe(late[0]?.durationLabel);
    expect(early[0]?.durationLabel).toBeTruthy();
    expect(late[0]?.durationLabel).toBeTruthy();
  });
});

const COMPONENT = makeComponent({
  id: "component-1",
  name: "Test component",
  sessions: 3,
});

// Still running, so Duration is measured against the injected clock rather
// than a stored end instant.
const RUNNING_STARTED_AT = new Date("2026-06-01T12:00:00.000Z");
const RUNNING_LAST_ACTIVITY_AT = new Date("2026-06-01T12:00:00.000Z");
const NOW_EARLY = new Date("2026-06-01T12:05:00.000Z");
const NOW_LATE = new Date("2026-06-01T12:47:00.000Z");

function runningSession(): AgentSessionListItem {
  return createAgentSessionListItemFixture({
    endedAt: null,
    id: "running-session",
    lastActivityAt: RUNNING_LAST_ACTIVITY_AT,
    name: "Still running",
    startedAt: RUNNING_STARTED_AT,
    status: SESSION_STATUS.ACTIVE,
    wallClock: null,
  });
}
