/**
 * ISS-6649: the catalog LIST route's filter/sort handoff to the service.
 *
 * `route.test.ts` covers org isolation, empty results, invalid params and the
 * deprecated `owner` alias; `list-sort.test.ts` and `inventory-where.test.ts`
 * cover the service's own filtering and ordering. What neither covers is that
 * `kinds`, `harness` and the sort params actually SURVIVE the route — the
 * handler forwards the whole parsed query object, so a change that reshaped or
 * narrowed it would silently answer every request with the unfiltered,
 * insertion-ordered org inventory.
 *
 * The service double is a FIXED-VALUE STUB and every test asserts the
 * ARGUMENTS `listForOrg` WAS CALLED WITH. An earlier revision instead used a
 * discriminating fake that re-applied the facets inside `mockImplementation`
 * and asserted the returned rows; that made the route→service contract depend
 * on a second implementation living in the mock, and it could not see any field
 * the fake did not model — a handler that forwarded the parsed query but pinned
 * `limit: 1` (the exact truncation `validators.ts` documents) kept the whole
 * suite green. Asserting the invocation shape closes that hole directly.
 *
 * Kept in its own file rather than grown onto `route.test.ts`, which is already
 * near the 500-line smell threshold.
 */
import {
  AgentComponentKind,
  AgentComponentSortDir,
  AgentComponentSortKey,
  Harness,
} from "@repo/api/src/types/agent-component";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_COMPONENT_LIST_DEFAULT_LIMIT,
  type AgentComponentListQuery,
} from "../validators";

const mocks = vi.hoisted(() => ({
  listForOrg: vi.fn(),
  authCtx: {
    userId: "user-1",
    organizationId: "org-1",
    clerkUserId: "clerk-user-1",
  },
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (
      request: NextRequest,
      context: { params: Promise<Record<string, string>> }
    ) =>
      handler(
        {
          user: {
            id: mocks.authCtx.userId,
            organizationId: mocks.authCtx.organizationId,
          },
          clerkUserId: mocks.authCtx.clerkUserId,
          authMethod: "session",
        },
        request,
        context.params
      ),
}));

vi.mock("../service", () => ({
  agentComponentsService: { listForOrg: mocks.listForOrg },
}));

import { GET as listRoute } from "../route";

/** The one page every test's stub answers with, whatever it is asked for. */
const SERVICE_RESULT = {
  items: [
    {
      slug: `${AgentComponentKind.Skill}::alpha`,
      name: "alpha",
      kind: AgentComponentKind.Skill,
    },
  ],
  total: 1,
  hasMore: false,
};

/**
 * The pagination the schema defaults to when a request supplies neither. Every
 * expectation below spells them out, so a handler that overrides either one
 * fails instead of passing unnoticed.
 */
const DEFAULT_PAGE = {
  limit: AGENT_COMPONENT_LIST_DEFAULT_LIMIT,
  offset: 0,
} as const;

function makeRequest(query = "") {
  return new NextRequest(`http://localhost/agent-components${query}`, {
    method: "GET",
  });
}

function routeContext() {
  return { params: Promise.resolve({}) };
}

/** The parsed query object the route handed the service on its first call. */
function forwardedQuery(): AgentComponentListQuery {
  return mocks.listForOrg.mock.calls[0][1];
}

describe("GET /agent-components — filter and sort handoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authCtx.organizationId = "org-1";
    mocks.listForOrg.mockResolvedValue(SERVICE_RESULT);
  });

  it("forwards `kinds` as the selected set, under the caller's org", async () => {
    const response = await listRoute(
      makeRequest(`?kinds=${AgentComponentKind.Command}`),
      routeContext()
    );

    expect(response.status).toBe(200);
    expect(mocks.listForOrg).toHaveBeenCalledWith("org-1", {
      kinds: [AgentComponentKind.Command],
      ...DEFAULT_PAGE,
    });
  });

  it("forwards a repeated `kinds` param as the whole selected set", async () => {
    await listRoute(
      makeRequest(
        `?kinds=${AgentComponentKind.Command}&kinds=${AgentComponentKind.Skill}`
      ),
      routeContext()
    );

    // The query-array preprocessing must reach the service as BOTH kinds, not
    // as the last-wins scalar `URLSearchParams.get` would yield.
    expect(mocks.listForOrg).toHaveBeenCalledTimes(1);
    expect(forwardedQuery().kinds).toEqual([
      AgentComponentKind.Command,
      AgentComponentKind.Skill,
    ]);
  });

  it("collapses a repeated `kinds` value instead of forwarding one arm each", async () => {
    // ISS-7271 (davetho review): every duplicate is one more bind parameter in
    // the usage rollup's `componentKind: { in: … }`, and enough of them build a
    // statement past the driver's ceiling that Prisma refuses outright — a 500
    // on the Agents catalog, from a query string carrying nothing but VALID
    // values. Repeated far past the enum's cardinality so a per-value cap could
    // not pass this while the duplicate arms still reached the predicate.
    const repeated = Array.from(
      { length: 200 },
      () => `kinds=${AgentComponentKind.Command}`
    ).join("&");

    await listRoute(makeRequest(`?${repeated}`), routeContext());

    expect(forwardedQuery().kinds).toEqual([AgentComponentKind.Command]);
  });

  it("forwards `harness`", async () => {
    await listRoute(makeRequest(`?harness=${Harness.Codex}`), routeContext());

    expect(mocks.listForOrg).toHaveBeenCalledWith("org-1", {
      harness: Harness.Codex,
      ...DEFAULT_PAGE,
    });
  });

  it("forwards `sortBy`/`sortDir` as the requested key and direction", async () => {
    await listRoute(
      makeRequest(
        `?sortBy=${AgentComponentSortKey.Invocations}&sortDir=${AgentComponentSortDir.Desc}`
      ),
      routeContext()
    );

    // A dropped `sortDir` leaves the service defaulting to ascending, which is
    // a different leaderboard than the one the caller asked for.
    expect(mocks.listForOrg).toHaveBeenCalledWith("org-1", {
      sortBy: AgentComponentSortKey.Invocations,
      sortDir: AgentComponentSortDir.Desc,
      ...DEFAULT_PAGE,
    });
  });

  it("answers with the page the service returned", async () => {
    const response = await listRoute(makeRequest(), routeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual(SERVICE_RESULT);
  });
});
