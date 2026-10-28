import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { buildDotCells } from "../session-timeline-dot-cells";
import { SessionTimelineHoverCards } from "../session-timeline-strip-parts";
import { SessionTrace } from "../session-trace";
import { createSessionTraceScenario } from "../session-trace-scenario-fixture";

/**
 * ISS-8651: the trace components must derive from ONE fixture, so a divergence
 * between them cannot ship silently.
 *
 * The proof is a MOVED INPUT, not the module's existence: a fixture nobody reads
 * is not a single source of truth, and a fixture only one component reads cannot
 * disagree with anything. Changing one field of the scenario has to move two
 * different components' rendering, and it does — the trace rows and the dot
 * rail's hover card both print the failing turn's summary because both are
 * derived from the same `failSummary`.
 *
 * EXPECTED VALUES ARE LITERALS. Nothing here re-derives an expectation by
 * calling back into the fixture or its helpers; that would assert the fixture
 * agrees with itself, which it does by construction. The duplication is the
 * test.
 */

const BUCKET_COUNT = 1;
const STAGE_ANCHOR = {
  bottom: 24,
  height: 8,
  left: 0,
  right: 8,
  top: 16,
  width: 8,
};

describe("session trace shared scenario (ISS-8651)", () => {
  it("renders the fixture's failing-turn summary in the trace rows", () => {
    renderTraceRows(createSessionTraceScenario());
    expect(screen.getByText("Ran 3 tools")).toBeInTheDocument();
  });

  it("renders the same fixture's failing-turn summary in the dot rail's hover card", () => {
    renderTroubleHoverCard(createSessionTraceScenario());
    expect(screen.getByText("Ran 3 tools")).toBeInTheDocument();
  });

  /*
   * The divergence guard. Both specs above would also pass against two
   * independent fixtures that happened to carry the same string today — which is
   * exactly the state ISS-8651 exists to end. Moving ONE field and requiring
   * BOTH renderings to follow is what proves they read the same source.
   */
  it("moves both components' rendering when one fixture field changes", () => {
    const changed = createSessionTraceScenario({ failSummary: "Ran 9 tools" });

    const rows = render(renderTraceRowsElement(changed));
    expect(screen.getByText("Ran 9 tools")).toBeInTheDocument();
    expect(screen.queryByText("Ran 3 tools")).toBeNull();
    rows.unmount();

    render(renderTroubleHoverCardElement(changed));
    expect(screen.getByText("Ran 9 tools")).toBeInTheDocument();
    expect(screen.queryByText("Ran 3 tools")).toBeNull();
  });
});

function renderTraceRows(
  scenario: ReturnType<typeof createSessionTraceScenario>
) {
  return render(renderTraceRowsElement(scenario));
}

function renderTraceRowsElement(
  scenario: ReturnType<typeof createSessionTraceScenario>
) {
  return <SessionTrace items={scenario.traceItems} />;
}

function renderTroubleHoverCard(
  scenario: ReturnType<typeof createSessionTraceScenario>
) {
  return render(renderTroubleHoverCardElement(scenario));
}

function renderTroubleHoverCardElement(
  scenario: ReturnType<typeof createSessionTraceScenario>
) {
  const cells = buildDotCells(
    scenario.markers,
    scenario.limitDotEvents,
    BUCKET_COUNT
  );
  return (
    <SessionTimelineHoverCards
      block={null}
      costsUnpublished={false}
      costUnmeasured={false}
      hoverBucket={null}
      hoverDot={{ anchor: STAGE_ANCHOR, bucketIndex: 0, color: "r" }}
      hoveredBucket={null}
      hoveredEvents={cells[0].r}
    />
  );
}
