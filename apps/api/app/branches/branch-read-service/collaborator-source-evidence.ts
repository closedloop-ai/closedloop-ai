import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  BranchIdentityAvailability,
  type BranchPersonCandidate,
  BranchPersonProvider,
  isHumanGitHubActor,
} from "@repo/api/src/types/branch-identity";
import { isPlausibleBranchPushTransition } from "@repo/api/src/types/branch-push-contribution";
import {
  GitHubActorType,
  normalizeGitHubActorType,
} from "@repo/api/src/types/github-actor";
import { ExternalCommentProvider, type PrismaClient } from "@repo/database";
import { z } from "zod";
import { chunksOf } from "@/lib/chunks-of";
import { readAssociatedPullRequestAuthors } from "../branch-canonical-pull-request-cloud";
import {
  type PullRequestAuthorRow,
  type PushContributionRow,
  readPullRequestAuthorWindow,
  readPushContributionWindow,
} from "./contributor-source-windows";
import { BRANCH_CONTRIBUTOR_EVIDENCE_MAX_ROWS } from "./identity-evidence-limits";

export const BRANCH_CONTRIBUTOR_SOURCE_PAGE_LIMIT =
  BRANCH_CONTRIBUTOR_EVIDENCE_MAX_ROWS;
const PROVIDER_USER_ID_RE = /^\d+$/;
const availabilitySchema = z.enum(BranchIdentityAvailability);

type ContributorClient = Pick<
  PrismaClient,
  | "branchDetail"
  | "pullRequestDetail"
  | "branchPushContribution"
  | "externalCommentAuthor"
  | "$queryRaw"
>;

type ProviderAuthor = {
  providerUserId: string;
  providerLogin: string;
  displayName: string | null;
  avatarUrl: string | null;
  profileUrl: string | null;
  userId: string;
};

/** Known candidates plus independent capped/missing acquisition state. */
export type BranchContributorEvidence = {
  authors: BranchPersonCandidate[];
  pushes: BranchPersonCandidate[];
  authorAvailability: BranchIdentityAvailability;
  pushAvailability: BranchIdentityAvailability;
};

/** Read a bounded Branch page, replacing saturated flat sources with per-Branch windows. */
export async function readBranchContributorEvidence(
  db: ContributorClient,
  organizationId: string,
  branchIds: readonly string[]
): Promise<Map<string, BranchContributorEvidence>> {
  if (branchIds.length === 0) {
    return new Map();
  }
  const [branches, pullRequests, contributions] = await Promise.all([
    db.branchDetail.findMany({
      where: {
        organizationId,
        artifactId: { in: [...branchIds] },
        deletedAt: null,
        artifact: { type: ArtifactType.Branch },
      },
      select: {
        artifactId: true,
        pushCoverageAvailability: true,
      },
    }),
    readAssociatedPullRequestAuthors(
      db,
      organizationId,
      branchIds,
      BRANCH_CONTRIBUTOR_SOURCE_PAGE_LIMIT
    ),
    db.branchPushContribution.findMany({
      where: { organizationId, branchArtifactId: { in: [...branchIds] } },
      select: {
        id: true,
        branchArtifactId: true,
        repositoryFullName: true,
        refName: true,
        providerUserId: true,
        actorType: true,
        beforeSha: true,
        afterSha: true,
        branch: { select: { repositoryFullName: true, branchName: true } },
      },
      orderBy: [
        { branchArtifactId: "asc" },
        { observedAt: "asc" },
        { id: "asc" },
      ],
      take: BRANCH_CONTRIBUTOR_SOURCE_PAGE_LIMIT,
    }),
  ]);
  const windowInput = {
    organizationId,
    branchIds,
    limit: BRANCH_CONTRIBUTOR_SOURCE_PAGE_LIMIT,
  };
  const [authorWindow, pushWindow] = await Promise.all([
    pullRequests.length === BRANCH_CONTRIBUTOR_SOURCE_PAGE_LIMIT
      ? readPullRequestAuthorWindow(db, windowInput)
      : pullRequests,
    contributions.length === BRANCH_CONTRIBUTOR_SOURCE_PAGE_LIMIT
      ? readPushContributionWindow(db, windowInput)
      : { rows: contributions, mismatchedBranchIds: new Set<string>() },
  ]);
  const cappedPullRequests = capSourceRowsByBranch(authorWindow);
  const cappedContributions = capSourceRowsByBranch(pushWindow.rows);
  const providerIds = new Set<string>();
  for (const pullRequest of cappedPullRequests.rows) {
    if (pullRequest.authorProviderUserId) {
      providerIds.add(pullRequest.authorProviderUserId);
    }
  }
  for (const contribution of cappedContributions.rows) {
    providerIds.add(contribution.providerUserId);
  }
  const authorsByProviderId = new Map<string, ProviderAuthor>();
  for (const idChunk of chunksOf(
    [...providerIds],
    PROVIDER_ID_READ_CHUNK_SIZE
  )) {
    const authors = await db.externalCommentAuthor.findMany({
      where: {
        organizationId,
        provider: ExternalCommentProvider.GITHUB,
        providerUserId: { in: idChunk },
      },
      select: {
        providerUserId: true,
        providerLogin: true,
        displayName: true,
        avatarUrl: true,
        profileUrl: true,
        userId: true,
      },
    });
    for (const author of authors) {
      authorsByProviderId.set(author.providerUserId, author);
    }
  }
  const result = new Map<string, BranchContributorEvidence>(
    branches.map((branch) => [
      branch.artifactId,
      {
        authors: [],
        pushes: [],
        authorAvailability: cappedPullRequests.truncatedBranchIds.has(
          branch.artifactId
        )
          ? BranchIdentityAvailability.Incomplete
          : BranchIdentityAvailability.Complete,
        pushAvailability:
          cappedContributions.truncatedBranchIds.has(branch.artifactId) ||
          pushWindow.mismatchedBranchIds.has(branch.artifactId)
            ? BranchIdentityAvailability.Incomplete
            : pushCoverageAvailability(branch.pushCoverageAvailability),
      },
    ])
  );
  applyPullRequestAuthors(cappedPullRequests.rows, result, authorsByProviderId);
  applyPushContributions(cappedContributions.rows, result, authorsByProviderId);
  return result;
}

function applyPullRequestAuthors(
  pullRequests: readonly PullRequestAuthorRow[],
  result: Map<string, BranchContributorEvidence>,
  authorsByProviderId: ReadonlyMap<string, ProviderAuthor>
): void {
  for (const pullRequest of pullRequests) {
    const evidence = result.get(pullRequest.branchArtifactId);
    if (!evidence) {
      continue;
    }
    const author = pullRequest.authorProviderUserId
      ? authorsByProviderId.get(pullRequest.authorProviderUserId)
      : undefined;
    if (
      pullRequest.authorLogin === "ghost" ||
      author?.providerLogin === "ghost"
    ) {
      evidence.authorAvailability = BranchIdentityAvailability.Incomplete;
      continue;
    }
    const actorType = normalizeGitHubActorType(
      pullRequest.authorActorType ?? undefined
    );
    if (
      !(
        pullRequest.authorProviderUserId &&
        PROVIDER_USER_ID_RE.test(pullRequest.authorProviderUserId) &&
        actorType
      ) ||
      (!isHumanGitHubActor(actorType) && actorType !== GitHubActorType.Bot)
    ) {
      evidence.authorAvailability = BranchIdentityAvailability.Incomplete;
      continue;
    }
    if (actorType === GitHubActorType.Bot) {
      continue;
    }
    evidence.authors.push(
      providerCandidate(
        pullRequest.authorProviderUserId,
        actorType,
        authorsByProviderId.get(pullRequest.authorProviderUserId),
        pullRequest.authorLogin
      )
    );
  }
}

function applyPushContributions(
  contributions: readonly PushContributionRow[],
  result: Map<string, BranchContributorEvidence>,
  authorsByProviderId: ReadonlyMap<string, ProviderAuthor>
): void {
  for (const contribution of contributions) {
    const evidence = result.get(contribution.branchArtifactId);
    if (!evidence) {
      continue;
    }
    if (
      contribution.repositoryFullName !==
        contribution.branch.repositoryFullName ||
      contribution.refName !== contribution.branch.branchName ||
      !isPlausibleBranchPushTransition(
        contribution.beforeSha,
        contribution.afterSha
      )
    ) {
      evidence.pushAvailability = BranchIdentityAvailability.Incomplete;
      continue;
    }
    const actorType = normalizeGitHubActorType(contribution.actorType);
    if (
      !(PROVIDER_USER_ID_RE.test(contribution.providerUserId) && actorType) ||
      (!isHumanGitHubActor(actorType) && actorType !== GitHubActorType.Bot)
    ) {
      evidence.pushAvailability = BranchIdentityAvailability.Incomplete;
      continue;
    }
    if (actorType === GitHubActorType.Bot) {
      continue;
    }
    evidence.pushes.push(
      providerCandidate(
        contribution.providerUserId,
        actorType,
        authorsByProviderId.get(contribution.providerUserId)
      )
    );
  }
}

function providerCandidate(
  providerUserId: string,
  actorType: NonNullable<ReturnType<typeof normalizeGitHubActorType>>,
  author?: ProviderAuthor,
  fallbackLogin?: string | null
): BranchPersonCandidate {
  const displayName =
    author?.displayName ??
    (author || fallbackLogin ? undefined : providerUserId);
  return {
    actorType,
    person: {
      provider: BranchPersonProvider.GitHub,
      id: providerUserId,
      ...(author?.userId ? { userId: author.userId } : {}),
      ...(author?.providerLogin || fallbackLogin
        ? { login: author?.providerLogin ?? fallbackLogin ?? undefined }
        : {}),
      ...(displayName ? { displayName } : {}),
      ...(author?.avatarUrl ? { avatarUrl: author.avatarUrl } : {}),
      ...(author?.profileUrl ? { profileUrl: author.profileUrl } : {}),
      actorType,
    },
  };
}

function pushCoverageAvailability(
  raw: string | null
): BranchIdentityAvailability {
  const parsed = availabilitySchema.safeParse(raw);
  if (parsed.success) {
    return parsed.data;
  }
  return BranchIdentityAvailability.Incomplete;
}

function capSourceRowsByBranch<T extends { branchArtifactId: string }>(
  rows: readonly T[]
): { rows: T[]; truncatedBranchIds: Set<string> } {
  const counts = new Map<string, number>();
  const kept: T[] = [];
  const truncatedBranchIds = new Set<string>();
  for (const row of rows) {
    const count = (counts.get(row.branchArtifactId) ?? 0) + 1;
    counts.set(row.branchArtifactId, count);
    if (count > BRANCH_CONTRIBUTOR_SOURCE_PAGE_LIMIT) {
      truncatedBranchIds.add(row.branchArtifactId);
    } else {
      kept.push(row);
    }
  }
  return { rows: kept, truncatedBranchIds };
}

/** Maximum provider IDs bound by one org-scoped author profile read. */
export const PROVIDER_ID_READ_CHUNK_SIZE = 1000;
