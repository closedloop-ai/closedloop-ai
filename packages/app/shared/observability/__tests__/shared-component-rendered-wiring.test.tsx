/**
 * ISS-8752 — production wiring for the MLP `shared_component_rendered` set.
 *
 * The port test beside this one proves the hook; these prove the three tracked
 * components actually CALL it, so deleting an emit site (or renaming a
 * component out of the tracked set) goes red here instead of silently ending
 * that component's adoption measurement. Loading-state mounts keep the
 * fixtures minimal — the emit is a mount effect, deliberately independent of
 * data arrival.
 */
import { BranchesListRolloutDecisionReason } from "@repo/api/src/types/branches-list-rollout";
import {
  GridviewRolloutDecisionOutcome,
  SharedAnalyticsComponent,
  type SharedAnalyticsComponent as SharedAnalyticsComponentType,
  Surface,
  SurfaceAnalyticsEvent,
} from "@repo/api/src/types/surface-analytics";
import { tooltipMockModule } from "@repo/app/test/mocks/tooltip";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionDetailView } from "../../../agents/components/detail/agent-session-detail-view";
import { SessionsListSurfaceV2 } from "../../../agents/components/sessions/sessions-list-surface-v2";
import { BranchDetailPage } from "../../../branches/components/branch-detail-page";
import { BranchesListSurfaceV2 } from "../../../branches/components/branches-list-surface-v2";
import { BranchCohortNoticeKind } from "../../../branches/lib/branch-cohort-transparency";
import { DEFAULT_BRANCH_FILTERS } from "../../../branches/lib/branch-row";
import { FeatureFlagAdapterProvider } from "../../feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "../../feature-flags/static-feature-flag-adapter";
import { SurfaceAnalyticsProvider } from "../surface-analytics-context";

vi.mock("@repo/design-system/components/ui/tooltip", () => tooltipMockModule);

const capture = vi.fn();
const CONNECTED_BRANCHES_STALL_CTA = {
  signals: {
    hasAccount: true,
    isGitHubConnected: true,
  },
} as const;

function mountTracked(
  children: React.ReactNode,
  enabledFlags: readonly string[] = []
) {
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({ enabledFlags })}
    >
      <SurfaceAnalyticsProvider capture={capture} surface={Surface.Web}>
        {children}
      </SurfaceAnalyticsProvider>
    </FeatureFlagAdapterProvider>
  );
}

function renderedEventFor(component: SharedAnalyticsComponentType) {
  return [
    SurfaceAnalyticsEvent.SharedComponentRendered,
    { component, surface: Surface.Web },
  ] as const;
}

describe("shared_component_rendered production wiring", () => {
  beforeEach(() => {
    capture.mockClear();
  });

  it("SessionsListSurfaceV2 emits on mount", () => {
    mountTracked(<SessionsListSurfaceV2 rows={[]} usage={undefined} />);
    expect(capture).toHaveBeenCalledWith(
      ...renderedEventFor(SharedAnalyticsComponent.SessionsListSurfaceV2)
    );
  });

  it("BranchesListSurfaceV2 emits on mount", () => {
    mountTracked(
      <BranchesListSurfaceV2
        allRows={[]}
        cohortNotice={{ kind: BranchCohortNoticeKind.Hidden, total: 0 }}
        comparisonSuppressedByFilter={false}
        hasActiveFilters={false}
        hasWindow={false}
        isError={false}
        isPending={false}
        isPlaceholderData={false}
        items={[]}
        onPageChange={vi.fn()}
        onPageSizeChange={vi.fn()}
        onRetry={vi.fn()}
        onShowAllTime={vi.fn()}
        onSort={vi.fn()}
        onSummaryRetry={vi.fn()}
        page={0}
        pageSize={25}
        sortBy="lastActivity"
        sortDir="desc"
        stallCta={CONNECTED_BRANCHES_STALL_CTA}
        summaryAnalyticsErrored={false}
        summaryCards={undefined}
        summaryCardsErrored={false}
        summaryCardsPending={false}
        summaryCardsReloading={false}
        toolbar={{
          dateRange: "7d",
          filters: DEFAULT_BRANCH_FILTERS,
          onDateRangeChange: vi.fn(),
          onFiltersChange: vi.fn(),
          onToggleColumn: vi.fn(),
          rows: [],
          visibleColumns: new Set(),
        }}
        total={0}
        totalPages={0}
        visibleColumns={new Set()}
      />
    );
    expect(capture).toHaveBeenCalledWith(
      ...renderedEventFor(SharedAnalyticsComponent.BranchesListSurfaceV2)
    );
    expect(capture).toHaveBeenCalledWith(
      SurfaceAnalyticsEvent.GridviewRolloutDecision,
      {
        component: SharedAnalyticsComponent.BranchesListSurfaceV2,
        hydrated_row_count: 0,
        outcome: GridviewRolloutDecisionOutcome.Enabled,
        reason: BranchesListRolloutDecisionReason.HydrationComplete,
        row_count: 0,
        surface: Surface.Web,
      }
    );
  });

  it("BranchesListSurfaceV2 reports parity from live state", () => {
    mountTracked(
      <BranchesListSurfaceV2
        allRows={[]}
        cohortNotice={{ kind: BranchCohortNoticeKind.Hidden, total: 2 }}
        comparisonSuppressedByFilter={false}
        hasActiveFilters={false}
        hasCompletePopulation
        hasWindow={false}
        isError
        isPending={false}
        isPlaceholderData={false}
        items={[]}
        onPageChange={vi.fn()}
        onPageSizeChange={vi.fn()}
        onRetry={vi.fn()}
        onShowAllTime={vi.fn()}
        onSort={vi.fn()}
        onSummaryRetry={vi.fn()}
        page={0}
        pageSize={25}
        sortBy="lastActivity"
        sortDir="desc"
        stallCta={CONNECTED_BRANCHES_STALL_CTA}
        summaryAnalyticsErrored={false}
        summaryCards={undefined}
        summaryCardsErrored={false}
        summaryCardsPending={false}
        summaryCardsReloading={false}
        toolbar={{
          dateRange: "7d",
          filters: DEFAULT_BRANCH_FILTERS,
          onDateRangeChange: vi.fn(),
          onFiltersChange: vi.fn(),
          onToggleColumn: vi.fn(),
          rows: [],
          visibleColumns: new Set(),
        }}
        total={2}
        totalPages={1}
        visibleColumns={new Set()}
      />
    );

    expect(capture).toHaveBeenCalledWith(
      SurfaceAnalyticsEvent.GridviewRolloutDecision,
      expect.objectContaining({
        outcome: GridviewRolloutDecisionOutcome.Disabled,
        reason: BranchesListRolloutDecisionReason.ParityMismatch,
      })
    );
  });

  it("AgentSessionDetailView emits on mount", () => {
    mountTracked(<AgentSessionDetailView backHref="/sessions" isLoading />);
    expect(capture).toHaveBeenCalledWith(
      ...renderedEventFor(SharedAnalyticsComponent.AgentSessionDetailView)
    );
  });

  it("BranchDetailPage emits on mount", () => {
    mountTracked(
      <BranchDetailPage
        backHref="/branches"
        branchId="branch-1"
        isError={false}
        isLoading
      />
    );
    expect(capture).toHaveBeenCalledWith(
      ...renderedEventFor(SharedAnalyticsComponent.BranchDetailPage)
    );
  });
});
