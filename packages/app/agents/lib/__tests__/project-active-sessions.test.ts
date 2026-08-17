import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { describe, expect, it } from "vitest";
import { getStartDateForRange } from "../../../shared/lib/format-utils";
import {
  buildProjectActiveSessionsFilters,
  buildProjectActiveSessionsHref,
  buildProjectActiveSessionsQueryFilters,
  PROJECT_ACTIVE_SESSION_STATUSES,
  PROJECT_ACTIVE_SESSIONS_DATE_RANGE,
} from "../project-active-sessions";
import {
  parseSessionDateRangeParam,
  SESSION_DATE_RANGE_PARAM,
} from "../session-date-range-param";
import {
  DEFAULT_SESSION_FACET_FILTERS,
  parseSessionFacetFilterParams,
  SESSION_FACET_FILTER_PARAMS,
} from "../session-filter-adapter";

const PROJECT_ID = "019f8008-1969-74f9-b056-99c13cca9a07";
const ORG_SLUG = "closedloop-ai";

/** The query string of a Sessions href, parsed the way the page parses it. */
function parseHrefFacets(href: string) {
  const [, query = ""] = href.split("?");
  return parseSessionFacetFilterParams(new URLSearchParams(query));
}

describe("project active sessions shared predicate", () => {
  it("defines active against the canonical session-status const object", () => {
    expect(PROJECT_ACTIVE_SESSION_STATUSES).toEqual([SESSION_STATUS.ACTIVE]);
  });

  it("selects only the active status and this one project", () => {
    expect(buildProjectActiveSessionsFilters(PROJECT_ID)).toEqual({
      ...DEFAULT_SESSION_FACET_FILTERS,
      statuses: [SESSION_STATUS.ACTIVE],
      projectIds: [PROJECT_ID],
    });
  });

  // The load-bearing assertion for "the number and the destination must agree":
  // the strip's count read and the listing the strip links to are two
  // projections of ONE facet selection, so round-tripping the href through the
  // destination page's own parser must reproduce that selection exactly. If a
  // future change gives either projection its own dimension or value, this fails.
  it("round-trips the count predicate through the destination URL unchanged", () => {
    const filters = buildProjectActiveSessionsFilters(PROJECT_ID);

    const parsed = parseHrefFacets(
      buildProjectActiveSessionsHref(ORG_SLUG, PROJECT_ID)
    );

    expect(parsed).toEqual(filters);
  });

  it("sends the same statuses and projects to the count read as the URL carries", () => {
    const href = buildProjectActiveSessionsHref(ORG_SLUG, PROJECT_ID);
    const parsed = parseHrefFacets(href);

    const queryFilters = buildProjectActiveSessionsQueryFilters(PROJECT_ID);

    expect(queryFilters.statuses).toEqual(parsed.statuses);
    expect(queryFilters.projectIds).toEqual(parsed.projectIds);
  });

  it("reads only the count, not a page of rows", () => {
    expect(buildProjectActiveSessionsQueryFilters(PROJECT_ID).limit).toBe(1);
  });

  it("targets the org's Sessions listing with the canonical facet param names", () => {
    const href = buildProjectActiveSessionsHref(ORG_SLUG, PROJECT_ID);

    expect(href.startsWith(`/${ORG_SLUG}/sessions?`)).toBe(true);
    const params = new URLSearchParams(href.split("?")[1]);
    expect(params.getAll("project")).toEqual([PROJECT_ID]);
    expect(params.getAll("status")).toEqual([SESSION_STATUS.ACTIVE]);
  });

  it("carries no facet beyond status, project, and the window", () => {
    const params = new URLSearchParams(
      buildProjectActiveSessionsHref(ORG_SLUG, PROJECT_ID).split("?")[1]
    );

    expect([...new Set(params.keys())].sort()).toEqual(
      [
        SESSION_FACET_FILTER_PARAMS.projectIds,
        SESSION_DATE_RANGE_PARAM,
        SESSION_FACET_FILTER_PARAMS.statuses,
      ].sort()
    );
  });

  // ISS-5355 (bot review): the count read and the link must name the SAME date
  // window. The count was unwindowed while the destination applied the viewer's
  // saved range (default 7d), so a viewer could click an all-time number and
  // land on a shorter list with nothing on screen explaining the gap.
  it("counts over the same window its link hands the listing", () => {
    const params = new URLSearchParams(
      buildProjectActiveSessionsHref(ORG_SLUG, PROJECT_ID).split("?")[1]
    );

    const linkedRange = parseSessionDateRangeParam(
      params.get(SESSION_DATE_RANGE_PARAM)
    );

    // The destination's own parser must recognise the window the link names —
    // an unparseable value falls back to the viewer's saved range, which is the
    // exact silent re-windowing this closes.
    expect(linkedRange).toBe(PROJECT_ACTIVE_SESSIONS_DATE_RANGE);
    expect(buildProjectActiveSessionsQueryFilters(PROJECT_ID).startDate).toBe(
      getStartDateForRange(PROJECT_ACTIVE_SESSIONS_DATE_RANGE)
    );
  });

  it("counts every active session, because active is a now-state", () => {
    // A session left ACTIVE that the stale-session reaper has not swept is still
    // active; a 7-day floor would make the strip report a number the project
    // page cannot account for. So the window is unbounded — and, per the test
    // above, the link says so rather than leaving it to the viewer.
    expect(
      buildProjectActiveSessionsQueryFilters(PROJECT_ID).startDate
    ).toBeUndefined();
  });
});
