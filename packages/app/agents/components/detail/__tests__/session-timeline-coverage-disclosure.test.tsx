import { TranscriptAvailability } from "@repo/api/src/types/desktop-transcripts";
import { SessionEvidenceCoverage } from "@repo/api/src/types/session-evidence-coverage-constants";
import { SESSION_TIMELINE_COVERAGE_DISCLOSURE_FLAG_KEY } from "@repo/api/src/types/session-timeline-coverage-disclosure-flag";
import { TranscriptSkipReason } from "@repo/api/src/types/transcript-skip-reason-constants";
import { SESSION_TIMELINE_SYNTHESIZED_COST_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { TRACE_LATER_ACTIVITY_UNREAD_LEGEND } from "@repo/app/shared/lib/trace-truncation-copy";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TIMELINE_SYNTHESIZED_COST_LEGEND } from "../activity-bucket-rendering";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { AgentSessionDetailView } from "../agent-session-detail-view";
import {
  composeTimelineLegend,
  resolveTimelineCoverageLegend,
  resolveTimelineTruncatedTilingLegend,
  TIMELINE_EVIDENCE_COVERAGE_LEGEND,
} from "../session-timeline-coverage";
import { SESSION_TIMELINE_LEGEND_ID } from "../session-timeline-header";
import { withProviders } from "./agent-session-detail-view.test-helpers";

/**
 * ISS-7427 AC5: "the timeline clearly distinguishes measured segments from
 * unknown/unavailable spans; it never implies complete transcript coverage".
 *
 * The strip tiles the intervals the metadata lane holds synced rows for, and its
 * axis starts at the first of them rather than at `session.startedAt`, so
 * uncovered time is drawn as nothing at all. These specs pin which coverage
 * state may say so and, the point of the ticket, which four must not, because
 * "unavailable", "still arriving" and "genuinely quiet" are exactly the states
 * that look alike on a bar chart.
 *
 * The pure specs pin the rule; the composed-view specs mount the real view so
 * deleting the render at the `session-detail-workspace.tsx` call site cannot
 * leave this file green.
 */

const ON = { bucketCount: 4, disclosureEnabled: true };

/** Any claim about what an archive IS — the clause this caption must not make. */
const ARCHIVE_CLAIM_PATTERN = /archiv/i;
const TRANSCRIPT_CLAIM_PATTERN = /transcript/i;

/**
 * Which of the five coverage states may carry the caption. Typed as an
 * EXHAUSTIVE record rather than a list, so a sixth `SessionEvidenceCoverage`
 * fails `tsc` here until someone decides whether the timeline may speak for it —
 * a plain array would silently not cover it.
 */
const DISCLOSES_BY_COVERAGE: Record<SessionEvidenceCoverage, boolean> = {
  [SessionEvidenceCoverage.MainReadable]: false,
  [SessionEvidenceCoverage.MetadataOnly]: true,
  [SessionEvidenceCoverage.NoEvidence]: false,
  [SessionEvidenceCoverage.NotApplicable]: false,
  [SessionEvidenceCoverage.Pending]: false,
};

/**
 * The mixed cohort in the shape that falsified this caption's first draft: the
 * MAIN archive is terminally gone, and a sidechain archive is readable. The
 * per-file size cap rejects main first, so this is what `too_large` normally
 * produces rather than an edge of it — and `readableSubagentTranscriptCount > 0`
 * is itself one of the four signals that PRODUCE `metadataOnly`.
 */
function metadataOnlyWithReadableSubagent() {
  return createAgentSessionDetailFixture({
    evidenceCoverage: SessionEvidenceCoverage.MetadataOnly,
    transcripts: [
      {
        fileKey: "main",
        availability: TranscriptAvailability.PermanentlyUnavailable,
        uploadedAt: null,
        permanentFailureReason: TranscriptSkipReason.TooLarge,
      },
      {
        fileKey: "subagent:reviewer",
        availability: TranscriptAvailability.Available,
        uploadedAt: "2026-06-10T12:19:00.000Z",
        permanentFailureReason: null,
      },
    ],
  });
}

describe("session timeline coverage disclosure (ISS-7427 AC5)", () => {
  it("withdraws the strip's coverage claim when the main transcript is terminally absent", () => {
    expect(
      resolveTimelineCoverageLegend({
        ...ON,
        evidenceCoverage: SessionEvidenceCoverage.MetadataOnly,
      })
    ).toBe(TIMELINE_EVIDENCE_COVERAGE_LEGEND);
  });

  /*
   * The copy, written out here rather than compared against the constant it
   * comes from: an assertion built from the value under test stays green through
   * any rewording, and this sentence is a claim about the data that a silent
   * edit must not be able to change.
   *
   * It claims ONLY the bars' population, and it HEDGES the span. The draft that
   * also said "no archived transcript exists to measure the rest" is false on the
   * very cohort below, and the draft that ended "not the whole session" asserted
   * a shortfall the gate never establishes — a metadata lane that captured every
   * interval reaches this line too. Both clauses are gone, which is why this
   * literal is pinned: a rewrite back to either is a false claim to the user.
   */
  it("claims the bars' population, and hedges rather than asserts a shortfall", () => {
    expect(TIMELINE_EVIDENCE_COVERAGE_LEGEND).toBe(
      "Bars cover synced activity only, which may not span the whole session."
    );
  });

  /*
   * The specific regression: the sentence must not state as FACT that activity
   * is missing. `metadataOnly` means the main transcript is permanently
   * unavailable, not that the metadata lane dropped anything, so a bare "not the
   * whole session" is unsupported. Asserting on the absent phrasing keeps a
   * future edit from reintroducing the overclaim while still passing the
   * equality check above if the constant and the literal are changed together.
   */
  it("never asserts an unestablished shortfall", () => {
    expect(TIMELINE_EVIDENCE_COVERAGE_LEGEND).not.toContain(
      "only, not the whole session"
    );
    expect(TIMELINE_EVIDENCE_COVERAGE_LEGEND).toContain("may not span");
  });

  it("speaks for the mixed cohort alone across every coverage state", () => {
    for (const [coverage, discloses] of Object.entries(DISCLOSES_BY_COVERAGE)) {
      expect({
        coverage,
        legend: resolveTimelineCoverageLegend({
          ...ON,
          evidenceCoverage: coverage as SessionEvidenceCoverage,
        }),
      }).toEqual({
        coverage,
        legend: discloses ? TIMELINE_EVIDENCE_COVERAGE_LEGEND : null,
      });
    }
  });

  it("stays silent when the server sent no classification", () => {
    expect(
      resolveTimelineCoverageLegend({ ...ON, evidenceCoverage: undefined })
    ).toBeNull();
  });

  it("stays silent while the flag is off", () => {
    expect(
      resolveTimelineCoverageLegend({
        bucketCount: 4,
        disclosureEnabled: false,
        evidenceCoverage: SessionEvidenceCoverage.MetadataOnly,
      })
    ).toBeNull();
  });

  it("stays silent when the strip drew no bars to qualify", () => {
    expect(
      resolveTimelineCoverageLegend({
        bucketCount: 0,
        disclosureEnabled: true,
        evidenceCoverage: SessionEvidenceCoverage.MetadataOnly,
      })
    ).toBeNull();
  });

  /*
   * The caption's blast radius, pinned on the composition rather than on the
   * coverage state — the axis the exhaustive record above cannot express, since
   * any of the five states can carry any evidence shape. A `metadataOnly`
   * session WITH a readable sidechain renders the transcript switcher's chip for
   * it, so a caption asserting no archive exists would contradict the row of
   * links directly above it.
   */
  it("says nothing about archives that a readable sidechain would contradict", () => {
    const session = metadataOnlyWithReadableSubagent();

    render(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={session}
        />,
        [SESSION_TIMELINE_COVERAGE_DISCLOSURE_FLAG_KEY]
      )
    );

    const legend = screen.getByText(TIMELINE_EVIDENCE_COVERAGE_LEGEND);
    expect(legend).toBeInTheDocument();
    expect(legend).not.toHaveTextContent(ARCHIVE_CLAIM_PATTERN);
    expect(legend).not.toHaveTextContent(TRANSCRIPT_CLAIM_PATTERN);
  });

  it("renders the caption under the timeline on the composed view", () => {
    render(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={createAgentSessionDetailFixture({
            evidenceCoverage: SessionEvidenceCoverage.MetadataOnly,
          })}
        />,
        [SESSION_TIMELINE_COVERAGE_DISCLOSURE_FLAG_KEY]
      )
    );

    expect(
      screen.getByText(TIMELINE_EVIDENCE_COVERAGE_LEGEND)
    ).toBeInTheDocument();
  });

  // The same mount with no flag enabled. Its sibling above proves this locator
  // can resolve at all, so the absence here is the gate working rather than a
  // query that never matches.
  it("renders no caption on the composed view while the flag is off", () => {
    render(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={createAgentSessionDetailFixture({
            evidenceCoverage: SessionEvidenceCoverage.MetadataOnly,
          })}
        />
      )
    );

    expect(
      screen.queryByText(TIMELINE_EVIDENCE_COVERAGE_LEGEND)
    ).not.toBeInTheDocument();
  });

  // Flag ON, archive readable: proves the composed view gates on the VERDICT and
  // not merely on the flag.
  it("renders no caption on the composed view when the archive is readable", () => {
    render(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={createAgentSessionDetailFixture({
            evidenceCoverage: SessionEvidenceCoverage.MainReadable,
          })}
        />,
        [SESSION_TIMELINE_COVERAGE_DISCLOSURE_FLAG_KEY]
      )
    );

    expect(
      screen.queryByText(TIMELINE_EVIDENCE_COVERAGE_LEGEND)
    ).not.toBeInTheDocument();
  });

  /*
   * FEA-4025 keeps the caption OUTSIDE the pinned region, so without this
   * association a screen-reader user hears every bar in "Session Timeline" and
   * only meets the sentence withdrawing its coverage after leaving the landmark.
   */
  it("describes the timeline region by the caption that qualifies it", () => {
    render(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={createAgentSessionDetailFixture({
            evidenceCoverage: SessionEvidenceCoverage.MetadataOnly,
          })}
        />,
        [SESSION_TIMELINE_COVERAGE_DISCLOSURE_FLAG_KEY]
      )
    );

    const region = document.querySelector<HTMLElement>(
      `section[aria-describedby="${SESSION_TIMELINE_LEGEND_ID}"]`
    );
    expect(region).not.toBeNull();
    expect(
      document.getElementById(SESSION_TIMELINE_LEGEND_ID)
    ).toHaveTextContent(TIMELINE_EVIDENCE_COVERAGE_LEGEND);
  });

  // The region must NOT advertise a description that is not on the page — an
  // `aria-describedby` pointing at a missing id is worse than none.
  it("leaves the region undescribed when no caption renders", () => {
    render(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={createAgentSessionDetailFixture({
            evidenceCoverage: SessionEvidenceCoverage.MainReadable,
          })}
        />,
        [SESSION_TIMELINE_COVERAGE_DISCLOSURE_FLAG_KEY]
      )
    );

    expect(
      document.querySelector(
        `section[aria-describedby="${SESSION_TIMELINE_LEGEND_ID}"]`
      )
    ).toBeNull();
  });
});

/**
 * The two withdrawals share one line. They are independent facts behind
 * independent flags, so the composition has to be neutral when only one is live
 * — otherwise this ticket's gate would silently reword a caption ISS-5566 owns.
 */
describe("timeline legend composition (ISS-7427 AC5)", () => {
  it("returns a lone note verbatim, so the other gate's line is unchanged", () => {
    expect(
      composeTimelineLegend([TIMELINE_SYNTHESIZED_COST_LEGEND, null])
    ).toBe(TIMELINE_SYNTHESIZED_COST_LEGEND);
    expect(
      composeTimelineLegend([null, TIMELINE_EVIDENCE_COVERAGE_LEGEND])
    ).toBe(TIMELINE_EVIDENCE_COVERAGE_LEGEND);
  });

  it("has nothing to say when neither gate is live", () => {
    expect(composeTimelineLegend([null, null])).toBeNull();
  });

  it("joins both withdrawals into one line", () => {
    expect(
      composeTimelineLegend([
        TIMELINE_SYNTHESIZED_COST_LEGEND,
        TIMELINE_EVIDENCE_COVERAGE_LEGEND,
      ])
    ).toBe(
      `${TIMELINE_SYNTHESIZED_COST_LEGEND} · ${TIMELINE_EVIDENCE_COVERAGE_LEGEND}`
    );
  });

  /*
   * The stacking case, on the real view with BOTH gates open — the state the
   * design review found was unlookable, because the story enabled this ticket's
   * flag without ISS-5566's and therefore never produced the pair it described.
   */
  it("renders both withdrawals in one element on the composed view", () => {
    render(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={createAgentSessionDetailFixture({
            evidenceCoverage: SessionEvidenceCoverage.MetadataOnly,
          })}
        />,
        [
          SESSION_TIMELINE_COVERAGE_DISCLOSURE_FLAG_KEY,
          SESSION_TIMELINE_SYNTHESIZED_COST_FEATURE_FLAG_KEY,
        ]
      )
    );

    const legend = document.getElementById(SESSION_TIMELINE_LEGEND_ID);
    expect(legend).toHaveTextContent(TIMELINE_SYNTHESIZED_COST_LEGEND);
    expect(legend).toHaveTextContent(TIMELINE_EVIDENCE_COVERAGE_LEGEND);
  });
});

describe("timeline truncated-tiling legend (ISS-9858)", () => {
  it("speaks only for a read that hit the tiling ceiling", () => {
    expect(
      resolveTimelineTruncatedTilingLegend({
        bucketCount: 4,
        rowsTruncated: true,
      })
    ).toBe(TRACE_LATER_ACTIVITY_UNREAD_LEGEND);
    for (const rowsTruncated of [false, null, undefined] as const) {
      expect(
        resolveTimelineTruncatedTilingLegend({ bucketCount: 4, rowsTruncated })
      ).toBeNull();
    }
  });

  it("stays silent when the strip drew no bars to qualify", () => {
    expect(
      resolveTimelineTruncatedTilingLegend({
        bucketCount: 0,
        rowsTruncated: true,
      })
    ).toBeNull();
  });
});
