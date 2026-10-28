import { BranchPushSource } from "@repo/api/src/types/artifact";
import { BranchStatus } from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github";
import { ArtifactType, Prisma, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";
import { projectCloudOwnedBranchAssociatedPullRequests } from "@/app/branches/branch-associated-pull-request-projection";
import { branchSelectedPullRequestLateralSql } from "@/app/branches/branch-associated-pull-request-sql";
import { branchArtifactSelectForOrganization } from "@/app/branches/branch-read-selects";

/**
 * ISS-10298 — the in-database associated-PR selector and the TypeScript one are
 * declared twins, and the Branch list's Status and Pull-request facet counts now
 * come from the SQL half while the rendered row still comes from the TypeScript
 * half. A disagreement is therefore directly visible: a row counted under one
 * status while its own card shows another.
 *
 * Each case seeds one branch's `pull_request_detail` rows, runs BOTH selectors
 * over them, and asserts they agree — the expectation is the TypeScript
 * selector's own answer, never a hand-written id, so the test cannot drift into
 * restating whichever implementation was edited last.
 */

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;
const committedOrganizations = createCommittedTestOrganizationTracker();

const OPENED_AT = new Date("2026-07-01T00:00:00.000Z");
const MERGED_EARLY = new Date("2026-07-02T00:00:00.000Z");
const MERGED_LATE = new Date("2026-07-05T00:00:00.000Z");
const VERIFIED_EARLY = new Date("2026-07-03T00:00:00.000Z");
const VERIFIED_LATE = new Date("2026-07-04T00:00:00.000Z");

type SeedPullRequest = {
  number: number;
  prState?: GitHubPRState;
  isDraft?: boolean;
  mergedAt?: Date | null;
  closedAt?: Date | null;
  githubCreatedAt?: Date | null;
  lastVerifiedAt?: Date | null;
  title?: string | null;
  repositoryFullName?: string;
  /**
   * Give this snapshot its OWN installation-repository row rather than the
   * denormalized name. Two snapshots of one pull request are only reachable
   * that way: `pull_request_detail` is unique on `(repository_id, number)` and,
   * for rows with no `repository_id`, on
   * `(organization_id, repository_full_name, number)` — so duplicates exist
   * exactly when two repository rows share a normalized full name.
   */
  viaRepositoryRow?: boolean;
};

type ParityCase = {
  name: string;
  branchRepositoryFullName?: string;
  /**
   * Point the BRANCH at an installation-repository row whose `full_name`
   * differs from its denormalized `repository_full_name`. Ownership reads the
   * relation first, so the two names disagreeing is what makes the precedence
   * decidable rather than coincidental.
   */
  branchRepositoryRowFullName?: string;
  pullRequests: SeedPullRequest[];
  /**
   * Whether the two selectors must name the same `pull_request_detail` ROW.
   *
   * They always agree on the pull request SELECTED — its identity, number,
   * lifecycle and observation. They can disagree on WHICH tied snapshot of it
   * is the newest, because `compareSnapshotRecency` breaks an observation tie
   * on `JSON.stringify(item)` code units and the SQL twin breaks it on `id`.
   * That is reachable only between snapshots this test has already proven
   * lifecycle-identical, so nothing the Branch list reads can move; the row id
   * is not part of the list contract.
   */
  comparesSelectedSnapshotId?: false;
};

/**
 * Every shape the two selectors could disagree on, drawn from the divergences
 * ISS-10298 closed: duplicate-snapshot grouping, the conflicting-duplicate drop,
 * the `parseRepositoryFullName` identity test, and recency ties.
 */
const PARITY_CASES: ParityCase[] = [
  {
    name: "one observed open pull request",
    pullRequests: [{ number: 1, githubCreatedAt: OPENED_AT }],
  },
  {
    name: "duplicate snapshots that agree on lifecycle collapse to one",
    pullRequests: [
      {
        number: 1,
        viaRepositoryRow: true,
        githubCreatedAt: OPENED_AT,
        lastVerifiedAt: VERIFIED_EARLY,
        title: null,
      },
      {
        number: 1,
        viaRepositoryRow: true,
        githubCreatedAt: OPENED_AT,
        lastVerifiedAt: VERIFIED_LATE,
        title: "newest",
      },
    ],
  },
  {
    name: "tied observation instants disagreeing on lifecycle conflict",
    pullRequests: [
      {
        number: 1,
        viaRepositoryRow: true,
        githubCreatedAt: OPENED_AT,
        lastVerifiedAt: VERIFIED_LATE,
      },
      {
        number: 1,
        viaRepositoryRow: true,
        prState: GitHubPRState.Closed,
        closedAt: MERGED_EARLY,
        githubCreatedAt: OPENED_AT,
        lastVerifiedAt: VERIFIED_LATE,
      },
    ],
  },
  {
    name: "an unrankable null observation disagreeing on lifecycle conflicts",
    pullRequests: [
      {
        number: 1,
        viaRepositoryRow: true,
        githubCreatedAt: OPENED_AT,
        lastVerifiedAt: null,
      },
      {
        number: 1,
        viaRepositoryRow: true,
        prState: GitHubPRState.Closed,
        closedAt: MERGED_EARLY,
        githubCreatedAt: OPENED_AT,
        lastVerifiedAt: null,
      },
    ],
  },
  {
    name: "tied observation instants agreeing on lifecycle do not conflict",
    comparesSelectedSnapshotId: false,
    pullRequests: [
      {
        number: 1,
        viaRepositoryRow: true,
        githubCreatedAt: OPENED_AT,
        lastVerifiedAt: VERIFIED_LATE,
        title: "left",
      },
      {
        number: 1,
        viaRepositoryRow: true,
        githubCreatedAt: OPENED_AT,
        lastVerifiedAt: VERIFIED_LATE,
        title: "right",
      },
    ],
  },
  {
    name: "an over-segmented repository identity blocks the selection",
    pullRequests: [
      {
        number: 1,
        githubCreatedAt: OPENED_AT,
        repositoryFullName: "acme/widgets/extra",
      },
    ],
  },
  {
    name: "a trailing-slash dot-git identity normalizes to two segments",
    branchRepositoryFullName: "acme/widgets",
    pullRequests: [
      {
        number: 1,
        githubCreatedAt: OPENED_AT,
        repositoryFullName: "acme/widgets/.git",
      },
    ],
  },
  {
    name: "a non-positive number blocks the selection",
    pullRequests: [{ number: 0, githubCreatedAt: OPENED_AT }],
  },
  {
    name: "two observed open pull requests are ambiguous",
    pullRequests: [
      { number: 1, githubCreatedAt: OPENED_AT },
      { number: 2, githubCreatedAt: OPENED_AT },
    ],
  },
  {
    name: "the most recently merged terminal pull request wins",
    pullRequests: [
      {
        number: 1,
        prState: GitHubPRState.Merged,
        mergedAt: MERGED_EARLY,
        githubCreatedAt: OPENED_AT,
      },
      {
        number: 2,
        prState: GitHubPRState.Merged,
        mergedAt: MERGED_LATE,
        githubCreatedAt: OPENED_AT,
      },
    ],
  },
  {
    name: "an unwitnessed pull request is selected last",
    pullRequests: [{ number: 7 }],
  },
  {
    name: "a closed draft is an invalid lifecycle",
    pullRequests: [
      {
        number: 1,
        isDraft: true,
        prState: GitHubPRState.Closed,
        closedAt: MERGED_EARLY,
      },
    ],
  },
  {
    name: "ownership reads the branch's repository relation before the column",
    branchRepositoryFullName: "acme/stale-column",
    branchRepositoryRowFullName: "acme/renamed",
    pullRequests: [
      {
        number: 1,
        githubCreatedAt: OPENED_AT,
        repositoryFullName: "acme/renamed",
      },
    ],
  },
  {
    name: "a superseded terminal snapshot with no timestamp blocks selection",
    pullRequests: [
      {
        number: 1,
        viaRepositoryRow: true,
        prState: GitHubPRState.Closed,
        closedAt: MERGED_EARLY,
        githubCreatedAt: OPENED_AT,
        lastVerifiedAt: VERIFIED_LATE,
      },
      {
        number: 1,
        viaRepositoryRow: true,
        prState: GitHubPRState.Closed,
        closedAt: null,
        githubCreatedAt: OPENED_AT,
        lastVerifiedAt: VERIFIED_EARLY,
      },
    ],
  },
  {
    name: "a pull request on another repository is not owned",
    pullRequests: [
      {
        number: 1,
        githubCreatedAt: OPENED_AT,
        repositoryFullName: "acme/other",
      },
    ],
  },
];

type SelectedPullRequestRow = {
  id: string | null;
  number: number | null;
  observed: boolean | null;
  associated_count: number;
};

async function readSqlSelection(
  branchArtifactId: string
): Promise<SelectedPullRequestRow> {
  const rows = await withDb((db) =>
    db.$queryRaw<SelectedPullRequestRow[]>(Prisma.sql`
      SELECT
        selected_pull_request.id,
        selected_pull_request.number,
        selected_pull_request.observed,
        selected_pull_request.associated_count
      FROM artifacts a
      INNER JOIN branch_detail b ON b.artifact_id = a.id
      LEFT JOIN LATERAL (${branchSelectedPullRequestLateralSql()})
        selected_pull_request ON TRUE
      WHERE a.id = ${branchArtifactId}::uuid
    `)
  );
  const row = rows[0];
  if (!row) {
    throw new Error("Expected the seeded branch to be readable");
  }
  return row;
}

async function readTypeScriptSelection(
  organizationId: string,
  branchArtifactId: string
) {
  const row = await withDb((db) =>
    db.artifact.findFirst({
      where: { id: branchArtifactId, organizationId },
      select: branchArtifactSelectForOrganization(organizationId),
    })
  );
  if (!row?.branch) {
    throw new Error("Expected the seeded branch artifact to hydrate");
  }
  return projectCloudOwnedBranchAssociatedPullRequests(row);
}

async function seedBranch(
  organizationId: string,
  parityCase: ParityCase
): Promise<string> {
  const branchRepositoryFullName =
    parityCase.branchRepositoryFullName ?? "acme/widgets";
  const branchRepositoryId = parityCase.branchRepositoryRowFullName
    ? await createInstallationRepository(
        organizationId,
        `branch-${parityCase.branchRepositoryRowFullName}`,
        parityCase.branchRepositoryRowFullName
      )
    : null;
  return await withDb(async (db) => {
    const artifact = await db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.BRANCH,
        name: "feat/parity",
        status: BranchStatus.Open,
      },
      select: { id: true },
    });
    await db.branchDetail.create({
      data: {
        artifactId: artifact.id,
        organizationId,
        repositoryFullName: branchRepositoryFullName,
        branchName: "feat/parity",
        ...(branchRepositoryId ? { repositoryId: branchRepositoryId } : {}),
        firstPushedAt: OPENED_AT,
        pushSource: BranchPushSource.Session,
        lastActivityAt: OPENED_AT,
      },
      select: { artifactId: true },
    });
    let snapshotIndex = 0;
    for (const pullRequest of parityCase.pullRequests) {
      snapshotIndex += 1;
      const repositoryFullName =
        pullRequest.repositoryFullName ?? branchRepositoryFullName;
      const repositoryId = pullRequest.viaRepositoryRow
        ? await createInstallationRepository(
            organizationId,
            `${artifact.id}-${snapshotIndex}`,
            repositoryFullName
          )
        : null;
      await db.pullRequestDetail.create({
        data: {
          organizationId,
          branchArtifactId: artifact.id,
          number: pullRequest.number,
          prState: pullRequest.prState ?? GitHubPRState.Open,
          isDraft: pullRequest.isDraft ?? false,
          mergedAt: pullRequest.mergedAt ?? null,
          closedAt: pullRequest.closedAt ?? null,
          githubCreatedAt: pullRequest.githubCreatedAt ?? null,
          lastVerifiedAt:
            pullRequest.lastVerifiedAt === undefined
              ? VERIFIED_LATE
              : pullRequest.lastVerifiedAt,
          title: pullRequest.title === undefined ? null : pullRequest.title,
          ...(repositoryId ? { repositoryId } : { repositoryFullName }),
        },
        select: { id: true },
      });
    }
    return artifact.id;
  });
}

/**
 * One installation repository, so a snapshot can carry a `repository_id`.
 * `github_installations` is unique per organization, so the installation is
 * created once and every repository row hangs off it.
 */
async function createInstallationRepository(
  organizationId: string,
  uniqueSuffix: string,
  fullName: string
): Promise<string> {
  return await withDb(async (db) => {
    const existing = await db.gitHubInstallation.findFirst({
      where: { organizationId },
      select: { id: true },
    });
    const installationId =
      existing?.id ??
      (
        await db.gitHubInstallation.create({
          data: {
            organizationId,
            installationId: `installation-${organizationId}`,
            accountId: `account-${organizationId}`,
            accountLogin: "acme",
            accountType: "Organization",
            senderLogin: "fixture-user",
            senderId: `sender-${organizationId}`,
          },
          select: { id: true },
        })
      ).id;
    const repository = await db.gitHubInstallationRepository.create({
      data: {
        installationId,
        githubRepoId: `repo-${uniqueSuffix}`,
        fullName,
        name: fullName.split("/").at(-1) ?? fullName,
        owner: fullName.split("/")[0] ?? "acme",
        private: false,
      },
      select: { id: true },
    });
    return repository.id;
  });
}

describeIfDb("associated pull-request selector — SQL twin parity", () => {
  for (const parityCase of PARITY_CASES) {
    it(`agrees with the TypeScript selector: ${parityCase.name}`, async () => {
      const organizationId = await committedOrganizations.create();
      const branchArtifactId = await seedBranch(organizationId, parityCase);

      const [sqlSelection, typeScriptSelection] = await Promise.all([
        readSqlSelection(branchArtifactId),
        readTypeScriptSelection(organizationId, branchArtifactId),
      ]);

      if (parityCase.comparesSelectedSnapshotId === false) {
        // Both must still SELECT, and select the same pull request.
        expect(sqlSelection.id).not.toBeNull();
        expect(typeScriptSelection.selected).not.toBeNull();
      } else {
        expect(sqlSelection.id).toBe(
          typeScriptSelection.selected?.source.id ?? null
        );
      }
      expect(sqlSelection.number).toBe(
        typeScriptSelection.selected?.source.number ?? null
      );
      expect(sqlSelection.associated_count).toBe(
        typeScriptSelection.collection.items.length
      );
    });
  }

  it("matches by provider repository id across a rename and reinstall split", async () => {
    const organizationId = await committedOrganizations.create();
    const branchArtifactId = await seedReinstallSplit(organizationId);

    const [sqlSelection, typeScriptSelection] = await Promise.all([
      readSqlSelection(branchArtifactId),
      readTypeScriptSelection(organizationId, branchArtifactId),
    ]);

    expect(sqlSelection.id).toBe(typeScriptSelection.selected?.source.id);
    expect(sqlSelection.number).toBe(729);
  });

  it("agrees that a conflicting duplicate removes the associated item", async () => {
    const organizationId = await committedOrganizations.create();
    const conflicting = PARITY_CASES.find((parityCase) =>
      parityCase.name.startsWith("tied observation instants disagreeing")
    );
    if (!conflicting) {
      throw new Error("Expected the conflicting-duplicate case to exist");
    }
    const branchArtifactId = await seedBranch(organizationId, conflicting);

    const sqlSelection = await readSqlSelection(branchArtifactId);

    // The positive control for every `null` above: a conflict empties BOTH the
    // selection and the associated collection, where an ordinary duplicate
    // (covered above) empties neither.
    expect(sqlSelection.id).toBeNull();
    expect(sqlSelection.associated_count).toBe(0);
  });
});

async function seedReinstallSplit(organizationId: string): Promise<string> {
  return await withDb(async (db) => {
    const artifact = await db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.BRANCH,
        name: "feat/reinstall-split",
        status: BranchStatus.Open,
      },
      select: { id: true },
    });
    const oldInstallation = await db.gitHubInstallation.create({
      data: {
        organizationId: null,
        installationId: `old-${artifact.id}`,
        accountId: `old-${artifact.id}`,
        accountLogin: "acme",
        accountType: "Organization",
        senderLogin: "fixture-user",
        senderId: `old-${artifact.id}`,
      },
      select: { id: true },
    });
    const newInstallation = await db.gitHubInstallation.create({
      data: {
        organizationId,
        installationId: `new-${artifact.id}`,
        accountId: `new-${artifact.id}`,
        accountLogin: "acme",
        accountType: "Organization",
        senderLogin: "fixture-user",
        senderId: `new-${artifact.id}`,
      },
      select: { id: true },
    });
    const [oldRepository, newRepository] = await Promise.all([
      db.gitHubInstallationRepository.create({
        data: {
          installationId: oldInstallation.id,
          githubRepoId: `repo-${artifact.id}`,
          fullName: "acme/widgets-before-rename",
          name: "widgets-before-rename",
          owner: "acme",
          private: false,
        },
        select: { id: true },
      }),
      db.gitHubInstallationRepository.create({
        data: {
          installationId: newInstallation.id,
          githubRepoId: `repo-${artifact.id}`,
          fullName: "acme/widgets",
          name: "widgets",
          owner: "acme",
          private: false,
        },
        select: { id: true },
      }),
    ]);
    await db.branchDetail.create({
      data: {
        artifactId: artifact.id,
        organizationId,
        repositoryId: newRepository.id,
        repositoryFullName: "acme/widgets",
        branchName: "feat/reinstall-split",
        firstPushedAt: OPENED_AT,
        pushSource: BranchPushSource.Session,
        lastActivityAt: OPENED_AT,
      },
      select: { artifactId: true },
    });
    await db.pullRequestDetail.create({
      data: {
        organizationId,
        branchArtifactId: artifact.id,
        repositoryId: oldRepository.id,
        repositoryFullName: "acme/widgets-before-rename",
        number: 729,
        prState: GitHubPRState.Open,
        githubCreatedAt: OPENED_AT,
        lastVerifiedAt: VERIFIED_LATE,
      },
      select: { id: true },
    });
    return artifact.id;
  });
}
