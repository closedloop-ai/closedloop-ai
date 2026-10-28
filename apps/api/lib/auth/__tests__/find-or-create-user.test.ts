/**
 * ISS-10335: the miss path fetches the user from Clerk, and a fresh
 * deployment's first burst of parallel requests all miss the same row at once —
 * measured at 10 to 14 identical Clerk reads against an allowance shared by
 * every caller. These cases pin the single-flight that collapses them, and that
 * a failure is never what the next caller inherits.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findOrCreateByClerkId: vi.fn(),
  findByClerkIdAndOrg: vi.fn(),
  upsertByClerkIdAndOrg: vi.fn(),
  getUser: vi.fn(),
}));

vi.mock("@/app/organizations/service", () => ({
  organizationsService: {
    findOrCreateByClerkId: mocks.findOrCreateByClerkId,
  },
}));

vi.mock("@/app/users/service", () => ({
  usersService: {
    findByClerkIdAndOrg: mocks.findByClerkIdAndOrg,
    upsertByClerkIdAndOrg: mocks.upsertByClerkIdAndOrg,
  },
}));

vi.mock("@/lib/auth/clerk-service", () => ({
  clerkService: {
    getUser: mocks.getUser,
  },
}));

import { createTestAuthContext } from "@/__tests__/utils/auth-helpers";
import {
  findOrCreateUser,
  IN_FLIGHT_SYNC_MAX_KEYS,
} from "@/lib/auth/find-or-create-user";

const CLERK_USER_ID = "user_burst";
const CLERK_ORG_ID = "org_burst";
const ORGANIZATION_ID = "internal_org_1";

const existingUser = createTestAuthContext().user;
const upsertedUser = { ...existingUser, id: "internal_user_1" };

const clerkProfile = {
  id: CLERK_USER_ID,
  email: "burst@example.com",
  firstName: "Ada",
  lastName: "Lovelace",
  imageUrl: "https://img.clerk.com/ada",
  phoneNumber: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findOrCreateByClerkId.mockResolvedValue({ id: ORGANIZATION_ID });
  mocks.upsertByClerkIdAndOrg.mockResolvedValue(upsertedUser);
  mocks.getUser.mockResolvedValue(clerkProfile);
});

describe("findOrCreateUser", () => {
  it("collapses a concurrent burst of misses into one Clerk read", async () => {
    mocks.findByClerkIdAndOrg.mockResolvedValue(null);

    const burst = await Promise.all(
      Array.from({ length: 5 }, () =>
        findOrCreateUser(CLERK_USER_ID, CLERK_ORG_ID)
      )
    );

    expect(mocks.getUser).toHaveBeenCalledTimes(1);
    expect(mocks.upsertByClerkIdAndOrg).toHaveBeenCalledTimes(1);
    // Every waiter gets the upserted row, not a null the loser of a race would
    // have returned.
    expect(burst).toEqual([
      upsertedUser,
      upsertedUser,
      upsertedUser,
      upsertedUser,
      upsertedUser,
    ]);
  });

  it("rejects every waiter on a Clerk failure and retries on the next call", async () => {
    mocks.findByClerkIdAndOrg.mockResolvedValue(null);
    const outage = new Error("clerk unavailable");
    mocks.getUser.mockRejectedValueOnce(outage);

    const burst = Promise.all([
      findOrCreateUser(CLERK_USER_ID, CLERK_ORG_ID),
      findOrCreateUser(CLERK_USER_ID, CLERK_ORG_ID),
    ]);
    await expect(burst).rejects.toBe(outage);
    expect(mocks.getUser).toHaveBeenCalledTimes(1);

    // The failed entry must not stick: a later caller asks Clerk again rather
    // than inheriting the rejection.
    await expect(
      findOrCreateUser(CLERK_USER_ID, CLERK_ORG_ID)
    ).resolves.toEqual(upsertedUser);
    expect(mocks.getUser).toHaveBeenCalledTimes(2);
  });

  it("leaves the hit path out of the single-flight map", async () => {
    mocks.findByClerkIdAndOrg.mockResolvedValue(existingUser);

    const hits = await Promise.all([
      findOrCreateUser(CLERK_USER_ID, CLERK_ORG_ID),
      findOrCreateUser(CLERK_USER_ID, CLERK_ORG_ID),
    ]);

    expect(hits).toEqual([existingUser, existingUser]);
    // Each hit does its own lookup — neither was served by an in-flight entry.
    expect(mocks.findByClerkIdAndOrg).toHaveBeenCalledTimes(2);
    expect(mocks.getUser).not.toHaveBeenCalled();

    // And a hit left nothing behind that a following miss would be served from.
    mocks.findByClerkIdAndOrg.mockResolvedValue(null);
    await expect(
      findOrCreateUser(CLERK_USER_ID, CLERK_ORG_ID)
    ).resolves.toEqual(upsertedUser);
    expect(mocks.getUser).toHaveBeenCalledTimes(1);
  });

  it("keys the single-flight per organization", async () => {
    mocks.findByClerkIdAndOrg.mockResolvedValue(null);
    mocks.findOrCreateByClerkId.mockImplementation((clerkOrgId: string) =>
      Promise.resolve({ id: `internal_${clerkOrgId}` })
    );

    await Promise.all([
      findOrCreateUser(CLERK_USER_ID, CLERK_ORG_ID),
      findOrCreateUser(CLERK_USER_ID, "org_other"),
    ]);

    // One user in two organizations needs two rows, so the burst must not be
    // collapsed onto the Clerk id alone.
    expect(mocks.upsertByClerkIdAndOrg).toHaveBeenCalledTimes(2);
  });
  it("caps the in-flight map, so a burst of distinct misses past the bound evicts the oldest", async () => {
    mocks.findByClerkIdAndOrg.mockResolvedValue(null);
    // Every Clerk read stays open until released, so the whole burst is in
    // flight at once and nothing settles out of the map on its own.
    const release: Array<() => void> = [];
    mocks.getUser.mockImplementation(
      () =>
        new Promise((resolve) => {
          release.push(() => resolve(clerkProfile));
        })
    );
    const burstSize = IN_FLIGHT_SYNC_MAX_KEYS + 1;
    const userId = (index: number) => `user_distinct_${index}`;

    const burst = Array.from({ length: burstSize }, (_, index) =>
      findOrCreateUser(userId(index), CLERK_ORG_ID)
    );
    await vi.waitFor(() =>
      expect(mocks.getUser).toHaveBeenCalledTimes(burstSize)
    );

    // The oldest key was evicted to admit the one past the cap, so a second
    // caller for it starts its own Clerk read; the newest key is still held,
    // so a second caller for it joins the read already in flight.
    const evictedAgain = findOrCreateUser(userId(0), CLERK_ORG_ID);
    const heldAgain = findOrCreateUser(userId(burstSize - 1), CLERK_ORG_ID);
    await vi.waitFor(() =>
      expect(mocks.getUser).toHaveBeenCalledTimes(burstSize + 1)
    );

    for (const settle of release) {
      settle();
    }
    const results = await Promise.all([...burst, evictedAgain, heldAgain]);

    expect(mocks.getUser).toHaveBeenCalledTimes(burstSize + 1);
    expect(results).toHaveLength(burstSize + 2);
    expect(new Set(results)).toEqual(new Set([upsertedUser]));
  });
});
