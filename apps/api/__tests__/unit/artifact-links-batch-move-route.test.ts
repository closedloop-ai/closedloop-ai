/**
 * Route dispatch tests for POST /artifact-links/batch-move.
 *
 * Why this file exists
 * --------------------
 * The service returns a `Result<value, StatusCode>` that the route must
 * translate into HTTP status codes:
 *   - ok                        → 200
 *   - err(Status.NotFound)      → 404 (source artifact missing)
 *   - err(Status.BadRequest)    → 400 (target project missing)
 *   - any other err             → 400 (generic fallback)
 *
 * Before PR #920 addressed the finding, every error collapsed into 400,
 * which silently hid "artifact not found" behind a "bad request" response.
 * This test pins the mapping at the route layer so a regression is caught
 * without needing an integration test.
 */

import { Status } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  Prisma: { JsonNull: "DbNull" },
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (handler: any) => (request: any, context: any) =>
    handler(
      { user: { id: "user-1", organizationId: "org-1" } },
      request,
      context.params
    ),
}));

vi.mock("@/app/artifact-links/service", () => ({
  artifactLinksService: {
    batchMoveArtifacts: vi.fn(),
  },
}));

import { POST } from "@/app/artifact-links/batch-move/route";
import { artifactLinksService } from "@/app/artifact-links/service";
import {
  createMockRequest,
  createMockRouteContext,
} from "../utils/auth-helpers";

// Valid v4 UUIDs (z.uuid() enforces RFC 4122 version/variant bits).
const ARTIFACT_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_PROJECT_ID = "22222222-2222-4222-8222-222222222222";

function makeRequest(body: unknown) {
  return createMockRequest({
    url: "http://localhost:3002/artifact-links/batch-move",
    method: "POST",
    body,
  });
}

const VALID_BODY = {
  artifactId: ARTIFACT_ID,
  targetProjectId: TARGET_PROJECT_ID,
  includeDownstream: false,
};

describe("POST /artifact-links/batch-move — status code mapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 with service value on ok result", async () => {
    const value = {
      movedArtifacts: [{ id: ARTIFACT_ID, type: "DOCUMENT" as const }],
    };
    vi.mocked(artifactLinksService.batchMoveArtifacts).mockResolvedValue({
      ok: true,
      value,
    });

    const response = await POST(
      makeRequest(VALID_BODY),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual(value);
  });

  it("returns 404 when the service reports Status.NotFound (source artifact missing)", async () => {
    vi.mocked(artifactLinksService.batchMoveArtifacts).mockResolvedValue({
      ok: false,
      error: Status.NotFound,
    });

    const response = await POST(
      makeRequest(VALID_BODY),
      createMockRouteContext({})
    );

    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json.success).toBe(false);
  });

  it("returns 400 when the service reports Status.BadRequest (target project missing)", async () => {
    vi.mocked(artifactLinksService.batchMoveArtifacts).mockResolvedValue({
      ok: false,
      error: Status.BadRequest,
    });

    const response = await POST(
      makeRequest(VALID_BODY),
      createMockRouteContext({})
    );

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.success).toBe(false);
  });

  it("returns 400 on any other failure status (generic fallback)", async () => {
    vi.mocked(artifactLinksService.batchMoveArtifacts).mockResolvedValue({
      ok: false,
      error: Status.Error,
    });

    const response = await POST(
      makeRequest(VALID_BODY),
      createMockRouteContext({})
    );

    expect(response.status).toBe(400);
  });

  it("returns 400 when the request body fails validation", async () => {
    const response = await POST(
      makeRequest({ artifactId: "not-a-uuid" }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(400);
    expect(artifactLinksService.batchMoveArtifacts).not.toHaveBeenCalled();
  });
});
