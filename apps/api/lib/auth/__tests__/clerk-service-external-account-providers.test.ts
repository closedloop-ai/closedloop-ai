/**
 * ISS-10335: the guided-onboarding snapshot the sidebar fetches on every
 * authenticated page load reads this list, and each read was a Clerk Backend
 * API user fetch against a 100-request/10-second allowance shared by every
 * caller. These cases pin the memo that removed that cost, and the two things
 * it must not trade away: a stale answer past the TTL, and a failure served as
 * an empty list.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
}));

vi.mock("@repo/auth/server", () => ({
  clerkClient: vi.fn(async () => ({
    users: {
      getUser: mocks.getUser,
    },
  })),
}));

import {
  clerkService,
  invalidateUserExternalAccountProviders,
} from "../clerk-service";

const CLERK_USER_ID = "user_memo_1";
const OTHER_CLERK_USER_ID = "user_memo_2";
const TTL_MS = 60_000;
const NOW = new Date("2026-09-15T12:00:00.000Z");

function clerkUserWith(providers: string[]) {
  return {
    externalAccounts: providers.map((provider) => ({ provider })),
  };
}

function read(userId = CLERK_USER_ID) {
  return clerkService.getUserExternalAccountProviders(userId);
}

beforeEach(() => {
  vi.clearAllMocks();
  // The memo is module state shared by every case in this file.
  invalidateUserExternalAccountProviders(CLERK_USER_ID);
  invalidateUserExternalAccountProviders(OTHER_CLERK_USER_ID);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("clerkService.getUserExternalAccountProviders memoization", () => {
  it("asks Clerk on the first read and returns the linked providers", async () => {
    mocks.getUser.mockResolvedValue(clerkUserWith(["oauth_github"]));

    await expect(read()).resolves.toEqual(["oauth_github"]);
    expect(mocks.getUser).toHaveBeenCalledTimes(1);
    expect(mocks.getUser).toHaveBeenCalledWith(CLERK_USER_ID);
  });

  it("serves a second read inside the TTL without a second Clerk call", async () => {
    mocks.getUser.mockResolvedValue(clerkUserWith(["oauth_github"]));

    const first = await read();
    vi.setSystemTime(new Date(NOW.getTime() + TTL_MS - 1));
    const second = await read();

    expect(second).toEqual(first);
    expect(mocks.getUser).toHaveBeenCalledTimes(1);
  });

  it("asks Clerk again once the TTL has passed", async () => {
    mocks.getUser.mockResolvedValue(clerkUserWith(["oauth_github"]));
    await read();

    vi.setSystemTime(new Date(NOW.getTime() + TTL_MS));
    mocks.getUser.mockResolvedValue(
      clerkUserWith(["oauth_github", "oauth_google"])
    );

    await expect(read()).resolves.toEqual(["oauth_github", "oauth_google"]);
    expect(mocks.getUser).toHaveBeenCalledTimes(2);
  });

  it("collapses concurrent first reads for one user into a single Clerk call", async () => {
    let release: ((user: unknown) => void) | undefined;
    mocks.getUser.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      })
    );

    const both = Promise.all([read(), read()]);
    release?.(clerkUserWith(["oauth_github"]));

    await expect(both).resolves.toEqual([["oauth_github"], ["oauth_github"]]);
    expect(mocks.getUser).toHaveBeenCalledTimes(1);
  });

  it("keys the memo per user, so one user's list never answers another's read", async () => {
    mocks.getUser.mockImplementation((userId: string) =>
      Promise.resolve(
        clerkUserWith(userId === CLERK_USER_ID ? ["oauth_github"] : [])
      )
    );

    await expect(read()).resolves.toEqual(["oauth_github"]);
    await expect(read(OTHER_CLERK_USER_ID)).resolves.toEqual([]);
    expect(mocks.getUser).toHaveBeenCalledTimes(2);
  });

  it("propagates a Clerk failure and retries it on the next read", async () => {
    const outage = new Error("clerk unavailable");
    mocks.getUser.mockRejectedValueOnce(outage);

    // The memo must not turn "we could not ask" into "no linked provider":
    // that is the distinction the method's own contract is built on.
    await expect(read()).rejects.toBe(outage);

    mocks.getUser.mockResolvedValue(clerkUserWith(["oauth_github"]));
    await expect(read()).resolves.toEqual(["oauth_github"]);
    expect(mocks.getUser).toHaveBeenCalledTimes(2);
  });

  it("refetches after an invalidation, inside the TTL", async () => {
    mocks.getUser.mockResolvedValue(clerkUserWith([]));
    await read();

    invalidateUserExternalAccountProviders(CLERK_USER_ID);
    mocks.getUser.mockResolvedValue(clerkUserWith(["oauth_github"]));

    await expect(read()).resolves.toEqual(["oauth_github"]);
    expect(mocks.getUser).toHaveBeenCalledTimes(2);
  });

  it("does not evict a newer entry when an older, already-replaced fetch rejects", async () => {
    // The identity check in the rejection handler must compare against the
    // CURRENT memo entry, not just "some entry exists for this user" — a
    // coarser check would evict the second, still-live entry too.
    let rejectFirst!: (reason: unknown) => void;
    let releaseSecond!: (value: unknown) => void;
    const firstFetch = new Promise((_resolve, reject) => {
      rejectFirst = reject;
    });
    const secondFetch = new Promise((resolve) => {
      releaseSecond = resolve;
    });

    mocks.getUser
      .mockImplementationOnce(() => firstFetch)
      .mockImplementationOnce(() => secondFetch);

    const firstRead = read();

    // Replace the entry firstRead installed before its fetch has settled, so
    // the rejection below finds a DIFFERENT entry as the memo's current one.
    invalidateUserExternalAccountProviders(CLERK_USER_ID);
    const secondRead = read();

    await vi.waitFor(() => {
      expect(mocks.getUser).toHaveBeenCalledTimes(2);
    });

    rejectFirst(new Error("stale fetch failed"));
    await expect(firstRead).rejects.toThrow("stale fetch failed");

    releaseSecond(clerkUserWith(["oauth_google"]));
    await expect(secondRead).resolves.toEqual(["oauth_google"]);

    // If the stale rejection had wrongly evicted the newer entry, this read
    // would miss the memo and call getUser a third time.
    await expect(read()).resolves.toEqual(["oauth_google"]);
    expect(mocks.getUser).toHaveBeenCalledTimes(2);
  });
});
