// Derives the merge-queue stall signal from live queue state (ISS-4450).
//
// Kept pure and separate from the route so the reasoning below is testable
// without HTTP, auth, or a network.
//
// ## Why merge-group age, and not "how long has the PR waited"
//
// The obvious metric, `now - enqueuedAt`, is wrong twice over. `enqueuedAt` is
// when the PR joined the queue and never resets, so it is inflated by (a)
// waiting for a build slot once depth exceeds `maximumEntriesToBuild`, and (b)
// merge-group REBUILDS — the queue rebuilds every entry behind it whenever the
// queue ahead changes, which restarts the checks while `enqueuedAt` stays put.
//
// `headCommit.committedDate` is the moment the currently-under-test group was
// formed. It resets on every rebuild and is unaffected by build-slot waiting,
// so it measures exactly the thing a stall makes grow.
//
// Taken as the MAX over every entry that has a group built, not just the head:
// with `mergingStrategy: ALLGREEN` several groups are under test at once, each
// passing on its own commit, so a group wedged behind the head stalls everything
// after it while the head drains. A head-only metric is blind to that.

import type {
  MergeQueueState,
  RequiredContext,
} from "@repo/github/merge-queue";
import {
  ambiguousPosterKeys,
  isConfirmedFailure,
  liveAttempts,
} from "@repo/github/required-context-attempts";

export const StallSampleStatus = {
  Ok: "ok",
  /**
   * The queue is deeper than the page we fetched, so a built group may be on a
   * page we never saw and the age max would understate — potentially all the
   * way to a falsely healthy 0.
   */
  Truncated: "truncated",
} as const;
export type StallSampleStatus =
  (typeof StallSampleStatus)[keyof typeof StallSampleStatus];

export type StallSample =
  | {
      status: typeof StallSampleStatus.Ok;
      depth: number;
      groupAgeMinutes: number;
    }
  | { status: typeof StallSampleStatus.Truncated; depth: number };

export const MS_PER_MINUTE = 60_000;

/** Two decimal places, so the emitted gauge is not a 15-digit float. */
export function roundMinutes(value: number): number {
  return Math.round(value * 100) / 100;
}

export function deriveStallSample(
  state: MergeQueueState,
  now: Date
): StallSample {
  const { totalCount, nodes } = state.entries;

  if (totalCount > nodes.length) {
    return { status: StallSampleStatus.Truncated, depth: totalCount };
  }

  // An entry with no group built yet is EXCLUDED, not counted as age 0.
  // Excluding it is what keeps the metric independent of queue depth.
  // `flatMap` rather than filter-then-map so the null is narrowed away by the
  // compiler instead of by an assertion.
  const ages = nodes.flatMap((entry) =>
    entry.headCommit === null
      ? []
      : [
          (now.getTime() - Date.parse(entry.headCommit.committedDate)) /
            MS_PER_MINUTE,
        ]
  );

  // An empty set yields 0 — the truthful reading for "nothing is under test",
  // and one that lets the monitor recover cleanly rather than going no-data.
  const rawAge = ages.length === 0 ? 0 : Math.max(...ages);

  // The clock is read before the API call, so a group formed in that window is
  // "newer than now" and the raw age goes slightly negative. A just-formed
  // group has genuinely been under test for no time.
  return {
    status: StallSampleStatus.Ok,
    depth: totalCount,
    groupAgeMinutes: roundMinutes(Math.max(0, rawAge)),
  };
}

// ## Why a second signal, and why it is not the age metric (ISS-5141)
//
// `groupAgeMinutes` keys on `headCommit.committedDate`, which RESETS every time
// the group re-forms. A merge group that fails, gets evicted, re-forms and fails
// again therefore keeps a permanently young age while the queue makes zero
// progress — observed cycling roughly every 25 minutes during the 2026-08-04
// api-stage wedge, which is why the 90-minute page never fired through hours of
// stall. The age metric catches a HUNG group; it structurally cannot catch a
// CHURNING one.
//
// It also matters without churn: GitHub does not evict a group the moment a
// check fails, it waits for the group's remaining checks to resolve. Through
// that window everything behind the entry is stalled and the failure lives on
// the merge-group commit, invisible on the PR's own Checks tab.

// ## Why no queue state decides a verdict (ISS-5833)
//
// `MergeQueueEntry.state` never decides whether a group is FAILING. It is only
// recorded — on `FailingGroup` for the diagnostic warn line, and as the
// `builtUnmergeable` tally below. This code used to treat `UNMERGEABLE` as a
// failure on GitHub's own authority; that premise was wrong. `UNMERGEABLE` is
// what the queue displays while it re-evaluates an entry against a speculative
// base that is still moving — groups ahead forming, merging, or failing — which
// under `mergingStrategy: ALLGREEN` happens routinely. ISS-5452 established that
// in the runbook, and the runbook is what this change rests on.
//
// ## What the tick counts do and do NOT show
//
// Over 2026-08-07 → 2026-08-10, 105 of the 116 ticks that published a non-zero
// count were attributable solely to entries in `UNMERGEABLE`. Those warn lines
// all carried `contexts: []` — but that is NOT evidence the groups had no red
// required check, because the branch removed here pushed `contexts: []` and
// skipped the rollup read entirely. The old shape cannot tell the two cases
// apart. Read 105/116 as "how often the state shortcut alone drove the gauge",
// never as a measured false-positive rate. It is also a share of TICKS, not of
// episodes or pages: `UNMERGEABLE` runs spanned 1–6 ticks while real failures
// were often a single tick, so the episode-level share is materially lower.
//
// Removing the branch does NOT make an `UNMERGEABLE` entry invisible: it is now
// judged on its contexts like any other, so one that really does carry a red
// required context still counts. Only the state-alone shortcut is gone — and
// `builtUnmergeable` keeps the population observable, so the question the old
// data could not answer becomes answerable after this ships.

/**
 * `MergeQueueEntry.state`, for the OBSERVABILITY tally only — never for a
 * verdict. The field is parsed as an open string upstream so a new GitHub enum
 * member cannot break the read.
 */
const MergeQueueEntryState = { Unmergeable: "UNMERGEABLE" } as const;

export const FailedGroupsStatus = {
  Ok: "ok",
  /**
   * The answer is not known for this tick. Emitted rather than a 0 when at least
   * one BUILT group could not be judged — its context page was truncated, a
   * required status context would not say who posted it (ISS-5386), or the
   * required set could not be established — and no other group was confirmed
   * failing. A 0 there could be hiding a red required check, and a confident
   * false-healthy is worse than no reading.
   *
   * Note the "at least one built group" qualifier: a queue with nothing built
   * has nothing to be uncertain about, so it reports a truthful `Ok`/0 even when
   * the required set is unreadable. See `deriveFailedGroups`.
   */
  Unknown: "unknown",
} as const;
export type FailedGroupsStatus =
  (typeof FailedGroupsStatus)[keyof typeof FailedGroupsStatus];

export type FailingGroup = {
  /** NULL only if GitHub returned an entry with no PR, which it should not. */
  pullRequest: number | null;
  /** The merge-group commit the failure is recorded against, not the PR head. */
  oid: string;
  /** Diagnostic only — never the reason this group is counted (ISS-5833). */
  state: string;
  /**
   * Required contexts observed failing. NEVER empty: a failing group is one a
   * required context terminally failed on, so the context that condemned it is
   * always named. Emptiness was the `UNMERGEABLE` shortcut, which is gone.
   *
   * There is no `truncated` flag: a group whose context page was cut short is
   * never confirmed failing, it is counted as unresolved instead, so a confirmed
   * failure is always read from a complete page.
   */
  contexts: string[];
};

export type FailedGroupsSample =
  | {
      status: typeof FailedGroupsStatus.Ok;
      failedGroups: number;
      failing: FailingGroup[];
      /**
       * Built groups whose answer could not be established this tick. Non-zero
       * makes `failedGroups` a LOWER BOUND — the count is still published,
       * because a confirmed failure elsewhere does not stop being a fact.
       */
      unresolved: number;
      /** See `countBuiltUnmergeable`. Never moves `failedGroups`. */
      builtUnmergeable: number;
    }
  | {
      status: typeof FailedGroupsStatus.Unknown;
      reason: string;
      /**
       * Carried on THIS arm too, deliberately. The tally is read from queue
       * state alone, so it stays knowable exactly when the contexts are not —
       * and an `Unknown` tick is the one someone later asks whether the ISS-5833
       * exclusion was justified on. Reporting `null` there would answer with a
       * number we held and threw away, when `null` has to mean genuinely
       * unknown. See `countBuiltUnmergeable`.
       */
      builtUnmergeable: number;
    };

/**
 * Names the CAUSE on the Unknown arm. Two distinct ones reach it, and reporting
 * an unreadable poster as a page that "could not be fully read" would send
 * on-call hunting a pagination bug on a page that was complete.
 */
function unresolvedReason(
  unreadablePage: number,
  ambiguousPoster: number
): string {
  const clauses: string[] = [];
  if (unreadablePage > 0) {
    clauses.push(
      `${unreadablePage} built group(s) had contexts that could not be fully read`
    );
  }
  if (ambiguousPoster > 0) {
    clauses.push(
      `${ambiguousPoster} built group(s) had a required status context with no creator, so its poster could not be established`
    );
  }
  return `${clauses.join("; ")}, and no other group was confirmed failing`;
}

/**
 * Counts merge groups that are red RIGHT NOW.
 *
 * An entry counts on ONE condition: it has a BUILT group and a required context
 * has terminally failed. That is the only state that reflects a check having
 * actually run and reported red. A queue `state` — `UNMERGEABLE` above all — is
 * not a verdict and is deliberately not consulted (ISS-5833).
 *
 * Requiring a built group is load-bearing, not defensive: an entry with no group
 * has no merge-group commit and therefore no rollup to read, so there is nothing
 * to judge it on. Merge-conflicted PRs additionally sit in that state
 * indefinitely (two of seven live entries on a healthy queue).
 */
export function deriveFailedGroups(
  state: MergeQueueState,
  required: readonly RequiredContext[]
): FailedGroupsSample {
  // An empty required set is NOT an early return, even though every verdict here
  // is context-based. An early return would also publish `Unknown` for an IDLE
  // queue with no group built at all, where a truthful 0 is the right reading —
  // uncertainty is per BUILT group, and a queue with nothing built has nothing
  // to be uncertain about. Letting the loop run is what keeps those two apart.
  //
  // Scope note: this is the `Ok`-with-no-required-rule case only. `route.ts`
  // resolves a FAILED or MALFORMED ruleset read to `Unknown` before calling this
  // function at all, so an unreadable-ruleset idle queue publishes nothing
  // regardless of what happens here.
  const contextVerdictsKnown = required.length > 0;

  // Recorded, never acted on — see the ISS-5833 note above. Counted up front
  // rather than in the loop because both returns below owe it: the tally does
  // not depend on any verdict, so it survives the ones that have none.
  const builtUnmergeable = countBuiltUnmergeable(state);
  const failing: FailingGroup[] = [];
  // Split by CAUSE so the Unknown arm can name the real one. All three feed the
  // same `unresolved` total, which is what the Ok arm publishes as a lower
  // bound. Only the latter two can reach `unresolvedReason`: the first is
  // gated on `contextVerdictsKnown`, whose arm carries its own fixed reason.
  let unjudgeableSet = 0;
  let unreadablePage = 0;
  let ambiguousPoster = 0;

  for (const entry of state.entries.nodes) {
    if (entry.headCommit === null) {
      continue;
    }

    if (!contextVerdictsKnown) {
      // Nothing to intersect against, so this group's contexts cannot be
      // judged. Unresolved, not clean — an absence of evidence is not evidence
      // of absence.
      unjudgeableSet++;
      continue;
    }

    const rollup = entry.headCommit.statusCheckRollup;
    const nodes = rollup?.contexts.nodes ?? [];
    // READABLE nodes, not array length. The boundary schema maps a node it
    // cannot parse to a null PLACEHOLDER, which keeps the array the same length
    // — so comparing against `nodes.length` would see no gap, skip the
    // unreadable node, and report the group clean. Counting what is actually
    // readable is what makes a dropped node register as missing information.
    const readable = nodes.filter((node) => node !== null);

    // `totalCount` is the server's own count and is never recomputed from
    // `nodes`, so this covers a cut page and a dropped node alike.
    if ((rollup?.contexts.totalCount ?? 0) > readable.length) {
      // Unresolved whatever is visible, in BOTH directions. The rollup returns
      // one node per re-run ATTEMPT, so a cut page can hide the FAILURE that
      // makes a group red, and can equally hide the newer SUCCESS that already
      // retired a visible FAILURE. The earlier rule counted the visible failure
      // and claimed truncation "cannot invent one"; at attempt granularity it
      // can, and a false page costs more trust than a deferred one.
      unreadablePage++;
      continue;
    }

    // A different unreadable dimension: the page is whole, but a required status
    // will not say who posted it, so the rule it satisfies cannot be
    // established. Unlike a cut page — which hides unknown OTHER nodes and so
    // condemns the whole group — this is scoped to the one rule that status
    // could have satisfied. See `ambiguousStatusPosterKey` (ISS-5386).
    const ambiguousKeys = ambiguousPosterKeys(readable, required);

    const contexts = [
      ...new Set(
        liveAttempts(readable, required)
          .filter((attempt) => isConfirmedFailure(attempt, ambiguousKeys))
          .map((attempt) => attempt.name)
      ),
    ];

    if (contexts.length > 0) {
      failing.push({
        pullRequest: entry.pullRequest?.number ?? null,
        oid: entry.headCommit.oid,
        state: entry.state,
        contexts,
      });
      continue;
    }

    // Nothing was confirmed, and at least one rule's verdict turned on a poster
    // we could not read — so the honest answer for this group is not known.
    if (ambiguousKeys.size > 0) {
      ambiguousPoster++;
    }
  }

  // Uncertainty is PER GROUP, not global. A confirmed failure elsewhere in the
  // queue remains a fact, so it publishes as a lower bound instead of being
  // suppressed: the monitor fires on `>= 1`, and going dark during a churning
  // wedge — exactly when re-run attempts inflate a rollup past one page — is the
  // outage this signal exists to catch. Unknown is reserved for the case where
  // uncertainty is ALL there is.
  const unresolved = unjudgeableSet + unreadablePage + ambiguousPoster;

  if (unresolved > 0 && failing.length === 0) {
    return {
      status: FailedGroupsStatus.Unknown,
      reason: contextVerdictsKnown
        ? unresolvedReason(unreadablePage, ambiguousPoster)
        : "the required-context set is empty or could not be read, so no built group's contexts could be judged",
      builtUnmergeable,
    };
  }

  return {
    status: FailedGroupsStatus.Ok,
    failedGroups: failing.length,
    failing,
    unresolved,
    builtUnmergeable,
  };
}

/**
 * Built groups sitting in `UNMERGEABLE`, whatever their verdict. Purely
 * diagnostic — it never moves `failedGroups`.
 *
 * It exists because ISS-5833 removed the only path that made this population
 * visible: such a group now produces no failure, no warn line, and a published
 * 0, so a wrong premise would be undetectable and the decision unreversible on
 * evidence. Riding it on the per-tick log keeps the population countable against
 * `failedGroups` after deploy.
 *
 * Exported because the verdict is not the only thing that has to carry it. The
 * route resolves an unreadable ruleset to `Unknown` WITHOUT calling
 * `deriveFailedGroups` at all, so that path has no sample to read the tally off
 * — and it is a path where the queue state was read fine and the population is
 * therefore known. Queue state is the only input, so this answers wherever that
 * read succeeded.
 */
export function countBuiltUnmergeable(state: MergeQueueState): number {
  // Built groups only, matching `deriveFailedGroups`: an entry with no
  // merge-group commit is not a group under test, and merge-conflicted PRs sit
  // in `UNMERGEABLE` with a null `headCommit` indefinitely.
  return state.entries.nodes.filter(
    (entry) =>
      entry.headCommit !== null &&
      entry.state === MergeQueueEntryState.Unmergeable
  ).length;
}
