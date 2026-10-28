/**
 * Route tests for POST /catalog/upload-intent (ISS-6689).
 *
 * The service already proves it *returns* 413/415/404/403; nothing proved the
 * route turns each of those into the matching HTTP status. 413 is the route's
 * fall-through branch, so every unmapped service error silently becomes a 413 —
 * these assert the exact numeric status and the discriminating message per
 * input, not merely that "a 4xx came back".
 */
import { Result } from "@repo/api/src/types/result";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "user-1", organizationId: "org-1" },
  requireOrgAdmin: vi.fn(),
  getUploadIntent: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, context: { params: Promise<unknown> }) =>
      handler(
        {
          user: mocks.user,
          clerkOrgId: "clerk-org-1",
          clerkUserId: "clerk-user-1",
        },
        request,
        context.params
      ),
}));

vi.mock("@/lib/auth/org-admin", () => ({
  requireOrgAdmin: mocks.requireOrgAdmin,
}));

vi.mock("../service", () => ({
  getUploadIntent: mocks.getUploadIntent,
}));

import {
  ORG_ADMIN_ADMITTED,
  orgAdminRefused,
} from "@/__tests__/support/auth/org-admin-gate.test-fixtures";
import { POST } from "./route";

const CATALOG_ITEM_ID = "11111111-1111-4111-8111-111111111111";

const validBody = {
  catalogItemId: CATALOG_ITEM_ID,
  fileType: "zip",
  contentType: "application/zip",
  fileSizeBytes: 1024,
};

function invoke(body: unknown) {
  return POST(
    new NextRequest("https://api.example.test/catalog/upload-intent", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) }
  );
}

describe("POST /catalog/upload-intent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireOrgAdmin.mockResolvedValue(ORG_ADMIN_ADMITTED);
  });

  it("returns the presigned URL and key for an admin caller", async () => {
    mocks.getUploadIntent.mockResolvedValue(
      Result.ok({ presignedUrl: "https://s3.example.test/put", s3Key: "k/1" })
    );

    const response = await invoke(validBody);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual({
      presignedUrl: "https://s3.example.test/put",
      s3Key: "k/1",
    });
    expect(mocks.getUploadIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        catalogItemId: CATALOG_ITEM_ID,
        fileType: "zip",
        contentType: "application/zip",
        fileSizeBytes: 1024,
      })
    );
  });

  it("returns 403 for a non-admin caller without minting an upload URL", async () => {
    mocks.requireOrgAdmin.mockImplementation(orgAdminRefused);

    const response = await invoke(validBody);

    expect(response.status).toBe(403);
    const json = await response.json();
    expect(json.success).toBe(false);
    // The gate must short-circuit: a presigned PUT must never be minted for a
    // caller who failed it.
    expect(mocks.getUploadIntent).not.toHaveBeenCalled();
  });

  it("returns 400 for a malformed body before reaching the service", async () => {
    const response = await invoke({ ...validBody, fileSizeBytes: 0 });

    expect(response.status).toBe(400);
    expect(mocks.getUploadIntent).not.toHaveBeenCalled();
  });

  it.each([
    {
      serviceError: 413 as const,
      status: 413,
      message: "File size exceeds the allowed limit",
    },
    {
      serviceError: 415 as const,
      status: 415,
      message: "Unsupported content type for this file type",
    },
    {
      serviceError: 404 as const,
      status: 404,
      message: "Catalog item not found",
    },
    { serviceError: 403 as const, status: 403, message: "Forbidden" },
  ])(
    "maps service error $serviceError to HTTP $status",
    async ({ serviceError, status, message }) => {
      mocks.getUploadIntent.mockResolvedValue(Result.err(serviceError));

      const response = await invoke(validBody);

      expect(response.status).toBe(status);
      const json = await response.json();
      expect(json.success).toBe(false);
      expect(json.error).toBe(message);
    }
  );

  it("returns 500 when the service throws", async () => {
    mocks.getUploadIntent.mockRejectedValue(new Error("s3 down"));

    const response = await invoke(validBody);

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.error).toBe("Failed to generate upload URL");
  });
});
