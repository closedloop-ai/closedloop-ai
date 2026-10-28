import assert from "node:assert/strict";
import { encodeBranchId } from "@repo/api/src/types/branch.js";
import {
  BranchTraceCompletenessState,
  BranchTraceSessionHydrationState,
  BranchTraceUnavailableReason,
  normalizeBranchTraceResult,
} from "@repo/api/src/types/branch-trace.js";
import { describe, test } from "vitest";
import { getSharedBranchTrace } from "../src/main/branch/shared-branch-trace.js";
// Imported rather than re-typed: the reporter owns this name, so a rename moves
// the producer and this assertion together instead of leaving the test green
// against a category nothing emits.
import {
  BRANCH_TRACE_ITEMS_UNREADABLE_CATEGORY,
  resetBranchTraceItemsUnreadableReport,
} from "../src/main/telemetry/branch-trace-unreadable-items-telemetry.js";
import { Observability } from "../src/main/telemetry/observability.js";
import { setTelemetryDeliverable } from "../src/main/telemetry/telemetry-delivery-readiness.js";
import {
  link,
  makeSource,
  syncedSession,
} from "./shared-branches-test-helpers.js";

const branchId = encodeBranchId({
  repoFullName: "acme/web",
  branchName: "feature/x",
});
const PRIVATE_IPC_DETAIL_RE = /private IPC detail/;

/** One tool call, as the local sync lane persists it. */
function toolEvent(
  externalEventId: string,
  toolName: string,
  createdAt: string
) {
  return {
    externalEventId,
    eventType: "tool_call",
    toolName,
    createdAt,
  };
}

describe("getSharedBranchTrace", () => {
  test("synthesizes one ordered session start per Session and an idle gap", async () => {
    const source = makeSource({
      links: [link({ session_id: "s1" }), link({ session_id: "s2" })],
      sessions: [
        syncedSession({
          externalSessionId: "s1",
          startedAt: "2026-06-10T10:00:00.000Z",
        }),
        syncedSession({
          externalSessionId: "s2",
          startedAt: "2026-06-10T12:00:00.000Z",
        }),
      ],
    });

    const result = await getSharedBranchTrace(source, branchId);
    const starts = result.items.filter((item) => item.type === "sessionstart");
    const idle = result.items.find((item) => item.type === "idle");

    assert.deepEqual(
      starts.map((item) => item.sessionId),
      ["s1", "s2"]
    );
    assert.ok(idle?.type === "idle" && idle.gapMs >= 120_000);
  });

  test("ISS-9723: keeps a Session's readable items when one item cannot be parsed", async () => {
    // The producer bug this ruling is about: a tool run whose LAST call carries
    // an unparseable stamp, so the projection's `endMs` folds to `NaN` and the
    // merged-trace contract refuses that item. It used to take the Session with
    // it.
    const source = makeSource({
      links: [link({ session_id: "s1" }), link({ session_id: "s2" })],
      sessions: [
        syncedSession({
          externalSessionId: "s1",
          startedAt: "2026-06-10T10:00:00.000Z",
          events: [
            toolEvent("e1", "read", "2026-06-10T10:00:05.000Z"),
            toolEvent("e2", "read", "not-a-timestamp"),
          ],
        }),
        syncedSession({
          externalSessionId: "s2",
          startedAt: "2026-06-10T12:00:00.000Z",
        }),
      ],
    });

    const result = await getSharedBranchTrace(source, branchId);
    const partial = result.sessions.find(
      (session) => session.identity.artifactId === "s1"
    );

    assert.equal(partial?.state, BranchTraceSessionHydrationState.Loaded);
    assert.equal(
      partial?.state === BranchTraceSessionHydrationState.Loaded
        ? partial.unreadableItemCount
        : null,
      1
    );
    // Its readable evidence survives, and the unparseable item is gone rather
    // than repaired into a plausible extent.
    assert.ok(
      result.items.some(
        (item) => item.type === "sessionstart" && item.sessionId === "s1"
      )
    );
    assert.ok(!result.items.some((item) => item.type === "tools"));
    assert.equal(
      result.aggregateCompleteness.state,
      BranchTraceCompletenessState.Incomplete
    );
  });

  test("ISS-9723: omits the drop count and stays complete when every item parses", async () => {
    const source = makeSource({
      links: [link({ session_id: "s1" })],
      sessions: [
        syncedSession({
          externalSessionId: "s1",
          startedAt: "2026-06-10T10:00:00.000Z",
          events: [toolEvent("e1", "read", "2026-06-10T10:00:05.000Z")],
        }),
      ],
    });

    const result = await getSharedBranchTrace(source, branchId);

    assert.ok(
      result.sessions.every(
        (session) =>
          session.state === BranchTraceSessionHydrationState.Loaded &&
          session.unreadableItemCount === undefined
      )
    );
    assert.equal(
      result.aggregateCompleteness.state,
      BranchTraceCompletenessState.Complete
    );
  });

  /**
   * ISS-9723 (#6884 review, codex): the drop must not be silent OFF this
   * machine. Driven through the real `Observability` emit path — the test's own
   * sink is the transport — rather than by asserting a mocked reporter was
   * called, so deleting the call site in `resultFromHydrations` reddens this.
   */
  test("ISS-9723: a dropped item reaches the monitored desktop diagnostic", async () => {
    const events = await captureTelemetry(() =>
      getSharedBranchTrace(sourceWithUnparseableToolStamp(), branchId)
    );

    assert.deepEqual(
      events.map((event) => event.category),
      [BRANCH_TRACE_ITEMS_UNREADABLE_CATEGORY],
      "one drop must raise exactly one monitored diagnostic"
    );
    assert.equal(
      events[0]?.severity,
      "error",
      "reported at error severity, the field a monitor queries"
    );
  });

  /**
   * The silence half, and the reason the arm above cannot be satisfied by a
   * reporter that fires on every read: a trace whose every item parses is the
   * overwhelmingly common case and must never page anyone.
   */
  test("ISS-9723: a trace that dropped nothing raises no diagnostic at all", async () => {
    const events = await captureTelemetry(() =>
      getSharedBranchTrace(
        makeSource({
          links: [link({ session_id: "s1" })],
          sessions: [
            syncedSession({
              externalSessionId: "s1",
              startedAt: "2026-06-10T10:00:00.000Z",
              events: [toolEvent("e1", "read", "2026-06-10T10:00:05.000Z")],
            }),
          ],
        }),
        branchId
      )
    );

    assert.deepEqual(events, [], "a clean read must emit nothing");
  });

  /**
   * Branch detail is a POLLED read path, so the cadence is the load-bearing half
   * of the reporter: without the latch, one corrupt Session bills a line per
   * navigation for as long as the window stays open.
   */
  test("ISS-9723: repeated reads of one corrupt branch raise one alert, not one each", async () => {
    const events = await captureTelemetry(async () => {
      await getSharedBranchTrace(sourceWithUnparseableToolStamp(), branchId);
      await getSharedBranchTrace(sourceWithUnparseableToolStamp(), branchId);
    }, true);

    assert.deepEqual(
      events.map((event) => event.category),
      [BRANCH_TRACE_ITEMS_UNREADABLE_CATEGORY],
      "two corrupt reads in one process must raise one alert"
    );
  });

  test("returns honest empty evidence for missing sources and unmatched branches", async () => {
    const missing = await getSharedBranchTrace(null, branchId);
    const empty = await getSharedBranchTrace(makeSource({}), branchId);
    const unmatched = await getSharedBranchTrace(
      makeSource({ links: [link({ branch_name: "other" })] }),
      branchId
    );

    assert.equal(missing.qualifyingSessionCount, null);
    assert.deepEqual(empty.items, []);
    assert.deepEqual(unmatched.items, []);
  });

  test("enumerates 0, 1, 30, 31, and many Sessions through one cache-preserving db-host call", async () => {
    for (const count of [0, 1, 30, 31, 125]) {
      const ids = Array.from(
        { length: count },
        (_, index) => `session-${String(index).padStart(3, "0")}`
      );
      const requestSizes: number[] = [];
      const source = makeSource({
        links: ids.map((sessionId, index) =>
          link({
            session_id: sessionId,
            observed_at: new Date(
              Date.UTC(2026, 5, 10, 10, 0, index)
            ).toISOString(),
          })
        ),
        sessions: ids.map((externalSessionId) =>
          syncedSession({ externalSessionId })
        ),
      });
      const originalLoader = source.syncSource?.loadSyncedSessions;
      assert.ok(originalLoader);
      source.syncSource = {
        ...source.syncSource,
        loadSyncedSessions: (...args) => {
          requestSizes.push(args[0].length);
          return originalLoader(...args);
        },
      };

      const result = await getSharedBranchTrace(source, branchId);

      assert.equal(result.qualifyingSessionCount, count);
      assert.equal(result.sessions.length, count);
      assert.equal(
        result.completeness.state,
        BranchTraceCompletenessState.Complete
      );
      assert.deepEqual(requestSizes, [count]);
    }
  });

  test("dedupes identities, tie-breaks by id, and ignores loader return order", async () => {
    const source = makeSource({
      links: [
        link({ session_id: "s2" }),
        link({ session_id: "s1" }),
        link({ session_id: "s1" }),
      ],
      sessions: [
        syncedSession({ externalSessionId: "s1" }),
        syncedSession({ externalSessionId: "s2" }),
      ],
    });
    const originalLoader = source.syncSource?.loadSyncedSessions;
    assert.ok(originalLoader);
    source.syncSource = {
      ...source.syncSource,
      loadSyncedSessions: async (...args) =>
        (await originalLoader(...args)).toReversed(),
    };

    const result = await getSharedBranchTrace(source, branchId);

    assert.deepEqual(
      result.sessions.map(({ identity }) => identity.artifactId),
      ["s1", "s2"]
    );
    assert.equal(result.qualifyingSessionCount, 2);
  });

  test("retains missing, malformed, and cancelled identities with typed provenance", async () => {
    const ids = ["s1", "s2", "s3", "s4", "s5"];
    const source = makeSource({
      links: ids.map((sessionId) => link({ session_id: sessionId })),
    });
    source.syncSource = {
      ...source.syncSource,
      loadSyncedSessions: () =>
        Promise.resolve([
          syncedSession({ externalSessionId: "s1" }),
          syncedSession({ externalSessionId: "s4", startedAt: "malformed" }),
        ]),
    };

    const result = await getSharedBranchTrace(source, branchId);
    const reasonById = new Map(
      result.sessions.map((session) => [
        session.identity.artifactId,
        session.state === BranchTraceSessionHydrationState.Unavailable
          ? session.reason
          : null,
      ])
    );

    assert.equal(reasonById.get("s1"), null);
    assert.equal(reasonById.get("s2"), BranchTraceUnavailableReason.NotFound);
    assert.equal(reasonById.get("s3"), BranchTraceUnavailableReason.NotFound);
    assert.equal(reasonById.get("s4"), BranchTraceUnavailableReason.Malformed);
    assert.equal(reasonById.get("s5"), BranchTraceUnavailableReason.NotFound);
    assert.equal(
      result.aggregateCompleteness.state,
      BranchTraceCompletenessState.Incomplete
    );
  });

  test("classifies a rejected db-host hydration call for every retained identity", async () => {
    const source = makeSource({
      links: [link({ session_id: "s1" }), link({ session_id: "s2" })],
    });
    source.syncSource = {
      ...source.syncSource,
      loadSyncedSessions: () =>
        Promise.reject(
          Object.assign(new Error("cancelled"), { name: "AbortError" })
        ),
    };

    const result = await getSharedBranchTrace(source, branchId);

    assert.deepEqual(
      result.sessions.map((session) =>
        session.state === BranchTraceSessionHydrationState.Unavailable
          ? session.reason
          : null
      ),
      [
        BranchTraceUnavailableReason.Cancelled,
        BranchTraceUnavailableReason.Cancelled,
      ]
    );
  });

  test("status evidence wins over AbortError and database failures are unknown", async () => {
    const source = makeSource({ links: [link({ session_id: "s1" })] });
    source.syncSource = {
      ...source.syncSource,
      loadSyncedSessions: () =>
        Promise.reject({ name: "AbortError", status: 401 }),
    };
    const authentication = await getSharedBranchTrace(source, branchId);
    const readFailureSource = makeSource({});
    readFailureSource.prisma.client.sessionArtifactLink.findMany = () =>
      Promise.reject(new Error("database unavailable"));
    const readFailure = await getSharedBranchTrace(readFailureSource, branchId);

    assert.equal(
      authentication.sessions[0]?.state ===
        BranchTraceSessionHydrationState.Unavailable
        ? authentication.sessions[0].reason
        : null,
      BranchTraceUnavailableReason.Authentication
    );
    assert.equal(
      readFailure.completeness.reason,
      BranchTraceUnavailableReason.Unknown
    );
  });

  test("the structured-clone IPC envelope normalizes additively without leaking raw fields", async () => {
    const source = makeSource({
      links: [link({ session_id: "s1" })],
      sessions: [syncedSession({ externalSessionId: "s1" })],
    });
    const produced = await getSharedBranchTrace(source, branchId);
    const cloned = structuredClone({
      ...produced,
      futureEnvelopeField: true,
      items: produced.items.map((item) => ({
        ...item,
        rawError: "private IPC detail",
      })),
    });

    const normalized = normalizeBranchTraceResult(cloned);

    assert.equal(normalized.qualifyingSessionCount, 1);
    assert.equal(
      normalized.sessions[0]?.state,
      BranchTraceSessionHydrationState.Loaded
    );
    assert.doesNotMatch(JSON.stringify(normalized), PRIVATE_IPC_DETAIL_RE);
  });
});

/**
 * The producer defect ISS-9723 is about: a tool run whose LAST call carries an
 * unparseable stamp, so the projection's `endMs` folds to `NaN` and the
 * merged-trace contract refuses that one item while the Session survives.
 *
 * A factory rather than a shared constant because `makeSource` is stateful per
 * read, and the latch case needs two independent reads of the same defect.
 */
function sourceWithUnparseableToolStamp(): ReturnType<typeof makeSource> {
  return makeSource({
    links: [link({ session_id: "s1" })],
    sessions: [
      syncedSession({
        externalSessionId: "s1",
        startedAt: "2026-06-10T10:00:00.000Z",
        events: [
          toolEvent("e1", "read", "2026-06-10T10:00:05.000Z"),
          toolEvent("e2", "read", "not-a-timestamp"),
        ],
      }),
    ],
  });
}

/**
 * Run `body` with the desktop telemetry transport pointed at a local array, and
 * return every event it emitted.
 *
 * `deliverable` is the lane's send gate, held CLOSED by default so the
 * reporter's once-per-process latch never sets and each case stays independent
 * — the emit itself happens either way, because the latch is gated on
 * acceptance and not on the attempt. The explicit reset covers the one case that
 * opens the gate on purpose.
 */
async function captureTelemetry(
  body: () => Promise<unknown>,
  deliverable = false
): Promise<Array<{ category: string; severity: string }>> {
  const events: Array<{ category: string; severity: string }> = [];
  resetBranchTraceItemsUnreadableReport();
  Observability.init({
    telemetrySend: (event) =>
      events.push({ category: event.category, severity: event.severity }),
  });
  setTelemetryDeliverable(() => deliverable);
  try {
    await body();
  } finally {
    setTelemetryDeliverable(null);
    Observability.initNoOp();
    resetBranchTraceItemsUnreadableReport();
  }
  return events;
}
