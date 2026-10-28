/**
 * @file live-sync-harness-report.test.ts
 * @description ISS-9166 (PRD-707 FR4b) — unit coverage for the live harness's
 * verdict, `scripts/live-sync-harness-report.ts`.
 *
 * The decision is EXECUTED here against synthetic tallies, never asserted to
 * exist: every case below builds a report that differs from the clean one in
 * exactly one field and pins the sentence that difference produces, so deleting
 * any single predicate in `collectLiveSyncViolations` reddens exactly one case
 * and the clean case stays green.
 *
 * THE EXPECTED SENTENCES ARE WRITTEN OUT HERE, not imported from the module or
 * built by its own helpers. A fixture that rendered its expectation through the
 * formatter it polices would agree with any rewording of it, including one that
 * dropped the field path the synthetic-break rehearsal exists to read.
 */
import assert from "node:assert/strict";
import { SyncLane, SyncReason } from "@closedloop-ai/telemetry-contract/sync";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
  AgentComponentInvocationSyncAckState,
  AgentComponentInvocationSyncRejectReason,
} from "@repo/api/src/types/agent-component-invocation";
import { describe, test } from "vitest";
import {
  allHarnessLanesDrained,
  collectLiveSyncViolations,
  HARNESS_DRIVES_LANE,
  type LiveSyncHarnessReport,
  type LiveSyncObservations,
  observeGatewayLog,
  serverRejectionDetail,
  syncTickFailureMessage,
  tallySyncBatch,
} from "../scripts/live-sync-harness-report.js";
import {
  componentInventoryBatchEvent,
  invocationPartBatchEvent,
} from "../src/main/agent-sync/sync-lane-cloud-health.js";
import type { AgentComponentInvocationSyncClientResult } from "../src/main/dashboard/desktop-agent-component-invocations-client.js";
import { GatewayLogger } from "../src/main/logging/gateway-logger.js";
import {
  SyncLaneDrainState,
  SyncLaneId,
} from "../src/shared/sync-burndown-contract.js";

// Hoisted per ultracite's useTopLevelRegex.
const RE_NOT_DRAINED = /session lane did not drain within the 900000ms budget/;
const RE_REJECTED_FIELD_PATH =
  /server detail: session_invalid:sessions\[0\]\.events\[3\]\.tokenCount/;
const RE_REJECTED_NO_REASON = /the server sent no reason/;
const RE_DEAD_LETTERED =
  /3 row\(s\) were dead-lettered \(1 session\(s\), 1 component row\(s\), 1 invocation part\(s\)\)/;
const RE_SYNC_FAILED = /1 distinct sync failure\(s\): .*ECONNRESET/;
const RE_UNMEASURED = /cloud-side counts were not measured/;
const RE_SESSION_SHORTFALL =
  /cloud stored 41 session\(s\); the corpus holds 42/;
const RE_EVENT_SHORTFALL =
  /cloud stored 900 session event\(s\); the corpus holds 901/;
const RE_ELIDED = /\(\+2 more\)/;
const RE_ONE_BATCH_REJECTED = /1 batch\(es\) were rejected/;
const RE_REASON_VALIDATION_FAILED = /reasons: validation_failed/;
const RE_SESSION_SURPLUS = /cloud stored 43 session\(s\)/;
const RE_INVOCATION_LANE_DRAINING =
  /Lane invocation_parts did not finish: state draining, 412 item\(s\) still owed/;
const RE_INVOCATION_DEAD_LETTERS =
  /Lane invocation_parts did not finish: state drained_with_dead_letters/;
const RE_COMPONENT_UNMEASURED =
  /Lane component_inventory did not finish: state remaining_unknown, an unmeasured number of item\(s\) still owed/;
const RE_NO_BURNDOWN_SAMPLE = /No burn-down sample completed/;

/** A run in which everything went right. Every case below mutates one field. */
function cleanReport(): LiveSyncHarnessReport {
  return {
    sessionLaneDrained: true,
    durationMs: 61_000,
    budgetMs: 900_000,
    sessionsDelivered: 42,
    lanes: [
      {
        lane: SyncLane.SessionMetadata,
        accepted: 9,
        rejected: 0,
        deferred: 0,
        deadLettered: 0,
        reasons: [],
      },
      {
        lane: SyncLane.ComponentInventory,
        accepted: 3,
        rejected: 0,
        deferred: 0,
        deadLettered: 0,
        reasons: [],
      },
    ],
    deadLetters: { sessions: 0, components: 0, invocationParts: 0 },
    syncFailures: [],
    rejectedDetails: [],
    // The three lanes the harness drives, each at its own `drained` verdict.
    laneRemainders: [
      {
        lane: SyncLaneId.SessionMetadata,
        state: SyncLaneDrainState.Drained,
        itemsRemaining: 0,
      },
      {
        lane: SyncLaneId.InvocationParts,
        state: SyncLaneDrainState.Drained,
        itemsRemaining: 0,
      },
      {
        lane: SyncLaneId.ComponentInventory,
        state: SyncLaneDrainState.Drained,
        itemsRemaining: 0,
      },
    ],
    corpus: { sessions: 42, events: 901 },
    cloud: { sessions: 42, events: 901 },
  };
}

describe("collectLiveSyncViolations", () => {
  test("a fully drained run with matching counts reports nothing", () => {
    assert.deepEqual(collectLiveSyncViolations(cleanReport()), []);
  });

  test("an outbox still owing work when the budget expires is a violation", () => {
    const violations = collectLiveSyncViolations({
      ...cleanReport(),
      sessionLaneDrained: false,
      durationMs: 900_004,
    });

    assert.equal(violations.length, 1);
    assert.match(violations[0], RE_NOT_DRAINED);
  });

  test("a lane still draining is a violation even when the session lane is caught up", () => {
    // The whitlockk review case. `drained`/`sessionsDelivered` describe the SESSION
    // lane; a verdict keyed on those alone passes a run that stopped with the
    // invocation-parts queue still full, which is the one thing this harness
    // exists to catch.
    const report = cleanReport();
    const violations = collectLiveSyncViolations({
      ...report,
      laneRemainders: [
        report.laneRemainders[0],
        {
          lane: SyncLaneId.InvocationParts,
          state: SyncLaneDrainState.Draining,
          itemsRemaining: 412,
        },
        report.laneRemainders[2],
      ],
    });

    assert.equal(violations.length, 1);
    assert.match(violations[0], RE_INVOCATION_LANE_DRAINING);
  });

  test("a lane that gave up on the rest is not caught up", () => {
    // The falsifier for a predicate that only checked `itemsRemaining === 0`:
    // `drained_with_dead_letters` reports an EMPTY queue and abandoned rows.
    const report = cleanReport();
    const violations = collectLiveSyncViolations({
      ...report,
      laneRemainders: [
        report.laneRemainders[0],
        {
          lane: SyncLaneId.InvocationParts,
          state: SyncLaneDrainState.DrainedWithDeadLetters,
          itemsRemaining: 0,
        },
        report.laneRemainders[2],
      ],
    });

    assert.equal(violations.length, 1);
    assert.match(violations[0], RE_INVOCATION_DEAD_LETTERS);
  });

  test("a lane whose queue was never read reports unmeasured, never zero", () => {
    const report = cleanReport();
    const violations = collectLiveSyncViolations({
      ...report,
      laneRemainders: [
        report.laneRemainders[0],
        report.laneRemainders[1],
        {
          lane: SyncLaneId.ComponentInventory,
          state: SyncLaneDrainState.RemainingUnknown,
          itemsRemaining: null,
        },
      ],
    });

    assert.equal(violations.length, 1);
    assert.match(violations[0], RE_COMPONENT_UNMEASURED);
  });

  test("a run with no burn-down sample at all says so rather than passing", () => {
    // An empty list is "we never read the queues", and `every` over it is
    // vacuously true — the exact shape that turns an unread queue into a pass.
    const violations = collectLiveSyncViolations({
      ...cleanReport(),
      laneRemainders: [],
    });

    assert.equal(violations.length, 1);
    assert.match(violations[0], RE_NO_BURNDOWN_SAMPLE);
  });

  test("a rejected batch names the ISS-8005 field path the server refused", () => {
    const report = cleanReport();
    const violations = collectLiveSyncViolations({
      ...report,
      lanes: [
        {
          ...report.lanes[0],
          accepted: 8,
          rejected: 1,
          reasons: ["validation_failed"],
        },
        report.lanes[1],
      ],
      rejectedDetails: ["session_invalid:sessions[0].events[3].tokenCount"],
    });

    assert.equal(violations.length, 1);
    assert.match(violations[0], RE_ONE_BATCH_REJECTED);
    assert.match(violations[0], RE_REASON_VALIDATION_FAILED);
    // The load-bearing half: a red that reports only a count cannot be acted on,
    // and the synthetic-break rehearsal asserts this exact path reaches the log.
    assert.match(violations[0], RE_REJECTED_FIELD_PATH);
  });

  test("a rejection the server did not explain says so rather than reading as unexplained-but-fine", () => {
    const report = cleanReport();
    const violations = collectLiveSyncViolations({
      ...report,
      lanes: [
        { ...report.lanes[0], accepted: 8, rejected: 1, reasons: [] },
        report.lanes[1],
      ],
    });

    assert.equal(violations.length, 1);
    assert.match(violations[0], RE_REJECTED_NO_REASON);
  });

  test("many field paths are elided with a visible remainder, never silently truncated", () => {
    const report = cleanReport();
    const violations = collectLiveSyncViolations({
      ...report,
      lanes: [
        { ...report.lanes[0], rejected: 7, reasons: ["validation_failed"] },
        report.lanes[1],
      ],
      rejectedDetails: ["a", "b", "c", "d", "e", "f", "g"],
    });

    assert.equal(violations.length, 1);
    assert.match(violations[0], RE_ELIDED);
  });

  test("dead letters in any of the three lane families are a violation, counted apart", () => {
    const violations = collectLiveSyncViolations({
      ...cleanReport(),
      deadLetters: { sessions: 1, components: 1, invocationParts: 1 },
    });

    assert.equal(violations.length, 1);
    assert.match(violations[0], RE_DEAD_LETTERED);
  });

  test("a failed sync tick is a violation and the message carries the cause", () => {
    const violations = collectLiveSyncViolations({
      ...cleanReport(),
      syncFailures: ["sync failed: fetch failed (ECONNRESET)"],
    });

    assert.equal(violations.length, 1);
    assert.match(violations[0], RE_SYNC_FAILED);
  });

  test("an unmeasured cloud side is a violation, not a pass", () => {
    // The false-completeness guard: `cloud: null` is "we did not look", and a
    // run that did not look must not report the same green as one that looked
    // and found the corpus whole.
    const violations = collectLiveSyncViolations({
      ...cleanReport(),
      cloud: null,
    });

    assert.equal(violations.length, 1);
    assert.match(violations[0], RE_UNMEASURED);
  });

  test("a session shortfall in the cloud is a violation", () => {
    const violations = collectLiveSyncViolations({
      ...cleanReport(),
      cloud: { sessions: 41, events: 901 },
    });

    assert.equal(violations.length, 1);
    assert.match(violations[0], RE_SESSION_SHORTFALL);
  });

  test("an event shortfall is reported separately from the session count", () => {
    // Events and sessions fail independently: a lane that drops the tail of a
    // session's events delivers every session and still loses data, so one
    // combined check would report that run as whole.
    const violations = collectLiveSyncViolations({
      ...cleanReport(),
      cloud: { sessions: 42, events: 900 },
    });

    assert.equal(violations.length, 1);
    assert.match(violations[0], RE_EVENT_SHORTFALL);
  });

  test("a cloud holding MORE than the corpus is a violation too", () => {
    // Not symmetric politeness: a surplus means a prior run's rows survived the
    // teardown, which makes every equality below it meaningless.
    const violations = collectLiveSyncViolations({
      ...cleanReport(),
      cloud: { sessions: 43, events: 901 },
    });

    assert.equal(violations.length, 1);
    assert.match(violations[0], RE_SESSION_SURPLUS);
  });

  test("independent failures are all reported, not just the first", () => {
    const report = cleanReport();
    const violations = collectLiveSyncViolations({
      ...report,
      sessionLaneDrained: false,
      lanes: [
        { ...report.lanes[0], rejected: 2, reasons: ["validation_failed"] },
        report.lanes[1],
      ],
      deadLetters: { sessions: 3, components: 0, invocationParts: 0 },
      syncFailures: ["sync failed: boom"],
      laneRemainders: [
        report.laneRemainders[0],
        {
          lane: SyncLaneId.InvocationParts,
          state: SyncLaneDrainState.Draining,
          itemsRemaining: 412,
        },
        report.laneRemainders[2],
      ],
      cloud: { sessions: 0, events: 0 },
    });

    // drain + rejection + dead letters + one unfinished lane + tick failure +
    // two count mismatches.
    assert.equal(violations.length, 7);
  });
});

/**
 * The drain loop's break condition, driven directly.
 *
 * It is the half of the whitlockk review the verdict cannot cover on its own: the
 * verdict judges the report the loop already decided to write, so a loop that
 * broke out early with a full invocation queue would sample nothing after the
 * break and hand the verdict whatever it last saw.
 */
describe("allHarnessLanesDrained", () => {
  test("every driven lane at drained is the pass", () => {
    assert.equal(allHarnessLanesDrained(cleanReport().laneRemainders), true);
  });

  test("an empty sample is NOT a pass, though `every` over it is vacuously true", () => {
    assert.equal(allHarnessLanesDrained([]), false);
  });

  test("a sample missing one driven lane is not a pass either", () => {
    // A short sample is how an unread queue becomes invisible: the lanes that
    // DID report are all drained, and nothing in the list says one is absent.
    assert.equal(
      allHarnessLanesDrained(cleanReport().laneRemainders.slice(0, 2)),
      false
    );
  });

  test("a lane that drained onto dead letters does not qualify", () => {
    const remainders = cleanReport().laneRemainders;
    assert.equal(
      allHarnessLanesDrained([
        remainders[0],
        {
          lane: SyncLaneId.InvocationParts,
          state: SyncLaneDrainState.DrainedWithDeadLetters,
          itemsRemaining: 0,
        },
        remainders[2],
      ]),
      false
    );
  });

  test("the driven set names every lane, so a new one cannot be omitted silently", () => {
    // Pins the exhaustive-record shape: the three the harness starts are driven,
    // and the ones it deliberately does not start are excluded BY NAME rather
    // than by being absent from a list.
    assert.deepEqual(HARNESS_DRIVES_LANE, {
      [SyncLaneId.SessionMetadata]: true,
      [SyncLaneId.InvocationParts]: true,
      [SyncLaneId.ComponentInventory]: true,
      [SyncLaneId.TranscriptArchive]: false,
    });
  });
});

/**
 * The two gateway-log lines the driver folds into the report, driven against the
 * message text the DESKTOP actually writes.
 *
 * The fixtures below are transcribed from the producing call sites, NOT built by
 * the matchers they exercise: `agent-session-sync-validation-failure.ts` (the
 * `(server detail: …)` suffix `formatServerDetailSuffix` appends, and the
 * `session_invalid:<path>` ISS-8005 puts inside it) and
 * `agent-session-sync-tick-failure-log.ts` (the `sync failed:` warn, and the two
 * abandonment arms that deliberately log at DEBUG instead). A matcher tested
 * against a string this file invented would agree with any shape, including one
 * no lane emits — which is how a harness comes to report zero rejections on a
 * run that rejected everything.
 */
describe("the gateway-log extractors", () => {
  test("a per-session rejection yields the ISS-8005 detail, field path included", () => {
    const detail = serverRejectionDetail(
      "agent-session 8bbdbfab (backfill, ~12.4 KiB) rejected as validation_failed (server detail: session_invalid:sessions[0].events[12].createdAt); attributed to the row itself — terminal once the budget is spent"
    );

    assert.equal(detail, "session_invalid:sessions[0].events[12].createdAt");
  });

  test("a lane-wide deferral's detail is captured too, not only a per-row one", () => {
    // Same suffix, a different call site. Dropping this one would lose the
    // diagnostic on exactly the failures that stall the whole lane.
    assert.equal(
      serverRejectionDetail(
        "rejected as validation_failed (server detail: schema_version_invalid) — deferring the lane"
      ),
      "schema_version_invalid"
    );
  });

  test("an ordinary line carries no detail", () => {
    // The falsifier: without it every case above passes on a matcher that
    // returned the whole message.
    assert.equal(
      serverRejectionDetail("queued historical backfill for 35 agent sessions"),
      null
    );
  });

  test("a genuine failed tick is counted and the two abandonment arms are not", () => {
    assert.equal(
      syncTickFailureMessage({
        level: "warn",
        message: "sync failed: fetch failed",
      }),
      "sync failed: fetch failed"
    );
    // `LogLevel` has no "debug" member and `gatewayLog.debug()` writes at
    // "info" — an earlier version of this case passed `level: "debug"`, an
    // input no producer can emit, so it proved nothing about either arm. What
    // keeps the abandonment arms out is their MESSAGE.
    assert.equal(
      syncTickFailureMessage({
        level: "info",
        message:
          "sync abandoned: db-host shutting down (retries on next launch)",
      }),
      null
    );
    assert.equal(
      syncTickFailureMessage({
        level: "warn",
        message: "failed to clear 3 acked outbox row(s)",
      }),
      null
    );
  });
});

/**
 * The gateway-log observer, driven against the REAL `GatewayLogger`.
 *
 * `MAX_BUFFER_SIZE` is not exported and is deliberately not re-declared here:
 * these cases emit well past any plausible cap and assert that the LAST line
 * still lands, which is the property that matters and the one an index-diffing
 * cursor loses. A fixture that hard-coded 500 would silently stop covering the
 * defect the day that constant moved.
 */
describe("observeGatewayLog", () => {
  function freshObservations(): LiveSyncObservations {
    return { lanes: new Map(), syncFailures: [], rejectedDetails: [] };
  }

  test("a rejection past the ring buffer's cap is still observed", () => {
    // THE REGRESSION. `GatewayLogger` hands the callback its whole CAPPED
    // buffer on every append, so a cursor kept as an index pins at the cap and
    // slices to nothing forever after. That version reported zero rejections on
    // a run that rejected everything — the exact false green this harness exists
    // to prevent — and a 15-minute drain clears the cap easily.
    const logger = new GatewayLogger();
    const observations = freshObservations();
    observeGatewayLog(logger, observations);

    for (let i = 0; i < 2000; i += 1) {
      logger.info("agent-session-sync", `queued historical backfill ${i}`);
    }
    logger.info(
      "agent-session-sync",
      "agent-session s1 (backfill, ~1.0 KiB) rejected as validation_failed (server detail: session_invalid:sessions[0].events[7].createdAt); attributed to the row itself"
    );

    assert.deepEqual(observations.rejectedDetails, [
      "session_invalid:sessions[0].events[7].createdAt",
    ]);
  });

  test("a failed tick past the cap is still observed", () => {
    const logger = new GatewayLogger();
    const observations = freshObservations();
    observeGatewayLog(logger, observations);

    for (let i = 0; i < 2000; i += 1) {
      logger.info("agent-session-sync", `pass trace ${i}`);
    }
    logger.warn("agent-session-sync", "sync failed: fetch failed");

    assert.deepEqual(observations.syncFailures, ["sync failed: fetch failed"]);
  });

  test("an identical failure repeated every tick is recorded once", () => {
    // Not a choice this module makes: `GatewayLogger.log` drops an entry whose
    // level:tag:message equals the previous one, so the list is distinct
    // failures however it is built. The verdict keys on non-empty, never on the
    // count, and its sentence says "distinct" for this reason.
    const logger = new GatewayLogger();
    const observations = freshObservations();
    observeGatewayLog(logger, observations);

    for (let i = 0; i < 5; i += 1) {
      logger.warn("agent-session-sync", "sync failed: fetch failed");
    }

    assert.equal(observations.syncFailures.length, 1);
  });

  test("unsubscribing stops the observer, so a shutdown line cannot reach a written report", () => {
    const logger = new GatewayLogger();
    const observations = freshObservations();
    const stop = observeGatewayLog(logger, observations);

    stop();
    logger.warn("agent-session-sync", "sync failed: too late");

    assert.deepEqual(observations.syncFailures, []);
  });

  test("clearing the log records nothing and keeps what was observed", () => {
    // `GatewayLogger.clear()` notifies with an empty array.
    const logger = new GatewayLogger();
    const observations = freshObservations();
    observeGatewayLog(logger, observations);
    logger.warn("agent-session-sync", "sync failed: fetch failed");

    logger.clear();

    assert.deepEqual(observations.syncFailures, ["sync failed: fetch failed"]);
    assert.deepEqual(observations.rejectedDetails, []);
  });

  test("an ordinary line adds nothing", () => {
    // The falsifier: without it the cases above pass on an observer that
    // recorded every line it saw.
    const logger = new GatewayLogger();
    const observations = freshObservations();
    observeGatewayLog(logger, observations);

    logger.info(
      "agent-session-sync",
      "queued historical backfill for 35 agent sessions"
    );

    assert.deepEqual(observations.syncFailures, []);
    assert.deepEqual(observations.rejectedDetails, []);
  });
});

/**
 * ISS-10912: the fold from the production batch events into the report, driven
 * with the events the invocation lane's own mapper emits.
 */
describe("tallySyncBatch", () => {
  function foldInvocationAcks(
    observations: LiveSyncObservations,
    count: number,
    ack: AgentComponentInvocationSyncClientResult
  ): void {
    for (let sent = 0; sent < count; sent += 1) {
      tallySyncBatch(observations, invocationPartBatchEvent(ack));
    }
  }

  function freshObservations(): LiveSyncObservations {
    return { lanes: new Map(), syncFailures: [], rejectedDetails: [] };
  }

  function withInvocationLane(
    observations: LiveSyncObservations
  ): LiveSyncHarnessReport {
    const report = cleanReport();
    return {
      ...report,
      lanes: [...report.lanes, ...observations.lanes.values()],
    };
  }

  test("the 2026-09-27 cut's drain, 29 session_missing retries then 40 accepted parts, passes", () => {
    const observations = freshObservations();
    foldInvocationAcks(
      observations,
      29,
      invocationAck(AgentComponentInvocationSyncRejectReason.SessionMissing)
    );
    foldInvocationAcks(observations, 40, invocationAck(null));

    assert.deepEqual(
      collectLiveSyncViolations(withInvocationLane(observations)),
      []
    );
    assert.deepEqual(observations.lanes.get(SyncLane.InvocationParts), {
      lane: SyncLane.InvocationParts,
      accepted: 40,
      rejected: 0,
      deferred: 29,
      deadLettered: 0,
      reasons: [],
    });
  });

  test("a retried part that never lands still fails the run, naming session_missing", () => {
    const observations = freshObservations();
    foldInvocationAcks(
      observations,
      3,
      invocationAck(AgentComponentInvocationSyncRejectReason.SessionMissing)
    );
    const report = withInvocationLane(observations);
    const invocationLane = (
      state: SyncLaneDrainState,
      itemsRemaining: number
    ) => [
      report.laneRemainders[0],
      { lane: SyncLaneId.InvocationParts, state, itemsRemaining },
      report.laneRemainders[2],
    ];

    assert.deepEqual(
      collectLiveSyncViolations({
        ...report,
        laneRemainders: invocationLane(SyncLaneDrainState.Draining, 1),
      }),
      [
        "Lane invocation_parts did not finish: state draining, 1 item(s) still owed; 3 send(s) deferred — reason: session_missing.",
      ]
    );
    assert.deepEqual(
      collectLiveSyncViolations({
        ...report,
        deadLetters: { sessions: 0, components: 0, invocationParts: 1 },
        laneRemainders: invocationLane(
          SyncLaneDrainState.DrainedWithDeadLetters,
          0
        ),
      }),
      [
        "1 row(s) were dead-lettered (0 session(s), 0 component row(s), 1 invocation part(s)).",
        "Lane invocation_parts did not finish: state drained_with_dead_letters, 0 item(s) still owed; 3 send(s) deferred — reason: session_missing.",
      ]
    );
    // The deferrals belong to the invocation lane, so another undrained lane,
    // and the invocation lane with none, carry no reason.
    assert.deepEqual(
      collectLiveSyncViolations({
        ...report,
        laneRemainders: [
          report.laneRemainders[0],
          report.laneRemainders[1],
          {
            lane: SyncLaneId.ComponentInventory,
            state: SyncLaneDrainState.Draining,
            itemsRemaining: 2,
          },
        ],
      }),
      [
        "Lane component_inventory did not finish: state draining, 2 item(s) still owed.",
      ]
    );
    assert.deepEqual(
      collectLiveSyncViolations({
        ...cleanReport(),
        laneRemainders: invocationLane(SyncLaneDrainState.Draining, 1),
      }),
      [
        "Lane invocation_parts did not finish: state draining, 1 item(s) still owed.",
      ]
    );
  });

  test("session_missing on another lane, or any other invocation reason, is still a rejection", () => {
    const observations = freshObservations();
    tallySyncBatch(
      observations,
      componentInventoryBatchEvent({
        rejectedReason: SyncReason.SessionMissing,
      })
    );
    foldInvocationAcks(
      observations,
      1,
      invocationAck(AgentComponentInvocationSyncRejectReason.ValidationFailed)
    );

    assert.deepEqual(
      collectLiveSyncViolations(withInvocationLane(observations)),
      [
        "2 batch(es) were rejected — reasons: session_missing, validation_failed.",
      ]
    );
  });
});

/** One invocation-part ack: accepted when `reason` is null, else rejected with it. */
function invocationAck(
  reason: AgentComponentInvocationSyncRejectReason | null
): AgentComponentInvocationSyncClientResult {
  const identity = {
    protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
    externalGenerationId: "generation-1",
    partIndex: 0,
    partHash: "hash-1",
  };
  if (reason === null) {
    return {
      kind: "ack",
      ack: {
        ...identity,
        accepted: true,
        state: AgentComponentInvocationSyncAckState.Activated,
      },
    };
  }
  return { kind: "ack", ack: { ...identity, accepted: false, reason } };
}
