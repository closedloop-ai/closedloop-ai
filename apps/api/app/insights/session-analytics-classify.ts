import {
  outcomeForEndsWithError,
  SpendOutcome,
} from "@closedloop-ai/loops-api/insights";
import { SessionTraceThrottleSourceType } from "@repo/api/src/types/agent-session";
import {
  BehavioralCause,
  LossClass,
} from "@repo/api/src/types/session-analytics";
import {
  normalizeSessionStatus,
  TERMINAL_SESSION_STATUSES,
} from "@repo/api/src/types/session-status";

/**
 * The single place a session is classified for BOTH session-analytics
 * surfaces — Lost work (ISS-4987) and TokenOps waste-vs-leverage (ISS-4988).
 *
 * The two screens measure the same failures in different units (wall-clock and
 * dollars). They share this module rather than each deriving their own
 * predicate, so "which sessions failed" is structurally one answer instead of
 * two that happen to agree today. `session-analytics-reconciliation.test.ts`
 * asserts that mechanically.
 *
 * Everything here keys off `outcomeForEndsWithError` from
 * `@closedloop-ai/loops-api/insights` — the canonical classifier over the single field
 * `SessionDetail.endsWithError`. Nothing in this file re-derives the null
 * mapping.
 */

/**
 * The signals that determine a session's OUTCOME and whether it lost work.
 *
 * Deliberately narrower than {@link AnalyticsSessionSignals}: the TokenOps
 * rollup groups on only these three columns, and typing the shared predicates
 * against this subset means it cannot come to depend on a signal it never
 * queried (which would silently classify every one of its sessions against a
 * placeholder).
 */
export type OutcomeSignals = {
  /** `SessionDetail.endsWithError` — nullable; null means never recorded. */
  endsWithError: boolean | null;
  /** The run yielded a pull request or changed files. */
  producedArtifact: boolean;
  /** Wall-clock the session consumed. */
  wallClockMinutes: number;
  /**
   * ISS-7019: the session's stored LIFECYCLE status (`artifacts.status`). Was
   * `state`, an `AgentSessionState` read off `session_detail.state` — a column
   * nothing has written since the sync path dropped the field, which made the
   * terminal gate below inert for every modern row.
   */
  status: string | null;
};

/** Every signal the lost-work attribution reads. */
export type AnalyticsSessionSignals = OutcomeSignals & {
  /**
   * A throttle source of a FAILURE kind was recorded against the run.
   * `TokenSnapshot` is excluded upstream: it is a usage sample, not a throttle.
   */
  hasFailureThrottle: boolean;
};

/**
 * The statuses in which a run has actually FINISHED.
 *
 * `endsWithError` alone cannot answer "did this end well", because the desktop
 * write path persists the flag for every row, live or terminal — a session
 * running right now syncs `endsWithError: false`. Without this gate that run
 * would be graded `Clean` ("Ended clean") for a run that has not ended, its
 * spend counted as productive on the TokenOps screen and its burnt wall-clock
 * counted as productive on the Lost-work one.
 *
 * ISS-7019: that is exactly what HAS been happening. The gate used to read
 * `session_detail.state`, and nothing has written that column since the sync
 * path dropped the field — so for every modern row the state was null, the
 * guard fell through, and a live session was graded Clean. Re-keying onto the
 * stored lifecycle status makes the gate fire again, which MOVES numbers:
 * spend and wall-clock for in-flight runs leave `Clean` for `Unknown` on both
 * screens. That is the correction, not a regression.
 *
 * Reads {@link TERMINAL_SESSION_STATUSES} rather than restating `inactive` and
 * `error`, so "which statuses are terminal" cannot fork from the vocabulary
 * that owns it — and `unknown`/`stale` stay non-terminal there deliberately.
 */
export const TERMINAL_ANALYTICS_SESSION_STATUSES: readonly string[] = [
  ...TERMINAL_SESSION_STATUSES,
];

/** The throttle sources that represent a platform-caused failure. */
export const FAILURE_THROTTLE_SOURCE_TYPES: readonly string[] = [
  SessionTraceThrottleSourceType.ProviderRateLimit,
  SessionTraceThrottleSourceType.UsageLimit,
  SessionTraceThrottleSourceType.ApiError,
];

/**
 * The one definition of a session's outcome.
 *
 * A run that has not reached a terminal status has no outcome YET, so it reports
 * `Unknown` — which is exactly the "no outcome recorded" fact that bucket
 * exists to hold — rather than borrowing the `endsWithError: false` a live row
 * carries for the reaper's benefit.
 *
 * A null status is left to `outcomeForEndsWithError`: "never recorded" is not
 * evidence of a run in flight, and treating it as such would reclassify every
 * row that predates the column. `artifacts.status` is non-null in practice, so
 * this arm is for a partially-projected or version-skewed row, not the norm —
 * which is the opposite of the `state` column it replaced, where null WAS the
 * norm and silently disabled the whole gate (ISS-7019).
 *
 * The `endsWithError` mapping itself is delegated and never re-derived here.
 */
export function outcomeOf(signals: OutcomeSignals): SpendOutcome {
  // Nullish, not just `null`: a version-skewed or partially-projected row can
  // arrive with the column absent, and "never recorded" must not be mistaken
  // for "still running" — that would reclassify every legacy row as Unknown.
  if (
    signals.status !== null &&
    signals.status !== undefined &&
    !TERMINAL_ANALYTICS_SESSION_STATUSES.includes(
      normalizeSessionStatus(signals.status)
    )
  ) {
    return SpendOutcome.Unknown;
  }
  return outcomeForEndsWithError(signals.endsWithError);
}

/**
 * A session whose wall-clock was lost: it consumed time, yielded no artifact,
 * and did NOT end clean.
 *
 * The clean exclusion is deliberate and is the one refinement this production
 * build makes over the prototype's predicate. A session that ended cleanly and
 * simply did not happen to produce an artifact — a question answered, an
 * investigation — has not lost the work, and counting it would invent loss that
 * was never observed. It also makes the reconciliation with the TokenOps screen
 * hold STRUCTURALLY on real data: the prototype's fixture never emitted a clean
 * session without an artifact, so its predicate agreed by construction rather
 * than by rule. With this exclusion the two invariants below are true for any
 * population:
 *
 *   Actionable ∪ Systemic === sessions that ended with an error and lost work
 *   Unattributed          === sessions whose outcome was never recorded
 */
export function isLostSession(signals: OutcomeSignals): boolean {
  return (
    !signals.producedArtifact &&
    signals.wallClockMinutes > 0 &&
    outcomeOf(signals) !== SpendOutcome.Clean
  );
}

/**
 * Attribution for a lost session, driven entirely by recorded signal: a
 * throttle source means the platform caused it; a recorded terminal failure
 * with no throttle source is coachable; an unrecorded outcome is neither and
 * says so rather than defaulting to one side.
 *
 * Returns `null` for a session that lost nothing.
 */
export function lossClassOf(
  signals: AnalyticsSessionSignals
): LossClass | null {
  if (!isLostSession(signals)) {
    return null;
  }
  if (outcomeOf(signals) === SpendOutcome.Unknown) {
    return LossClass.Unattributed;
  }
  return signals.hasFailureThrottle ? LossClass.Systemic : LossClass.Actionable;
}

/**
 * The behavioral cause behind a coachable loss, read off the terminal state the
 * run landed in. Derived, never stored as a second taxonomy.
 */
export function behavioralCauseOf(
  signals: AnalyticsSessionSignals
): BehavioralCause | null {
  if (lossClassOf(signals) !== LossClass.Actionable) {
    return null;
  }
  // ISS-4654: this used to split on AgentSessionState.Abandoned. That state is
  // retired (ISS-4586 supersedes FEA-4287's abandonment half), and no other
  // signal distinguishes a swept-idle run from a dead-ended one, so every
  // actionable loss now reports DeadEnded.
  //
  // KNOWN CONSEQUENCE, deliberately not fixed here: `BehavioralCause.Abandoned`
  // is now unreachable, so the "Abandoned mid-run" bucket on the Lost-work
  // screen is permanently empty. Retiring that member spans the insights
  // taxonomy, `apps/app`'s loss-causes UI and the prototypes' own copy, so it is
  // left as follow-up rather than widened into this change.
  return BehavioralCause.DeadEnded;
}

/**
 * Whether this session's spend belongs in the recoverable-waste basis: it
 * ended with a recorded error AND lost the work. Outcome-unknown spend is
 * excluded outright (and reported separately), because we cannot claim a
 * session wasted money when we never observed that it failed.
 *
 * This is the TokenOps side of the shared definition, expressed here so the two
 * screens cannot drift.
 */
export function isRecoverableWasteBasis(signals: OutcomeSignals): boolean {
  return outcomeOf(signals) === SpendOutcome.Errored && isLostSession(signals);
}
