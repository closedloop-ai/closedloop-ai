import { BranchCohortNoticeKind } from "../../lib/branch-cohort-transparency";
import type { BranchesListSummaryBandProps } from "../branches-list-summary-band";

type SummaryProps = Omit<BranchesListSummaryBandProps, "dateRange" | "layout">;

export function branchesListSurfaceV2SummaryPropsFixture(
  overrides: Partial<SummaryProps> = {}
): SummaryProps {
  return {
    cohortNotice: { kind: BranchCohortNoticeKind.Hidden, total: 0 },
    comparisonSuppressedByFilter: false,
    githubReturnStatus: null,
    onSummaryRetry: () => undefined,
    summaryAnalyticsErrored: false,
    summaryCards: undefined,
    summaryCardsErrored: false,
    summaryCardsPending: false,
    summaryCardsReloading: false,
    ...overrides,
  };
}
