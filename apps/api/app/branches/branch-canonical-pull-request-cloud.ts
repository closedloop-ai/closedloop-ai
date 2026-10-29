/**
 * ISS-8153 — the cloud-row composition of the branch-canonical resolution:
 * the shared owned-set selector supplies the fallback arm, the promotion
 * pointer the primary. Split from `branch-canonical-pull-request.ts` so the
 * pure predicates stay importable without pulling the projection/select
 * dependency chain into bundle- and mock-sensitive consumers.
 */
import { ArtifactType, type Prisma, type PrismaClient } from "@repo/database";
import {
  type CloudBranchProjectionInput,
  type CloudPullRequestProjectionInput,
  projectCloudBranchAssociatedPullRequests,
} from "./branch-associated-pull-request-projection";
import {
  type BranchCanonicalPullRequestDetail,
  type BranchCanonicalPullRequestResolution,
  branchOwnsPullRequestDetail,
  resolveBranchCanonicalPullRequestId,
} from "./branch-canonical-pull-request";

/**
 * Full cloud resolution: the shared owned-set selector supplies the fallback
 * arm, the pointer supplies the primary. `row` is the same shape the branch
 * projections consume, plus the pointer id.
 */
export function resolveCloudBranchCanonicalDetail<
  Detail extends CloudPullRequestProjectionInput &
    BranchCanonicalPullRequestDetail,
>(
  row: CloudBranchProjectionInput<Detail> & {
    currentPullRequestDetailId: string | null;
  }
): {
  detail: Detail | null;
  resolution: BranchCanonicalPullRequestResolution;
} {
  const selection = projectCloudBranchAssociatedPullRequests(row);
  const resolution = resolveBranchCanonicalPullRequestId({
    currentPullRequestDetailId: row.currentPullRequestDetailId,
    pullRequestDetails: row.pullRequestDetails,
    ownedSetSelectedId: selection.selected?.source.id ?? null,
  });
  const detail =
    resolution.id === null
      ? null
      : (row.pullRequestDetails.find((item) => item.id === resolution.id) ??
        null);
  return { detail, resolution };
}

/**
 * The PR-detail columns {@link resolveCloudBranchCanonicalDetail} decides from,
 * as a Prisma select. Shared so a caller cannot omit one of the eligibility
 * terms and have the arbitration silently rank on an absent fact.
 */
export const cloudBranchCanonicalPullRequestSelect = {
  id: true,
  branchArtifactId: true,
  repositoryId: true,
  repositoryFullName: true,
  // ISS-8901: `githubRepoId` is the provider identity `branchOwnsPullRequestDetail`
  // probes before falling back to the name, so every caller that arbitrates a
  // canonical PR must hydrate it or that probe silently degrades to the name arm.
  repository: { select: { fullName: true, githubRepoId: true } },
  number: true,
  title: true,
  htmlUrl: true,
  prState: true,
  isDraft: true,
  reviewDecision: true,
  githubCreatedAt: true,
  closedAt: true,
  mergedAt: true,
  lastVerifiedAt: true,
  fetchMechanism: true,
  githubId: true,
  additions: true,
  deletions: true,
  changedFiles: true,
} satisfies Prisma.PullRequestDetailSelect;

/** The full org-owned PR set for a Branch page, including non-selected PRs. */
export async function readAssociatedPullRequestAuthors(
  db: Pick<PrismaClient, "pullRequestDetail">,
  organizationId: string,
  branchIds: readonly string[],
  limit: number,
  cursorId?: string
) {
  return await db.pullRequestDetail.findMany({
    where: { organizationId, branchArtifactId: { in: [...branchIds] } },
    select: {
      id: true,
      branchArtifactId: true,
      authorProviderUserId: true,
      authorActorType: true,
      authorLogin: true,
    },
    orderBy: [{ branchArtifactId: "asc" }, { number: "asc" }, { id: "asc" }],
    take: limit,
    ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
  });
}

/** Associated PR base identities for bounded historical pusher recovery. */
export async function readAssociatedPullRequestsForPushBackfill(
  db: Pick<PrismaClient, "pullRequestDetail">,
  organizationId: string,
  branchArtifactId: string,
  limit: number
) {
  return await db.pullRequestDetail.findMany({
    where: { organizationId, branchArtifactId },
    select: {
      number: true,
      repositoryFullName: true,
      headRefName: true,
      headRepositoryFullName: true,
      repository: { select: { fullName: true } },
    },
    orderBy: [{ number: "asc" }, { id: "asc" }],
    take: limit,
  });
}

/**
 * ISS-12552: each branch's canonical pull request, resolved here so a
 * consumer never reads the promotion pointer itself (ISS-8521). Branches
 * outside the organization, or with no owned pull request, are absent.
 */
export async function readCloudBranchCanonicalPullRequests(
  db: Pick<PrismaClient, "artifact">,
  organizationId: string,
  branchIds: readonly string[]
): Promise<Map<string, { number: number; repositoryFullName: string | null }>> {
  if (branchIds.length === 0) {
    return new Map();
  }
  const branches = await db.artifact.findMany({
    where: {
      organizationId,
      id: { in: [...branchIds] },
      type: ArtifactType.BRANCH,
    },
    select: {
      id: true,
      pullRequestDetails: {
        where: { organizationId },
        select: cloudBranchCanonicalPullRequestSelect,
      },
      branch: {
        select: {
          currentPullRequestDetailId: true,
          repositoryId: true,
          repositoryFullName: true,
          repository: { select: { fullName: true, githubRepoId: true } },
        },
      },
    },
  });
  const canonical = new Map<
    string,
    { number: number; repositoryFullName: string | null }
  >();
  for (const artifact of branches) {
    const branch = artifact.branch;
    if (!branch) {
      continue;
    }
    const { detail } = resolveCloudBranchCanonicalDetail({
      id: artifact.id,
      currentPullRequestDetailId: branch.currentPullRequestDetailId,
      branch,
      pullRequestDetails: artifact.pullRequestDetails.filter((candidate) =>
        branchOwnsPullRequestDetail(branch, candidate)
      ),
    });
    if (detail) {
      canonical.set(artifact.id, {
        number: detail.number,
        repositoryFullName:
          detail.repository?.fullName ?? detail.repositoryFullName ?? null,
      });
    }
  }
  return canonical;
}
