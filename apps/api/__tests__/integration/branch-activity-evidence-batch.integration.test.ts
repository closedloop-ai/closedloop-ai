import { randomUUID } from "node:crypto";
import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  BranchActivityAtomVersion,
  BranchActivityAttributionKind,
  BranchActivityEvidenceCompleteness,
  BranchActivitySource,
} from "@repo/api/src/types/branch-activity";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import { MAX_SYNCED_MONITORED_SESSION_ACTIVITY_EVENTS_PER_SESSION } from "@repo/api/src/types/session-monitored-activity";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import { BranchActivityPersistStatus } from "@/app/branches/branch-activity-evidence";
import { persistBranchActivityAtomsInTransaction } from "@/app/branches/branch-activity-evidence-batch";
import {
  autoRollbackTransaction,
  createTestOrganization,
} from "../utils/db-helpers";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;
const AGGREGATE_EVENT_CAP =
  MAX_SYNCED_MONITORED_SESSION_ACTIVITY_EVENTS_PER_SESSION;
const REPOSITORY = "closedloop-ai/symphony-alpha";
const FIRST_EVENT_AT = "2026-08-12T12:00:00.000Z";

describeIfDb("Branch activity batch persistence", () => {
  it("persists and replay-validates a cap-sized monitored Session in one transaction", async () => {
    await autoRollbackTransaction(
      async () => {
        const organizationId = await createTestOrganization();
        const branches = Array.from(
          { length: AGGREGATE_EVENT_CAP },
          (_, index) => ({
            artifactId: randomUUID(),
            branchName: `feat/iss-6060-batch-${index}`,
            occurredAt: new Date(
              Date.parse(FIRST_EVENT_AT) + index * 1000
            ).toISOString(),
          })
        );
        const firstBranch = branches[0];
        const lastBranch = branches.at(-1);
        if (!(firstBranch && lastBranch)) {
          throw new Error("cap-sized Branch fixture unexpectedly empty");
        }
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

        const inserted = await persistBatch(
          organizationId,
          branches,
          BranchActivityEvidenceCompleteness.Complete
        );
        expect(inserted).toHaveLength(AGGREGATE_EVENT_CAP);
        expect(
          inserted.every(
            (result) => result.status === BranchActivityPersistStatus.Inserted
          )
        ).toBe(true);

        const replayed = await persistBatch(
          organizationId,
          branches,
          BranchActivityEvidenceCompleteness.Partial
        );
        expect(replayed).toHaveLength(AGGREGATE_EVENT_CAP);
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
          branches: await db.branchDetail.findMany({
            where: {
              artifactId: {
                in: [firstBranch.artifactId, lastBranch.artifactId],
              },
            },
            orderBy: { branchName: "asc" },
            select: { branchName: true, lastActivityAt: true },
          }),
        }));
        expect(persisted.count).toBe(AGGREGATE_EVENT_CAP);
        expect(persisted.branches).toEqual([
          {
            branchName: firstBranch.branchName,
            lastActivityAt: new Date(firstBranch.occurredAt),
          },
          {
            branchName: lastBranch.branchName,
            lastActivityAt: new Date(lastBranch.occurredAt),
          },
        ]);
      },
      { timeout: 30_000 }
    );
  }, 35_000);
});

function persistBatch(
  organizationId: string,
  branches: readonly {
    artifactId: string;
    occurredAt: string;
  }[],
  completeness:
    | typeof BranchActivityEvidenceCompleteness.Complete
    | typeof BranchActivityEvidenceCompleteness.Partial
) {
  return withDb.tx((tx) =>
    persistBranchActivityAtomsInTransaction(tx, {
      organizationId,
      records: branches.map((branch, index) => ({
        branchArtifactId: branch.artifactId,
        atom: {
          version: BranchActivityAtomVersion.V1,
          source: BranchActivitySource.MonitoredSession,
          sourceEventId: `monitored_session_v1:batch-${index}`,
          occurredAt: branch.occurredAt,
          attribution: { kind: BranchActivityAttributionKind.Branch },
          completeness,
        },
      })),
    })
  );
}
