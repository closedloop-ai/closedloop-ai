/**
 * @file iss10332-session-branch-priority.integration.test.ts
 * @description ISS-10332 — Session and Branch priority against a real database.
 *
 * Three things only a database can show:
 *
 *  1. INGEST DOES NOT REVERT IT. A user-set priority on a session and on its
 *     branch survives a re-sync of the same run, because neither ingest update
 *     arm writes `artifacts.priority`.
 *  2. THE WRITE PREDICATE. `updatePriority` carries the organization AND the
 *     artifact type in its lock and its write, so another org's id — or a
 *     same-org artifact of a different type — is a 404 that changes nothing.
 *  3. THE SYNC SEED (PLN-2086 Milestone 3). A desktop-set priority is adopted
 *     only while the cloud artifact holds none, and never overwrites one.
 *
 * Two organizations throughout: a single-org fixture cannot tell a scoped write
 * from an unscoped one.
 */
import { randomUUID } from "node:crypto";
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
} from "@repo/api/src/types/agent-session";
import { ArtifactPriorityMutationErrorCode } from "@repo/api/src/types/artifact-priority-mutation";
import { Priority } from "@repo/api/src/types/common";
import { Status } from "@repo/api/src/types/result";
import { PRIORITY_VALUES } from "@repo/api/src/types/search-query";
import {
  ArtifactRefRelation,
  ArtifactRefTargetKind,
} from "@repo/api/src/types/session-artifact-link";
import { ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import { persistedGitHubRepositoryAuthority } from "@/__tests__/fixtures/repository-default-authority";
import { agentSessionsService } from "@/app/agent-sessions/service";
import { drainBranchMaterializationRetries } from "@/app/agent-sessions/service/artifact-links/branch-materialization-retry-drain";
import { BranchMaterializationRetryPolicy } from "@/app/agent-sessions/service/artifact-links/branch-materialization-retry-policy";
import { branchService } from "@/app/branches/branch-service";
import { artifactBulkPriorityService } from "@/app/documents/artifact-bulk-priority-service";
import { parseDesktopAgentSessionsPayload } from "@/lib/desktop-agent-sessions-schema";
import {
  createTestOrganization,
  createTestUser,
  joinAmbientTransactionForSessionSyncWrites,
} from "../utils/db-helpers";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const REPOSITORY_FULL_NAME = "closedloop-ai/closedloop-ai";
const BRANCH_NAME = "feat/iss-10332-priority";
const STARTED_AT = "2026-09-21T12:00:00.000Z";
const UPDATED_AT = "2026-09-21T12:05:00.000Z";
const RESYNCED_AT = "2026-09-21T12:30:00.000Z";
const EXTERNAL_SESSION_ID = "iss-10332-priority-session";
const RESYNCED_HEAD_SHA = "1033200000000000000000000000000000000002";

/**
 * PLN-2086 Milestone 3: what a desktop payload claims about priority. A key
 * left out is omitted from the payload (an older desktop, or none set); a
 * string outside the vocabulary is what a newer desktop could send.
 */
type DesktopPriority = { session?: string; branch?: string };

type OrganizationFixture = {
  organizationId: string;
  ingest: (updatedAt: string, desktop?: DesktopPriority) => Promise<void>;
  grantRepositoryAuthority: () => Promise<void>;
};

type SeededOrganization = {
  organizationId: string;
  sessionId: string;
  branchId: string;
  ingest: (updatedAt: string, desktop?: DesktopPriority) => Promise<void>;
};

/**
 * The drain and every ingest before it share one transaction per case; the
 * sibling suites' bound, which stays inside the integration tier's 30s.
 */
const DEFERRED_CASE_TX_OPTIONS = { maxWait: 5000, timeout: 20_000 };

describeIfDb("ISS-10332 session and branch priority", () => {
  it("keeps a user-set session and branch priority across a re-ingest", async () => {
    const seeded = await seedOrganization("a");
    try {
      await setPriority(seeded, ArtifactType.SESSION, seeded.sessionId, {
        priority: Priority.Urgent,
      });
      await setPriority(seeded, ArtifactType.BRANCH, seeded.branchId, {
        priority: Priority.Low,
      });

      // A later sync of the SAME run takes the session ingest's update arm...
      await seeded.ingest(RESYNCED_AT);
      // ...and a later push of the SAME branch takes the branch ingest's. The
      // session sync only ever CREATES a branch row, so without this the branch
      // half would pin a write that never ran.
      const pushed = await branchService.upsertBranchArtifact({
        organizationId: seeded.organizationId,
        repositoryFullName: REPOSITORY_FULL_NAME,
        branchName: BRANCH_NAME,
        projectId: null,
        headSha: RESYNCED_HEAD_SHA,
        headShaObservedAt: new Date(RESYNCED_AT),
      });
      expect(pushed.ok ? pushed.value.id : null).toBe(seeded.branchId);

      // Both update arms really ran: each rewrote a column it owns.
      expect(await readArtifactName(seeded.sessionId)).toBe(
        sessionNameAt(RESYNCED_AT)
      );
      expect(await readBranchHeadSha(seeded.branchId)).toBe(RESYNCED_HEAD_SHA);

      expect(await readPriority(seeded.sessionId)).toBe(Priority.Urgent);
      expect(await readPriority(seeded.branchId)).toBe(Priority.Low);
    } finally {
      await cleanupOrganization(seeded.organizationId);
    }
  });

  it("refuses another organization's session and branch, and leaves them unset", async () => {
    const mine = await seedOrganization("a");
    const theirs = await seedOrganization("b");
    try {
      for (const [artifactType, artifactId] of [
        [ArtifactType.SESSION, theirs.sessionId],
        [ArtifactType.BRANCH, theirs.branchId],
      ] as const) {
        const result = await artifactBulkPriorityService.updatePriority({
          artifactId,
          artifactType,
          organizationId: mine.organizationId,
          priority: Priority.High,
        });
        expect(result.ok ? null : result.error.status).toBe(Status.NotFound);
        expect(await readPriority(artifactId)).toBeNull();
      }

      // And the scoped write lands on my row only.
      await setPriority(mine, ArtifactType.SESSION, mine.sessionId, {
        priority: Priority.High,
      });
      expect(await readPriority(mine.sessionId)).toBe(Priority.High);
      expect(await readPriority(theirs.sessionId)).toBeNull();
    } finally {
      await cleanupOrganization(mine.organizationId);
      await cleanupOrganization(theirs.organizationId);
    }
  });

  it("refuses an artifact of a different type than the entry point names", async () => {
    const seeded = await seedOrganization("a");
    try {
      const asSession = await artifactBulkPriorityService.updatePriority({
        artifactId: seeded.branchId,
        artifactType: ArtifactType.SESSION,
        organizationId: seeded.organizationId,
        priority: Priority.High,
      });
      const asBranch = await artifactBulkPriorityService.updatePriority({
        artifactId: seeded.sessionId,
        artifactType: ArtifactType.BRANCH,
        organizationId: seeded.organizationId,
        priority: Priority.High,
      });
      // The document batch stays DOCUMENT-only: a session id is an unknown id.
      const asDocument = await artifactBulkPriorityService.batchUpdatePriority(
        [seeded.sessionId],
        Priority.High,
        seeded.organizationId
      );

      expect(asSession.ok ? null : asSession.error.status).toBe(
        Status.NotFound
      );
      expect(asBranch.ok ? null : asBranch.error.status).toBe(Status.NotFound);
      expect(asDocument.ok ? null : asDocument.error.code).toBe(
        ArtifactPriorityMutationErrorCode.ArtifactsNotFound
      );
      expect(await readPriority(seeded.sessionId)).toBeNull();
      expect(await readPriority(seeded.branchId)).toBeNull();
    } finally {
      await cleanupOrganization(seeded.organizationId);
    }
  });

  it("refuses a SESSION artifact with no session_detail row, before writing anything", async () => {
    const seeded = await seedOrganization("a");
    try {
      await withDb((db) =>
        db.sessionDetail.delete({
          where: { artifactId: seeded.sessionId },
          select: { artifactId: true },
        })
      );

      const result = await artifactBulkPriorityService.updatePriority({
        artifactId: seeded.sessionId,
        artifactType: ArtifactType.SESSION,
        organizationId: seeded.organizationId,
        priority: Priority.Urgent,
      });

      expect(result.ok ? null : result.error.status).toBe(Status.NotFound);
      expect(await readPriority(seeded.sessionId)).toBeNull();
    } finally {
      await cleanupOrganization(seeded.organizationId);
    }
  });

  it("declares the Postgres Priority enum in the wire ordinal's low-to-high order", async () => {
    // `ORDER BY artifacts.priority` resolves against `pg_enum.enumsortorder`,
    // not the Prisma client enum: an `ALTER TYPE ... ADD VALUE ... BEFORE`
    // would reorder the database while the generated client stayed put.
    const rows = await withDb(
      (db) =>
        db.$queryRaw<{ enumlabel: string }[]>`
        SELECT e."enumlabel"
        FROM pg_enum e
        JOIN pg_type t ON t."oid" = e."enumtypid"
        WHERE t."typname" = 'Priority'
        ORDER BY e."enumsortorder" ASC
      `
    );

    expect(rows.map((row) => row.enumlabel)).toEqual(PRIORITY_VALUES);
  });

  it("guards on expectedPriority, where null asserts unset and absent is unguarded", async () => {
    const seeded = await seedOrganization("a");
    try {
      // Stored: unset. Expecting HIGH is stale and must not write.
      const stale = await artifactBulkPriorityService.updatePriority({
        artifactId: seeded.branchId,
        artifactType: ArtifactType.BRANCH,
        organizationId: seeded.organizationId,
        priority: Priority.Urgent,
        expectedPriority: Priority.High,
      });
      expect(stale.ok ? null : stale.error.code).toBe(
        ArtifactPriorityMutationErrorCode.StalePriority
      );
      expect(stale.ok ? null : stale.error.status).toBe(Status.Conflict);
      expect(await readPriority(seeded.branchId)).toBeNull();

      // `null` asserts "holds none", which is true — so this one writes.
      await setPriority(seeded, ArtifactType.BRANCH, seeded.branchId, {
        priority: Priority.Urgent,
        expectedPriority: null,
      });
      expect(await readPriority(seeded.branchId)).toBe(Priority.Urgent);

      // The same `null` expectation is now stale: the row holds URGENT.
      const staleNull = await artifactBulkPriorityService.updatePriority({
        artifactId: seeded.branchId,
        artifactType: ArtifactType.BRANCH,
        organizationId: seeded.organizationId,
        priority: Priority.Low,
        expectedPriority: null,
      });
      expect(staleNull.ok).toBe(false);
      expect(await readPriority(seeded.branchId)).toBe(Priority.Urgent);

      // Absent expectation: last-write-wins, and `null` CLEARS.
      await setPriority(seeded, ArtifactType.BRANCH, seeded.branchId, {
        priority: null,
      });
      expect(await readPriority(seeded.branchId)).toBeNull();
    } finally {
      await cleanupOrganization(seeded.organizationId);
    }
  });

  // ISS-9486 ruling 2: a retried commit still carries the expectation its first
  // attempt already moved the row off, and must not 409 against that success.
  it.each([ArtifactType.SESSION, ArtifactType.BRANCH] as const)(
    "accepts a same-value retry of a %s priority write whose expectation is stale",
    async (artifactType) => {
      const seeded = await seedOrganization("a");
      const artifactId =
        artifactType === ArtifactType.SESSION
          ? seeded.sessionId
          : seeded.branchId;
      try {
        const write = {
          artifactId,
          artifactType,
          organizationId: seeded.organizationId,
          priority: Priority.Urgent,
          expectedPriority: null,
        };
        const first = await artifactBulkPriorityService.updatePriority(write);
        const retry = await artifactBulkPriorityService.updatePriority(write);

        expect(first.ok ? first.value.changed : first.error.code).toBe(true);
        expect(retry.ok ? retry.value.changed : retry.error.code).toBe(false);
        expect(await readPriority(artifactId)).toBe(Priority.Urgent);

        // A DIFFERENT value under the same stale expectation is still refused.
        const moved = await artifactBulkPriorityService.updatePriority({
          ...write,
          priority: Priority.Low,
        });
        expect(moved.ok ? null : moved.error.code).toBe(
          ArtifactPriorityMutationErrorCode.StalePriority
        );
        expect(await readPriority(artifactId)).toBe(Priority.Urgent);
      } finally {
        await cleanupOrganization(seeded.organizationId);
      }
    }
  );
});

// PLN-2086 Milestone 3 (steps 17-19): a priority set on the desktop in local
// mode travels up on sync and is SEEDED — adopted only while the cloud artifact
// holds none. Two organizations sync the same run and the same branch identity
// throughout, so a seed that reached the other org's row would show.
describeIfDb("ISS-10332 desktop priority seed on sync", () => {
  it("adopts a desktop priority into an artifact holding none, on create and on update, in its own org only", async () => {
    // The unset org first, so a seed that escaped its own org would land on
    // this row while it still holds none.
    const updated = await seedOrganization("b");
    const created = await seedOrganization("a", {
      session: Priority.Urgent,
      branch: Priority.High,
    });
    try {
      // The create arm: the first sync already carried the priorities.
      expect(await readPriority(created.sessionId)).toBe(Priority.Urgent);
      expect(await readPriority(created.branchId)).toBe(Priority.High);
      // The other org's identical run and branch took nothing from it.
      expect(await readPriority(updated.sessionId)).toBeNull();
      expect(await readPriority(updated.branchId)).toBeNull();

      // The update arm: a later sync of an unset run seeds it.
      await updated.ingest(RESYNCED_AT, {
        session: Priority.Low,
        branch: Priority.Medium,
      });
      expect(await readArtifactName(updated.sessionId)).toBe(
        sessionNameAt(RESYNCED_AT)
      );
      expect(await readPriority(updated.sessionId)).toBe(Priority.Low);
      expect(await readPriority(updated.branchId)).toBe(Priority.Medium);
      expect(await readPriority(created.sessionId)).toBe(Priority.Urgent);
      expect(await readPriority(created.branchId)).toBe(Priority.High);
    } finally {
      await cleanupOrganization(created.organizationId);
      await cleanupOrganization(updated.organizationId);
    }
  });

  it("never overwrites a priority the cloud already holds", async () => {
    const seeded = await seedOrganization("a");
    try {
      await setPriority(seeded, ArtifactType.SESSION, seeded.sessionId, {
        priority: Priority.Urgent,
      });
      await setPriority(seeded, ArtifactType.BRANCH, seeded.branchId, {
        priority: Priority.Low,
      });

      await seeded.ingest(RESYNCED_AT, {
        session: Priority.Medium,
        branch: Priority.High,
      });

      expect(await readArtifactName(seeded.sessionId)).toBe(
        sessionNameAt(RESYNCED_AT)
      );
      expect(await readPriority(seeded.sessionId)).toBe(Priority.Urgent);
      expect(await readPriority(seeded.branchId)).toBe(Priority.Low);
    } finally {
      await cleanupOrganization(seeded.organizationId);
    }
  });

  it("keeps a web clear across a re-sync that no longer carries the desktop's priority", async () => {
    // PR #7794 review: a desktop priority seeds HIGH, the web clears it, and
    // the run re-syncs. The desktop stops sending a value once a confirmed sync
    // has carried it, so the re-sync omits it — and an omission must leave the
    // clear in place. The other org is seeded identically and never cleared.
    const cleared = await seedOrganization("a", {
      session: Priority.High,
      branch: Priority.High,
    });
    const untouched = await seedOrganization("b", {
      session: Priority.High,
      branch: Priority.High,
    });
    try {
      expect(await readPriority(cleared.sessionId)).toBe(Priority.High);
      expect(await readPriority(cleared.branchId)).toBe(Priority.High);
      await setPriority(cleared, ArtifactType.SESSION, cleared.sessionId, {
        priority: null,
      });
      await setPriority(cleared, ArtifactType.BRANCH, cleared.branchId, {
        priority: null,
      });

      await cleared.ingest(RESYNCED_AT);
      await untouched.ingest(RESYNCED_AT);

      // The re-sync really took the update arm.
      expect(await readArtifactName(cleared.sessionId)).toBe(
        sessionNameAt(RESYNCED_AT)
      );
      expect(await readPriority(cleared.sessionId)).toBeNull();
      expect(await readPriority(cleared.branchId)).toBeNull();
      expect(await readPriority(untouched.sessionId)).toBe(Priority.High);
      expect(await readPriority(untouched.branchId)).toBe(Priority.High);

      // What the omission protects against: a payload that still carried the
      // value — the desktop before the fix — re-seeds the cleared artifacts.
      const staleResyncAt = "2026-09-21T13:30:00.000Z";
      await cleared.ingest(staleResyncAt, {
        session: Priority.High,
        branch: Priority.High,
      });
      expect(await readPriority(cleared.sessionId)).toBe(Priority.High);
      expect(await readPriority(cleared.branchId)).toBe(Priority.High);
    } finally {
      await cleanupOrganization(cleared.organizationId);
      await cleanupOrganization(untouched.organizationId);
    }
  });

  it("leaves the cloud untouched for an omitted or an unknown desktop priority", async () => {
    const seeded = await seedOrganization("a");
    try {
      await setPriority(seeded, ArtifactType.SESSION, seeded.sessionId, {
        priority: Priority.High,
      });

      // An older desktop omits the field: no claim, nothing cleared.
      await seeded.ingest(RESYNCED_AT);
      expect(await readPriority(seeded.sessionId)).toBe(Priority.High);
      expect(await readPriority(seeded.branchId)).toBeNull();

      // A newer desktop's member this cloud cannot read: the session is still
      // accepted, and the value is dropped rather than seeded or rejected.
      const newerSyncAt = "2026-09-21T13:00:00.000Z";
      await seeded.ingest(newerSyncAt, {
        session: "CRITICAL",
        branch: "CRITICAL",
      });
      expect(await readArtifactName(seeded.sessionId)).toBe(
        sessionNameAt(newerSyncAt)
      );
      expect(await readPriority(seeded.sessionId)).toBe(Priority.High);
      expect(await readPriority(seeded.branchId)).toBeNull();
    } finally {
      await cleanupOrganization(seeded.organizationId);
    }
  });
});

// A branch the first sync cannot materialize (here: no repository authority
// yet) is created later by the retry drain, from the durable retry row alone —
// so that row is all that can carry the desktop's claim to it.
describeIfDb("ISS-10332 desktop priority seed on a deferred branch", () => {
  it("seeds the claim when the retry drain materializes the branch, in its own org only", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      // The unclaimed org first, so a seed that escaped its own org would
      // land on this branch while it still holds none.
      const unclaimed = await createOrganizationFixture("b");
      const claimed = await createOrganizationFixture("a");
      await unclaimed.ingest(UPDATED_AT);
      // The claim arrives on a LATER sync of the still-deferred branch, so it
      // has to merge into the retry row the first sync wrote.
      await claimed.ingest(UPDATED_AT);
      await claimed.ingest(RESYNCED_AT, { branch: Priority.High });

      // Deferred, not dropped: no branch yet, one durable retry row per org.
      expect(await branchCount(claimed.organizationId)).toBe(0);
      expect(await retryRowCount(claimed.organizationId)).toBe(1);
      expect(await retryRowCount(unclaimed.organizationId)).toBe(1);

      await unclaimed.grantRepositoryAuthority();
      await claimed.grantRepositoryAuthority();
      await drainBranchMaterializationRetries(afterRetryBackoff());

      // Both retries settled by materializing, which the priorities below
      // are read from.
      expect(await retryRowCount(claimed.organizationId)).toBe(0);
      expect(await retryRowCount(unclaimed.organizationId)).toBe(0);
      expect(
        await readPriority(
          await readArtifactId(claimed.organizationId, ArtifactType.BRANCH)
        )
      ).toBe(Priority.High);
      expect(
        await readPriority(
          await readArtifactId(unclaimed.organizationId, ArtifactType.BRANCH)
        )
      ).toBeNull();
    }, DEFERRED_CASE_TX_OPTIONS);
  });

  it("never overwrites a priority the branch gained before the drain ran", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fixture = await createOrganizationFixture("a");
      await fixture.ingest(UPDATED_AT, { branch: Priority.Low });
      await fixture.grantRepositoryAuthority();
      // Another producer creates the branch first, and a user sets it.
      const pushed = await branchService.upsertBranchArtifact({
        organizationId: fixture.organizationId,
        repositoryFullName: REPOSITORY_FULL_NAME,
        branchName: BRANCH_NAME,
        projectId: null,
        headSha: RESYNCED_HEAD_SHA,
        headShaObservedAt: new Date(RESYNCED_AT),
      });
      if (!pushed.ok) {
        throw new Error("branch push refused");
      }
      const branchId = pushed.value.id;
      await setPriority(fixture, ArtifactType.BRANCH, branchId, {
        priority: Priority.Urgent,
      });

      await drainBranchMaterializationRetries(afterRetryBackoff());

      // The retry settled onto the existing row, and left its value alone.
      expect(await retryRowCount(fixture.organizationId)).toBe(0);
      expect(await readPriority(branchId)).toBe(Priority.Urgent);
    }, DEFERRED_CASE_TX_OPTIONS);
  });
});

async function setPriority(
  seeded: { organizationId: string },
  artifactType: typeof ArtifactType.SESSION | typeof ArtifactType.BRANCH,
  artifactId: string,
  write: { priority: Priority | null; expectedPriority?: Priority | null }
): Promise<void> {
  const result = await artifactBulkPriorityService.updatePriority({
    artifactId,
    artifactType,
    organizationId: seeded.organizationId,
    ...write,
  });
  if (!result.ok) {
    throw new Error(`priority write refused: ${result.error.code}`);
  }
}

async function readPriority(artifactId: string): Promise<Priority | null> {
  const row = await withDb((db) =>
    db.artifact.findUniqueOrThrow({
      where: { id: artifactId },
      select: { priority: true },
    })
  );
  return row.priority;
}

function sessionNameAt(updatedAt: string): string {
  return `ISS-10332 priority ${updatedAt}`;
}

async function readArtifactName(artifactId: string): Promise<string | null> {
  const row = await withDb((db) =>
    db.artifact.findUniqueOrThrow({
      where: { id: artifactId },
      select: { name: true },
    })
  );
  return row.name;
}

async function readBranchHeadSha(artifactId: string): Promise<string | null> {
  const row = await withDb((db) =>
    db.branchDetail.findUniqueOrThrow({
      where: { artifactId },
      select: { headSha: true },
    })
  );
  return row.headSha;
}

/** One org with one ingested session that created one branch. */
async function seedOrganization(
  label: string,
  firstIngest?: DesktopPriority
): Promise<SeededOrganization> {
  const fixture = await createOrganizationFixture(label);
  await fixture.grantRepositoryAuthority();
  await fixture.ingest(UPDATED_AT, firstIngest);
  return {
    organizationId: fixture.organizationId,
    sessionId: await readArtifactId(
      fixture.organizationId,
      ArtifactType.SESSION
    ),
    branchId: await readArtifactId(fixture.organizationId, ArtifactType.BRANCH),
    ingest: fixture.ingest,
  };
}

/**
 * One org that can sync the run, with no repository authority until it is
 * granted — before that, the run's branch cannot materialize.
 */
async function createOrganizationFixture(
  label: string
): Promise<OrganizationFixture> {
  const organizationId = await createTestOrganization();
  const user = await createTestUser(organizationId);
  const computeTarget = await withDb((db) =>
    db.computeTarget.create({
      data: {
        organizationId,
        userId: user.id,
        machineName: `iss-10332-priority-${label}`,
        platform: "darwin",
      },
      select: { id: true },
    })
  );
  return {
    organizationId,
    ingest: async (updatedAt, desktop) => {
      await agentSessionsService.upsertSessions(
        { organizationId, userId: user.id, computeTargetId: computeTarget.id },
        buildPayload(updatedAt, desktop)
      );
    },
    grantRepositoryAuthority: async () => {
      await withDb((db) =>
        db.publicRepository.create({
          data: {
            organizationId,
            ...persistedGitHubRepositoryAuthority({
              githubRepoId: `repo-iss-10332-${label}`,
              fullName: REPOSITORY_FULL_NAME,
            }),
            owner: "closedloop-ai",
            name: "closedloop-ai",
            htmlUrl: `https://github.com/${REPOSITORY_FULL_NAME}`,
          },
        })
      );
    },
  };
}

function branchCount(organizationId: string): Promise<number> {
  return withDb((db) =>
    db.artifact.count({ where: { organizationId, type: ArtifactType.BRANCH } })
  );
}

function retryRowCount(organizationId: string): Promise<number> {
  return withDb((db) =>
    db.branchMaterializationRetry.count({ where: { organizationId } })
  );
}

/** Past the enqueue's own initial backoff, so the drain claims the row. */
function afterRetryBackoff(): Date {
  return new Date(
    Date.now() + BranchMaterializationRetryPolicy.BaseDelayMs * 2
  );
}

async function readArtifactId(
  organizationId: string,
  type: typeof ArtifactType.SESSION | typeof ArtifactType.BRANCH
): Promise<string> {
  const rows = await withDb((db) =>
    db.artifact.findMany({
      where: { organizationId, type },
      select: { id: true },
    })
  );
  if (rows.length !== 1) {
    throw new Error(`expected one ${type} artifact, found ${rows.length}`);
  }
  return rows[0].id;
}

/**
 * The payload AS INGESTED: parsed by the route's own boundary schema, so a
 * desktop priority reaches the service exactly as the route would hand it on —
 * an unknown value already dropped rather than passed through.
 */
function buildPayload(
  updatedAt: string,
  desktop?: DesktopPriority
): Parameters<typeof agentSessionsService.upsertSessions>[1] {
  const payload = {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: randomUUID(),
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: 1,
    sessions: [buildSession(updatedAt, desktop)],
  };
  const parsed = parseDesktopAgentSessionsPayload(payload);
  if (!parsed.ok) {
    throw new Error(`invalid integration payload: ${parsed.reason}`);
  }
  return parsed.payload;
}

function buildSession(
  updatedAt: string,
  desktop: DesktopPriority = {}
): Record<string, unknown> {
  return {
    ...(desktop.session === undefined ? {} : { priority: desktop.session }),
    externalSessionId: EXTERNAL_SESSION_ID,
    // The name moves with the sync so the artifact update arm has a real write
    // to make — a re-ingest that changed nothing would prove less.
    name: sessionNameAt(updatedAt),
    status: "active",
    harness: "claude",
    cwd: "/tmp/iss-10332",
    model: "claude-opus-5",
    startedAt: STARTED_AT,
    updatedAt,
    agents: [
      {
        externalAgentId: "agent-iss-10332",
        name: "Implementation worker",
        type: "main",
        status: "active",
      },
    ],
    events: [
      {
        externalEventId: `${EXTERNAL_SESSION_ID}-event-0`,
        agentExternalId: "agent-iss-10332",
        eventType: "message",
        createdAt: STARTED_AT,
      },
    ],
    tokenUsageByModel: [],
    tokenEvents: [],
    artifactRefs: [
      {
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: REPOSITORY_FULL_NAME,
        branchName: BRANCH_NAME,
        method: "git_push",
        relation: ArtifactRefRelation.Created,
        observedAt: updatedAt,
        ...(desktop.branch === undefined ? {} : { priority: desktop.branch }),
      },
    ],
    prRefs: [],
  };
}

async function cleanupOrganization(organizationId: string): Promise<void> {
  await withDb(async (db) => {
    const artifacts = await db.artifact.findMany({
      where: { organizationId },
      select: { id: true },
    });
    const artifactIds = artifacts.map((artifact) => artifact.id);
    await db.agentSessionEvent.deleteMany({
      where: { agentSessionId: { in: artifactIds } },
    });
    await db.artifactLink.deleteMany({
      where: {
        OR: [
          { sourceId: { in: artifactIds } },
          { targetId: { in: artifactIds } },
        ],
      },
    });
    await db.sessionDetail.deleteMany({
      where: { artifactId: { in: artifactIds } },
    });
    await db.branchDetail.deleteMany({ where: { organizationId } });
    await db.publicRepository.deleteMany({ where: { organizationId } });
    await db.artifact.deleteMany({ where: { id: { in: artifactIds } } });
    await db.computeTarget.deleteMany({ where: { organizationId } });
    await db.user.deleteMany({ where: { organizationId } });
    await db.organization.deleteMany({ where: { id: organizationId } });
  });
}
