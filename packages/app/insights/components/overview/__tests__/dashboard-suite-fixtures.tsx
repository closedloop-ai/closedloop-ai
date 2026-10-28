import { DASHBOARD_ROW_LABELS, DashboardRowTour } from "../dashboard-tiles";

/**
 * The query-state shapes, response fixtures and copy patterns the overview
 * dashboard's suites drive from.
 *
 * Extracted when ISS-10486's degradation cases pushed
 * `insights-overview-dashboard.test.tsx` past the 1,000-line ceiling and the
 * row-degradation group moved to its own sibling file. These are the pieces
 * both files need and neither owns; the `vi.hoisted` handles, the `vi.mock`
 * factories and the `renderDashboard` bound to them stay per-file, because
 * mock hoisting is per module graph and a shared copy would not be the mock
 * either file is actually driving.
 *
 * Not a `*.test.*` file, so the runner does not collect it as an empty suite.
 */
export const succeeded = (data: unknown) => ({
  // ISS-10414: settled AND answering for the key that was asked for.
  isPlaceholderData: false,
  isSuccess: true,
  isError: false,
  isLoading: false,
  isFetching: false,
  data,
});
// FEA-4020: settled-success but re-fetching over the already-present data (the
// range-change / manual-refresh case). `keepPreviousData` keeps `data` and
// `isSuccess`, so `isFetching` flips — and, on a range or scope CHANGE,
// `isPlaceholderData` with it (ISS-10414). The two are not the same fact: a
// same-key background refetch flips only the first, which is why the header
// indicator and the per-row disclosure read different flags.
export const refetching = (data: unknown) => ({
  isSuccess: true,
  isError: false,
  isLoading: false,
  isFetching: true,
  isPlaceholderData: true,
  data,
});
export const pending = () => ({
  isSuccess: false,
  isError: false,
  isLoading: true,
  isFetching: true,
  // No data at all — the row is LOADING, which is a different fact from stale.
  isPlaceholderData: false,
  data: undefined,
});
export const errored = () => ({
  // No data for this key at all — errored, never stale.
  isPlaceholderData: false,
  isSuccess: false,
  isError: true,
  isLoading: false,
  isFetching: false,
  data: undefined,
});

export const DEGRADED_RE = /dashboard metrics are temporarily unavailable/i;
/**
 * ISS-10486: the row-scoped degraded copy, distinct from the page-level one.
 * Held against the canonical row label so the two cannot drift; the sentence
 * around it is this suite's own, which is what makes it a check on the copy
 * rather than a restatement of it.
 */
export const ROW_DEGRADED_RE = new RegExp(
  `${DASHBOARD_ROW_LABELS[DashboardRowTour.Models]} is temporarily unavailable`,
  "i"
);
export const RETRY_RE = /retry/i;
/** The same control while its refetch is in flight. */
export const RETRYING_RE = /retrying/i;
/**
 * Anchored, because `RETRY_RE` is a substring match and "Retrying…" contains
 * "Retry" — a per-state assertion addressed by that pattern would count both.
 *
 * ISS-10486 review: each control's ACCESSIBLE name is now "Retry <the row it
 * recovers>", so these carry that trailing name instead of ending at the verb.
 * The old `/^retry$/` would match no control at all, which a `.length` check
 * reads as a clean zero rather than as a broken locator.
 */
export const RETRY_IDLE_RE = /^retry .+/i;
export const RETRY_BUSY_RE = /^retrying .+/i;
/** The accessible name of the control that recovers one named row. */
export const retryNameFor = (label: string) => `Retry ${label}`;
/** The same sentence for the autonomy row, which web is never served data for. */
export const AUTONOMY_DEGRADED_RE = new RegExp(
  `${DASHBOARD_ROW_LABELS[DashboardRowTour.Autonomy]} is temporarily unavailable`,
  "i"
);
/** The Recent Sessions card's own failure copy, inside an otherwise ready page. */
export const SESSIONS_ERROR_RE = /recent sessions are temporarily unavailable/i;
export const NO_SESSIONS_RE = /no agent sessions yet/i;
export const AI_IMPACT_RE = /ai impact/i;

export const emptySeries = { series: [], points: [] };
// Cloud Insights API today: no activityHeatmap, no autonomyTrend.
export const webUtilization = {
  kpis: [],
  charts: { eventActivity: emptySeries },
};
export const webAgents = {
  kpis: [],
  charts: { modelUsageOverTime: emptySeries, modelBreakdown: [] },
};
export const webDelivery = { kpis: [], charts: {} };
// An org that actually runs subagents: the Agents section resolves WITH a
// populated collaboration graph, which is what keeps the agent-pipeline row on
// the dashboard now that ISS-5280 retired its flag.
export const webAgentsWithPipeline = {
  ...webAgents,
  charts: {
    ...webAgents.charts,
    agentPipeline: {
      nodes: [{ id: "researcher", label: "researcher", value: 4 }],
      edges: [],
    },
  },
};

export function sessions(total: number) {
  return succeeded({
    total,
    items: Array.from({ length: Math.min(total, 1) }, (_, i) => ({
      id: `s${i}`,
    })),
  });
}

// FEA-4020: a settled sessions query that is re-fetching over its prior data.
export function refetchingSessions(total: number) {
  return {
    ...sessions(total),
    isFetching: true,
  };
}
