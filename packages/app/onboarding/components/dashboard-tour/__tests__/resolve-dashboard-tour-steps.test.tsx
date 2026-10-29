/**
 * ISS-8351 / PLN-1875 Step 3: the run list a tour actually shows.
 *
 * Two halves of one contract. The resolver decides WHICH canonical steps run,
 * and the callout's progress dots have to agree with that decision — a fixed
 * six-step list that skips missing anchors at render is exactly the dot row
 * that lies about progress, which is the defect this unit exists to prevent.
 * So the rendered indicator is asserted here beside the function's return
 * value, not in place of it.
 *
 * The presence rule is the load-bearing decision. `spotlightHole` refuses a
 * zero-area rect and dims the whole viewport instead of ringing the top-left
 * corner; if presence meant "in the document" the resolver would hand such an
 * anchor a step and a dot anyway, putting that same lie one layer up.
 */

import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardTourAnchor } from "../../../../insights/components/overview/dashboard-tour-anchors";
import {
  DESKTOP_DOWNLOAD_DESCRIPTION,
  DESKTOP_DOWNLOAD_EYEBROW,
  DESKTOP_DOWNLOAD_TITLE,
} from "../../../lib/desktop-download-copy";
import { Tour } from "../dashboard-tour";
import type { TourStep } from "../dashboard-tour-types";
import {
  isDashboardTourAnchorPresent,
  resolveDashboardTourSteps,
  resolveReducedDesktopDownloadDashboardTourSteps,
} from "../resolve-dashboard-tour-steps";
import {
  mountAnchor,
  progressDots,
  restoreTourDom,
  stubMeasuredSize,
} from "./dashboard-tour.test-helpers";

/**
 * The semantic order ISS-8351 specifies, written out rather than derived from
 * the module under test — a spec the implementation is held to, not a copy of
 * it. `Prs` last is the deliberate half: the normative prototype the copy came
 * from names that target `pull-requests`, and the production key is `prs`.
 */
const CANONICAL_ANCHOR_ORDER = [
  DashboardTourAnchor.Stats,
  DashboardTourAnchor.Impact,
  DashboardTourAnchor.Activity,
  DashboardTourAnchor.Sessions,
  DashboardTourAnchor.Models,
  DashboardTourAnchor.Prs,
];

function anchorsOf(steps: readonly TourStep[]): string[] {
  return steps.map((step) => step.sel);
}

afterEach(() => {
  restoreTourDom();
});

describe("resolveDashboardTourSteps", () => {
  it("runs every canonical step when every anchor is present", () => {
    const steps = resolveDashboardTourSteps({ isAnchorPresent: () => true });

    expect(anchorsOf(steps)).toEqual(CANONICAL_ANCHOR_ORDER);
  });

  it("drops the step for an absent anchor rather than skipping it at render", () => {
    const steps = resolveDashboardTourSteps({
      isAnchorPresent: (anchor) => anchor !== DashboardTourAnchor.Activity,
    });

    expect(anchorsOf(steps)).toEqual([
      DashboardTourAnchor.Stats,
      DashboardTourAnchor.Impact,
      DashboardTourAnchor.Sessions,
      DashboardTourAnchor.Models,
      DashboardTourAnchor.Prs,
    ]);
  });

  it("resolves to the single present anchor when the rest are gone", () => {
    const steps = resolveDashboardTourSteps({
      isAnchorPresent: (anchor) => anchor === DashboardTourAnchor.Stats,
    });

    expect(anchorsOf(steps)).toEqual([DashboardTourAnchor.Stats]);
  });

  it("resolves to nothing when no anchor is present", () => {
    const steps = resolveDashboardTourSteps({ isAnchorPresent: () => false });

    expect(steps).toEqual([]);
  });

  it("measures the document by default rather than trusting every anchor", () => {
    // Only `stats` is mounted AND measurable, so a default that answered `true`
    // for everything — or read the document without the area rule — resolves a
    // different list than this.
    stubMeasuredSize(mountAnchor(DashboardTourAnchor.Stats), {
      width: 200,
      height: 50,
    });
    mountAnchor(DashboardTourAnchor.Models);

    expect(anchorsOf(resolveDashboardTourSteps())).toEqual([
      DashboardTourAnchor.Stats,
    ]);
  });

  it("never runs the empty page's own beat as part of the canonical run", () => {
    // ISS-9727's separation, from the canonical side. `getting-started` exists
    // only on a page that drew no row, so a canonical run that picked it up
    // would ring the empty state on a dashboard full of data — which is exactly
    // what a single filtered list over both step sets would do the moment a row
    // learned to render beside the empty branch. `isAnchorPresent` answers TRUE
    // for everything here, so nothing but the list separation can exclude it.
    const steps = resolveDashboardTourSteps({ isAnchorPresent: () => true });

    expect(anchorsOf(steps)).not.toContain(DashboardTourAnchor.GettingStarted);
  });
});

describe("resolveReducedDesktopDownloadDashboardTourSteps", () => {
  it("runs the empty page's one beat when its anchor is present", () => {
    const steps = resolveReducedDesktopDownloadDashboardTourSteps({
      isAnchorPresent: () => true,
    });

    expect(anchorsOf(steps)).toEqual([DashboardTourAnchor.GettingStarted]);
  });

  it("resolves to nothing when the empty page's own anchor is absent", () => {
    // The host's fallback depends on this answer, and it is the half that keeps
    // ISS-8351's deferral guarantee alive: an empty page whose anchor did not
    // measure must resolve to `[]` so the host defers rather than opening a run
    // that renders nothing and gives the reader no control to end it with.
    const steps = resolveReducedDesktopDownloadDashboardTourSteps({
      isAnchorPresent: () => false,
    });

    expect(steps).toEqual([]);
  });

  it("never runs a canonical beat, even on a page that could show all six", () => {
    // The sibling of the canonical exclusion above, from the reduced side. The
    // predicate accepts every anchor, so a reduced resolver that filtered the
    // canonical list — or concatenated the two — answers with six steps here.
    const steps = resolveReducedDesktopDownloadDashboardTourSteps({
      isAnchorPresent: () => true,
    });

    expect(anchorsOf(steps)).toEqual([DashboardTourAnchor.GettingStarted]);
    expect(anchorsOf(steps)).not.toContain(DashboardTourAnchor.Stats);
  });

  it("measures the document by default rather than trusting the anchor", () => {
    // Same default as the canonical resolver, and the same trap: an anchor in
    // the document with no area gets no spotlight hole, so counting it present
    // hands the reduced run its one dot and rings nothing.
    mountAnchor(DashboardTourAnchor.GettingStarted);

    expect(resolveReducedDesktopDownloadDashboardTourSteps()).toEqual([]);

    stubMeasuredSize(
      document.querySelector<HTMLElement>(
        `[data-tour="${DashboardTourAnchor.GettingStarted}"]`
      ) as HTMLElement,
      { width: 400, height: 360 }
    );

    expect(
      anchorsOf(resolveReducedDesktopDownloadDashboardTourSteps())
    ).toEqual([DashboardTourAnchor.GettingStarted]);
  });

  it("says the download offer's approved words", () => {
    // PLN-2216 R5: the card under the scrim always offers the Desktop download,
    // so the beat ringing it carries that offer's own copy.
    const [beat] = resolveReducedDesktopDownloadDashboardTourSteps({
      isAnchorPresent: () => true,
    });

    expect(beat).toMatchObject({
      body: DESKTOP_DOWNLOAD_DESCRIPTION,
      eyebrow: DESKTOP_DOWNLOAD_EYEBROW,
      title: DESKTOP_DOWNLOAD_TITLE,
    });
  });
});

describe("isDashboardTourAnchorPresent", () => {
  it("accepts an anchor the spotlight can measure", () => {
    stubMeasuredSize(mountAnchor(DashboardTourAnchor.Prs), {
      width: 200,
      height: 50,
    });

    expect(isDashboardTourAnchorPresent(DashboardTourAnchor.Prs)).toBe(true);
  });

  it("rejects an anchor that is in the document but measures no area", () => {
    // The case that decides the whole unit: `display: none`, a collapsed
    // section, or a row already detached all measure 0x0, and `spotlightHole`
    // refuses to ring them. Calling this present would give the step a dot and
    // a number for a section nobody is ever shown.
    stubMeasuredSize(mountAnchor(DashboardTourAnchor.Prs), {
      width: 0,
      height: 0,
    });

    expect(isDashboardTourAnchorPresent(DashboardTourAnchor.Prs)).toBe(false);
  });

  it("rejects an anchor no shell emitted", () => {
    expect(isDashboardTourAnchorPresent(DashboardTourAnchor.Prs)).toBe(false);
  });
});

describe("the rendered progress indicator", () => {
  it("shows five dots, not six with a gap, when `activity` is absent", () => {
    const steps = resolveDashboardTourSteps({
      isAnchorPresent: (anchor) => anchor !== DashboardTourAnchor.Activity,
    });

    const { container } = render(
      <Tour active onClose={vi.fn()} resolveSteps={() => steps} />
    );

    expect(progressDots(container)).toHaveLength(5);
  });
});
