import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  type BranchCollaborators,
  type BranchOwnerIdentity,
  type BranchPersonCandidate,
  BranchPersonProvider,
} from "@repo/api/src/types/branch-identity";
import type { PrismaClient } from "@repo/database";
import {
  type DirectParticipationEntry,
  directParticipationService,
  type KnownThreadComment,
  mergeDirectArtifactPeople,
} from "@/app/artifacts/collaborators/direct-participation-service";
import { chunksOf } from "@/lib/chunks-of";
import type { BranchOwnerEvidence } from "./batch-session-link-evidence";
import { BRANCH_MEMBERSHIP_SESSION_LIMIT } from "./branch-membership-limit";
import {
  assigneeOwnerIdentity,
  type GitHubConnection,
  gitHubPersonForLogin,
  isPushMethod,
  ownerPersonForUser,
  type PushOwnerEvidence,
  projectOwner,
} from "./branch-owner-projection";
import {
  type BranchCommentEvidence,
  type NativeUser,
  projectBranchCollaborators,
} from "./collaborator-projection";
import {
  type BranchContributorEvidence,
  readBranchContributorEvidence,
} from "./collaborator-source-evidence";
import {
  attachSessionOwnerProfiles,
  collectBranchOwnerIds,
  type OwnerProfile,
  ownerDisplayNames,
  readOwnerDirectory,
  sessionOwnerProfileFromUser,
  sessionOwnerProfiles,
} from "./owner-attribution";
import {
  groupByBranch,
  readPageCommentEvidence,
} from "./page-comment-evidence";
import { readPushSessionCreators } from "./push-session-creator-read";
import {
  getBranchLifetimeUsage,
  getSessionUsageByBranch,
  type SessionBranchIdentityEvidence,
  type SessionUsage,
  type SessionUsageClient,
  type SessionUsageDateWindow,
} from "./session-usage-window";

type BranchIdentityReadClient = Pick<
  PrismaClient,
  | "$queryRaw"
  | "artifact"
  | "comment"
  | "gitHubCommentProjection"
  | "gitHubUserConnection"
  | "user"
  | "branchDetail"
  | "pullRequestDetail"
  | "branchPushContribution"
  | "externalCommentAuthor"
>;

export type BranchIdentityInput = {
  branchId: string;
  /** The branch artifact's assignee, which is its Owner (ISS-12463). */
  assigneeId: string | null;
  firstPushedAt: Date | null;
  associatedPullRequestCount: number;
  /**
   * ISS-11752: the branch's PR authors, in the read's PR order, which the
   * PR-author Collaborator candidates resolve. Empty-string logins are the
   * ABSENT form (ISS-8155) and are dropped before they reach here, never
   * treated as a real account.
   */
  pullRequestAuthorLogins?: readonly string[];
};

export type BranchIdentityProjection = {
  ownerIdentity: BranchOwnerIdentity;
  collaborators: BranchCollaborators;
};

/**
 * Resolves Branch people from persisted, organization-scoped evidence only.
 * This projector performs no provider reads, refreshes, sync, or backfill.
 */
export async function resolveBranchIdentities(
  db: BranchIdentityReadClient,
  organizationId: string,
  branches: readonly BranchIdentityInput[],
  linkEvidence: readonly SessionBranchIdentityEvidence[],
  options: {
    /** Filled with each Branch's direct participation, for callers that need its comment count. */
    directParticipationOut?: Map<string, DirectParticipationEntry>;
    /** Extra ids to resolve in THIS read rather than a second one (ISS-8972). */
    sessionOwnerIds?: Iterable<string>;
    /** Filled with every resolved user, for callers that need name + picture. */
    ownerProfilesOut?: Map<string, OwnerProfile>;
    /** Canonical SQL Owner decisions let batch reads avoid retaining every link. */
    ownerEvidenceByBranch?: ReadonlyMap<string, BranchOwnerEvidence>;
    /** Full persisted-link comment window, including the overflow signal. */
    sessionCommentRowsByBranch?: ReadonlyMap<
      string,
      readonly { authorId: string }[]
    >;
  } = {}
): Promise<Map<string, BranchIdentityProjection>> {
  if (branches.length === 0) {
    return new Map();
  }
  const sessionIdsByBranch = new Map<string, Set<string>>();
  const linksByBranch = groupByBranch(linkEvidence, (link) => [link.targetId]);
  for (const link of linkEvidence) {
    const sessionIds =
      sessionIdsByBranch.get(link.targetId) ?? new Set<string>();
    sessionIds.add(link.sourceId);
    sessionIdsByBranch.set(link.targetId, sessionIds);
  }
  const branchIds = branches.map((branch) => branch.branchId);
  const branchComments = new Map<string, KnownThreadComment[]>();
  const [evidenceByBranch, contributorByBranch, pusherBySessionId] =
    await Promise.all([
      readPageCommentEvidence(
        db,
        organizationId,
        branches,
        sessionIdsByBranch,
        options.sessionCommentRowsByBranch,
        branchComments
      ),
      readBranchContributorEvidence(db, organizationId, branchIds),
      readPushSessionCreators(
        db,
        organizationId,
        projectedPushSessionIds(linkEvidence, options.ownerEvidenceByBranch)
      ),
    ]);
  const providerIds = collectContributorProviderIds(
    evidenceByBranch,
    contributorByBranch
  );
  const userIds = ownerUserIds(branches, options.ownerEvidenceByBranch);
  for (const link of linkEvidence) {
    const pusherUserId = pusherBySessionId.get(link.sourceId);
    if (pusherUserId && isPushMethod(link.branchParticipationMethod)) {
      userIds.add(pusherUserId);
    }
  }
  for (const evidence of evidenceByBranch.values()) {
    for (const comment of [
      ...evidence.branchComments,
      ...evidence.sessionComments,
    ]) {
      userIds.add(comment.authorId);
    }
  }
  const authorLogins = collectPullRequestAuthorLogins(branches);
  const [connections, verifiedConnections, directByArtifact] =
    await Promise.all([
      readGitHubIdentityConnections(
        db,
        organizationId,
        [...userIds],
        [],
        false,
        [...authorLogins]
      ),
      readGitHubIdentityConnections(db, organizationId, [], providerIds, true),
      // Direct Comments reuse the page's Branch comments rather than scanning
      // them again; nothing else here waits on this read.
      readDirectBranchParticipation(
        db,
        organizationId,
        branchIds,
        branchComments
      ),
    ]);
  for (const [artifactId, entry] of directByArtifact) {
    options.directParticipationOut?.set(artifactId, entry);
  }
  const profileUserIds = profileUserIdsFor(
    userIds,
    options.sessionOwnerIds,
    connections
  );
  const users = await readIdentityChunks([...profileUserIds], (idChunk) =>
    db.user.findMany({
      where: { organizationId, id: { in: idChunk } },
      select: {
        id: true,
        clerkId: true,
        email: true,
        firstName: true,
        lastName: true,
        avatarUrl: true,
      },
    })
  );
  const usersById = new Map(users.map((user) => [user.id, user]));
  fillOwnerProfiles(users, options.ownerProfilesOut);
  const connectionsByUserId = new Map(
    connections.map((connection) => [connection.userId, connection])
  );
  const connectionsByLogin = new Map(
    connections.map((connection) => [connection.login, connection])
  );
  const verifiedGitHubUserIds = verifiedProviderAccountIds(verifiedConnections);
  const projections = new Map<string, BranchIdentityProjection>();
  for (const branch of branches) {
    const ownerEvidence = options.ownerEvidenceByBranch?.get(branch.branchId);
    const ownerLinks = withPushers(
      linksByBranch.get(branch.branchId),
      pusherBySessionId
    );
    const ownerIdentity = assigneeOwnerIdentity(
      branch.assigneeId,
      connectionsByUserId,
      usersById
    );
    const observedOwnerIdentity = ownerEvidence
      ? {
          availability: ownerEvidence.observedAvailability,
          person: ownerPersonForUser(
            ownerEvidence.observedUserId,
            connectionsByUserId,
            usersById
          ),
        }
      : projectOwner(branch, connectionsByUserId, usersById, ownerLinks);
    projections.set(branch.branchId, {
      ownerIdentity,
      collaborators: projectBranchCollaborators({
        associatedPullRequestCount: branch.associatedPullRequestCount,
        ownerIdentity: observedOwnerIdentity,
        evidence: evidenceByBranch.get(branch.branchId),
        contributors: contributorByBranch.get(branch.branchId),
        pullRequestAuthors: pullRequestAuthorCandidates(
          branch,
          connectionsByLogin,
          usersById
        ),
        usersById,
        verifiedGitHubUserIds,
      }),
    });
  }
  mergeBranchDirectParticipation(projections, directByArtifact);
  return projections;
}

/**
 * Distinct PR-author logins across the page, which the PR-author Collaborator
 * candidates resolve through the login arm of the one connection read
 * (ISS-11752).
 */
function collectPullRequestAuthorLogins(
  branches: readonly BranchIdentityInput[]
): Set<string> {
  const logins = new Set<string>();
  for (const branch of branches) {
    for (const login of branch.pullRequestAuthorLogins ?? []) {
      logins.add(login);
    }
  }
  return logins;
}

/**
 * The users this read resolves a display label from.
 *
 * Three sources, and only the first drives WHO a projection names:
 *  - `userIds` — the assignees (each branch's Owner, ISS-12463), push-link
 *    owners and native comment authors the projections resolve; this same set
 *    drives the connection read above.
 *  - ISS-8972 — the extra Session owners a caller asked for, resolved by the
 *    User statement this read ALREADY issues rather than a second one (a second
 *    `user.findMany` broke the ISS-6004 fan-out bound).
 *  - ISS-11762 (tamsinb review) — every connection this read resolved, which
 *    is what puts a PR-author Collaborator's user id in reach. A PR author is
 *    found by LOGIN, so its user id is not known until the connection read
 *    returns; with the User read in the earlier tier `gitHubPersonForLogin` found
 *    no user, left `displayName` undefined, and the same person appeared under
 *    their real name in one place and under their bare GitHub login in
 *    another. `apps/api/app/branches/AGENTS.md` names that split: "Resolve a
 *    person's display label once for the surface."
 *
 * Widening this set cannot change which person any projection names: it feeds
 * only `usersById`, which is read by key and never enumerated, and the
 * connection read that DOES drive resolution is already issued by the time this
 * set is built.
 */
function profileUserIdsFor(
  userIds: ReadonlySet<string>,
  sessionOwnerIds: Iterable<string> | undefined,
  connections: readonly { userId: string }[]
): Set<string> {
  const ids = new Set(userIds);
  for (const ownerId of sessionOwnerIds ?? []) {
    ids.add(ownerId);
  }
  for (const connection of connections) {
    ids.add(connection.userId);
  }
  return ids;
}

/**
 * The connection read's org-scoped predicate.
 *
 * The login arm is added ONLY when this page actually has PR authors to
 * resolve, so a page without them issues the exact predicate it always did
 * rather than a one-armed `OR` that reads as a change where none happened.
 */
function branchConnectionWhere(
  organizationId: string,
  userIds: ReadonlySet<string>,
  authorLogins: ReadonlySet<string>
) {
  if (authorLogins.size === 0) {
    return { organizationId, userId: { in: [...userIds] } };
  }
  return {
    organizationId,
    OR: [
      { userId: { in: [...userIds] } },
      { login: { in: [...authorLogins] } },
    ],
  };
}

type BranchIdentityRow = {
  id: string;
  assigneeId: string | null;
  branch: { firstPushedAt: Date | null };
  // ISS-11752: narrowed from `readonly unknown[]` — this read counts the PRs
  // AND now reads their authors. `authorLogin` is optional so a caller whose
  // select predates it still typechecks and simply infers no owner.
  pullRequestDetails: readonly { authorLogin?: string | null }[];
};

type BranchIdentityClient = BranchIdentityReadClient & SessionUsageClient;

/** Reads list usage and canonical identities from one Session-link scan. */
export async function resolveBranchListIdentityData(
  db: BranchIdentityClient,
  organizationId: string,
  rows: readonly BranchIdentityRow[],
  dateWindow: SessionUsageDateWindow | undefined,
  preloaded?: BranchListIdentityData
): Promise<BranchListIdentityData> {
  const evidence: SessionBranchIdentityEvidence[] = [];
  const usage = await getBranchLifetimeUsage(
    db,
    organizationId,
    rows.map((row) => row.id),
    dateWindow,
    preloaded ? undefined : evidence,
    { includeLifecycleEvents: false, includeSessionPhaseSegments: false }
  );
  // ISS-8972 — resolved by the identity read below, in its profile lookup.
  const ownerProfiles = new Map<string, OwnerProfile>();
  for (const previousUsage of preloaded?.lifetime.values() ?? []) {
    for (const [sessionId, profile] of previousUsage.sessionOwnerProfileById) {
      const ownerId = previousUsage.sessionOwnerById.get(sessionId);
      if (ownerId) {
        ownerProfiles.set(ownerId, profile);
      }
    }
  }
  const identityByBranch =
    preloaded?.identityByBranch ??
    (await resolveBranchIdentities(
      db,
      organizationId,
      identityInputs(rows),
      evidence,
      {
        sessionOwnerIds: describedSessionOwnerIds(usage.lifetime),
        ownerProfilesOut: ownerProfiles,
      }
    ));
  attachSessionOwnerProfiles(usage.lifetime, ownerProfiles);
  attachSessionOwnerProfiles(usage.windowed, ownerProfiles);
  return { ...usage, identityByBranch };
}

/** Reads detail usage and canonical identity from one Session-link scan. */
export async function resolveBranchDetailIdentityData(
  db: BranchIdentityClient,
  organizationId: string,
  row: BranchIdentityRow
): Promise<{
  usageByBranch: Map<string, SessionUsage>;
  identityByBranch: Map<string, BranchIdentityProjection>;
  nameById: Map<string, string>;
}> {
  const evidence: SessionBranchIdentityEvidence[] = [];
  const usageByBranch = await getSessionUsageByBranch(
    db,
    organizationId,
    [row.id],
    { identityEvidenceOut: evidence }
  );
  const [identityByBranch, ownerDirectory] = await Promise.all([
    resolveBranchIdentities(
      db,
      organizationId,
      identityInputs([row]),
      evidence
    ),
    // ISS-11738: the PROFILES, not just the names. This path resolved names
    // only, so `usage.sessionOwnerProfileById` stayed empty and the canonical
    // projection's `!profile && ownerId` test (canonical-projection.ts) was true
    // for EVERY session that has an owner — stamping `ownerUnavailable: true`,
    // the flag reserved for an owner nobody could look up, on sessions whose
    // owner the same response names in `ownerUserName`. One org-scoped read
    // feeds both derivations, so taking the profiles costs no extra query.
    readOwnerDirectory(
      db,
      organizationId,
      collectBranchOwnerIds(usageByBranch)
    ),
  ]);
  // `sessionOwnerProfiles` (name parts only), never the directory's
  // `displayUserName` (email fallback): the chip profile reaches the wire as
  // `ownerName`, and an email there is a private address published as a display
  // name (whitlockk review, ISS-11738). `nameById` keeps the display-name
  // derivation it has always had — it feeds `ownerUserName`, whose email
  // fallback this change does not touch.
  attachSessionOwnerProfiles(
    usageByBranch,
    sessionOwnerProfiles(ownerDirectory)
  );
  return {
    usageByBranch,
    identityByBranch,
    nameById: ownerDisplayNames(ownerDirectory),
  };
}

/**
 * Exported for the Branches-list identity SQL oracle (ISS-11765): the parity
 * fixture has to hand `resolveBranchIdentities` the SAME input the production
 * reads do, or it silently stops exercising the PR-creator rung and reports a
 * SQL twin that ignores it as in agreement.
 */
export function identityInputs(
  rows: readonly BranchIdentityRow[]
): BranchIdentityInput[] {
  return rows.map((row) => ({
    branchId: row.id,
    assigneeId: row.assigneeId,
    firstPushedAt: row.branch.firstPushedAt,
    associatedPullRequestCount: row.pullRequestDetails.length,
    // ISS-8155: `""` is how an unfilled `authorLogin` reaches a read — the
    // ABSENT form, deliberately not the literal "unknown" a real account could
    // hold. Dropped here so no downstream lookup treats it as a login.
    pullRequestAuthorLogins: row.pullRequestDetails
      .map((pullRequest) => pullRequest.authorLogin)
      .filter((login): login is string => Boolean(login)),
  }));
}

/**
 * ISS-8972 (whitlockk review) — the owners of only the Sessions the projection will
 * actually DESCRIBE, so this read's widened predicate is bounded by
 * {@link BRANCH_MEMBERSHIP_SESSION_LIMIT} per branch rather than by a branch's
 * total link count.
 *
 * It matters most on the server-page path, where identity resolution runs over
 * the whole matching corpus BEFORE pagination: an unbounded set there would add
 * one bind parameter per linked Session in the corpus to a statement that is
 * already corpus-wide.
 */
function describedSessionOwnerIds(
  lifetime: Map<string, SessionUsage>
): Set<string> {
  const ownerIds = new Set<string>();
  for (const usage of lifetime.values()) {
    for (const session of usage.sessions.slice(
      0,
      BRANCH_MEMBERSHIP_SESSION_LIMIT
    )) {
      const ownerId = usage.sessionOwnerById.get(session.sessionId);
      if (ownerId) {
        ownerIds.add(ownerId);
      }
    }
  }
  return ownerIds;
}

/**
 * ISS-8972 — record each resolved user as a chip-ready profile, through the
 * same `sessionOwnerProfileFromUser` derivation the detail path uses, so the
 * two cannot name one user differently (ISS-11738).
 *
 * Extracted so `resolveBranchIdentities` stays under the cognitive-complexity
 * ceiling. The out map is optional because only the LIST path gets its profiles
 * from THIS read; the detail path resolves them from its own owner directory,
 * and every other caller resolves identities without paying for them.
 */
function fillOwnerProfiles(
  users: readonly NativeUser[],
  out: Map<string, OwnerProfile> | undefined
): void {
  if (!out) {
    return;
  }
  for (const user of users) {
    const profile = sessionOwnerProfileFromUser(user);
    if (profile) {
      out.set(user.id, profile);
    }
  }
}

async function readIdentityChunks<T>(
  ids: readonly string[],
  readChunk: (ids: string[]) => Promise<T[]>
): Promise<T[]> {
  const chunks = chunksOf(ids, BRANCH_IDENTITY_READ_CHUNK_SIZE);
  const rows: T[] = [];
  for (const chunk of chunks.length > 0 ? chunks : [[]]) {
    rows.push(...(await readChunk(chunk)));
  }
  return rows;
}

/** Maximum platform user IDs bound by one Branch identity lookup. */
export const BRANCH_IDENTITY_READ_CHUNK_SIZE = 1000;

function pullRequestAuthorCandidates(
  branch: BranchIdentityInput,
  connectionsByLogin: ReadonlyMap<string, GitHubConnection>,
  usersById: ReadonlyMap<string, NativeUser>
): BranchPersonCandidate[] {
  const candidates: BranchPersonCandidate[] = [];
  const seen = new Set<string>();
  for (const login of branch.pullRequestAuthorLogins ?? []) {
    if (seen.has(login)) {
      continue;
    }
    seen.add(login);
    const person = gitHubPersonForLogin(login, connectionsByLogin, usersById);
    if (person) {
      candidates.push({ person, actorType: person.actorType });
    }
  }
  return candidates;
}

function collectContributorProviderIds(
  comments: ReadonlyMap<string, BranchCommentEvidence>,
  contributors: ReadonlyMap<string, BranchContributorEvidence>
): string[] {
  const ids = new Set<string>();
  for (const evidence of comments.values()) {
    for (const comment of evidence.githubComments) {
      if (comment.externalAuthor) {
        ids.add(comment.externalAuthor.providerUserId);
      }
    }
  }
  for (const evidence of contributors.values()) {
    for (const candidate of [...evidence.authors, ...evidence.pushes]) {
      if (candidate.person?.provider === BranchPersonProvider.GitHub) {
        ids.add(candidate.person.id);
      }
    }
  }
  return [...ids];
}

async function readGitHubIdentityConnections(
  db: BranchIdentityReadClient,
  organizationId: string,
  userIds: readonly string[],
  providerIds: readonly string[],
  currentVerifiedOnly = false,
  ownerLogins: readonly string[] = []
): Promise<GitHubConnection[]> {
  if (currentVerifiedOnly && providerIds.length === 0) {
    return [];
  }
  const userChunks = chunksOf(userIds, BRANCH_IDENTITY_READ_CHUNK_SIZE);
  const providerChunks = chunksOf(providerIds, BRANCH_IDENTITY_READ_CHUNK_SIZE);
  const loginChunks = chunksOf(ownerLogins, BRANCH_IDENTITY_READ_CHUNK_SIZE);
  const rows: GitHubConnection[] = [];
  for (
    let index = 0;
    index <
    Math.max(1, userChunks.length, providerChunks.length, loginChunks.length);
    index++
  ) {
    const idChunk = userChunks[index] ?? [];
    const providerChunk = providerChunks[index] ?? [];
    const loginChunk = loginChunks[index] ?? [];
    rows.push(
      ...(await db.gitHubUserConnection.findMany({
        where: {
          organizationId,
          ...(currentVerifiedOnly
            ? { revokedAt: null, user: { organizationId, active: true } }
            : {}),
          ...(providerChunk.length > 0
            ? {
                user: {
                  organizationId,
                  ...(currentVerifiedOnly ? { active: true } : {}),
                },
                OR: [
                  { userId: { in: idChunk } },
                  { githubUserId: { in: providerChunk } },
                  ...(currentVerifiedOnly &&
                  providerChunk.some((id) => id.startsWith("node:"))
                    ? [
                        {
                          githubNodeId: {
                            in: providerChunk
                              .filter((id) => id.startsWith("node:"))
                              .map((id) => id.slice(5)),
                          },
                        },
                      ]
                    : []),
                ],
              }
            : branchConnectionWhere(
                organizationId,
                new Set(idChunk),
                new Set(loginChunk)
              )),
        },
        select: {
          userId: true,
          githubUserId: true,
          ...(currentVerifiedOnly ? { githubNodeId: true } : {}),
          login: true,
          avatarUrl: true,
          profileUrl: true,
        },
      }))
    );
  }
  return rows;
}

/** A stable alias resolves only when the verified rows agree on one account. */
function verifiedProviderAccountIds(
  connections: readonly GitHubConnection[]
): Map<string, string> {
  const accounts = new Map<string, Set<string>>();
  for (const connection of connections) {
    const aliases = [connection.githubUserId];
    if (connection.githubNodeId) {
      aliases.push(`node:${connection.githubNodeId}`);
    }
    for (const alias of aliases) {
      const users = accounts.get(alias) ?? new Set<string>();
      users.add(connection.userId);
      accounts.set(alias, users);
    }
  }
  const resolved = new Map<string, string>();
  for (const [alias, users] of accounts) {
    const [userId] = users;
    if (users.size === 1 && userId) {
      resolved.set(alias, userId);
    }
  }
  return resolved;
}

/** Request-local identity evidence shared by date arms of the same snapshot.
 * Identity is lifetime-scoped; windowed usage is still read for each arm. */
export type BranchListIdentityData = {
  windowed: Map<string, SessionUsage>;
  lifetime: Map<string, SessionUsage>;
  identityByBranch: Map<string, BranchIdentityProjection>;
};

async function readDirectBranchParticipation(
  db: BranchIdentityReadClient,
  organizationId: string,
  artifactIds: readonly string[],
  knownComments: ReadonlyMap<string, readonly KnownThreadComment[]>
): Promise<ReadonlyMap<string, DirectParticipationEntry>> {
  const entries = await directParticipationService.read(
    db,
    organizationId,
    ArtifactType.Branch,
    artifactIds,
    knownComments
  );
  return new Map(entries.map((entry) => [entry.artifactId, entry]));
}

function mergeBranchDirectParticipation(
  projections: Map<string, BranchIdentityProjection>,
  directByArtifact: ReadonlyMap<string, DirectParticipationEntry>
): void {
  for (const [artifactId, projection] of projections) {
    const direct = directByArtifact.get(artifactId);
    if (direct) {
      projection.collaborators = mergeDirectArtifactPeople(
        projection.collaborators,
        direct.collaborators
      );
    }
  }
}

/**
 * The pushing sessions whose creator `projectOwner` needs. A Branch whose
 * observed-push rung the batch SQL already read never reaches `projectOwner`, so
 * its links cost no creator lookup.
 */
function projectedPushSessionIds(
  linkEvidence: readonly SessionBranchIdentityEvidence[],
  ownerEvidenceByBranch: ReadonlyMap<string, BranchOwnerEvidence> | undefined
): string[] {
  return linkEvidence
    .filter(
      (link) =>
        isPushMethod(link.branchParticipationMethod) &&
        !ownerEvidenceByBranch?.has(link.targetId)
    )
    .map((link) => link.sourceId);
}

function withPushers(
  links: readonly SessionBranchIdentityEvidence[] | undefined,
  pusherBySessionId: ReadonlyMap<string, string | null>
): PushOwnerEvidence[] {
  return (links ?? []).map((link) => ({
    ...link,
    pusherUserId: pusherBySessionId.get(link.sourceId) ?? null,
  }));
}

function ownerUserIds(
  branches: readonly BranchIdentityInput[],
  ownerEvidenceByBranch: ReadonlyMap<string, BranchOwnerEvidence> | undefined
): Set<string> {
  const userIds = new Set<string>();
  for (const branch of branches) {
    if (branch.assigneeId) {
      userIds.add(branch.assigneeId);
    }
  }
  for (const owner of ownerEvidenceByBranch?.values() ?? []) {
    if (owner.observedUserId) {
      userIds.add(owner.observedUserId);
    }
  }
  return userIds;
}
