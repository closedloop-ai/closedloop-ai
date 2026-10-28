import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ detail: vi.fn() }));
vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (
      request: NextRequest,
      context: { params: Promise<Record<string, string>> }
    ) =>
      handler(
        { user: { id: "user-1", clerkId: "clerk-1", organizationId: "org-1" } },
        request,
        context.params
      ),
}));
vi.mock("../service", () => ({
  agentComponentsService: { getDetailForOrg: mocks.detail },
}));

import { GET as invocationsRoute } from "../[slug]/invocations/route";
import { GET as sessionsRoute } from "../[slug]/sessions/route";
import { encodeInvocationReadCursor } from "../invocation-read-cursor";

const slug = "skill::literal%20/name";
const context = { params: Promise.resolve({ slug }) };
const sessionCursor = {
  t: "2026-10-19T00:00:00.000Z",
  id: "00000000-0000-4000-8000-000000000001",
};

beforeEach(() => {
  mocks.detail.mockResolvedValue({
    sessionsTab: [],
    sessions: 73,
    sessionsTabNextCursor: "next",
    invocationRows: {
      items: [],
      total: 10,
      hasMore: false,
      nextCursor: null,
      unmatchedCount: 0,
      ambiguousCount: 0,
    },
  });
});

describe("component detail page route handoff", () => {
  it("passes a validated session cursor and the decoded route slug to the canonical detail owner", async () => {
    const cursor = Buffer.from(JSON.stringify(sessionCursor)).toString(
      "base64url"
    );
    const response = await sessionsRoute(
      new NextRequest(
        `http://localhost/agent-components/${encodeURIComponent(slug)}/sessions?cursor=${cursor}`
      ),
      context
    );
    expect(response.status).toBe(200);
    expect(mocks.detail).toHaveBeenCalledWith(
      "org-1",
      slug,
      { userId: "user-1", clerkUserId: "clerk-1" },
      { sessionCursor }
    );
    expect((await response.json()).data).toEqual({
      items: [],
      total: 73,
      nextCursor: "next",
    });
  });

  it("passes an invocation continuation without decoding or widening its identity", async () => {
    const cursor = encodeInvocationReadCursor({
      invokedAtMs: 1234,
      generationId: sessionCursor.id,
      sequence: 2,
      externalInvocationId: "tool-1",
    });
    const response = await invocationsRoute(
      new NextRequest(
        `http://localhost/agent-components/${encodeURIComponent(slug)}/invocations?cursor=${cursor}`
      ),
      context
    );
    expect(response.status).toBe(200);
    expect(mocks.detail).toHaveBeenCalledWith(
      "org-1",
      slug,
      { userId: "user-1", clerkUserId: "clerk-1" },
      { invocationCursor: cursor }
    );
  });

  it.each([sessionsRoute, invocationsRoute])(
    "rejects a malformed continuation before calling the owner",
    async (route) => {
      const response = await route(
        new NextRequest(
          "http://localhost/agent-components/skill/sessions?cursor=malformed"
        ),
        context
      );
      expect(response.status).toBe(400);
      expect(mocks.detail).not.toHaveBeenCalled();
    }
  );

  it("maps missing component to 404", async () => {
    mocks.detail.mockResolvedValue(null);
    const response = await sessionsRoute(
      new NextRequest("http://localhost/agent-components/skill/sessions"),
      context
    );
    expect(response.status).toBe(404);
  });
});
