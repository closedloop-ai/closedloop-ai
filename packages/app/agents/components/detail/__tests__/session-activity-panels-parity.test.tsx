// ISS-5841: activity phases now ship behind a flag, default off. These cases
// exist to cover the phases surfaces, so they opt the flag ON rather than
// asserting a region the product deliberately hides.

import { DECLARED_EVIDENCE_LAYER } from "@repo/api/src/activity-evidence-layers";
import type { SyncedActivitySegmentRow } from "@repo/api/src/types/agent-session";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SESSION_ACTIVITY_PHASES_FEATURE_FLAG_KEY } from "../../../../shared/lib/feature-flags";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { AgentSessionDetailView } from "../agent-session-detail-view";
import { withProviders } from "./agent-session-detail-view.test-helpers";

// The ISS-4446 regression boundary is the COMPOSED detail view: the Activity
// phases strip (SessionActivitySegments) and the Activity breakdown
// (SessionActivityBreakdown) sit adjacent, both fed by the same session. On a
// capped session they previously told two different stories — the strip showed
// phases, the breakdown denied attribution. This suite mounts the parent view so
// the two panels are asserted together, which the per-component test cannot do.

// A capped session ships the raw tiling (the strip renders it) but NOT the
// priced `activitySegments` (the projection drops them over the pricing cap).
const CAPPED_ROWS: SyncedActivitySegmentRow[] = [
  {
    phase: "implement",
    startMs: 1000,
    endMs: 301_000,
    confidence: 0.8,
    evidenceLayers: [DECLARED_EVIDENCE_LAYER],
    version: 1,
  },
  {
    phase: "review",
    startMs: 301_000,
    endMs: 361_000,
    confidence: 0.5,
    evidenceLayers: ["structural"],
    version: 1,
  },
];

const NO_ATTRIBUTION_FALLBACK = /No per-phase attribution is available/i;
const COST_UNAVAILABLE_CAPTION = /Per-phase cost isn.t available/i;

describe("Activity strip vs breakdown parity on a capped session", () => {
  it("shows the same phases in both adjacent panels with no no-attribution fallback", () => {
    const session = createAgentSessionDetailFixture({
      activitySegmentRows: CAPPED_ROWS,
    });
    render(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={session}
        />,
        [SESSION_ACTIVITY_PHASES_FEATURE_FLAG_KEY]
      )
    );

    // The strip renders the raw tiling: each slice carries the verbatim phase in
    // its accessible name.
    const strip = screen.getByLabelText("Activity phases timeline");
    const stripText = strip.textContent ?? "";
    const stripAria = Array.from(
      strip.querySelectorAll<HTMLElement>("[aria-label]"),
      (node) => node.getAttribute("aria-label") ?? ""
    ).join(" ");
    expect(`${stripText} ${stripAria}`.toLowerCase()).toContain("implement");

    // The breakdown attributes the SAME phases (titleized) rather than collapsing
    // to a single unclassified remainder — the panels now agree.
    expect(screen.getByText("Implement")).toBeInTheDocument();
    expect(screen.getByText("Review")).toBeInTheDocument();

    // It explains cost is unavailable; it never claims attribution is.
    expect(screen.getByText(COST_UNAVAILABLE_CAPTION)).toBeInTheDocument();
    expect(screen.queryByText(NO_ATTRIBUTION_FALLBACK)).not.toBeInTheDocument();
  });
});
