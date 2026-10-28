import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { TOTAL_ESTIMATED_COST_ALIAS_LABEL } from "@repo/api/src/types/total-estimated-cost-copy";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { tooltipMockModule } from "@repo/app/test/mocks/tooltip";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAgentSessionUsageSummaryFixture,
  createSessionTableRowFixture,
} from "../session-list-fixtures";
import { SessionsListSurfaceV2 } from "../sessions-list-surface-v2";

vi.mock("@repo/design-system/components/ui/tooltip", () => tooltipMockModule);

/**
 * ISS-7355 — the v2 surface used to hand `SessionsSummaryCards` only
 * `cardClassName`/`isLoading`/`usage`, so mounting it in place of the production
 * Sessions list silently dropped five shipped behaviours of the summary strip.
 *
 * These cases assert through the SURFACE, not the cards: `SessionsSummaryCards`
 * already has its own ISS-4481 coverage, and that suite stayed green through the
 * entire period the surface was dropping the prop. What was never pinned is the
 * FORWARDING — so each case here fails if `{...summaryCards}` leaves the
 * surface's render, which is the regression that actually shipped.
 */

const ALL_UNKNOWN_COST_USAGE = createAgentSessionUsageSummaryFixture(
  AgentSessionViewerScope.Organization,
  {
    totalEstimatedCost: 0,
    apiEstimatedCost: 0,
    subscriptionEstimatedCost: 70,
  }
);

const ROWS = [createSessionTableRowFixture()];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SessionsListSurfaceV2 summary-row parity (ISS-7355)", () => {
  it("forwards costUnknownActive, so an all-unknown cohort is never summed to a fabricated $0", () => {
    stubContainerWidthPx(1440);
    // The host's Cost facet is Unknown: every row renders "—", so the
    // facet-scoped cost sums to a finite 0 that means "not computed", not "free".
    render(
      <SessionsListSurfaceV2
        isLoading={false}
        rows={ROWS}
        summaryCards={{ costUnknownActive: true }}
        usage={ALL_UNKNOWN_COST_USAGE}
      />
    );

    expect(
      screen.getByText(TOTAL_ESTIMATED_COST_ALIAS_LABEL)
    ).toBeInTheDocument();
    // The whole point: no fabricated zero beside a column of dashes.
    expect(screen.queryByText("$0")).toBeNull();
    expect(screen.queryByText("$0.00")).toBeNull();
  });

  it("still renders metered spend when costUnknownActive is not set", () => {
    stubContainerWidthPx(1440);
    // The opposite branch, so the case above cannot pass merely because the Cost
    // tile never renders a figure through this surface at all.
    render(
      <SessionsListSurfaceV2
        isLoading={false}
        rows={ROWS}
        usage={createAgentSessionUsageSummaryFixture(
          AgentSessionViewerScope.Organization,
          {
            totalEstimatedCost: 30,
            apiEstimatedCost: 30,
            subscriptionEstimatedCost: 0,
          }
        )}
      />
    );

    expect(screen.getByText("$30")).toBeInTheDocument();
  });

  it("forwards the summary read's own isError independently of the row read", () => {
    stubContainerWidthPx(1440);
    // `isError` on the SURFACE is the ROW read — it feeds the empty state's
    // Unavailable reason. The summary query is a different query, and before
    // ISS-7355 a failed one left the cards rendering as if they were fine.
    //
    // The usage carries a real $30 so the assertion has something to suppress:
    // the tile must drop to its errored state rather than reporting spend from a
    // read that failed. Without the forwarding, $30 renders and this goes red.
    render(
      <SessionsListSurfaceV2
        isError={false}
        isLoading={false}
        rows={ROWS}
        summaryCards={{ isError: true }}
        usage={createAgentSessionUsageSummaryFixture(
          AgentSessionViewerScope.Organization,
          {
            totalEstimatedCost: 30,
            apiEstimatedCost: 30,
            subscriptionEstimatedCost: 0,
          }
        )}
      />
    );

    expect(screen.queryByText("$30")).toBeNull();
  });
});
