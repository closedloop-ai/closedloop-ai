/**
 * @file live-sync-harness-report.ts
 * @description ISS-9166 (PRD-707 FR4b) — the live harness's REPORT shape and the
 * verdict over it, kept apart from the driver that produces it.
 *
 * The split is the same one `rehearsal-verify-checks.ts` makes for the rebuild
 * rehearsal, and for the same reason: the driver needs a live store, a
 * containerized API and a drained outbox before it can say anything at all, so a
 * verdict living inside it is a decision no test can reach. Here the decision is
 * a pure function over a plain record, driven directly against synthetic tallies.
 *
 * WHY `cloud: null` IS A VIOLATION AND NOT A PASS. The harness's headline claim
 * is that everything the local store held reached the cloud, and the only
 * evidence for it is a cloud-side count. A run whose count step did not happen
 * has NOT proved that — it has proved nothing about it — and the difference
 * between "equal" and "unmeasured" is precisely the false-completeness class
 * AGENTS.md → Handling Bad or Nonsensical Data forbids collapsing. So the absent
 * measurement is reported as its own violation rather than skipped, and a broken
 * count step reds the lane instead of quietly widening what green means.
 */
import {
  SyncLane,
  SyncOutcome,
  SyncReason,
} from "@closedloop-ai/telemetry-contract/sync";
import type { DesktopSyncBatchEventInput } from "../src/main/telemetry/app-otel-runtime.js";
import {
  type SyncLaneDrainState,
  SyncLaneDrainState as SyncLaneDrainStateValues,
  SyncLaneId,
} from "../src/shared/sync-burndown-contract.js";

/**
 * Which lanes the live harness actually drives, and therefore which ones must
 * reach `drained` before a green verdict.
 *
 * An EXHAUSTIVE record rather than a list, so a new member of `SyncLaneId`
 * fails `tsc` here and has to be answered rather than silently omitted from the
 * completion check — the shape AGENTS.md → Review Lessons prescribes for a side
 * inventory over a closed union.
 *
 * The `false` rows are lanes the harness genuinely does not start: the
 * transcript archive is composed in the dashboard runtime it does not stand up
 * (`getTranscriptSync: () => null`). Holding a lane that
 * never ran to `drained` would red every run; reporting it as caught up would
 * be a lie. It is excluded and said so.
 */
export const HARNESS_DRIVES_LANE: Record<SyncLaneId, boolean> = {
  [SyncLaneId.SessionMetadata]: true,
  [SyncLaneId.InvocationParts]: true,
  [SyncLaneId.ComponentInventory]: true,
  [SyncLaneId.TranscriptArchive]: false,
};

/** How many lanes a complete sample must carry before it can be a pass. */
const HARNESS_LANE_COUNT =
  Object.values(HARNESS_DRIVES_LANE).filter(Boolean).length;

/** Sessions and their events, on one side of the wire. */
export type LiveSyncCounts = {
  sessions: number;
  events: number;
};

/**
 * The bucket a batch event with NO `sync.lane` attribute is tallied under.
 *
 * `DesktopSyncBatchEventInput.lane` is optional so a record from an older
 * desktop "degrades to unattributed rather than mis-attributing them to lane 1",
 * and the report needs somewhere to put one that says so. Deliberately not a
 * `SyncLane` member: it is the absence of a lane, and widening the closed set
 * would let it be written as one.
 */
export const UNATTRIBUTED_LANE = "unattributed" as const;

/**
 * One lane's batch tally, folded from the production
 * `appOtelRuntime.emitSyncBatchEvent` calls the lanes already make — the
 * harness observes the telemetry seam rather than adding a counter to the lane.
 */
export type LiveSyncLaneTally = {
  lane: SyncLane | typeof UNATTRIBUTED_LANE;
  accepted: number;
  rejected: number;
  /**
   * ISS-10912: invocation-part sends the cloud answered `session_missing`,
   * retried or dead-lettered by the lane — retried inside
   * `SESSION_MISSING_MAX_RETRY_AGE_MS` (a part that outran its parent session,
   * cause 2 in `invocation-sync-rejection-policy.ts`), dead-lettered on the send
   * that crosses it. So this overlaps `deadLetters.invocationParts` rather than
   * being disjoint from it. Not a rejection: a part that never lands still fails
   * the verdict, as a dead letter or as a lane that did not drain, and the
   * undrained-lane violation names this count.
   */
  deferred: number;
  deadLettered: number;
  /** The closed `SyncReason` values carried by the rejected and dead-lettered batches. */
  reasons: string[];
};

/**
 * One lane's own burn-down verdict, folded from the final
 * `SyncBurndownReporter` sample of the drain.
 *
 * Carried per lane rather than as one boolean because "the drain stopped early"
 * and "the invocation-parts queue still owes 412 parts" are different
 * debugging problems, and a single flag would make them look the same.
 */
export type LiveSyncLaneRemainder = {
  lane: SyncLaneId;
  /** The lane's own {@link SyncLaneDrainState}; only `drained` is caught up. */
  state: SyncLaneDrainState;
  /**
   * Items the lane still owes. `null` is the store's "I never read this queue"
   * — unknown, never zero — and the state above is what decides the verdict.
   */
  itemsRemaining: number | null;
};

export type LiveSyncHarnessReport = {
  /**
   * The SESSION lane's queues reached empty before the budget expired.
   *
   * NAMED FOR THE ONE LANE IT MEASURES, because `AgentSessionSyncProgress`
   * `caughtUp` is explicit that it is per-lane and "must never be presented as a
   * whole-app completeness claim (ISS-5768)" — it does not reflect the
   * invocation-parts lane this harness also starts. An earlier revision called
   * this `drained` and documented it as "both outboxes reached empty", which is
   * exactly the claim that docstring forbids.
   *
   * It is therefore NOT the pass condition on its own. The whole-run answer is
   * {@link laneRemainders}, one per lane the harness drives; this flag survives
   * because "the session lane never settled" and "it settled and another lane
   * still owed work" are different failures and the report says which.
   */
  sessionLaneDrained: boolean;
  durationMs: number;
  budgetMs: number;
  /** Sessions the session lane counted at a VERIFIED ack. */
  sessionsDelivered: number;
  lanes: LiveSyncLaneTally[];
  /**
   * Rows the lanes parked as dead letters, by lane family.
   *
   * THREE COUNTERS, NOT TWO. `sessions` and `components` come from the session
   * service's `sync_state.dead_lettered_ids`, which ISS-5347 records "does NOT
   * and cannot cover" the invocation-parts lane; that lane keeps its own
   * `deadLetteredPartCount`, and reading only the first two reported a lane that
   * had abandoned rows as clean.
   */
  deadLetters: {
    sessions: number;
    components: number;
    invocationParts: number;
  };
  /**
   * The DISTINCT `sync failed: …` warnings the lane wrote
   * (`agent-session-sync-tick-failure-log.ts`) — what the assertions call
   * `agent_sessions.sync.failed`.
   *
   * DISTINCT, NOT A TICK COUNT, and the difference is the logger's not a
   * choice: `GatewayLogger.log` drops an entry whose `level:tag:message` equals
   * the previous one, so a lane failing identically every tick for fifteen
   * minutes writes ONE line. Reporting the length as a number of failed ticks
   * would read as a single transient blip. Any non-empty list is a violation, so
   * the verdict does not depend on the count.
   */
  syncFailures: string[];
  /**
   * The server's `details.reason` diagnostic, as the lane echoed it. For a
   * per-session rejection ISS-8005 makes that `session_invalid:<field path>`, so
   * a red NAMES the field that was refused instead of reporting a count — which
   * is what makes the synthetic-break rehearsal actionable.
   */
  rejectedDetails: string[];
  /**
   * The per-lane burn-down at the end of the drain, for the lanes the harness
   * actually runs. Empty when no sample ever completed, which is itself a
   * violation — an unread queue is not an empty one.
   */
  laneRemainders: LiveSyncLaneRemainder[];
  /** What the local SQLite store held before the drain. */
  corpus: LiveSyncCounts;
  /**
   * What the API stored, read from the containerized Postgres. `null` when the
   * count step did not run or could not be parsed — see the file header.
   */
  cloud: LiveSyncCounts | null;
};

/** Sum a field across every lane tally. */
function totalAcross(
  lanes: readonly LiveSyncLaneTally[],
  field: "accepted" | "rejected" | "deadLettered"
): number {
  return lanes.reduce((total, tally) => total + tally[field], 0);
}

/** The distinct reasons behind every rejected or dead-lettered batch, in first-seen order. */
function distinctReasons(lanes: readonly LiveSyncLaneTally[]): string[] {
  return [...new Set(lanes.flatMap((tally) => tally.reasons))];
}

/**
 * Render a bounded list into a violation message. Bounded because the whole
 * report is echoed into a CI job summary and one pathological session can carry
 * hundreds of identical paths; the count is kept so the elision is visible
 * rather than silent.
 */
function nameSome(values: readonly string[], limit = 5): string {
  if (values.length <= limit) {
    return values.join(", ");
  }
  return `${values.slice(0, limit).join(", ")} (+${values.length - limit} more)`;
}

function rejectionDetail(report: LiveSyncHarnessReport): string {
  const parts: string[] = [];
  const reasons = distinctReasons(report.lanes);
  if (reasons.length > 0) {
    parts.push(`reasons: ${nameSome(reasons)}`);
  }
  if (report.rejectedDetails.length > 0) {
    parts.push(`server detail: ${nameSome(report.rejectedDetails)}`);
  }
  // An empty detail is itself worth saying: a rejection the server declined to
  // explain is a different debugging problem from one that named a field, and a
  // bare count would make the two look the same.
  return parts.length > 0 ? parts.join("; ") : "the server sent no reason";
}

function countsViolations(report: LiveSyncHarnessReport): string[] {
  if (report.cloud === null) {
    return [
      "The cloud-side counts were not measured, so this run proves nothing about " +
        `whether the corpus arrived (local store held ${report.corpus.sessions} session(s) ` +
        `and ${report.corpus.events} event(s)).`,
    ];
  }
  const violations: string[] = [];
  if (report.cloud.sessions !== report.corpus.sessions) {
    violations.push(
      `The cloud stored ${report.cloud.sessions} session(s); the corpus holds ${report.corpus.sessions}.`
    );
  }
  if (report.cloud.events !== report.corpus.events) {
    violations.push(
      `The cloud stored ${report.cloud.events} session event(s); the corpus holds ${report.corpus.events}.`
    );
  }
  return violations;
}

/**
 * Is this lane genuinely caught up? `drained` is the only qualifying state —
 * `drained_with_dead_letters` gave up on the rest and `remaining_unknown` never
 * measured it. One writer, so the drain loop's break condition and the verdict
 * cannot disagree about what "finished" means.
 */
export function laneRemainderIsDrained(
  remainder: LiveSyncLaneRemainder
): boolean {
  return remainder.state === SyncLaneDrainStateValues.Drained;
}

/**
 * Every lane the harness drives reported itself caught up in ONE sample — the
 * drain loop's break condition.
 *
 * The count check is NOT redundant with `every`: `every` is vacuously true over
 * the empty array a failed or short sample produces, which is precisely the
 * shape that would turn "the queues were never read" into a pass.
 */
export function allHarnessLanesDrained(
  remainders: readonly LiveSyncLaneRemainder[]
): boolean {
  return (
    remainders.length === HARNESS_LANE_COUNT &&
    remainders.every(laneRemainderIsDrained)
  );
}

/**
 * The per-lane half of the verdict (whitlockk review).
 *
 * The session lane's `caughtUp` is scoped to ITS queues and is documented as
 * never a whole-app completeness claim, so a green that read only that would
 * pass with the invocation-parts or component-inventory queue still full. Each
 * lane is held to its OWN `classifyLaneDrainState` verdict, for which `drained`
 * is the single qualifying value — `drained_with_dead_letters` and
 * `remaining_unknown` are both failures here.
 */
function laneViolations(report: LiveSyncHarnessReport): string[] {
  if (report.laneRemainders.length === 0) {
    return [
      "No burn-down sample completed, so no lane's queue depth was measured — " +
        "this run cannot say whether any lane still owes the cloud work.",
    ];
  }
  return report.laneRemainders
    .filter((remainder) => !laneRemainderIsDrained(remainder))
    .map(
      (remainder) =>
        `Lane ${remainder.lane} did not finish: state ${remainder.state}, ` +
        `${remainder.itemsRemaining ?? "an unmeasured number of"} item(s) still owed` +
        `${deferredDetail(report, remainder.lane)}.`
    );
}

/**
 * The harness verdict: every way a live drain can be wrong, named.
 *
 * An empty array is the pass. Each entry is one operator-readable sentence, so
 * the driver can print them verbatim into a CI annotation without re-deriving a
 * message from a code.
 */
export function collectLiveSyncViolations(
  report: LiveSyncHarnessReport
): string[] {
  const violations: string[] = [];

  if (!report.sessionLaneDrained) {
    violations.push(
      `The session lane did not drain within the ${report.budgetMs}ms budget ` +
        `(gave up after ${report.durationMs}ms, ${report.sessionsDelivered} session(s) delivered).`
    );
  }

  const rejected = totalAcross(report.lanes, "rejected");
  if (rejected > 0) {
    violations.push(
      `${rejected} batch(es) were rejected — ${rejectionDetail(report)}.`
    );
  }

  const deadLettered =
    report.deadLetters.sessions +
    report.deadLetters.components +
    report.deadLetters.invocationParts;
  if (deadLettered > 0) {
    violations.push(
      `${deadLettered} row(s) were dead-lettered (${report.deadLetters.sessions} session(s), ` +
        `${report.deadLetters.components} component row(s), ` +
        `${report.deadLetters.invocationParts} invocation part(s)).`
    );
  }

  violations.push(...laneViolations(report));

  if (report.syncFailures.length > 0) {
    violations.push(
      `The lane reported ${report.syncFailures.length} distinct sync failure(s): ` +
        `${nameSome(report.syncFailures, 3)}.`
    );
  }

  violations.push(...countsViolations(report));

  return violations;
}

/**
 * The lane's own `sync failed: …` warning
 * (`agent-session-sync-tick-failure-log.ts`), which is what the assertions call
 * `agent_sessions.sync.failed`.
 *
 * BOTH HALVES ARE LOAD-BEARING, and neither is the one an earlier revision of
 * this comment claimed. `GatewayLogger` has no debug LEVEL — `LogLevel` is
 * `"info" | "warn" | "error"` and `gatewayLog.debug()` writes at `"info"` when
 * verbose — so the two abandonment arms (`sync abandoned: …`, deliberately not
 * failures) are separated by their MESSAGE, and the `warn` check is what keeps
 * an unrelated `info`/`error` line that happens to start the same way out.
 */
export function syncTickFailureMessage(entry: {
  level: string;
  message: string;
}): string | null {
  return entry.level === "warn" && entry.message.startsWith("sync failed:")
    ? entry.message
    : null;
}

/**
 * The server's diagnostic, out of whichever rejection line carried it.
 *
 * Matched on the `(server detail: …)` wrapper the DESKTOP writes
 * (`formatServerDetailSuffix`), deliberately NOT on the server's reason
 * vocabulary. `session_invalid` is module-private in
 * `apps/api/lib/desktop-agent-sessions-parse-guards.ts` and unreachable from
 * here, and spelling it again would put a copy of a cross-process literal in a
 * harness that silently reports zero field paths the moment the two drift —
 * which reads as "nothing was rejected", not as "the harness stopped looking".
 * The wrapper is emitted for a rejection and nothing else, and it carries
 * whatever a newer API invents, including a reason this build has never seen.
 */
export function serverRejectionDetail(message: string): string | null {
  return SERVER_DETAIL_PATTERN.exec(message)?.[1] ?? null;
}

const SERVER_DETAIL_PATTERN = /\(server detail: ([^)]*)\)/;

/** The batch tallies and log lines observed across one drain. */
export type LiveSyncObservations = {
  lanes: Map<LiveSyncLaneTally["lane"], LiveSyncLaneTally>;
  syncFailures: string[];
  rejectedDetails: string[];
};

/** The only thing {@link observeGatewayLog} needs from `GatewayLogger`. */
export type LiveSyncLogSource = {
  setOnChange(listener: (entries: readonly LiveSyncLogEntry[]) => void): void;
};

export type LiveSyncLogEntry = {
  level: string;
  message: string;
};

/**
 * Subscribe to the gateway log for the two lines the verdict reads. Returns the
 * unsubscribe, which the caller must run before the process exits so a late
 * shutdown line cannot append to a report already written.
 *
 * READS ONLY THE LAST ENTRY PER NOTIFICATION, and that is the whole correctness
 * argument. `GatewayLogger` keeps a RING BUFFER capped at 500 and hands the
 * callback the whole capped array on every append, so diffing by index — which
 * an earlier revision did — pins the cursor at 500 the moment the buffer fills
 * and silently drops every line after it. A fifteen-minute drain clears 500
 * lines easily, so that version would have reported no failures and no field
 * paths on a run that rejected everything: the exact defect this module's own
 * docstring warns about. `log()` notifies once per appended entry and the
 * appended entry is always last, so taking the tail is exact and cap-proof.
 */
export function observeGatewayLog(
  logger: LiveSyncLogSource,
  observations: LiveSyncObservations
): () => void {
  logger.setOnChange((entries) => {
    // `clear()` notifies with an empty array; nothing was appended.
    const entry = entries.at(-1);
    if (!entry) {
      return;
    }
    const failure = syncTickFailureMessage(entry);
    if (failure && !observations.syncFailures.includes(failure)) {
      // De-duplicated here too: the logger already drops a message identical to
      // the one before it, so the list is distinct failures either way, and
      // saying so once beats a count that cannot mean what it looks like.
      observations.syncFailures.push(failure);
    }
    const detail = serverRejectionDetail(entry.message);
    if (detail) {
      observations.rejectedDetails.push(detail);
    }
  });
  return () => logger.setOnChange(() => undefined);
}

/**
 * Fold one production `emitSyncBatchEvent` call into its lane's tally.
 *
 * An absent `lane` gets its own bucket rather than a default: `lane` is optional
 * so a record from an older desktop "degrades to unattributed rather than
 * mis-attributing them to lane 1", and defaulting it to SessionMetadata would
 * send an operator to the session lane for a component-lane failure.
 */
export function tallySyncBatch(
  observations: LiveSyncObservations,
  input: DesktopSyncBatchEventInput
): void {
  const lane = input.lane ?? UNATTRIBUTED_LANE;
  let tally = observations.lanes.get(lane);
  if (!tally) {
    tally = {
      lane,
      accepted: 0,
      rejected: 0,
      deferred: 0,
      deadLettered: 0,
      reasons: [],
    };
    observations.lanes.set(lane, tally);
  }
  if (input.outcome === SyncOutcome.Success) {
    tally.accepted += 1;
    return;
  }
  if (isRetriedSessionMissing(input)) {
    tally.deferred += 1;
    return;
  }
  if (input.outcome === SyncOutcome.DeadLetter) {
    tally.deadLettered += 1;
  } else {
    tally.rejected += 1;
  }
  if (input.reason) {
    tally.reasons.push(input.reason);
  }
}

/**
 * ISS-10912: the invocation-parts lane's `session_missing` failure, which that
 * lane's rejection policy defers and retries. The same reason on any other lane
 * stays a rejection.
 */
function isRetriedSessionMissing(input: DesktopSyncBatchEventInput): boolean {
  return (
    input.lane === SyncLane.InvocationParts &&
    input.outcome === SyncOutcome.Failure &&
    input.reason === SyncReason.SessionMissing
  );
}

/**
 * ISS-10912 (tamsinb review): a deferred send is not a rejection, so its reason
 * never reaches {@link rejectionDetail}. A part whose parent session never
 * arrives stays inside `SESSION_MISSING_MAX_RETRY_AGE_MS` for the whole drain
 * budget and never dead-letters, so the undrained-lane sentence is its only
 * signal — it carries the reason here.
 */
function deferredDetail(
  report: LiveSyncHarnessReport,
  lane: SyncLaneId
): string {
  const deferred = report.lanes.find((tally) => tally.lane === lane)?.deferred;
  return deferred
    ? `; ${deferred} send(s) deferred — reason: ${SyncReason.SessionMissing}`
    : "";
}
