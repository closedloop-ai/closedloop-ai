/**
 * ISS-6651: route tests for GET /agent-components/pack/{packId}.
 *
 * `pack-analytics-service.test.ts` covers the rollup itself; the handler's own
 * decisions — which org the pack is read for, which id it resolves from the
 * path, and mapping an absent rollup to a 404 — had no coverage.
 *
 * The service double is a FIXED-VALUE STUB and the handoff tests assert the
 * ARGUMENTS `getPackAnalytics` WAS CALLED WITH. An earlier revision used a
 * two-org discriminating fake and asserted the response body instead, which
 * proved the org reached the service only by way of a second lookup
 * implementation living in the mock.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPackAnalytics: vi.fn(),
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

vi.mock("../pack-analytics-service", () => ({
  packAnalyticsService: { getPackAnalytics: mocks.getPackAnalytics },
}));

import { GET as packRoute } from "../pack/[packId]/route";

/** A pack id carrying a character the wire must percent-encode. */
const PACK_ID = "closedloop/ai-pack";

/** The one rollup the stub answers with, whatever it is asked for. */
const SERVICE_RESULT = {
  packId: PACK_ID,
  invocations: 120,
  sessions: 3,
  locPerDollar: null,
  owners: ["Ada Lovelace"],
  deviceCount: 2,
  locDelta: null,
  costDelta: null,
  durationDelta: null,
  qualityScore: null,
  qualityDelta: null,
};

function makeRequest(packId: string) {
  return new NextRequest(
    `http://localhost/agent-components/pack/${encodeURIComponent(packId)}`,
    { method: "GET" }
  );
}

/**
 * Next pre-decodes every captured segment before populating `context.params`
 * (`getRouteMatcher`, next@16), so the handler receives the raw pack id. The
 * request URL keeps the encoded form because that is the wire representation;
 * the param does not. The handler's second `decodeURIComponent` was a defect,
 * removed by ISS-6908; the two literal-`%` cases below stop it returning.
 */
function routeContext(packId: string) {
  return { params: Promise.resolve({ packId }) };
}

describe("GET /agent-components/pack/[packId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authCtx.organizationId = "org-1";
    mocks.getPackAnalytics.mockResolvedValue(SERVICE_RESULT);
  });

  it("reads the pack for the caller's org from auth, never a client value", async () => {
    mocks.authCtx.organizationId = "org-2";

    const response = await packRoute(
      makeRequest(PACK_ID),
      routeContext(PACK_ID)
    );

    expect(response.status).toBe(200);
    // Substituting a hardcoded or client-supplied org here is how one org's
    // rollup leaks to another; the id must come from the auth context.
    expect(mocks.getPackAnalytics).toHaveBeenCalledWith("org-2", PACK_ID);
  });

  it("resolves the pack id from the path param", async () => {
    await packRoute(makeRequest(PACK_ID), routeContext(PACK_ID));

    expect(mocks.getPackAnalytics).toHaveBeenCalledWith("org-1", PACK_ID);
  });

  it("answers with the rollup the service returned", async () => {
    const response = await packRoute(
      makeRequest(PACK_ID),
      routeContext(PACK_ID)
    );
    const body = await response.json();

    expect(body.data).toEqual(SERVICE_RESULT);
  });

  /**
   * ISS-6908. A second decode read the `%20` in an already-decoded pack id as
   * an escape and rolled up a DIFFERENT pack — a 404, or another pack's numbers
   * rendered under this pack's name, with nothing saying the key was rewritten.
   */
  it("rolls up a pack id containing a literal percent escape verbatim", async () => {
    const literalPercentPackId = "closedloop/a%20b";

    await packRoute(
      makeRequest(literalPercentPackId),
      routeContext(literalPercentPackId)
    );

    expect(mocks.getPackAnalytics).toHaveBeenCalledWith(
      "org-1",
      literalPercentPackId
    );
  });

  /**
   * ISS-6908. `decodeURIComponent("closedloop/100%-done")` throws
   * `URIError: URI malformed`; inside this handler's try/catch that became a
   * generic 500 for a pack the org may legitimately own.
   */
  it("answers a pack id with an undecodable percent instead of a 500", async () => {
    const undecodablePackId = "closedloop/100%-done";

    const response = await packRoute(
      makeRequest(undecodablePackId),
      routeContext(undecodablePackId)
    );

    expect(response.status).toBe(200);
    expect(mocks.getPackAnalytics).toHaveBeenCalledWith(
      "org-1",
      undecodablePackId
    );
  });

  it("maps an absent rollup to 404", async () => {
    mocks.getPackAnalytics.mockResolvedValue(null);

    const response = await packRoute(
      makeRequest("no-such-pack"),
      routeContext("no-such-pack")
    );

    expect(response.status).toBe(404);
  });
});
