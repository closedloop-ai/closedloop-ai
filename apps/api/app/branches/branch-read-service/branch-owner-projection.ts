import {
  BranchIdentityAvailability,
  type BranchOwnerIdentity,
  type BranchPerson,
  BranchPersonProvider,
} from "@repo/api/src/types/branch-identity";
import { GitHubActorType } from "@repo/api/src/types/github-actor";
import { BRANCH_PUSH_METHODS } from "@repo/api/src/types/session-artifact-link";
import { displayUserName } from "@/lib/user-display-name";
import type { NativeUser } from "./collaborator-projection";
import type { BranchIdentityInput } from "./identity-attribution";
import type { SessionBranchIdentityEvidence } from "./session-usage-window";

export type GitHubConnection = {
  userId: string;
  githubUserId: string;
  githubNodeId?: string | null;
  login: string;
  avatarUrl: string | null;
  profileUrl: string | null;
};

/** The session owner of the branch's earliest observed push. */
export function projectOwner(
  branch: OwnerChainInput,
  connectionsByUserId: ReadonlyMap<string, GitHubConnection>,
  usersById: ReadonlyMap<string, NativeUser>,
  links: readonly PushOwnerEvidence[] = []
): BranchOwnerIdentity {
  // ISS-11737: the owner is the session owner of the EARLIEST PUSH (operator
  // ruling 2026-09-30), and the push links carry that instant themselves. This
  // used to return here whenever `branch.firstPushedAt` was unset, discarding
  // push links the projector demonstrably HAD — their presence is exactly what
  // made the same return report `Incomplete` rather than `Complete`. A branch
  // whose push evidence never reached the column (the stamp is written by a
  // separate lane) was therefore rendered "Unattributed" with a resolvable
  // owner sitting in the links. The column is now a TIEBREAK input, not a
  // precondition; see `authoritativeOwnerLinks`.
  const branchPushLinks = links.filter(
    (link) =>
      link.targetId === branch.branchId &&
      isPushMethod(link.branchParticipationMethod)
  );
  const pushLinks = branchPushLinks.filter(
    (link) => link.branchParticipationObservedAt
  );
  const earliestLinks = authoritativeOwnerLinks(branch, pushLinks);
  const resolvedCandidates: BranchPerson[] = [];
  for (const link of earliestLinks) {
    const person = ownerPersonForLink(link, connectionsByUserId, usersById);
    if (!person) {
      continue;
    }
    resolvedCandidates.push(person);
  }
  resolvedCandidates.sort(compareOwnerPeople);
  const complete =
    resolvedCandidates.length > 0 &&
    resolvedCandidates.length === earliestLinks.length;
  // ISS-11737: a branch with NO push evidence on either input has a COMPLETE
  // corpus that names nobody — "we looked, a push was never observed" — and
  // must keep saying so. Only a branch that HAS push evidence and still cannot
  // name an owner is partial. Folding the two would report every pushless
  // branch as partial, which is the mirror of the defect being fixed.
  const hasPushEvidence =
    branch.firstPushedAt !== null || branchPushLinks.length > 0;
  // ISS-11737 (whitlockk review) — an UNDATED push link is dropped before the
  // earliest-push decision, so with no `firstPushedAt` to pin against a branch
  // carrying both a dated and an undated push cannot prove the dated one was
  // first: the undated one may be earlier and its owner unseen. The dated
  // push's owner stays the candidate; the corpus reports partial rather than a
  // completeness the evidence does not support. `firstPushedAt` settles the
  // question on its own, so a stamped branch is unaffected.
  const earliestPushIdentified =
    branch.firstPushedAt !== null ||
    branchPushLinks.length === pushLinks.length;
  return {
    // ISS-8188: `availability` and `person` are independent axes, and only the
    // first one is about the evidence. An earliest link that resolves to nobody
    // (a link with no user, a user outside this org) makes the corpus partial —
    // it does not unmake the owner the OTHER links did resolve. Nulling the
    // person for that reason reported a confident "Unattributed", which is a
    // stronger claim than the evidence supports and drops the owner out of the
    // Branches Owner facet entirely. Two earliest links resolving to DIFFERENT
    // people were already reconciled by taking the sorted-first candidate, so a
    // link resolving to nobody — strictly less information — must not be more
    // destructive than that. `Incomplete` stays the explicit signal that the
    // evidence was partial, the same way the Collaborators half already reports
    // a populated `people` list alongside an `Incomplete` source.
    availability:
      !hasPushEvidence || (complete && earliestPushIdentified)
        ? BranchIdentityAvailability.Complete
        : BranchIdentityAvailability.Incomplete,
    person: resolvedCandidates[0] ?? null,
  };
}

/**
 * The push links that speak for the EARLIEST push, which is the one whose
 * session owner owns the branch (operator ruling 2026-09-30).
 *
 * `firstPushedAt` stays the pin when the branch has one — it is the
 * server-observed instant and can be stamped by a lane that left no session
 * link, so it must keep winning over the links' own view. ISS-11737: when it is
 * absent, the earliest OBSERVED push among the links is the same question asked
 * of the evidence in hand, instead of a `getTime()` against `undefined` that
 * matched no link and silently emptied this set.
 */
function authoritativeOwnerLinks(
  branch: OwnerChainInput,
  pushLinks: readonly PushOwnerEvidence[]
): readonly PushOwnerEvidence[] {
  if (pushLinks.length <= 1) {
    return pushLinks;
  }
  const earliestPushedAt =
    branch.firstPushedAt?.getTime() ?? earliestObservedPush(pushLinks);
  return pushLinks.filter(
    (link) => link.branchParticipationObservedAt?.getTime() === earliestPushedAt
  );
}

/**
 * One GitHub login as a `BranchPerson`, or null when this organization has no
 * connected account for it.
 */
export function gitHubPersonForLogin(
  login: string,
  connectionsByLogin: ReadonlyMap<string, GitHubConnection>,
  usersById: ReadonlyMap<string, NativeUser>
): BranchPerson | null {
  const connection = connectionsByLogin.get(login);
  if (!connection) {
    return null;
  }
  const user = usersById.get(connection.userId);
  return {
    provider: BranchPersonProvider.GitHub,
    id: connection.githubUserId,
    userId: connection.userId,
    login: connection.login,
    displayName: user ? displayUserName(user) : undefined,
    avatarUrl: connection.avatarUrl ?? undefined,
    profileUrl: connection.profileUrl ?? undefined,
    actorType: GitHubActorType.User,
  };
}

/** The earliest `branchParticipationObservedAt` among dated push links. */
function earliestObservedPush(
  pushLinks: readonly SessionBranchIdentityEvidence[]
): number | undefined {
  let earliest: number | undefined;
  for (const link of pushLinks) {
    const observedAt = link.branchParticipationObservedAt?.getTime();
    if (
      observedAt !== undefined &&
      (earliest === undefined || observedAt < earliest)
    ) {
      earliest = observedAt;
    }
  }
  return earliest;
}

/** Match the canonical persisted push-observation methods. */
export function isPushMethod(method: string | null): boolean {
  return method !== null && BRANCH_PUSH_METHODS.has(method);
}

function ownerPersonForLink(
  link: PushOwnerEvidence,
  connectionsByUserId: ReadonlyMap<string, GitHubConnection>,
  usersById: ReadonlyMap<string, NativeUser>
): BranchPerson | null {
  return ownerPersonForUser(link.pusherUserId, connectionsByUserId, usersById);
}

/** Resolve an Owner account through the organization-scoped profile and connection maps. */
export function ownerPersonForUser(
  userId: string | null,
  connectionsByUserId: ReadonlyMap<string, GitHubConnection>,
  usersById: ReadonlyMap<string, OwnerUser>
): BranchPerson | null {
  if (!userId) {
    return null;
  }
  const connection = connectionsByUserId.get(userId);
  const user = usersById.get(userId);
  if (connection) {
    return {
      provider: BranchPersonProvider.GitHub,
      id: connection.githubUserId,
      userId,
      login: connection.login,
      displayName: user ? displayUserName(user) : undefined,
      avatarUrl: user?.avatarUrl ?? undefined,
      profileUrl: connection.profileUrl ?? undefined,
    };
  }
  return user
    ? {
        provider: BranchPersonProvider.ClosedLoop,
        id: user.id,
        userId,
        displayName: displayUserName(user),
        avatarUrl: user.avatarUrl ?? undefined,
      }
    : null;
}

function compareOwnerPeople(left: BranchPerson, right: BranchPerson): number {
  return ownerPersonSortKey(left).localeCompare(ownerPersonSortKey(right));
}

function ownerPersonSortKey(person: BranchPerson): string {
  return person.userId
    ? `${BranchPersonProvider.ClosedLoop}:${person.userId}`
    : `${person.provider}:${person.id}`;
}

/**
 * A Session→Branch link with the person who pushed: the linked session's
 * creator (`artifacts.created_by_id`, ISS-12251), not its assignee — a
 * reassignment moves the session's Owner, never who pushed.
 */
export type PushOwnerEvidence = SessionBranchIdentityEvidence & {
  pusherUserId: string | null;
};

export type OwnerUser = Pick<
  NativeUser,
  "id" | "email" | "firstName" | "lastName" | "avatarUrl"
>;

/**
 * The Branch Owner is the branch's own assignee (ISS-12463). It is a column
 * read, not inferred evidence, so it is always Complete: a NULL assignee, or one
 * outside `usersById`'s organization, is the existing Unattributed state.
 *
 * A connection row is scoped by its own organization, not its user's, so an
 * assignee missing from `usersById` is never resolved through one.
 */
export function assigneeOwnerIdentity(
  assigneeId: string | null,
  connectionsByUserId: ReadonlyMap<string, GitHubConnection>,
  usersById: ReadonlyMap<string, OwnerUser>
): BranchOwnerIdentity {
  return {
    availability: BranchIdentityAvailability.Complete,
    person:
      assigneeId && usersById.has(assigneeId)
        ? ownerPersonForUser(assigneeId, connectionsByUserId, usersById)
        : null,
  };
}

/** The evidence the push-owner chain reads; the assignee is not evidence. */
type OwnerChainInput = Pick<BranchIdentityInput, "branchId" | "firstPushedAt">;
