/**
 * ISS-8661 — the distributions gates tell an UNRESOLVED role apart from a
 * REFUSED one, at the service AND on the wire.
 *
 * The gate for `create`/`update`/`withdraw` lives in the service and travels as
 * a `Result<_, StatusCode>`, so it needs BOTH halves pinned: the service must
 * choose `Status.ServiceUnavailable` over `Status.Forbidden`, and the route must
 * turn that into a 503 rather than letting it fall through to the generic 500.
 * Neither half is provable from the other — the service test alone stays green
 * with the route's `ServiceUnavailable` branch deleted.
 *
 * Every case is paired with its `not_admin` sibling, so a gate that answered 503
 * for every refusal would fail rather than pass.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** `Distribution.id` is `@db.Uuid`, so the route refuses a non-uuid segment. */
const DIST_ID = "0199a000-0000-7000-8000-000000000301";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  getOrgAdminStatus: vi.fn(),
  create: vi.fn(),
  withdraw: vi.fn(),
  computeTargetsService: { findOwnedById: vi.fn() },
  getCatalogAssetDownloadUrl: vi.fn(),
  awsKeys: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings: Array.from(strings),
      values,
    }),
  },
}));

vi.mock("@repo/aws/catalog-assets", () => ({
  getCatalogAssetDownloadUrl: mocks.getCatalogAssetDownloadUrl,
}));

vi.mock("@repo/aws/keys", () => ({ keys: mocks.awsKeys }));

vi.mock("@/lib/auth/org-admin", () => ({
  getOrgAdminStatus: mocks.getOrgAdminStatus,
}));

vi.mock("@/app/compute-targets/service", () => ({
  computeTargetsService: mocks.computeTargetsService,
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: unknown, context?: { params: Promise<unknown> }) =>
      handler(
        {
          user: { id: "user-1", organizationId: "org-1" },
          clerkOrgId: "clerk-org-1",
          clerkUserId: "clerk-user-1",
        },
        request,
        context?.params ?? Promise.resolve({})
      ),
}));

import {
  DistributionMode,
  DistributionTargetingType,
} from "@repo/api/src/types/distribution";
import { Status } from "@repo/api/src/types/result";
import {
  ORG_ADMIN_STATUS_NOT_ADMIN,
  ORG_ADMIN_STATUS_PROVIDER_ERROR,
} from "@/__tests__/support/auth/org-admin-gate.test-fixtures";
import { createMockRequest } from "@/__tests__/utils/auth-helpers";
import { OrgAdminGateErrorCode } from "@/lib/auth/org-admin-denial";
import { distributionsService } from "../service";

const CREATE_BODY = {
  catalogItemId: "019f0fcb-8336-7c4d-9f64-528fb9520c32",
  mode: DistributionMode.AutoInstall,
  targetingType: DistributionTargetingType.All,
};

function createArgs() {
  return [
    "org-1",
    "user-1",
    "clerk-org-1",
    "clerk-user-1",
    CREATE_BODY,
  ] as const;
}

describe("distributionsService — unresolved role is not a denial", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.awsKeys.mockReturnValue({ PLUGIN_STORE_BUCKET: "test-bucket" });
    mocks.withDb.mockResolvedValue(null);
  });

  it("errs with ServiceUnavailable, not Forbidden, when the role is unresolved", async () => {
    mocks.getOrgAdminStatus.mockResolvedValue(ORG_ADMIN_STATUS_PROVIDER_ERROR);

    const result = await distributionsService.create(...createArgs());

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe(Status.ServiceUnavailable);
    expect(result.ok === false && result.error).not.toBe(Status.Forbidden);
  });

  it("still errs with Forbidden for a resolved non-admin", async () => {
    mocks.getOrgAdminStatus.mockResolvedValue(ORG_ADMIN_STATUS_NOT_ADMIN);

    const result = await distributionsService.create(...createArgs());

    expect(result.ok === false && result.error).toBe(Status.Forbidden);
  });

  it("errs with ServiceUnavailable on withdraw when the role is unresolved", async () => {
    mocks.getOrgAdminStatus.mockResolvedValue(ORG_ADMIN_STATUS_PROVIDER_ERROR);

    const result = await distributionsService.withdraw(
      "org-1",
      DIST_ID,
      "user-1",
      "clerk-org-1",
      "clerk-user-1"
    );

    expect(result.ok === false && result.error).toBe(Status.ServiceUnavailable);
  });
});

describe("distributions routes — unresolved role reaches the wire as 503", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.awsKeys.mockReturnValue({ PLUGIN_STORE_BUCKET: "test-bucket" });
    mocks.withDb.mockResolvedValue(null);
  });

  it("answers 503 role_unresolved on POST /distributions", async () => {
    mocks.getOrgAdminStatus.mockResolvedValue(ORG_ADMIN_STATUS_PROVIDER_ERROR);
    const { POST } = await import("../route");

    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "https://api.example.test/distributions",
        body: CREATE_BODY,
      }),
      { params: Promise.resolve({}) }
    );

    // Without the route's `ServiceUnavailable` branch this falls through to the
    // generic handler and answers 500, so the status IS the assertion.
    expect(response.status).toBe(503);
    expect(response.status).not.toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      code: OrgAdminGateErrorCode.RoleUnresolved,
    });
  });

  it("keeps 403 on POST /distributions for a resolved non-admin", async () => {
    mocks.getOrgAdminStatus.mockResolvedValue(ORG_ADMIN_STATUS_NOT_ADMIN);
    const { POST } = await import("../route");

    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "https://api.example.test/distributions",
        body: CREATE_BODY,
      }),
      { params: Promise.resolve({}) }
    );

    expect(response.status).toBe(403);
  });

  it("answers 503 role_unresolved on DELETE /distributions/[id]", async () => {
    mocks.getOrgAdminStatus.mockResolvedValue(ORG_ADMIN_STATUS_PROVIDER_ERROR);
    const { DELETE } = await import("../[id]/route");

    const response = await DELETE(
      createMockRequest({
        method: "DELETE",
        url: "https://api.example.test/distributions/dist-1",
      }),
      { params: Promise.resolve({ id: DIST_ID }) }
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: OrgAdminGateErrorCode.RoleUnresolved,
    });
  });

  it("keeps 403 on DELETE /distributions/[id] for a resolved non-admin", async () => {
    mocks.getOrgAdminStatus.mockResolvedValue(ORG_ADMIN_STATUS_NOT_ADMIN);
    const { DELETE } = await import("../[id]/route");

    const response = await DELETE(
      createMockRequest({
        method: "DELETE",
        url: "https://api.example.test/distributions/dist-1",
      }),
      { params: Promise.resolve({ id: DIST_ID }) }
    );

    expect(response.status).toBe(403);
  });
});
