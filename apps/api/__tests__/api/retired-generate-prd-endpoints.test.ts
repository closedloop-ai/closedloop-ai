/**
 * ISS-8943 version skew: `/ai/prd` and `/documents/:id/generate-prd-from-doc`
 * are permanently retired, but a browser tab on a pre-ISS-8943 bundle and an
 * `sk_live_*` integration both still POST to them. `apps/api/AGENTS.md` calls
 * for a 410 through `goneResponse` so those callers get a non-retryable
 * deprecation signal instead of a generic, retryable-looking 404.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks (must come before imports) ---

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => unknown) =>
    (request: unknown, context: { params?: unknown }) =>
      handler(
        { id: "user-1", organizationId: "org-1" },
        request,
        context?.params
      ),
}));

// --- Imports (after mocks) ---

import { GeneratePrdEndpointRemoval } from "@repo/api/src/types/endpoint-removal";
import { NextRequest } from "next/server";
import { POST as aiPrd } from "@/app/ai/prd/route";
import { POST as generatePrdFromDoc } from "@/app/documents/[id]/generate-prd-from-doc/route";

const GONE_STATUS = 410;

beforeEach(() => {
  vi.clearAllMocks();
});

function postTo(url: string): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [] }),
  });
}

describe("retired GENERATE_PRD endpoints", () => {
  it("answers POST /ai/prd with a 410 carrying the removal code", async () => {
    const response = await aiPrd(postTo("http://localhost/ai/prd"));

    expect(response.status).toBe(GONE_STATUS);
    expect(await response.json()).toMatchObject({
      success: false,
      error: GeneratePrdEndpointRemoval.Message,
      code: GeneratePrdEndpointRemoval.Code,
    });
  });

  it("answers POST /documents/:id/generate-prd-from-doc with the same 410", async () => {
    const response = await generatePrdFromDoc(
      postTo("http://localhost/documents/doc-1/generate-prd-from-doc"),
      { params: Promise.resolve({ id: "doc-1" }) }
    );

    expect(response.status).toBe(GONE_STATUS);
    expect(await response.json()).toMatchObject({
      success: false,
      error: GeneratePrdEndpointRemoval.Message,
      code: GeneratePrdEndpointRemoval.Code,
    });
  });
});
