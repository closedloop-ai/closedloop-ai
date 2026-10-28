import type { OrganizationMembershipJSON } from "@repo/auth/server";
import { log } from "@repo/observability/log";
import { InternalCallFailure } from "@repo/realtime-server/internal-call";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as RevokeModule from "@/app/doc-sync/internal/revoke";
import {
  DOC_SYNC_REVOKE_FAILED_EVENT,
  revokeDocSyncAccess,
} from "@/app/doc-sync/internal/revoke";
import { organizationsService } from "@/app/organizations/service";
import { usersService } from "@/app/users/service";
import {
  handleOrganizationDeleted,
  handleOrganizationMembershipDeleted,
  handleUserDeleted,
} from "@/app/webhooks/auth/auth-hooks";

const { clientRevoke } = vi.hoisted(() => ({ clientRevoke: vi.fn() }));

vi.mock("@repo/analytics/server", () => ({
  analytics: { identify: vi.fn(), capture: vi.fn(), groupIdentify: vi.fn() },
}));

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("@/app/doc-sync/internal/revoke", async (importActual) => ({
  ...(await importActual<typeof RevokeModule>()),
  revokeDocSyncAccess: vi.fn(),
}));

vi.mock("@/app/doc-sync/internal/internal-client", () => ({
  docSyncInternalClient: () => ({ revoke: clientRevoke }),
}));

vi.mock("@/app/organizations/service", () => ({
  organizationsService: {
    findByClerkId: vi.fn(),
    deactivateByClerkId: vi.fn(),
  },
}));

vi.mock("@/app/users/service", () => ({
  usersService: {
    deactivateAllByClerkId: vi.fn(),
    deactivateByClerkIdAndOrg: vi.fn(),
  },
}));

const ORG_ROW_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const USER_ROW_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";
const OTHER_USER_ROW_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(revokeDocSyncAccess).mockResolvedValue(undefined);
  vi.mocked(organizationsService.findByClerkId).mockResolvedValue({
    id: ORG_ROW_ID,
  } as never);
  vi.mocked(usersService.deactivateByClerkIdAndOrg).mockResolvedValue({
    id: USER_ROW_ID,
  } as never);
});

describe("organizationMembership.deleted", () => {
  it("revokes the deactivated member's row", async () => {
    const response = await handleOrganizationMembershipDeleted(membership());

    expect(response.status).toBe(204);
    expect(usersService.deactivateByClerkIdAndOrg).toHaveBeenCalledWith(
      "user_clerk",
      ORG_ROW_ID
    );
    expect(vi.mocked(revokeDocSyncAccess).mock.calls).toEqual([
      [{ userId: USER_ROW_ID }],
    ]);
  });

  it("revokes nothing when the member has no row (P2025)", async () => {
    vi.mocked(usersService.deactivateByClerkIdAndOrg).mockRejectedValue(
      Object.assign(new Error("not found"), { code: "P2025" })
    );

    const response = await handleOrganizationMembershipDeleted(membership());

    expect(response.status).toBe(204);
    expect(revokeDocSyncAccess).not.toHaveBeenCalled();
  });

  it("still answers 204 when doc-sync refuses the revoke, which is logged", async () => {
    const actual = await vi.importActual<typeof RevokeModule>(
      "@/app/doc-sync/internal/revoke"
    );
    vi.mocked(revokeDocSyncAccess).mockImplementation(
      actual.revokeDocSyncAccess
    );
    clientRevoke.mockResolvedValue({
      ok: false,
      failure: InternalCallFailure.Rejected,
      status: 503,
    });

    const response = await handleOrganizationMembershipDeleted(membership());

    expect(response.status).toBe(204);
    expect(clientRevoke).toHaveBeenCalledWith({ userId: USER_ROW_ID });
    expect(log.error).toHaveBeenCalledWith(
      "Doc sync revoke failed",
      expect.objectContaining({ event: DOC_SYNC_REVOKE_FAILED_EVENT })
    );
  });
});

describe("user.deleted", () => {
  it("revokes every deactivated row, one per organization", async () => {
    vi.mocked(usersService.deactivateAllByClerkId).mockResolvedValue([
      { id: USER_ROW_ID },
      { id: OTHER_USER_ROW_ID },
    ]);

    const response = await handleUserDeleted({
      object: "user",
      id: "user_clerk",
      deleted: true,
    });

    expect(response.status).toBe(204);
    expect(vi.mocked(revokeDocSyncAccess).mock.calls).toEqual([
      [{ userId: USER_ROW_ID }],
      [{ userId: OTHER_USER_ROW_ID }],
    ]);
  });
});

describe("organization.deleted", () => {
  it("revokes the deactivated organization", async () => {
    vi.mocked(organizationsService.deactivateByClerkId).mockResolvedValue({
      id: ORG_ROW_ID,
    } as never);

    const response = await handleOrganizationDeleted({
      object: "organization",
      id: "org_clerk",
      deleted: true,
    });

    expect(response.status).toBe(204);
    expect(vi.mocked(revokeDocSyncAccess).mock.calls).toEqual([
      [{ orgId: ORG_ROW_ID }],
    ]);
  });

  it("revokes nothing when no organization was deactivated", async () => {
    vi.mocked(organizationsService.deactivateByClerkId).mockResolvedValue(null);

    const response = await handleOrganizationDeleted({
      object: "organization",
      id: "org_clerk",
      deleted: true,
    });

    expect(response.status).toBe(204);
    expect(revokeDocSyncAccess).not.toHaveBeenCalled();
  });
});

function membership(): OrganizationMembershipJSON {
  return {
    object: "organization_membership",
    id: "orgmem_clerk",
    role: "org:member",
    permissions: [],
    public_metadata: {},
    created_at: 0,
    updated_at: 0,
    organization: {
      object: "organization",
      id: "org_clerk",
      name: "Org",
      slug: "org",
      image_url: "",
      has_image: false,
      created_at: 0,
      updated_at: 0,
      public_metadata: {},
      private_metadata: {},
      max_allowed_memberships: 100,
      admin_delete_enabled: false,
      members_count: 1,
    },
    public_user_data: {
      user_id: "user_clerk",
      identifier: "member@example.com",
      first_name: "Member",
      last_name: "One",
      image_url: "",
      has_image: false,
    },
  };
}
