import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  ARTIFACT_COLLABORATOR_BATCH_TOO_LARGE,
  type ArtifactCollaboratorBatchQuery,
  type ArtifactCollaboratorBatchResponse,
  type ArtifactCollaboratorEntry,
  DirectCollaboratorSource,
  SessionCollaboratorSource,
  unavailableArtifactCollaborators,
} from "@repo/api/src/types/artifact-collaborators";
import {
  BranchIdentityAvailability,
  type BranchPersonCandidate,
  BranchPersonProvider,
  projectArtifactPeople,
} from "@repo/api/src/types/branch-identity";
import { Result } from "@repo/api/src/types/result";
import { Prisma, type TransactionClient, withDb } from "@repo/database";
import {
  readSessionCommentEvidence,
  type SessionCommentEvidence,
} from "@/app/agent-sessions/service/session-collaborator-comment-evidence";
import {
  readSessionCollaboratorEvidence,
  type SessionCollaboratorEvidence,
} from "@/app/agent-sessions/service/session-collaborator-evidence";
import { branchPullRequestDetailOrderBy } from "@/app/branches/branch-read-selects";
import { readBatchSessionLinkEvidence } from "@/app/branches/branch-read-service/batch-session-link-evidence";
import { resolveBranchIdentities } from "@/app/branches/branch-read-service/identity-attribution";
import { COMMENT_EVIDENCE_LIMIT } from "@/app/branches/branch-read-service/page-comment-evidence";
import { isGitHubShadowClerkId } from "@/app/comments/github-shadow-identity";
import { chunksOf } from "@/lib/chunks-of";
import { displayUserName } from "@/lib/user-display-name";
import {
  type DirectParticipationEntry,
  directParticipationService,
  mergeDirectArtifactPeople,
} from "./direct-participation-service";
import {
  COLLABORATOR_READ_MAX_RESPONSE_BYTES,
  collaboratorReadFitsBudget,
} from "./read-budget";

/** Organization-scoped, read-only Collaborators batch service. */
export const artifactCollaboratorsService = {
  /** Public reads reject oversized cohorts whole; shared clients retry smaller groups. */
  async readBoundedBatch(
    organizationId: string,
    query: ArtifactCollaboratorBatchQuery
  ): Promise<
    Result<
      ArtifactCollaboratorBatchResponse,
      typeof ARTIFACT_COLLABORATOR_BATCH_TOO_LARGE
    >
  > {
    // Admission and materialization must see the same history during concurrent writes.
    return await withDb.tx(
      async (db) => {
        if (!(await collaboratorReadFitsBudget(db, organizationId, query))) {
          return Result.err(ARTIFACT_COLLABORATOR_BATCH_TOO_LARGE);
        }
        const response = await artifactCollaboratorsService.readBatch(
          organizationId,
          query
        );
        if (
          Buffer.byteLength(JSON.stringify(response), "utf8") >
          COLLABORATOR_READ_MAX_RESPONSE_BYTES
        ) {
          return Result.err(ARTIFACT_COLLABORATOR_BATCH_TOO_LARGE);
        }
        return Result.ok(response);
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        maxWait: COLLABORATOR_READ_TX_MAX_WAIT_MS,
        timeout: COLLABORATOR_READ_TX_TIMEOUT_MS,
      }
    );
  },
  async readBatch(
    organizationId: string,
    query: ArtifactCollaboratorBatchQuery
  ): Promise<ArtifactCollaboratorBatchResponse> {
    const artifactIds = [...new Set(query.artifactIds)];
    return await withDb(async (db) => {
      if (query.artifactType === ArtifactType.Branch) {
        // The Branch identity pass reads direct participation from the comments
        // it already loads and merges its people, so only the count is taken here.
        const directOut = new Map<string, DirectParticipationEntry>();
        const branches = await readBranches(
          db,
          organizationId,
          artifactIds,
          directOut
        );
        return {
          results: branches.flatMap((entry) => {
            const direct = directOut.get(entry.artifactId);
            return direct
              ? [{ ...entry, commentCount: direct.commentCount }]
              : [];
          }),
        };
      }
      const direct = await directParticipationService.read(
        db,
        organizationId,
        query.artifactType,
        artifactIds
      );
      const extended =
        query.artifactType === ArtifactType.Session
          ? await readSessions(db, organizationId, artifactIds)
          : [];
      const extendedById = new Map(
        extended.map((entry) => [entry.artifactId, entry])
      );
      const directById = new Map(
        direct.map((entry) => [entry.artifactId, entry])
      );
      return {
        results: artifactIds.flatMap((artifactId) => {
          const entry = directById.get(artifactId);
          return entry
            ? [mergeParticipation(entry, extendedById.get(artifactId))]
            : [];
        }),
      };
    });
  },
};

async function readSessions(
  db: TransactionClient,
  organizationId: string,
  artifactIds: readonly string[]
): Promise<ArtifactCollaboratorEntry[]> {
  const [evidence, comments] = await Promise.all([
    readSessionCollaboratorEvidence(db, organizationId, artifactIds),
    readSessionCommentEvidence(db, organizationId, artifactIds),
  ]);
  const userIds = new Set<string>();
  for (const session of evidence.values()) {
    if (session.ownerId) {
      userIds.add(session.ownerId);
    }
    for (const editorId of session.editorIds) {
      userIds.add(editorId);
    }
  }
  for (const comment of comments.values()) {
    for (const authorId of comment.authorIds) {
      userIds.add(authorId);
    }
  }
  const usersById = new Map<string, SessionUser>();
  for (const idChunk of chunksOf([...userIds], SESSION_USER_READ_CHUNK_SIZE)) {
    const users = await db.user.findMany({
      where: { organizationId, id: { in: idChunk } },
      select: {
        id: true,
        clerkId: true,
        email: true,
        firstName: true,
        lastName: true,
        avatarUrl: true,
      },
    });
    for (const user of users) {
      usersById.set(user.id, user);
    }
  }
  const result: ArtifactCollaboratorEntry[] = [];
  for (const artifactId of artifactIds) {
    const session = evidence.get(artifactId);
    if (session) {
      result.push(
        projectSessionEntry(
          artifactId,
          session,
          comments.get(artifactId),
          usersById
        )
      );
    }
  }
  return result;
}

type SessionUser = {
  id: string;
  clerkId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
};

function humanSessionCandidate(
  user: SessionUser | undefined
): BranchPersonCandidate {
  if (!user || isGitHubShadowClerkId(user.clerkId)) {
    return {};
  }
  return {
    person: {
      provider: BranchPersonProvider.ClosedLoop,
      id: user.id,
      userId: user.id,
      displayName: displayUserName(user),
      ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
    },
  };
}

function projectSessionEntry(
  artifactId: string,
  session: SessionCollaboratorEvidence,
  comments: SessionCommentEvidence | undefined,
  usersById: ReadonlyMap<string, SessionUser>
): ArtifactCollaboratorEntry {
  const owner = session.ownerId
    ? humanSessionCandidate(usersById.get(session.ownerId))
    : null;
  const editors = session.editorIds.map((id) =>
    humanSessionCandidate(usersById.get(id))
  );
  const commenters = (comments?.authorIds ?? []).map((id) =>
    humanSessionCandidate(usersById.get(id))
  );
  const candidates = [
    ...(owner ? [owner] : []),
    ...editors,
    ...commenters,
    ...(comments?.capped ? [{}] : []),
  ];
  return {
    artifactId,
    artifactType: ArtifactType.Session,
    collaborators: projectArtifactPeople(candidates, {
      [DirectCollaboratorSource.Creator]: BranchIdentityAvailability.Complete,
      [DirectCollaboratorSource.Interactions]:
        BranchIdentityAvailability.Complete,
      [DirectCollaboratorSource.Comments]: BranchIdentityAvailability.Complete,
      [SessionCollaboratorSource.Owner]:
        session.ownerId && !owner?.person
          ? BranchIdentityAvailability.Incomplete
          : BranchIdentityAvailability.Complete,
      [SessionCollaboratorSource.Comments]:
        comments?.capped || commenters.some((commenter) => !commenter.person)
          ? BranchIdentityAvailability.Incomplete
          : BranchIdentityAvailability.Complete,
      [SessionCollaboratorSource.MetadataEdits]:
        session.editorAvailability === BranchIdentityAvailability.Incomplete ||
        editors.some((editor) => !editor.person)
          ? BranchIdentityAvailability.Incomplete
          : BranchIdentityAvailability.Complete,
    }),
  };
}

async function readBranches(
  db: TransactionClient,
  organizationId: string,
  artifactIds: readonly string[],
  directOut: Map<string, DirectParticipationEntry>
): Promise<ArtifactCollaboratorEntry[]> {
  const branches = await db.artifact.findMany({
    where: {
      organizationId,
      type: ArtifactType.Branch,
      id: { in: [...artifactIds] },
      branch: { isNot: null },
    },
    select: {
      id: true,
      assigneeId: true,
      branch: { select: { firstPushedAt: true } },
      pullRequestDetails: {
        orderBy: branchPullRequestDetailOrderBy,
        select: { authorLogin: true },
      },
    },
  });
  if (branches.length === 0) {
    return [];
  }
  const branchIds = branches.map((branch) => branch.id);
  const links = await readBatchSessionLinkEvidence(
    db,
    organizationId,
    branchIds,
    COMMENT_EVIDENCE_LIMIT
  );
  const identities = await resolveBranchIdentities(
    db,
    organizationId,
    branches.map((branch) => ({
      branchId: branch.id,
      assigneeId: branch.assigneeId,
      firstPushedAt: branch.branch?.firstPushedAt ?? null,
      associatedPullRequestCount: branch.pullRequestDetails.length,
      pullRequestAuthorLogins: branch.pullRequestDetails
        .map((pullRequest) => pullRequest.authorLogin)
        .filter((login): login is string => Boolean(login)),
    })),
    [],
    {
      directParticipationOut: directOut,
      ownerEvidenceByBranch: links.ownersByBranch,
      sessionCommentRowsByBranch: links.commentsByBranch,
    }
  );
  return artifactIds.flatMap((artifactId): ArtifactCollaboratorEntry[] => {
    const identity = identities.get(artifactId);
    if (!identity) {
      return [];
    }
    return [
      {
        artifactId,
        artifactType: ArtifactType.Branch,
        collaborators: {
          ...identity.collaborators,
          // Defaults first: `identity` already carries the direct sources it merged.
          sources: {
            ...unavailableArtifactCollaborators(ArtifactType.Document).sources,
            ...identity.collaborators.sources,
          },
        },
      },
    ];
  });
}

/** Maximum user IDs bound by one Session collaborator profile read. */
export const SESSION_USER_READ_CHUNK_SIZE = 1000;
const COLLABORATOR_READ_TX_MAX_WAIT_MS = 5000;
const COLLABORATOR_READ_TX_TIMEOUT_MS = 30_000;

function mergeParticipation(
  direct: DirectParticipationEntry,
  extended: ArtifactCollaboratorEntry | undefined
): ArtifactCollaboratorEntry {
  if (extended?.artifactType === ArtifactType.Session) {
    return {
      ...extended,
      commentCount: direct.commentCount,
      collaborators: mergeDirectArtifactPeople(
        extended.collaborators,
        direct.collaborators
      ),
    };
  }
  if (
    direct.artifactType === ArtifactType.Document ||
    direct.artifactType === ArtifactType.Deployment
  ) {
    return { ...direct, artifactType: direct.artifactType };
  }
  // Branch never reaches here: readBatch serves it from the identity pass.
  return {
    ...direct,
    artifactType: ArtifactType.Session,
    collaborators: mergeDirectArtifactPeople(
      unavailableArtifactCollaborators(ArtifactType.Session),
      direct.collaborators
    ),
  };
}
