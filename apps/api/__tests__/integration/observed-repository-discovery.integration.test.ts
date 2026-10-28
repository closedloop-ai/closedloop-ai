/**
 * PLN-1775 M1 (ISS-7403) — the discovery handoff, end to end against Postgres.
 *
 * The batch suite mocks BOTH ends of this path (`upsertSessionSlice` and
 * `recordObservedRepositories`), so it proves the fold and the write shape but
 * cannot notice the slice handing back an empty list: every one of its
 * assertions stays green under that mutation. This is the case that fails,
 * because the only producer here is the real ingest and the only sink is the
 * real table.
 *
 * It also pins the filter that decides WHICH names are candidates: a repository
 * the server already has an identity for is not a discovery candidate, and
 * observing it would add a row whose identity we would then have to pick
 * between.
 */
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  type DesktopAgentSessionsPayload,
  type SyncedAgentSession,
} from "@repo/api/src/types/agent-session";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  type SyncedArtifactRef,
} from "@repo/api/src/types/session-artifact-link";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import { persistedGitHubRepositoryAuthority } from "@/__tests__/fixtures/repository-default-authority";
import { agentSessionsService } from "@/app/agent-sessions/service";
import { GITHUB_REPO_SCOPE } from "@/lib/github/github-connection-credential";
import { selectOrgIdsWithDueObservedRepositories } from "@/lib/github/observed-repository-discovery";
import { GitHubObservedRepositoryVerificationState } from "@/lib/github/observed-repository-store";
import {
  createTestOrganization,
  createTestUser,
  joinAmbientTransactionForSessionSyncWrites,
} from "../utils/db-helpers";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const STARTED_AT = new Date("2026-08-20T10:00:00.000Z");
const UPDATED_AT = new Date("2026-08-20T11:00:00.000Z");
const UNKNOWN_REPOSITORY = "acme/unrecorded-widget";
const KNOWN_REPOSITORY = "acme/already-known";
const VERIFIED_REPOSITORY = "acme/verified-widget";
const PROSE_PR_REPOSITORY = "vercel/next.js";
const PROSE_BRANCH_REPOSITORY = "acme/prose-only-widget";

function createComputeTarget(organizationId: string, userId: string) {
  return withDb((db) =>
    db.computeTarget.create({
      data: {
        organizationId,
        userId,
        machineName: "observed-repository-machine",
        platform: "darwin",
      },
      select: { id: true },
    })
  );
}

function branchRef(repositoryFullName: string): SyncedArtifactRef {
  return {
    kind: ArtifactRefTargetKind.Branch,
    repositoryFullName,
    branchName: "feature/discovery",
    method: "git_push",
    relation: ArtifactRefRelation.Created,
    observedAt: UPDATED_AT.toISOString(),
  };
}

function proseBranchRef(repositoryFullName: string): SyncedArtifactRef {
  return {
    kind: ArtifactRefTargetKind.Branch,
    repositoryFullName,
    branchName: "feature/prose-only",
    method: ArtifactRefMethod.BranchMentionInProse,
    relation: ArtifactRefRelation.Referenced,
  };
}

function prosePullRequestRef(repositoryFullName: string): SyncedArtifactRef {
  return {
    kind: ArtifactRefTargetKind.PullRequest,
    repositoryFullName,
    prNumber: 95_639,
    method: ArtifactRefMethod.PrMentionInProse,
    relation: ArtifactRefRelation.Referenced,
  };
}

function buildSession(
  externalSessionId: string,
  artifactRefs: SyncedArtifactRef[]
): SyncedAgentSession {
  return {
    externalSessionId,
    name: `Discovery session ${externalSessionId}`,
    status: "active",
    harness: "claude",
    cwd: "/tmp/worktree",
    model: "claude-opus",
    startedAt: STARTED_AT.toISOString(),
    updatedAt: UPDATED_AT.toISOString(),
    agents: [],
    events: [],
    tokenUsageByModel: [],
    artifactRefs,
  };
}

function buildPayload(
  sessions: SyncedAgentSession[]
): DesktopAgentSessionsPayload {
  return {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: "2c9f0b71-5f4e-4a1d-9b7e-0f5a1c2d3e4b",
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: sessions.length,
    sessions,
  };
}

function readObservedRepositories(organizationId: string) {
  return withDb((db) =>
    db.gitHubObservedRepository.findMany({
      where: { organizationId },
      orderBy: { repositoryFullName: "asc" },
      select: {
        repositoryFullName: true,
        verificationState: true,
        observedSessionCount: true,
      },
    })
  );
}

/**
 * A `github_observed_repository` row in the state M2's verifier leaves behind: a
 * `repos.get` through the org's own credential returned it, so it carries a
 * provider id and the default-branch group. `fullName` is renamed because the
 * observation table keys on `repository_full_name`, not `full_name`.
 */
async function seedVerifiedObservation(
  organizationId: string,
  repositoryFullName: string
): Promise<void> {
  const { fullName, ...authority } = persistedGitHubRepositoryAuthority({
    githubRepoId: "778899",
    fullName: repositoryFullName,
  });
  await withDb((db) =>
    db.gitHubObservedRepository.create({
      data: {
        organizationId,
        repositoryFullName: fullName,
        verificationState: GitHubObservedRepositoryVerificationState.Verified,
        ...authority,
        owner: "acme",
        name: "verified-widget",
        htmlUrl: `https://github.com/${repositoryFullName}`,
        isPrivate: true,
      },
    })
  );
}

async function seedKnownRepository(organizationId: string): Promise<void> {
  await withDb((db) =>
    db.publicRepository.create({
      data: {
        organizationId,
        ...persistedGitHubRepositoryAuthority({
          githubRepoId: "554433",
          fullName: KNOWN_REPOSITORY,
        }),
        owner: "acme",
        name: "already-known",
        htmlUrl: `https://github.com/${KNOWN_REPOSITORY}`,
      },
    })
  );
}

describeIfDb("desktop sync → observed repository candidates", () => {
  it("records a repository the server has no identity for, weighted by the sessions that named it", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const computeTarget = await createComputeTarget(organizationId, user.id);

      await agentSessionsService.upsertSessions(
        { organizationId, userId: user.id, computeTargetId: computeTarget.id },
        buildPayload([
          buildSession("ext-discovery-1", [branchRef(UNKNOWN_REPOSITORY)]),
          buildSession("ext-discovery-2", [branchRef(UNKNOWN_REPOSITORY)]),
        ])
      );

      const rows = await readObservedRepositories(organizationId);

      expect(rows).toEqual([
        {
          repositoryFullName: UNKNOWN_REPOSITORY,
          verificationState: GitHubObservedRepositoryVerificationState.Pending,
          // Two sessions worked in it, and that weight is what orders the
          // verifier's bounded per-cycle draw.
          observedSessionCount: 2,
        },
      ]);
    });
  });

  it("does not observe repositories that only appear in prose artifact refs (ISS-7888)", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const computeTarget = await createComputeTarget(organizationId, user.id);

      await agentSessionsService.upsertSessions(
        { organizationId, userId: user.id, computeTargetId: computeTarget.id },
        buildPayload([
          buildSession("ext-discovery-prose-only", [
            prosePullRequestRef(PROSE_PR_REPOSITORY),
            proseBranchRef(PROSE_BRANCH_REPOSITORY),
          ]),
        ])
      );

      const rows = await readObservedRepositories(organizationId);

      expect(rows).toEqual([]);
    });
  });

  it("leaves a repository the server already has an identity for out of the candidates", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const computeTarget = await createComputeTarget(organizationId, user.id);
      await seedKnownRepository(organizationId);

      await agentSessionsService.upsertSessions(
        { organizationId, userId: user.id, computeTargetId: computeTarget.id },
        buildPayload([
          buildSession("ext-discovery-3", [
            branchRef(KNOWN_REPOSITORY),
            branchRef(UNKNOWN_REPOSITORY),
          ]),
        ])
      );

      const rows = await readObservedRepositories(organizationId);

      // Discovery is for what the server has never heard of. A repo it can
      // already resolve a provider identity for is not a candidate.
      expect(rows.map((row) => row.repositoryFullName)).toEqual([
        UNKNOWN_REPOSITORY,
      ]);
    });
  });

  it("materializes a branch from a verified observation, and stops observing that repository (PLN-1775 M4)", async () => {
    // The M4 query is raw SQL over a table no typechecker sees, so this is the
    // only place a wrong column name shows up. It also pins the loop closing:
    // once a repository resolves through the fourth authority source it has a
    // provider identity, so the M1 collector stops naming it and the observation
    // counter is self-limiting rather than growing forever.
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const computeTarget = await createComputeTarget(organizationId, user.id);
      await seedVerifiedObservation(organizationId, VERIFIED_REPOSITORY);

      await agentSessionsService.upsertSessions(
        { organizationId, userId: user.id, computeTargetId: computeTarget.id },
        buildPayload([
          buildSession("ext-discovery-4", [branchRef(VERIFIED_REPOSITORY)]),
        ])
      );

      const branches = await withDb((db) =>
        db.branchDetail.findMany({
          where: { organizationId },
          select: {
            repositoryFullName: true,
            branchName: true,
            repositoryId: true,
          },
        })
      );
      expect(branches).toEqual([
        {
          repositoryFullName: VERIFIED_REPOSITORY,
          branchName: "feature/discovery",
          // An observation row is not an installation repository, so it supplies
          // authority without a surrogate repository id.
          repositoryId: null,
        },
      ]);

      const rows = await readObservedRepositories(organizationId);
      expect(rows).toEqual([
        {
          repositoryFullName: VERIFIED_REPOSITORY,
          verificationState: GitHubObservedRepositoryVerificationState.Verified,
          // Untouched by this ingest: the repository now resolves, so it was
          // never a candidate on this pass.
          observedSessionCount: 0,
        },
      ]);
    });
  });
});

/**
 * A due (pending, no horizon) observation row, with an explicit attempt stamp so
 * the selector's nulls-first rotation is deterministic.
 */
async function seedDueObservation(
  organizationId: string,
  repositoryFullName: string,
  lastVerificationAttemptAt: Date | null
): Promise<void> {
  await withDb((db) =>
    db.gitHubObservedRepository.create({
      data: {
        organizationId,
        repositoryFullName,
        verificationState: GitHubObservedRepositoryVerificationState.Pending,
        lastVerificationAttemptAt,
      },
    })
  );
}

async function seedRepoScopedConnection(
  organizationId: string,
  userId: string
): Promise<void> {
  await withDb((db) =>
    db.gitHubUserConnection.create({
      data: {
        organizationId,
        userId,
        githubUserId: `gh-${userId}`,
        login: "octocat",
        normalizedLogin: "octocat",
        scopes: [GITHUB_REPO_SCOPE],
      },
    })
  );
}

describeIfDb("due-org selection under a bounded page", () => {
  it("does not let an org the verifier cannot serve hold a slot", async () => {
    // The starvation this exists to stop (#5551): an org with no live
    // `repo`-scoped connection never has its rows handed to the verifier, so
    // nothing advances their `lastVerificationAttemptAt` and they sit at the head
    // of the nulls-first ordering on every tick, forever. With the connection
    // filter applied AFTER the distinct-org cap, one such org empties a
    // `limit: 1` page and the connected org behind it is never verified — the
    // same shape at `VERIFY_ORG_BATCH` disconnected orgs starves the whole lane.
    //
    // Mocking cannot catch this: the cap and the filter are both the database's
    // to apply, so only a real ordered read over real rows fails when they are
    // applied in the wrong order.
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const starvedOrgId = await createTestOrganization();
      await seedDueObservation(starvedOrgId, "acme/no-credential", null);

      const servableOrgId = await createTestOrganization();
      const user = await createTestUser(servableOrgId);
      await seedRepoScopedConnection(servableOrgId, user.id);
      await seedDueObservation(
        servableOrgId,
        "acme/servable",
        new Date("2026-08-21T09:00:00.000Z")
      );

      const ids = await selectOrgIdsWithDueObservedRepositories(1, UPDATED_AT);

      expect(ids).toEqual([servableOrgId]);
    });
  });
});
