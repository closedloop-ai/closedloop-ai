import { randomUUID } from "node:crypto";
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
} from "@repo/api/src/types/agent-session";
import {
  ArtifactRefRelation,
  ArtifactRefTargetKind,
} from "@repo/api/src/types/session-artifact-link";
import { ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import { persistedGitHubRepositoryAuthority } from "@/__tests__/fixtures/repository-default-authority";
import {
  type ObservedStatement,
  observeStatements,
} from "@/__tests__/support/db-statement-observer";
import {
  FIRST_PUSHED_AT,
  GIT_PUSH_METHOD,
  readAssignee,
  seedBranch,
  seedEvidenceLink,
} from "@/__tests__/utils/branch-identity-sql-fixture";
import { agentSessionsService } from "@/app/agent-sessions/service";
import { drainBranchMaterializationRetries } from "@/app/agent-sessions/service/artifact-links/branch-materialization-retry-drain";
import { BranchMaterializationRetryPolicy } from "@/app/agent-sessions/service/artifact-links/branch-materialization-retry-policy";
import { branchService } from "@/app/branches/branch-service";
import { parseDesktopAgentSessionsPayload } from "@/lib/desktop-agent-sessions-schema";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestUser,
  joinAmbientTransactionForSessionSyncWrites,
} from "../utils/db-helpers";

/**
 * ISS-12463 / PLN-2192 T-3.2a: each production entry point C2 hooks stamps the
 * branch assignee. Session ingest (T-1.3), the retry drain (T-1.4) and
 * `upsertBranchArtifactOnce` (T-1.7).
 */
const hasDatabase = Boolean(keys().DATABASE_URL);

const REPOSITORY_FULL_NAME = "closedloop-ai/closedloop-ai";
const BRANCH_NAME = "feat/iss-12463-owner-seed";
const SECOND_BRANCH_NAME = "feat/iss-12463-owner-seed-second";
/** The SQL that only `seedBranchOwners` issues. */
const SEED_STATEMENT_MARKER = "FOR NO KEY UPDATE SKIP LOCKED";
const STARTED_AT = "2026-10-16T12:00:00.000Z";
const UPDATED_AT = "2026-10-16T12:05:00.000Z";
const EXTERNAL_SESSION_ID = "iss-12463-owner-seed-session";
const HEAD_SHA = "1246300000000000000000000000000000000001";
const DRAIN_TX_OPTIONS = { maxWait: 5000, timeout: 20_000 };

describe.skipIf(!hasDatabase)("ISS-12463 branch owner seed wiring", () => {
  it("session ingest seeds the pushing user as the branch assignee", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fixture = await createSyncFixture("ingest");
      await fixture.grantRepositoryAuthority();

      await fixture.ingest();

      const branchId = await readBranchId(fixture.organizationId);
      expect(await readAssignee(branchId)).toBe(fixture.userId);
    });
  });

  it("a re-ingest seeds only the batch's branches that hold no assignee", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fixture = await createSyncFixture("reingest-cleared", [
        BRANCH_NAME,
        SECOND_BRANCH_NAME,
      ]);
      await fixture.grantRepositoryAuthority();
      await fixture.ingest();
      const kept = await readBranchIdByName(
        fixture.organizationId,
        BRANCH_NAME
      );
      const cleared = await readBranchIdByName(
        fixture.organizationId,
        SECOND_BRANCH_NAME
      );
      const other = await createTestUser(fixture.organizationId);
      await setAssignee(kept, other.id);
      await setAssignee(cleared, null);

      const { statements } = await observeStatements(fixture.ingest);

      expect(seedStatementIds(statements)).toEqual([[cleared]]);
      expect(await readAssignee(cleared)).toBe(fixture.userId);
      expect(await readAssignee(kept)).toBe(other.id);
    });
  });

  it("a re-ingest whose branches are all assigned issues no seed statement", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fixture = await createSyncFixture("reingest-assigned");
      await fixture.grantRepositoryAuthority();
      await fixture.ingest();
      const branchId = await readBranchId(fixture.organizationId);
      const other = await createTestUser(fixture.organizationId);
      await setAssignee(branchId, other.id);

      const { statements } = await observeStatements(fixture.ingest);

      expect(seedStatementIds(statements)).toEqual([]);
      expect(await readAssignee(branchId)).toBe(other.id);
    });
  });

  it("the retry drain seeds the pushing user when it materializes a deferred branch", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fixture = await createSyncFixture("drain");
      await fixture.ingest();
      expect(await branchCount(fixture.organizationId)).toBe(0);

      await fixture.grantRepositoryAuthority();
      await drainBranchMaterializationRetries(afterRetryBackoff());

      const branchId = await readBranchId(fixture.organizationId);
      expect(await readAssignee(branchId)).toBe(fixture.userId);
    }, DRAIN_TX_OPTIONS);
  });

  it("a branch upsert seeds an unassigned branch whose chain resolves", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const pusher = await createTestUser(organizationId);
      const branchName = "upsert-seed";
      const branchId = await seedBranch(organizationId, branchName, {
        firstPushedAt: FIRST_PUSHED_AT,
      });
      await seedEvidenceLink({
        organizationId,
        branchId,
        userId: pusher.id,
        label: branchName,
        method: GIT_PUSH_METHOD,
        observedAt: FIRST_PUSHED_AT,
      });
      await grantRepositoryAuthority(
        organizationId,
        `acme/${branchName}`,
        branchName
      );
      expect(await readAssignee(branchId)).toBeNull();

      const pushed = await branchService.upsertBranchArtifact({
        organizationId,
        repositoryFullName: `acme/${branchName}`,
        branchName,
        projectId: null,
        headSha: HEAD_SHA,
        headShaObservedAt: new Date(UPDATED_AT),
      });

      expect(pushed.ok ? pushed.value.id : null).toBe(branchId);
      expect(await readAssignee(branchId)).toBe(pusher.id);
    });
  });
});

type SyncFixture = {
  organizationId: string;
  userId: string;
  ingest: () => Promise<void>;
  grantRepositoryAuthority: () => Promise<void>;
};

/** One org that syncs one pushing run; the branch cannot materialize until authority is granted. */
async function createSyncFixture(
  label: string,
  branchNames: readonly string[] = [BRANCH_NAME]
): Promise<SyncFixture> {
  const organizationId = await createTestOrganization();
  const user = await createTestUser(organizationId);
  const computeTarget = await withDb((db) =>
    db.computeTarget.create({
      data: {
        organizationId,
        userId: user.id,
        machineName: `iss-12463-owner-seed-${label}`,
        platform: "darwin",
      },
      select: { id: true },
    })
  );
  return {
    organizationId,
    userId: user.id,
    ingest: async () => {
      await agentSessionsService.upsertSessions(
        { organizationId, userId: user.id, computeTargetId: computeTarget.id },
        buildPayload(branchNames)
      );
    },
    grantRepositoryAuthority: () =>
      grantRepositoryAuthority(organizationId, REPOSITORY_FULL_NAME, label),
  };
}

async function grantRepositoryAuthority(
  organizationId: string,
  fullName: string,
  label: string
): Promise<void> {
  const [owner, name] = fullName.split("/");
  await withDb((db) =>
    db.publicRepository.create({
      data: {
        organizationId,
        ...persistedGitHubRepositoryAuthority({
          githubRepoId: `repo-iss-12463-${label}`,
          fullName,
        }),
        owner,
        name,
        htmlUrl: `https://github.com/${fullName}`,
      },
    })
  );
}

function branchCount(organizationId: string): Promise<number> {
  return withDb((db) =>
    db.artifact.count({ where: { organizationId, type: ArtifactType.BRANCH } })
  );
}

async function readBranchId(organizationId: string): Promise<string> {
  const rows = await withDb((db) =>
    db.artifact.findMany({
      where: { organizationId, type: ArtifactType.BRANCH },
      select: { id: true },
    })
  );
  if (rows.length !== 1) {
    throw new Error(`expected one branch, found ${rows.length}`);
  }
  return rows[0].id;
}

async function readBranchIdByName(
  organizationId: string,
  branchName: string
): Promise<string> {
  const row = await withDb((db) =>
    db.branchDetail.findFirstOrThrow({
      where: { organizationId, branchName },
      select: { artifactId: true },
    })
  );
  return row.artifactId;
}

async function setAssignee(
  branchId: string,
  assigneeId: string | null
): Promise<void> {
  await withDb((db) =>
    db.artifact.update({ where: { id: branchId }, data: { assigneeId } })
  );
}

/** The branch ids each observed `seedBranchOwners` statement was bound with. */
function seedStatementIds(statements: readonly ObservedStatement[]): unknown[] {
  return statements
    .filter((statement) => statement.sql.includes(SEED_STATEMENT_MARKER))
    .map((statement) => statement.values.find(Array.isArray));
}

/** Past the enqueue's own initial backoff, so the drain claims the row. */
function afterRetryBackoff(): Date {
  return new Date(
    Date.now() + BranchMaterializationRetryPolicy.BaseDelayMs * 2
  );
}

function buildPayload(
  branchNames: readonly string[]
): Parameters<typeof agentSessionsService.upsertSessions>[1] {
  const parsed = parseDesktopAgentSessionsPayload({
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: randomUUID(),
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: 1,
    sessions: [
      {
        externalSessionId: EXTERNAL_SESSION_ID,
        name: "ISS-12463 owner seed",
        status: "active",
        harness: "claude",
        cwd: "/tmp/iss-12463",
        model: "claude-opus-5",
        startedAt: STARTED_AT,
        updatedAt: UPDATED_AT,
        agents: [
          {
            externalAgentId: "agent-iss-12463",
            name: "Implementation worker",
            type: "main",
            status: "active",
          },
        ],
        events: [
          {
            externalEventId: `${EXTERNAL_SESSION_ID}-event-0`,
            agentExternalId: "agent-iss-12463",
            eventType: "message",
            createdAt: STARTED_AT,
          },
        ],
        tokenUsageByModel: [],
        tokenEvents: [],
        artifactRefs: branchNames.map((branchName) => ({
          kind: ArtifactRefTargetKind.Branch,
          repositoryFullName: REPOSITORY_FULL_NAME,
          branchName,
          method: GIT_PUSH_METHOD,
          relation: ArtifactRefRelation.Created,
          observedAt: UPDATED_AT,
        })),
        prRefs: [],
      },
    ],
  });
  if (!parsed.ok) {
    throw new Error(`invalid integration payload: ${parsed.reason}`);
  }
  return parsed.payload;
}
