import { DeliveryMatchOutcome } from "@repo/database";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import {
  fetchDeliverySegment,
  type PenseroRequestCredential,
  SegmentCompleteness,
} from "@repo/pensero/delivery-client";
import { toIsoDateOnly } from "@/lib/date-only";
import {
  listPenseroConfiguredOrganizations,
  withOrgPenseroCredential,
} from "@/lib/delivery-points/pensero-credential-resolver";
import {
  type DeliveryBackfillOptions,
  type DeliveryBackfillReport,
  runPenseroDeliveryBackfill,
} from "@/lib/delivery-points/pensero-delivery-backfill";
import {
  degradedReasonForCompleteness,
  emitPenseroBackfillDayFailed,
  emitPenseroBackfillDegraded,
  emitPenseroBackfillRun,
  PenseroBackfillDegradedReason,
  type PenseroBackfillOutcomeCounts,
} from "@/lib/observability/pensero-backfill-metrics";
import {
  advanceBackwardCursor,
  advanceRecheckCursor,
  BackfillDayReason,
  type BackwardDayAttempt,
  DEFAULT_BACKWARD_DAYS_PER_RUN,
  DEFAULT_MAX_DAYS_PER_RUN,
  type PlannedBackfillDay,
  planBackfillDays,
} from "./day-plan";
import {
  type FailedUnit,
  type FailureReasonSummary,
  FailureSummaryScope,
  formatFailureSummary,
  summarizeFailureReasons,
} from "./failure-reason";
import {
  readOrganizationBackfillState,
  recordBackfillDayAttempt,
  writeBackfillCursors,
} from "./ledger";

/**
 * The scheduled, multi-tenant Pensero delivery backfill (ISS-8761).
 *
 * ## What was actually broken
 *
 * `runPenseroDeliveryBackfill` shipped complete and with ZERO production
 * callers. An organization could store a Pensero credential, watch the settings
 * card confirm it, and never receive a single delivery point — the feature read
 * as configured and did nothing. This module is the missing trigger, and the
 * per-org/per-day segmentation that drives it. It reimplements none of the
 * fetch/join/match/attach pipeline; it decides WHICH organization and WHICH day,
 * and records what happened.
 *
 * ## One fetch per organization per day
 *
 * Each planned day is one `runPenseroDeliveryBackfill` call with a one-day
 * lookback and a one-day segment, so the provider sees exactly one request per
 * organization per day. Person-to-user mapping stays where it already was — a
 * post-fetch email bridge inside the matcher — so nothing here issues a request
 * per user.
 *
 * ## Per-org scoping, end to end
 *
 * The sweep visits only organizations with their OWN stored credential, each
 * one's token is resolved just in time inside a callback that owns its
 * lifetime, and every downstream read and write is already keyed on
 * `organizationId`. A failure in one organization does not abort the sweep and
 * does not leak into another's ledger.
 */

/** Cap on attempted days read per org to feed the round-robin recheck lane. */
const ATTEMPTED_DAY_READ_LIMIT = 400;

/**
 * Wall-clock budget for ONE sweep, in milliseconds (codex + whitlockk, #6492).
 *
 * The route declares `maxDuration = 300` and every provider call carries a
 * 30-second timeout, so with the default 14 planned days ONE organization whose
 * provider is timing out can burn 420 seconds on its own. Vercel then kills the
 * invocation before ANY cursor is written and before the second organization is
 * reached — so a single slow tenant both loses its own progress and starves
 * every tenant after it, on every run, forever.
 *
 * 240 s leaves room for the one in-flight day that may have started just under
 * the deadline (≤30 s), the org's cursor write, the Slack notify, and the
 * response — inside the 300 s ceiling. It bounds WORK, never HISTORY: a
 * deferred organization is not skipped, it is first in line next run (see
 * `listPenseroConfiguredOrganizations`, ordered least-recently-swept first).
 */
const DEFAULT_SWEEP_BUDGET_MS = 240_000;

/** One day's lookback, one day's segment: exactly one provider request. */
const SINGLE_DAY_LOOKBACK = 1;
const SINGLE_DAY_SEGMENT = 1;
const SINGLE_DAY_MAX_SEGMENTS = 1;

/** What the sweep did, for the route's response and its logs. */
export type PenseroBackfillSweepSummary = {
  readonly organizationsConsidered: number;
  readonly organizationsSwept: number;
  readonly organizationsFailed: number;
  /**
   * Organizations the run's wall-clock budget stopped it reaching. NOT skipped:
   * the listing is ordered least-recently-swept first, so a deferred org leads
   * the next run. A number that is persistently non-zero means the schedule is
   * too sparse for the tenant count, which is why it is reported rather than
   * folded into `organizationsConsidered`.
   */
  readonly organizationsDeferred: number;
  readonly daysAttempted: number;
  readonly daysSucceeded: number;
  readonly daysFailed: number;
  readonly rowsWritten: number;
  /**
   * True when at least one organization ended the run with lanes still owed
   * work. Not a truncation — the cursors carry the remainder — but a run that
   * is permanently in this state is one whose budget is too small.
   */
  readonly continuationPending: boolean;
  /** True when any degraded signal fired. Drives the route's alerting. */
  readonly degraded: boolean;
  /**
   * WHY the failed days failed, or `null` when none did.
   *
   * `daysFailed=8` on its own names a volume and no cause, and the cause was
   * already known at the point of failure — it just stopped there. This carries
   * it as far as the alert. Deliberately scoped to failed DAYS: an organization
   * whose whole sweep threw is a different fault with a different owner, is
   * counted separately in `organizationsFailed`, and folding the two together
   * would produce a "dominant reason" over a population nobody can act on.
   */
  readonly dayFailureSummary: FailureReasonSummary | null;
};

/**
 * What the on-demand validation probe actually established, per organization.
 *
 * The four organization counters are MUTUALLY EXCLUSIVE and sum to
 * `organizationsConsidered`, which is the whole contract of this tool: a reader
 * must never mistake an organization the run never reached for one that passed.
 * `organizationsDeferred` is that distinction — see
 * {@link validatePenseroDeliveryBackfill}.
 */
export type PenseroDeliveryValidationSummary = {
  readonly organizationsConsidered: number;
  /** Reached, fetched, and answered — the only counter that means "healthy". */
  readonly organizationsValidated: number;
  /** Reached, but the credential was gone by the time it was resolved. */
  readonly organizationsSkipped: number;
  /** Reached, and the provider call threw. */
  readonly organizationsFailed: number;
  /**
   * NOT REACHED before the wall-clock budget ran out, and therefore UNKNOWN.
   * A non-zero value means this summary is partial: the organizations it counts
   * were neither proved healthy nor proved broken.
   */
  readonly organizationsDeferred: number;
  readonly rowsSeen: number;
  readonly continuationPending: boolean;
  readonly degraded: boolean;
  /**
   * Scoped to failed ORGANIZATIONS, not days (whitlockk, #6747). Validation samples
   * exactly one day per organization, so a count here is a number of tenants;
   * `formatValidationSummary` labels it as one.
   */
  readonly organizationFailureSummary: FailureReasonSummary | null;
};

export type PenseroDeliveryValidationOptions = {
  readonly now: Date;
  /** Wall-clock budget for the whole probe. Defaults to {@link DEFAULT_SWEEP_BUDGET_MS}. */
  readonly budgetMs?: number;
  /** Elapsed-time source, injected ONLY for tests. Production uses `Date.now`. */
  readonly elapsedNowMs?: () => number;
};

export type PenseroBackfillSweepOptions = {
  /** The run's clock, injected so day boundaries are pinnable in tests. */
  readonly now: Date;
  readonly maxDaysPerOrganization?: number;
  readonly backwardDaysPerRun?: number;
  /**
   * The backfill entry point, injected ONLY for tests. Production always uses
   * `runPenseroDeliveryBackfill`; naming it here is what lets a test drive the
   * degraded and failure branches without a provider.
   */
  readonly runBackfill?: (
    options: DeliveryBackfillOptions
  ) => Promise<DeliveryBackfillReport>;
  /** Wall-clock budget for the whole sweep. Defaults to {@link DEFAULT_SWEEP_BUDGET_MS}. */
  readonly budgetMs?: number;
  /**
   * The elapsed-time source the budget is measured against, injected ONLY for
   * tests. Production uses `Date.now`. Named rather than read directly so a
   * deadline case can advance a counter deterministically instead of sleeping —
   * a real-clock wait would be exactly the timing-based assertion the repo bans.
   */
  readonly elapsedNowMs?: () => number;
};

/**
 * Probe every configured organization's Pensero endpoint for today, READ-ONLY.
 *
 * ## Why it carries the sweep's budget (tamsinb + whitlockk, #6747)
 *
 * This walks organizations serially and every `fetchDeliverySegment` carries a
 * 30-second timeout, so eleven unreachable tenants is 330 s against the route's
 * `maxDuration = 300` — Vercel kills the invocation and the operator gets
 * NOTHING. That is precisely the scenario the tool exists to diagnose, so the
 * unbudgeted version failed exactly when it was needed. It now shares the
 * sweep's deadline and returns the partial result instead of dying.
 *
 * ## A partial result must not read as a pass
 *
 * Organizations past the deadline are counted in `organizationsDeferred` and
 * NOT in `organizationsValidated`. "Not reached, therefore unknown" and
 * "reached and healthy" are different facts, and folding the first into the
 * second would make a half-finished probe of eleven broken tenants look like a
 * clean bill of health for the three it managed to check.
 */
export async function validatePenseroDeliveryBackfill(
  options: PenseroDeliveryValidationOptions
): Promise<PenseroDeliveryValidationSummary> {
  const organizations = await listPenseroConfiguredOrganizations();
  const today = toIsoDateOnly(options.now);
  const organizationFailures: FailedUnit[] = [];
  const isPastDeadline = createDeadline(
    options.elapsedNowMs ?? Date.now,
    clampBudgetMs(options.budgetMs)
  );

  let organizationsValidated = 0;
  let organizationsSkipped = 0;
  let organizationsFailed = 0;
  let organizationsDeferred = 0;
  let rowsSeen = 0;
  let continuationPending = false;

  for (const organization of organizations) {
    // Checked BEFORE the fetch, never mid-flight: the worst overrun past the
    // deadline is one request's own 30 s timeout, which is what keeps the
    // summary inside the route's ceiling instead of being killed with it.
    if (isPastDeadline()) {
      organizationsDeferred += 1;
      continue;
    }
    try {
      const result = await withOrgPenseroCredential(
        organization.organizationId,
        async (credential) =>
          await fetchDeliverySegment({
            startDate: today,
            endDate: today,
            teamIdentifiers: organization.teamIdentifiers,
            credential,
          })
      );
      if (!result) {
        organizationsSkipped += 1;
        continue;
      }
      organizationsValidated += 1;
      rowsSeen += result.segment.rows.length;
      continuationPending =
        continuationPending ||
        result.completeness === SegmentCompleteness.TruncationSignalled;
    } catch (error) {
      organizationsFailed += 1;
      organizationFailures.push({
        organizationId: organization.organizationId,
        reason: parseError(error),
      });
    }
  }

  return {
    organizationsConsidered: organizations.length,
    organizationsValidated,
    organizationsSkipped,
    organizationsFailed,
    organizationsDeferred,
    rowsSeen,
    continuationPending,
    // A probe that ran out of budget is degraded on its own terms: unlike the
    // sweep, there is no next scheduled run to pick the rest up — an operator
    // asked a question and got a partial answer.
    degraded:
      organizationsFailed > 0 ||
      continuationPending ||
      organizationsDeferred > 0,
    organizationFailureSummary: summarizeFailureReasons(organizationFailures),
  };
}

/**
 * Run the sweep across every organization with a configured Pensero credential.
 *
 * An organization that throws is counted and skipped; the remaining tenants
 * still get their run, because one org's bad credential is not a reason to stop
 * delivering everyone else's data.
 */
export async function sweepPenseroDeliveryBackfill(
  options: PenseroBackfillSweepOptions
): Promise<PenseroBackfillSweepSummary> {
  const organizations = await listPenseroConfiguredOrganizations();
  const budgetMs = clampBudgetMs(options.budgetMs);
  const isPastDeadline = createDeadline(
    options.elapsedNowMs ?? Date.now,
    budgetMs
  );

  let organizationsSwept = 0;
  let organizationsFailed = 0;
  let organizationsDeferred = 0;
  let daysAttempted = 0;
  let daysSucceeded = 0;
  let daysFailed = 0;
  let rowsWritten = 0;
  let continuationPending = false;
  let degraded = false;
  // Flat and across every tenant: the sweep alerts once per run, so the question
  // the alert answers is "what is failing tonight", not "what is org X failing
  // on". Each entry still names its ORGANIZATION (ISS-9689), so the one line
  // that pages someone can say which tenant the dominant cause belongs to
  // instead of leaving them to go and find it.
  const dayFailures: FailedUnit[] = [];

  for (const organization of organizations) {
    // Checked BEFORE the org rather than after, so the run stops while it can
    // still write what it has instead of being killed mid-flight. Everything
    // after this point in the list is deferred, not dropped.
    if (isPastDeadline()) {
      organizationsDeferred += 1;
      continuationPending = true;
      // Queryable per tenant, and deliberately NOT folded into `degraded`:
      // deferral under a fair least-recently-swept rotation is the budget
      // working, the same way a per-org `continuationPending` is. What would be
      // a defect is the SAME org deferring run after run, and only a per-org
      // series can show that.
      emitPenseroBackfillDegraded({
        orgId: organization.organizationId,
        reason: PenseroBackfillDegradedReason.SweepBudgetExhausted,
      });
      continue;
    }
    try {
      const result = await sweepOrganization(organization, options, {
        isPastDeadline,
      });
      organizationsSwept += 1;
      daysAttempted += result.daysAttempted;
      daysSucceeded += result.daysSucceeded;
      daysFailed += result.daysFailed;
      rowsWritten += result.rowsWritten;
      dayFailures.push(...result.dayFailures);
      continuationPending = continuationPending || result.continuationPending;
      degraded = degraded || result.degraded;
    } catch (error) {
      organizationsFailed += 1;
      degraded = true;
      log.error("[backfill-pensero-delivery] Organization sweep failed", {
        organizationId: organization.organizationId,
        error: parseError(error),
      });
    }
  }

  if (organizationsDeferred > 0) {
    log.info("[backfill-pensero-delivery] Sweep budget exhausted", {
      organizationsDeferred,
      budgetMs,
    });
  }

  return {
    organizationsConsidered: organizations.length,
    organizationsSwept,
    organizationsFailed,
    organizationsDeferred,
    daysAttempted,
    daysSucceeded,
    daysFailed,
    rowsWritten,
    continuationPending,
    degraded,
    dayFailureSummary: summarizeFailureReasons(dayFailures),
  };
}

/**
 * Clamp the sweep budget at BOTH ends. A negative or non-finite budget produces
 * a deadline already in the past, which would defer every organization and read
 * exactly like a completed run with nothing to do.
 */
function clampBudgetMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_SWEEP_BUDGET_MS;
  }
  return Math.max(1, Math.floor(value));
}

/**
 * The one deadline predicate both the sweep and the validation probe run on.
 *
 * Shared rather than copied so the two cannot drift: the FIRST read of
 * `elapsedNowMs` establishes the deadline, every later read is compared against
 * it, and a run that walks organizations serially against a 30 s per-request
 * timeout stops itself before the route's ceiling kills it.
 */
function createDeadline(
  elapsedNowMs: () => number,
  budgetMs: number
): () => boolean {
  const deadlineMs = elapsedNowMs() + budgetMs;
  return () => elapsedNowMs() >= deadlineMs;
}

type OrganizationSweepResult = {
  daysAttempted: number;
  daysSucceeded: number;
  daysFailed: number;
  rowsWritten: number;
  /** One entry per FAILED day, raw. Same length as `daysFailed`, by construction. */
  dayFailures: FailedUnit[];
  continuationPending: boolean;
  degraded: boolean;
};

/** Plan, fetch, record and advance for exactly one organization. */
async function sweepOrganization(
  organization: { organizationId: string; teamIdentifiers: readonly string[] },
  options: PenseroBackfillSweepOptions,
  budget: { isPastDeadline: () => boolean }
): Promise<OrganizationSweepResult> {
  const { organizationId } = organization;
  const state = await readOrganizationBackfillState(
    organizationId,
    ATTEMPTED_DAY_READ_LIMIT
  );
  const plan = planBackfillDays({
    today: options.now,
    cursors: state.cursors,
    attemptedDays: state.attemptedDays,
    maxDays: options.maxDaysPerOrganization ?? DEFAULT_MAX_DAYS_PER_RUN,
    backwardDaysPerRun:
      options.backwardDaysPerRun ?? DEFAULT_BACKWARD_DAYS_PER_RUN,
  });

  const runBackfill = options.runBackfill ?? runPenseroDeliveryBackfill;
  const tallies = emptyDayTallies(organizationId);

  // The credential lives only inside this callback. It is never returned, never
  // logged, and never placed on any object that outlives the sweep — see
  // `withOrgPenseroCredential`. A `null` here means the org lost its credential
  // between the listing read and now, which is a clean no-op rather than an
  // error.
  let budgetStoppedDays = false;
  const swept = await withOrgPenseroCredential(
    organizationId,
    async (credential) => {
      for (const planned of plan.days) {
        // Between days, never mid-fetch: the in-flight call carries its own
        // 30 s timeout, so the worst overrun past the deadline is one day's
        // request rather than the whole remaining plan. Stopping HERE is what
        // lets the cursor write below still happen — the sweep leaving its own
        // progress unrecorded is the failure this bound exists to prevent.
        if (budget.isPastDeadline()) {
          budgetStoppedDays = true;
          break;
        }
        foldDayResult(
          tallies,
          planned,
          await attemptDay({
            organizationId,
            teamIdentifiers: organization.teamIdentifiers,
            credential,
            planned,
            now: options.now,
            runBackfill,
          })
        );
      }
      return true;
    }
  );

  if (swept === null) {
    return {
      daysAttempted: 0,
      daysSucceeded: 0,
      daysFailed: 0,
      rowsWritten: 0,
      dayFailures: [],
      continuationPending: false,
      degraded: false,
    };
  }

  await writeBackfillCursors(organizationId, {
    backwardCursor: advanceBackwardCursor(
      state.cursors.backwardCursor,
      tallies.backwardAttempts
    ),
    recheckCursor: advanceRecheckCursor(
      state.cursors.recheckCursor,
      tallies.recheckedDays
    ),
  });

  const continuationPending = plan.continuationPending || budgetStoppedDays;
  if (continuationPending) {
    emitPenseroBackfillDegraded({
      orgId: organizationId,
      reason: PenseroBackfillDegradedReason.ContinuationPending,
    });
  }

  // The days actually ASKED FOR, not the days planned. A budget-stopped run
  // that reported `plan.days.length` would claim attempts it never made, and
  // the run counter is what an operator reads to tell a slow tenant from a
  // healthy one.
  emitPenseroBackfillRun({
    orgId: organizationId,
    daysAttempted: tallies.daysAttempted,
    daysSucceeded: tallies.daysSucceeded,
    daysFailed: tallies.daysFailed,
    rowsWritten: tallies.rowsWritten,
    artifactAssociationsWritten: tallies.artifactAssociationsWritten,
    peopleUnbridged: tallies.peopleUnbridged,
    outcomeCounts: tallies.outcomeCounts,
  });

  return {
    daysAttempted: tallies.daysAttempted,
    daysSucceeded: tallies.daysSucceeded,
    daysFailed: tallies.daysFailed,
    rowsWritten: tallies.rowsWritten,
    dayFailures: tallies.dayFailures,
    continuationPending,
    degraded: tallies.degraded,
  };
}

type DayAttemptResult = {
  succeeded: boolean;
  degraded: boolean;
  report: DeliveryBackfillReport | null;
  /** The raw reason, on a failed day only. `null` on a day that succeeded. */
  failureReason: string | null;
};

/**
 * Ask the provider for one organization's one day, and record what happened.
 *
 * ## What counts as a success, and what a success does NOT claim
 *
 * A fetch that completed without a transport or parse failure is a SUCCESSFUL
 * ATTEMPT, and it advances the backward cursor, regardless of how many rows
 * came back — a zero-row day is a real answer about a quiet day. It never marks
 * the day complete, because the delivery endpoint returns no `hasMore`, no
 * cursor and no total, so a short window and a quiet window are the same bytes.
 * That is exactly why the recheck cursor asks every attempted day again.
 *
 * ## `planTruncated` is an invariant break, not a quiet day
 *
 * This caller asks for one day with a one-day segment and a one-segment ceiling,
 * so a truncated plan means the planner did not give us the window we asked for.
 * The day is therefore NOT recorded as a success and the backward cursor does
 * not advance past it — the alternative is a permanent hole in the ledger that
 * nothing re-asks, wearing a green tick.
 */
async function attemptDay(input: {
  organizationId: string;
  teamIdentifiers: readonly string[];
  // The resolved credential type, not a structural copy: it carries the
  // `baseUrlSource` label the delivery client reads to decide whether this
  // request's egress is pinned (ISS-9690), and a narrowed local shape would
  // silently drop it from anything constructed here.
  credential: PenseroRequestCredential;
  planned: PlannedBackfillDay;
  now: Date;
  runBackfill: (
    options: DeliveryBackfillOptions
  ) => Promise<DeliveryBackfillReport>;
}): Promise<DayAttemptResult> {
  const { organizationId, planned } = input;
  try {
    const report = await input.runBackfill({
      organizationId,
      // Absent narrowing omits the provider parameter entirely; see
      // `FetchDeliveryOptions.teamIdentifiers`.
      teamIdentifiers: input.teamIdentifiers,
      credential: input.credential,
      endDate: new Date(`${planned.day}T00:00:00.000Z`),
      lookbackDays: SINGLE_DAY_LOOKBACK,
      segmentDays: SINGLE_DAY_SEGMENT,
      maxSegments: SINGLE_DAY_MAX_SEGMENTS,
    });

    const failedSegment = report.segmentsFailed.at(0);
    if (failedSegment) {
      return await failDay({
        organizationId,
        day: planned.day,
        now: input.now,
        reason: failedSegment.error,
      });
    }

    if (report.planTruncated) {
      emitPenseroBackfillDegraded({
        orgId: organizationId,
        reason: PenseroBackfillDegradedReason.PlanTruncated,
      });
      return await failDay({
        organizationId,
        day: planned.day,
        now: input.now,
        reason: PenseroBackfillDegradedReason.PlanTruncated,
      });
    }

    const degradedReason = degradedReasonForCompleteness(report.completeness);
    if (degradedReason) {
      emitPenseroBackfillDegraded({
        orgId: organizationId,
        reason: degradedReason,
      });
    }

    await recordBackfillDayAttempt(organizationId, input.now, {
      day: planned.day,
      succeeded: true,
      failureReason: null,
      rowsWritten: report.rowsWritten,
    });

    return {
      succeeded: true,
      degraded: report.completeness !== SegmentCompleteness.Unverified,
      report,
      failureReason: null,
    };
  } catch (error) {
    return await failDay({
      organizationId,
      day: planned.day,
      now: input.now,
      reason: parseError(error),
    });
  }
}

/** Record a failed day, emit its counter, and report it as not-succeeded. */
async function failDay(input: {
  organizationId: string;
  day: string;
  now: Date;
  reason: string;
}): Promise<DayAttemptResult> {
  await recordBackfillDayAttempt(input.organizationId, input.now, {
    day: input.day,
    succeeded: false,
    failureReason: input.reason,
    rowsWritten: 0,
  });
  emitPenseroBackfillDayFailed({
    orgId: input.organizationId,
    day: input.day,
  });
  log.error("[backfill-pensero-delivery] Day fetch failed", {
    organizationId: input.organizationId,
    day: input.day,
    error: input.reason,
  });
  return {
    succeeded: false,
    degraded: true,
    report: null,
    failureReason: input.reason,
  };
}

/**
 * Every outcome initialized to zero. A member absent from the tally would be
 * indistinguishable from a member that genuinely occurred zero times, and only
 * one of those is a measurement — the same rule `countOutcomes` follows inside
 * the backfill itself.
 */
function emptyOutcomeCounts(): PenseroBackfillOutcomeCounts {
  return {
    [DeliveryMatchOutcome.MATCHED]: 0,
    [DeliveryMatchOutcome.NO_COUNTERPART]: 0,
    [DeliveryMatchOutcome.AMBIGUOUS]: 0,
    [DeliveryMatchOutcome.UNMATCHABLE]: 0,
    [DeliveryMatchOutcome.PENDING_REFERENCE]: 0,
  };
}

/** Fold one day's report into the run's tallies, keeping every outcome apart. */
function addOutcomeCounts(
  totals: PenseroBackfillOutcomeCounts,
  report: DeliveryBackfillReport | null
): void {
  if (!report) {
    return;
  }
  for (const outcome of Object.values(DeliveryMatchOutcome)) {
    totals[outcome] += report.outcomeCounts[outcome];
  }
}

/**
 * What one organization's day walk accumulates.
 *
 * Two of these fields are ORDER-SENSITIVE and cannot be reconstructed by
 * sorting: `backwardAttempts` and `recheckedDays` are consumed in walk order by
 * `advanceBackwardCursor` and `advanceRecheckCursor`, which is why each lane is
 * kept apart rather than folded into one list of attempted days.
 */
type OrganizationDayTallies = {
  /**
   * WHOSE days these are. Held on the tallies rather than passed alongside them
   * so a failed day cannot be attributed to an organization other than the one
   * whose walk produced it — there is exactly one tallies object per org, built
   * by `emptyDayTallies` at the top of that org's walk.
   */
  organizationId: string;
  outcomeCounts: PenseroBackfillOutcomeCounts;
  backwardAttempts: BackwardDayAttempt[];
  recheckedDays: string[];
  /** One entry per FAILED day, raw and unsanitized. */
  dayFailures: FailedUnit[];
  daysAttempted: number;
  daysSucceeded: number;
  daysFailed: number;
  rowsWritten: number;
  artifactAssociationsWritten: number;
  peopleUnbridged: number;
  degraded: boolean;
};

function emptyDayTallies(organizationId: string): OrganizationDayTallies {
  return {
    organizationId,
    outcomeCounts: emptyOutcomeCounts(),
    backwardAttempts: [],
    recheckedDays: [],
    dayFailures: [],
    daysAttempted: 0,
    daysSucceeded: 0,
    daysFailed: 0,
    rowsWritten: 0,
    artifactAssociationsWritten: 0,
    peopleUnbridged: 0,
    degraded: false,
  };
}

/** Fold one attempted day into the organization's running tallies. */
function foldDayResult(
  tallies: OrganizationDayTallies,
  planned: PlannedBackfillDay,
  dayResult: DayAttemptResult
): void {
  tallies.daysAttempted += 1;
  if (planned.reason === BackfillDayReason.Recheck) {
    tallies.recheckedDays.push(planned.day);
  }
  if (planned.reason === BackfillDayReason.Backward) {
    tallies.backwardAttempts.push({
      day: planned.day,
      succeeded: dayResult.succeeded,
    });
  }
  if (dayResult.succeeded) {
    tallies.daysSucceeded += 1;
    tallies.rowsWritten += dayResult.report?.rowsWritten ?? 0;
    tallies.artifactAssociationsWritten +=
      dayResult.report?.artifactAssociationsWritten ?? 0;
    tallies.peopleUnbridged += dayResult.report?.peopleUnbridged ?? 0;
    addOutcomeCounts(tallies.outcomeCounts, dayResult.report);
  } else {
    tallies.daysFailed += 1;
    // Recorded inside the failure branch, never beside it: a reason banked for a
    // day that succeeded would inflate the dominant cause with a case it does
    // not describe.
    if (dayResult.failureReason !== null) {
      tallies.dayFailures.push({
        organizationId: tallies.organizationId,
        reason: dayResult.failureReason,
      });
    }
  }
  tallies.degraded = tallies.degraded || dayResult.degraded;
}

/**
 * The probe's one-line answer.
 *
 * `orgsDeferred` sits beside `validated` rather than being omitted when zero:
 * an operator reading `orgs=11 validated=3` needs the other eight accounted
 * for, and "not reached" is the answer that stops them being read as healthy.
 */
export function formatValidationSummary(
  summary: PenseroDeliveryValidationSummary
): string {
  const formatted = [
    "validation=true",
    `orgs=${summary.organizationsConsidered}`,
    `validated=${summary.organizationsValidated}`,
    `orgsSkipped=${summary.organizationsSkipped}`,
    `orgsFailed=${summary.organizationsFailed}`,
    `orgsDeferred=${summary.organizationsDeferred}`,
    `rowsSeen=${summary.rowsSeen}`,
    `continuationPending=${summary.continuationPending}`,
  ].join(" ");
  return summary.organizationFailureSummary
    ? `${formatted} ${formatFailureSummary(
        summary.organizationFailureSummary,
        FailureSummaryScope.Organization
      )}`
    : formatted;
}

/** A one-line summary for the route's response body and its log line. */
export function formatSweepSummary(
  summary: PenseroBackfillSweepSummary
): string {
  return [
    `orgs=${summary.organizationsConsidered}`,
    `swept=${summary.organizationsSwept}`,
    `orgsFailed=${summary.organizationsFailed}`,
    `orgsDeferred=${summary.organizationsDeferred}`,
    `days=${summary.daysAttempted}`,
    `daysOk=${summary.daysSucceeded}`,
    `daysFailed=${summary.daysFailed}`,
    `rows=${summary.rowsWritten}`,
    `continuationPending=${summary.continuationPending}`,
  ].join(" ");
}
