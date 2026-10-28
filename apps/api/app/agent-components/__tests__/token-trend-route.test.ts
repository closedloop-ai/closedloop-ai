/**
 * ISS-6648: route tests for GET /agent-components/{slug}/token-trend — the
 * endpoint behind the Agents detail "Usage over time" chart.
 *
 * The route destructures `userId`/`since`/`until` out of the parsed query and
 * hands them to `analyticsService.fetchTokenTrend`. Nothing downstream of the
 * handler would notice if it stopped passing one of them: the chart would
 * silently widen to the component's whole history (or to every user's usage)
 * and still render.
 *
 * The service double is therefore a FIXED-VALUE STUB and each handoff test
 * asserts the ARGUMENTS `fetchTokenTrend` WAS CALLED WITH. An earlier revision
 * used a discriminating fake that re-applied the org/slug/user/date bounds
 * inside `mockImplementation` and asserted the points that came back; that put
 * the route→service contract in a second implementation inside the mock, and it
 * could only see the fields the fake modelled.
 *
 * Service-side filtering itself is covered by `token-trend.test.ts`; this file
 * covers only the route → service handoff and the response mapping.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchTokenTrend: vi.fn(),
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

vi.mock("../analytics-service", () => ({
  analyticsService: { fetchTokenTrend: mocks.fetchTokenTrend },
}));

import { GET as tokenTrendRoute } from "../[slug]/token-trend/route";
import { encodeTokenTrendCursor } from "../token-trend-cursor";

const SLUG = "skill::deep-work";

/** The one trend the stub answers with, whatever it is asked for. */
const SERVICE_RESULT = {
  slug: SLUG,
  points: [
    {
      sessionId: "sess-feb",
      sessionStartedAt: "2026-02-15T00:00:00.000Z",
      model: "claude-opus-4-5",
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCostUsd: 0.5,
      runtimeMs: 1000,
    },
  ],
  models: ["claude-opus-4-5"],
};

function makeRequest(query = "") {
  return new NextRequest(
    `http://localhost/agent-components/${encodeURIComponent(SLUG)}/token-trend${query}`,
    { method: "GET" }
  );
}

/**
 * Next's route matcher runs `decodeURIComponent` over every captured segment
 * before it populates `context.params` (`getRouteMatcher`, next@16), so a
 * handler receives the DECODED slug — `skill::deep-work`, never
 * `skill%3A%3Adeep-work`. The request URL above still carries the encoded form,
 * because that is what goes over the wire; only the param is pre-decoded.
 *
 * An earlier revision seeded an ENCODED slug here and asserted the handler
 * decoded it. That modelled a state the framework cannot produce, and it pinned
 * the handler's second `decodeURIComponent` — a live defect, now removed by
 * ISS-6908. Do not reintroduce an encoded fixture to bring that decode back:
 * the two literal-`%` cases below are what stop it returning.
 */
function routeContext(slug: string = SLUG) {
  return { params: Promise.resolve({ slug }) };
}

/** The options object the route handed the service on its first call. */
function forwardedOptions() {
  return mocks.fetchTokenTrend.mock.calls[0][2];
}

describe("GET /agent-components/[slug]/token-trend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authCtx.organizationId = "org-1";
    mocks.fetchTokenTrend.mockResolvedValue(SERVICE_RESULT);
  });

  it("forwards `since` from the query", async () => {
    const response = await tokenTrendRoute(
      makeRequest("?since=2026-02-01"),
      routeContext()
    );

    expect(response.status).toBe(200);
    // Dropped, the chart silently widens to the component's whole history.
    expect(mocks.fetchTokenTrend).toHaveBeenCalledTimes(1);
    expect(forwardedOptions()).toEqual({
      userId: undefined,
      since: "2026-02-01",
      until: undefined,
    });
  });

  it("forwards `until` from the query", async () => {
    await tokenTrendRoute(makeRequest("?until=2026-02-28"), routeContext());

    expect(mocks.fetchTokenTrend).toHaveBeenCalledTimes(1);
    expect(forwardedOptions()).toEqual({
      userId: undefined,
      since: undefined,
      until: "2026-02-28",
    });
  });

  it("forwards `userId` from the query", async () => {
    await tokenTrendRoute(makeRequest("?userId=user-2"), routeContext());

    // The personal view must not fall back to the whole org's usage.
    expect(mocks.fetchTokenTrend).toHaveBeenCalledTimes(1);
    expect(forwardedOptions()).toEqual({
      userId: "user-2",
      since: undefined,
      until: undefined,
    });
  });

  it("scopes to the caller's org from auth, never a client value", async () => {
    mocks.authCtx.organizationId = "org-2";

    const response = await tokenTrendRoute(makeRequest(), routeContext());

    expect(response.status).toBe(200);
    expect(mocks.fetchTokenTrend).toHaveBeenCalledWith(
      "org-2",
      SLUG,
      expect.anything()
    );
  });

  it("reads the trend for the slug from the path param", async () => {
    await tokenTrendRoute(makeRequest(), routeContext());

    expect(mocks.fetchTokenTrend).toHaveBeenCalledWith(
      "org-1",
      SLUG,
      expect.anything()
    );
  });

  it("answers with the trend the service returned", async () => {
    const response = await tokenTrendRoute(makeRequest(), routeContext());
    const body = await response.json();

    expect(body.data).toEqual(SERVICE_RESULT);
  });

  it("maps a null service result to 404", async () => {
    mocks.fetchTokenTrend.mockResolvedValue(null);

    const response = await tokenTrendRoute(makeRequest(), routeContext());

    expect(response.status).toBe(404);
  });

  /**
   * ISS-6908. Next hands the handler an already-decoded slug, so a slug whose
   * key legitimately contains `%` reaches it verbatim. A second decode read
   * `%20` as an escape and silently looked up a DIFFERENT component — a 404 or,
   * worse, a neighbouring row's trend, with nothing in the response saying so.
   */
  it("looks up a slug containing a literal percent escape verbatim", async () => {
    const literalPercentSlug = "skill::a%20b";

    await tokenTrendRoute(makeRequest(), routeContext(literalPercentSlug));

    expect(mocks.fetchTokenTrend).toHaveBeenCalledWith(
      "org-1",
      literalPercentSlug,
      expect.anything()
    );
  });

  /**
   * ISS-6908. `decodeURIComponent("skill::100%-done")` throws
   * `URIError: URI malformed`, and in this route the decode sat OUTSIDE the
   * try/catch — so the throw escaped the handler entirely instead of becoming a
   * response. Assert a real response, not merely that the promise settles.
   */
  it("answers a slug with an undecodable percent instead of throwing", async () => {
    const undecodableSlug = "skill::100%-done";

    const response = await tokenTrendRoute(
      makeRequest(),
      routeContext(undecodableSlug)
    );

    expect(response.status).toBe(200);
    expect(mocks.fetchTokenTrend).toHaveBeenCalledWith(
      "org-1",
      undecodableSlug,
      expect.anything()
    );
  });

  /**
   * ISS-9851. The cursor is decoded by the validator, so the service receives a
   * position rather than a string — and a token the endpoint did not mint never
   * becomes a uuid comparison the database rejects.
   */
  it("forwards a decoded `cursor` from the query", async () => {
    const cursor = {
      sessionStartedAtMs: Date.parse("2026-07-01T00:00:00.000Z"),
      agentSessionId: "01a08753-c74c-7349-8010-5d07ee4f8bd4",
    };

    await tokenTrendRoute(
      makeRequest(`?cursor=${encodeTokenTrendCursor(cursor)}`),
      routeContext()
    );

    expect(mocks.fetchTokenTrend).toHaveBeenCalledTimes(1);
    expect(forwardedOptions()).toEqual({
      userId: undefined,
      since: undefined,
      until: undefined,
      cursor,
    });
  });

  it("rejects a cursor it never minted and never reaches the service", async () => {
    const response = await tokenTrendRoute(
      makeRequest("?cursor=not-a-cursor"),
      routeContext()
    );

    // A 400, not a 500: the id inside a forged token would otherwise reach the
    // read as a uuid comparison against garbage.
    expect(response.status).toBe(400);
    expect(mocks.fetchTokenTrend).not.toHaveBeenCalled();
  });

  it("rejects an unparseable date and never reaches the service", async () => {
    const response = await tokenTrendRoute(
      makeRequest("?since=not-a-date"),
      routeContext()
    );

    expect(response.status).toBe(400);
    // The parse error must short-circuit: an Invalid Date reaching the usage
    // read is a 500, not a 400.
    expect(mocks.fetchTokenTrend).not.toHaveBeenCalled();
  });
});
