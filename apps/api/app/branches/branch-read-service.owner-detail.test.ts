/**
 * Branch DETAIL owner resolution. Split out of
 * `branch-read-service.owner.test.ts`, which owns the same projection on the
 * LIST path; the two must agree about the same session, which is the contract
 * ISS-11738 was filed against.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule({
    ChecksStatus: { UNKNOWN: "UNKNOWN" },
  });
});

vi.mock("@repo/github", async () => {
  const actual =
    await vi.importActual<typeof import("@repo/github")>("@repo/github");
  return {
    ...actual,
    getSinglePullRequestWithProviderResult: vi.fn(),
  };
});

import { makeBranchAssignee } from "@/__tests__/support/branches/branch-assignee.test-fixtures";
import { withSeededPushSessionCreators } from "@/__tests__/support/branches/branch-evidence-link.test-fixtures";
import {
  branchId,
  createMockDb,
  makeBranchRow,
  makePushSessionLink,
  now,
  organizationId,
} from "@/__tests__/support/branches/branch-read-service.test-helpers";
import { mockWithDbCall, mockWithDbTx } from "../../__tests__/utils/db-helpers";
import { branchReadService } from "./branch-read-service";

afterEach(() => {
  vi.useRealTimers();
});

describe("branchReadService detail owner resolution", () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mockDb = createMockDb();
    mockWithDbCall(withSeededPushSessionCreators(mockDb));
    mockWithDbTx(withSeededPushSessionCreators(mockDb));
    mockDb.commitDetail.findMany.mockResolvedValue([]);
  });

  const ownerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const clerkAvatarUrl = "https://img.clerk.com/branch-owner.png";

  it("resolves the branch-detail owner via the same batched path", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(
      makeBranchRow({
        firstPushedAt: now,
        assignee: makeBranchAssignee(ownerA),
      })
    );
    mockDb.artifactLink.findMany.mockResolvedValue([
      makePushSessionLink(branchId, "s1", ownerA, now),
    ]);
    mockDb.user.findMany.mockResolvedValue([
      {
        id: ownerA,
        clerkId: "clerk-ada",
        email: "ada@example.com",
        firstName: "Ada",
        lastName: "Lovelace",
        avatarUrl: clerkAvatarUrl,
      },
    ]);
    mockDb.gitHubUserConnection.findMany.mockResolvedValue([
      {
        userId: ownerA,
        githubUserId: "1",
        login: "ada",
        avatarUrl: null,
        profileUrl: null,
      },
    ]);

    const detail = await branchReadService.getBranchDetail(
      organizationId,
      branchId
    );

    expect(detail?.owner).toBe("Ada Lovelace");
    expect(detail?.ownerIdentity?.person?.avatarUrl).toBe(clerkAvatarUrl);
    expect(
      detail?.canonicalProjection?.common.people.owner?.person?.avatarUrl
    ).toBe(clerkAvatarUrl);
  });

  it("does not expose an email as a branch-detail Linked Session owner name", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(
      makeBranchRow({ firstPushedAt: now })
    );
    mockDb.artifactLink.findMany.mockResolvedValue([
      makePushSessionLink(branchId, "s1", ownerA, now),
    ]);
    mockDb.user.findMany.mockResolvedValue([
      {
        id: ownerA,
        email: "private-owner@example.com",
        clerkId: "clerk-private-owner",
        firstName: null,
        lastName: null,
        avatarUrl: null,
      },
    ]);
    mockDb.gitHubUserConnection.findMany.mockResolvedValue([]);

    const detail = await branchReadService.getBranchDetail(
      organizationId,
      branchId
    );

    // The same contract the list case above pins, on the detail response:
    // `resolveOwnerProfiles`/`displayUserName` falls back to EMAIL, so a detail
    // profile map built from it would publish a private address as `ownerName`
    // (whitlockk review, ISS-11738). A nameless owner stays `ownerUnavailable`.
    const membership = detail?.canonicalProjection?.common.membership;
    expect(membership?.sessions?.[0]).toMatchObject({
      ownerUnavailable: true,
    });
    expect(membership?.sessions?.[0]?.ownerName).toBeUndefined();
    expect(JSON.stringify(membership)).not.toContain(
      "private-owner@example.com"
    );
  });
});
