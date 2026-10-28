/**
 * ISS-10667 — closes a false-green suite for the Sessions surfaces: nine
 * production components grew a `useFeatureFlagEnabledOptional(
 * ONE_LABEL_PER_METRIC_FLAG_KEY)` read and none of them had a test that ever
 * rendered with the gate ON, so deleting any one of those reads left every
 * existing suite green.
 *
 * Every case below mounts the REAL production component (or hook) through the
 * REAL feature-flag port (`AppCoreStoryProviders`, backed by
 * `FeatureFlagAdapterProvider`) and asserts the RENDERED label — never a prop,
 * never a mock of the flag module. Each site STILL GATED is asserted on both
 * arms, so deleting the flag read fails the gate-ON case.
 *
 * ISS-10301 removed the v1 `SessionsToolbar` Options-menu cases with the toolbar
 * itself. They are not re-homed: the v2 surface's own menu rows read the STATIC
 * `SESSIONS_SUMMARY_CARD_LABELS`, so there is no gated label in a live menu for
 * them to describe.
 *
 * The COST sites are no longer gated: ISS-10636 retired the basis gate, so those
 * cases pin the label with the vocabulary gate OFF. Which label depends on the
 * SURFACE, and that is the point of asserting both here: the summary CARD (and
 * its loading shell) render ruling 7's alias since the operator ruling of
 * 2026-09-20, because the canonical phrase plus its info trigger does not fit
 * one line at the strip's card widths, while the table's Cost COLUMN HEADER
 * keeps the canonical phrase. The token and ratio sites are the two rows
 * `ONE_LABEL_PER_METRIC_FLAG_KEY` still moves, and keep both arms.
 */

import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { ONE_LABEL_PER_METRIC_FLAG_KEY } from "@repo/api/src/types/one-label-per-metric-flag";
import {
  TOTAL_ESTIMATED_COST_ALIAS_LABEL,
  TOTAL_ESTIMATED_COST_COPY,
} from "@repo/api/src/types/total-estimated-cost-copy";
import { TOTAL_TOKENS_LABEL } from "@repo/api/src/types/total-tokens-copy";
import {
  LOC_PER_DOLLAR_LABEL,
  MERGED_LOC_PER_DOLLAR_LABEL,
} from "@repo/api/src/utils/loc-per-dollar";
import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import { render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import { SESSIONS_COST_COLUMN_ID } from "../../../lib/sessions-table-columns";
import { SESSIONS_COLUMN_LABELS } from "../../../lib/sessions-total-estimated-cost-columns";
import { createAgentSessionDetailFixture } from "../../detail/agent-session-detail-fixtures";
import { SessionLocPerDollarProperty } from "../../detail/session-loc-per-dollar-property";
import { SessionsTable } from "../session-detail-table";
import { createAgentSessionUsageSummaryFixture } from "../session-list-fixtures";
import { TOTAL_TOKENS_METRIC_CARD_LABEL } from "../sessions-summary-card-labels";
import { SessionsSummaryCards } from "../sessions-summary-cards";
import { useSessionsListColumns } from "../use-sessions-list-columns";

/**
 * A cost split that reconciles but is deliberately UNSPLITTABLE (a negative
 * lane), so the gate-OFF arm settles on the SHIPPED presentation (lowercase
 * `cost`) rather than the unconditional Breakdown mode — the arm that actually
 * distinguishes the two label sets. Mirrors
 * `sessions-summary-cards-total-estimated-cost.test.tsx`'s own fixture.
 */
function costAndTokensUsageFixture(): AgentSessionUsageSummary {
  return createAgentSessionUsageSummaryFixture(
    AgentSessionViewerScope.Organization,
    {
      totalSessions: 12,
      totalEstimatedCost: 18_855,
      subscriptionEstimatedCost: -1,
      apiEstimatedCost: 16_825,
      meteredEstimatedCost: 42,
      unknownEstimatedCost: 16_783,
      totalInputTokens: 1000,
      totalOutputTokens: 500,
      totalCacheReadTokens: 200,
      totalCacheWriteTokens: 50,
    }
  );
}

function locPerDollarUsageFixture(): AgentSessionUsageSummary {
  return createAgentSessionUsageSummaryFixture(
    AgentSessionViewerScope.Organization,
    {
      totalSessions: 12,
      mergedPrCount: 7,
      mergedLocPerDollar: 3.5,
    }
  );
}

describe("SessionsSummaryCards -> AlwaysAvailableCards: Cost + Total Tokens labels (ISS-10667 / ISS-10636)", () => {
  it("Cost headlines the card alias with the vocabulary gate off", () => {
    render(
      <AppCoreStoryProviders>
        <SessionsSummaryCards
          authenticated
          isLoading={false}
          usage={costAndTokensUsageFixture()}
        />
      </AppCoreStoryProviders>
    );

    expect(
      screen.getByText(TOTAL_ESTIMATED_COST_ALIAS_LABEL)
    ).toBeInTheDocument();
  });

  it("gate on: Cost still headlines the card alias and Tokens reads sentence case", () => {
    render(
      <AppCoreStoryProviders enabledFlags={[ONE_LABEL_PER_METRIC_FLAG_KEY]}>
        <SessionsSummaryCards
          authenticated
          isLoading={false}
          usage={costAndTokensUsageFixture()}
        />
      </AppCoreStoryProviders>
    );

    expect(
      screen.getByText(TOTAL_ESTIMATED_COST_ALIAS_LABEL)
    ).toBeInTheDocument();
    expect(screen.getByText(TOTAL_TOKENS_LABEL)).toBeInTheDocument();
  });

  it("gate off: Tokens keeps title case", () => {
    render(
      <AppCoreStoryProviders>
        <SessionsSummaryCards
          authenticated
          isLoading={false}
          usage={costAndTokensUsageFixture()}
        />
      </AppCoreStoryProviders>
    );

    expect(
      screen.getByText(TOTAL_TOKENS_METRIC_CARD_LABEL)
    ).toBeInTheDocument();
    expect(screen.queryByText(TOTAL_TOKENS_LABEL)).not.toBeInTheDocument();
  });
});

describe("SessionsSummaryCards: LOC/$ card label (ISS-10667)", () => {
  it("gate on: reads the canonical merged phrase", () => {
    render(
      <AppCoreStoryProviders enabledFlags={[ONE_LABEL_PER_METRIC_FLAG_KEY]}>
        <SessionsSummaryCards
          authenticated
          isLoading={false}
          usage={locPerDollarUsageFixture()}
        />
      </AppCoreStoryProviders>
    );

    expect(screen.getByText(MERGED_LOC_PER_DOLLAR_LABEL)).toBeInTheDocument();
    expect(screen.queryByText(LOC_PER_DOLLAR_LABEL)).not.toBeInTheDocument();
  });

  it("gate off: keeps the shipped bare-unit label", () => {
    render(
      <AppCoreStoryProviders>
        <SessionsSummaryCards
          authenticated
          isLoading={false}
          usage={locPerDollarUsageFixture()}
        />
      </AppCoreStoryProviders>
    );

    expect(screen.getByText(LOC_PER_DOLLAR_LABEL)).toBeInTheDocument();
    expect(
      screen.queryByText(MERGED_LOC_PER_DOLLAR_LABEL)
    ).not.toBeInTheDocument();
  });
});

/**
 * `SessionsSummaryCardsLoading` reads `useSessionsSummaryCardLabels()` itself
 * for the Tokens/Cost cards; the LOC/$ label is resolved by its caller
 * (`SessionsSummaryCards`, from the same gate) and handed down as a prop. Both
 * halves are exercised by rendering the real parent in its loading state,
 * rather than hand-feeding the shell a label that would prove only that it
 * paints what it is given.
 */
describe("SessionsSummaryCardsLoading (via SessionsSummaryCards, isLoading): card labels (ISS-10667)", () => {
  it("gate on: spells every card the way the settled strip will, before data lands", () => {
    render(
      <AppCoreStoryProviders enabledFlags={[ONE_LABEL_PER_METRIC_FLAG_KEY]}>
        <SessionsSummaryCards authenticated isLoading usage={undefined} />
      </AppCoreStoryProviders>
    );

    expect(screen.getByText(MERGED_LOC_PER_DOLLAR_LABEL)).toBeInTheDocument();
    expect(screen.getByText(TOTAL_TOKENS_LABEL)).toBeInTheDocument();
    expect(
      screen.getByText(TOTAL_ESTIMATED_COST_ALIAS_LABEL)
    ).toBeInTheDocument();
  });

  it("gate off: keeps the shipped token and ratio labels, Cost on its alias", () => {
    render(
      <AppCoreStoryProviders>
        <SessionsSummaryCards authenticated isLoading usage={undefined} />
      </AppCoreStoryProviders>
    );

    expect(screen.getByText(LOC_PER_DOLLAR_LABEL)).toBeInTheDocument();
    expect(
      screen.getByText(TOTAL_TOKENS_METRIC_CARD_LABEL)
    ).toBeInTheDocument();
    expect(
      screen.getByText(TOTAL_ESTIMATED_COST_ALIAS_LABEL)
    ).toBeInTheDocument();
  });
});

function renderName(row: SessionTableRow, className: string) {
  return (
    <a className={className} href={`/sessions/${row.id}`}>
      {row.name}
    </a>
  );
}

describe("SessionsTable: Cost column header (ISS-10636)", () => {
  it("header reads the canonical dollar phrase with no flag enabled", () => {
    render(
      <AppCoreStoryProviders>
        <SessionsTable items={[]} mode="expanded" renderName={renderName} />
      </AppCoreStoryProviders>
    );

    expect(
      screen.getByText(TOTAL_ESTIMATED_COST_COPY.label)
    ).toBeInTheDocument();
    expect(
      screen.queryByText(SESSIONS_COLUMN_LABELS[SESSIONS_COST_COLUMN_ID])
    ).not.toBeInTheDocument();
  });
});

describe("SessionLocPerDollarProperty: session detail ratio row (ISS-10667)", () => {
  it("gate on: reads the canonical merged phrase", () => {
    render(
      <AppCoreStoryProviders enabledFlags={[ONE_LABEL_PER_METRIC_FLAG_KEY]}>
        <SessionLocPerDollarProperty
          session={createAgentSessionDetailFixture()}
        />
      </AppCoreStoryProviders>
    );

    expect(screen.getByText(MERGED_LOC_PER_DOLLAR_LABEL)).toBeInTheDocument();
  });

  it("gate off: keeps the shipped bare-unit label", () => {
    render(
      <AppCoreStoryProviders>
        <SessionLocPerDollarProperty
          session={createAgentSessionDetailFixture()}
        />
      </AppCoreStoryProviders>
    );

    expect(screen.getByText(LOC_PER_DOLLAR_LABEL)).toBeInTheDocument();
    expect(
      screen.queryByText(MERGED_LOC_PER_DOLLAR_LABEL)
    ).not.toBeInTheDocument();
  });
});

function columnsWrapper(enabledFlags: readonly string[]) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <AppCoreStoryProviders enabledFlags={enabledFlags}>
        {children}
      </AppCoreStoryProviders>
    );
  };
}

function renderCostColumnLabel(
  enabledFlags: readonly string[]
): string | undefined {
  const { result } = renderHook(
    () =>
      useSessionsListColumns({
        customFieldColumns: [],
        favoritesEnabled: false,
        isServerDriven: false,
        seamRenderers: new Map(),
        showAddField: false,
        visibleColumnIds: new Set([SESSIONS_COST_COLUMN_ID]),
      }),
    { wrapper: columnsWrapper(enabledFlags) }
  );
  return result.current.columns.find(
    (column) => column.id === SESSIONS_COST_COLUMN_ID
  )?.label;
}

describe("useSessionsListColumns: Cost column label (ISS-10636)", () => {
  it("resolves the canonical dollar phrase with no flag enabled", () => {
    expect(renderCostColumnLabel([])).toBe(TOTAL_ESTIMATED_COST_COPY.label);
  });
});
