import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getOrganizationMembershipList: vi.fn(),
  getOrganizationInvitationList: vi.fn(),
  updateOrganization: vi.fn(),
  getOrganizationInvitation: vi.fn(),
}));

vi.mock("@repo/auth/server", () => ({
  clerkClient: vi.fn(async () => ({
    organizations: {
      getOrganizationMembershipList: mocks.getOrganizationMembershipList,
      getOrganizationInvitationList: mocks.getOrganizationInvitationList,
      updateOrganization: mocks.updateOrganization,
      getOrganizationInvitation: mocks.getOrganizationInvitation,
    },
  })),
}));

import { ClerkInvitationStatus, clerkService } from "../clerk-service";

const CLERK_ORG_ID = "org_clerk_1";
const CREATED_MS = 1_788_460_403_425;
const UPDATED_MS = 1_788_470_403_425;
const EXPIRES_MS = 1_789_065_203_425;

function membershipRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "orgmem_1",
    role: "org:admin",
    createdAt: CREATED_MS,
    updatedAt: UPDATED_MS,
    publicUserData: {
      userId: "user_1",
      identifier: "member@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
      imageUrl: "https://img.clerk.com/ada",
    },
    ...overrides,
  };
}

function invitationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "orginv_1",
    emailAddress: "invitee@example.com",
    role: "org:member",
    status: ClerkInvitationStatus.Pending,
    createdAt: CREATED_MS,
    updatedAt: UPDATED_MS,
    expiresAt: EXPIRES_MS,
    ...overrides,
  };
}

describe("clerkService organization membership reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("asks the provider for the given organization and page bounds", async () => {
    mocks.getOrganizationMembershipList.mockResolvedValue({
      data: [],
      totalCount: 0,
    });

    await clerkService.listOrganizationMemberships({
      organizationId: CLERK_ORG_ID,
      limit: 25,
      offset: 50,
    });

    expect(mocks.getOrganizationMembershipList).toHaveBeenCalledWith({
      organizationId: CLERK_ORG_ID,
      limit: 25,
      offset: 50,
    });
  });

  it("flattens identity off publicUserData and keeps the provider's epoch units", async () => {
    mocks.getOrganizationMembershipList.mockResolvedValue({
      data: [membershipRow()],
      totalCount: 1,
    });

    const page = await clerkService.listOrganizationMemberships({
      organizationId: CLERK_ORG_ID,
      limit: 25,
      offset: 0,
    });

    expect(page).toEqual({
      data: [
        {
          id: "orgmem_1",
          userId: "user_1",
          role: "org:admin",
          identifier: "member@example.com",
          firstName: "Ada",
          lastName: "Lovelace",
          imageUrl: "https://img.clerk.com/ada",
          createdAt: CREATED_MS,
          updatedAt: UPDATED_MS,
        },
      ],
      totalCount: 1,
    });
  });

  it("yields nulls — including userId — when the provider withholds publicUserData", async () => {
    mocks.getOrganizationMembershipList.mockResolvedValue({
      data: [membershipRow({ publicUserData: null })],
      totalCount: 1,
    });

    const page = await clerkService.listOrganizationMemberships({
      organizationId: CLERK_ORG_ID,
      limit: 25,
      offset: 0,
    });

    expect(page.data).toHaveLength(1);
    expect(page.data[0]).toMatchObject({
      userId: null,
      identifier: null,
      firstName: null,
      lastName: null,
      imageUrl: null,
      role: "org:admin",
    });
  });

  it("returns an unrecognized provider role verbatim rather than dropping the row", async () => {
    mocks.getOrganizationMembershipList.mockResolvedValue({
      data: [membershipRow({ role: "org:billing_manager" })],
      totalCount: 1,
    });

    const page = await clerkService.listOrganizationMemberships({
      organizationId: CLERK_ORG_ID,
      limit: 25,
      offset: 0,
    });

    expect(page.data).toHaveLength(1);
    expect(page.data[0]?.role).toBe("org:billing_manager");
  });

  it("propagates a provider failure instead of reporting an empty roster", async () => {
    mocks.getOrganizationMembershipList.mockRejectedValue(
      new Error("clerk unreachable")
    );

    await expect(
      clerkService.listOrganizationMemberships({
        organizationId: CLERK_ORG_ID,
        limit: 25,
        offset: 0,
      })
    ).rejects.toThrow("clerk unreachable");
  });
});

describe("clerkService organization invitation reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards the status filter and the page bounds", async () => {
    mocks.getOrganizationInvitationList.mockResolvedValue({
      data: [],
      totalCount: 0,
    });

    await clerkService.listOrganizationInvitations({
      organizationId: CLERK_ORG_ID,
      limit: 10,
      offset: 20,
      status: [ClerkInvitationStatus.Pending],
    });

    expect(mocks.getOrganizationInvitationList).toHaveBeenCalledWith({
      organizationId: CLERK_ORG_ID,
      limit: 10,
      offset: 20,
      status: [ClerkInvitationStatus.Pending],
    });
  });

  it("omits the status filter entirely when the caller supplies none", async () => {
    mocks.getOrganizationInvitationList.mockResolvedValue({
      data: [],
      totalCount: 0,
    });

    await clerkService.listOrganizationInvitations({
      organizationId: CLERK_ORG_ID,
      limit: 10,
      offset: 0,
    });

    expect(mocks.getOrganizationInvitationList).toHaveBeenCalledWith({
      organizationId: CLERK_ORG_ID,
      limit: 10,
      offset: 0,
    });
  });

  it("propagates a provider failure instead of reporting an empty invitation list", async () => {
    mocks.getOrganizationInvitationList.mockRejectedValue(
      new Error("clerk unreachable")
    );

    await expect(
      clerkService.listOrganizationInvitations({
        organizationId: CLERK_ORG_ID,
        limit: 10,
        offset: 0,
      })
    ).rejects.toThrow("clerk unreachable");
  });

  it("keeps an absent invitation status absent rather than defaulting it", async () => {
    const { status, ...withoutStatus } = invitationRow();
    expect(status).toBe(ClerkInvitationStatus.Pending);
    mocks.getOrganizationInvitationList.mockResolvedValue({
      data: [withoutStatus],
      totalCount: 1,
    });

    const page = await clerkService.listOrganizationInvitations({
      organizationId: CLERK_ORG_ID,
      limit: 10,
      offset: 0,
    });

    expect(page.data[0]).not.toHaveProperty("status");
  });

  it("keeps a present invitation status when the provider reports one", async () => {
    // The case above already pins the omitted-status arm; this covers the
    // other side of the conditional spread via a single-invitation read.
    mocks.getOrganizationInvitation.mockResolvedValue(invitationRow());

    const invitation = await clerkService.getOrganizationInvitation({
      organizationId: CLERK_ORG_ID,
      invitationId: "orginv_1",
    });

    expect(invitation).toMatchObject({ status: ClerkInvitationStatus.Pending });
  });
});

describe("clerkService.updateOrganization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes only slug when only slug is provided", async () => {
    mocks.updateOrganization.mockResolvedValue({
      id: "org_1",
      name: "Acme",
      slug: "acme",
    });

    await clerkService.updateOrganization("org_1", { slug: "acme" });

    expect(mocks.updateOrganization).toHaveBeenCalledWith("org_1", {
      slug: "acme",
    });
  });

  it("passes only name when only name is provided", async () => {
    mocks.updateOrganization.mockResolvedValue({
      id: "org_1",
      name: "Acme Inc",
      slug: "acme",
    });

    await clerkService.updateOrganization("org_1", { name: "Acme Inc" });

    expect(mocks.updateOrganization).toHaveBeenCalledWith("org_1", {
      name: "Acme Inc",
    });
  });

  it("passes both slug and name when both are provided", async () => {
    mocks.updateOrganization.mockResolvedValue({
      id: "org_1",
      name: "Acme Inc",
      slug: "acme-inc",
    });

    await clerkService.updateOrganization("org_1", {
      slug: "acme-inc",
      name: "Acme Inc",
    });

    expect(mocks.updateOrganization).toHaveBeenCalledWith("org_1", {
      slug: "acme-inc",
      name: "Acme Inc",
    });
  });

  it("passes an empty patch when neither slug nor name is provided", async () => {
    mocks.updateOrganization.mockResolvedValue({
      id: "org_1",
      name: "Acme",
      slug: "acme",
    });

    await clerkService.updateOrganization("org_1", {});

    expect(mocks.updateOrganization).toHaveBeenCalledWith("org_1", {});
  });
});

describe("clerkService.getOrganizationMembershipRole", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when the provider reports no membership", async () => {
    mocks.getOrganizationMembershipList.mockResolvedValue({
      data: [],
      totalCount: 0,
    });

    await expect(
      clerkService.getOrganizationMembershipRole(CLERK_ORG_ID, "user_1")
    ).resolves.toBeNull();
  });

  it("returns the membership's role when the provider finds one", async () => {
    mocks.getOrganizationMembershipList.mockResolvedValue({
      data: [membershipRow()],
      totalCount: 1,
    });

    await expect(
      clerkService.getOrganizationMembershipRole(CLERK_ORG_ID, "user_1")
    ).resolves.toBe("org:admin");
  });
});
