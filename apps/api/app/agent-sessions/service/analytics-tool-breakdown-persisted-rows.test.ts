/**
 * ISS-6912: the org-wide Tool Usage breakdown must fold the event rows that are
 * actually persisted.
 *
 * `20260526000000_normalize_agent_session_events` dropped the `events` JSON
 * column from `agent_sessions` and made it the `agent_session_events` relation.
 * The fold kept safe-parsing its input with the DESKTOP WIRE schema, whose
 * `createdAt` is an ISO string where the row carries a `DateTime`, so the
 * all-or-nothing `z.array(...)` fallback returned `[]` for every session and the
 * breakdown served a confident empty table to every organization.
 *
 * Nothing caught it because the shared fixture emitted the wire shape too. These
 * cases are therefore built on {@link buildPersistedEvent}, which is now pinned
 * to `AnalyticsSessionRecord["events"][number]` — the Prisma-derived row —
 * so a fixture that drifts from the database again fails `tsc` here rather than
 * quietly agreeing with a broken read.
 *
 * There is deliberately NO assertion here reconciling the fold against the stored
 * `agent_sessions.tool_use_count`. `analyticsSessionSelect` does not select that
 * column, so it is not an input to `aggregateByTool` and any such assertion would
 * compare the fold against a hand-written literal — green whatever either
 * producer does. The two also genuinely disagree today: the persist path counts
 * `event_type = 'tool_use' OR tool_name <> ''` while this fold skips every row
 * without a tool name, so a `tool_use` row carrying no tool name (the third case
 * below) is counted by one and not the other. That divergence is real and is
 * reported on ISS-6912; picking which rule is right is not this fix's call.
 */
import { describe, expect, it } from "vitest";
import {
  buildAnalyticsSessionRecord,
  buildPersistedEvent,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import { aggregateByTool } from "./analytics-aggregation";

function sessionOneRows() {
  return [
    buildPersistedEvent({ externalEventId: "e1", toolName: "Read" }),
    buildPersistedEvent({
      externalEventId: "e2",
      toolName: "Read",
      eventType: "tool_failure",
    }),
    buildPersistedEvent({ externalEventId: "e3", toolName: "Bash" }),
  ];
}

describe("aggregateByTool over persisted event rows", () => {
  it("folds persisted event rows into the tool breakdown instead of collapsing to an empty population", () => {
    const breakdown = aggregateByTool([
      buildAnalyticsSessionRecord(1, { events: sessionOneRows() }),
      buildAnalyticsSessionRecord(2, {
        events: [buildPersistedEvent({ externalEventId: "e4" })],
      }),
    ]);

    // Every number is distinct from its neighbours so a transposed pair fails:
    // Read is 3 invocations / 1 error / 2 sessions, Bash is 1 / 0 / 1.
    expect(breakdown).toEqual([
      {
        toolName: "Read",
        invocationCount: 3,
        errorCount: 1,
        sessionCount: 2,
      },
      {
        toolName: "Bash",
        invocationCount: 1,
        errorCount: 0,
        sessionCount: 1,
      },
    ]);
  });

  it("excludes rows carrying no tool name without inventing a phantom entry", () => {
    const breakdown = aggregateByTool([
      buildAnalyticsSessionRecord(1, {
        events: [
          buildPersistedEvent({ externalEventId: "e1", toolName: "Read" }),
          // A lifecycle row: real, persisted, and simply not a tool call.
          buildPersistedEvent({
            externalEventId: "e2",
            toolName: null,
            eventType: "session_started",
          }),
          // ISS-5493 parity with the desktop fold: an empty tool name is not an
          // identity, so it is dropped rather than bucketed under "".
          buildPersistedEvent({ externalEventId: "e3", toolName: "" }),
        ],
      }),
      // A session that genuinely recorded nothing must stay absent, not become
      // an "unknown" bucket.
      buildAnalyticsSessionRecord(2, { events: [] }),
    ]);

    expect(breakdown).toEqual([
      {
        toolName: "Read",
        invocationCount: 1,
        errorCount: 0,
        sessionCount: 1,
      },
    ]);
  });

  it("does not let a non-tool error row inflate any tool error count", () => {
    const breakdown = aggregateByTool([
      buildAnalyticsSessionRecord(1, {
        events: [
          buildPersistedEvent({ externalEventId: "e1", toolName: "Read" }),
          buildPersistedEvent({ externalEventId: "e2", toolName: "Read" }),
          buildPersistedEvent({
            externalEventId: "e3",
            toolName: null,
            eventType: "session_error",
          }),
        ],
      }),
    ]);

    // Two invocations, zero errors: the session-level error row is classified
    // off the row's own `event_type`, and belongs to no tool.
    expect(breakdown).toEqual([
      {
        toolName: "Read",
        invocationCount: 2,
        errorCount: 0,
        sessionCount: 1,
      },
    ]);
  });
});
