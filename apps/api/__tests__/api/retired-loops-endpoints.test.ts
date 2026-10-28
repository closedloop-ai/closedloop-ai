/**
 * ISS-12435 (PRD-795) version skew: Loops are removed, but installed Desktop
 * builds, stale browser bundles and `sk_live_*` integrations still call these
 * routes. Each one answers every method it exported before with a 410 through
 * `goneResponse` (`apps/api/AGENTS.md`), so the caller gets a non-retryable
 * signal instead of a 404 or a 405.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const AUTH_CONTEXT = { user: { id: "user-1", organizationId: "org-1" } };

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (
    handler: (...args: unknown[]) => unknown,
    options?: { requiredScopes?: readonly string[] }
  ) =>
    Object.assign(
      (request: unknown, context: { params?: unknown }) =>
        handler(AUTH_CONTEXT, request, context?.params),
      { wrappedBy: "withAnyAuth", requiredScopes: options?.requiredScopes }
    ),
}));

vi.mock("@/lib/auth/with-auth", () => ({
  withAuth: (handler: (...args: unknown[]) => unknown) =>
    Object.assign(
      (request: unknown, context: { params?: unknown }) =>
        handler(AUTH_CONTEXT, request, context?.params),
      { wrappedBy: "withAuth" }
    ),
}));

import { LoopsEndpointRemoval } from "@repo/api/src/types/endpoint-removal";
import { NextRequest } from "next/server";
import { POST as catalogBootstrapStartPost } from "@/app/catalog/bootstrap/start/route";
import { GET as documentGenerationStatusGet } from "@/app/documents/[id]/generation-status/route";
import { GET as documentInheritedReposGet } from "@/app/documents/[id]/inherited-additional-repos/route";
import { POST as documentRunLoopPost } from "@/app/documents/[id]/run-loop/route";
import { POST as loopCancelPost } from "@/app/loops/[id]/cancel/route";
import {
  GET as loopEventsGet,
  POST as loopEventsPost,
} from "@/app/loops/[id]/events/route";
import { POST as loopManualEventsPost } from "@/app/loops/[id]/manual-events/route";
import { POST as loopResumePost } from "@/app/loops/[id]/resume/route";
import {
  DELETE as loopByIdDelete,
  GET as loopByIdGet,
  PATCH as loopByIdPatch,
} from "@/app/loops/[id]/route";
import { GET as loopRuntimeGet } from "@/app/loops/[id]/runtime/route";
import { GET as loopStreamGet } from "@/app/loops/[id]/stream/route";
import { GET as loopsGet, POST as loopsPost } from "@/app/loops/route";
import { POST as loopSummariesPost } from "@/app/loops/summaries/route";
import { GET as loopUsageGet } from "@/app/loops/usage/route";
import { POST as planStartLoopFromLocalPost } from "@/app/plans/start-loop-from-local/route";
import {
  DELETE as orgApiKeyDelete,
  PUT as orgApiKeyPut,
} from "@/app/settings/api-keys/org/route";
import { GET as apiKeysGet } from "@/app/settings/api-keys/route";
import {
  DELETE as userApiKeyDelete,
  PUT as userApiKeyPut,
} from "@/app/settings/api-keys/user/route";
import {
  GET as computeModeGet,
  PUT as computeModePut,
} from "@/app/settings/compute-mode/route";
import {
  GET as computePreferenceGet,
  PUT as computePreferencePut,
} from "@/app/settings/compute-preference/route";

const GONE_STATUS = 410;
const ROUTE_ID = "0199a000-0000-7000-8000-000000000501";

const Wrapper = {
  AnyAuth: "withAnyAuth",
  ClerkOnly: "withAuth",
  None: "none",
} as const;
type Wrapper = (typeof Wrapper)[keyof typeof Wrapper];

type RouteHandler = (
  request: NextRequest,
  context: { params: Promise<Record<string, string>> }
) => Promise<Response> | Response;

/**
 * Every tombstone and method it kept. Each handler is a named import, so a
 * method dropped from a route fails to compile here instead of turning into a
 * 405 for an old caller.
 */
const CASES: ReadonlyArray<{
  method: string;
  path: string;
  handler: RouteHandler;
  wrapper: Wrapper;
  scopes?: readonly string[];
}> = [
  {
    method: "GET",
    path: "/loops",
    handler: loopsGet,
    wrapper: Wrapper.AnyAuth,
  },
  {
    method: "POST",
    path: "/loops",
    handler: loopsPost,
    wrapper: Wrapper.AnyAuth,
    scopes: ["write"],
  },
  {
    method: "GET",
    path: `/loops/${ROUTE_ID}`,
    handler: loopByIdGet,
    wrapper: Wrapper.AnyAuth,
  },
  {
    method: "PATCH",
    path: `/loops/${ROUTE_ID}`,
    handler: loopByIdPatch,
    wrapper: Wrapper.AnyAuth,
    scopes: ["write"],
  },
  {
    method: "DELETE",
    path: `/loops/${ROUTE_ID}`,
    handler: loopByIdDelete,
    wrapper: Wrapper.AnyAuth,
    scopes: ["delete"],
  },
  {
    method: "POST",
    path: `/loops/${ROUTE_ID}/cancel`,
    handler: loopCancelPost,
    wrapper: Wrapper.AnyAuth,
    scopes: ["write"],
  },
  {
    method: "GET",
    path: `/loops/${ROUTE_ID}/events`,
    handler: loopEventsGet,
    wrapper: Wrapper.AnyAuth,
  },
  {
    method: "POST",
    path: `/loops/${ROUTE_ID}/events`,
    handler: loopEventsPost,
    wrapper: Wrapper.None,
  },
  {
    method: "POST",
    path: `/loops/${ROUTE_ID}/manual-events`,
    handler: loopManualEventsPost,
    wrapper: Wrapper.AnyAuth,
    scopes: ["write"],
  },
  {
    method: "POST",
    path: `/loops/${ROUTE_ID}/resume`,
    handler: loopResumePost,
    wrapper: Wrapper.AnyAuth,
    scopes: ["write"],
  },
  {
    method: "GET",
    path: `/loops/${ROUTE_ID}/runtime`,
    handler: loopRuntimeGet,
    wrapper: Wrapper.AnyAuth,
  },
  {
    method: "GET",
    path: `/loops/${ROUTE_ID}/stream`,
    handler: loopStreamGet,
    wrapper: Wrapper.ClerkOnly,
  },
  {
    method: "POST",
    path: "/loops/summaries",
    handler: loopSummariesPost,
    wrapper: Wrapper.AnyAuth,
    scopes: ["read"],
  },
  {
    method: "GET",
    path: "/loops/usage",
    handler: loopUsageGet,
    wrapper: Wrapper.AnyAuth,
  },
  {
    method: "POST",
    path: `/documents/${ROUTE_ID}/run-loop`,
    handler: documentRunLoopPost,
    wrapper: Wrapper.AnyAuth,
  },
  {
    method: "GET",
    path: `/documents/${ROUTE_ID}/inherited-additional-repos`,
    handler: documentInheritedReposGet,
    wrapper: Wrapper.AnyAuth,
  },
  {
    method: "GET",
    path: `/documents/${ROUTE_ID}/generation-status`,
    handler: documentGenerationStatusGet,
    wrapper: Wrapper.AnyAuth,
  },
  {
    method: "POST",
    path: "/plans/start-loop-from-local",
    handler: planStartLoopFromLocalPost,
    wrapper: Wrapper.AnyAuth,
    scopes: ["write"],
  },
  {
    method: "POST",
    path: "/catalog/bootstrap/start",
    handler: catalogBootstrapStartPost,
    wrapper: Wrapper.AnyAuth,
  },
  {
    method: "GET",
    path: "/settings/compute-preference",
    handler: computePreferenceGet,
    wrapper: Wrapper.AnyAuth,
  },
  {
    method: "PUT",
    path: "/settings/compute-preference",
    handler: computePreferencePut,
    wrapper: Wrapper.AnyAuth,
  },
  {
    method: "GET",
    path: "/settings/compute-mode",
    handler: computeModeGet,
    wrapper: Wrapper.AnyAuth,
  },
  {
    method: "PUT",
    path: "/settings/compute-mode",
    handler: computeModePut,
    wrapper: Wrapper.ClerkOnly,
  },
  {
    method: "GET",
    path: "/settings/api-keys",
    handler: apiKeysGet,
    wrapper: Wrapper.AnyAuth,
  },
  {
    method: "PUT",
    path: "/settings/api-keys/org",
    handler: orgApiKeyPut,
    wrapper: Wrapper.ClerkOnly,
  },
  {
    method: "DELETE",
    path: "/settings/api-keys/org",
    handler: orgApiKeyDelete,
    wrapper: Wrapper.ClerkOnly,
  },
  {
    method: "PUT",
    path: "/settings/api-keys/user",
    handler: userApiKeyPut,
    wrapper: Wrapper.ClerkOnly,
  },
  {
    method: "DELETE",
    path: "/settings/api-keys/user",
    handler: userApiKeyDelete,
    wrapper: Wrapper.ClerkOnly,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("retired Loops endpoints (ISS-12435)", () => {
  it.each(CASES)(
    "answers $method $path with a 410 carrying the removal code",
    async ({ path, method, handler }) => {
      const response = await handler(
        new NextRequest(`http://localhost${path}`, { method }),
        { params: Promise.resolve({ id: ROUTE_ID }) }
      );

      expect(response.status).toBe(GONE_STATUS);
      expect(await response.json()).toMatchObject({
        success: false,
        error: LoopsEndpointRemoval.Message,
        code: LoopsEndpointRemoval.Code,
      });
    }
  );

  // Each tombstone keeps the wrapper and scopes the live route had, so a
  // caller without credentials still gets the 401 it got before (PLN-2182 v3).
  it.each(CASES)(
    "keeps the $wrapper wrapper on $method $path",
    ({ handler, wrapper, scopes }) => {
      expect(Reflect.get(handler, "wrappedBy") ?? Wrapper.None).toBe(wrapper);
      expect(Reflect.get(handler, "requiredScopes")).toEqual(scopes);
    }
  );
});
