// Summary KPI cards (mirrors SessionsSummaryCards) — derived from the CURRENT
// filtered row set so the aggregate always reconciles with the visible list
// (review: 148 sessions over a list of 8 that doesn't move on filter erodes
// trust). Production's card copy is "matched by the current filters", so the
// detail lines say the same and mean it.
//
import { type DateRange, PrState, type SessionRow } from "./mock";

export type SummaryKpi = {
  key: string;
  label: string;
  value: string;
  detail: string;
  info: { what: string; how: string };
  /** Signed period-over-period percent; omitted when there is no comparison. */
  delta?: number;
  /** Comparison caption beside the delta chip (e.g. "vs prior 30 days"). */
  deltaLabel?: string;
};

export function computeSummaryKpis(
  rows: readonly SessionRow[],
  _dateRange: DateRange,
  _filtersActive: boolean
): SummaryKpi[] {
  const totalCost = rows.reduce((sum, row) => sum + row.cost, 0);
  const totalTokens = rows.reduce(
    (sum, row) => sum + row.inputTokens + row.outputTokens,
    0
  );
  const apiEquivalentCost = rows.reduce(
    (sum, row) => sum + row.apiEquivalentCost,
    0
  );
  const apiCostUplift = Math.max(0, apiEquivalentCost - totalCost);
  const merged = rows.filter((row) => row.prState === PrState.Merged);
  const mergedLoc = merged
    .filter((row) => row.additions != null && row.deletions != null)
    .map((row) => (row.additions ?? 0) + (row.deletions ?? 0));
  const mergedCost = merged.reduce((sum, row) => sum + row.cost, 0);
  const totalMergedLoc = mergedLoc.reduce((sum, loc) => sum + loc, 0);
  const mergedLocPerDollar =
    mergedCost > 0 ? Math.round(totalMergedLoc / mergedCost) : null;

  return [
    {
      key: "sessions",
      label: "Sessions",
      value: String(rows.length),
      detail: "matched by the current filters",
      info: {
        what: "Agent sessions matching the current time window and filters.",
        how: "Counted from the filtered rows on screen.",
      },
    },
    {
      key: "tokens",
      label: "Total tokens",
      value: formatCompactCount(totalTokens),
      detail: "input + output",
      info: {
        what: "Total model tokens consumed by the matched sessions.",
        how: "Input and output tokens summed across the current range and filters.",
      },
    },
    {
      key: "cost",
      label: "Cost",
      value: formatCurrency(totalCost),
      detail: `+${formatCurrency(apiCostUplift)} if billed to API`,
      info: {
        what: "Estimated cost across the matched sessions.",
        how: "Session cost is summed for the selected range; the caption estimates the additional usage-based API cost.",
      },
    },
    {
      key: "prs",
      label: "PRs shipped",
      value: String(merged.length),
      detail: "merged in range",
      info: {
        what: "Pull requests shipped by the matched sessions.",
        how: "Counted where a matched session's pull request is merged.",
      },
    },
    {
      key: "efficiency",
      label: "LOC (merged) / $",
      value: mergedLocPerDollar == null ? "—" : String(mergedLocPerDollar),
      detail:
        mergedLocPerDollar == null
          ? "no merged PRs in range"
          : "merged LOC per dollar",
      info: {
        what: "Merged lines of code per dollar of session cost.",
        how: "Additions and deletions from merged pull requests divided by matched merged-session cost.",
      },
    },
  ];
}

function formatCompactCount(value: number): string {
  return new Intl.NumberFormat("en-US", {
    compactDisplay: "short",
    maximumFractionDigits: 2,
    notation: "compact",
  }).format(value);
}

function formatCurrency(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}
