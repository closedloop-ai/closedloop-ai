/**
 * Route tests for POST /catalog/[id]/import-zip (ISS-6691).
 *
 * This route parses attacker-supplied archives and had no route test — only a
 * `maxDuration` constant assertion. The reject branches all fail `res.ok`, so
 * these pin the exact numeric status per service error (403 is the
 * fall-through, so an unmapped error silently reads as Forbidden), and pin the
 * `invalid` count surviving the success envelope (FEA-3263 shipped that
 * surfacing).
 */
import { Result } from "@repo/api/src/types/result";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "user-1", organizationId: "org-1" },
  requireOrgAdmin: vi.fn(),
  importPackZipComponents: vi.fn(),
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

vi.mock("../../service", () => ({
  importPackZipComponents: mocks.importPackZipComponents,
}));

import {
  ORG_ADMIN_ADMITTED,
  orgAdminRefused,
} from "@/__tests__/support/auth/org-admin-gate.test-fixtures";
import { POST } from "./route";

const PACK_ID = "33333333-3333-4333-8333-333333333333";

function invoke() {
  return POST(
    new NextRequest(`https://api.example.test/catalog/${PACK_ID}/import-zip`, {
      method: "POST",
    }),
    { params: Promise.resolve({ id: PACK_ID }) }
  );
}

describe("POST /catalog/[id]/import-zip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireOrgAdmin.mockResolvedValue(ORG_ADMIN_ADMITTED);
  });

  it("returns the import counts, preserving a non-zero invalid count", async () => {
    mocks.importPackZipComponents.mockResolvedValue(
      Result.ok({ created: 4, skipped: 1, invalid: 2 })
    );

    const response = await invoke();

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    // `invalid` is the only signal that entries were rejected; dropping or
    // zeroing it makes a partial import read as a clean one.
    expect(json.data).toEqual({ created: 4, skipped: 1, invalid: 2 });
    expect(mocks.importPackZipComponents).toHaveBeenCalledWith(
      expect.objectContaining({
        id: PACK_ID,
        organizationId: "org-1",
        userId: "user-1",
      }),
      undefined
    );
  });

  it("returns 403 for a non-admin caller without parsing the archive", async () => {
    mocks.requireOrgAdmin.mockImplementation(orgAdminRefused);

    const response = await invoke();

    expect(response.status).toBe(403);
    // The zip parser must never run for a caller who failed the gate.
    expect(mocks.importPackZipComponents).not.toHaveBeenCalled();
  });

  it.each([
    {
      serviceError: 413 as const,
      status: 413,
      message: "Pack zip exceeds the decompressed-size or entry-count limit",
    },
    {
      serviceError: 400 as const,
      status: 400,
      message: "No zip uploaded for this Pack",
    },
    { serviceError: 404 as const, status: 404, message: "Pack not found" },
    { serviceError: 403 as const, status: 403, message: "Forbidden" },
  ])(
    "maps service error $serviceError to HTTP $status",
    async ({ serviceError, status, message }) => {
      mocks.importPackZipComponents.mockResolvedValue(Result.err(serviceError));

      const response = await invoke();

      expect(response.status).toBe(status);
      const json = await response.json();
      expect(json.success).toBe(false);
      expect(json.error).toBe(message);
    }
  );

  it("returns 500 when the zip import throws", async () => {
    mocks.importPackZipComponents.mockRejectedValue(new Error("unzip failed"));

    const response = await invoke();

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.error).toBe("Failed to import Pack zip");
  });
});
