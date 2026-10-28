/**
 * ISS-6650: route tests for GET /agent-components/ranking.
 *
 * Deliberately narrow. The leaderboard SERVICE is covered by `ranking.test.ts`
 * and `ranking-list-parity.test.ts`, the read is org-visible and side-effect
 * free, and no production UI calls it today — so this file covers only what the
 * handler itself decides: which org it reads for, and whether the `kind`/`limit`
 * facets survive the parse.
 *
 * The service double is a FIXED-VALUE STUB and every test asserts the ARGUMENT
 * OBJECT `getRanking` WAS CALLED WITH, rather than re-deriving a leaderboard
 * inside `mockImplementation` and inspecting the rows that came back. A fake
 * that re-applies the facets only proves the fields it models, so a handler
 * that forwarded them and also pinned an unmodelled field kept the suite green.
 *
 * NOT asserted here: that `requiredScopes: ["read"]` is enforced. `withAnyAuth`
 * falls back to `{ requiredScopes: ["read"] }` for any GET when a route passes
 * no options (`with-any-auth.ts`), so deleting the option from this route
 * changes no reachable behavior — a test pinning it would redden on a no-op and
 * would still not prove enforcement, which belongs to `withApiKeyAuth`.
 */
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ANALYTICS_LIMIT_DEFAULT } from "../analytics-validators";

const mocks = vi.hoisted(() => ({
  getRanking: vi.fn(),
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

vi.mock("../ranking/service", () => ({
  rankingService: { getRanking: mocks.getRanking },
}));

import { GET as rankingRoute } from "../ranking/route";

/** The one leaderboard the stub answers with, whatever it is asked for. */
const SERVICE_RESULT = {
  items: [
    {
      slug: `${AgentComponentKind.Command}::bravo`,
      name: "bravo",
      kind: AgentComponentKind.Command,
      rank: 1,
      invocations: 9,
      sessions: 1,
      adoptionBreadth: 1,
      errorRate: null,
    },
  ],
  total: 1,
};

function makeRequest(query = "") {
  return new NextRequest(`http://localhost/agent-components/ranking${query}`, {
    method: "GET",
  });
}

const emptyContext = { params: Promise.resolve({}) };

describe("GET /agent-components/ranking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authCtx.organizationId = "org-1";
    mocks.getRanking.mockResolvedValue(SERVICE_RESULT);
  });

  it("reads the leaderboard for the caller's org from auth, never a client value", async () => {
    mocks.authCtx.organizationId = "org-2";

    const response = await rankingRoute(makeRequest(), emptyContext);

    expect(response.status).toBe(200);
    expect(mocks.getRanking).toHaveBeenCalledWith({
      organizationId: "org-2",
      kind: undefined,
      limit: ANALYTICS_LIMIT_DEFAULT,
    });
  });

  it("forwards `kind`", async () => {
    await rankingRoute(
      makeRequest(`?kind=${AgentComponentKind.Command}`),
      emptyContext
    );

    expect(mocks.getRanking).toHaveBeenCalledWith({
      organizationId: "org-1",
      kind: AgentComponentKind.Command,
      limit: ANALYTICS_LIMIT_DEFAULT,
    });
  });

  it("forwards `limit` as the requested page size", async () => {
    await rankingRoute(makeRequest("?limit=2"), emptyContext);

    expect(mocks.getRanking).toHaveBeenCalledWith({
      organizationId: "org-1",
      kind: undefined,
      limit: 2,
    });
  });

  it("rejects a non-positive `limit` and never reaches the service", async () => {
    const response = await rankingRoute(makeRequest("?limit=0"), emptyContext);

    // A zero/NaN limit that slipped through became a `slice(0, …)` that silently
    // emptied the leaderboard, so the parse error must short-circuit here.
    expect(response.status).toBe(400);
    expect(mocks.getRanking).not.toHaveBeenCalled();
  });

  it("answers with the leaderboard the service returned", async () => {
    const response = await rankingRoute(makeRequest(), emptyContext);
    const body = await response.json();

    expect(body.data).toEqual(SERVICE_RESULT);
  });
});
