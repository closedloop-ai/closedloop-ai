/**
 * ISS-6822 — `GET /agent-components/page-data` at the HTTP boundary.
 *
 * The sibling `page-data-service.test.ts` drives the service with an already
 * typed params object, so it never sees the query STRING. Everything below only
 * exists on this side of `parseQueryParams`: the org identity the route reads
 * from auth rather than from the caller, the two closed-by-default flag gates
 * arriving as the strings `"true"`/`"false"`, the repeated-param facets, and the
 * refusal to reduce against a half-specified prior window.
 *
 * Every case asserts the PARSED QUERY the service was handed, or the response —
 * never that a mock was reached.
 */

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPageDataForOrg: vi.fn(),
  authCtx: { organizationId: "org-1" },
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, context: { params: Promise<unknown> }) =>
      handler(
        {
          user: { id: "user-1", organizationId: mocks.authCtx.organizationId },
          clerkUserId: "clerk-user-1",
          authMethod: "session",
        },
        request,
        context.params
      ),
}));

vi.mock("../service", () => ({
  agentComponentPageDataService: {
    getPageDataForOrg: mocks.getPageDataForOrg,
  },
}));

import {
  AgentComponentKind,
  AgentComponentSortKey,
  Harness,
} from "@repo/api/src/types/agent-component";
import { AGENT_COMPONENT_PAGE_DATA_MAX_FACET_VALUES } from "@repo/api/src/utils/agent-component-page-data";
import { GET as pageDataRoute } from "../route";

const EMPTY_RESULT = {
  items: [],
  filteredTotal: 0,
  totalPages: 1,
  page: 0,
  facets: { collaborators: [], sources: [], harnesses: [] },
  current: {
    components: 0,
    invocations: 0,
    locPerDollar: null,
    locPerDollarSampleSize: 0,
    collaborators: 0,
    hasVerifiableLocPerDollar: false,
    invocationsExact: true,
    invocationsPluginCoverage: [],
  },
};

function request(query = ""): NextRequest {
  return new NextRequest(
    `http://localhost/agent-components/page-data${query}`,
    { method: "GET" }
  );
}

function routeContext() {
  return { params: Promise.resolve({}) };
}

/** The params the route actually handed the service on its last call. */
function lastParams(): Record<string, unknown> {
  const call = mocks.getPageDataForOrg.mock.calls.at(-1);
  if (!call) {
    throw new Error("the route did not reach the service");
  }
  return call[1] as Record<string, unknown>;
}

beforeEach(() => {
  mocks.getPageDataForOrg.mockReset();
  mocks.getPageDataForOrg.mockResolvedValue(EMPTY_RESULT);
  mocks.authCtx.organizationId = "org-1";
});

describe("GET /agent-components/page-data (ISS-6822)", () => {
  it("scopes the read to the AUTHENTICATED org, not to anything in the query string", async () => {
    mocks.authCtx.organizationId = "org-real";

    const response = await pageDataRoute(
      request("?organizationId=org-other&orgId=org-other"),
      routeContext()
    );

    expect(response.status).toBe(200);
    expect(mocks.getPageDataForOrg.mock.calls.at(-1)?.[0]).toBe("org-real");
    // The smuggled ids are not carried through as filters either.
    expect(lastParams()).not.toHaveProperty("organizationId");
  });

  it("reads the closed-by-default gates from the literal string 'true' only", async () => {
    // Query params are strings, so `"false"` is truthy. A coercion that treated
    // any present value as enabled would open both gates for the very callers
    // that spelled out their intent to keep them closed.
    await pageDataRoute(
      request("?honestSource=false&dedupePluginRollups=1"),
      routeContext()
    );
    expect(lastParams().honestSource).toBe(false);
    expect(lastParams().dedupePluginRollups).toBe(false);

    await pageDataRoute(
      request("?honestSource=true&dedupePluginRollups=true"),
      routeContext()
    );
    expect(lastParams().honestSource).toBe(true);
    expect(lastParams().dedupePluginRollups).toBe(true);
  });

  it("defaults every gate and facet closed when the caller sends nothing", async () => {
    await pageDataRoute(request(), routeContext());

    const params = lastParams();
    expect(params.honestSource).toBe(false);
    expect(params.dedupePluginRollups).toBe(false);
    expect(params.kinds).toEqual([]);
    expect(params.harnesses).toEqual([]);
    expect(params.page).toBe(0);
    expect(params.sortBy).toBe(AgentComponentSortKey.Name);
    expect(params.startDate).toBeUndefined();
  });

  it("reads a repeated facet param as the whole multi-select, not just its last value", async () => {
    await pageDataRoute(
      request(`?harnesses=${Harness.Claude}&harnesses=${Harness.Codex}`),
      routeContext()
    );

    expect(lastParams().harnesses).toEqual([Harness.Claude, Harness.Codex]);
  });

  it("rejects a half-specified prior window instead of reducing against an unbounded baseline", async () => {
    // `prevEnd` alone leaves the baseline unbounded below (every component the
    // org has ever had); `prevStart` alone overlaps the current window. Either
    // one would put a real percentage on the delta chip against a population
    // nobody asked for.
    const onlyEnd = await pageDataRoute(
      request("?prevEnd=2026-06-01"),
      routeContext()
    );
    const onlyStart = await pageDataRoute(
      request("?prevStart=2026-04-01"),
      routeContext()
    );

    expect(onlyEnd.status).toBe(400);
    expect(onlyStart.status).toBe(400);
    expect(mocks.getPageDataForOrg).not.toHaveBeenCalled();
  });

  it("accepts a complete prior window and passes both bounds through", async () => {
    const response = await pageDataRoute(
      request("?startDate=2026-06-01&prevStart=2026-04-01&prevEnd=2026-06-01"),
      routeContext()
    );

    expect(response.status).toBe(200);
    expect(lastParams().prevStart).toBe("2026-04-01");
    expect(lastParams().prevEnd).toBe("2026-06-01");
  });

  it("rejects a page size above the inventory cap rather than serving it", async () => {
    const response = await pageDataRoute(
      request("?pageSize=999999"),
      routeContext()
    );

    expect(response.status).toBe(400);
    expect(mocks.getPageDataForOrg).not.toHaveBeenCalled();
  });
});

describe("GET /agent-components/page-data — facet bounds (ISS-9073)", () => {
  function collaborators(count: number): string {
    return Array.from({ length: count }, (_, i) => `collaborators=c${i}`).join(
      "&"
    );
  }

  it("collapses a repeated facet value to one entry", async () => {
    await pageDataRoute(
      request(
        `?kinds=${AgentComponentKind.Skill}&kinds=${AgentComponentKind.Skill}`
      ),
      routeContext()
    );

    expect(lastParams().kinds).toEqual([AgentComponentKind.Skill]);
  });

  it("de-duplicates BEFORE capping, so one value repeated past the cap still serves", async () => {
    const repeated = Array.from(
      { length: AGENT_COMPONENT_PAGE_DATA_MAX_FACET_VALUES + 50 },
      () => `kinds=${AgentComponentKind.Skill}`
    ).join("&");

    const response = await pageDataRoute(
      request(`?${repeated}`),
      routeContext()
    );

    expect(response.status).toBe(200);
    expect(lastParams().kinds).toEqual([AgentComponentKind.Skill]);
  });

  it("rejects more distinct open-valued facet values than the cap before the in-memory narrowing", async () => {
    const response = await pageDataRoute(
      request(
        `?${collaborators(AGENT_COMPONENT_PAGE_DATA_MAX_FACET_VALUES + 1)}`
      ),
      routeContext()
    );

    expect(response.status).toBe(400);
    expect(mocks.getPageDataForOrg).not.toHaveBeenCalled();
  });

  it("accepts exactly the cap of distinct values", async () => {
    const response = await pageDataRoute(
      request(`?${collaborators(AGENT_COMPONENT_PAGE_DATA_MAX_FACET_VALUES)}`),
      routeContext()
    );

    expect(response.status).toBe(200);
    expect(lastParams().collaborators).toHaveLength(
      AGENT_COMPONENT_PAGE_DATA_MAX_FACET_VALUES
    );
  });
});
