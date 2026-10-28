import { RoutinesEndpointRemoval } from "@repo/api/src/types/endpoint-removal";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (ctx: unknown, request: NextRequest) => Promise<Response>) =>
    (request: NextRequest) =>
      handler({ user: { id: "user-1", organizationId: "org-1" } }, request),
}));

import { POST } from "./route";

const COMPUTE_TARGET_ID = "9f1c2b3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d";

// Shaped like the protocol-1 envelope installed pre-PRD-797 Desktop builds
// send (`{ protocolVersion, item: { sourceId, routine, runs } }`).
const LEGACY_DESKTOP_PAYLOAD = {
  protocolVersion: 1,
  item: {
    sourceId: "nightly-review",
    routine: { name: "Nightly review" },
    runs: [],
  },
};

function callPost(): Promise<Response> {
  const request = new NextRequest(
    `https://api.test/desktop/routines/sync?computeTargetId=${COMPUTE_TARGET_ID}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(LEGACY_DESKTOP_PAYLOAD),
    }
  );
  return POST(request, { params: Promise.resolve({}) });
}

describe("POST /desktop/routines/sync (retired, PRD-797 FR-6)", () => {
  it("answers a legacy Desktop payload with a terminal 400 and the removal code", async () => {
    const response = await callPost();

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toEqual({
      success: false,
      error: RoutinesEndpointRemoval.Message,
      code: RoutinesEndpointRemoval.Code,
    });
  });
});
