import {
  BranchCollaboratorSource,
  type BranchCollaborators,
  BranchIdentityAvailability,
  type BranchOwnerIdentity,
  type BranchPersonCandidate,
  BranchPersonProvider,
  isHumanGitHubActor,
  projectBranchPeople,
} from "@repo/api/src/types/branch-identity";
import { GitHubActorType } from "@repo/api/src/types/github-actor";
import { parseGitHubAuthorProviderDetailActorType } from "@/app/comments/github-author-provider-detail";
import {
  GITHUB_GHOST_AUTHOR_PREFIX,
  isGitHubShadowClerkId,
} from "@/app/comments/github-shadow-identity";
import { displayUserName } from "@/lib/user-display-name";
import type { BranchContributorEvidence } from "./collaborator-source-evidence";

type PlatformComment = { authorId: string };

/** Platform comment row shape selected by the page-wide identity read. */
export type PagePlatformComment = PlatformComment & {
  createdAt: Date;
  id: string;
  thread: { artifactId: string };
};

type GitHubComment = {
  threadProjection: {
    branchArtifactId: string;
    pullRequestDetailId: string;
    fetchResultReason: string | null;
  };
  externalAuthor: {
    providerUserId: string;
    providerLogin: string;
    displayName: string | null;
    avatarUrl: string | null;
    profileUrl: string | null;
    userId: string;
    providerDetail: unknown;
  } | null;
};

/** Stored people and acquisition gaps; a canonical proof cannot erase read caps. */
export type BranchCommentEvidence = {
  branchComments: PlatformComment[];
  sessionComments: PlatformComment[];
  githubComments: GitHubComment[];
  branchCapped: boolean;
  sessionCapped: boolean;
  githubCapped: boolean;
  /** The reader's per-PR lane proof (`pull-request-comment-proof-sql.ts`). */
  pullRequestAvailability: BranchIdentityAvailability;
};

export type NativeUser = {
  id: string;
  clerkId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
};

/** Merge existing comment and Owner evidence with PR authors and pushers. */
export function projectBranchCollaborators(input: {
  associatedPullRequestCount: number;
  ownerIdentity: BranchOwnerIdentity;
  evidence?: BranchCommentEvidence;
  contributors?: BranchContributorEvidence;
  pullRequestAuthors?: readonly BranchPersonCandidate[];
  usersById: ReadonlyMap<string, NativeUser>;
  verifiedGitHubUserIds: ReadonlyMap<string, string>;
}): BranchCollaborators {
  const { evidence, contributors, ownerIdentity, usersById } = input;
  const branchNative = nativeCandidates(
    evidence?.branchComments ?? [],
    usersById
  );
  const sessionNative = nativeCandidates(
    evidence?.sessionComments ?? [],
    usersById
  );
  const ownerCandidate = ownerIdentity.person?.userId
    ? nativeUserCandidate(ownerIdentity.person.userId, usersById)
    : null;
  const github = githubCandidates(evidence?.githubComments ?? []);
  const candidates = [
    ...branchNative,
    ...sessionNative,
    ...github,
    ...(ownerCandidate ? [ownerCandidate] : []),
    ...(input.pullRequestAuthors ?? []),
    ...(contributors?.authors ?? []),
    ...(contributors?.pushes ?? []),
  ].map((candidate) =>
    reconcileVerifiedProviderIdentity(candidate, input.verifiedGitHubUserIds)
  );
  return projectBranchPeople(candidates, {
    [BranchCollaboratorSource.PullRequestAuthors]:
      contributors?.authorAvailability ??
      (input.associatedPullRequestCount === 0
        ? BranchIdentityAvailability.Complete
        : BranchIdentityAvailability.Unavailable),
    [BranchCollaboratorSource.Pushes]:
      ownerIdentity.availability === BranchIdentityAvailability.Incomplete ||
      (ownerCandidate !== null && !ownerCandidate.person)
        ? BranchIdentityAvailability.Incomplete
        : (contributors?.pushAvailability ??
          BranchIdentityAvailability.Unavailable),
    [BranchCollaboratorSource.PullRequestComments]:
      pullRequestCommentAvailability(
        input.associatedPullRequestCount,
        evidence,
        github
      ),
    [BranchCollaboratorSource.BranchComments]:
      evidence?.branchCapped ||
      branchNative.some((candidate) => !candidate.person)
        ? BranchIdentityAvailability.Incomplete
        : BranchIdentityAvailability.Complete,
    [BranchCollaboratorSource.SessionComments]:
      evidence?.sessionCapped ||
      sessionNative.some((candidate) => !candidate.person)
        ? BranchIdentityAvailability.Incomplete
        : BranchIdentityAvailability.Complete,
  });
}

function nativeCandidates(
  comments: readonly PlatformComment[],
  usersById: ReadonlyMap<string, NativeUser>
): BranchPersonCandidate[] {
  return comments.map((comment) =>
    nativeUserCandidate(comment.authorId, usersById)
  );
}

function nativeUserCandidate(
  userId: string,
  usersById: ReadonlyMap<string, NativeUser>
): BranchPersonCandidate {
  const user = usersById.get(userId);
  return user && !isGitHubShadowClerkId(user.clerkId)
    ? {
        person: {
          provider: BranchPersonProvider.ClosedLoop,
          id: user.id,
          userId: user.id,
          displayName: displayUserName(user),
          avatarUrl: user.avatarUrl ?? undefined,
        },
      }
    : {};
}

function githubCandidates(
  comments: readonly GitHubComment[]
): BranchPersonCandidate[] {
  return comments.map((comment) => {
    const author = comment.externalAuthor;
    const actorType = parseGitHubAuthorProviderDetailActorType(
      author?.providerDetail
    );
    return author &&
      !author.providerUserId.startsWith(GITHUB_GHOST_AUTHOR_PREFIX)
      ? {
          actorType,
          person: {
            provider: BranchPersonProvider.GitHub,
            id: author.providerUserId,
            userId: author.userId,
            login: author.providerLogin,
            displayName: author.displayName ?? undefined,
            avatarUrl: author.avatarUrl ?? undefined,
            profileUrl: author.profileUrl ?? undefined,
            ...(actorType ? { actorType } : {}),
          },
        }
      : {};
  });
}

function reconcileVerifiedProviderIdentity(
  candidate: BranchPersonCandidate,
  verifiedUserIds: ReadonlyMap<string, string>
): BranchPersonCandidate {
  const person = candidate.person;
  if (person?.provider !== BranchPersonProvider.GitHub) {
    return candidate;
  }
  const userId = verifiedUserIds.get(person.id);
  return userId ? { ...candidate, person: { ...person, userId } } : candidate;
}

/** Acquisition proof never overrides a capped read or an unresolved comment identity. */
function pullRequestCommentAvailability(
  associatedPullRequestCount: number,
  evidence: BranchCommentEvidence | undefined,
  candidates: readonly BranchPersonCandidate[]
): BranchIdentityAvailability {
  if (
    evidence?.githubCapped ||
    candidates.some(isUnclassifiedGitHubCandidate)
  ) {
    return BranchIdentityAvailability.Incomplete;
  }
  if (evidence) {
    return evidence.pullRequestAvailability;
  }
  return associatedPullRequestCount === 0
    ? BranchIdentityAvailability.Complete
    : BranchIdentityAvailability.Incomplete;
}

function isUnclassifiedGitHubCandidate(
  candidate: BranchPersonCandidate
): boolean {
  if (!candidate.person) {
    return true;
  }
  return (
    candidate.actorType !== GitHubActorType.Bot &&
    !isHumanGitHubActor(candidate.actorType)
  );
}
