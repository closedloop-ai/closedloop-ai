import { SessionEvidenceCoverage } from "@repo/api/src/types/session-evidence-coverage-constants";
import { SESSION_TIMELINE_COVERAGE_DISCLOSURE_FLAG_KEY } from "@repo/api/src/types/session-timeline-coverage-disclosure-flag";
import { SESSION_TIMELINE_SYNTHESIZED_COST_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import {
  TRACE_LATER_ACTIVITY_UNREAD_LEGEND,
  TRACE_UNREAD_TAIL_LEGEND,
} from "@repo/app/shared/lib/trace-truncation-copy";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TIMELINE_SYNTHESIZED_COST_LEGEND } from "../activity-bucket-rendering";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { AgentSessionDetailView } from "../agent-session-detail-view";
import { TIMELINE_EVIDENCE_COVERAGE_LEGEND } from "../session-timeline-coverage";
import { SESSION_TIMELINE_LEGEND_ID } from "../session-timeline-header";
import { withProviders } from "./agent-session-detail-view.test-helpers";

/**
 * ISS-9858: `AgentSessionDetail.activitySegmentRowsTruncated` reaches the
 * screen. The detail read serves the activity tiling as a start-ordered prefix
 * when it hits the stored ceiling, and that tiling sizes the axis window, so a
 * cut tiling could end the axis early with nothing on screen to say so.
 *
 * Mounts the COMPOSED view, because the claim under test is what the reader
 * sees under the strip, not a resolver's return value; deleting the note at
 * the `session-detail-workspace.tsx` call site turns this file red. Shared
 * verbatim by web and desktop through `@repo/app`, so pinning the composed view
 * pins both shells — no desktop-only lane exercises this line.
 *
 * Every session here is fixture-only: no shipped producer emits a tiling past
 * the ceiling, so the flag is a backstop and this suite is where the state can
 * be looked at.
 */

const STRIP_EMPTY_STATE = "No activity recorded for this session.";
const REGION_DESCRIBED_SELECTOR = `section[aria-describedby="${SESSION_TIMELINE_LEGEND_ID}"]`;

function renderDetail(
  session: ReturnType<typeof createAgentSessionDetailFixture>,
  enabledFlags?: readonly string[]
) {
  return render(
    withProviders(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={session}
      />,
      enabledFlags
    )
  );
}

function readLegend(): string | null {
  return (
    document.getElementById(SESSION_TIMELINE_LEGEND_ID)?.textContent ?? null
  );
}

describe("session timeline tiling truncation (ISS-9858)", () => {
  // Absence, `false` and `null` all mean "the read did not hit its ceiling" —
  // the field is additive and a server that predates it omits it.
  for (const activitySegmentRowsTruncated of [
    undefined,
    false,
    null,
  ] as const) {
    it(`renders no legend when the flag is ${String(activitySegmentRowsTruncated)}`, () => {
      renderDetail(
        createAgentSessionDetailFixture({ activitySegmentRowsTruncated })
      );

      expect(readLegend()).toBeNull();
      expect(document.querySelector(REGION_DESCRIBED_SELECTOR)).toBeNull();
    });
  }

  it("says the timeline may end early when the tiling was served as a prefix", () => {
    renderDetail(
      createAgentSessionDetailFixture({ activitySegmentRowsTruncated: true })
    );

    expect(readLegend()).toBe(TRACE_LATER_ACTIVITY_UNREAD_LEGEND);
  });

  // The legend sits outside the region, so the region must point at it or a
  // screen-reader user traverses the timeline before hearing that it may end
  // early. The coverage flag is off here: the tiling note drives the id alone.
  it("describes the region by the legend when only the tiling note renders", () => {
    renderDetail(
      createAgentSessionDetailFixture({ activitySegmentRowsTruncated: true })
    );

    expect(document.querySelector(REGION_DESCRIBED_SELECTOR)).not.toBeNull();
  });

  /*
   * A strip that drew nothing already says so in its own words. Both the
   * persisted buckets AND the transcript rows the strip would synthesize from
   * are empty here, so the strip genuinely draws no bar — an empty
   * `activityBuckets` alone still yields a synthesized strip from `turnItems`.
   */
  it("stays silent when the strip drew no bars, so two claims never sit on an absent element", () => {
    renderDetail(
      createAgentSessionDetailFixture({
        activityBuckets: [],
        activitySegmentRowsTruncated: true,
        events: [],
        turnItems: [],
      })
    );

    expect(screen.getByText(STRIP_EMPTY_STATE)).toBeInTheDocument();
    expect(readLegend()).toBeNull();
    expect(document.querySelector(REGION_DESCRIBED_SELECTOR)).toBeNull();
  });

  // Join order is pinned: the pre-existing legends keep their positions and
  // the tiling note is appended last.
  it("joins after the synthesized-cost legend when both are live", () => {
    renderDetail(
      createAgentSessionDetailFixture({ activitySegmentRowsTruncated: true }),
      [SESSION_TIMELINE_SYNTHESIZED_COST_FEATURE_FLAG_KEY]
    );

    expect(readLegend()).toBe(
      `${TIMELINE_SYNTHESIZED_COST_LEGEND} · ${TRACE_LATER_ACTIVITY_UNREAD_LEGEND}`
    );
    expect(document.querySelector(REGION_DESCRIBED_SELECTOR)).not.toBeNull();
  });

  // The cost legend withdraws the bars' HEIGHTS, not their extent, and sits
  // behind its own flag, so a line carrying it alone never describes the
  // region. Without this case, "any legend describes the region" stays green.
  it("leaves the region undescribed when only the synthesized-cost legend renders", () => {
    renderDetail(createAgentSessionDetailFixture(), [
      SESSION_TIMELINE_SYNTHESIZED_COST_FEATURE_FLAG_KEY,
    ]);

    expect(readLegend()).toBe(TIMELINE_SYNTHESIZED_COST_LEGEND);
    expect(document.querySelector(REGION_DESCRIBED_SELECTOR)).toBeNull();
  });

  it("joins after the coverage legend, and the region stays described", () => {
    renderDetail(
      createAgentSessionDetailFixture({
        activitySegmentRowsTruncated: true,
        evidenceCoverage: SessionEvidenceCoverage.MetadataOnly,
      }),
      [SESSION_TIMELINE_COVERAGE_DISCLOSURE_FLAG_KEY]
    );

    expect(readLegend()).toBe(
      `${TIMELINE_EVIDENCE_COVERAGE_LEGEND} · ${TRACE_LATER_ACTIVITY_UNREAD_LEGEND}`
    );
    expect(document.querySelector(REGION_DESCRIBED_SELECTOR)).not.toBeNull();
  });

  /*
   * Two independent facts on one screen: the EVENT stream was cut (the strip's
   * own caption, pointing at its shaded tail) and the activity TILING was cut
   * (the legend beneath). Neither suppresses the other, and they render in
   * distinct elements with distinct words.
   */
  it("renders beside the strip's own events caption when both reads were cut", () => {
    renderDetail(
      createAgentSessionDetailFixture({
        activitySegmentRowsTruncated: true,
        eventsTruncated: true,
      })
    );

    const stripCaption = document.querySelector(".sd3-actbar p");
    expect(stripCaption).toHaveTextContent(TRACE_UNREAD_TAIL_LEGEND);
    expect(stripCaption).not.toHaveTextContent(
      TRACE_LATER_ACTIVITY_UNREAD_LEGEND
    );
    expect(readLegend()).toBe(TRACE_LATER_ACTIVITY_UNREAD_LEGEND);
  });
});
