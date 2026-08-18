import {
  type GitHubActorType,
  GitHubActorType as GitHubActorTypeValue,
} from "./github-actor.ts";

/** Availability of a canonical Branch identity projection. */
export const BranchIdentityAvailability = {
  Complete: "complete",
  Incomplete: "incomplete",
  Unavailable: "unavailable",
} as const;
export type BranchIdentityAvailability =
  (typeof BranchIdentityAvailability)[keyof typeof BranchIdentityAvailability];

/** Stable identity namespace for a person in a Branch projection. */
export const BranchPersonProvider = {
  ClosedLoop: "closedloop",
  GitHub: "github",
} as const;
export type BranchPersonProvider =
  (typeof BranchPersonProvider)[keyof typeof BranchPersonProvider];

/** The persisted evidence sources that contribute to Collaborators. */
export const BranchCollaboratorSource = {
  PullRequestComments: "pull_request_comments",
  BranchComments: "branch_comments",
  SessionComments: "session_comments",
} as const;
export type BranchCollaboratorSource =
  (typeof BranchCollaboratorSource)[keyof typeof BranchCollaboratorSource];

/** Provider-qualified stable person identity shared by cloud and Desktop. */
export type BranchPerson = {
  provider: BranchPersonProvider;
  /** Stable ID in `provider`; never a login or display name. */
  id: string;
  /** ClosedLoop user ID, when persisted evidence links provider identities. */
  userId?: string;
  login?: string;
  displayName?: string;
  avatarUrl?: string;
  profileUrl?: string;
  actorType?: GitHubActorType;
};

/** Canonical Owner plus the availability of the evidence that established it. */
export type BranchOwnerIdentity = {
  availability: BranchIdentityAvailability;
  person: BranchPerson | null;
};

/** Canonical Collaborators union plus per-source evidence availability. */
export type BranchCollaborators = {
  availability: BranchIdentityAvailability;
  people: BranchPerson[];
  sources: Record<BranchCollaboratorSource, BranchIdentityAvailability>;
};

/** Candidate accepted by the deterministic Collaborators projector. */
export type BranchPersonCandidate = {
  person?: BranchPerson;
  actorType?: GitHubActorType;
};

/**
 * Produces a stable, non-bot people union. GitHub candidates without a known
 * human actor type are excluded and make the result incomplete; ClosedLoop
 * users are already authenticated people. Linked provider identities dedupe
 * through `userId`, while unlinked identities remain provider-qualified.
 */
export function projectBranchPeople(
  candidates: readonly BranchPersonCandidate[],
  sources: Record<BranchCollaboratorSource, BranchIdentityAvailability>
): BranchCollaborators {
  const peopleByKey = new Map<string, BranchPerson>();
  let hasUnclassifiedCandidate = false;
  for (const candidate of candidates) {
    const person = candidate.person;
    if (!person) {
      hasUnclassifiedCandidate = true;
      continue;
    }
    if (person.provider === BranchPersonProvider.GitHub) {
      const actorType = candidate.actorType ?? person.actorType;
      if (actorType === GitHubActorTypeValue.Bot) {
        continue;
      }
      if (!isHumanGitHubActor(actorType)) {
        hasUnclassifiedCandidate = true;
        continue;
      }
    }
    const key = person.userId
      ? `${BranchPersonProvider.ClosedLoop}:${person.userId}`
      : `${person.provider}:${person.id}`;
    const existing = peopleByKey.get(key);
    peopleByKey.set(key, existing ? preferPerson(existing, person) : person);
  }
  const people = [...peopleByKey.values()].sort(compareBranchPeople);
  const sourceAvailability = Object.values(sources);
  const unavailableSources = sourceAvailability.filter(
    (value) => value === BranchIdentityAvailability.Unavailable
  ).length;
  let availability: BranchIdentityAvailability =
    BranchIdentityAvailability.Complete;
  if (unavailableSources === sourceAvailability.length && people.length === 0) {
    availability = BranchIdentityAvailability.Unavailable;
  } else if (
    hasUnclassifiedCandidate ||
    sourceAvailability.some(
      (value) => value !== BranchIdentityAvailability.Complete
    )
  ) {
    availability = BranchIdentityAvailability.Incomplete;
  }
  return { availability, people, sources };
}

function isHumanGitHubActor(actorType: GitHubActorType | undefined): boolean {
  return (
    actorType === GitHubActorTypeValue.User ||
    actorType === GitHubActorTypeValue.Mannequin ||
    actorType === GitHubActorTypeValue.EnterpriseUserAccount
  );
}

function compareBranchPeople(left: BranchPerson, right: BranchPerson): number {
  return stablePersonKey(left).localeCompare(stablePersonKey(right));
}

function stablePersonKey(person: BranchPerson): string {
  return person.userId
    ? `${BranchPersonProvider.ClosedLoop}:${person.userId}`
    : `${person.provider}:${person.id}`;
}

function preferPerson(left: BranchPerson, right: BranchPerson): BranchPerson {
  if (
    left.provider === BranchPersonProvider.GitHub &&
    right.provider !== BranchPersonProvider.GitHub
  ) {
    return left;
  }
  if (
    right.provider === BranchPersonProvider.GitHub &&
    left.provider !== BranchPersonProvider.GitHub
  ) {
    return right;
  }
  return providerIdentityKey(left).localeCompare(providerIdentityKey(right)) <=
    0
    ? left
    : right;
}

function providerIdentityKey(person: BranchPerson): string {
  return `${person.provider}:${person.id}`;
}
