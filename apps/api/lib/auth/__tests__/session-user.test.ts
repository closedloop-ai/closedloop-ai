/**
 * Unit tests for `resolveSessionUser`.
 *
 * This is the only place the real function runs: all five production consumers
 * — /desktop/authorize, /desktop/onboarding-attempt, /desktop/device-onboarding
 * {session,approve}, and compute-targets security-upgrade-attempt — `vi.mock`
 * the module, so nothing else in the repo executes it. It is the sole gate in
 * front of five credential-minting routes.
 *
 * Two things are pinned here that no route suite can pin:
 *   - WHICH guard produced a `null` (the session check vs the `active` check),
 *     via whether `findOrCreateUser` was reached.
 *   - That a failed lookup PROPAGATES rather than becoming `null`. Both awaits
 *     can reject, and /desktop/authorize now answers a rejection with a
 *     retryable 503 instead of a 401 (ISS-7974). Swallowing either one here
 *     would make that catch arm unreachable and silently restore the bug.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/auth/server", () => ({
  auth: vi.fn(),
}));

vi.mock("@/lib/auth/find-or-create-user", () => ({
  findOrCreateUser: vi.fn(),
}));

import { auth } from "@repo/auth/server";
import { createTestAuthContext } from "@/__tests__/utils/auth-helpers";
import { findOrCreateUser } from "@/lib/auth/find-or-create-user";
import { resolveSessionUser } from "@/lib/auth/session-user";

const CLERK_USER_ID = "user_x";
const CLERK_ORG_ID = "org_x";

const mockAuth = vi.mocked(auth);
const mockFindOrCreateUser = vi.mocked(findOrCreateUser);

const activeUser = createTestAuthContext().user;

function stubSession(userId: string | null, orgId: string | null) {
  mockAuth.mockResolvedValue({ userId, orgId } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveSessionUser", () => {
  it("returns null without a lookup when there is no Clerk session at all", async () => {
    stubSession(null, null);

    await expect(resolveSessionUser()).resolves.toBeNull();
    expect(mockFindOrCreateUser).not.toHaveBeenCalled();
  });

  // The guard is `!(clerkUserId && clerkOrgId)`. A both-null case alone leaves
  // either half of the `&&` free to be deleted, so each half gets the case that
  // is the ONLY one to diverge when that half is dropped.
  it("returns null without a lookup when the org is missing", async () => {
    stubSession(CLERK_USER_ID, null);

    await expect(resolveSessionUser()).resolves.toBeNull();
    expect(mockFindOrCreateUser).not.toHaveBeenCalled();
  });

  it("returns null without a lookup when the user is missing", async () => {
    stubSession(null, CLERK_ORG_ID);

    await expect(resolveSessionUser()).resolves.toBeNull();
    expect(mockFindOrCreateUser).not.toHaveBeenCalled();
  });

  it("returns null for a resolved but inactive user, having performed the lookup", async () => {
    stubSession(CLERK_USER_ID, CLERK_ORG_ID);
    mockFindOrCreateUser.mockResolvedValue({ ...activeUser, active: false });

    await expect(resolveSessionUser()).resolves.toBeNull();
    // Asserting the lookup RAN is what attributes this null to the `active`
    // check rather than the session check above — the two are indistinguishable
    // from the return value alone.
    expect(mockFindOrCreateUser).toHaveBeenCalledWith(
      CLERK_USER_ID,
      CLERK_ORG_ID
    );
    expect(mockFindOrCreateUser).toHaveBeenCalledTimes(1);
  });

  it("returns null for a null lookup result, having performed the lookup", async () => {
    stubSession(CLERK_USER_ID, CLERK_ORG_ID);
    mockFindOrCreateUser.mockResolvedValue(null);

    await expect(resolveSessionUser()).resolves.toBeNull();
    expect(mockFindOrCreateUser).toHaveBeenCalledTimes(1);
  });

  // The anchor. Without a case that returns a context, a function that returned
  // `null` unconditionally would satisfy every case above. The two Clerk ids are
  // asserted to their own distinct values so a field swap cannot survive.
  it("returns the resolved context with both Clerk ids echoed", async () => {
    stubSession(CLERK_USER_ID, CLERK_ORG_ID);
    mockFindOrCreateUser.mockResolvedValue(activeUser);

    await expect(resolveSessionUser()).resolves.toEqual({
      user: activeUser,
      clerkUserId: CLERK_USER_ID,
      clerkOrgId: CLERK_ORG_ID,
    });
    expect(mockFindOrCreateUser).toHaveBeenCalledTimes(1);
  });

  it("propagates a failed session lookup instead of reporting it as signed out", async () => {
    mockAuth.mockRejectedValue(new Error("clerk unavailable"));

    await expect(resolveSessionUser()).rejects.toThrow("clerk unavailable");
    expect(mockFindOrCreateUser).not.toHaveBeenCalled();
  });

  // The second rejecting await. The case above returns before this call is
  // reached, and every resolved-value case is indistinguishable from a caught
  // rejection here — including the null one.
  it("propagates a failed user lookup instead of reporting it as signed out", async () => {
    stubSession(CLERK_USER_ID, CLERK_ORG_ID);
    mockFindOrCreateUser.mockRejectedValue(new Error("database unavailable"));

    await expect(resolveSessionUser()).rejects.toThrow("database unavailable");
  });
});
