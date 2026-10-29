import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  getUserList: vi.fn(),
  getOrganizationMembershipList: vi.fn(),
  getSessionList: vi.fn(),
}));

vi.mock("@repo/auth/server", () => ({
  clerkClient: vi.fn(async () => ({
    users: {
      getUser: mocks.getUser,
      getUserList: mocks.getUserList,
      getOrganizationMembershipList: mocks.getOrganizationMembershipList,
    },
    sessions: { getSessionList: mocks.getSessionList },
  })),
}));

import { clerkService } from "../clerk-service";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("clerkService.getUser", () => {
  it("resolves the primary email and primary phone when both are found", async () => {
    mocks.getUser.mockResolvedValueOnce({
      id: "user_1",
      firstName: "Ada",
      lastName: "Lovelace",
      imageUrl: "https://img.clerk.com/ada",
      primaryEmailAddressId: "email_1",
      emailAddresses: [{ id: "email_1", emailAddress: "ada@example.com" }],
      primaryPhoneNumberId: "phone_1",
      phoneNumbers: [{ id: "phone_1", phoneNumber: "+15551234567" }],
    });

    await expect(clerkService.getUser("user_1")).resolves.toEqual({
      id: "user_1",
      email: "ada@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
      imageUrl: "https://img.clerk.com/ada",
      phoneNumber: "+15551234567",
    });
  });

  it("rejects when no email address matches the primary email address id", async () => {
    mocks.getUser.mockResolvedValueOnce({
      id: "user_2",
      firstName: null,
      lastName: null,
      imageUrl: null,
      primaryEmailAddressId: "email_missing",
      emailAddresses: [],
      primaryPhoneNumberId: null,
      phoneNumbers: [],
    });

    await expect(clerkService.getUser("user_2")).rejects.toThrow(
      "User has no primary email address"
    );
  });

  it("resolves a null phone number when no phone matches the primary phone number id", async () => {
    mocks.getUser.mockResolvedValueOnce({
      id: "user_3",
      firstName: "Grace",
      lastName: "Hopper",
      imageUrl: null,
      primaryEmailAddressId: "email_3",
      emailAddresses: [{ id: "email_3", emailAddress: "grace@example.com" }],
      primaryPhoneNumberId: "phone_missing",
      phoneNumbers: [],
    });

    await expect(clerkService.getUser("user_3")).resolves.toEqual({
      id: "user_3",
      email: "grace@example.com",
      firstName: "Grace",
      lastName: "Hopper",
      imageUrl: null,
      phoneNumber: null,
    });
  });
});

describe("clerkService user lookups for a vibe environment (ISS-12056)", () => {
  it("asks for at most two users with the email and returns their ids", async () => {
    mocks.getUserList.mockResolvedValueOnce({
      data: [{ id: "user_1" }, { id: "user_2" }],
      totalCount: 2,
    });

    await expect(
      clerkService.findUserIdsByEmail("ada@example.com")
    ).resolves.toEqual(["user_1", "user_2"]);
    expect(mocks.getUserList).toHaveBeenCalledWith({
      emailAddress: ["ada@example.com"],
      limit: 2,
    });
  });

  it("maps each of a user's memberships to its org id, name and role", async () => {
    mocks.getOrganizationMembershipList.mockResolvedValueOnce({
      data: [
        {
          role: "org:admin",
          organization: { id: "org_a", name: "ClosedLoop" },
        },
        { role: "org:member", organization: { id: "org_b", name: "Side" } },
      ],
      totalCount: 2,
    });

    await expect(
      clerkService.listUserOrganizationMemberships("user_1")
    ).resolves.toEqual([
      {
        organizationId: "org_a",
        organizationName: "ClosedLoop",
        role: "org:admin",
      },
      { organizationId: "org_b", organizationName: "Side", role: "org:member" },
    ]);
    expect(mocks.getOrganizationMembershipList).toHaveBeenCalledWith({
      userId: "user_1",
      limit: 100,
      offset: 0,
    });
  });

  it("reads every page so the org choice cannot omit a membership", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      role: "org:member",
      organization: { id: `org_${index}`, name: `Org ${index}` },
    }));
    mocks.getOrganizationMembershipList
      .mockResolvedValueOnce({ data: firstPage, totalCount: 101 })
      .mockResolvedValueOnce({
        data: [
          {
            role: "org:admin",
            organization: { id: "org_last", name: "Last org" },
          },
        ],
        totalCount: 101,
      });

    const memberships =
      await clerkService.listUserOrganizationMemberships("user_1");

    expect(memberships).toHaveLength(101);
    expect(memberships.at(-1)).toEqual({
      organizationId: "org_last",
      organizationName: "Last org",
      role: "org:admin",
    });
    expect(mocks.getOrganizationMembershipList).toHaveBeenNthCalledWith(2, {
      userId: "user_1",
      limit: 100,
      offset: 100,
    });
  });

  it("refuses a short page rather than hiding memberships", async () => {
    mocks.getOrganizationMembershipList
      .mockResolvedValueOnce({
        data: [
          {
            role: "org:member",
            organization: { id: "org_a", name: "Org A" },
          },
        ],
        totalCount: 2,
      })
      .mockResolvedValueOnce({ data: [], totalCount: 2 });

    await expect(
      clerkService.listUserOrganizationMemberships("user_1")
    ).rejects.toThrow("incomplete organization membership page");
  });
});

describe("clerkService.getLastActiveOrganizationId (ISS-12135)", () => {
  it("reads the org of the most recently active session that has one, across every page", async () => {
    const firstPage = [
      { lastActiveAt: 300, lastActiveOrganizationId: undefined },
      { lastActiveAt: 100, lastActiveOrganizationId: "org_old" },
      ...Array.from({ length: 98 }, () => ({
        lastActiveAt: 50,
        lastActiveOrganizationId: "org_older",
      })),
    ];
    mocks.getSessionList
      .mockResolvedValueOnce({ data: firstPage, totalCount: 101 })
      .mockResolvedValueOnce({
        data: [{ lastActiveAt: 200, lastActiveOrganizationId: "org_latest" }],
        totalCount: 101,
      });

    await expect(
      clerkService.getLastActiveOrganizationId("user_1")
    ).resolves.toBe("org_latest");
    expect(mocks.getSessionList).toHaveBeenNthCalledWith(1, {
      userId: "user_1",
      limit: 100,
      offset: 0,
    });
    expect(mocks.getSessionList).toHaveBeenNthCalledWith(2, {
      userId: "user_1",
      limit: 100,
      offset: 100,
    });
  });

  it("answers undefined when no session had an org active", async () => {
    mocks.getSessionList.mockResolvedValueOnce({
      data: [{ lastActiveAt: 1, lastActiveOrganizationId: undefined }],
      totalCount: 1,
    });

    await expect(
      clerkService.getLastActiveOrganizationId("user_1")
    ).resolves.toBeUndefined();
  });

  it("refuses a short page rather than answering from part of the sessions", async () => {
    mocks.getSessionList
      .mockResolvedValueOnce({
        data: [{ lastActiveAt: 1, lastActiveOrganizationId: "org_a" }],
        totalCount: 2,
      })
      .mockResolvedValueOnce({ data: [], totalCount: 2 });

    await expect(
      clerkService.getLastActiveOrganizationId("user_1")
    ).rejects.toThrow("incomplete session page");
  });

  it("throws a provider failure rather than answering no org", async () => {
    mocks.getSessionList.mockRejectedValueOnce(new Error("Clerk is down"));

    await expect(
      clerkService.getLastActiveOrganizationId("user_1")
    ).rejects.toThrow("Clerk is down");
  });
});
