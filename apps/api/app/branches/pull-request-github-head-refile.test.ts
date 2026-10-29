import type { RepositoryDefaultAuthority } from "@repo/api/src/types/repository-default-identity";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  ensureBranch: vi.fn(),
  resolveAuthorities: vi.fn(),
  relink: vi.fn(),
  acquireLock: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

// ISS-12463: the branch-owner seed is raw SQL this stubbed database does not
// model; its wiring is pinned by the real-Postgres seed-wiring suite.
vi.mock("@/app/branches/branch-owner-seed/branch-owner-seed", () => ({
  seedBranchOwners: vi.fn().mockResolvedValue(0),
}));

vi.mock("@repo/database", () => ({ withDb: mocks.withDb }));

vi.mock("@repo/observability/log", () => ({
  log: { error: mocks.logError, warn: mocks.logWarn, info: vi.fn() },
}));

vi.mock(
  "@/app/agent-sessions/service/artifact-links/branch-links",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/app/agent-sessions/service/artifact-links/branch-links")
    >()),
    ensureBranchArtifactRow: mocks.ensureBranch,
  })
);

vi.mock("@/app/agent-sessions/service/artifact-links/shared", () => ({
  resolveRepositoryAuthorityByNames: mocks.resolveAuthorities,
}));

vi.mock("./pull-request-branch-relink", () => ({
  relinkPullRequestBranchInTransaction: mocks.relink,
}));

vi.mock("./pull-request-provider-lock", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pull-request-provider-lock")>()),
  acquirePullRequestProviderIdentityLockInTransaction: mocks.acquireLock,
}));

import { BranchMaterializationStatus } from "@/app/agent-sessions/service/artifact-links/branch-links";
import { CloudBranchNonMaterializationKind } from "./branch-write-eligibility";
import {
  refilePullRequestUnderGitHubHead,
  refilePullRequestUnderGitHubHeadInTransaction,
} from "./pull-request-github-head-refile";
import { pullRequestProviderLockTxOptions } from "./pull-request-provider-lock";

/**
 * ISS-12344, Perrin Upcott's ruling 2026-10-09 ("Move it"): a PR filed under a
 * Branch other than the head GitHub reports is re-filed under that head.
 *
 * The PR rows live in an in-memory table the relink double really moves, so a
 * case asserts where each PR ENDS UP, not only that a call happened.
 */
describe("refilePullRequestUnderGitHubHead", () => {
  let rows: Map<string, StoredPullRequest>;
  const db = {
    pullRequestDetail: {
      findFirst: vi.fn((args: { where: { id: string } }) =>
        Promise.resolve(toSelectedRow(rows.get(args.where.id)))
      ),
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    rows = new Map();
    mocks.withDb.mockImplementation((fn: (client: unknown) => unknown) =>
      fn(db)
    );
    mocks.withDb.tx.mockImplementation((fn: (client: unknown) => unknown) =>
      fn(db)
    );
    mocks.resolveAuthorities.mockImplementation(
      (_tx: unknown, _organizationId: string, names: string[]) =>
        Promise.resolve(new Map(names.map((name) => [name, AUTHORITY])))
    );
    mocks.ensureBranch.mockImplementation(
      (
        _tx: unknown,
        input: { repositoryFullName: string; branchName: string }
      ) =>
        Promise.resolve({
          status: BranchMaterializationStatus.Materialized,
          artifactId: branchArtifactIdFor(
            input.branchName,
            input.repositoryFullName
          ),
        })
    );
    mocks.relink.mockImplementation(
      (
        _tx: unknown,
        input: { pullRequestDetailId: string; branchArtifactId: string }
      ) => {
        const row = rows.get(input.pullRequestDetailId);
        if (row) {
          Object.assign(row, branchFor(input.branchArtifactId));
        }
        return Promise.resolve(true);
      }
    );
  });

  it("moves a PR under the head a GitHub read reports, creating that Branch when absent", async () => {
    rows.set("pr-1", storedRow({ number: 3932, branchName: SESSION_BRANCH }));

    const moved = await refilePullRequestUnderGitHubHead(
      ORG_ID,
      "pr-1",
      read("marisol/fea-4331-multibranch-session-cost")
    );

    expect(moved).toBe(true);
    expect(rows.get("pr-1")?.branchName).toBe(
      "marisol/fea-4331-multibranch-session-cost"
    );
    expect(mocks.withDb.tx).toHaveBeenCalledWith(
      expect.any(Function),
      pullRequestProviderLockTxOptions
    );
    expect(mocks.acquireLock).toHaveBeenCalledWith(db, {
      organizationId: ORG_ID,
      repositoryFullName: REPOSITORY,
      number: 3932,
    });
    expect(mocks.resolveAuthorities).toHaveBeenCalledWith(db, ORG_ID, [
      REPOSITORY,
    ]);
    expect(mocks.ensureBranch).toHaveBeenCalledWith(db, {
      organizationId: ORG_ID,
      projectId: PROJECT_ID,
      repositoryAuthority: AUTHORITY,
      repositoryFullName: REPOSITORY,
      branchName: "marisol/fea-4331-multibranch-session-cost",
      createWhenAbsent: true,
    });
    expect(mocks.relink).toHaveBeenCalledWith(db, {
      organizationId: ORG_ID,
      pullRequestDetailId: "pr-1",
      branchArtifactId: branchArtifactIdFor(
        "marisol/fea-4331-multibranch-session-cost"
      ),
      repositoryFullName: REPOSITORY,
      pullRequestNumber: 3932,
    });
  });

  it("moves each of two PRs one tool-use filed under one Branch to its own head", async () => {
    rows.set("pr-26", storedRow({ number: 26, branchName: SESSION_BRANCH }));
    rows.set("pr-27", storedRow({ number: 27, branchName: SESSION_BRANCH }));

    await refilePullRequestUnderGitHubHead(
      ORG_ID,
      "pr-26",
      read("fix/incremental-reindex-batched-deletes")
    );
    await refilePullRequestUnderGitHubHead(
      ORG_ID,
      "pr-27",
      read("fix/search-reads-during-reindex")
    );

    expect(rows.get("pr-26")?.branchName).toBe(
      "fix/incremental-reindex-batched-deletes"
    );
    expect(rows.get("pr-27")?.branchName).toBe(
      "fix/search-reads-during-reindex"
    );
    expect(mocks.acquireLock).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ number: 26 })
    );
    expect(mocks.acquireLock).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ number: 27 })
    );
  });

  it("leaves a PR already filed under its GitHub head where it is", async () => {
    rows.set("pr-1", storedRow({ number: 25, branchName: SESSION_BRANCH }));

    const moved = await refilePullRequestUnderGitHubHead(
      ORG_ID,
      "pr-1",
      read(SESSION_BRANCH)
    );

    expect(moved).toBe(false);
    expect(mocks.acquireLock).not.toHaveBeenCalled();
    expect(mocks.ensureBranch).not.toHaveBeenCalled();
    expect(mocks.relink).not.toHaveBeenCalled();
  });

  it("skips a head that lives in a fork", async () => {
    rows.set("pr-1", storedRow({ number: 2497, branchName: SESSION_BRANCH }));

    const moved = await refilePullRequestUnderGitHubHead(
      ORG_ID,
      "pr-1",
      read("read-config-gypi", "zcbenz/node-gyp")
    );

    expect(moved).toBe(false);
    expect(mocks.acquireLock).not.toHaveBeenCalled();
    expect(rows.get("pr-1")?.branchName).toBe(SESSION_BRANCH);
  });

  it("skips a read that could not report the head repository", async () => {
    rows.set("pr-1", storedRow({ number: 7, branchName: SESSION_BRANCH }));

    const moved = await refilePullRequestUnderGitHubHead(ORG_ID, "pr-1", {
      headBranch: "feat/elsewhere",
    });

    expect(moved).toBe(false);
    expect(mocks.acquireLock).not.toHaveBeenCalled();
  });

  it("re-checks under the provider lock and moves nothing another writer already moved", async () => {
    rows.set("pr-1", storedRow({ number: 26, branchName: SESSION_BRANCH }));
    mocks.acquireLock.mockImplementation(() => {
      const row = rows.get("pr-1");
      if (row) {
        row.branchName = "fix/incremental-reindex-batched-deletes";
      }
      return Promise.resolve();
    });

    const moved = await refilePullRequestUnderGitHubHead(
      ORG_ID,
      "pr-1",
      read("fix/incremental-reindex-batched-deletes")
    );

    expect(moved).toBe(false);
    expect(mocks.acquireLock).toHaveBeenCalledTimes(1);
    expect(mocks.relink).not.toHaveBeenCalled();
  });

  it("keeps the PR where it is when the head Branch cannot be materialized", async () => {
    rows.set("pr-1", storedRow({ number: 7, branchName: SESSION_BRANCH }));
    mocks.ensureBranch.mockResolvedValue({
      status: BranchMaterializationStatus.NotMaterialized,
      cause: CloudBranchNonMaterializationKind.AuthorityUnavailable,
    });

    const moved = await refilePullRequestUnderGitHubHead(
      ORG_ID,
      "pr-1",
      read("feat/head")
    );

    expect(moved).toBe(false);
    expect(mocks.relink).not.toHaveBeenCalled();
    expect(rows.get("pr-1")?.branchName).toBe(SESSION_BRANCH);
  });

  it("contains a failed move so the GitHub read that triggered it still lands", async () => {
    rows.set("pr-1", storedRow({ number: 7, branchName: SESSION_BRANCH }));
    mocks.relink.mockRejectedValue(new Error("relink lock timeout"));

    await expect(
      refilePullRequestUnderGitHubHead(ORG_ID, "pr-1", read("feat/head"))
    ).resolves.toBe(false);

    expect(mocks.logError).toHaveBeenCalledWith(
      "pull_request_github_head_refile_failed",
      expect.objectContaining({
        organizationId: ORG_ID,
        pullRequestDetailId: "pr-1",
      })
    );
  });

  // ISS-12344 review (PR #8704): older desktop builds filed PRs of other
  // repositories under the session's own Branch. A same-named Branch in
  // another repository is not this PR's head Branch.
  it("moves a PR filed under a same-named Branch of another repository", async () => {
    rows.set(
      "pr-1",
      storedRow({
        number: 2497,
        branchName: SHARED_BRANCH_NAME,
        branchRepositoryFullName: OTHER_REPOSITORY,
      })
    );

    const moved = await refilePullRequestUnderGitHubHead(
      ORG_ID,
      "pr-1",
      read(SHARED_BRANCH_NAME)
    );

    expect(moved).toBe(true);
    expect(mocks.ensureBranch).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        repositoryFullName: REPOSITORY,
        branchName: SHARED_BRANCH_NAME,
      })
    );
    expect(rows.get("pr-1")).toMatchObject({
      branchName: SHARED_BRANCH_NAME,
      branchRepositoryFullName: REPOSITORY,
    });
  });

  // ISS-12344 review (PR #8704): the reconciler reads head A and commits, the
  // branch is renamed to B on GitHub, and a newer webhook relinks the PR to B.
  // The reconciler's move then runs holding A and must not move it back.
  it("leaves the PR where a newer read filed it when this caller's read is older", async () => {
    rows.set(
      "pr-1",
      storedRow({
        number: 26,
        branchName: "fix/renamed-head",
        githubUpdatedAt: new Date(NEWER_READ_AT),
      })
    );

    const moved = await refilePullRequestUnderGitHubHead(
      ORG_ID,
      "pr-1",
      read("fix/original-head", REPOSITORY, OLDER_READ_AT)
    );

    expect(moved).toBe(false);
    expect(mocks.acquireLock).toHaveBeenCalledTimes(1);
    expect(mocks.ensureBranch).not.toHaveBeenCalled();
    expect(mocks.relink).not.toHaveBeenCalled();
    expect(rows.get("pr-1")?.branchName).toBe("fix/renamed-head");
  });

  it("moves the PR when the stored row is as old as this caller's read", async () => {
    rows.set(
      "pr-1",
      storedRow({
        number: 26,
        branchName: SESSION_BRANCH,
        githubUpdatedAt: new Date(OLDER_READ_AT),
      })
    );

    const moved = await refilePullRequestUnderGitHubHead(
      ORG_ID,
      "pr-1",
      read("fix/original-head", REPOSITORY, OLDER_READ_AT)
    );

    expect(moved).toBe(true);
    expect(rows.get("pr-1")?.branchName).toBe("fix/original-head");
  });

  it("moves nothing on a read with no timestamp once the stored row has one", async () => {
    rows.set(
      "pr-1",
      storedRow({
        number: 26,
        branchName: SESSION_BRANCH,
        githubUpdatedAt: new Date(OLDER_READ_AT),
      })
    );

    const moved = await refilePullRequestUnderGitHubHead(
      ORG_ID,
      "pr-1",
      read("fix/original-head")
    );

    expect(moved).toBe(false);
    expect(mocks.relink).not.toHaveBeenCalled();
  });

  // ISS-12344 review (PR #8704): a desktop session lane can create the same
  // head Branch at the same moment without this PR's provider lock. A create
  // inside the webhook's transaction would surface that P2002 there and abort
  // the whole pull_request delivery, projection write included.
  it("never creates the head Branch inside the webhook's transaction, so a concurrent create cannot abort the delivery", async () => {
    rows.set("pr-1", storedRow({ number: 7, branchName: SESSION_BRANCH }));
    mocks.ensureBranch.mockImplementation(
      (_tx: unknown, input: { createWhenAbsent: boolean }) =>
        input.createWhenAbsent
          ? Promise.reject(
              Object.assign(new Error("Unique constraint failed"), {
                code: "P2002",
              })
            )
          : Promise.resolve({
              status: BranchMaterializationStatus.NotMaterialized,
              cause: CloudBranchNonMaterializationKind.NotPushed,
            })
    );

    const moved = await refilePullRequestUnderGitHubHeadInTransaction(
      db as never,
      {
        organizationId: ORG_ID,
        pullRequestDetailId: "pr-1",
        head: {
          branchName: "feat/head",
          repositoryFullName: REPOSITORY,
          updatedAt: null,
        },
      }
    );

    expect(moved).toBe(false);
    expect(mocks.ensureBranch).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        branchName: "feat/head",
        createWhenAbsent: false,
      })
    );
    expect(mocks.relink).not.toHaveBeenCalled();
    expect(rows.get("pr-1")?.branchName).toBe(SESSION_BRANCH);
  });
});

const ORG_ID = "org-1";
const PROJECT_ID = "project-1";
const REPOSITORY = "closedloop-ai/lemoncrow";
const SESSION_BRANCH = "fix/code-engine-autosync-leak";
const OTHER_REPOSITORY = "closedloop-ai/closedloop-ai";
const SHARED_BRANCH_NAME = "fix/shared-branch-name";
const OLDER_READ_AT = "2026-10-09T20:00:00.000Z";
const NEWER_READ_AT = "2026-10-09T20:05:00.000Z";
const AUTHORITY = { repositoryId: "repo-1", authorities: [] };

type StoredPullRequest = {
  number: number;
  branchName: string;
  /** The repository of the Branch the PR is filed under. */
  branchRepositoryFullName: string;
  githubUpdatedAt: Date | null;
};

function storedRow(
  row: Pick<StoredPullRequest, "number" | "branchName"> &
    Partial<StoredPullRequest>
): StoredPullRequest {
  return {
    branchRepositoryFullName: REPOSITORY,
    githubUpdatedAt: null,
    ...row,
  };
}

function toSelectedRow(row: StoredPullRequest | undefined) {
  if (!row) {
    return null;
  }
  return {
    number: row.number,
    repositoryFullName: REPOSITORY,
    githubUpdatedAt: row.githubUpdatedAt,
    repository: null,
    branchArtifact: {
      projectId: PROJECT_ID,
      branch: {
        branchName: row.branchName,
        repositoryFullName: row.branchRepositoryFullName,
      },
    },
  };
}

function read(
  headBranch: string,
  headRepositoryFullName = REPOSITORY,
  updatedAt?: string
) {
  return {
    headBranch,
    headRepository: {
      repository: { fullName: headRepositoryFullName },
    } as RepositoryDefaultAuthority,
    ...(updatedAt === undefined ? {} : { updatedAt }),
  };
}

function branchArtifactIdFor(
  branchName: string,
  repositoryFullName = REPOSITORY
): string {
  return `branch:${repositoryFullName}:${branchName}`;
}

function branchFor(
  branchArtifactId: string
): Pick<StoredPullRequest, "branchName" | "branchRepositoryFullName"> {
  const [, repositoryFullName = "", branchName = ""] =
    BRANCH_ARTIFACT_ID_RE.exec(branchArtifactId) ?? [];
  return { branchName, branchRepositoryFullName: repositoryFullName };
}

const BRANCH_ARTIFACT_ID_RE = /^branch:([^:]+):(.+)$/;
