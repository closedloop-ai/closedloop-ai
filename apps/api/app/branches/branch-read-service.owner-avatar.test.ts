import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule({ ChecksStatus: { UNKNOWN: "UNKNOWN" } });
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
  mockBranchCandidatePage,
  now,
  organizationId,
} from "@/__tests__/support/branches/branch-read-service.test-helpers";
import { mockWithDbCall, mockWithDbTx } from "../../__tests__/utils/db-helpers";
import { branchReadService } from "./branch-read-service";

const OWNER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLERK_AVATAR_URL = "https://img.clerk.com/branch-owner.png";

afterEach(() => {
  vi.useRealTimers();
});

describe("Branch list Owner avatar projection", () => {
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

  it("serves the linked Clerk photo through the list Owner projection", async () => {
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({
        firstPushedAt: now,
        assignee: makeBranchAssignee(OWNER_ID),
      }),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([
      makePushSessionLink(branchId, "s1", OWNER_ID, now),
    ]);
    mockDb.user.findMany.mockResolvedValue([
      {
        id: OWNER_ID,
        clerkId: "user_ada",
        email: "ada@example.com",
        firstName: "Ada",
        lastName: "Lovelace",
        avatarUrl: CLERK_AVATAR_URL,
      },
    ]);
    mockDb.gitHubUserConnection.findMany.mockResolvedValue([
      {
        userId: OWNER_ID,
        githubUserId: "10",
        login: "ada",
        avatarUrl: null,
        profileUrl: null,
      },
    ]);

    const response = await branchReadService.listBranches(organizationId, {
      limit: 50,
      offset: 0,
    });

    const owner = response.items[0]?.ownerIdentity?.person;
    expect(owner?.avatarUrl).toBe(CLERK_AVATAR_URL);
    expect(owner?.id).toBe("10");
    expect(
      response.items[0]?.canonicalProjection?.common.people.owner?.person
        ?.avatarUrl
    ).toBe(CLERK_AVATAR_URL);
  });
});
