/**
 * ISS-12617 version skew: compute-target sharing is retired, but a web tab
 * opened before the deploy, or an `sk_live_*` integration, can still PATCH
 * `/compute-targets/:id/sharing`. The route answers 410 through `goneResponse`
 * (`apps/api/AGENTS.md`) and writes nothing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const AUTH_CONTEXT = { user: { id: "user-1", organizationId: "org-1" } };

const mocks = vi.hoisted(() => ({ withDb: vi.fn() }));

vi.mock("@repo/database", () => ({ withDb: mocks.withDb }));

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

import { ComputeTargetSharingEndpointRemoval } from "@repo/api/src/types/endpoint-removal";
import { NextRequest } from "next/server";
import { PATCH } from "@/app/compute-targets/[id]/sharing/route";

const TARGET_ID = "0199a000-0000-7000-8000-000000000601";
const GONE_STATUS = 410;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PATCH /compute-targets/:id/sharing tombstone (ISS-12617)", () => {
  it.each([true, false])(
    "answers isSharedWithOrg=%s with a 410 carrying the removal code and writes nothing",
    async (isSharedWithOrg) => {
      const response = await PATCH(
        new NextRequest(
          `http://localhost/compute-targets/${TARGET_ID}/sharing`,
          {
            method: "PATCH",
            body: JSON.stringify({ isSharedWithOrg }),
            headers: { "content-type": "application/json" },
          }
        ),
        { params: Promise.resolve({ id: TARGET_ID }) }
      );

      expect(response.status).toBe(GONE_STATUS);
      expect(await response.json()).toMatchObject({
        success: false,
        error: ComputeTargetSharingEndpointRemoval.Message,
        code: ComputeTargetSharingEndpointRemoval.Code,
      });
      expect(mocks.withDb).not.toHaveBeenCalled();
    }
  );

  // The live route was `withAnyAuth` with no scope list, so a caller without
  // credentials still gets the 401 it got before.
  it("keeps the withAnyAuth wrapper and its scopes", () => {
    expect(Reflect.get(PATCH, "wrappedBy")).toBe("withAnyAuth");
    expect(Reflect.get(PATCH, "requiredScopes")).toBeUndefined();
  });
});
