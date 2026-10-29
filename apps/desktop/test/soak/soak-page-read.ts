/**
 * @file soak-page-read.ts
 * @description ISS-6100 — grading for one sample of the production Sessions
 * page-data IPC.
 *
 * The grade used to be the PRESENCE OF A KEY:
 *
 * ```ts
 * if (result && typeof result === "object" && "list" in result) { stats.ok += 1; }
 * ```
 *
 * `{ list: [] }` — and `{ list: { items: [], total: 0 } }` — scored `ok`. During
 * the heaviest drain windows, exactly when a read is most likely to come back
 * empty or partial, the harness could not tell "answered correctly" from
 * "answered emptily". That is the loading-vs-true-zero conflation the logical-QA
 * discipline exists to catch, sitting inside the oracle itself.
 *
 * Grading now needs CONTENT:
 *
 *  - `list.items` must be a non-empty array, and
 *  - `list.total` must not have fallen below the population established for this
 *    query at the start of the cycle.
 *
 * The expected population is established once per cycle, from a read taken after
 * the app authenticates and before the drain poll begins — the "expected
 * population for the query" in the ticket's words. It is compared with `>=`
 * rather than `===` on purpose: sync never deletes local sessions, but a
 * collector may legitimately ADD one mid-cycle, and a harness that reddened on
 * legitimate growth would be a false-alarm generator. A read that SHRINKS is the
 * failure this ticket is about, and `>=` catches every one of them.
 *
 * Note what this probe is and is not evidence of, since the ticket's second
 * point is that the harness never named it: `pageData` is the DESKTOP's LOCAL
 * read. It measures local read responsiveness and correctness while the sync
 * drain runs. It is not evidence about the cloud — that is what the read-back
 * pass in `soak-cloud-content.ts` covers.
 */

import type { PageReadGrade, PageReadStats } from "./soak-types";

export const PageReadOutcome = {
  Ok: "ok",
  /** The list answered, but with zero rows. */
  Empty: "empty",
  /** The list answered with fewer rows in total than the established population. */
  Short: "short",
  /** Not a page-data shape at all. */
  Malformed: "malformed",
} as const;
export type PageReadOutcome =
  (typeof PageReadOutcome)[keyof typeof PageReadOutcome];

type PageDataShape = {
  list?: { items?: unknown; total?: unknown } | null;
};

/**
 * True only for a value that can actually be a population size.
 *
 * `typeof total === "number"` is not that test: it admits `NaN`, `Infinity`,
 * negatives and fractions. `NaN` is the dangerous one — it passes the type
 * check, then makes EVERY subsequent comparison false, so a `NaN` total slips
 * past the short-read check and scores Ok, and `Math.min` in
 * `applyPageReadGrade` poisons `shortestTotal` for the rest of the cycle. A
 * value that cannot be a population is malformed, not a passing read.
 */
function isPopulationTotal(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Grade one page-data result against the population established for this cycle.
 *
 * `expectedTotal` of `null` means the population is not established yet — the
 * establishing read itself — so only the non-degenerate checks apply.
 */
export function gradePageRead(
  result: unknown,
  expectedTotal: number | null
): PageReadGrade {
  if (!(result && typeof result === "object")) {
    return { outcome: PageReadOutcome.Malformed, itemCount: null, total: null };
  }
  const list = (result as PageDataShape).list;
  if (!(list && typeof list === "object")) {
    return { outcome: PageReadOutcome.Malformed, itemCount: null, total: null };
  }
  const { items, total } = list;
  if (!(Array.isArray(items) && isPopulationTotal(total))) {
    return { outcome: PageReadOutcome.Malformed, itemCount: null, total: null };
  }
  if (items.length === 0) {
    return { outcome: PageReadOutcome.Empty, itemCount: 0, total };
  }
  if (total < items.length) {
    // A population smaller than the page it just returned cannot be true of any
    // real read. Grading it Ok (or Short) would report a number the answer
    // itself contradicts.
    return { outcome: PageReadOutcome.Malformed, itemCount: null, total: null };
  }
  if (expectedTotal !== null && total < expectedTotal) {
    return {
      outcome: PageReadOutcome.Short,
      itemCount: items.length,
      total,
    };
  }
  return { outcome: PageReadOutcome.Ok, itemCount: items.length, total };
}

/** Fold one grade into the cycle's accumulated page-read stats. */
export function applyPageReadGrade(
  stats: PageReadStats,
  grade: PageReadGrade,
  elapsedMs: number
): void {
  if (grade.outcome === PageReadOutcome.Ok) {
    stats.ok += 1;
    stats.latenciesMs.push(elapsedMs);
    return;
  }
  if (grade.outcome === PageReadOutcome.Empty) {
    stats.empty += 1;
    return;
  }
  if (grade.outcome === PageReadOutcome.Short) {
    stats.short += 1;
    stats.shortestTotal =
      stats.shortestTotal === null
        ? grade.total
        : Math.min(stats.shortestTotal, grade.total ?? stats.shortestTotal);
    return;
  }
  stats.errors += 1;
}

/**
 * One raw page-data read: its result, how long it took, and whether the read
 * deadline won the race. The Playwright/Electron read that produces this lives
 * in `soak-app.ts`; keeping the SHAPE here is what lets the two functions below
 * be graded and tested without an Electron runtime.
 */
export type PageReadSample = {
  result: unknown;
  elapsedMs: number;
  timedOut: boolean;
  /**
   * ISS-6102 — how long the `pageData` call took INSIDE the renderer, as the
   * settled evaluation itself reported it, or `null` when it never got to
   * report one (the deadline won the race). Never defaulted to `0`: a missing
   * measurement and a zero-millisecond read are opposite facts.
   */
  rendererMs: number | null;
  /** Set only on a timed-out sample. See {@link classifyTimeoutPhase}. */
  timeoutPhase: PageReadTimeoutPhase | null;
  /**
   * ISS-6102 — how long this read spent getting INTO the renderer: the gap
   * between the instant the runner issued `page.evaluate` and the instant the
   * renderer began executing it. Measured on BOTH paths — a settled read reports
   * it directly, a timed-out one has it read back off its own in-flight mark —
   * because the timed-out reads are the population the question is asked about.
   * `null` whenever no usable start instant was reported for THIS read.
   *
   * This is the half of the harness segment that `rendererMs` cannot see.
   * `elapsedMs - rendererMs` is the WHOLE harness cost but says nothing about
   * which direction it was paid in, and the two have different meanings: time
   * paid on the way OUT is time the app had not started working yet, while time
   * paid on the way BACK is the CDP serialization of a page-data payload no
   * real user ever receives.
   */
  dispatchMs: number | null;
};

/**
 * ISS-6102 — where a timed-out page read lost its deadline.
 *
 * `elapsedMs` is measured in the Playwright runner and spans three segments the
 * harness has never separated: the db-host read, the renderer/main IPC, and the
 * runner's own CDP round trip. A timeout count over that sum cannot tell the
 * three apart, which is why criterion 4 has been arguable rather than
 * measurable — a db-host change (ISS-6079/#4890) that moves the first segment
 * reads as neutral if the deadline was actually lost in the third.
 *
 * The renderer stamps an in-flight mark before it calls `pageData` and records
 * the INSTANT the call settles. Comparing that instant with the deadline instant
 * the runner actually lost is a single bit that does separate them, and it costs
 * one tiny CDP call on the timeout path only.
 */
export const PageReadTimeoutPhase = {
  /**
   * The read had not REACHED the renderer when the deadline fired: the
   * renderer's evaluation began after the deadline instant, so every
   * millisecond the read lost was spent in the outbound CDP dispatch hop and
   * none of it below the renderer boundary.
   *
   * Distinct from {@link PageReadTimeoutPhase.InRenderer} because the two are
   * opposite answers to the question the split asks. A read that started late
   * has an outstanding `pageData` call at the deadline in the trivial sense
   * that it has no call at all yet, and folding it into `inRenderer` reports a
   * request that never arrived as a db-host cost — the same axis collapse this
   * split exists to remove, one level down. Distinct from
   * {@link PageReadTimeoutPhase.AboveRenderer} too: that one is the return leg,
   * a payload the app already produced, and a lane acting on the two would look
   * in opposite directions.
   */
  PreRenderer: "preRenderer",
  /**
   * The renderer's own `pageData` call was still outstanding at the deadline —
   * the time is at or below the renderer boundary (db-host read, lane
   * admission, or the main-process IPC hop).
   */
  InRenderer: "inRenderer",
  /**
   * The renderer's call had ALREADY settled when the deadline won, so the time
   * was lost above it: in the CDP transport of the result back to the runner,
   * or in the runner's own event loop.
   */
  AboveRenderer: "aboveRenderer",
  /**
   * The mark could not be read, belonged to a different read, or carried no
   * usable settle instant.
   */
  Unknown: "unknown",
} as const;
export type PageReadTimeoutPhase =
  (typeof PageReadTimeoutPhase)[keyof typeof PageReadTimeoutPhase];

/**
 * One counter per phase. A `Record` over the union rather than a hand-written
 * three-key object, so adding a fourth phase fails `tsc` at every counter and
 * initializer instead of silently never being counted anywhere.
 */
export type PageReadTimeoutPhaseCounts = Record<PageReadTimeoutPhase, number>;

/**
 * The renderer's in-flight mark as the follow-up probe reads it back.
 *
 * `settledAt` is an ABSOLUTE instant (epoch ms, the renderer's `Date.now()`),
 * not a duration, because the only question the phase split asks is whether the
 * call was still outstanding AT the runner's deadline instant — and a duration
 * cannot answer that without also knowing when the call started. `null` means
 * the call had not settled when the probe read the mark.
 *
 * `readId` is which read published the mark. The mark lives at a fixed key on
 * `window`, and it is published INSIDE the evaluation, so a read whose CDP
 * dispatch has not landed yet leaves the PREVIOUS read's mark sitting there —
 * long settled, and about a different read. Without the identity check that
 * stale mark is indistinguishable from a fast one and scores
 * {@link PageReadTimeoutPhase.AboveRenderer}, which is precisely the
 * misattribution the absolute timestamp exists to remove.
 */
export type PageReadRendererMark = {
  readId: string;
  settledAt: number | null;
  /**
   * ISS-6102 — the absolute instant the renderer BEGAN executing this read's
   * evaluation, stamped synchronously as the mark is published.
   *
   * `settledAt` alone cannot separate a slow app from a slow instrument. A read
   * whose CDP dispatch stalled 9.5s and then ran `pageData` for 1s settles at
   * 10.5s, past a 10s deadline, and is indistinguishable by settle instant
   * alone from a read that started immediately and spent the whole 10.5s in the
   * db-host — yet the first lost its deadline entirely in the harness and the
   * second lost it entirely in the app. That is the same defect one level up
   * from the duration-vs-budget one this mark was introduced to fix: a phase
   * inferred without the instant that settles it.
   *
   * `null` when the renderer did not report one — an older mark shape or an
   * unusable read. A start instant is never DEFAULTED, because a missing one
   * and an instant of zero are opposite facts, and the classifier must fall
   * back to the settle-instant rule rather than act on a fabricated start.
   */
  startedAt: number | null;
};

/**
 * What a mark has to match to be evidence about THIS read: the read that
 * published it, and the absolute instant its deadline fired at.
 */
export type PageReadDeadlineInstant = {
  readId: string;
  /** Epoch ms, on the same clock the renderer stamps `settledAt` with. */
  deadlineAt: number;
};

/**
 * How long a page read is given before the runner declares it timed out.
 *
 * Lives here rather than in `soak-app.ts` because {@link classifyTimeoutPhase}
 * cannot decide a phase without it (see the settle-window rule there), and this
 * module is the half that runs without an Electron/Playwright runtime.
 */
export const PAGE_READ_DEADLINE_MS = 10_000;

/**
 * How long the follow-up mark probe gets before the runner gives up on it.
 *
 * The probe is only ever issued on the timeout path — that is, only once the
 * renderer is already suspect — and a renderer that is WEDGED rather than merely
 * slow never answers it at all. A `try/catch` around that `page.evaluate` bounds
 * a rejection and nothing else, so an unbounded await there hangs the very read
 * whose timeout it was called to explain: the deadline fires, the sample is
 * never built, and the soak cycle emits no result for a state that is exactly
 * what the harness exists to catch.
 *
 * Short on purpose. This is one tiny CDP round trip on an app that has already
 * blown a {@link PAGE_READ_DEADLINE_MS} budget; a probe that has not answered in
 * this long is not going to, and an unattributed timeout beats a lost cycle.
 */
export const RENDERER_MARK_PROBE_DEADLINE_MS = 2000;

/**
 * Classify a timed-out sample from the renderer's in-flight mark.
 *
 * A mark that is absent, that belongs to a different read, or whose `settledAt`
 * is not a usable instant is {@link PageReadTimeoutPhase.Unknown} — never
 * folded into either real phase. Attributing an unreadable mark would put a
 * fabricated count behind the exact question this split exists to answer.
 *
 * **The comparison is instant-vs-instant, never duration-vs-budget.** A
 * duration says how long the renderer's call RAN, not when it ran, so a call
 * that started late still looks short: 9.5s of CDP dispatch followed by a 1s
 * `pageData` is a call still in flight when the 10s deadline fires, yet its
 * duration (1s) is comfortably inside the budget. Judging it on duration files
 * it under "the db-host was fine, the harness was the cost" — inverting the
 * answer in the case that matters most, and corrupting the one attribution this
 * whole split exists to produce. The mark therefore carries the absolute
 * instant the call settled, and the test is whether that instant is past the
 * deadline instant the runner actually lost.
 *
 * **This phase deliberately answers ONE question — where the read had got to at
 * the deadline instant — and the dispatch hop is reported as a NUMBER beside
 * it, never folded in.** "Still outstanding at the deadline" does not by itself
 * say the time went below the renderer: a read whose CDP dispatch stalls 9.5s
 * and then runs `pageData` for 1s is outstanding at a 10s deadline, yet 9.5s of
 * what it lost was spent getting there. An apportionment rule that scored that
 * `aboveRenderer` would answer a SECOND question ("which segment was the larger
 * share") under the same three-valued enum, and a share of 50.01% would then be
 * indistinguishable in `timeoutPhases` from a request that never arrived at
 * all — the exact distinction-collapse this split exists to remove, reintroduced
 * in its own output. {@link PageReadStats.timeoutDispatchLatenciesMs} carries
 * the share instead, so a lane reads the phase counts and the dispatch
 * percentiles together and neither has to stand in for the other.
 *
 * The independence runs the other way too, and it is why a phase is still
 * decided when the dispatch number cannot be: a mark whose `settledAt` is
 * usable but whose `startedAt` is not still says exactly where the read had got
 * to, and scoring it {@link PageReadTimeoutPhase.Unknown} to signal the missing
 * NUMBER would throw away a sound phase to report a different gap in the wrong
 * counter. That gap has its own counter —
 * {@link PageReadStats.timeoutDispatchUnmeasured} — which is what keeps the
 * omission visible without corrupting this one.
 *
 * An UNUSABLE `startedAt` and a usable one PAST the deadline are opposite cases
 * and are treated as such. The first leaves only the dispatch number
 * unanswerable and the phase intact; the second answers the phase question
 * itself — the read had not reached the renderer at all — and is
 * {@link PageReadTimeoutPhase.PreRenderer}. Conflating them is how a read still
 * sitting in the outbound hop came to be reported as time spent below the
 * renderer boundary.
 */
export function classifyTimeoutPhase(
  mark: PageReadRendererMark | null,
  expected: PageReadDeadlineInstant
): PageReadTimeoutPhase {
  if (mark === null || mark.readId !== expected.readId) {
    return PageReadTimeoutPhase.Unknown;
  }
  // The start instant is consulted BEFORE the settle rule, because it can
  // falsify the settle rule's premise. `settledAt === null` means "not settled
  // when the probe looked", which reads as "still in the renderer" only if the
  // read was ever IN the renderer by the deadline; a start instant past the
  // deadline says it was not, and the probe runs for up to
  // RENDERER_MARK_PROBE_DEADLINE_MS after the deadline, so an evaluation that
  // lands during the probe publishes exactly that mark. Ordering the settle rule
  // first would report every one of them as `inRenderer`.
  if (isUsableInstant(mark.startedAt) && mark.startedAt > expected.deadlineAt) {
    return PageReadTimeoutPhase.PreRenderer;
  }
  if (mark.settledAt === null) {
    return PageReadTimeoutPhase.InRenderer;
  }
  if (!isUsableInstant(mark.settledAt)) {
    return PageReadTimeoutPhase.Unknown;
  }
  if (mark.settledAt > expected.deadlineAt) {
    return PageReadTimeoutPhase.InRenderer;
  }
  return PageReadTimeoutPhase.AboveRenderer;
}

/**
 * True only for a value that can actually be a wall-clock instant. Shared by
 * both instants on the mark so neither can drift into accepting a `NaN`, an
 * `Infinity`, or a zero that a missing measurement was coerced into.
 */
function isUsableInstant(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

/**
 * ISS-6100 — establish the population this cycle's page reads are graded
 * against, from one read taken after the app authenticates and before the drain
 * poll begins.
 *
 * Returns the observed total, or `null` when the establishing read timed out,
 * threw, or itself came back degenerate; the caller records that as a fail
 * reason rather than silently grading the rest of the cycle against nothing.
 */
export async function establishPageReadPopulation(
  readOnce: () => Promise<PageReadSample>,
  stats: PageReadStats
): Promise<number | null> {
  let sample: PageReadSample;
  try {
    sample = await readOnce();
  } catch {
    return null;
  }
  if (sample.timedOut) {
    return null;
  }
  const grade = gradePageRead(sample.result, null);
  if (grade.outcome !== PageReadOutcome.Ok || grade.total === null) {
    return null;
  }
  stats.expectedTotal = grade.total;
  return grade.total;
}

/**
 * Fold one drain-time sample into the cycle's stats. A timeout is recorded as a
 * timeout; anything else is graded on CONTENT against the established
 * population.
 */
export function recordPageReadSample(
  stats: PageReadStats,
  sample: PageReadSample
): void {
  if (sample.timedOut) {
    stats.timeouts += 1;
    stats.timeoutPhases[sample.timeoutPhase ?? PageReadTimeoutPhase.Unknown] +=
      1;
    // Counted in the branch where the measurement actually failed, never
    // inferred later from a length: every timeout lands in exactly one of these
    // two, so the dispatch percentiles can always be published with the share of
    // the population they were computed over.
    if (sample.dispatchMs === null) {
      stats.timeoutDispatchUnmeasured += 1;
    } else {
      stats.timeoutDispatchLatenciesMs.push(sample.dispatchMs);
    }
    return;
  }
  const grade = gradePageRead(sample.result, stats.expectedTotal);
  applyPageReadGrade(stats, grade, sample.elapsedMs);
  // Only an ok read contributes a renderer latency, so the two latency series
  // describe the SAME population and their difference is the harness segment
  // rather than a mix of graded and degenerate reads.
  if (grade.outcome === PageReadOutcome.Ok && sample.rendererMs !== null) {
    stats.rendererLatenciesMs.push(sample.rendererMs);
  }
  // The ok population's dispatch hop is tallied on BOTH sides for the same
  // reason the timeout population's is: a settled read can still fail to
  // produce a usable cross-process delta (a wall-clock step ordering the two
  // instants backwards, an older mark shape), and a percentile over whichever
  // reads survived that reads as a statement about every ok read in the cycle.
  // Counted in the branch where the measurement actually failed, never inferred
  // later from a length, so `dispatchLatenciesMs.length + dispatchUnmeasured`
  // is always exactly `ok`.
  if (grade.outcome === PageReadOutcome.Ok) {
    if (sample.dispatchMs === null) {
      stats.dispatchUnmeasured += 1;
    } else {
      stats.dispatchLatenciesMs.push(sample.dispatchMs);
    }
  }
}

/** What the renderer-side evaluation hands back on the settled path. */
export type PageReadEvaluation = {
  value: unknown;
  rendererMs: number;
  /**
   * ISS-6102 — the absolute instant the renderer began executing, the same one
   * it published on the in-flight mark. Returned on the settled path as well so
   * dispatch latency is measurable on EVERY graded read rather than only on the
   * timeouts, which is what lets a cycle rank the three segments against each
   * other instead of only attributing its failures.
   */
  rendererStartedAt: number;
};

/**
 * Distinguishes a bound winning its race from any value the racer could itself
 * resolve. Shared by the read deadline and the mark-probe bound.
 */
const TIMEOUT_SENTINEL = Symbol("page-read-timeout");

/**
 * Race one renderer evaluation against the read deadline and build the sample.
 *
 * This lives here rather than in `soak-app.ts` for a coverage reason, not a
 * tidiness one: it is the only part of the probe that DECIDES anything — which
 * branch a sample took, whether the renderer mark is consulted at all, and
 * which phase the deadline loss is attributed to. Left inline beside the two
 * `page.evaluate` calls it would need Electron to reach, so a regression that
 * hardcoded a phase, swapped the two branches, or dropped `rendererMs` on the
 * floor would be invisible to every test. The Playwright-bound halves are
 * injected, so all of that is drivable from a unit test.
 */
export async function raceReadAgainstDeadline(deps: {
  evaluation: Promise<PageReadEvaluation>;
  /** Identity of this read, matched against the mark the renderer published. */
  readId: string;
  /** Epoch ms at which this read was launched, on {@link deps.now}. */
  startedAt: number;
  /**
   * The clock, in epoch ms. Injected rather than read from `Date.now()` so the
   * race is drivable from a unit test, and deliberately the SAME wall clock the
   * renderer stamps `settledAt` with — the two instants are only comparable
   * because both are `Date.now()` on the one host the soak runs on.
   */
  now: () => number;
  sleep: (ms: number) => Promise<unknown>;
  readRendererMark: () => Promise<PageReadRendererMark | null>;
  deadlineMs?: number;
  markProbeDeadlineMs?: number;
}): Promise<PageReadSample> {
  const deadlineMs = deps.deadlineMs ?? PAGE_READ_DEADLINE_MS;
  // A read that rejects AFTER the deadline already won the race would be an
  // unhandled rejection; this handler marks it handled without hiding it from
  // the race below.
  deps.evaluation.catch(() => undefined);
  const raced = await Promise.race([
    deps.evaluation,
    deps.sleep(deadlineMs).then(() => TIMEOUT_SENTINEL),
  ]);
  const elapsedMs = deps.now() - deps.startedAt;
  // The sentinel is the only symbol either racer can produce, and `typeof`
  // narrows where an identity compare against a widened `symbol` does not.
  if (typeof raced === "symbol") {
    // ONE mark read, feeding both the phase and the dispatch number. Probing
    // twice would compare a phase against a dispatch measured from a different
    // observation of a moving object, and would pay a second CDP round trip on
    // the path that is already over budget.
    const mark = await readMarkWithinBound(
      deps.readRendererMark,
      deps.sleep,
      deps.markProbeDeadlineMs ?? RENDERER_MARK_PROBE_DEADLINE_MS
    );
    const expected = {
      readId: deps.readId,
      deadlineAt: deps.startedAt + deadlineMs,
    };
    return {
      result: raced,
      elapsedMs,
      timedOut: true,
      rendererMs: null,
      // Only THIS read's mark can say when THIS read reached the renderer. A
      // stale or absent mark leaves the dispatch unmeasured rather than
      // borrowing the previous read's, which is the same identity rule the
      // phase is decided by.
      dispatchMs:
        mark !== null && mark.readId === expected.readId
          ? dispatchLatency(mark.startedAt, deps.startedAt)
          : null,
      timeoutPhase: classifyTimeoutPhase(mark, expected),
    };
  }
  return {
    result: raced.value,
    elapsedMs,
    timedOut: false,
    rendererMs: raced.rendererMs,
    dispatchMs: dispatchLatency(raced.rendererStartedAt, deps.startedAt),
    timeoutPhase: null,
  };
}

/**
 * How long the read spent reaching the renderer, or `null` when that cannot be
 * stated.
 *
 * A negative result is rejected rather than clamped to `0`. The two instants are
 * `Date.now()` reads taken in two different processes, so a wall-clock step
 * between them can order them backwards; a clamp would turn that into a
 * confident "dispatch was instant" and fold a corrupt sample into the very
 * percentile it would distort. Absent is the honest representation.
 */
function dispatchLatency(
  rendererStartedAt: number | null,
  runnerStartedAt: number
): number | null {
  if (!isUsableInstant(rendererStartedAt)) {
    return null;
  }
  const dispatchMs = rendererStartedAt - runnerStartedAt;
  return dispatchMs >= 0 ? dispatchMs : null;
}

/**
 * Read the renderer's in-flight mark, bounded by
 * {@link RENDERER_MARK_PROBE_DEADLINE_MS}.
 *
 * Two failure modes, one answer. A probe that REJECTS is caught — a mark we
 * could not read is `unknown`, never a thrown sample that would score an
 * already-recorded timeout as an error instead. A probe that never SETTLES is
 * the one a `catch` cannot touch, and it is the likelier of the two here: this
 * runs only after a read already blew its deadline, so a wedged renderer is the
 * state being probed. Racing it against its own bound is what keeps a wedged
 * renderer costing one unattributed timeout rather than the whole cycle's
 * result.
 */
async function readMarkWithinBound(
  readRendererMark: () => Promise<PageReadRendererMark | null>,
  sleep: (ms: number) => Promise<unknown>,
  probeDeadlineMs: number
): Promise<PageReadRendererMark | null> {
  const raced = await Promise.race([
    readRendererMark().catch(() => null),
    sleep(probeDeadlineMs).then(() => TIMEOUT_SENTINEL),
  ]);
  return typeof raced === "symbol" ? null : raced;
}

export function newPageReadStats(): PageReadStats {
  return {
    ok: 0,
    errors: 0,
    timeouts: 0,
    empty: 0,
    short: 0,
    expectedTotal: null,
    shortestTotal: null,
    latenciesMs: [],
    rendererLatenciesMs: [],
    dispatchLatenciesMs: [],
    dispatchUnmeasured: 0,
    timeoutDispatchLatenciesMs: [],
    timeoutDispatchUnmeasured: 0,
    timeoutPhases: {
      preRenderer: 0,
      inRenderer: 0,
      aboveRenderer: 0,
      unknown: 0,
    },
  };
}
