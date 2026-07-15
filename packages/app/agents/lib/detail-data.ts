/**
 * Agents workspace — component detail reshape helpers (T-1.3).
 *
 * Ports the detail-data reshape helpers from the prototype
 * (`apps/prototypes/app/p/agents/detail-data.ts`) DECOUPLED from direct mock
 * imports. All functions accept their inputs as typed parameters; callers
 * supply data from the `AgentComponentsDataSource` seam rather than the
 * prototype's inline mock.
 *
 * This file has NO imports from `apps/prototypes/` or mock data modules.
 *
 * @see packages/app/agents/lib/session-table-row.ts for the shared
 *   AgentSessionListItem → SessionTableRow mapper used by sessionsFor().
 */

import type {
  AgentComponent,
  AgentComponentDetail,
} from "@repo/api/src/types/agent-component.js";
import type { AgentSessionListItem } from "@repo/api/src/types/agent-session.js";
import type { SessionTableRow } from "@repo/app/agents/components/sessions/sessions-table";
import {
  agentSessionToSessionTableRow,
  resolveSessionRepoLabel,
} from "@repo/app/agents/lib/session-table-row";

// ---------------------------------------------------------------------------
// Formatting helper (mirrors NUMBER_FORMAT from component-meta.tsx — defined
// here independently so this file has no dependency on T-1.2 until it lands).
// ---------------------------------------------------------------------------

const NUMBER_FORMAT = new Intl.NumberFormat("en-US");

const METRIC_DASH = "—";

// ---------------------------------------------------------------------------
// ComponentMetric — the display-ready cards rendered above the Sessions /
// Branches tabs on the detail page.
// ---------------------------------------------------------------------------

export type ComponentMetric = {
  key: string;
  label: string;
  value: string;
  info?: { what: string; how?: string };
};

/**
 * Build the per-kind metric cards for the component detail page.
 *
 * Accepts a full `AgentComponentDetail` so it can derive PR / cost / lines
 * metrics from `detail.branchesTab` (pre-fetched branch rows). In Phase 1
 * the stub source returns `[]` for `branchesTab`, yielding `0` for those
 * aggregate fields — the same safe fallback the prototype used when a
 * component had no associated branches.
 *
 * Returns `readonly ComponentMetric[]` matching the card variant used by
 * `agent-detail.tsx`'s metrics grid.
 */
export const componentMetrics = (
  detail: AgentComponentDetail
): readonly ComponentMetric[] => {
  const branches = detail.branchesTab;
  const merged = branches.filter(
    (branch) => branch.prState === "MERGED"
  ).length;
  const linesShipped = branches.reduce(
    (sum, branch) => sum + (branch.additions ?? 0),
    0
  );
  const totalCost = branches.reduce(
    (sum, branch) => sum + (branch.estimatedCostUsd ?? 0),
    0
  );
  const avgPerSession =
    detail.invocations != null && detail.sessions != null && detail.sessions > 0
      ? Math.round(detail.invocations / detail.sessions)
      : null;

  const numOrDash = (value: number | null): string =>
    value === null ? METRIC_DASH : NUMBER_FORMAT.format(value);

  const klocCard: ComponentMetric = {
    key: "kloc",
    label: "KLOC / $",
    value:
      detail.klocPerDollar === null
        ? METRIC_DASH
        : detail.klocPerDollar.toFixed(1),
    info: {
      what: "Merged KLOC per dollar across sessions that used it.",
      how: "Directional — a session-level metric, not caused by one component.",
    },
  };
  const invocationsCard: ComponentMetric = {
    key: "invocations",
    label: "Invocations",
    value: numOrDash(detail.invocations),
    info: { what: "Total calls attributed to this component in range." },
  };
  const sessionsCard: ComponentMetric = {
    key: "sessions",
    label: "Sessions",
    value: numOrDash(detail.sessions),
  };
  const mergedCard: ComponentMetric = {
    key: "merged",
    label: "Merged PRs",
    value: String(merged),
  };

  if (detail.kind === "subagent") {
    return [
      klocCard,
      invocationsCard,
      sessionsCard,
      mergedCard,
      {
        key: "lines",
        label: "Lines shipped",
        value: numOrDash(linesShipped),
      },
      { key: "cost", label: "Total cost", value: `$${totalCost.toFixed(2)}` },
    ];
  }

  return [
    klocCard,
    invocationsCard,
    sessionsCard,
    mergedCard,
    {
      key: "avg",
      label: "Avg / session",
      value: avgPerSession === null ? METRIC_DASH : String(avgPerSession),
    },
  ];
};

// ---------------------------------------------------------------------------
// detailFor — look up a component detail record from the caller-supplied
// array. In production the array is fetched from the data source; in the
// stub source it is the pre-built mock catalogue. Returns `undefined` when
// no matching id is found so callers can surface a 404.
// ---------------------------------------------------------------------------

/**
 * Find a component detail record by its stable `id` from a caller-supplied
 * list. Decoupled from any mock catalogue — the caller (hook or component)
 * supplies the records from the `AgentComponentsDataSource`.
 *
 * Returns `undefined` when the id is not found; callers should treat this
 * the same as a 404 from the data source.
 */
export const detailFor = (
  id: string,
  components: readonly AgentComponentDetail[]
): AgentComponentDetail | undefined =>
  components.find((component) => component.id === id);

// ---------------------------------------------------------------------------
// sessionsFor — map AgentSessionListItem rows to the presentational
// SessionTableRow shape accepted by sessions-table.tsx.
// ---------------------------------------------------------------------------

/**
 * Map a list of `AgentSessionListItem` records (from `detail.sessionsTab`)
 * to the `SessionTableRow[]` shape consumed by the shared `SessionsTable`
 * component.
 *
 * Accepts `component` for future filtering/sorting extensions but does not
 * use it for the mapping itself — the prototype's filtering logic (pack-mate
 * priority, SESSIONS_SHOWN cap) is not ported here because Phase-1 tab data
 * comes pre-fetched from the data source with server-side scoping.
 *
 * Returns `SessionTableRow[]` matching the type in
 * `packages/app/agents/components/sessions/sessions-table.tsx`.
 */
export const sessionsFor = (
  _component: AgentComponent,
  sessions: readonly AgentSessionListItem[]
): SessionTableRow[] =>
  sessions.map((session) =>
    agentSessionToSessionTableRow(session, resolveSessionRepoLabel(session))
  );
