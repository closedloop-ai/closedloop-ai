/**
 * ISS-11117 — the Sessions listing card renders `Pts / $` from the Pensero
 * numerator, and renders LOC/$ unchanged when there is none.
 *
 * Drives the PRODUCTION composite both shells mount — `apps/app`'s Sessions
 * page and the desktop `SessionsView` both render `SessionsSummaryCards`
 * through `renderSummaryMetricBand` — so grading it here grades what web and
 * desktop actually paint.
 */

import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createAgentSessionUsageSummaryFixture } from "../session-list-fixtures";
import { SessionsSummaryCards } from "../sessions-summary-cards";

/**
 * Spelled out rather than imported from the modules under test: an expectation
 * rebuilt from the same helper the code reads passes for whatever that helper
 * returns, wrong values included.
 */
const LOC_CARD_LABEL = "LOC / $";
const POINTS_CARD_LABEL = "Pts / $";

describe("ISS-11117 Sessions listing Pts / $", () => {
  it("renders the points figure UNDER the points label", () => {
    renderRow(
      usageFixture({
        // A points ratio deliberately DIFFERENT from the LOC one, so the DOM
        // says which numerator the card selected rather than leaving two equal
        // numbers to agree by accident.
        penseroPointsPerDollar: 12.34,
      })
    );

    const card = cardLabelled(POINTS_CARD_LABEL);
    // The PAIR: label and figure together, because drift between them is the
    // failure the one-resolver rule exists to prevent.
    expect(card.textContent).toContain("12.3");
    expect(card.textContent).toContain("across sessions in range");
    expect(screen.queryByText(LOC_CARD_LABEL)).toBeNull();
  });

  it("renders the LOC ratio with its LOC label when no numerator is sent", () => {
    // AC2, positively: the number the reader can already see stays, under the
    // word it has always carried.
    renderRow(usageFixture());

    const card = cardLabelled(LOC_CARD_LABEL);
    expect(card.textContent).toContain("3.5");
    expect(screen.queryByText(POINTS_CARD_LABEL)).toBeNull();
  });

  it("publishes a MEASURED zero as 0 Pts / $, never as the LOC ratio", () => {
    renderRow(usageFixture({ penseroPointsPerDollar: 0 }));

    const card = cardLabelled(POINTS_CARD_LABEL);
    expect(card.textContent).toContain("0");
    expect(card.textContent).not.toContain("3.5");
  });
});

function usageFixture(
  overrides: Partial<AgentSessionUsageSummary> = {}
): AgentSessionUsageSummary {
  return createAgentSessionUsageSummaryFixture(
    AgentSessionViewerScope.Organization,
    {
      totalSessions: 12,
      totalEstimatedCost: 42,
      apiEstimatedCost: 42,
      mergedPrCount: 7,
      mergedLocPerDollar: 3.5,
      ...overrides,
    }
  );
}

function renderRow(usage: AgentSessionUsageSummary) {
  return render(
    <SessionsSummaryCards authenticated isLoading={false} usage={usage} />
  );
}

function cardLabelled(label: string): HTMLElement {
  const card = screen.getByText(label).closest('[data-slot="card"]');
  if (!(card instanceof HTMLElement)) {
    throw new Error(`card labelled ${label} is missing`);
  }
  return card;
}
