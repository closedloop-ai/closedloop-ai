import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import {
  type DateRange,
  getStartDateForRange,
} from "../../shared/lib/format-utils";
import type { AgentSessionQueryFilters } from "../data-source/agent-sessions-data-source";
import { SESSION_DATE_RANGE_PARAM } from "./session-date-range-param";
import {
  DEFAULT_SESSION_FACET_FILTERS,
  type SessionFacetFilters,
  writeSessionFacetFilterParams,
} from "./session-filter-adapter";

/**
 * ISS-5355 — the ONE predicate behind the project-detail "active sessions"
 * strip and the Sessions listing it links to.
 *
 * The strip's number and the row count of the listing you land on after
 * clicking it are the same question, so they are built from the same value
 * here rather than from two hand-written filter objects. {@link
 * buildProjectActiveSessionsFilters} produces the facet selection; the count
 * query and the destination URL are both PROJECTIONS of that one value —
 * `toQueryFilters` for the API read, {@link buildProjectActiveSessionsHref} for
 * the link — so neither can drift from the other without changing this module.
 *
 * "Active" is the canonical {@link SESSION_STATUS}`.ACTIVE` member, not a
 * second local notion of activity, and it is the same value the Sessions Status
 * facet offers. A user who clicks through therefore sees a Status chip reading
 * "Active" over exactly the rows the strip counted.
 *
 * The DATE WINDOW is part of the predicate too, and it is the SAME value on both
 * projections — {@link PROJECT_ACTIVE_SESSIONS_DATE_RANGE}. "Currently active"
 * is a now-state, not a period, so the strip counts every active session
 * regardless of when it started; the count is therefore deliberately unwindowed
 * rather than accidentally so. What used to make that a defect is that the
 * destination did NOT agree: the Sessions listing windows its rows on a
 * per-viewer saved range (`useSessionsViewState`, default 7d), so a viewer with
 * a narrower saved range clicked an unwindowed number and landed on fewer rows,
 * with nothing on screen explaining the difference. The href now writes the
 * window into `?range=` (`session-date-range-param.ts`) and the Sessions page
 * honours that param, so the link carries the same window the count used.
 *
 * "In this project" is the session→artifact link the session detail view
 * already renders as "linked artifacts" (ISS-5236) — narrowed by the
 * `projectIds` facet, whose server predicate is the single definition in
 * `apps/api/.../service/project-link-where.ts`. Deliberately NOT the session
 * artifact's own `projectId`: a synced SessionDetail artifact is created
 * unparented, so that column is null for essentially every session and a count
 * built on it would be a permanent zero. There is no second linkage path and no
 * inferred repository→project fallback.
 */
export const PROJECT_ACTIVE_SESSION_STATUSES = [SESSION_STATUS.ACTIVE] as const;

/**
 * The window the strip counts over, and the window its link hands the Sessions
 * listing. `"all"` because "currently active" is a now-state: a session left
 * ACTIVE by a harness the stale-session reaper has not yet swept is still an
 * active session, and hiding it behind a 7-day window would make the strip
 * report a number the project page cannot account for.
 */
export const PROJECT_ACTIVE_SESSIONS_DATE_RANGE: DateRange = "all";

/**
 * The facet selection describing "active sessions linked to this project".
 * Every consumer starts here.
 */
export function buildProjectActiveSessionsFilters(
  projectId: string
): SessionFacetFilters {
  return {
    ...DEFAULT_SESSION_FACET_FILTERS,
    statuses: [...PROJECT_ACTIVE_SESSION_STATUSES],
    projectIds: [projectId],
  };
}

/**
 * The facet selection as API query filters — what the strip's count read sends,
 * and what the Sessions page sends once it has parsed the link's URL back into
 * facets. `limit: 1` because the strip needs the envelope's `total`, not rows.
 */
export function buildProjectActiveSessionsQueryFilters(
  projectId: string
): AgentSessionQueryFilters {
  const facets = buildProjectActiveSessionsFilters(projectId);
  // Derived from the shared range rather than hardcoded, so the count's window
  // and the link's `?range=` cannot be changed independently. `"all"` resolves
  // to `undefined` (no lower bound), and the key is omitted rather than sent as
  // `undefined` so the request shape stays clean.
  const startDate = getStartDateForRange(PROJECT_ACTIVE_SESSIONS_DATE_RANGE);
  return {
    statuses: facets.statuses,
    projectIds: facets.projectIds,
    ...(startDate ? { startDate } : {}),
    limit: 1,
  };
}

/**
 * The same facet selection as a Sessions listing URL. Written with the canonical
 * facet param writer, so the destination page's own parser reproduces exactly
 * the filters {@link buildProjectActiveSessionsFilters} returned — the link and
 * the count cannot name different dimensions.
 */
export function buildProjectActiveSessionsHref(
  orgSlug: string,
  projectId: string
): string {
  const params = new URLSearchParams();
  writeSessionFacetFilterParams(
    params,
    buildProjectActiveSessionsFilters(projectId)
  );
  // The window the count used, so the destination cannot re-window the rows
  // under the reader with a saved range they never applied here.
  params.set(SESSION_DATE_RANGE_PARAM, PROJECT_ACTIVE_SESSIONS_DATE_RANGE);
  return `/${orgSlug}/sessions?${params.toString()}`;
}
