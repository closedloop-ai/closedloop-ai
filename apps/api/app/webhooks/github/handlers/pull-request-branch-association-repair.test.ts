import type { TransactionClient } from "@repo/database";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import { MAX_TRUSTED_FUTURE_SKEW_MS } from "@/lib/trusted-timestamp";
import { repairPullRequestBranchAssociationInTransaction } from "./pull-request-branch-association-repair";

const mocks = vi.hoisted(() => ({
  acquireProviderLock: vi.fn(),
  relinkBranch: vi.fn(),
  refileUnderHead: vi.fn(),
}));

vi.mock("@/app/branches/pull-request-provider-lock", () => ({
  acquirePullRequestProviderIdentityLockInTransaction:
    mocks.acquireProviderLock,
}));

vi.mock("@/app/branches/pull-request-branch-relink", () => ({
  relinkPullRequestBranchInTransaction: mocks.relinkBranch,
}));

vi.mock("@/app/branches/pull-request-github-head-refile", () => ({
  refilePullRequestUnderGitHubHeadInTransaction: mocks.refileUnderHead,
}));

describe("repairPullRequestBranchAssociationInTransaction", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(TRUSTED_NOW);
    mocks.acquireProviderLock.mockReset();
    mocks.acquireProviderLock.mockResolvedValue(undefined);
    mocks.relinkBranch.mockReset();
    mocks.relinkBranch.mockResolvedValue(undefined);
    mocks.refileUnderHead.mockReset();
    mocks.refileUnderHead.mockResolvedValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("declines the repair when the projection carries no organization", async () => {
    const tx = createRepairTx();

    await expect(
      repairPullRequestBranchAssociationInTransaction(
        asTransactionClient(tx),
        createRepairInput({ organizationId: null })
      )
    ).resolves.toBe(false);

    expect(mocks.acquireProviderLock).not.toHaveBeenCalled();
    expect(mocks.relinkBranch).not.toHaveBeenCalled();
    expect(tx.pullRequestDetail.findFirst).not.toHaveBeenCalled();
  });

  it("declines the repair when the projection has no branch to move off", async () => {
    const tx = createRepairTx();

    await expect(
      repairPullRequestBranchAssociationInTransaction(
        asTransactionClient(tx),
        createRepairInput({ currentBranchArtifactId: null })
      )
    ).resolves.toBe(false);

    expect(mocks.acquireProviderLock).not.toHaveBeenCalled();
    expect(mocks.relinkBranch).not.toHaveBeenCalled();
    expect(tx.pullRequestDetail.findFirst).not.toHaveBeenCalled();
  });

  // ISS-7973, OPEN PRODUCT DECISION — these assertions pin what the code does
  // TODAY, not what it should do. The throw below propagates out of the webhook
  // transaction to the route's catch at apps/api/app/webhooks/github/route.ts
  // :169-177, which answers 500, so GitHub re-delivers the same payload and the
  // same untrustworthy timestamp fails again. Whether an untrustworthy
  // producer clock should instead be a 200-skip (accept the delivery, do no
  // repair) is unresolved on ISS-7973; a human decides it on the PR. Note this
  // is the one throw here driven by payload-supplied input rather than by a
  // value that is impossible by construction. If the decision changes, these
  // three cases must be rewritten deliberately — do not weaken them to green a
  // behaviour change.
  it("throws today on an unparseable incoming timestamp, before the provider lock is taken", async () => {
    const tx = createRepairTx();

    await expect(
      repairPullRequestBranchAssociationInTransaction(
        asTransactionClient(tx),
        createRepairInput({ incomingUpdatedAt: new Date("garbage") })
      )
    ).rejects.toThrow(UNTRUSTED_TIMESTAMP_MESSAGE);

    expect(mocks.acquireProviderLock).not.toHaveBeenCalled();
    expect(mocks.relinkBranch).not.toHaveBeenCalled();
  });

  it("throws today one millisecond past the trusted future skew, before the provider lock is taken", async () => {
    const tx = createRepairTx();

    await expect(
      repairPullRequestBranchAssociationInTransaction(
        asTransactionClient(tx),
        createRepairInput({
          incomingUpdatedAt: new Date(
            TRUSTED_NOW.getTime() + MAX_TRUSTED_FUTURE_SKEW_MS + 1
          ),
        })
      )
    ).rejects.toThrow(UNTRUSTED_TIMESTAMP_MESSAGE);

    expect(mocks.acquireProviderLock).not.toHaveBeenCalled();
    expect(mocks.relinkBranch).not.toHaveBeenCalled();
  });

  it("accepts a timestamp exactly at the trusted future skew boundary", async () => {
    const tx = createRepairTx();

    await expect(
      repairPullRequestBranchAssociationInTransaction(
        asTransactionClient(tx),
        createRepairInput({
          incomingUpdatedAt: new Date(
            TRUSTED_NOW.getTime() + MAX_TRUSTED_FUTURE_SKEW_MS
          ),
        })
      )
    ).resolves.toBe(true);

    expect(mocks.acquireProviderLock).toHaveBeenCalledTimes(1);
    expect(mocks.relinkBranch).toHaveBeenCalledTimes(1);
  });

  it("declines the repair when the pull request projection is gone", async () => {
    const tx = createRepairTx({ pullRequest: null });

    await expect(
      repairPullRequestBranchAssociationInTransaction(
        asTransactionClient(tx),
        createRepairInput()
      )
    ).resolves.toBe(false);

    expect(mocks.acquireProviderLock).toHaveBeenCalledTimes(1);
    expect(mocks.relinkBranch).not.toHaveBeenCalled();
    expect(tx.branchDetail.findFirst).not.toHaveBeenCalled();
  });

  // This arm is a post-lock RACE check, not a plain staleness refusal. The
  // caller already rejects `incoming < stored` before it ever reaches this
  // function (isAuthoritativeRelinkDelivery, pull-request-handler.ts:578-583),
  // so the re-read here exists only to catch a writer that won the provider
  // lock first and advanced githubUpdatedAt while this delivery queued behind
  // it. That is why the read must stay ordered AFTER the lock acquisition, and
  // why the arm is not redundant with the caller's filter.
  it("refuses the relink when a competing writer advanced githubUpdatedAt while this delivery waited on the provider lock", async () => {
    const tx = createRepairTx({
      pullRequest: {
        branchArtifactId: PROJECTED_BRANCH_ARTIFACT_ID,
        githubUpdatedAt: new Date(INCOMING_UPDATED_AT.getTime() + 1),
      },
    });

    await expect(
      repairPullRequestBranchAssociationInTransaction(
        asTransactionClient(tx),
        createRepairInput()
      )
    ).resolves.toBe(false);

    expect(mocks.acquireProviderLock).toHaveBeenCalledTimes(1);
    expect(firstCallOrder(mocks.acquireProviderLock)).toBeLessThan(
      firstCallOrder(tx.pullRequestDetail.findFirst)
    );
    expect(mocks.relinkBranch).not.toHaveBeenCalled();
    expect(tx.branchDetail.findFirst).not.toHaveBeenCalled();
  });

  it("repairs when a competing writer left githubUpdatedAt equal to this delivery", async () => {
    const tx = createRepairTx({
      pullRequest: {
        branchArtifactId: PROJECTED_BRANCH_ARTIFACT_ID,
        githubUpdatedAt: new Date(INCOMING_UPDATED_AT.getTime()),
      },
    });

    await expect(
      repairPullRequestBranchAssociationInTransaction(
        asTransactionClient(tx),
        createRepairInput()
      )
    ).resolves.toBe(true);

    expect(mocks.relinkBranch).toHaveBeenCalledTimes(1);
  });

  // ISS-12344 (Perrin Upcott's ruling 2026-10-09, "Move it") replaced the
  // decline this case used to pin: the shared GitHub-head refile looks the
  // head Branch up by repository name and moves the PR under it.
  it("hands the PR to the GitHub-head refile when no Branch carries this repository id", async () => {
    const tx = createRepairTx({ branch: null });
    const client = asTransactionClient(tx);
    mocks.refileUnderHead.mockResolvedValue(true);

    await expect(
      repairPullRequestBranchAssociationInTransaction(
        client,
        createRepairInput()
      )
    ).resolves.toBe(true);

    expect(mocks.refileUnderHead).toHaveBeenCalledWith(client, {
      organizationId: ORGANIZATION_ID,
      pullRequestDetailId: PULL_REQUEST_DETAIL_ID,
      head: {
        branchName: HEAD_BRANCH,
        repositoryFullName: REPOSITORY_FULL_NAME,
        updatedAt: INCOMING_UPDATED_AT,
      },
    });
    expect(mocks.relinkBranch).not.toHaveBeenCalled();
  });

  it("reports no reload when the GitHub-head refile moved nothing", async () => {
    const tx = createRepairTx({ branch: null });

    await expect(
      repairPullRequestBranchAssociationInTransaction(
        asTransactionClient(tx),
        createRepairInput()
      )
    ).resolves.toBe(false);

    expect(mocks.refileUnderHead).toHaveBeenCalledTimes(1);
    expect(mocks.relinkBranch).not.toHaveBeenCalled();
  });

  it.each([
    { name: "a head in a fork", headRepositoryFullName: "contributor/widgets" },
    { name: "no reported head repository", headRepositoryFullName: null },
  ])(
    "leaves the PR where it is for $name, even when a same-named Branch exists",
    async ({ headRepositoryFullName }) => {
      const tx = createRepairTx();

      await expect(
        repairPullRequestBranchAssociationInTransaction(
          asTransactionClient(tx),
          createRepairInput({ headRepositoryFullName })
        )
      ).resolves.toBe(false);

      expect(mocks.acquireProviderLock).not.toHaveBeenCalled();
      expect(mocks.relinkBranch).not.toHaveBeenCalled();
      expect(mocks.refileUnderHead).not.toHaveBeenCalled();
    }
  );

  it("declines the repair when the projection already points at the authoritative Branch", async () => {
    const tx = createRepairTx({
      branch: { artifactId: PROJECTED_BRANCH_ARTIFACT_ID },
    });

    await expect(
      repairPullRequestBranchAssociationInTransaction(
        asTransactionClient(tx),
        createRepairInput()
      )
    ).resolves.toBe(false);

    expect(mocks.relinkBranch).not.toHaveBeenCalled();
  });

  it("moves the projection onto the authoritative Branch and reports the reload", async () => {
    const tx = createRepairTx();
    const client = asTransactionClient(tx);

    await expect(
      repairPullRequestBranchAssociationInTransaction(
        client,
        createRepairInput()
      )
    ).resolves.toBe(true);

    expect(mocks.acquireProviderLock).toHaveBeenCalledWith(client, {
      organizationId: ORGANIZATION_ID,
      repositoryFullName: REPOSITORY_FULL_NAME,
      number: PULL_REQUEST_NUMBER,
    });
    expect(tx.pullRequestDetail.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: PULL_REQUEST_DETAIL_ID,
          organizationId: ORGANIZATION_ID,
        },
      })
    );
    expect(tx.branchDetail.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: ORGANIZATION_ID,
          repositoryId: REPOSITORY_ID,
          branchName: HEAD_BRANCH,
        },
      })
    );
    expect(mocks.refileUnderHead).not.toHaveBeenCalled();
    expect(mocks.relinkBranch).toHaveBeenCalledTimes(1);
    expect(mocks.relinkBranch).toHaveBeenCalledWith(client, {
      organizationId: ORGANIZATION_ID,
      pullRequestDetailId: PULL_REQUEST_DETAIL_ID,
      branchArtifactId: AUTHORITATIVE_BRANCH_ARTIFACT_ID,
      repositoryFullName: REPOSITORY_FULL_NAME,
      pullRequestNumber: PULL_REQUEST_NUMBER,
    });
  });
});

const ORGANIZATION_ID = "019ff7a1-2c40-7c11-9f1e-2b7a8f2c4d10";
const REPOSITORY_ID = "019ff7a1-4b8e-7f22-8a3d-6c9e1b0f7a55";
const REPOSITORY_FULL_NAME = "acme/widgets";
const HEAD_BRANCH = "feat/iss-7973";
const PULL_REQUEST_NUMBER = 7973;
const PULL_REQUEST_DETAIL_ID = "019ff7a1-6d02-70aa-b4c8-51d3e9a26b7f";

/** What the caller believes the projection points at. */
const CURRENT_BRANCH_ARTIFACT_ID = "019ff7a1-8f14-7333-9d6b-0e2a75c1f488";
/** What the stored projection row actually points at — arm (e) compares this. */
const PROJECTED_BRANCH_ARTIFACT_ID = "019ff7a1-a126-7444-bf0a-3c81d6e29a02";
/** What the provider says the head ref resolves to. */
const AUTHORITATIVE_BRANCH_ARTIFACT_ID = "019ff7a1-c238-7555-8e75-9b40f7c3d611";

const TRUSTED_NOW = new Date("2026-08-25T12:00:00.000Z");
const INCOMING_UPDATED_AT = new Date("2026-08-25T11:30:00.000Z");
const STORED_UPDATED_AT = new Date("2026-08-25T10:00:00.000Z");

/** Not exported by the module under test, so it is spelled once here. */
const UNTRUSTED_TIMESTAMP_MESSAGE =
  "pull request relink timestamp is not trustworthy";

type RepairInput = Parameters<
  typeof repairPullRequestBranchAssociationInTransaction
>[1];

type StoredPullRequest = {
  branchArtifactId: string | null;
  githubUpdatedAt: Date | null;
};

type AuthoritativeBranch = { artifactId: string };

type RepairTx = {
  pullRequestDetail: { findFirst: Mock };
  branchDetail: { findFirst: Mock };
};

function createRepairInput(overrides: Partial<RepairInput> = {}): RepairInput {
  return {
    organizationId: ORGANIZATION_ID,
    repositoryId: REPOSITORY_ID,
    repositoryFullName: REPOSITORY_FULL_NAME,
    headBranch: HEAD_BRANCH,
    headRepositoryFullName: REPOSITORY_FULL_NAME,
    pullRequestNumber: PULL_REQUEST_NUMBER,
    pullRequestDetailId: PULL_REQUEST_DETAIL_ID,
    currentBranchArtifactId: CURRENT_BRANCH_ARTIFACT_ID,
    incomingUpdatedAt: INCOMING_UPDATED_AT,
    ...overrides,
  };
}

function createRepairTx(rows?: {
  pullRequest?: StoredPullRequest | null;
  branch?: AuthoritativeBranch | null;
}): RepairTx {
  const pullRequest =
    rows?.pullRequest === undefined
      ? {
          branchArtifactId: PROJECTED_BRANCH_ARTIFACT_ID,
          githubUpdatedAt: STORED_UPDATED_AT,
        }
      : rows.pullRequest;
  const branch =
    rows?.branch === undefined
      ? { artifactId: AUTHORITATIVE_BRANCH_ARTIFACT_ID }
      : rows.branch;
  return {
    pullRequestDetail: { findFirst: vi.fn().mockResolvedValue(pullRequest) },
    branchDetail: { findFirst: vi.fn().mockResolvedValue(branch) },
  };
}

function asTransactionClient(tx: RepairTx): TransactionClient {
  return tx as unknown as TransactionClient;
}

/** Vitest's deterministic invocation sequence number, never a clock reading. */
function firstCallOrder(mock: Mock): number {
  return mock.mock.invocationCallOrder[0];
}
