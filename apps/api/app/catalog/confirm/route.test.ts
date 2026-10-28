/**
 * Route tests for POST /catalog/confirm (ISS-6690).
 *
 * The route is where the service's `asset_not_found` becomes a 400 rather than
 * a 404 — that distinction exists nowhere else — and where 404/403 stay
 * distinct. These pin the exact numeric status and message per service return,
 * so a mis-mapping (e.g. collapsing `asset_not_found` into the 404 branch)
 * fails.
 */
import { Result } from "@repo/api/src/types/result";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CatalogAssetError, type ConfirmUploadError } from "../asset-errors";

const mocks = vi.hoisted(() => ({
  user: { id: "user-1", organizationId: "org-1" },
  requireOrgAdmin: vi.fn(),
  confirmAssetUpload: vi.fn(),
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
  confirmAssetUpload: mocks.confirmAssetUpload,
}));

import {
  ORG_ADMIN_ADMITTED,
  orgAdminRefused,
} from "@/__tests__/support/auth/org-admin-gate.test-fixtures";
import { POST } from "./route";

const CATALOG_ITEM_ID = "22222222-2222-4222-8222-222222222222";

const validBody = {
  catalogItemId: CATALOG_ITEM_ID,
  fileType: "zip",
  s3Key: "orgs/org-1/catalog/22222222-2222-4222-8222-222222222222/pack.zip",
};

function invoke(body: unknown) {
  return POST(
    new NextRequest("https://api.example.test/catalog/confirm", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) }
  );
}

// Typed against the service's own error union, so renaming or dropping a
// discriminant fails to compile here rather than sliding through the route's
// catch-all 400 branch with an obsolete literal.
const serviceErrorCases: {
  serviceError: ConfirmUploadError;
  status: number;
  message: string;
}[] = [
  {
    serviceError: CatalogAssetError.AssetNotFound,
    status: 400,
    message: "Asset not found in S3. Upload the file before confirming.",
  },
  {
    serviceError: 404,
    status: 404,
    message: "Catalog item not found",
  },
  { serviceError: 403, status: 403, message: "Forbidden" },
];

describe("POST /catalog/confirm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireOrgAdmin.mockResolvedValue(ORG_ADMIN_ADMITTED);
  });

  it("returns the updated item with the asset key for an admin caller", async () => {
    mocks.confirmAssetUpload.mockResolvedValue(
      Result.ok({ id: CATALOG_ITEM_ID, zipAssetKey: validBody.s3Key })
    );

    const response = await invoke(validBody);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data.zipAssetKey).toBe(validBody.s3Key);
    expect(mocks.confirmAssetUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        catalogItemId: CATALOG_ITEM_ID,
        fileType: "zip",
        s3Key: validBody.s3Key,
      }),
      undefined
    );
  });

  it("returns 403 for a non-admin caller without recording the asset", async () => {
    mocks.requireOrgAdmin.mockImplementation(orgAdminRefused);

    const response = await invoke(validBody);

    expect(response.status).toBe(403);
    expect(mocks.confirmAssetUpload).not.toHaveBeenCalled();
  });

  it("returns 400 for a malformed body before reaching the service", async () => {
    const response = await invoke({ ...validBody, s3Key: "" });

    expect(response.status).toBe(400);
    expect(mocks.confirmAssetUpload).not.toHaveBeenCalled();
  });

  it.each(serviceErrorCases)(
    "maps service error $serviceError to HTTP $status",
    async ({ serviceError, status, message }) => {
      mocks.confirmAssetUpload.mockResolvedValue(Result.err(serviceError));

      const response = await invoke(validBody);

      expect(response.status).toBe(status);
      const json = await response.json();
      expect(json.success).toBe(false);
      expect(json.error).toBe(message);
    }
  );

  it("returns 500 when the service throws", async () => {
    mocks.confirmAssetUpload.mockRejectedValue(new Error("head object failed"));

    const response = await invoke(validBody);

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.error).toBe("Failed to confirm asset upload");
  });
});
