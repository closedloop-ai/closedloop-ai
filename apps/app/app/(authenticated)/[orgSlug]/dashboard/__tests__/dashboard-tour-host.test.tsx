/**
 * ISS-8351 / PLN-1875 Steps 6 and 9: what the web dashboard's tour mount opens,
 * the states in which it must open nothing, and which of the two exits it
 * records when a run ends.
 *
 * PRESENCE IS MEASURED, NOT LOOKED UP. `resolveDashboardTourSteps` keeps a step
 * only when `spotlightHole(measureRect(el))` returns a hole, and jsdom measures
 * every element as zero area — so an anchor merely appended to the document is
 * ABSENT here, and a case that forgot to stub sizes would resolve to nothing and
 * still read as a green "the tour does not open". The sizes come from the shared
 * `stubMeasuredSize`, not a local copy, so this suite cannot drift away from the
 * geometry rule it is imitating.
 *
 * The refusal case is the one this suite exists for. Web passes no leading
 * steps, so an unmeasurable dashboard resolves to `[]`, and `Tour` refuses an
 * empty run by throwing outside production — which is what a host that armed
 * anyway would take the whole shell down with.
 */

import { DashboardContentState } from "@repo/app/insights/components/overview/dashboard-content-state";
import { DashboardTourAnchor } from "@repo/app/insights/components/overview/dashboard-tour-anchors";
import {
  mountAnchor,
  progressDots,
  restoreTourDom,
  stubMeasuredSize,
  stubScrollTo,
} from "@repo/app/onboarding/components/dashboard-tour/__tests__/dashboard-tour.test-helpers";
import { DASHBOARD_TOUR_STEPS } from "@repo/app/onboarding/components/dashboard-tour/dashboard-tour-steps";
import { TourCloseReason } from "@repo/app/onboarding/components/dashboard-tour/dashboard-tour-types";
import { DESKTOP_DOWNLOAD_TITLE } from "@repo/app/onboarding/lib/desktop-download-copy";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardTourHost, useDashboardTourRun } from "../dashboard-tour-host";

/** Records every render of `Tour`, with the `active` it was handed. */
const { tourProps, tourRendered } = vi.hoisted(() => ({
  /** The props of the most recent render, so a case can drive `onClose`. */
  tourProps: vi.fn(),
  tourRendered: vi.fn(),
}));

/**
 * The real `Tour`, behind a render probe.
 *
 * Whether the host MOUNTS the tour is not observable from the DOM: a shut `Tour`
 * and an absent one both render null. It is observable in what a mounted one
 * still costs — an unconditional `usePrefersReducedMotion()`, so a `matchMedia`
 * subscription per reader — and this probe is the direct way to assert it.
 */
vi.mock(
  "@repo/app/onboarding/components/dashboard-tour/dashboard-tour",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@repo/app/onboarding/components/dashboard-tour/dashboard-tour")
      >();
    return {
      ...actual,
      Tour: (props: Parameters<typeof actual.Tour>[0]) => {
        tourRendered(props.active);
        tourProps(props);
        return <actual.Tour {...props} />;
      },
    };
  }
);

/** The six canonical beats, written out rather than read off the shared list. */
const CANONICAL_ANCHOR_ORDER = [
  DashboardTourAnchor.Stats,
  DashboardTourAnchor.Impact,
  DashboardTourAnchor.Activity,
  DashboardTourAnchor.Sessions,
  DashboardTourAnchor.Models,
  DashboardTourAnchor.Prs,
];

/** The callout's own dismiss control; the click blocker shares its name. */
const SKIP_TEXT_BUTTON = 1;

/**
 * End the currently-mounted run through the engine's own callback.
 *
 * `empty` is reported BY `Tour`, from an effect, when the run it froze had no
 * steps — a state the engine's own suite drives end to end. What is under test
 * here is the host's answer to it, so the reason is delivered the way the engine
 * delivers it rather than by re-staging the disagreement that produces it.
 */
function closeOpenTour(reason: TourCloseReason): void {
  const props = tourProps.mock.lastCall?.[0] as
    | { onClose: (reason: TourCloseReason) => void }
    | undefined;
  if (!props) {
    throw new Error("no Tour was rendered to close");
  }
  props.onClose(reason);
}

function mountEveryAnchorMeasurable(): void {
  for (const anchor of CANONICAL_ANCHOR_ORDER) {
    stubMeasuredSize(mountAnchor(anchor), { width: 400, height: 120 });
  }
}

/**
 * The one anchor a zero-session dashboard emits (ISS-9727), measurable.
 *
 * Written out here and never mounted by {@link mountEveryAnchorMeasurable}: the
 * two sets are mutually exclusive on a real page, and a helper that mounted both
 * would let a case pass with the wrong run frozen.
 */
function mountGettingStartedMeasurable(): void {
  stubMeasuredSize(mountAnchor(DashboardTourAnchor.GettingStarted), {
    width: 400,
    height: 360,
  });
}

function renderHost({
  dashboardContentState = DashboardContentState.Ready,
  onDeferTour = () => undefined,
  onFinishTour = () => undefined,
  tourRequested = true,
}: {
  dashboardContentState?: DashboardContentState;
  onDeferTour?: () => void;
  onFinishTour?: () => void;
  tourRequested?: boolean;
} = {}) {
  return render(
    <HostHarness
      dashboardContentState={dashboardContentState}
      onDeferTour={onDeferTour}
      onFinishTour={onFinishTour}
      tourRequested={tourRequested}
    />
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  stubScrollTo();
  tourProps.mockClear();
  tourRendered.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  restoreTourDom();
});

describe("DashboardTourHost — what opens the tour", () => {
  it("opens the six canonical beats for an enrolled account", () => {
    mountEveryAnchorMeasurable();

    const { container } = renderHost();

    expect(screen.getByRole("dialog")).toHaveAccessibleName(
      "Start with the headline metrics"
    );
    // Six dots, because web leads with no intro card: the run is exactly the
    // anchored beats the page measured.
    expect(progressDots(container)).toHaveLength(CANONICAL_ANCHOR_ORDER.length);
  });

  it("opens only the beats this dashboard actually renders", () => {
    // `activity` is one of the four rows an ordinary org can be missing, and
    // dropped-not-skipped is why the progress dots can be trusted.
    for (const anchor of CANONICAL_ANCHOR_ORDER) {
      if (anchor !== DashboardTourAnchor.Activity) {
        stubMeasuredSize(mountAnchor(anchor), { width: 400, height: 120 });
      }
    }

    const { container } = renderHost();

    expect(progressDots(container)).toHaveLength(
      CANONICAL_ANCHOR_ORDER.length - 1
    );
  });

  it("opens the reduced run for an org that has no sessions yet", () => {
    // ISS-9727, and the cohort onboarding exists for. The empty branch replaces
    // the body, so none of the six canonical anchors is on this page — and
    // before this the host ended the run without ever opening one, which meant
    // a brand-new account was the ONE account the dashboard tour never reached.
    //
    // The title is the approved copy module's constant, which
    // `REDUCED_DASHBOARD_TOUR_STEPS_DESKTOP_DOWNLOAD` also reads, so this pins
    // which step the run opened on, not the step's wording.
    mountGettingStartedMeasurable();

    const { container } = renderHost({
      dashboardContentState: DashboardContentState.Empty,
    });

    expect(screen.getByRole("dialog")).toHaveAccessibleName(
      DESKTOP_DOWNLOAD_TITLE
    );
    // ONE dot, not six. The count is what separates the reduced run from the
    // canonical one being opened over a page that cannot show it: both would
    // satisfy "a dialog is on screen", and only this says which run was frozen.
    expect(progressDots(container)).toHaveLength(1);
  });
});

describe("DashboardTourHost — what keeps it shut", () => {
  it("does not arm on a page with nothing to ring", () => {
    // No anchor is mounted, so the resolver answers `[]`. A host that armed
    // anyway hands `Tour` an empty run, which it refuses by throwing outside
    // production — taking the shell down through the root error boundary. The
    // guard is the host's, and this is the case that proves it is there.
    //
    // The dashboard reports READY here, so this is a page that has finished
    // drawing and still has nothing to ring — not one that is merely early. The
    // readiness suite below owns that distinction.
    const { container } = renderHost();

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it("mounts the tour shut for a reader onboarding has not sent to it", () => {
    // The arm is the run asking for the tour, and a run that has finished it —
    // or has not been read at all — does not. That is an enrolled v2 account on
    // a fully measurable dashboard, which is every other condition this tour
    // needs.
    //
    // The mount assertion is the counterpart of the two cases above, and what
    // keeps their `not.toHaveBeenCalled()` from going vacuous: the gate is the
    // resolved EXPERIENCE, so a settled v2 mounts the tour even when nothing
    // arms it, and a probe that stopped observing renders would fail here.
    mountEveryAnchorMeasurable();

    renderHost({ tourRequested: false });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(tourRendered).toHaveBeenCalledWith(false);
  });
});

describe("DashboardTourHost — waiting for the dashboard", () => {
  it("does not ring skeletons while the dashboard rows are still loading", () => {
    // Every anchor measures, because `stats` / `models` / `prs` wrap their
    // skeletons — so the resolver is perfectly happy here and the ONLY thing
    // between the reader and a tour of placeholders is the readiness gate.
    mountEveryAnchorMeasurable();

    renderHost({
      dashboardContentState: DashboardContentState.Loading,
    });

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens once the dashboard reports it has finished drawing", () => {
    // The half a one-shot arm cannot do. The effect's deps were `[requested,
    // run]`, and neither moves when dashboard data lands, so an unmeasurable
    // or still-loading first commit stayed untoured for the whole page load —
    // "nothing measurable YET" indistinguishable from "nothing measurable at
    // all". Dropping `dashboardContentState` from those deps leaves the case
    // above green and this one red.
    mountEveryAnchorMeasurable();
    const { rerender } = render(
      <HostHarness
        dashboardContentState={DashboardContentState.Loading}
        onDeferTour={() => undefined}
        onFinishTour={() => undefined}
        tourRequested
      />
    );
    expect(screen.queryByRole("dialog")).toBeNull();

    rerender(
      <HostHarness
        dashboardContentState={DashboardContentState.Ready}
        onDeferTour={() => undefined}
        onFinishTour={() => undefined}
        tourRequested
      />
    );

    expect(screen.getByRole("dialog")).toHaveAccessibleName(
      "Start with the headline metrics"
    );
  });

  // ISS-12110 (Marisol Ashgrove, 2026-10-07): "go to the next beat once the data
  // for that beat is ready". This host opens only on `Ready`, which every panel
  // has settled by, so no beat is left to wait on; Desktop, which opens on the
  // headline row alone, is where Next is held.
  it("walks every beat without holding Next", () => {
    mountEveryAnchorMeasurable();

    renderHost();

    for (const _beat of CANONICAL_ANCHOR_ORDER.slice(1)) {
      const next = screen.getByRole("button", { name: NEXT_BUTTON });
      expect(next.getAttribute("aria-disabled")).toBe("false");
      fireEvent.click(next);
    }
    expect(screen.getByRole("dialog")).toHaveAccessibleName(
      DASHBOARD_TOUR_STEPS.at(-1)?.title ?? ""
    );
  });

  it("keeps the run it opened when a dashboard with nothing to draw fills in", () => {
    // Empty is not "not yet": the session read refetches on window focus and on
    // reconnect, so a new org that syncs its first session while the reader is
    // in another tab really does flip to Ready on their return — mid-run, under
    // an already-open callout. The run `Tour` froze is the reduced one, and it
    // has to stay that: a host that re-resolved on the flip would swap a
    // one-step run for a six-step one under a reader on step one, leaving the
    // index and the dots describing a different tour than the one they opened.
    //
    // Every canonical anchor is measurable here, so the six-step run is fully
    // available on the second render and only the freeze keeps it out.
    mountGettingStartedMeasurable();
    mountEveryAnchorMeasurable();
    const { container, rerender } = render(
      <HostHarness
        dashboardContentState={DashboardContentState.Empty}
        onDeferTour={() => undefined}
        onFinishTour={() => undefined}
        tourRequested
      />
    );
    // The run this case is about, before the flip that must not disturb it.
    expect(progressDots(container)).toHaveLength(1);

    rerender(
      <HostHarness
        dashboardContentState={DashboardContentState.Ready}
        onDeferTour={() => undefined}
        onFinishTour={() => undefined}
        tourRequested
      />
    );

    expect(screen.getByRole("dialog")).toHaveAccessibleName(
      DESKTOP_DOWNLOAD_TITLE
    );
    expect(progressDots(container)).toHaveLength(1);
  });

  it("never arms on an empty dashboard whose own anchor is unmeasurable", () => {
    // The fallback ISS-9727 must not spend. The host reads the content state and
    // the resolver measures the DOM one commit apart, so they can disagree: the
    // page reports Empty while its `getting-started` anchor is gone, collapsed,
    // or not yet laid out. A run with no steps renders nothing and offers the
    // reader no control to end it with, and `Tour` refuses it by throwing
    // outside production, so the host must not open one.
    //
    // Every CANONICAL anchor is measurable here, so a host that fell through to
    // the six-beat resolve would open a full run — the failure this pins is not
    // "nothing was mounted".
    mountEveryAnchorMeasurable();

    renderHost({ dashboardContentState: DashboardContentState.Empty });

    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("DashboardTourHost — ending the run", () => {
  it("closes for good when the reader skips, with no dock button to fly into", () => {
    // The host alone mounts no `[data-tour-btn]` — the page's Tour control is
    // not part of this render — so the skip animation has nothing to animate
    // toward and closes immediately, and no timer is advanced below. The run
    // must then stay closed: the anchors are still measurable, so a host that
    // returned to waiting would re-open what the reader just dismissed.
    mountEveryAnchorMeasurable();

    renderHost();
    fireEvent.click(
      screen.getAllByRole("button", { name: "Skip tour" })[
        SKIP_TEXT_BUTTON
      ] as HTMLElement
    );

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("records the finished run on the server when the reader dismisses it", () => {
    // The write half of the arm. Dismissal is component state here, so without
    // it the cohort is offered the tour again on every dashboard visit.
    mountEveryAnchorMeasurable();
    const onFinishTour = vi.fn();

    renderHost({ onFinishTour });
    fireEvent.click(
      screen.getAllByRole("button", { name: "Skip tour" })[
        SKIP_TEXT_BUTTON
      ] as HTMLElement
    );

    expect(onFinishTour).toHaveBeenCalledTimes(1);
  });

  it("defers a tour the reader was never shown, rather than recording it", () => {
    // `empty` is the engine saying its frozen run had no steps, so nothing ever
    // painted. Writing `finish_tour` for that marks the tour complete for a
    // reader who saw none of it and retires it permanently. Recording NOTHING is
    // not the answer either — that is the trap PLN-1875 Step 9 closes, and both
    // assertions are needed to tell the two failures apart.
    mountEveryAnchorMeasurable();
    const onDeferTour = vi.fn();
    const onFinishTour = vi.fn();

    renderHost({ onDeferTour, onFinishTour });
    act(() => {
      closeOpenTour(TourCloseReason.Empty);
    });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onFinishTour).not.toHaveBeenCalled();
    expect(onDeferTour).toHaveBeenCalledTimes(1);
  });

  it("defers when an empty dashboard cannot even offer its own anchor", () => {
    // The trap PLN-1875 Step 9 closed, still closed after ISS-9727 moved the
    // empty page onto the reduced run. The run is parked on the tour, the
    // dashboard reports its empty branch, and its `getting-started` anchor does
    // not measure — so there is nothing to open and the host must still END the
    // run. `finish_tour` was once the phase's only edge out, so writing nothing
    // re-entered the tour phase on every visit; writing `finish_tour` would
    // retire the tour for a reader shown none of it. Both assertions are needed
    // to tell those two failures apart.
    //
    // The canonical anchors are mounted, so the deferral comes from the reported
    // state and the missing reduced anchor rather than from a bare page, and no
    // dialog is opened for the reader to close: it comes from the arm itself.
    mountEveryAnchorMeasurable();
    const onDeferTour = vi.fn();
    const onFinishTour = vi.fn();

    renderHost({
      dashboardContentState: DashboardContentState.Empty,
      onDeferTour,
      onFinishTour,
    });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onDeferTour).toHaveBeenCalledTimes(1);
    expect(onFinishTour).not.toHaveBeenCalled();
  });

  it("records the reduced run as finished when the reader ends it", () => {
    // ISS-9727's write half, and the sibling that keeps the deferral above from
    // being satisfiable by a host that simply never opens anything. The reader
    // WAS shown a tour here — one beat, but a real one they walked and
    // dismissed — so this is a completion, and recording it as a deferral would
    // offer the same reduced run again on their next empty visit and every one
    // after it, since web keeps no local seen record.
    mountGettingStartedMeasurable();
    const onDeferTour = vi.fn();
    const onFinishTour = vi.fn();

    renderHost({
      dashboardContentState: DashboardContentState.Empty,
      onDeferTour,
      onFinishTour,
    });
    expect(screen.getByRole("dialog")).toHaveAccessibleName(
      DESKTOP_DOWNLOAD_TITLE
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: "Skip tour" })[
        SKIP_TEXT_BUTTON
      ] as HTMLElement
    );

    expect(onFinishTour).toHaveBeenCalledTimes(1);
    expect(onDeferTour).not.toHaveBeenCalled();
  });

  it("defers, and never finishes, an empty page whose org has synced before", () => {
    // ISS-9727 REVIEW (whitlockk, chatgpt-codex-connector), and the pole this whole
    // correction turns on. `Quiet` is an org with sessions OLDER than the Recent
    // Sessions card's fixed seven-day window: it draws the same empty body as a
    // brand-new org and is a completely different population. The reduced beat
    // is not its onboarding, and `finish_tour` is permanent — stamped here, that
    // org would never be shown the six-beat dashboard tour at all, downgraded
    // forever on a recency window nobody told it was load-bearing.
    //
    // BOTH anchor sets are measurable, which is what makes this falsifiable:
    // map `Quiet` back to `Reduce` and the reduced callout opens and a skip
    // writes `finish_tour`; map it to `Measure` and the six-beat run opens. Only
    // the deferral leaves the screen bare AND the tour owed, and the two
    // assertions below separate that from the other failure — recording nothing,
    // which is what `Degraded` gets and what parked this reader before Step 9.
    mountGettingStartedMeasurable();
    mountEveryAnchorMeasurable();
    const onDeferTour = vi.fn();
    const onFinishTour = vi.fn();

    renderHost({
      dashboardContentState: DashboardContentState.Quiet,
      onDeferTour,
      onFinishTour,
    });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onDeferTour).toHaveBeenCalledTimes(1);
    expect(onFinishTour).not.toHaveBeenCalled();
  });

  it("records nothing at all when the dashboard failed to load", () => {
    // The pair to the case above, and the ONLY thing that differs is the state
    // the dashboard reported: same anchors mounted, same run, same props. A
    // deferral is a claim that there was nothing to show, and a page whose
    // insights reads failed has established no such thing, so the host posts
    // neither exit. The server refuses the same conclusion separately — since
    // ISS-8351 a `defer_tour` stamps no `completedAt` — but that guard lives in
    // `transition-service.ts`, and what this case pins is the client half: what
    // reaches the wire, not what the server does with it.
    mountEveryAnchorMeasurable();
    const onDeferTour = vi.fn();
    const onFinishTour = vi.fn();

    renderHost({
      dashboardContentState: DashboardContentState.Degraded,
      onDeferTour,
      onFinishTour,
    });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onDeferTour).not.toHaveBeenCalled();
    expect(onFinishTour).not.toHaveBeenCalled();
  });

  it("records the completion, and no deferral, when an opened run reports done", () => {
    // The other arm of the exit fold, against the `empty` case above: a run that
    // actually opened and reported `done` is the one ending that retires the
    // tour. The dialog assertion is what separates the two — `empty` never
    // paints, so a host that answered both reasons the same way would be caught
    // here or there whichever way it collapsed them.
    mountEveryAnchorMeasurable();
    const onDeferTour = vi.fn();
    const onFinishTour = vi.fn();

    renderHost({ onDeferTour, onFinishTour });
    expect(screen.getByRole("dialog")).toHaveAccessibleName(
      "Start with the headline metrics"
    );
    act(() => {
      closeOpenTour(TourCloseReason.Done);
    });

    expect(onFinishTour).toHaveBeenCalledTimes(1);
    expect(onDeferTour).not.toHaveBeenCalled();
  });
});

describe("DashboardTourHost — waiting for a modal dialog (ISS-11919)", () => {
  // Marisol's ruling, 2026-10-07. Stage's teams/projects specs open Create Team
  // during the ~1 s the arm waits on the dashboard, and the tour's full-viewport
  // blocker (z-60) then landed over the dialog (z-50) and swallowed the click on
  // its first field. The dialog here is the design-system one those specs open,
  // so the open state comes from the same component, not from a stub.
  //
  // Radix hides everything outside an open modal from the accessibility tree, so
  // `queryByRole` would report the tour absent even if it had opened. These
  // cases read the probe's `active` and query the blocker with `hidden: true`.

  it("holds the reduced run while a dialog is open and opens it once the dialog closes", () => {
    mountGettingStartedMeasurable();
    const { rerender } = render(
      <HostWithDialog
        dashboardContentState={DashboardContentState.Loading}
        dialogOpen
      />
    );

    rerender(
      <HostWithDialog
        dashboardContentState={DashboardContentState.Empty}
        dialogOpen
      />
    );

    expect(skipTourControls()).toHaveLength(0);
    expect(tourRendered).toHaveBeenLastCalledWith(false);

    rerender(
      <HostWithDialog
        dashboardContentState={DashboardContentState.Empty}
        dialogOpen={false}
      />
    );

    expect(tourRendered).toHaveBeenLastCalledWith(true);
    expect(screen.getByRole("dialog")).toHaveAccessibleName(
      DESKTOP_DOWNLOAD_TITLE
    );
  });

  it("holds the six-beat run while a dialog is open and opens it once the dialog closes", () => {
    mountEveryAnchorMeasurable();
    const { rerender } = render(
      <HostWithDialog
        dashboardContentState={DashboardContentState.Loading}
        dialogOpen
      />
    );

    rerender(
      <HostWithDialog
        dashboardContentState={DashboardContentState.Ready}
        dialogOpen
      />
    );

    expect(skipTourControls()).toHaveLength(0);
    expect(tourRendered).toHaveBeenLastCalledWith(false);

    rerender(
      <HostWithDialog
        dashboardContentState={DashboardContentState.Ready}
        dialogOpen={false}
      />
    );

    expect(tourRendered).toHaveBeenLastCalledWith(true);
    expect(screen.getByRole("dialog")).toHaveAccessibleName(
      "Start with the headline metrics"
    );
  });

  it("opens as before when the dialog is mounted but closed", () => {
    // The control: with the dialog on the page but shut, the tour opens exactly
    // as it does with no dialog at all.
    mountEveryAnchorMeasurable();

    render(
      <HostWithDialog
        dashboardContentState={DashboardContentState.Ready}
        dialogOpen={false}
      />
    );

    expect(tourRendered).toHaveBeenLastCalledWith(true);
    expect(skipTourControls()).not.toHaveLength(0);
  });
});

/** The page's wiring of the run to the host, without the page around it. */
function HostHarness(props: Parameters<typeof useDashboardTourRun>[0]) {
  return <DashboardTourHost run={useDashboardTourRun(props)} />;
}

/** The host beside the design-system dialog the stage specs open over it. */
function HostWithDialog({
  dashboardContentState,
  dialogOpen,
}: {
  dashboardContentState: DashboardContentState;
  dialogOpen: boolean;
}) {
  return (
    <>
      <Dialog open={dialogOpen}>
        <DialogContent>
          <DialogTitle>Create team</DialogTitle>
          <DialogDescription>Name the team.</DialogDescription>
          <input aria-label="Team name" id="team-name" />
        </DialogContent>
      </Dialog>
      <HostHarness
        dashboardContentState={dashboardContentState}
        onDeferTour={() => undefined}
        onFinishTour={() => undefined}
        tourRequested
      />
    </>
  );
}

/** The tour's Skip tour controls, its click blocker among them, found under an open modal. */
function skipTourControls(): HTMLElement[] {
  return screen.queryAllByRole("button", { hidden: true, name: "Skip tour" });
}

/** The callout's advance control on every step but the last. */
const NEXT_BUTTON = /Next/;
