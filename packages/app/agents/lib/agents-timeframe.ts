import { AGENT_COMPONENT_INVENTORY_CAP } from "@repo/api/src/types/agent-component";
import { getStartIsoForDays } from "../../shared/lib/format-utils";

/**
 * Agents workspace time-window + fetch-limit helpers.
 *
 * The Agents workspace fetches the whole org inventory in one request and does
 * all filtering / grouping / pagination / summary math client-side (see
 * `agents-grouped-list.tsx`). These helpers back the always-visible time-window
 * segmented control (All / 30 / 60 / 90 day) on that surface.
 *
 * NOTE: this is deliberately NOT the shared `DateRange` (7d/30d/90d/all) used by
 * the Sessions/Branches toolbars — the Agents workspace uses a 30/60/90/All set,
 * so it gets its own tiny enum here rather than widening the shared one and
 * changing every other surface's selector.
 */

/**
 * Max rows the Agents workspace requests in a single list call. The shared
 * `AGENT_COMPONENT_INVENTORY_CAP` — the same value the service-side
 * `MAX_ORG_INVENTORY_ROWS` DB read cap and the desktop local clamp use — so this
 * pulls the entire bounded inventory the server will ever return in one page and
 * the client then paginates locally.
 */
export const AGENT_INVENTORY_FETCH_LIMIT = AGENT_COMPONENT_INVENTORY_CAP;

/** How many inventory rows render per client-side page. */
export const AGENTS_PAGE_SIZE = 50;

/**
 * The Agents workspace time-window options. Defined as a const object (never a
 * bare `as const` string array) per the repo AGENTS.md convention, matching the
 * `{...} as const` + `(typeof X)[keyof typeof X]` idiom used across the repo
 * (e.g. `AgentComponentKind`). The render order is derived from its values.
 */
export const AgentsTimeRange = {
  All: "all",
  Last30Days: "30d",
  Last60Days: "60d",
  Last90Days: "90d",
} as const;
export type AgentsTimeRange =
  (typeof AgentsTimeRange)[keyof typeof AgentsTimeRange];

/** Segmented-control render order, derived from the const object's values. */
export const AGENTS_TIME_RANGES: readonly AgentsTimeRange[] =
  Object.values(AgentsTimeRange);

export const AGENTS_TIME_RANGE_DEFAULT: AgentsTimeRange = AgentsTimeRange.All;

/** Short labels for the segmented control ("All", "30", "60", "90"). */
export const AGENTS_TIME_RANGE_SHORT_LABELS: Record<AgentsTimeRange, string> = {
  [AgentsTimeRange.All]: "All",
  [AgentsTimeRange.Last30Days]: "30",
  [AgentsTimeRange.Last60Days]: "60",
  [AgentsTimeRange.Last90Days]: "90",
};

/** Accessible labels for the segmented control. */
export const AGENTS_TIME_RANGE_LABELS: Record<AgentsTimeRange, string> = {
  [AgentsTimeRange.All]: "All time",
  [AgentsTimeRange.Last30Days]: "Last 30 days",
  [AgentsTimeRange.Last60Days]: "Last 60 days",
  [AgentsTimeRange.Last90Days]: "Last 90 days",
};

const AGENTS_TIME_RANGE_DAYS: Record<
  Exclude<AgentsTimeRange, typeof AgentsTimeRange.All>,
  number
> = {
  [AgentsTimeRange.Last30Days]: 30,
  [AgentsTimeRange.Last60Days]: 60,
  [AgentsTimeRange.Last90Days]: 90,
};

/**
 * The inclusive lower bound (ISO timestamp) for a window, or `undefined` for
 * "all" (no lower bound). `now` is injectable for deterministic tests.
 */
export function getAgentsRangeStartIso(
  range: AgentsTimeRange,
  now: Date = new Date()
): string | undefined {
  return getStartIsoForDays(
    range === AgentsTimeRange.All ? undefined : AGENTS_TIME_RANGE_DAYS[range],
    now
  );
}

/**
 * FEA-3178: the PRECEDING equivalent window for a range — the same-duration
 * window immediately before the current one. The current window is
 * `[now - Nd, now]`; the preceding window is `[now - 2Nd, now - Nd]`, i.e. it
 * ends exactly where the current window begins (`prevEnd === currentStart`) and
 * has identical duration. Both bounds are on the SAME `lastInvokedAt` usage
 * basis the server windows on (`startDate`/`endDate`).
 *
 * Returns `undefined` for the "All" range: an unbounded window has no
 * finite duration, so there is no meaningful "previous period" to compare
 * against — the summary cards render no delta in that case. `now` is injectable
 * for deterministic tests.
 */
export function getAgentsPrecedingRangeIso(
  range: AgentsTimeRange,
  now: Date = new Date()
): { prevStart: string; prevEnd: string } | undefined {
  if (range === AgentsTimeRange.All) {
    return undefined;
  }
  const days = AGENTS_TIME_RANGE_DAYS[range];
  const prevEnd = new Date(now);
  prevEnd.setDate(prevEnd.getDate() - days);
  const prevStart = new Date(now);
  prevStart.setDate(prevStart.getDate() - days * 2);
  return {
    prevStart: prevStart.toISOString(),
    prevEnd: prevEnd.toISOString(),
  };
}
