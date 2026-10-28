/**
 * ISS-5951 — the timeline headline cost and its incompleteness marker must come
 * from ONE predicate.
 *
 * They used to be two expressions. The VALUE fell back to the chartable subtotal
 * when `timingIncomplete || authoritativeCost == null`; the MARKER was decided
 * separately at the render site from `timingIncomplete` and aggregate trace
 * completeness. The second fallback reason therefore rendered a fallback figure
 * with nothing saying it was one.
 *
 * That divergence was masked for a long time. `MergedTraceItem.t` was revived
 * into a `Date` on web, so both `typeof t === "string"` guards
 * (`branch-burst-spans.ts`, `branch-derivations.ts`) rejected every trace item
 * and aggregate completeness read `Incomplete` almost everywhere — the marker
 * was on for a reason unrelated to its stated meaning. ISS-5771 stopped the
 * revival and the two rules could finally disagree.
 *
 * The divergence fixture below is deliberately the case where the two OLD marker
 * inputs are both quiet: timing is complete (no disclosure is rendered) and the
 * trace reports Complete, so aggregate completeness cannot mark anything. Only
 * the predicate that actually selected the value can. A fixture where the two
 * notions happen to agree would prove nothing here.
 *
 * Reaching it needs the legacy producer shape: `attributedCostUsd` absent and
 * `estimatedCostUsd` null (the documented null-on-zero compatibility behavior)
 * while linked Sessions carry priced spend. An explicit `attributedCostUsd:
 * null` cannot reach it — `buildSessionTimeline` treats that as branch cost
 * unavailable and nulls the chartable subtotal too, so the headline honestly
 * reads "Unavailable" instead.
 *
 * That fixture carries a LOADED trace rather than a null one. `traceState: null`
 * is now its own rendered outcome (item 4 below), so pairing it with this shape
 * would prove the absent-evidence rule and quietly stop proving this one.
 *
 * whitlockk review — three states where the marker was still on or off for the wrong
 * reason, each covered below:
 *
 * 1. A loaded trace makes `detailForLoadedTimelineSessions` rewrite that legacy
 *    branch's null `estimatedCostUsd` to the loaded-Session subtotal, so the
 *    RENDERED figure looked authoritative and the marker vanished while the
 *    source Branch still had no total. Source absence is now read from the
 *    unrewritten `detail` and carried separately, so the null-to-loaded
 *    transition keeps the marker.
 * 2. Aggregate trace incompleteness marks a figure inside
 *    `formatTimelineEvidenceValue` on its own. That reason now joins the same
 *    predicate, so a marked figure always carries `aria-describedby` and a
 *    disclosure sentence instead of an asterisk with no footnote.
 * 3. With no cost resolvable at all the fallback sentence still fired, claiming
 *    the total shown is the charted spend beside a figure reading "Unavailable".
 *    It is now set only when a non-null chartable figure was actually selected.
 *
 * davetho review — the fourth state, and the one the fixtures above were
 * silently standing on:
 *
 * 4. A trace that never arrived was read as `!== Incomplete`, the same answer a
 *    CONFIRMED-complete trace gives, so cost, LOC/$ and duration rendered as
 *    supported figures with no completeness evidence behind them at all. The
 *    boundary is now read once into a four-member state, and absent evidence
 *    renders "Unavailable" instead — gated, with the gate-closed render pinned
 *    as its positive control.
 */
import {
  BranchTraceCompletenessState,
  BranchTraceSessionHydrationState,
  type BranchTraceState,
  BranchTraceUnavailableReason,
} from "@repo/api/src/types/branch-trace";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { BRANCH_TIMELINE_COST_FALLBACK_MARKER_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  makeBranchDetail,
  makeBranchSession,
} from "../../__tests__/branch-fixtures";
import { BranchPrActivityTimeline } from "../branch-pr-activity-timeline";
import {
  detailForLoadedTimelineSessions,
  formatTimelineEvidenceValue,
  resolveTimelineCostEvidence,
  TimelineTraceEvidence,
} from "../branch-pr-activity-timeline-helpers";
import { costStat } from "./branch-timeline-header-stats.test-helpers";

const TIMING_UNAVAILABLE_RE = /Timing is unavailable for SES-2/;
const UNPRICED_BRANCH_RE = /no attributed cost of its own/;
const INCOMPLETE_EVIDENCE_RE = /trace evidence could not be loaded/;
const UNAVAILABLE_FIGURE = formatTimelineEvidenceValue(
  "",
  TimelineTraceEvidence.Unavailable
);
function loadedTraceState(artifactIds: readonly string[]): BranchTraceState {
  return {
    sessions: artifactIds.map((artifactId) => ({
      identity: {
        artifactId,
        name: artifactId,
        navigableRef: artifactId,
        slug: artifactId,
      },
      state: BranchTraceSessionHydrationState.Loaded,
    })),
    qualifyingSessionCount: artifactIds.length,
    completeness: { state: BranchTraceCompletenessState.Complete },
    aggregateCompleteness: { state: BranchTraceCompletenessState.Complete },
  };
}

function chartableSession(over: Partial<ReturnType<typeof makeBranchSession>>) {
  return makeBranchSession({
    startedAt: "2026-06-10T10:00:00.000Z",
    endedAt: "2026-06-10T11:00:00.000Z",
    estimatedCostUsd: 5,
    ownerUserName: "Cosimo",
    ...over,
  });
}

/** Legacy producer: no attributed total, null-on-zero raw total, priced Sessions. */
function legacyUnpricedBranchDetail() {
  return makeBranchDetail({
    additions: 100,
    deletions: 0,
    estimatedCostUsd: null,
    sessions: [chartableSession({ sessionId: "s1", slug: "SES-1" })],
  });
}

/**
 * The mixed loaded/unavailable trace evidence shape: one Session hydrated, one
 * could not be read, so the aggregate evidence is incomplete.
 */
function mixedTraceState(): BranchTraceState {
  return {
    sessions: [
      {
        identity: {
          artifactId: "s1",
          name: "Loaded Session",
          navigableRef: "SES-1",
          slug: "SES-1",
        },
        state: BranchTraceSessionHydrationState.Loaded,
      },
      {
        identity: {
          artifactId: "s2",
          name: "Unavailable Session",
          navigableRef: "SES-2",
          slug: "SES-2",
        },
        reason: BranchTraceUnavailableReason.Permission,
        state: BranchTraceSessionHydrationState.Unavailable,
      },
    ],
    qualifyingSessionCount: 2,
    completeness: { state: BranchTraceCompletenessState.Incomplete },
    aggregateCompleteness: { state: BranchTraceCompletenessState.Incomplete },
  };
}

function unstampedOnlyLoadedTraceState(): BranchTraceState {
  return {
    sessions: [
      {
        identity: {
          artifactId: "s1",
          name: "Stamped Session",
          navigableRef: "SES-1",
          slug: "SES-1",
        },
        reason: BranchTraceUnavailableReason.Permission,
        state: BranchTraceSessionHydrationState.Unavailable,
      },
      {
        identity: {
          artifactId: "s2",
          name: "Unstamped Session",
          navigableRef: "SES-2",
          slug: "SES-2",
        },
        state: BranchTraceSessionHydrationState.Loaded,
      },
    ],
    qualifyingSessionCount: 2,
    completeness: { state: BranchTraceCompletenessState.Incomplete },
    aggregateCompleteness: { state: BranchTraceCompletenessState.Incomplete },
  };
}

function allSessionsLoadedTruncatedTraceState(): BranchTraceState {
  return {
    sessions: ["s1", "s2"].map((artifactId) => ({
      identity: {
        artifactId,
        name: artifactId,
        navigableRef: artifactId,
        slug: artifactId,
      },
      state: BranchTraceSessionHydrationState.Loaded,
    })),
    qualifyingSessionCount: 2,
    completeness: {
      eventsTruncated: true,
      state: BranchTraceCompletenessState.Incomplete,
    },
    aggregateCompleteness: {
      eventsTruncated: true,
      state: BranchTraceCompletenessState.Incomplete,
    },
  };
}

/** A priced Branch whose second Session's trace evidence never loaded. */
function mixedEvidenceDetail() {
  return makeBranchDetail({
    additions: 20,
    attributedCostUsd: 5,
    deletions: 0,
    estimatedCostUsd: 10,
    sessions: [
      chartableSession({
        sessionId: "s1",
        slug: "SES-1",
        estimatedCostUsd: 4,
        evenSplitCostUsd: 2,
      }),
      chartableSession({
        sessionId: "s2",
        slug: "SES-2",
        startedAt: "2026-06-10T12:00:00.000Z",
        endedAt: "2026-06-10T13:00:00.000Z",
        estimatedCostUsd: 6,
        evenSplitCostUsd: 3,
      }),
    ],
  });
}

/**
 * The legacy shape whose loaded trace used to fabricate a numeric subtotal from
 * all-unpriced loaded Sessions.
 *
 * Timing is complete and the trace reports Complete, so this fixture isolates
 * the loaded-cost evidence path.
 */
function unpricedSessionLegacyBranchDetail() {
  return makeBranchDetail({
    additions: 100,
    deletions: 0,
    estimatedCostUsd: null,
    sessions: [
      chartableSession({
        sessionId: "s1",
        slug: "SES-1",
        estimatedCostUsd: null,
      }),
    ],
  });
}

/** Legacy producer with a loaded Session whose cost is known to be zero. */
function zeroCostSessionLegacyBranchDetail() {
  return makeBranchDetail({
    additions: 100,
    deletions: 0,
    estimatedCostUsd: null,
    sessions: [
      chartableSession({
        sessionId: "s1",
        slug: "SES-1",
        estimatedCostUsd: 0,
      }),
    ],
  });
}

function mixedZeroAndUnpricedSessionLegacyBranchDetail() {
  return makeBranchDetail({
    additions: 100,
    deletions: 0,
    estimatedCostUsd: null,
    sessions: [
      chartableSession({
        sessionId: "s1",
        slug: "SES-1",
        estimatedCostUsd: 0,
      }),
      chartableSession({
        sessionId: "s2",
        slug: "SES-2",
        estimatedCostUsd: null,
      }),
    ],
  });
}

/** Nothing is priced at either end: no Branch total and no chartable spend. */
function unresolvableCostDetail() {
  return makeBranchDetail({
    additions: 100,
    attributedCostUsd: null,
    deletions: 0,
    estimatedCostUsd: null,
    sessions: [
      chartableSession({
        sessionId: "s1",
        slug: "SES-1",
        estimatedCostUsd: null,
      }),
    ],
  });
}

/** The same Branch, but with an authoritative total to prefer. */
function pricedBranchDetail() {
  return makeBranchDetail({
    additions: 100,
    deletions: 0,
    estimatedCostUsd: 5,
    attributedCostUsd: 5,
    sessions: [chartableSession({ sessionId: "s1", slug: "SES-1" })],
  });
}

/** A complete trace whose Branch total must govern mixed stamped rows. */
function mixedStampedBranchDetail() {
  return makeBranchDetail({
    additions: 100,
    attributedCostUsd: 15,
    deletions: 0,
    estimatedCostUsd: 20,
    sessions: [
      chartableSession({
        sessionId: "s1",
        slug: "SES-1",
        estimatedCostUsd: 10,
        evenSplitCostUsd: 10,
      }),
      chartableSession({
        sessionId: "s2",
        slug: "SES-2",
        estimatedCostUsd: 10,
        ownerUserName: "Tamsin",
      }),
    ],
  });
}

/** A priced Branch with one loaded Session that cannot produce a bar. */
function timingIncompleteDetail() {
  return makeBranchDetail({
    additions: 100,
    deletions: 0,
    estimatedCostUsd: 12,
    attributedCostUsd: 12,
    sessions: [
      chartableSession({ sessionId: "s1", slug: "SES-1" }),
      chartableSession({
        sessionId: "s2",
        slug: "SES-2",
        startedAt: "2026-06-10T12:00:00.000Z",
        endedAt: "2026-06-10T12:00:00.000Z",
        estimatedCostUsd: 7,
        ownerUserName: "Tamsin",
      }),
    ],
  });
}

function renderTimeline({
  detail,
  traceState,
  markerEnabled,
}: {
  detail: ReturnType<typeof makeBranchDetail>;
  traceState: BranchTraceState | null;
  markerEnabled: boolean;
}) {
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: markerEnabled
          ? [BRANCH_TIMELINE_COST_FALLBACK_MARKER_FEATURE_FLAG_KEY]
          : [],
      })}
    >
      <BranchPrActivityTimeline detail={detail} traceState={traceState} />
    </FeatureFlagAdapterProvider>
  );
}

describe("detailForLoadedTimelineSessions", () => {
  it("keeps all-unpriced loaded Session evidence at the legacy zero without the gated rewrite", () => {
    const renderedDetail = detailForLoadedTimelineSessions(
      unpricedSessionLegacyBranchDetail(),
      loadedTraceState(["s1"])
    );

    expect(renderedDetail.estimatedCostUsd).toBe(0);
  });

  it("keeps all-unpriced loaded Session evidence unavailable with the gated rewrite", () => {
    const renderedDetail = detailForLoadedTimelineSessions(
      unpricedSessionLegacyBranchDetail(),
      loadedTraceState(["s1"]),
      { requireKnownLoadedCost: true }
    );

    expect(renderedDetail.estimatedCostUsd).toBeNull();
  });

  it("keeps known zero loaded Session evidence distinct from unavailable", () => {
    const renderedDetail = detailForLoadedTimelineSessions(
      zeroCostSessionLegacyBranchDetail(),
      loadedTraceState(["s1"]),
      { requireKnownLoadedCost: true }
    );

    expect(renderedDetail.estimatedCostUsd).toBe(0);
  });

  it("keeps mixed zero and unpriced loaded Session evidence unavailable with the gated rewrite", () => {
    const renderedDetail = detailForLoadedTimelineSessions(
      mixedZeroAndUnpricedSessionLegacyBranchDetail(),
      loadedTraceState(["s1", "s2"]),
      { requireKnownLoadedCost: true }
    );

    expect(renderedDetail.estimatedCostUsd).toBeNull();
  });
});

describe("resolveTimelineCostEvidence", () => {
  it("returns the authoritative total and marks nothing", () => {
    expect(
      resolveTimelineCostEvidence({
        authoritativeCostUsd: 9,
        chartableCostUsd: 5,
        discloseFallbackReasons: true,
        sourceCostUnpriced: false,
        timingIncomplete: false,
        traceEvidence: TimelineTraceEvidence.Complete,
      })
    ).toEqual({
      value: 9,
      evidenceMissing: false,
      incomplete: false,
      incompleteTraceEvidence: false,
      unpricedBranchFallback: false,
    });
  });

  it("falls back to the chartable subtotal when timing is incomplete", () => {
    expect(
      resolveTimelineCostEvidence({
        authoritativeCostUsd: 9,
        chartableCostUsd: 5,
        sourceCostUnpriced: false,
        timingIncomplete: true,
        traceEvidence: TimelineTraceEvidence.Complete,
      })
    ).toEqual({
      value: 5,
      evidenceMissing: false,
      incomplete: true,
      incompleteTraceEvidence: false,
      unpricedBranchFallback: false,
    });
  });

  it("falls back \u2014 and says so \u2014 when there is no authoritative total", () => {
    expect(
      resolveTimelineCostEvidence({
        authoritativeCostUsd: null,
        chartableCostUsd: 5,
        discloseFallbackReasons: true,
        sourceCostUnpriced: true,
        timingIncomplete: false,
        traceEvidence: TimelineTraceEvidence.Complete,
      })
    ).toEqual({
      value: 5,
      evidenceMissing: false,
      incomplete: true,
      incompleteTraceEvidence: false,
      unpricedBranchFallback: true,
    });
  });

  // whitlockk 1 at the predicate itself: the figure handed in is a settled number
  // (a loaded trace rewrote it), and only the separately-carried source absence
  // can still reach the fallback reason.
  it("says so from source absence even when the figure was rewritten to a number", () => {
    expect(
      resolveTimelineCostEvidence({
        authoritativeCostUsd: 5,
        chartableCostUsd: 5,
        discloseFallbackReasons: true,
        sourceCostUnpriced: true,
        timingIncomplete: false,
        traceEvidence: TimelineTraceEvidence.Complete,
      })
    ).toEqual({
      value: 5,
      evidenceMissing: false,
      incomplete: true,
      incompleteTraceEvidence: false,
      unpricedBranchFallback: true,
    });
  });

  // whitlockk 2: the reason that marks a figure inside `formatTimelineEvidenceValue`
  // has to come back out of this predicate, or the marker it puts on the figure
  // has no describedby and no sentence.
  it("carries aggregate trace incompleteness as its own disclosed reason", () => {
    expect(
      resolveTimelineCostEvidence({
        authoritativeCostUsd: 2,
        chartableCostUsd: 2,
        discloseFallbackReasons: true,
        sourceCostUnpriced: false,
        timingIncomplete: false,
        traceEvidence: TimelineTraceEvidence.Incomplete,
      })
    ).toEqual({
      value: 2,
      evidenceMissing: false,
      incomplete: true,
      incompleteTraceEvidence: true,
      unpricedBranchFallback: false,
    });
  });

  // The gate is an INPUT, so it can only narrow what is DISCLOSED \u2014 it must
  // never change which number the timeline shows.
  it("still falls back with the gate closed, but marks nothing", () => {
    expect(
      resolveTimelineCostEvidence({
        authoritativeCostUsd: null,
        chartableCostUsd: 5,
        discloseFallbackReasons: false,
        sourceCostUnpriced: true,
        timingIncomplete: false,
        traceEvidence: TimelineTraceEvidence.Incomplete,
      })
    ).toEqual({
      value: 5,
      evidenceMissing: false,
      incomplete: false,
      incompleteTraceEvidence: false,
      unpricedBranchFallback: false,
    });
  });

  // The gate-closed case the other two could not be. Both of them hand in
  // `authoritativeCostUsd: null`, which reaches the fallback on its own, so
  // they answer the same whether or not the NEW `sourceCostUnpriced` reason is
  // gated. Here the authoritative figure is a settled `0` and only that new
  // reason can move the selection — so with the gate closed it must not, or the
  // rendered NUMBER changes on the closed-by-default path.
  it("does not let the new unpriced-source reason pick the figure while the gate is closed", () => {
    expect(
      resolveTimelineCostEvidence({
        authoritativeCostUsd: 0,
        chartableCostUsd: null,
        discloseFallbackReasons: false,
        sourceCostUnpriced: true,
        timingIncomplete: false,
        traceEvidence: TimelineTraceEvidence.Complete,
      })
    ).toEqual({
      value: 0,
      evidenceMissing: false,
      incomplete: false,
      incompleteTraceEvidence: false,
      unpricedBranchFallback: false,
    });
  });

  // The same inputs with the gate OPEN, so the case above is pinning the gate
  // rather than the reason being absent altogether: the new reason is a real,
  // deliberate behavior change and it belongs entirely behind the flag.
  it("lets that reason pick the figure once the gate is open", () => {
    expect(
      resolveTimelineCostEvidence({
        authoritativeCostUsd: 0,
        chartableCostUsd: null,
        discloseFallbackReasons: true,
        sourceCostUnpriced: true,
        timingIncomplete: false,
        traceEvidence: TimelineTraceEvidence.Complete,
      })
    ).toEqual({
      value: null,
      evidenceMissing: false,
      incomplete: false,
      incompleteTraceEvidence: false,
      unpricedBranchFallback: false,
    });
  });

  it("keeps the timing marker when the gate is closed", () => {
    expect(
      resolveTimelineCostEvidence({
        authoritativeCostUsd: null,
        chartableCostUsd: 5,
        discloseFallbackReasons: false,
        sourceCostUnpriced: true,
        timingIncomplete: true,
        traceEvidence: TimelineTraceEvidence.Complete,
      })
    ).toEqual({
      value: 5,
      evidenceMissing: false,
      incomplete: true,
      incompleteTraceEvidence: false,
      unpricedBranchFallback: false,
    });
  });

  // whitlockk 3 \u2014 CHANGED EXPECTATION. This case used to assert
  // `unpricedBranchFallback: true`, which set a sentence claiming the total
  // shown is the spend charted above while the figure resolved to nothing and
  // rendered "Unavailable". No chartable figure was selected, so that reason is
  // now off; the value being null is the whole and honest claim.
  // davetho — absent evidence is its own state. The ONLY difference from the
  // first case in this suite is the boundary answer, and it has to be enough to
  // change the outcome; a `traceEvidenceIncomplete` boolean gave `false` here
  // and for a confirmed-complete trace alike.
  it("keeps a trace that never arrived distinct from a confirmed-complete one", () => {
    expect(
      resolveTimelineCostEvidence({
        authoritativeCostUsd: 9,
        chartableCostUsd: 5,
        discloseFallbackReasons: true,
        sourceCostUnpriced: false,
        timingIncomplete: false,
        traceEvidence: TimelineTraceEvidence.Missing,
      })
    ).toEqual({
      value: 9,
      evidenceMissing: true,
      incomplete: false,
      incompleteTraceEvidence: false,
      unpricedBranchFallback: false,
    });
  });

  // Absent evidence is not a resolved zero either: the predicate still reports
  // the figure it computed, so a caller can tell "we have nothing to stand on"
  // apart from "this Branch genuinely spent nothing".
  it("does not collapse absent evidence into a true zero", () => {
    expect(
      resolveTimelineCostEvidence({
        authoritativeCostUsd: 0,
        chartableCostUsd: 0,
        discloseFallbackReasons: true,
        sourceCostUnpriced: false,
        timingIncomplete: false,
        traceEvidence: TimelineTraceEvidence.Missing,
      })
    ).toEqual({
      value: 0,
      evidenceMissing: true,
      incomplete: false,
      incompleteTraceEvidence: false,
      unpricedBranchFallback: false,
    });
  });

  // The gate stays an input here too: with it closed the absent-evidence case
  // must resolve exactly as it did before this change, marker and all.
  it("leaves the absent-evidence case untouched while the gate is closed", () => {
    expect(
      resolveTimelineCostEvidence({
        authoritativeCostUsd: null,
        chartableCostUsd: 5,
        discloseFallbackReasons: false,
        sourceCostUnpriced: true,
        timingIncomplete: false,
        traceEvidence: TimelineTraceEvidence.Missing,
      })
    ).toEqual({
      value: 5,
      evidenceMissing: false,
      incomplete: false,
      incompleteTraceEvidence: false,
      unpricedBranchFallback: false,
    });
  });

  it("reports the unresolvable case with no value and no fallback claim", () => {
    expect(
      resolveTimelineCostEvidence({
        authoritativeCostUsd: null,
        chartableCostUsd: null,
        discloseFallbackReasons: true,
        sourceCostUnpriced: true,
        timingIncomplete: false,
        traceEvidence: TimelineTraceEvidence.Complete,
      })
    ).toEqual({
      value: null,
      evidenceMissing: false,
      incomplete: false,
      incompleteTraceEvidence: false,
      unpricedBranchFallback: false,
    });
  });
});

describe("BranchPrActivityTimeline headline cost (ISS-5951)", () => {
  // davetho — the trace that never arrived. `BranchSessionsTimelineTab` passes
  // `traceQuery.data ?? null` and renders this once the query settles, so a
  // legacy or failed trace response is a real, reachable window. It used to be
  // indistinguishable from a confirmed-complete trace: this same fixture pinned
  // a confident "$5.00" with no evidence behind it at all.
  it("reads the figures as unavailable when no trace evidence arrived", () => {
    renderTimeline({
      detail: legacyUnpricedBranchDetail(),
      traceState: null,
      markerEnabled: true,
    });

    // Cost, LOC/$ and duration all cross the same evidence boundary, so none of
    // the three may present a number the boundary cannot support.
    expect(screen.getAllByText("Unavailable")).toHaveLength(3);
    expect(
      screen.queryByText("$5.00", { exact: true })
    ).not.toBeInTheDocument();
    expect(screen.queryByText("$5.00*")).not.toBeInTheDocument();
    // No figure was shown, so no sentence may claim one was.
    expect(screen.queryByText(UNPRICED_BRANCH_RE)).not.toBeInTheDocument();
  });

  // The positive control for the assertion above: the SAME query and the SAME
  // fixture, with only the gate flipped, must find those figures rendered — so
  // the absence assertion is proving the gate, not a selector that never matches.
  it("leaves those same figures exactly as they were while the gate is closed", () => {
    renderTimeline({
      detail: legacyUnpricedBranchDetail(),
      traceState: null,
      markerEnabled: false,
    });

    expect(
      within(costStat()).getByText("$5.00", { exact: true })
    ).toBeInTheDocument();
    expect(screen.queryByText("$5.00*")).not.toBeInTheDocument();
    expect(screen.queryByText(UNAVAILABLE_FIGURE)).not.toBeInTheDocument();
    expect(screen.queryByText(UNPRICED_BRANCH_RE)).not.toBeInTheDocument();
    expect(screen.queryByText(TIMING_UNAVAILABLE_RE)).not.toBeInTheDocument();
  });

  it("does not mark the authoritative figure when nothing fell back", () => {
    renderTimeline({
      detail: pricedBranchDetail(),
      traceState: loadedTraceState(["s1"]),
      markerEnabled: true,
    });

    expect(
      within(costStat()).getByText("$5.00", { exact: true })
    ).toBeInTheDocument();
    expect(screen.queryByText("$5.00*")).not.toBeInTheDocument();
  });

  it("keeps a complete trace reconciled to the authoritative Branch cost when stamped and unstamped rows mix", () => {
    renderTimeline({
      detail: mixedStampedBranchDetail(),
      traceState: loadedTraceState(["s1", "s2"]),
      markerEnabled: true,
    });

    expect(
      within(costStat()).getByText("$15.00", { exact: true })
    ).toBeInTheDocument();
    expect(
      screen.queryByText("$20.00", { exact: true })
    ).not.toBeInTheDocument();
    expect(screen.getByTitle("Cosimo · $10.00")).toBeInTheDocument();
    expect(screen.getByTitle("Tamsin · $5.00")).toBeInTheDocument();
    expect(screen.queryByTitle("Tamsin · $10.00")).not.toBeInTheDocument();
  });

  it("uses the full source residual scale when only the unstamped row loaded", () => {
    renderTimeline({
      detail: mixedStampedBranchDetail(),
      traceState: unstampedOnlyLoadedTraceState(),
      markerEnabled: true,
    });

    expect(within(costStat()).getByText("$5.00*")).toHaveAccessibleDescription(
      INCOMPLETE_EVIDENCE_RE
    );
    expect(screen.queryByText("$10.00*")).not.toBeInTheDocument();
    expect(screen.queryByTitle("Cosimo · $10.00")).not.toBeInTheDocument();
    expect(screen.getByTitle("Tamsin · $5.00")).toBeInTheDocument();
    expect(screen.queryByTitle("Tamsin · $10.00")).not.toBeInTheDocument();
  });

  it("keeps the Branch cost authoritative when every session loaded but trace events were truncated", () => {
    renderTimeline({
      detail: mixedStampedBranchDetail(),
      traceState: allSessionsLoadedTruncatedTraceState(),
      markerEnabled: true,
    });

    expect(within(costStat()).getByText("$15.00*")).toHaveAccessibleDescription(
      INCOMPLETE_EVIDENCE_RE
    );
    expect(
      screen.queryByText("$17.50*", { exact: true })
    ).not.toBeInTheDocument();
    expect(screen.getByTitle("Cosimo · $10.00")).toBeInTheDocument();
    expect(screen.getByTitle("Tamsin · $5.00")).toBeInTheDocument();
    expect(screen.queryByTitle("Tamsin · $7.50")).not.toBeInTheDocument();
  });

  it("keeps marking — and disclosing — the timing-incomplete fallback under both gate states", () => {
    for (const markerEnabled of [false, true]) {
      const { unmount } = renderTimeline({
        detail: timingIncompleteDetail(),
        traceState: loadedTraceState(["s1", "s2"]),
        markerEnabled,
      });

      expect(
        within(costStat()).getByText("$5.00*")
      ).toHaveAccessibleDescription(TIMING_UNAVAILABLE_RE);
      unmount();
    }
  });

  // whitlockk 1 — the null-to-loaded transition. `detailForLoadedTimelineSessions`
  // rewrites this legacy Branch's null `estimatedCostUsd` to the loaded-Session
  // subtotal, so the figure handed to the predicate is a normal settled number.
  // Only source absence read from the UNREWRITTEN detail can keep the marker on,
  // and the trace here reports Complete so no aggregate reason can supply it.
  it("keeps the fallback marker when a loaded trace rewrites the Branch's absent total", () => {
    renderTimeline({
      detail: legacyUnpricedBranchDetail(),
      traceState: loadedTraceState(["s1"]),
      markerEnabled: true,
    });

    expect(within(costStat()).getByText("$5.00*")).toHaveAccessibleDescription(
      UNPRICED_BRANCH_RE
    );
    expect(screen.getByText(UNPRICED_BRANCH_RE)).toBeInTheDocument();
    // LOC/$ divides by that SAME rewritten stand-in total, so it makes the same
    // claim and owes the same footnote. Left reading only aggregate trace
    // incompleteness it rendered a bare, unqualified `20` beside a cost figure
    // marked `*` for the substitution both figures are built on.
    expect(screen.getByText("20*")).toHaveAccessibleDescription(
      UNPRICED_BRANCH_RE
    );
  });

  it("keeps that transition unmarked while the gate is closed", () => {
    renderTimeline({
      detail: legacyUnpricedBranchDetail(),
      traceState: loadedTraceState(["s1"]),
      markerEnabled: false,
    });

    expect(
      within(costStat()).getByText("$5.00", { exact: true })
    ).toBeInTheDocument();
    expect(screen.queryByText("$5.00*")).not.toBeInTheDocument();
    expect(screen.queryByText(UNPRICED_BRANCH_RE)).not.toBeInTheDocument();
    // The LOC/$ marker is gated with the cost's, so neither figure can leak the
    // disclosure onto the closed-by-default path on its own.
    expect(screen.getByText("20", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText("20*")).not.toBeInTheDocument();
  });

  // ISS-5747 — the unavailable-cost selection is behind the same closed-by-default
  // rollout that gates the Branch timeline fallback-cost behavior.
  it("leaves all-unpriced loaded Sessions on the legacy zero while the gate is closed", () => {
    renderTimeline({
      detail: unpricedSessionLegacyBranchDetail(),
      traceState: loadedTraceState(["s1"]),
      markerEnabled: false,
    });

    expect(screen.getByText("$0.00", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText("$0.00*")).not.toBeInTheDocument();
    expect(screen.queryByText(UNAVAILABLE_FIGURE)).not.toBeInTheDocument();
    expect(screen.queryByText(UNPRICED_BRANCH_RE)).not.toBeInTheDocument();
  });

  it("still renders known zero loaded Session cost as zero once the gate is open", () => {
    renderTimeline({
      detail: zeroCostSessionLegacyBranchDetail(),
      traceState: loadedTraceState(["s1"]),
      markerEnabled: true,
    });

    expect(within(costStat()).getByText("$0.00*")).toHaveAccessibleDescription(
      UNPRICED_BRANCH_RE
    );
    expect(screen.queryByText(UNAVAILABLE_FIGURE)).not.toBeInTheDocument();
  });

  it("keeps mixed zero and unpriced loaded Sessions unavailable once the gate is open", () => {
    renderTimeline({
      detail: mixedZeroAndUnpricedSessionLegacyBranchDetail(),
      traceState: loadedTraceState(["s1", "s2"]),
      markerEnabled: true,
    });

    expect(
      screen.queryByText("$0.00", { exact: true })
    ).not.toBeInTheDocument();
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(screen.queryByText(UNPRICED_BRANCH_RE)).not.toBeInTheDocument();
  });

  it("keeps that fixture unavailable once the gate is open", () => {
    renderTimeline({
      detail: unpricedSessionLegacyBranchDetail(),
      traceState: loadedTraceState(["s1"]),
      markerEnabled: true,
    });

    expect(
      screen.queryByText("$0.00", { exact: true })
    ).not.toBeInTheDocument();
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(screen.queryByText(UNPRICED_BRANCH_RE)).not.toBeInTheDocument();
  });

  // whitlockk 2 — the marker `formatTimelineEvidenceValue` adds from aggregate trace
  // incompleteness used to bypass this predicate entirely, so the figure carried
  // an asterisk with no `aria-describedby` and no paragraph to point at.
  it("resolves the marker aggregate trace incompleteness puts on the figure", () => {
    renderTimeline({
      detail: mixedEvidenceDetail(),
      traceState: mixedTraceState(),
      markerEnabled: true,
    });

    const cost = within(costStat()).getByText("$2.00*");
    expect(cost).toHaveAccessibleDescription(INCOMPLETE_EVIDENCE_RE);
    // The description must resolve to a node that is actually rendered — an
    // `aria-describedby` pointing at nothing is worse than no marker at all.
    const describedBy = cost.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy ?? "")).toBeInTheDocument();
  });

  it("resolves that same marker on every other figure it lands on", () => {
    renderTimeline({
      detail: mixedEvidenceDetail(),
      traceState: mixedTraceState(),
      markerEnabled: true,
    });

    // LOC/$ and duration take the asterisk from the same aggregate reason, so
    // they owe the reader the same footnote the cost figure now carries.
    expect(screen.getByText("10*")).toHaveAccessibleDescription(
      INCOMPLETE_EVIDENCE_RE
    );
    expect(screen.getByText("60m 0s*")).toHaveAccessibleDescription(
      INCOMPLETE_EVIDENCE_RE
    );
  });

  it("leaves the aggregate marker exactly as it was while the gate is closed", () => {
    renderTimeline({
      detail: mixedEvidenceDetail(),
      traceState: mixedTraceState(),
      markerEnabled: false,
    });

    expect(within(costStat()).getByText("$2.00*")).toHaveAccessibleDescription(
      ""
    );
    expect(screen.queryByText(INCOMPLETE_EVIDENCE_RE)).not.toBeInTheDocument();
  });

  // whitlockk 3 — with no cost resolvable at either end the figure reads
  // "Unavailable", so a sentence claiming the total shown is the charted spend
  // describes a total that was never shown.
  // The trace is LOADED here on purpose: with a null trace the figure would now
  // read "Unavailable" for the absent-evidence reason, and this case would pass
  // without ever exercising the unresolvable-cost path it claims to cover.
  it("does not claim the figure is the charted spend when no cost resolved", () => {
    renderTimeline({
      detail: unresolvableCostDetail(),
      traceState: loadedTraceState(["s1"]),
      markerEnabled: true,
    });

    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(screen.queryByText(UNPRICED_BRANCH_RE)).not.toBeInTheDocument();
  });

  it("renders the figure the single predicate selected, never the other candidate", () => {
    // The fallback ($5.00 charted) and the Branch total ($12.00) differ here, so
    // a render that reached for the other candidate is visible.
    renderTimeline({
      detail: timingIncompleteDetail(),
      traceState: loadedTraceState(["s1", "s2"]),
      markerEnabled: true,
    });

    expect(within(costStat()).getByText("$5.00*")).toBeInTheDocument();
    expect(screen.queryByText("$12.00*")).not.toBeInTheDocument();
    expect(screen.queryByText("$12.00")).not.toBeInTheDocument();
  });
});
