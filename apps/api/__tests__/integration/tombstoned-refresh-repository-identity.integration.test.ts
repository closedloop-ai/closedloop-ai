/**
 * ISS-8901 — the tombstoned-refresh lane's repository identity, against a real
 * PostgreSQL.
 *
 * `GitHubInstallationRepository.id` is PER-INSTALLATION: uninstalling and
 * reinstalling the GitHub App mints a NEW row for the same `owner/repo` and
 * tombstones the old one. A branch created before the reinstall and a PR row
 * written after it therefore sit on two different ids for one repository — the
 * reinstall split — and every guarded write on this lane used to require those
 * two ids to be EQUAL.
 *
 * What this suite covers and what it deliberately does not. The unit suite
 * (`app/integrations/github/sync-service.test.ts`) is what pins that the lane's
 * three guarded writes actually carry `tombstonedRepositoryWhere`; asserting
 * that here would be asserting a mock. What only a real database can state is
 * whether the provider-id term MATCHES the split rows once they exist.
 *
 * Every case is written against rows this file builds, and the first carries
 * its own counterfactual: the same query under the surrogate-id term the lane
 * used to issue, which must match nothing. Without it, a `count: 1` proves only
 * that a row exists, not that the split is real.
 */
import { ArtifactType, GitHubInstallationStatus, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterAll, describe, expect, it } from "vitest";
import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";
import { tombstonedRepositoryWhere } from "@/app/branches/branch-canonical-pull-request";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

/**
 * The two names model a rename between installations; the stable provider id
 * is the authority that proves both rows represent one repository.
 */
const BRANCH_REPO_FULL_NAME = "Acme/Web";
const PR_REPO_FULL_NAME = "acme/web-renamed";
const PROVIDER_REPOSITORY_ID = "repo-github-1";

const OLD_TOMBSTONE_AT = new Date("2026-01-01T00:00:00.000Z");
const NEW_TOMBSTONE_AT = new Date("2026-06-01T00:00:00.000Z");
const STAMP = new Date("2026-07-06T09:00:00.000Z");

type ReinstallSplit = {
  organizationId: string;
  branchArtifactId: string;
  oldRepositoryId: string;
  newRepositoryId: string;
  pullRequestDetailId: string;
};

const tracker = createCommittedTestOrganizationTracker();

/**
 * Install -> uninstall -> reinstall -> uninstall. BOTH rows are tombstoned,
 * which is the shape this lane can actually reach: the detail write also
 * carries `removedAt: { not: null }`, so a PR sitting on a LIVE sibling row is
 * fail-closed for a separate reason this change does not touch.
 */
async function seedReinstallSplit(): Promise<ReinstallSplit> {
  const organizationId = await tracker.create();
  return await withDb(async (db) => {
    const oldInstallation = await db.gitHubInstallation.create({
      data: {
        installationId: `old-inst-${organizationId}`,
        accountId: "1",
        accountLogin: "acme",
        accountType: "Organization",
        senderLogin: "octocat",
        senderId: "2",
        status: GitHubInstallationStatus.UNINSTALLED,
      },
      select: { id: true },
    });
    const newInstallation = await db.gitHubInstallation.create({
      data: {
        organizationId,
        installationId: `new-inst-${organizationId}`,
        accountId: "1",
        accountLogin: "acme",
        accountType: "Organization",
        senderLogin: "octocat",
        senderId: "2",
        status: GitHubInstallationStatus.ACTIVE,
      },
      select: { id: true },
    });
    const oldRepository = await db.gitHubInstallationRepository.create({
      data: {
        installationId: oldInstallation.id,
        name: "web",
        owner: "acme",
        private: true,
        githubRepoId: PROVIDER_REPOSITORY_ID,
        fullName: BRANCH_REPO_FULL_NAME,
        removedAt: OLD_TOMBSTONE_AT,
      },
      select: { id: true },
    });
    const newRepository = await db.gitHubInstallationRepository.create({
      data: {
        installationId: newInstallation.id,
        name: "web-renamed",
        owner: "acme",
        private: true,
        githubRepoId: PROVIDER_REPOSITORY_ID,
        fullName: PR_REPO_FULL_NAME,
        removedAt: NEW_TOMBSTONE_AT,
      },
      select: { id: true },
    });
    const artifact = await db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.BRANCH,
        name: "feat/iss-8901",
        status: "OPEN",
        branch: {
          create: {
            organizationId,
            repositoryId: oldRepository.id,
            repositoryFullName: BRANCH_REPO_FULL_NAME,
            branchName: "feat/iss-8901",
          },
        },
      },
      select: { id: true },
    });
    const detail = await db.pullRequestDetail.create({
      data: {
        organizationId,
        branchArtifactId: artifact.id,
        repositoryId: newRepository.id,
        repositoryFullName: PR_REPO_FULL_NAME,
        number: 2294,
      },
      select: { id: true },
    });
    return {
      organizationId,
      branchArtifactId: artifact.id,
      oldRepositoryId: oldRepository.id,
      newRepositoryId: newRepository.id,
      pullRequestDetailId: detail.id,
    };
  });
}

describeIfDb("tombstoned refresh repository identity (ISS-8901)", () => {
  afterAll(async () => {
    await tracker.cleanup();
  });

  it("settles a reinstall-split PR that the surrogate-id term could not reach", async () => {
    const split = await seedReinstallSplit();

    // The counterfactual FIRST, so the rest cannot be read as a row that simply
    // happened to match: under the term this lane used to issue, the branch's
    // repository id and the PR's disagree and nothing is written.
    const surrogate = await withDb((db) =>
      db.pullRequestDetail.updateMany({
        where: {
          id: split.pullRequestDetailId,
          branchArtifactId: split.branchArtifactId,
          repositoryId: split.oldRepositoryId,
          repository: { removedAt: { not: null } },
        },
        data: { lastRefreshAttemptAt: STAMP },
      })
    );
    expect(surrogate.count).toBe(0);

    const byProviderId = await withDb((db) =>
      db.pullRequestDetail.updateMany({
        where: {
          id: split.pullRequestDetailId,
          branchArtifactId: split.branchArtifactId,
          repository: tombstonedRepositoryWhere({
            fullName: BRANCH_REPO_FULL_NAME,
            githubRepoId: PROVIDER_REPOSITORY_ID,
          }),
        },
        data: { lastRefreshAttemptAt: STAMP },
      })
    );
    expect(byProviderId.count).toBe(1);

    // Asserted after the call, off the store, rather than from the count alone.
    const settled = await withDb((db) =>
      db.pullRequestDetail.findUniqueOrThrow({
        where: { id: split.pullRequestDetailId },
        select: { lastRefreshAttemptAt: true, repositoryId: true },
      })
    );
    expect(settled.lastRefreshAttemptAt).toEqual(STAMP);
    // Still on the sibling installation row: the lane settles the split, it
    // does not quietly relink the PR to the branch's repository.
    expect(settled.repositoryId).toBe(split.newRepositoryId);
  });

  it("keeps the tombstone term binding on a live sibling row", async () => {
    const split = await seedReinstallSplit();
    await withDb((db) =>
      db.gitHubInstallationRepository.update({
        where: { id: split.newRepositoryId },
        data: { removedAt: null },
        select: { id: true },
      })
    );

    const result = await withDb((db) =>
      db.pullRequestDetail.updateMany({
        where: {
          id: split.pullRequestDetailId,
          branchArtifactId: split.branchArtifactId,
          repository: tombstonedRepositoryWhere({
            fullName: BRANCH_REPO_FULL_NAME,
            githubRepoId: PROVIDER_REPOSITORY_ID,
          }),
        },
        data: { lastRefreshAttemptAt: STAMP },
      })
    );

    // Provider-id keying follows the reinstall; `removedAt` keeps the user OAuth
    // lane from reaching the live App-covered sibling.
    expect(result.count).toBe(0);
    const untouched = await withDb((db) =>
      db.pullRequestDetail.findUniqueOrThrow({
        where: { id: split.pullRequestDetailId },
        select: { lastRefreshAttemptAt: true },
      })
    );
    expect(untouched.lastRefreshAttemptAt).toBeNull();
  });

  it("does not reach the same provider repository in another organization", async () => {
    const split = await seedReinstallSplit();
    const foreign = await seedReinstallSplit();

    // Deliberately NOT scoped by `branchArtifactId`. Keying on it would make the
    // org and name terms inert — every seeded split gets its own branch
    // artifact, so the foreign row is excluded before provider identity is read
    // and the case would pass with both of them deleted.
    const scoped = await withDb((db) =>
      db.pullRequestDetail.updateMany({
        where: {
          branchArtifact: { organizationId: split.organizationId },
          repository: tombstonedRepositoryWhere({
            fullName: BRANCH_REPO_FULL_NAME,
            githubRepoId: PROVIDER_REPOSITORY_ID,
          }),
        },
        data: { lastRefreshAttemptAt: STAMP },
      })
    );
    expect(scoped.count).toBe(1);

    const foreignDetail = await withDb((db) =>
      db.pullRequestDetail.findUniqueOrThrow({
        where: { id: foreign.pullRequestDetailId },
        select: { lastRefreshAttemptAt: true },
      })
    );
    expect(foreignDetail.lastRefreshAttemptAt).toBeNull();

    // The counterfactual that makes the assertion above mean something: a repo
    // provider id can appear once per installation, so without the org term the
    // same query reaches the OTHER organization's row.
    //
    // Asserted by the foreign row's own value flipping, not by a row count:
    // cases in this file accumulate rows against one database, so a count is a
    // function of how many cases ran before this one and would pin nothing.
    await withDb((db) =>
      db.pullRequestDetail.updateMany({
        where: {
          repository: tombstonedRepositoryWhere({
            fullName: BRANCH_REPO_FULL_NAME,
            githubRepoId: PROVIDER_REPOSITORY_ID,
          }),
        },
        data: { lastRefreshAttemptAt: STAMP },
      })
    );
    const foreignAfterUnscoped = await withDb((db) =>
      db.pullRequestDetail.findUniqueOrThrow({
        where: { id: foreign.pullRequestDetailId },
        select: { lastRefreshAttemptAt: true },
      })
    );
    expect(foreignAfterUnscoped.lastRefreshAttemptAt).toEqual(STAMP);
  });
});
