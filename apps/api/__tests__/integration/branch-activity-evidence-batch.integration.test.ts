import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  BranchActivityAtomVersion,
  BranchActivityAttributionKind,
  BranchActivityEvidenceCompleteness,
  BranchActivitySource,
} from "@repo/api/src/types/branch-activity";
import { MonitoredSessionActivityEventKind } from "@repo/api/src/types/branch-activity-kind";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  type SyncedBranchArtifactRef,
} from "@repo/api/src/types/session-artifact-link";
import type { SyncedMonitoredSessionActivityEvent } from "@repo/api/src/types/session-monitored-activity";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import { persistMonitoredSessionActivity } from "@/app/agent-sessions/service/monitored-session-activity";
import { bindParameterChunkSize } from "@/app/agent-sessions/service/write-chunking";
import { BranchActivityPersistStatus } from "@/app/branches/branch-activity-evidence";
import { persistBranchActivityAtomsInTransaction } from "@/app/branches/branch-activity-evidence-batch";
import {
  autoRollbackTransactionJoining,
  createTestOrganization,
} from "../utils/db-helpers";

/**
 * ISS-11104 — this suite lets its ambient transaction absorb the nested
 * `withDb.tx` its production path opens, discarding that call's own budget.
 * The reason below is the whole statement: it is what a reviewer reads to tell
 * a suite that does not need the real boundary from one that is blind to it.
 */
const joinAmbientTransaction = autoRollbackTransactionJoining(
  "this suite's own persistBatch helper budgets the transaction it opens; the cases pin the evidence rows it writes, not that boundary"
);

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;
/**
 * One past the widest `createManyAndReturn` the writer may issue for
 * `BranchActivityAtom` (thirteen bound columns per row), so the insert and the
 * replay both cross a chunk boundary against the real driver.
 */
const PAST_ONE_INSERT_CHUNK = bindParameterChunkSize(13, 0) + 1;
/** A full desktop sync page: `MONITORED_ACTIVITY_SYNC_PAGE_EVENTS`. */
const FULL_PAGE_EVENT_COUNT = 1000;
const BRANCH_COUNT = 8;
const REPOSITORY = "closedloop-ai/closedloop-ai";
const FIRST_EVENT_AT = "2026-08-12T12:00:00.000Z";
const TRANSACTION_OPTIONS = { maxWait: 5000, timeout: 20_000 };

type SeededBranch = { artifactId: string; branchName: string };

describeIfDb("Branch activity batch persistence", () => {
  it("persists and replay-validates a batch past one insert chunk boundary in one transaction (ISS-9860)", async () => {
    await joinAmbientTransaction(async () => {
      const organizationId = await createTestOrganization();
      const branches = await seedBranches(organizationId, "batch");
      const records = Array.from(
        { length: PAST_ONE_INSERT_CHUNK },
        (_, index) => ({
          branchArtifactId: branches[index % BRANCH_COUNT].artifactId,
          sourceEventId: `monitored_session_v1:batch-${index}`,
          occurredAt: eventAt(index),
        })
      );
      const lastRecord = records.at(-1);
      if (!lastRecord) {
        throw new Error("chunk-boundary fixture unexpectedly empty");
      }

      const inserted = await persistBatch(
        organizationId,
        records,
        BranchActivityEvidenceCompleteness.Complete
      );
      expect(inserted).toHaveLength(PAST_ONE_INSERT_CHUNK);
      expect(
        inserted.every(
          (result) => result.status === BranchActivityPersistStatus.Inserted
        )
      ).toBe(true);

      const replayed = await persistBatch(
        organizationId,
        records,
        BranchActivityEvidenceCompleteness.Partial
      );
      expect(replayed).toHaveLength(PAST_ONE_INSERT_CHUNK);
      expect(
        replayed.every(
          (result) => result.status === BranchActivityPersistStatus.Replayed
        )
      ).toBe(true);

      const persisted = await withDb(async (db) => ({
        count: await db.branchActivityAtom.count({
          where: {
            organizationId,
            source: BranchActivitySource.MonitoredSession,
          },
        }),
        lastBranch: await db.branchDetail.findUnique({
          where: { artifactId: lastRecord.branchArtifactId },
          select: { lastActivityAt: true },
        }),
      }));
      expect(persisted.count).toBe(PAST_ONE_INSERT_CHUNK);
      expect(persisted.lastBranch?.lastActivityAt).toEqual(
        new Date(lastRecord.occurredAt)
      );
    }, TRANSACTION_OPTIONS);
  });

  it("persists one full 1,000-event page through persistMonitoredSessionActivity (ISS-9860)", async ({
    annotate,
  }) => {
    await joinAmbientTransaction(async () => {
      const organizationId = await createTestOrganization();
      const branches = await seedBranches(organizationId, "page");
      const sessionArtifactId = randomUUID();
      const artifactRefs = branches.map((branch, target) =>
        monitoredBranchRef(
          branch.branchName,
          Array.from({ length: FULL_PAGE_EVENT_COUNT }, (_, index) => index)
            .filter((index) => index % BRANCH_COUNT === target)
            .map((index) => ({
              kind: MonitoredSessionActivityEventKind.AgentRead,
              sourceEventId: `monitored_session_v1:page-${index}`,
              occurredAt: eventAt(index),
              completeness: BranchActivityEvidenceCompleteness.Complete,
            }))
        )
      );

      const startedAt = performance.now();
      const result = await withDb.tx(
        (tx) =>
          persistMonitoredSessionActivity(tx, {
            organizationId,
            sessionArtifactId,
            artifactRefs,
            pullRequestLane: {
              details: new Map(),
              // Branch refs only, so the PR lane ran over nothing.
              deferrals: new Map(),
            },
            repositoryIdentity: {
              authorities: new Map(),
              probedNames: new Set([REPOSITORY]),
            },
          }),
        TRANSACTION_OPTIONS
      );
      const elapsedMs = Math.round(performance.now() - startedAt);
      await annotate(
        `1,000-event page through persistMonitoredSessionActivity: ${elapsedMs} ms`
      );

      expect(result.retryRequired).toBe(false);
      expect(result.persistedCount).toBe(FULL_PAGE_EVENT_COUNT);
      const persisted = await withDb(async (db) => ({
        canonical: await db.branchActivityAtom.count({
          where: {
            organizationId,
            source: BranchActivitySource.MonitoredSession,
            compatibilityAliasForSourceEventId: null,
          },
        }),
        aliases: await db.branchActivityAtom.count({
          where: {
            organizationId,
            source: BranchActivitySource.MonitoredSession,
            compatibilityAliasForSourceEventId: { not: null },
          },
        }),
        partial: await db.branchActivityAtom.count({
          where: {
            organizationId,
            completeness: BranchActivityEvidenceCompleteness.Partial,
          },
        }),
      }));
      expect(persisted.canonical).toBe(FULL_PAGE_EVENT_COUNT);
      expect(persisted.aliases).toBe(FULL_PAGE_EVENT_COUNT);
      expect(persisted.partial).toBe(0);
    }, TRANSACTION_OPTIONS);
  });
});

function eventAt(index: number): string {
  return new Date(Date.parse(FIRST_EVENT_AT) + index * 1000).toISOString();
}

async function seedBranches(
  organizationId: string,
  label: string
): Promise<SeededBranch[]> {
  const branches = Array.from({ length: BRANCH_COUNT }, (_, index) => ({
    artifactId: randomUUID(),
    branchName: `feat/iss-9860-${label}-${index}`,
  }));
  await withDb(async (db) => {
    await db.artifact.createMany({
      data: branches.map((branch) => ({
        id: branch.artifactId,
        organizationId,
        type: ArtifactType.Branch,
        name: branch.branchName,
        status: GitHubPRState.Open,
      })),
    });
    await db.branchDetail.createMany({
      data: branches.map((branch) => ({
        artifactId: branch.artifactId,
        organizationId,
        repositoryFullName: REPOSITORY,
        branchName: branch.branchName,
      })),
    });
  });
  return branches;
}

function persistBatch(
  organizationId: string,
  records: readonly {
    branchArtifactId: string;
    sourceEventId: string;
    occurredAt: string;
  }[],
  completeness:
    | typeof BranchActivityEvidenceCompleteness.Complete
    | typeof BranchActivityEvidenceCompleteness.Partial
) {
  return withDb.tx(
    (tx) =>
      persistBranchActivityAtomsInTransaction(tx, {
        organizationId,
        records: records.map((record) => ({
          branchArtifactId: record.branchArtifactId,
          atom: {
            version: BranchActivityAtomVersion.V1,
            source: BranchActivitySource.MonitoredSession,
            kind: MonitoredSessionActivityEventKind.AgentRead,
            sourceEventId: record.sourceEventId,
            occurredAt: record.occurredAt,
            attribution: { kind: BranchActivityAttributionKind.Branch },
            completeness,
          },
        })),
      }),
    TRANSACTION_OPTIONS
  );
}

function monitoredBranchRef(
  branchName: string,
  events: SyncedMonitoredSessionActivityEvent[]
): SyncedBranchArtifactRef {
  return {
    kind: ArtifactRefTargetKind.Branch,
    repositoryFullName: REPOSITORY,
    branchName,
    method: ArtifactRefMethod.McpToolCall,
    relation: ArtifactRefRelation.Reviewed,
    monitoredSessionActivity: {
      completeness: BranchActivityEvidenceCompleteness.Complete,
      events,
    },
  };
}
