import { DashboardTourStanding } from "@repo/app/onboarding/lib/dashboard-tour-completion";
import { renderHook } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubLocalStorage } from "../../../../__tests__/local-storage-stub";
import {
  getBlockingOnboardingModalOpen,
  setBlockingOnboardingModalOpen,
} from "../../../onboarding/blocking-onboarding-modal-store";
import { DesktopDashboardContent } from "../../dashboard-state";
import {
  DASHBOARD_FLAG_SET,
  dashboardOnboardedStorageKey,
} from "../../dashboard-storage-keys";
import { useTourArming } from "../use-tour-arming";

/**
 * PRD-689's non-overlap contract, held against the arm that decides it
 * (ISS-11150).
 *
 * The desktop counterpart of the web pin landing in PR #7967 (ISS-11147/11149)
 * as `packages/app/onboarding/hooks/__tests__/onboarding-modal-tour-exclusion.test.tsx`
 * — NOT yet on `main`, so do not go looking for it here. That one walks every
 * phase and asserts `isBlockingPhase && isDashboardTourRequestedByRun` is never
 * true; this one proves the same two states cannot coexist on the host where the
 * dashboard mounts BEHIND the modal and lives through the whole run.
 *
 * Held at the hook rather than through `FirstLaunchDashboard`, which
 * `first-launch-dashboard-tour-behind-modal.test.tsx` already drives end to end.
 * Two reasons this is the honest level for the contract. The standing is a
 * PARAMETER here, so `Unread` can be named directly — reaching it through the
 * page means driving the completion read to a pending state, and the cost of
 * that setup is why nothing pinned it. And an integration run declines to open
 * the tour for any of eight reasons, so a suppression asserted there passes just
 * as well when the fixture broke; every SUPPRESSION case below therefore pairs
 * its absence with the release that follows on the SAME fixture. The last case
 * is the exception and asserts no absence at all — it is the fixture control for
 * the others.
 */
describe("useTourArming non-overlap with the blocking onboarding modal", () => {
  beforeEach(() => {
    stubLocalStorage();
    setBlockingOnboardingModalOpen(false);
    visibility = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
    // jsdom lays nothing out, so the arm's `offsetParent` guard would refuse
    // every page. The dashboard under test IS laid out; the modal merely covers
    // it, which is the situation this suite is about.
    vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockImplementation(
      () => document.body
    );
    anchor = document.createElement("div");
    anchor.setAttribute("data-tour", "sessions");
    document.body.append(anchor);
  });

  afterEach(() => {
    anchor.remove();
    vi.restoreAllMocks();
    // `stubLocalStorage` replaces the global via `vi.stubGlobal`, which
    // `restoreAllMocks` does not unwind — every sibling suite here pairs the two.
    vi.unstubAllGlobals();
    setBlockingOnboardingModalOpen(false);
    Reflect.deleteProperty(document, "visibilityState");
  });

  /**
   * MARISOL'S RULING, 2026-09-25 (ISS-11204): "never start while the onboarding
   * modal is visible", then "start immediately after the modal closes".
   *
   * The absence and the release in one case on one fixture, because "the tour
   * did not open" is also what a broken fixture, an unmounted hook and a
   * missing anchor all look like. The release is what proves this fixture COULD
   * have opened it.
   *
   * The latch is asserted in both directions here rather than in a case of its
   * own: unwritten under the cover is the half a latch that is simply NEVER
   * written would satisfy alone, so the write after the close has to sit beside
   * it. The deferral is the one part this fixture cannot reach — it draws a
   * READY page, so `holdTour` is unreachable — and has its own case below.
   */
  it("opens nothing while the modal is up and opens on the very next commit once it closes", () => {
    const arm = renderArm({ blockingModalOpen: true });

    // The modal is genuinely up, asserted against the STORE rather than against
    // the prop this case just passed in. Reading the fixture's own input back
    // would be a tautology no mutation of the arm could redden, and would leave
    // `setBlockingOnboardingModalOpen` in the fixture deletable in silence.
    expect(getBlockingOnboardingModalOpen()).toBe(true);
    expect(arm.setTourActive).not.toHaveBeenCalled();
    expect(localStorage.getItem(dashboardOnboardedStorageKey)).toBeNull();

    arm.setModalOpen(false);

    expect(arm.setTourActive).toHaveBeenCalledWith(true);
    expect(localStorage.getItem(dashboardOnboardedStorageKey)).toBe(
      DASHBOARD_FLAG_SET
    );
  });

  /**
   * A stale prop cannot spend the shot. The host and the dashboard are in
   * different component trees, so a commit in which the modal opens leaves this
   * arm holding `false` until the store schedules it a re-render — and the write
   * below it is permanent, which is why `use-tour-arming.ts` reads the live store
   * as well as the prop.
   *
   * WHAT THIS PINS, measured rather than assumed: that the hook consults the
   * store SOMEWHERE, not either individual read. It reads it twice — in
   * `syncTakeoverGate` and again inside `arm()` — and deleting either one alone
   * leaves this case green, because the survivor still catches the disagreement.
   * Only removing both reddens it. Stated because the obvious stronger claim
   * ("without this the OR can be deleted silently") is false, and a reader who
   * believed it would skip the case that would actually catch that deletion.
   *
   * The release runs the host catching up and then closing, because this case's
   * fixture is the only disagreeing one in the file and the positive control at
   * the bottom therefore does not cover it — without a release of its own, a
   * fixture break confined to this shape would pass as a suppression.
   */
  it("refuses a prop that says the modal is closed while the store says it is up", () => {
    const arm = renderArm({ blockingModalOpen: false, storeOpen: true });

    expect(arm.setTourActive).not.toHaveBeenCalled();
    expect(localStorage.getItem(dashboardOnboardedStorageKey)).toBeNull();

    arm.setModalOpen(true);
    arm.setModalOpen(false);

    expect(arm.setTourActive).toHaveBeenCalledWith(true);
    expect(localStorage.getItem(dashboardOnboardedStorageKey)).toBe(
      DASHBOARD_FLAG_SET
    );
  });

  /**
   * THE THREE-VALUED STANDING, and the one member nothing pinned.
   *
   * The ruling starts the tour on ANY available data rather than a settled read,
   * and `Unread` is the input that must still not fold into an open: the
   * completion read has not answered, and this arm cannot take either answer
   * back — `Owed` opens the tour and `Done` writes the permanent latch. Folding
   * it spends the install's one shot on a guess.
   *
   * The modal is CLOSED here and the page is `Ready`, so the standing is the
   * only thing left that can decline — and the flip to `Owed` on the same
   * fixture is what proves it was.
   */
  it("waits on an unread standing rather than folding it, and opens once it resolves to owed", () => {
    const arm = renderArm({
      blockingModalOpen: false,
      tourStanding: DashboardTourStanding.Unread,
    });

    expect(arm.setTourActive).not.toHaveBeenCalled();
    expect(localStorage.getItem(dashboardOnboardedStorageKey)).toBeNull();

    arm.setStanding(DashboardTourStanding.Owed);

    expect(arm.setTourActive).toHaveBeenCalledWith(true);
    expect(localStorage.getItem(dashboardOnboardedStorageKey)).toBe(
      DASHBOARD_FLAG_SET
    );
  });

  /**
   * THE DEFERRAL HALF, on the only fixture that can reach it.
   *
   * A suppressed run must not report a deferral either: `deferTour` moves the
   * guided run on without showing a beat, and a run deferred for a page the
   * reader never saw is spent for the wrong reason. Asserting that against a
   * READY page proves nothing — `holdTour` is unreachable there, so the absence
   * holds whatever the modal gate does. An EMPTY page is the fixture where the
   * arm would genuinely defer, which is what makes the absence falsifiable.
   *
   * WHICH gate, precisely, since the arm reads the store twice: only
   * `syncTakeoverGate`'s read. Deleting it lets the first render fall through to
   * `Hold` and this case reports a deferral. Deleting the read inside `arm()`
   * leaves it green, because a `Hold` returns before `arm()` is ever called.
   *
   * The release is the honest deferral once the modal is down — an empty
   * dashboard has nothing to tour, so the run is deferred rather than armed, and
   * the latch stays unwritten so a later launch with rows can still open it.
   */
  it("records no deferral while the modal is up, and defers without spending the latch once it closes", () => {
    const arm = renderArm({
      blockingModalOpen: true,
      content: DesktopDashboardContent.Empty,
    });

    expect(arm.deferTour).not.toHaveBeenCalled();

    arm.setModalOpen(false);

    expect(arm.deferTour).toHaveBeenCalledTimes(1);
    expect(arm.setTourActive).not.toHaveBeenCalled();
    expect(localStorage.getItem(dashboardOnboardedStorageKey)).toBeNull();
  });

  /**
   * THE HANDOFF, AND THE STATUS THE FIRST FIX LET GO ONE TOO EARLY.
   *
   * Pressing Create account CLOSES the takeover to open the system browser, so
   * the falling edge arrives in the middle of onboarding rather than at its end.
   * Held on the auth machine's in-flight statuses — and `Exchanging` is one of
   * them (ISS-11315 review, tamsinb + codex). The browser has come back, but
   * during the redeem the guest run is gone and the authenticated run is not on
   * yet, so `useGuidedOnboardingSnapshot` is still disabled and
   * `dashboardTourStandingHere` folds a read that never happened to `Owed`.
   * Releasing there spent the latch and opened the tour, and Choose organization
   * then opened on top of it.
   *
   * DRIVEN THROUGH `Exchanging` DELIBERATELY. The earlier renderer case went
   * `OpeningBrowser` straight to settled and skipped this transition, which is
   * the only reason it was green. The release below is on the SAME fixture, so a
   * broken fixture cannot pass as a suppression.
   */
  it("holds the shot while the redeem is in flight, and arms once onboarding is really over", () => {
    const arm = renderArm({ blockingModalOpen: true });

    // The takeover closes to hand off to the browser: a falling edge that is
    // not the end of onboarding.
    arm.setHandoffPending(true);
    arm.setModalOpen(false);

    expect(arm.setTourActive).not.toHaveBeenCalled();
    expect(localStorage.getItem(dashboardOnboardedStorageKey)).toBeNull();

    arm.setHandoffPending(false);

    expect(arm.setTourActive).toHaveBeenCalledWith(true);
    expect(localStorage.getItem(dashboardOnboardedStorageKey)).toBe(
      DASHBOARD_FLAG_SET
    );
  });

  /**
   * THE REOPEN THE OLD CASE NEVER DROVE — ISS-10570 again, one status later.
   *
   * Holding through the handoff is only worth anything if the takeover coming
   * BACK finds the shot unspent. The recording shows exactly that: the wizard
   * returns for Choose organization after the browser does. So this drives the
   * whole sequence the operator hit — takeover up, handoff out, redeem in
   * flight, takeover back — and asserts the tour never opened under it and the
   * permanent latch was never written, which is the half that cannot be undone.
   *
   * The `Unread` standing is what guards the window between the redeem settling
   * and the takeover reopening on the real page (the snapshot query is loading
   * there), and it is named as a parameter here for the reason the file header
   * gives: reaching it through the page means driving a completion read to a
   * pending state.
   */
  it("still has its shot when the takeover comes back for Choose organization", () => {
    const arm = renderArm({
      blockingModalOpen: true,
      tourStanding: DashboardTourStanding.Unread,
    });

    arm.setHandoffPending(true);
    arm.setModalOpen(false);
    arm.setHandoffPending(false);
    arm.setModalOpen(true);

    expect(arm.setTourActive).not.toHaveBeenCalled();
    expect(localStorage.getItem(dashboardOnboardedStorageKey)).toBeNull();

    // And the shot survives it: the takeover finally closes for good with the
    // run answered, and the tour opens then.
    arm.setStanding(DashboardTourStanding.Owed);
    arm.setModalOpen(false);

    expect(arm.setTourActive).toHaveBeenCalledWith(true);
  });

  /**
   * The counterfactual for every suppression above: with the modal down and an
   * owed tour this fixture arms on the spot. Without it, each case would pass
   * just as well against an arm that had simply stopped working.
   */
  it("arms immediately when no modal is covering the page", () => {
    const arm = renderArm({ blockingModalOpen: false });

    expect(arm.setTourActive).toHaveBeenCalledWith(true);
    expect(localStorage.getItem(dashboardOnboardedStorageKey)).toBe(
      DASHBOARD_FLAG_SET
    );
  });
});

let anchor: HTMLElement;
let visibility: DocumentVisibilityState;

/**
 * Drive the arm the way the page does: every input at the value a first-launch
 * dashboard with rows on it reports, so the case under test is the only reason
 * the arm can decline.
 *
 * `setModalOpen` writes the store as well as the prop because the host does
 * both — the store is what an irreversible write reads.
 */
function renderArm({
  blockingModalOpen,
  content = DesktopDashboardContent.Ready,
  handoffPending = false,
  storeOpen = blockingModalOpen,
  tourStanding = DashboardTourStanding.Owed,
}: {
  blockingModalOpen: boolean;
  /**
   * ISS-11315 Defect 4: the account run is mid-handoff to the system browser.
   * Defaults false so every case above drives the arm exactly as before.
   */
  handoffPending?: boolean;
  /**
   * What the dashboard DREW. `Ready` for every case about opening; `Empty` is
   * the only value that can reach `holdTour`, so the deferral case needs it.
   */
  content?: DesktopDashboardContent;
  /** The live store, when the case needs it to DISAGREE with the prop. */
  storeOpen?: boolean;
  tourStanding?: DashboardTourStanding;
}) {
  const setTourActive = vi.fn();
  const deferTour = vi.fn();
  let modalOpen = blockingModalOpen;
  let standing = tourStanding;
  let pending = handoffPending;
  setBlockingOnboardingModalOpen(storeOpen);

  const view = renderHook(() => {
    const completedRef = useRef(false);
    useTourArming({
      blockingModalOpen: modalOpen,
      firstBeatReady: true,
      handoffPending: pending,
      hasRenderedAnchor: true,
      runHasAnchoredBeat: true,
      firstLaunch: true,
      tourStanding: standing,
      content,
      deferTour,
      completedRef,
      setTourActive,
    });
  });

  return {
    deferTour,
    setTourActive,
    setModalOpen(open: boolean) {
      modalOpen = open;
      setBlockingOnboardingModalOpen(open);
      view.rerender();
    },
    setStanding(next: DashboardTourStanding) {
      standing = next;
      view.rerender();
    },
    /** The auth status moving, with the takeover already down. */
    setHandoffPending(next: boolean) {
      pending = next;
      view.rerender();
    },
  };
}
