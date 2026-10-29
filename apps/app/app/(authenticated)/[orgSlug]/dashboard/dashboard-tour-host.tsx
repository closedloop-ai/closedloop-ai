"use client";

import { OnboardingTourSource } from "@repo/api/src/types/onboarding-analytics";
import { DashboardContentState } from "@repo/app/insights/components/overview/dashboard-content-state";
import { Tour } from "@repo/app/onboarding/components/dashboard-tour/dashboard-tour";
import {
  TourCloseReason,
  type TourStep,
} from "@repo/app/onboarding/components/dashboard-tour/dashboard-tour-types";
import {
  resolveDashboardTourSteps,
  resolveReducedDesktopDownloadDashboardTourSteps,
} from "@repo/app/onboarding/components/dashboard-tour/resolve-dashboard-tour-steps";
import {
  DashboardTourOutcome,
  dashboardTourOutcome,
} from "@repo/app/onboarding/lib/dashboard-tour-completion";
import { useModalDialogOpen } from "@repo/design-system/hooks/use-modal-dialog-open";
import { useCallback, useEffect, useState } from "react";

/**
 * ISS-8351 / PLN-1875 Steps 6, 8 and 9 — the web dashboard's mount of the
 * shared tour.
 *
 * WHAT ARMS IT is the tour still being OWED (PRD-689), read from ISS-8375's
 * snapshot by `useGuidedDashboardTour` and handed down by the route. Step 6
 * shipped that prop permanently inert because the service had no client; Step 8
 * built one, and Step 9 widened the arm from the single `dashboard_tour` phase
 * to the one definition in `dashboard-tour-completion.ts` — which also covers a
 * run that deferred to `Ready` with the tour still unshown.
 *
 * THE ARM WAITS FOR THE DASHBOARD TO FINISH, which is the half a phase alone
 * cannot supply. The tour rings `[data-tour]` anchors, and the overview
 * dashboard emits its `stats` / `models` / `prs` wrappers AROUND their
 * skeletons while withholding `impact` until its row settles — so a page
 * measured mid-load resolves to a short run pointed at placeholders. The
 * degraded branch emits no anchor at all, and the empty branch emits only its
 * own `getting-started` (ISS-9727) — so neither can be told from a page that is
 * merely early by measuring the ROWS.
 * `dashboardContentState` is the dashboard saying
 * which of them it is; without it the effect below could only ever answer
 * once, and "nothing measurable YET" would be indistinguishable from "nothing
 * measurable at all" for the rest of the page load. Desktop has carried this
 * gate since ISS-5112 (`use-tour-arming.ts` waits on `analyticsLoaded` among
 * others); web could not, because that value lives inside the dashboard.
 *
 * THE HOST REFUSES AN EMPTY RUN, and that refusal is web's alone. Desktop always
 * leads with its intro summary card, so its run can never resolve empty; web
 * passes no leading steps, and four of the eight dashboard rows can be absent
 * for an ordinary org, so `resolveDashboardTourSteps` answers `[]` whenever
 * nothing measures. `Tour` refuses an empty run — the shell through the root
 * error boundary in dev, a silently dead tour in production — and that refusal
 * is right: a run with no steps renders nothing. Not opening is the HOST's call,
 * so the arm asks the resolver first, and `Tour` closes itself with `empty` if
 * the two measurements disagree across the commit between them.
 *
 * A ZERO-SESSION ORG GETS THE REDUCED RUN (ISS-9727), which is the operator's
 * ruling on where PLN-1875 Step 9 left that cohort. Step 9 made an empty
 * dashboard EXIT the tour phase — `defer_tour` rather than `finish_tour`, so the
 * reader reached `Ready` with the tour still owed instead of parking on
 * `dashboard_tour` forever — but it still showed them nothing, and a brand-new
 * account before any data exists is the cohort onboarding is for. The empty
 * branch now emits `getting-started` and the host runs the one beat that rings
 * it (`REDUCED_DASHBOARD_TOUR_STEPS_DESKTOP_DOWNLOAD`, the beat over the card's
 * Desktop download offer — PLN-2216 R5). That run ends like any other: walked to
 * the end or skipped, it is a `Completed`, so it stamps `finish_tour` and the
 * reader is not toured again when their data lands. One tour per reader is the
 * model desktop has always had — its first-launch latch is permanent — and the
 * six beats narrate rows this reader does not have.
 *
 * ZERO-SESSION IS AN ALL-TIME FACT, NEVER A SEVEN-DAY ONE, and getting that
 * wrong is what makes the paragraph above dangerous rather than merely
 * generous. The empty body this run is aimed at is drawn off the Recent Sessions
 * card, which is PINNED to a seven-day window, so an org that onboarded three
 * weeks ago and paused renders exactly like a brand-new one. Handed only that,
 * this host would open the reduced run for it and stamp `finish_tour` — and
 * because that stamp is permanent, that org would never be shown the six-beat
 * tour at all, downgraded forever on a recency window nobody told it was
 * load-bearing (ISS-9727 review, whitlockk). So the dashboard now reads the org's
 * ALL-TIME session count before it says `Empty`, and reports the seven-day
 * silence as `Quiet` instead — which lands on the deferral below, tour still
 * owed. The distinction is made where the population is known; this host only
 * consumes it, and must never re-derive a population fact from a render state.
 *
 * A RUN THAT SHOWED NOTHING STILL HAS TO END, and that is now the FALLBACK
 * rather than the empty page's answer. `Tour` freezing an empty run, and an
 * `Empty` page whose own anchor does not measure, both report `empty`, which
 * `dashboard-tour-completion.ts` classifies as `Unshown` and the host records
 * with `defer_tour`. Recording those as finished would retire the tour for a
 * reader shown nothing; recording nothing at all is what left a zero-session org
 * parked, because `finish_tour` was once the phase's only edge out.
 *
 * A RUN THAT COULD NOT LOOK REPORTS NOTHING, which is why `Degraded` is not
 * folded into that. A deferral is a claim — there was nothing here to show — and
 * a dashboard whose insights reads failed has established no such thing, so the
 * host declines to post one. TWO guards stand behind that outcome now, and
 * independently: since ISS-8351 the server stamps no `completedAt` off a
 * `defer_tour` either, because the wire carries no reason and it cannot tell an
 * empty org's deferral from a broken dashboard's. The server's covers every
 * client, desktop and older builds included; this one keeps an unsupported
 * claim out of the run's event log in the first place. The tour stays owed
 * under either ending, so the reader is unharmed — what was at stake was the
 * record.
 *
 * ISS-10929 retired the page's Tour control, so the run that opens by itself is
 * the only run there is — there is no replay to refuse, and every run this host
 * opens is an onboarding tour.
 */
export function useDashboardTourRun({
  dashboardContentState,
  onDeferTour,
  onFinishTour,
  tourRequested,
}: {
  /** What the overview dashboard on this page is currently rendering. */
  dashboardContentState: DashboardContentState;
  /** Records that the run showed nothing. Leaves the tour owed. */
  onDeferTour: () => void;
  /** Records the run as finished on the server. Suppresses it everywhere. */
  onFinishTour: () => void;
  /**
   * Whether the guided run is asking for the tour, per the one definition in
   * `dashboard-tour-completion.ts`. `false` while the run is unread, gated off,
   * or already finished — the run that opens by itself arms on nothing else,
   * so an answerless read is silence rather than an arm. `replay` does not read
   * it: the reader asking is its own answer.
   */
  tourRequested: boolean;
}): DashboardTourRunHandle {
  const [run, setRun] = useState<DashboardTourRun>(DashboardTourRun.Waiting);
  const modalDialogOpen = useModalDialogOpen();

  const requested = tourRequested;

  /**
   * Ends the run for this page load, and records which of the two things it was.
   *
   * `Closed` rather than back to `Waiting`, because the arm would otherwise find
   * the same measurable anchors and re-open the tour the reader just dismissed.
   */
  const close = useCallback(
    (reason: TourCloseReason) => {
      setRun(DashboardTourRun.Closed);
      if (dashboardTourOutcome(reason) === DashboardTourOutcome.Completed) {
        onFinishTour();
        return;
      }
      onDeferTour();
    },
    [onDeferTour, onFinishTour]
  );

  useEffect(() => {
    if (!requested || run !== DashboardTourRun.Waiting) {
      return;
    }
    // Marisol's ruling, ISS-11919, 2026-10-07: the tour waits while a modal dialog
    // is open, and arms once it closes.
    if (modalDialogOpen) {
      return;
    }
    const action = ARM_ACTION_BY_CONTENT_STATE[dashboardContentState];
    // ISS-9727: a zero-session org gets the REDUCED run rather than nothing.
    // The empty branch replaces the body, so the six canonical beats have no
    // targets — but the empty state itself is one, and pointing at it is what
    // reaches the cohort onboarding exists for. The deferral below is still the
    // answer when the anchor is not measurable, which is the ISS-8351 guarantee
    // this must not spend: the host and the dashboard measure one commit apart,
    // so an empty result here means they disagreed, and a run with no steps
    // renders nothing and offers the reader no control to end it with.
    if (action === DashboardTourArmAction.Reduce) {
      if (resolveReducedDesktopDownloadDashboardTourSteps().length > 0) {
        setRun(DashboardTourRun.Open);
        return;
      }
      close(TourCloseReason.Empty);
      return;
    }
    // A QUIET dashboard ends the run with the DEFERRAL, exactly as every empty
    // page did before ISS-9727, and this is the review correction that keeps the
    // reduced run off the wrong cohort (whitlockk, chatgpt-codex-connector). The
    // Recent Sessions card is pinned to a seven-day window, so an org that
    // onboarded three weeks ago and paused draws the same empty body as one that
    // has never synced anything. It is not a zero-session org, the reduced beat
    // is not its onboarding, and `finish_tour` here would retire the six-beat
    // tour for it PERMANENTLY on the strength of a recency window nobody told it
    // was load-bearing. Deferring leaves the tour owed, so it arrives when their
    // dashboard fills back in.
    if (action === DashboardTourArmAction.Defer) {
      close(TourCloseReason.Empty);
      return;
    }
    // A FAILED dashboard ends the run and records NOTHING, which is the half
    // that cannot be folded into the deferral above. `defer_tour` reports that
    // there was nothing to show, and a page whose insights reads failed has
    // measured nothing at all — so it has no such report to make. The server
    // reaches the same conclusion from its own side (ISS-8351: a `defer_tour`
    // stamps no `completedAt`), which does not make this guard redundant: this
    // one keeps the unsupported claim off the wire rather than discarding its
    // consequence afterwards. The tour stays owed either way, so the reader is
    // unharmed. Nothing was measured here, so nothing is reported.
    if (action === DashboardTourArmAction.Abandon) {
      setRun(DashboardTourRun.Closed);
      return;
    }
    // Loading is the one state worth waiting through, and rings skeletons if it
    // is not: every row wrapper is emitted around its placeholder.
    if (action === DashboardTourArmAction.Wait) {
      return;
    }
    // Measured twice, one commit apart, and deliberately: this reading decides
    // WHETHER to open, and `Tour`'s own reading on the activation edge is the
    // run it freezes. Handing the list over instead would hand `Tour` a
    // measurement taken before the render that opens it, which is the stale-run
    // bug its resolver signature exists to make unrepresentable.
    if (resolveDashboardTourSteps().length === 0) {
      return;
    }
    setRun(DashboardTourRun.Open);
  }, [close, dashboardContentState, modalDialogOpen, requested, run]);

  return {
    active: run === DashboardTourRun.Open,
    close,
    resolveSteps: tourStepsResolverFor(dashboardContentState),
    tourSource: tourSourceFor(dashboardContentState),
  };
}

export function DashboardTourHost({ run }: { run: DashboardTourRunHandle }) {
  return (
    <Tour
      active={run.active}
      onClose={run.close}
      resolveSteps={run.resolveSteps}
      tourSource={run.tourSource}
    />
  );
}

/** What the arm does about one report from the dashboard below it. */
const DashboardTourArmAction = {
  /** Wait: the page is still drawing and its anchors are skeletons. */
  Wait: "wait",
  /** Measure the page and open the tour if there is anything to ring. */
  Measure: "measure",
  /**
   * Run the REDUCED tour: the page drew no row, but it drew an empty state, and
   * that is a target. Falls back to the deferral when even that is unmeasurable.
   */
  Reduce: "reduce",
  /** End the run and record that nothing was shown — there was nothing to show. */
  Defer: "defer",
  /** End the run and record NOTHING: the dashboard failed, so nothing was measured. */
  Abandon: "abandon",
} as const;
type DashboardTourArmAction =
  (typeof DashboardTourArmAction)[keyof typeof DashboardTourArmAction];

/**
 * Exhaustive over {@link DashboardContentState}, so a state added to the
 * dashboard's report has to declare what the arm does about it rather than
 * falling to whichever branch an `if` chain happens to leave last.
 *
 * `Degraded` and `Empty` render identically and answer differently, which is the
 * whole reason they are separate members: a deferral is a REPORT that the tour
 * had nothing to show, and a dashboard that failed to load has not established
 * that. ISS-9727 widened the gap: `Empty` now RUNS something, because the empty
 * state is a deliberate target and a failed one is not.
 *
 * `Quiet` is the THIRD member of that family and the one this table exists to
 * keep out of `Reduce`. It renders exactly like `Empty` and differs only in
 * population — an org with sessions older than the Recent Sessions window, or
 * one whose all-time count could not be read at all. Its answer is the deferral,
 * which is what `Empty` answered before ISS-9727: the run showed nothing, so say
 * so and leave the tour owed. Nothing here may be `Reduce` unless the dashboard
 * has ESTABLISHED that this org has never synced a session, because `Reduce`'s
 * ending is permanent.
 */
const ARM_ACTION_BY_CONTENT_STATE: Record<
  DashboardContentState,
  DashboardTourArmAction
> = {
  [DashboardContentState.Degraded]: DashboardTourArmAction.Abandon,
  [DashboardContentState.Empty]: DashboardTourArmAction.Reduce,
  [DashboardContentState.Loading]: DashboardTourArmAction.Wait,
  [DashboardContentState.Quiet]: DashboardTourArmAction.Defer,
  [DashboardContentState.Ready]: DashboardTourArmAction.Measure,
};

/** Where one page load's tour is: not yet opened, open, or already dismissed. */
const DashboardTourRun = {
  Waiting: "waiting",
  Open: "open",
  Closed: "closed",
} as const;
type DashboardTourRun =
  (typeof DashboardTourRun)[keyof typeof DashboardTourRun];

/**
 * Follows the page, not the run's own memory of it. `Tour` resolves ONCE, on the
 * render that flips `active`, and whatever flipped it read this same state — so
 * the page that opened a run is the page whose run gets frozen. Keeping a second
 * copy in state would only add a way for the two to disagree.
 */
function tourStepsResolverFor(
  content: DashboardContentState
): () => readonly TourStep[] {
  return content === DashboardContentState.Empty
    ? resolveReducedDesktopDownloadDashboardTourSteps
    : resolveDashboardTourSteps;
}

export type DashboardTourRunHandle = {
  active: boolean;
  close: (reason: TourCloseReason) => void;
  resolveSteps: () => readonly TourStep[];
  tourSource: OnboardingTourSource;
};

/**
 * PRD-736: `web_teammate_data` may only be claimed when the org already has
 * analyzed data — which on this host is exactly the Ready arm. The reduced run
 * on an empty org is an onboarding tour.
 */
function tourSourceFor(content: DashboardContentState): OnboardingTourSource {
  return content === DashboardContentState.Ready
    ? OnboardingTourSource.WebTeammateData
    : OnboardingTourSource.Onboarding;
}
