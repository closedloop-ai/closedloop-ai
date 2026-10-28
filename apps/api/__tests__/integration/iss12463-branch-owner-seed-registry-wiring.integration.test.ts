import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FIRST_PUSHED_AT,
  HAS_DATABASE,
  readAssignee,
  seedBranch,
  seedCommit,
  seedPullRequestDetail,
} from "@/__tests__/utils/branch-identity-sql-fixture";
import {
  BranchOwnerLoginSeedError,
  seedBranchOwnersForLogin,
} from "@/app/branches/branch-owner-seed/branch-owner-seed";
import { syncClerkRegistryConnection } from "@/lib/github/github-clerk-registry";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestUser,
} from "../utils/db-helpers";

/**
 * ISS-12463 / PLN-2192 T-3.2b: a GitHub connection created for, or re-bound
 * to, a login seeds the branches that login's commits and PRs already resolve
 * (T-1.8), off the credential's response path, and a seed failure never fails
 * the credential resolution.
 */
const waitUntilMock = vi.hoisted(() => vi.fn());

vi.mock("@vercel/functions", () => ({ waitUntil: waitUntilMock }));

vi.mock(
  "@/app/branches/branch-owner-seed/branch-owner-seed",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/app/branches/branch-owner-seed/branch-owner-seed")
      >();
    return {
      ...actual,
      seedBranchOwnersForLogin: vi.fn(actual.seedBranchOwnersForLogin),
    };
  }
);

describe.skipIf(!HAS_DATABASE)("ISS-12463 GitHub connect owner seed", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    waitUntilMock.mockReset();
  });

  it("creating a connection seeds the branches the login's commits name", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const branchId = await seedBranch(organizationId, "connect", {
        firstPushedAt: null,
      });
      await seedCommit({
        organizationId,
        branchId,
        sha: "f".repeat(40),
        authorLogin: "connector",
        committedAt: FIRST_PUSHED_AT,
      });

      const synced = await syncClerkRegistryConnection(
        syncInput(organizationId, user.id, { id: 701, login: "connector" })
      );
      await drainWaitUntil();

      expect(synced?.connection).not.toBeNull();
      expect(await readAssignee(branchId)).toBe(user.id);
    });
  });

  it("re-binding a connection to a new login seeds the branches that login's PRs name", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      await withDb((db) =>
        db.gitHubUserConnection.create({
          data: {
            organizationId,
            userId: user.id,
            githubUserId: "700",
            login: "before",
            normalizedLogin: "before",
          },
          select: { id: true },
        })
      );
      const branchId = await seedBranch(organizationId, "rebind", {
        firstPushedAt: null,
      });
      await seedPullRequestDetail(organizationId, branchId, "rebind", "after");
      expect(await readAssignee(branchId)).toBeNull();

      const synced = await syncClerkRegistryConnection(
        syncInput(organizationId, user.id, { id: 702, login: "after" })
      );
      await drainWaitUntil();

      expect(synced?.login).toBe("after");
      expect(await readAssignee(branchId)).toBe(user.id);
    });
  });

  it("the credential resolves before the seed settles", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      let settleSeed: (stamped: number) => void = () => undefined;
      vi.mocked(seedBranchOwnersForLogin).mockReturnValueOnce(
        new Promise<number>((resolve) => {
          settleSeed = resolve;
        })
      );

      const synced = await syncClerkRegistryConnection(
        syncInput(organizationId, user.id, { id: 704, login: "patient" })
      );

      expect(synced?.connection?.login).toBe("patient");
      expect(seedBranchOwnersForLogin).toHaveBeenCalledWith(
        organizationId,
        "patient"
      );
      expect(waitUntilMock).toHaveBeenCalledTimes(1);
      settleSeed(0);
      await drainWaitUntil();
    });
  });

  it("a seed failure leaves the new connection resolved and logs the cause and progress", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      vi.mocked(seedBranchOwnersForLogin).mockRejectedValueOnce(
        new BranchOwnerLoginSeedError(new Error("seed failed"), {
          pagesCommitted: 2,
          stamped: 900,
        })
      );
      const warn = vi.spyOn(log, "warn");

      const synced = await syncClerkRegistryConnection(
        syncInput(organizationId, user.id, { id: 703, login: "unlucky" })
      );
      await drainWaitUntil();

      expect(synced?.connection?.login).toBe("unlucky");
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("failed to seed branch owners"),
        expect.objectContaining({
          status: "warn",
          organizationId,
          error: "seed failed",
          pagesCommitted: 2,
          stampedBeforeFailure: 900,
        })
      );
    });
  });
});

/** Settle every promise the registry handed to `waitUntil`. */
async function drainWaitUntil(): Promise<void> {
  for (const [scheduled] of waitUntilMock.mock.calls) {
    await scheduled;
  }
}

function syncInput(
  organizationId: string,
  userId: string,
  gitHubUser: { id: number; login: string }
) {
  return {
    organizationId,
    userId,
    scopes: ["repo"],
    octokit: {
      rest: {
        users: {
          getAuthenticated: vi.fn().mockResolvedValue({ data: gitHubUser }),
        },
      },
    } as never,
    now: new Date("2026-10-16T12:00:00.000Z"),
  };
}
