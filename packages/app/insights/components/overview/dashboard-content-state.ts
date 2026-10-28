/**
 * @file dashboard-content-state.ts
 * @description What the overview dashboard is currently rendering, published to
 * the surface around it (PLN-1875 Step 8).
 *
 * The dashboard's `data-tour` anchors are not a readiness signal on their own:
 * the `stats`, `models` and `prs` wrappers render AROUND their skeletons, so a
 * reader whose sections are still in flight has a page full of measurable
 * anchors ringing placeholders — while `impact` is withheld until its row
 * settles, so the same page also has fewer beats than it will end up with. And
 * the degraded and empty branches return before any row is emitted at all, so a
 * freshly-onboarded org measures as a page with nothing to ring, which is
 * exactly what a page mid-load looks like from the DOM.
 *
 * Nothing outside this component can tell those apart by looking, so this says
 * which one it is. Derived here rather than inline so the branch that decides it
 * is a pure function a test can drive over every member.
 *
 * THREE OF THESE MEMBERS RENDER IDENTICALLY, and that is the point rather than a
 * smell: `Degraded`, `Empty` and `Quiet` all replace the body with something a
 * DOM read cannot tell apart, and they mean three different things to a consumer
 * that RECORDS an outcome — "we could not show it", "there is nothing and there
 * never has been", "there is nothing this week". Collapsing any pair of them
 * makes that consumer record a measurement it never took.
 */

/** Which of the overview dashboard's render outcomes is on screen. */
export const DashboardContentState = {
  /** Rows are still resolving; anything anchored is a skeleton. */
  Loading: "loading",
  /**
   * The body was REPLACED by the degraded branch: EVERY insights section FAILED,
   * so the dashboard had nothing at all to draw. There is no anchor on this page
   * and no amount of waiting produces one.
   *
   * SCOPED TO ALL-FAILED BY ISS-10486. One failed section used to land here, and
   * that is what made the branch dishonest: the two sections that had succeeded
   * were thrown away with it. A partially failed page draws its rows, degrades
   * the rows that read the failed section, and reports READY — it has anchors,
   * and the reader has a Retry scoped to what actually broke.
   *
   * KEPT APART FROM {@link DashboardContentState.Empty}, which renders the same
   * way and means the opposite thing. "We could not show it" is not "there was
   * nothing to show", and a consumer that records an outcome off this state
   * records a measurement it never took — the tour host used to post a
   * `defer_tour` here, asserting an emptiness it had not established, for a
   * reader whose dashboard 500'd on their first visit. The host now abandons
   * that run and reports nothing, and the server independently stamps no
   * completion off a deferral (ISS-8351). Both were needed: the server cannot
   * tell the two states apart, since the wire carries no reason and neither one
   * emits an anchor — only this enum, reported from inside the dashboard, can.
   *
   * Scoped to the whole-body degraded branch deliberately. It used to cover a
   * failed Recent Sessions read as well, which draws the whole dashboard and
   * puts an error treatment inside ONE card — five healthy beats cancelled over
   * the sixth. A failed read now costs its own beat and nothing else: the
   * emitter withholds the `sessions` anchor, so `resolveDashboardTourSteps`
   * drops that step by measurement and the run goes ahead without it.
   */
  Degraded: "degraded",
  /**
   * The body was REPLACED by the empty branch AND this org has never synced a
   * session — an all-time count of zero, established, not inferred from the
   * window the card above happens to read.
   *
   * KEPT APART FROM {@link DashboardContentState.Quiet}, which renders the same
   * way and is a different POPULATION. The Recent Sessions query is pinned to a
   * fixed seven-day window, so its zero total says only "nothing this week"; an
   * org that onboarded a month ago and paused produces the identical render and
   * the identical zero. A consumer that acts PERMANENTLY on this state — the
   * tour host stamps `finish_tour`, which retires the dashboard tour for good —
   * would otherwise silently downgrade that org's onboarding forever on the
   * strength of a recency window it never knew was load-bearing (ISS-9727
   * review, whitlockk).
   *
   * NOT a promise that it will stay that way. The session read refetches on
   * window focus and on reconnect (the shared client's defaults), so an empty
   * org that syncs its first session while the reader is in another tab
   * genuinely does become READY mid-visit. A consumer that treats this as "not
   * yet" and waits will therefore act on that later flip — which is why the tour
   * host latches instead: an unprompted modal on tab-return is worse than one
   * missed visit. The degraded branch above has no such recovery at all: the
   * insights queries never retry on their own.
   */
  Empty: "empty",
  /**
   * The body was REPLACED by the empty branch, and this org is NOT established
   * as never-having-synced: either the all-time count came back non-zero — the
   * dormant org, whose sessions are simply older than the Recent Sessions
   * window — or that read failed and established nothing at all.
   *
   * The FAILED read folds in here on purpose. Both members describe a page that
   * showed nothing, so a consumer may still report that; what only
   * {@link DashboardContentState.Empty} licenses is retiring something
   * permanently, and an unanswered count has not licensed it. Folding the
   * failure the other way would put this defect back for every reader whose
   * count read 500'd.
   *
   * ISS-11927 narrowed the dormant half to the page that still REPLACES its
   * body: the selected range hides every session this org has, and the body
   * is the date-range empty with "Show all time". A dormant org whose selected
   * range has sessions draws its rows and reports
   * {@link DashboardContentState.Ready}, because that is what is on screen.
   */
  Quiet: "quiet",
  /**
   * Every row this dashboard will draw has reached a terminal state, so the page
   * has anchors on it. NOT a claim that every row has data: since ISS-10486 a
   * row whose section failed draws its own degraded card beside rows that did
   * get theirs, and the page reports READY over that.
   */
  Ready: "ready",
} as const;
export type DashboardContentState =
  (typeof DashboardContentState)[keyof typeof DashboardContentState];

/**
 * The session read contributes two answers here, and the third is not this
 * function's to give. Still pending is LOADING — the `sessions` anchor wraps
 * `RecentSessions` whether or not its query has settled, so a dashboard whose
 * sections are done but whose list is not has one beat on a skeleton. Settled
 * is READY whether the list arrived or the read failed, because a failed read
 * still draws every other row: suppressing that beat is the EMITTER's job, done
 * by withholding one anchor, not this function's by refusing the page.
 *
 * THE ALL-TIME COUNT contributes the third, and only inside the empty branch.
 * It is a different POPULATION from every other input here — every one of those
 * describes the pinned seven-day window — so it is asked for only once that
 * window has come back empty, and its two answers split what used to be one
 * `Empty` member (ISS-9727 review). Unanswered is LOADING rather than a guess,
 * because the difference decides whether a consumer may retire something
 * permanently.
 *
 * READY means the page DREW: no row is still waiting on a read, and neither
 * body-replacing branch fired. It is no longer the stronger guarantee it was —
 * a partially failed page withholds the anchor of every row it degraded, so a
 * failure pattern that degrades them all leaves READY with nothing to ring.
 * `resolveDashboardTourSteps` measures each anchor and the host handles a
 * zero-step run, so that degrades to "no tour" rather than a tour over error
 * cards. Folding either refusal into READY would still break it, and hand the
 * host a settled page it could not tell from one that never loaded.
 *
 * SETTLED, NOT SUCCEEDED (ISS-10486). A section that errored is as terminal as
 * one that returned: its rows draw their own degraded treatment and everything
 * else draws its data. Asking for success here would have parked a partially
 * failed page on LOADING for the life of the window, reporting a skeleton over a
 * dashboard that had already drawn.
 */
export function resolveDashboardContentState({
  analyticsAllFailed,
  analyticsAllSettled,
  empty,
  emptyBodyShown,
  orgHasNeverSynced,
  orgSessionHistoryPending,
  recentSessionsPending,
}: {
  /** Every insights section reached a terminal error: nothing at all to draw. */
  analyticsAllFailed: boolean;
  /** Every insights section reached a terminal state, success or error. */
  analyticsAllSettled: boolean;
  /**
   * The pinned-window session read came back with nothing. A statement about
   * the WINDOW, never about the org — which is why it cannot decide between the
   * two empty members on its own.
   */
  empty: boolean;
  /** An all-time session count of zero, settled. Read only when `empty`. */
  orgHasNeverSynced: boolean;
  /**
   * ISS-11927: an empty body (never-synced, or the date-range empty) REPLACED
   * the rows. False on an `empty` page only for an established dormant org
   * whose selected range has sessions — it draws its rows. Read only when
   * `empty`.
   */
  emptyBodyShown: boolean;
  /** The all-time count could still answer. Read only when `empty`. */
  orgSessionHistoryPending: boolean;
  recentSessionsPending: boolean;
}): DashboardContentState {
  // Order matters and the two are not interchangeable: a failed read can also
  // report a zero total, and a failure is what that page IS.
  if (analyticsAllFailed) {
    return DashboardContentState.Degraded;
  }
  if (empty) {
    // An unanswered count is LOADING, for the same reason the window's own
    // pending read is: the page is already showing the empty body, and a
    // consumer told `Empty` here would act permanently on a population nothing
    // has established yet. The empty body is not a skeleton, so this is the one
    // place a settled-looking page still reports Loading — deliberately, since
    // the report's whole job is to say what a DOM read cannot.
    if (orgSessionHistoryPending) {
      return DashboardContentState.Loading;
    }
    if (orgHasNeverSynced) {
      return DashboardContentState.Empty;
    }
    // ISS-11927: only a REPLACED body is Quiet. An established dormant org
    // whose selected range has sessions drew its rows, and falls through.
    if (emptyBodyShown) {
      return DashboardContentState.Quiet;
    }
  }
  if (analyticsAllSettled && !recentSessionsPending) {
    return DashboardContentState.Ready;
  }
  return DashboardContentState.Loading;
}
