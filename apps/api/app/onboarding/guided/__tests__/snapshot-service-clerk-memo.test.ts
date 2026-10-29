/**
 * ISS-10335: the production wiring, not the memo's own unit.
 *
 * Every other suite in this directory mocks `@/lib/auth/clerk-service`, so none
 * of them can see what the snapshot actually costs Clerk. This one runs the
 * REAL clerk-service against a mocked `clerkClient`, which is the only place the
 * sidebar's per-page-load read and the memo meet.
 */
import { KnownFlag } from "@repo/api/src/types/onboarding-phase";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  getUser: vi.fn(),
  organizationHasSyncedSessionData: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/database")>()),
  withDb: mocks.withDb,
}));

vi.mock("@repo/auth/server", () => ({
  clerkClient: vi.fn(async () => ({
    users: { getUser: mocks.getUser },
  })),
}));

vi.mock("@/app/agent-sessions/organization-synced-session-data", () => ({
  organizationHasSyncedSessionData: mocks.organizationHasSyncedSessionData,
}));

import { OnboardingHost } from "@repo/api/src/types/onboarding-phase";
import { createGuidedOnboardingDb } from "@/__tests__/support/onboarding-guided/guided-onboarding.test-db";
import {
  CLERK_USER_A,
  ORG_A,
  organizationRow,
  USER_A,
  userRow,
} from "@/__tests__/support/onboarding-guided/guided-onboarding.test-fixtures";
import { invalidateUserExternalAccountProviders } from "@/lib/auth/clerk-service";
import { guidedOnboardingSnapshotService } from "../snapshot-service";

function read() {
  return guidedOnboardingSnapshotService.getSnapshot({
    organizationId: ORG_A,
    userId: USER_A,
    clerkUserId: CLERK_USER_A,
    host: OnboardingHost.Web,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  invalidateUserExternalAccountProviders(CLERK_USER_A);
  const db = createGuidedOnboardingDb({
    users: [userRow(USER_A, ORG_A)],
    organizations: [organizationRow(ORG_A)],
  });
  mocks.withDb.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(db.client)
  );
  mocks.organizationHasSyncedSessionData.mockResolvedValue(KnownFlag.No);
  mocks.getUser.mockResolvedValue({
    externalAccounts: [{ provider: "oauth_github" }],
  });
});

describe("guided onboarding snapshot Clerk cost", () => {
  it("spends one Clerk user read across two snapshots for the same user", async () => {
    const first = await read();
    const second = await read();

    expect(mocks.getUser).toHaveBeenCalledTimes(1);
    // The saving must not change the answer: both reads still report the
    // provider Clerk named.
    expect(second.context.accountProvider).toBe(first.context.accountProvider);
    expect(second.context.accountProvider).not.toBeNull();
  });
});
