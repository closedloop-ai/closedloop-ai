/**
 * ISS-12168. A 4xx `request_completed` line carries the response's contract
 * `error_code`, so the per-route denial monitors can tell an expected per-item
 * refusal from an authorization regression. ISS-12274: the same line's `path`
 * is the matched route template.
 *
 * Driven through the production wrappers: `POST /session-mesh/feedback` under
 * its real `withSessionMeshAuth` → `withAnyAuth` → `withDesktopSessionAuth`
 * chain (the 2026-10-07 storm's route and caller), and each wrapper that
 * emits `request_completed` on its own, so deleting the read from any one of
 * them turns a case here red. The only doubles are the identity, flag and
 * service lookups behind them.
 */
import { failure } from "@repo/api/src/types/common";
import { LoopsEndpointRemoval } from "@repo/api/src/types/endpoint-removal";
import { Status } from "@repo/api/src/types/result";
import { SessionMeshForbiddenCode } from "@repo/api/src/types/session-mesh";
import { API_KEY_SCOPES_UNRESOLVABLE_CODE } from "@repo/api/src/utils/api-key-scope-resolution";
import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@repo/observability/log", async () => {
  const { createLogMockModule } = await import(
    "@/__tests__/fixtures/mock-modules"
  );
  return createLogMockModule();
});
vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));
vi.mock("@repo/auth/server", () => ({ auth: vi.fn() }));
vi.mock("@repo/auth/desktop-session-jwt", () => ({
  isDesktopSessionToken: vi.fn(() => true),
}));
vi.mock("@/app/api-keys/service", () => ({
  apiKeysService: { touchLastUsedAt: vi.fn(), verifyKeyWithMetadata: vi.fn() },
}));
vi.mock("@/app/organizations/service", () => ({
  organizationsService: { findById: vi.fn() },
}));
vi.mock("@/app/users/service", () => ({
  usersService: { findById: vi.fn() },
}));
vi.mock("@/lib/auth/find-or-create-user", () => ({
  findOrCreateUser: vi.fn(),
}));
vi.mock("@/lib/auth/resolve-org-header", () => ({
  resolveOrgHeader: vi.fn(),
}));
vi.mock("@/lib/auth/desktop-session-auth", () => ({
  resolveDesktopSessionContext: vi.fn(),
}));
vi.mock("@/lib/auth/desktop-managed-pop", () => ({
  getDesktopManagedPopRequestFailure: vi.fn(),
}));
vi.mock("@/lib/feature-flag-identity", () => ({
  isFeatureFlagEnabledForAnyIdentity: vi.fn(),
}));
vi.mock("@/app/session-mesh/service", () => ({
  sessionMeshService: { recordFeedback: vi.fn() },
}));

import { auth } from "@repo/auth/server";
import { log } from "@repo/observability/log";
import { apiKeysService } from "@/app/api-keys/service";
import { organizationsService } from "@/app/organizations/service";
import { POST as postFeedback } from "@/app/session-mesh/feedback/route";
import { sessionMeshService } from "@/app/session-mesh/service";
import { usersService } from "@/app/users/service";
import { resolveDesktopSessionContext } from "@/lib/auth/desktop-session-auth";
import { findOrCreateUser } from "@/lib/auth/find-or-create-user";
import { resolveOrgHeader } from "@/lib/auth/resolve-org-header";
import { withApiKeyAuth } from "@/lib/auth/with-api-key-auth";
import { withAuth } from "@/lib/auth/with-auth";
import { withDesktopSessionAuth } from "@/lib/auth/with-desktop-session-auth";
import { isFeatureFlagEnabledForAnyIdentity } from "@/lib/feature-flag-identity";
import { loopsRemovedResponse } from "@/lib/loops-removed-response";
import { withRequestCompleted } from "@/lib/observability/with-request-completed";
import {
  forbiddenResponse,
  REQUEST_COMPLETED_EVENT,
  unauthorizedResponse,
} from "@/lib/route-utils";
import { SSE_CONTENT_TYPE } from "@/lib/sse-stream";

const ORGANIZATION_ID = "0190f6a1-5b2c-7d3e-8f40-6a7b8c9d0e1f";
const USER_ID = "019c2500-1f4c-7a10-9d33-6b0f2c8e41aa";
const CLERK_ORG_ID = "org_clerk_abc123";
const CLERK_USER_ID = "clerk_user_1";
const FEEDBACK_URL = "https://api.closedloop.ai/session-mesh/feedback";
const ERROR_CODE_FIELD = "error_code";
const FEEDBACK = {
  idempotencyKey: "fb-1",
  kind: "useful",
  rationale: "avoided a conflict",
};
const USER = {
  id: USER_ID,
  clerkId: CLERK_USER_ID,
  organizationId: ORGANIZATION_ID,
  active: true,
};

function postFeedbackRequest(body: unknown): Promise<Response> {
  return postFeedback(
    new NextRequest(FEEDBACK_URL, {
      method: "POST",
      headers: {
        authorization: "Bearer desktop-session-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) }
  );
}

function requestCompletedFields(): Record<string, unknown> {
  const calls = [
    ...(log.info as Mock).mock.calls,
    ...(log.error as Mock).mock.calls,
  ].filter(([message]) => message === REQUEST_COMPLETED_EVENT);
  if (calls.length !== 1) {
    throw new Error(`expected one request_completed line, got ${calls.length}`);
  }
  return calls[0][1];
}

function authenticate(): void {
  vi.mocked(resolveDesktopSessionContext).mockResolvedValue({
    user: USER,
    organizationId: ORGANIZATION_ID,
    clerkOrgId: CLERK_ORG_ID,
  } as Awaited<ReturnType<typeof resolveDesktopSessionContext>>);
  vi.mocked(apiKeysService.verifyKeyWithMetadata).mockResolvedValue({
    apiKeyId: "api-key-1",
    userId: USER_ID,
    organizationId: ORGANIZATION_ID,
    scopes: ["read", "write"],
    gatewayId: null,
    boundPublicKey: null,
  } as Awaited<ReturnType<typeof apiKeysService.verifyKeyWithMetadata>>);
  vi.mocked(usersService.findById).mockResolvedValue(
    USER as Awaited<ReturnType<typeof usersService.findById>>
  );
  vi.mocked(organizationsService.findById).mockResolvedValue({
    id: ORGANIZATION_ID,
    clerkId: CLERK_ORG_ID,
  } as Awaited<ReturnType<typeof organizationsService.findById>>);
  vi.mocked(auth).mockResolvedValue({
    userId: CLERK_USER_ID,
    orgId: CLERK_ORG_ID,
    orgRole: "org:member",
  } as Awaited<ReturnType<typeof auth>>);
  vi.mocked(resolveOrgHeader).mockResolvedValue({
    kind: "session",
    clerkOrgId: CLERK_ORG_ID,
    orgRole: "org:member",
  });
  vi.mocked(findOrCreateUser).mockResolvedValue(
    USER as Awaited<ReturnType<typeof findOrCreateUser>>
  );
}

function wrappedRequest(): NextRequest {
  return new NextRequest(FEEDBACK_URL, {
    method: "POST",
    headers: { authorization: "Bearer sk_live_testkey" },
  });
}

const ROUTE_CONTEXT = { params: Promise.resolve({}) };
const BRANCH_URL = "https://api.closedloop.ai/branches";
const BRANCH_ID = "019f6b8b-3c2d-7e41-9a10-2b6c8d4e5f70";

function forbiddenWithCode() {
  return Promise.resolve(
    forbiddenResponse({ code: SessionMeshForbiddenCode.AgentForbidden })
  );
}

/** Every wrapper that calls `logRequestCompleted` from its own `finally`. */
const EMITTING_WRAPPERS: Record<
  string,
  (request: NextRequest, context: typeof ROUTE_CONTEXT) => Promise<Response>
> = {
  withApiKeyAuth: withApiKeyAuth(forbiddenWithCode),
  withAuth: withAuth(forbiddenWithCode),
  withDesktopSessionAuth: withDesktopSessionAuth(forbiddenWithCode),
  withRequestCompleted: withRequestCompleted(forbiddenWithCode),
};

describe("request_completed error_code (ISS-12168)", () => {
  beforeEach(() => {
    authenticate();
    vi.mocked(isFeatureFlagEnabledForAnyIdentity).mockResolvedValue(true);
  });

  it("carries a feedback 403's contract code through the real route wiring", async () => {
    vi.mocked(sessionMeshService.recordFeedback).mockResolvedValue({
      ok: false,
      error: Status.Forbidden,
    });

    const response = await postFeedbackRequest(FEEDBACK);

    expect(response.status).toBe(403);
    expect(requestCompletedFields()).toMatchObject({
      path: "/session-mesh/feedback",
      status_code: 403,
      [ERROR_CODE_FIELD]: SessionMeshForbiddenCode.FeedbackForbidden,
    });
    // The code was read from a clone: the caller still receives the body.
    await expect(response.json()).resolves.toMatchObject({
      code: SessionMeshForbiddenCode.FeedbackForbidden,
    });
  });

  it("omits error_code on a 4xx whose body has no code", async () => {
    const response = await postFeedbackRequest({
      ...FEEDBACK,
      kind: "coordination_overhead",
    });

    expect(response.status).toBe(400);
    expect(requestCompletedFields()).not.toHaveProperty(ERROR_CODE_FIELD);
  });

  it("omits error_code on a 2xx", async () => {
    vi.mocked(sessionMeshService.recordFeedback).mockResolvedValue({
      ok: true,
      value: { id: "e-1" },
    } as Awaited<ReturnType<typeof sessionMeshService.recordFeedback>>);

    const response = await postFeedbackRequest(FEEDBACK);

    expect(response.status).toBe(200);
    expect(requestCompletedFields()).not.toHaveProperty(ERROR_CODE_FIELD);
  });

  it.each(Object.entries(EMITTING_WRAPPERS))(
    "%s carries a handler 403's contract code",
    async (_name, route) => {
      const response = await route(wrappedRequest(), ROUTE_CONTEXT);

      expect(response.status).toBe(403);
      expect(requestCompletedFields()).toMatchObject({
        status_code: 403,
        [ERROR_CODE_FIELD]: SessionMeshForbiddenCode.AgentForbidden,
      });
    }
  );

  // ISS-12274: `path` is the `@path` tag of `api.requests.latency.app`, so
  // every wrapper must stamp the route template, not the record id.
  it.each(Object.entries(EMITTING_WRAPPERS))(
    "%s tags path with the route template, not the record id",
    async (_name, route) => {
      await route(
        new NextRequest(`${BRANCH_URL}/${BRANCH_ID}/sessions`, {
          headers: { authorization: "Bearer sk_live_testkey" },
        }),
        { params: Promise.resolve({ id: BRANCH_ID }) }
      );

      expect(requestCompletedFields()).toMatchObject({
        path: "/branches/:id/sessions",
        "url.path": `/branches/${BRANCH_ID}/sessions`,
      });
    }
  );

  it.each([
    {
      label: "a thrown handler",
      handler: () => Promise.reject(new Error("boom")),
    },
    {
      label: "an SSE stream",
      handler: () =>
        Promise.resolve(
          new Response("data: {}\n\n", {
            headers: { "content-type": SSE_CONTENT_TYPE },
          })
        ),
    },
  ])(
    "withRequestCompleted tags $label with the route template",
    async ({ handler }) => {
      const route = withRequestCompleted(
        (_request: NextRequest, _context: typeof ROUTE_CONTEXT) => handler()
      );

      const response = await route(
        new NextRequest(`${BRANCH_URL}/${BRANCH_ID}`),
        { params: Promise.resolve({ id: BRANCH_ID }) }
      ).catch(() => undefined);
      await response?.text();

      expect(requestCompletedFields()).toMatchObject({
        path: "/branches/:id",
      });
    }
  );

  it.each([
    {
      route: "/internal/api-keys/verify",
      status: 401,
      code: API_KEY_SCOPES_UNRESOLVABLE_CODE,
      respond: unauthorizedResponse,
    },
    {
      route: "/loops",
      status: 410,
      code: LoopsEndpointRemoval.Code,
      respond: loopsRemovedResponse,
    },
  ])(
    "carries the $status code $route answers",
    async ({ status, code, respond }) => {
      const handler = withRequestCompleted(async () => respond({ code }));

      await handler(wrappedRequest());

      expect(requestCompletedFields()).toMatchObject({
        status_code: status,
        [ERROR_CODE_FIELD]: code,
      });
    }
  );

  it.each([
    { status: 200, label: "2xx" },
    { status: 503, label: "5xx" },
  ])(
    "omits error_code on a $label that carries a contract code",
    async ({ status }) => {
      const handler = withRequestCompleted(async () =>
        NextResponse.json(
          failure("not a 4xx", { code: SessionMeshForbiddenCode.Disabled }),
          { status }
        )
      );

      await handler(wrappedRequest());

      expect(requestCompletedFields()).toMatchObject({ status_code: status });
      expect(requestCompletedFields()).not.toHaveProperty(ERROR_CODE_FIELD);
    }
  );

  it.each([
    "user 019c2500-1f4c-7a10-9d33-6b0f2c8e41aa is not in org_clerk_abc123",
    "org_2NNEqL2nrIRdJ194ndJqAHwEfxC",
  ])("drops a 403 code outside the contract set: %s", async (code) => {
    const handler = withRequestCompleted(async () =>
      NextResponse.json(failure("Forbidden", { code }), { status: 403 })
    );

    await handler(wrappedRequest());

    expect(requestCompletedFields()).toMatchObject({ status_code: 403 });
    expect(requestCompletedFields()).not.toHaveProperty(ERROR_CODE_FIELD);
  });
});
