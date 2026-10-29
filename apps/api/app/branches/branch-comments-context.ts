import type { BranchSelectedPullRequestIdentity } from "@repo/api/src/types/branch-associated-pull-request";
import {
  normalizeRepoFullName,
  parseRepositoryFullName,
} from "@repo/api/src/types/branch-repository";
import { ArtifactType, type Prisma, type withDb } from "@repo/database";
import {
  projectCloudBranchAssociatedPullRequests,
  resolveCloudBranchAssociatedPullRequest,
} from "./branch-associated-pull-request-projection";
import { branchHasCloudEligibility } from "./cloud-branch-eligibility";

export type BranchCommentsClient = Parameters<typeof withDb>[0] extends (
  db: infer Db
) => unknown
  ? Db
  : never;

export type BranchCommentsContext = {
  branchId: string;
  repositoryFullName: string;
  prNumber: number | null;
  prUrl: string | null;
  owner: string;
  repo: string;
  pullRequestDetailId: string | null;
};

type BranchCommentsContextRow = Prisma.ArtifactGetPayload<{
  select: typeof branchCommentsContextSelect;
}>;

const branchCommentsContextSelect = {
  id: true,
  pullRequestDetails: {
    orderBy: [{ repositoryId: "asc" }, { number: "desc" }, { id: "asc" }],
    select: {
      id: true,
      branchArtifactId: true,
      repositoryId: true,
      repositoryFullName: true,
      number: true,
      title: true,
      htmlUrl: true,
      prState: true,
      isDraft: true,
      // ISS-8422: this service runs the same selector the list does, so it must
      // read the same evidence. Under-selecting these would let it classify an
      // LOC-carrying PR as unwitnessed and comment on a different one than the
      // branch row shows.
      additions: true,
      deletions: true,
      changedFiles: true,
      reviewDecision: true,
      githubCreatedAt: true,
      closedAt: true,
      mergedAt: true,
      lastVerifiedAt: true,
      repository: {
        select: { fullName: true, owner: true, name: true },
      },
    },
  },
  branch: {
    select: {
      deletedAt: true,
      // FR12 visibility SSOT (PRD-510) — mirrors branch-read-service; never the
      // headShaSource-derived gate (the stale_push trap).
      firstPushedAt: true,
      repositoryId: true,
      repositoryFullName: true,
      repository: {
        select: { fullName: true, owner: true, name: true },
      },
    },
  },
} satisfies Prisma.ArtifactSelect;

export async function findBranchCommentsContext(
  db: BranchCommentsClient,
  organizationId: string,
  branchId: string,
  selectedIdentity: BranchSelectedPullRequestIdentity | undefined
): Promise<BranchCommentsContext | null> {
  // Fail before projecting comments context or acquiring any provider client.
  if (!(await branchHasCloudEligibility(db, organizationId, branchId))) {
    return null;
  }
  const row = await db.artifact.findFirst({
    where: {
      id: branchId,
      organizationId,
      type: ArtifactType.BRANCH,
      branch: {
        deletedAt: null,
      },
    },
    select: branchCommentsContextSelect,
  });
  if (!hasBranchCommentsContextRow(row)) {
    return null;
  }
  const associated = projectCloudBranchAssociatedPullRequests(row);
  const resolved = resolveCloudBranchAssociatedPullRequest(
    row,
    associated,
    selectedIdentity
  );
  if (!resolved) {
    return null;
  }
  const selected = resolved.selected;
  const detail = selected?.source ?? null;
  const repositoryFullName = normalizeRepoFullName(
    selected?.repositoryFullName ??
      row.branch.repository?.fullName ??
      row.branch.repositoryFullName ??
      ""
  );
  const selectedRepository = detail?.repository ?? row.branch.repository;
  const repository =
    selectedRepository &&
    normalizeRepoFullName(selectedRepository.fullName) === repositoryFullName
      ? selectedRepository
      : await findExactOrganizationRepository(
          db,
          organizationId,
          repositoryFullName
        );
  // Kerensa, 2026-10-05: a branch can come straight from a developer machine, so
  // a repository no installation lists is still read by its full name.
  const identity =
    repository?.owner && repository.name
      ? { owner: repository.owner, repo: repository.name }
      : parseRepositoryFullName(repositoryFullName);
  if (!identity) {
    return null;
  }
  if (!(await branchHasCloudEligibility(db, organizationId, branchId))) {
    return null;
  }
  return {
    branchId: row.id,
    repositoryFullName,
    prNumber: detail?.number ?? null,
    prUrl: detail?.htmlUrl ?? null,
    owner: identity.owner,
    repo: identity.repo,
    pullRequestDetailId: detail?.id ?? null,
  };
}

function findExactOrganizationRepository(
  db: BranchCommentsClient,
  organizationId: string,
  repositoryFullName: string
) {
  if (!repositoryFullName) {
    return Promise.resolve(null);
  }
  return db.gitHubInstallationRepository.findFirst({
    where: {
      fullName: { equals: repositoryFullName, mode: "insensitive" },
      installation: { organizationId },
    },
    select: { fullName: true, owner: true, name: true },
  });
}

function hasBranchCommentsContextRow(
  row: BranchCommentsContextRow | null
): row is BranchCommentsContextRow & {
  branch: NonNullable<BranchCommentsContextRow["branch"]>;
} {
  return Boolean(row?.branch);
}
