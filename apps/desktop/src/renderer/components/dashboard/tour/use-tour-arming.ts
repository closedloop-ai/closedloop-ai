import { DashboardTourStanding } from "@repo/app/onboarding/lib/dashboard-tour-completion";
import { useEffect, useRef } from "react";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { getBlockingOnboardingModalOpen } from "../../onboarding/blocking-onboarding-modal-store";
import { DesktopDashboardContent } from "../dashboard-state";
import {
  dashboardOnboardedStorageKey,
  writeFlag,
} from "../dashboard-storage-keys";

/**
 * Exhaustive over {@link DashboardTourStanding}: what this arm does about each
 * standing.
 *
 * `fires` is whether the arm runs at all; `opensTour` is whether firing opens
 * the tour or only writes the permanent latch. Both used to arrive by
 * FALLTHROUGH — one `if` tested `Unread` and one tested `Done`, and everything
 * else opened the tour — so a fourth standing would have spent this install's
 * one shot on whichever branch happened to be last, with nothing failing. A
 * `Record` cannot be written without naming every member, which is the same
 * correction `dashboard-tour-completion.ts` made to its phase inventory.
 */
const ARM_PLAN_BY_STANDING: Record<
  DashboardTourStanding,
  { fires: boolean; opensTour: boolean }
> = {
  [DashboardTourStanding.Done]: { fires: true, opensTour: false },
  [DashboardTourStanding.Owed]: { fires: true, opensTour: true },
  [DashboardTourStanding.Unread]: { fires: false, opensTour: false },
};

const DesktopTourArmAction = {
  /** Open the tour, spending this install's one shot. */
  Arm: "arm",
  /**
   * Leave the shot unspent and report the deferral once: the page settled with
   * nothing on it, which is a thing the run can honestly say it looked for.
   */
  Hold: "hold",
  /**
   * Leave the shot unspent and report NOTHING. Same arm as {@link Hold} and a
   * different CLAIM: a page that has not settled has established nothing for a
   * deferral to be about.
   */
  Wait: "wait",
} as const;
type DesktopTourArmAction =
  (typeof DesktopTourArmAction)[keyof typeof DesktopTourArmAction];

/** Available rows can be toured while the rest of the import continues. */
const ARM_ACTION_BY_CONTENT: Record<
  DesktopDashboardContent,
  DesktopTourArmAction
> = {
  [DesktopDashboardContent.Loading]: DesktopTourArmAction.Wait,
  [DesktopDashboardContent.Error]: DesktopTourArmAction.Wait,
  [DesktopDashboardContent.Empty]: DesktopTourArmAction.Hold,
  // ISS-11927: settled with no rows drawn, like Empty — web's Quiet defers too.
  [DesktopDashboardContent.RangeHidden]: DesktopTourArmAction.Hold,
  [DesktopDashboardContent.Ready]: DesktopTourArmAction.Arm,
};

/**
 * The first-launch tour's one shot.
 *
 * The invariant every gate below serves: the shot is spent at the moment the
 * tour OPENS and at no earlier point, because `closeTour` then retires the tour
 * for this reader on every device and the guided takeover's exit, below, is now
 * the only thing that re-opens it — ISS-10929 retired the header's Tour control
 * and none replaced it. Every branch that declines to open must therefore
 * return without writing `dashboardOnboardedStorageKey` and without setting
 * `completedRef`, so the install stays first-launch and this effect can arm
 * later — on a later launch, or on a `content` flip in this same session
 * (ISS-9992).
 */
export function useTourArming({
  blockingModalOpen,
  firstBeatReady,
  hasRenderedAnchor,
  runHasAnchoredBeat,
  firstLaunch,
  tourStanding,
  content,
  deferTour,
  completedRef,
  handoffPending,
  setTourActive,
}: {
  /** Reactive host state; the live store is also checked before opening. */
  blockingModalOpen: boolean;
  /**
   * Whether the run's first beat, the headline metrics row, has its data. Marisol
   * Ashgrove's ISS-12110 ruling (2026-10-07): "We should not be starting the
   * tour until we have data available ... We can start the 1st beat as soon as
   * the 1st row of metrics cards is filled with data". A Wait, like
   * `hasRenderedAnchor`: the row is coming, so there is no deferral to report.
   */
  firstBeatReady: boolean;
  /**
   * ISS-11315 Defect 4: the account run is mid-handoff to the system browser.
   * Forwarded to {@link syncTakeoverGate}, which holds the takeover's falling
   * edge on it — see that parameter for why.
   */
  handoffPending: boolean;
  /**
   * Whether the page has actually MOUNTED its first row anchor. NOT the retired
   * `tick >= 100` gate (ISS-11204 removed that): it flips at the reveal's first
   * beat, and is already true on the run that opens immediately.
   *
   * `arm()` needs one `[data-tour]` element to exist, and on a staggered reveal
   * none does at the instant `content` reaches `Ready`. Without this the effect
   * ran once against a page with no anchors, declined, and never re-ran —
   * leaving an install that opens no tour (a `Done` standing) permanently
   * first-launch, because the onboarded latch is written inside `arm()`.
   */
  hasRenderedAnchor: boolean;
  /**
   * ISS-9728: whether the run this page would open rings anything on the
   * dashboard at all.
   *
   * The canonical run is MEASURED against the dashboard's rows, so a page that
   * draws none of them resolves to an empty run. Two ways that happens and the
   * caller folds both in: the empty branch, and the org gate replacing the body
   * while the content state still reads `Ready` (see `first-launch-dashboard`).
   *
   * ISS-10546 changed what an unanchored run COSTS, not this gate. Desktop used
   * to lead every run with its own intro summary card, so such a run was one
   * step long and the card's own "Take a quick tour" was its LAST press —
   * closing it wrote `dashboardTourSeenStorageKey` and the reader lost the tour
   * permanently without being shown a beat of it. With that card retired the
   * run is simply empty. Held HERE rather than answered with an empty run
   * because `Tour` refuses one; not opening is the host's call, exactly as it
   * is on web (`dashboard-tour-host.tsx`).
   *
   * Held BEFORE the arm commits, so the permanent first-launch latch is not
   * written either — the tour is deferred, not spent, and arrives on the launch
   * (or the commit) where the dashboard has rows.
   */
  runHasAnchoredBeat: boolean;
  firstLaunch: boolean;
  /**
   * PLN-1875 Step 9: what this reader's tour STANDS AT on this device. The
   * caller composes it from `dashboardTourSeenStorageKey` and the guided run's
   * server record through the one definition in `@repo/app`'s
   * `dashboard-tour-completion.ts` — this hook used to read the local flag
   * itself, which made the local record the only one that could ever suppress a
   * re-show and left a reader who finished the tour on the web app shown it
   * again here.
   *
   * THREE-VALUED: a boolean would have to fold the still-arriving read into an answer, and this
   * arm is unrecoverable in BOTH directions. `Owed` opens the tour and `Done`
   * writes `dashboardOnboardedStorageKey` — the permanent first-launch latch —
   * so folding an unread run to either one spends the install's one shot on a
   * guess. `Unread` waits, bounded by the read itself resolving or failing.
   */
  tourStanding: DashboardTourStanding;
  /**
   * ISS-9992: what the dashboard DREW. The gate every other input here misses —
   * they all ask whether the page is ready to be toured, and none asks whether
   * there is anything on it to tour. See {@link ARM_ACTION_BY_CONTENT}.
   */
  content: DesktopDashboardContent;
  /**
   * The guided run's "ended without showing anything" write, for the `Hold`
   * branch alone. Deliberately not `finishTour`: retiring the tour is the defect.
   */
  deferTour: () => void;
  completedRef: React.RefObject<boolean>;
  setTourActive: (v: boolean) => void;
}) {
  const deferredRef = useRef(false);
  const takeoverUpRef = useRef(false);
  const takeoverExitedRef = useRef(false);
  // Only a run that OPENS has a first beat to wait for.
  const firstBeatPending =
    !firstBeatReady && ARM_PLAN_BY_STANDING[tourStanding].opensTour;
  const armable = hasRenderedAnchor && !firstBeatPending;
  useEffect(() => {
    const held = syncTakeoverGate({
      blockingModalOpen,
      completedRef,
      handoffPending,
      takeoverExitedRef,
      takeoverUpRef,
    });
    if (held) {
      return;
    }
    if (completedRef.current) {
      return;
    }
    // `firstLaunch` is read once at mount from the same permanent latch `arm()`
    // writes, so it cannot describe a reader whose onboarding is finishing right
    // now — see the edge above, which is why this gate defers to it.
    if (!(firstLaunch || takeoverExitedRef.current)) {
      completedRef.current = true;
      return;
    }
    const plan = ARM_PLAN_BY_STANDING[tourStanding];
    // An unread run is not an answer, and this arm cannot take one back: the
    // branch below writes the permanent latch either way. Held here rather than
    // in the guard above so a returning launch still settles immediately — it
    // reads no tour standing at all.
    if (!plan.fires) {
      return;
    }
    // Returns BEFORE `completedRef` is set and before the latch is written, and
    // that is the whole fix: the shot is only spent at the moment the tour
    // opens, so an install held here stays first-launch. Leaving `completedRef`
    // alone is also what lets the arm fire later in this SAME session — a
    // first-launch import lands, `content` flips to `Ready`, and this effect
    // re-runs on that dep with nothing to undo.
    const holdTour = () => {
      // Once per mount: this effect re-runs on every dep change, and a deferral
      // per re-render would spend a revision each time to move the run nowhere.
      //
      // A no-op for most readers by design, and worth saying so rather than
      // implying a reach it does not have: `canRecordDashboardTourDeferral`
      // accepts a deferral only from `OnboardingPhase.DashboardTour`, and
      // nothing in production posts `dashboard_entered`, so most Desktop runs
      // sit on `Welcome` or `DashboardAvailable` and this records nothing. It is
      // correct for the run that IS on the tour phase — otherwise parked there
      // with its completion card withheld, which is the web symptom ISS-9727
      // fixed.
      if (!deferredRef.current) {
        deferredRef.current = true;
        deferTour();
      }
    };
    const action = ARM_ACTION_BY_CONTENT[content];
    if (action === DesktopTourArmAction.Wait) {
      return;
    }
    if (action === DesktopTourArmAction.Hold) {
      holdTour();
      return;
    }
    // ISS-9728: nothing on this page for the run to ring. Held for the same
    // reason as the standing above and released the same way — this is a
    // dependency, so a dashboard whose rows arrive later re-runs the effect and
    // arms then. A standing that only writes the latch is unaffected: it opens
    // nothing, so it has nothing to be empty.
    if (plan.opensTour && !runHasAnchoredBeat) {
      holdTour();
      return;
    }
    // Nothing to measure yet, and nothing to report about it either: the rows,
    // or the headline row's data, are coming, and this is not the empty page
    // `holdTour` describes. Returning leaves the shot unspent and the effect
    // re-runs on this dep.
    if (!armable) {
      return;
    }

    const arm = () => {
      if (completedRef.current) {
        return;
      }
      // Asks the visibility question of an anchor the run would RING, not of the
      // header's Tour control — `querySelector` returns DOM order, not run
      // order, so this is "some anchor is laid out", not "the first beat is".
      // Deliberately tighter than the `[data-tour-btn]` check this replaced
      // (ISS-10929 retired that control and none replaced it): the control was
      // presentational chrome mounted in every content state, so its visibility
      // could pass over a page with no anchors and the arm then leaned on
      // `runHasAnchoredBeat` to hold.
      const anchor = document.querySelector<HTMLElement>("[data-tour]");
      const onScreen =
        document.visibilityState === "visible" && anchor?.offsetParent != null;
      if (!onScreen) {
        return;
      }
      // Read HERE rather than taken from the render that scheduled this effect:
      // see the `blockingModalOpen` prop. Everything below this line either
      // spends the install's one shot or leaves it, and a stale `false` spends
      // it permanently.
      //
      // ORed rather than replaced, because the two are stale in opposite
      // directions and only one of those is recoverable. A prop that still says
      // `true` after the takeover closed defers by one commit and self-heals —
      // it is a dependency, so the effect re-runs on it. A prop that says
      // `false` before the store has been told cannot be taken back.
      if (blockingModalOpen || getBlockingOnboardingModalOpen()) {
        return;
      }
      completedRef.current = true;
      takeoverExitedRef.current = false;
      document.removeEventListener("visibilitychange", arm);
      writeFlag(dashboardOnboardedStorageKey);
      if (plan.opensTour) {
        setTourActive(true);
      }
    };

    arm();
    if (!completedRef.current) {
      document.addEventListener("visibilitychange", arm);
    }
    return () => {
      document.removeEventListener("visibilitychange", arm);
    };
  }, [
    armable,
    blockingModalOpen,
    handoffPending,
    runHasAnchoredBeat,
    firstLaunch,
    tourStanding,
    content,
    deferTour,
    completedRef,
    setTourActive,
  ]);
}

/**
 * Track the guided-onboarding takeover across this effect's runs, and answer
 * whether it is holding the arm right now.
 *
 * THE TAKEOVER'S EXIT IS ITSELF AN ARM SIGNAL, and it has to outrank both
 * latches the caller checks after it.
 *
 * A reader who just finished the takeover is looking at this dashboard for the
 * first time, which is exactly the moment the tour is for. But the page mounts
 * BEHIND that takeover and lives through the whole run, so by the time it closes
 * the install can already have spent its one shot: `arm()` writes
 * `dashboardOnboardedStorageKey` for a `Done` standing, a commit can complete
 * the arm in a gap before the store has been told the takeover is up, and a
 * relaunch mid-onboarding reads `firstLaunch` as false off a latch written on
 * the previous one. Each of those leaves the reader on a dashboard with no tour,
 * ever — the shot spent on a page they never saw.
 *
 * So the falling edge releases the shot, once. WHAT IT DOES NOT DO is decide
 * that the tour should be SHOWN: `tourStanding` still owns that, so a reader who
 * has already seen it gets the latch rewritten and nothing else
 * (`ARM_PLAN_BY_STANDING`), and an unread run still waits.
 */
function syncTakeoverGate({
  blockingModalOpen,
  completedRef,
  handoffPending,
  takeoverExitedRef,
  takeoverUpRef,
}: {
  blockingModalOpen: boolean;
  completedRef: React.RefObject<boolean>;
  /**
   * ISS-11315 Defect 4: the account run has handed off to the system browser
   * and is waiting for it to come back.
   *
   * The falling edge below reads a closing takeover as "onboarding finished",
   * and that is wrong for the one case the operator reported: pressing Create
   * account CLOSES the takeover to open a browser, so the tour armed and its
   * opening animation played while the reader was being redirected away. The
   * gate could not tell "finished" from "mid-handoff and coming back".
   *
   * It can now, from the auth state machine's own in-flight statuses — a
   * signal that already exists and is already the authority on this question,
   * not a timer or a second latch. HOLDING is all this does: the edge is not
   * consumed, `completedRef` is untouched, and the arm fires on the next run of
   * this effect once the handoff settles in either direction. The status
   * settling is what bounds the hold, and the sign-in run bounds that itself,
   * so an abandoned browser ends on the callback timeout rather than here.
   */
  handoffPending: boolean;
  /** Set while an exit is owed an arm, cleared when one commits. */
  takeoverExitedRef: React.RefObject<boolean>;
  /** Whether the takeover has been up at any point this effect has observed. */
  takeoverUpRef: React.RefObject<boolean>;
}): boolean {
  if (blockingModalOpen || getBlockingOnboardingModalOpen()) {
    takeoverUpRef.current = true;
    return true;
  }
  // Held BEFORE the falling edge is read, and `takeoverUpRef` is deliberately
  // left set: the edge is deferred, never spent. Returning true also returns
  // the caller before `completedRef` and the permanent first-launch latch, so
  // ISS-11150's fourth ruled behaviour — never spend the latch — holds here
  // exactly as it does for the takeover-up branch above.
  if (takeoverUpRef.current && handoffPending) {
    return true;
  }
  if (takeoverUpRef.current) {
    takeoverUpRef.current = false;
    takeoverExitedRef.current = true;
    completedRef.current = false;
  }
  return false;
}

/**
 * Which auth statuses mean "the account run has handed off to the system
 * browser and is coming back" (ISS-11315 Defect 4).
 *
 * DERIVED from an exhaustive `Record`, not written out as a set of the two
 * members that happen to qualify today. A bare `ReadonlySet<DesktopAuthStatus>`
 * would still compile when a status is added, and the new member would silently
 * answer "not pending" — which is the falling edge firing during a handoff
 * again, on a code path nothing would point at. The `Record` cannot be written
 * without naming every member, so a new status fails `tsc` here.
 */
const HANDOFF_PENDING_BY_STATUS: Record<DesktopAuthStatus, boolean> = {
  [DesktopAuthStatus.Loading]: false,
  [DesktopAuthStatus.SignedOut]: false,
  [DesktopAuthStatus.OpeningBrowser]: true,
  [DesktopAuthStatus.AwaitingRedirect]: true,
  // HELD, and this one was wrong (ISS-11315 review, tamsinb + codex). The
  // browser has come back, but the takeover HAS NOT ANSWERED yet: during
  // `Exchanging` the guest run is gone (`canOfferAccount` wants `SignedOut`)
  // and the authenticated handoff run is not on yet (it wants
  // `Authenticated`), so no source offers a run, `useGuidedOnboardingSnapshot`
  // is still disabled, and `dashboardTourStandingHere` folds a read that never
  // happened to `Owed`. Releasing here therefore spent the takeover's falling
  // edge, wrote `dashboardOnboardedStorageKey` and opened the tour — and then
  // Choose organization opened on top of it, which is the ISS-10570 case this
  // gate exists to prevent, and what the operator's recording shows.
  //
  // `Authenticated` needs no hold of its own and is the reason this one is
  // enough: the snapshot query is enabled by then, so `isLoading` makes
  // `tourStanding` read `Unread`, and `ARM_PLAN_BY_STANDING` does not fire on
  // it — the arm returns before the latch either way. The hold therefore lasts
  // until the host has actually answered, not until auth settles.
  [DesktopAuthStatus.Exchanging]: true,
  [DesktopAuthStatus.Authenticated]: false,
  [DesktopAuthStatus.RefreshFailed]: false,
};

/** Whether the account run is waiting on the system browser right now. */
export function isDesktopAuthHandoffPending(
  status: DesktopAuthStatus
): boolean {
  return HANDOFF_PENDING_BY_STATUS[status];
}
