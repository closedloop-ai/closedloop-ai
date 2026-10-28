import {
  setAppSpanAttributes,
  withAppSpan,
} from "@repo/observability/tracing/spans";

/** Return the non-date cohort when a metric request carries a date boundary. */
export function resolveCanonicalMetricCohort<Row, Query extends object>(
  query: Query & { startDate?: unknown; endDate?: unknown },
  windowedRows: Row[],
  loadNonDateCohort: (query: Query) => Promise<Row[]>
): Promise<Row[]> {
  return withAppSpan("branches.analytics.canonical_cohort.resolve", () => {
    if (!(query.startDate || query.endDate)) {
      setAppSpanAttributes({
        "branches.analytics.canonical_cohort.date_bounded": false,
        "branches.analytics.canonical_cohort.windowed_row_count":
          windowedRows.length,
        "branches.analytics.canonical_cohort.reloaded": false,
      });
      return Promise.resolve(windowedRows);
    }
    setAppSpanAttributes({
      "branches.analytics.canonical_cohort.date_bounded": true,
      "branches.analytics.canonical_cohort.windowed_row_count":
        windowedRows.length,
      "branches.analytics.canonical_cohort.reloaded": true,
    });
    return loadNonDateCohort({
      ...query,
      startDate: undefined,
      endDate: undefined,
    });
  });
}

/** Preserve selected-PR LOC as the canonical gross-LOC numerator. */
export function selectedPullRequestLoc(
  pullRequest:
    | { additions: number | null; deletions: number | null }
    | null
    | undefined
): { additions: number | null; deletions: number | null } | null {
  if (!pullRequest) {
    return null;
  }
  return {
    additions: pullRequest.additions,
    deletions: pullRequest.deletions,
  };
}
