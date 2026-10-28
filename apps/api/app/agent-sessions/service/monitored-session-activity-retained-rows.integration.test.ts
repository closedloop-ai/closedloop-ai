/**
 * #8737 follow-up — the retained-row read against a real Postgres.
 *
 * The unit suites answer this statement from a transaction double that applies
 * the same semantics in JavaScript, so only this file proves the SQL itself: that
 * it returns exactly this delivery's rows (the target arm and the id arm), and
 * that its target predicate matches `artifact_activity_events_monitored_retained_target_idx`.
 */
import {
  ArtifactActivityAction,
  ArtifactActivityActorType,
} from "@repo/api/src/types/artifact-activity";
import { BranchActivityEvidenceCompleteness } from "@repo/api/src/types/branch-activity";
import { MonitoredSessionActivityEventKind } from "@repo/api/src/types/branch-activity-kind";
import {
  MonitoredHoldExpiryCause,
  MonitoredTargetDisposition,
} from "@repo/api/src/types/monitored-activity-target";
import { ArtifactRefTargetKind } from "@repo/api/src/types/session-artifact-link";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestSessionDetail,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { retainedMonitoredActivityRowsQuery } from "./monitored-session-activity-retained-rows";
import {
  createRetainedMonitoredActivityRowReader,
  retainedMonitoredActivityEventId,
  retainedMonitoredActivitySnapshot,
} from "./monitored-session-activity-retention";
import type { MonitoredActivityCandidate } from "./monitored-session-activity-shared";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const RETAINED_TARGET_INDEX =
  "artifact_activity_events_monitored_retained_target_idx";

describeIfDb("readRetainedMonitoredActivityRows (integration)", () => {
  it("returns only the rows of this delivery's targets and ids, on this session", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const sessionArtifactId = await createTestSessionDetail({
        organizationId,
        userId: user.id,
        label: "retained-read",
      });
      const otherSessionArtifactId = await createTestSessionDetail({
        organizationId,
        userId: user.id,
        label: "retained-read-other",
      });

      const branch = candidate({
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: "acme/app",
        branchName: "feature/held",
      });
      const pullRequest = candidate({
        kind: ArtifactRefTargetKind.PullRequest,
        repositoryFullName: "acme/app",
        prNumber: 42,
      });
      // Same repository, different target: must never be read for this delivery.
      const foreign = candidate({
        kind: ArtifactRefTargetKind.PullRequest,
        repositoryFullName: "acme/app",
        prNumber: 4,
      });
      // A candidate whose stored row no longer parses, found only by its id.
      const unparseable = candidate(
        {
          kind: ArtifactRefTargetKind.Branch,
          repositoryFullName: "acme/app",
          branchName: "feature/corrupt",
        },
        "monitored_session_v1:corrupt"
      );

      const branchRowId = retainedMonitoredActivityEventId(
        sessionArtifactId,
        branch
      );
      const pullRequestRowId = retainedMonitoredActivityEventId(
        sessionArtifactId,
        pullRequest
      );
      const unparseableRowId = retainedMonitoredActivityEventId(
        sessionArtifactId,
        unparseable
      );
      await withDb((db) =>
        db.artifactActivityEvent.createMany({
          data: [
            retainedRow(organizationId, sessionArtifactId, branch),
            retainedRow(organizationId, sessionArtifactId, pullRequest),
            retainedRow(organizationId, sessionArtifactId, foreign),
            {
              ...retainedRow(organizationId, sessionArtifactId, unparseable),
              after: { corrupt: true },
            },
            // The same target on another session.
            retainedRow(organizationId, otherSessionArtifactId, branch),
            // The same target's snapshot under another action.
            {
              ...retainedRow(organizationId, sessionArtifactId, branch),
              id: crypto.randomUUID(),
              action: ArtifactActivityAction.FieldChange,
            },
          ],
        })
      );

      const rows = await withDb.tx((tx) =>
        createRetainedMonitoredActivityRowReader(
          tx,
          { organizationId, sessionArtifactId },
          [branch, pullRequest, unparseable]
        )()
      );

      expect(rows.map((row) => row.id).sort()).toEqual(
        [branchRowId, pullRequestRowId, unparseableRowId].sort()
      );
    });
  });

  it("probes the target index with every target expression", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const sessionArtifactId = await createTestSessionDetail({
        organizationId,
        userId: user.id,
        label: "retained-plan",
      });
      const plan = await withDb.tx(async (tx) => {
        // A long-lived session's history, and statistics for it: on an empty,
        // unanalyzed table the planner rightly walks the session's rows and
        // filters, which says nothing about the plan that matters. ANALYZE is
        // transactional, so the rollback discards these statistics too.
        await tx.$executeRaw`
          INSERT INTO artifact_activity_events (id, organization_id, artifact_id, actor_type, action, after)
          SELECT gen_random_uuid(), ${organizationId}::uuid, ${sessionArtifactId}::uuid,
                 ${ArtifactActivityActorType.System}, ${ArtifactActivityAction.MonitoredActivityRetained},
                 jsonb_build_object('kind', ${ArtifactRefTargetKind.PullRequest}::text,
                                    'repositoryFullName', 'acme/repo-' || (g % 20),
                                    'prNumber', (g % 500) + 1)
            FROM generate_series(1, 5000) AS g`;
        await tx.$executeRawUnsafe("ANALYZE artifact_activity_events");
        const query = retainedMonitoredActivityRowsQuery({
          organizationId,
          sessionArtifactId,
          targets: [
            {
              kind: ArtifactRefTargetKind.PullRequest,
              repositoryFullName: "acme/repo-1",
              prNumber: 2,
            },
          ],
          rowIds: [],
        });
        return tx.$queryRawUnsafe<{ "QUERY PLAN": string }[]>(
          `EXPLAIN ${query.text}`,
          ...query.values
        );
      });
      const lines = plan.map((row) => row["QUERY PLAN"]);
      const probe = lines.findIndex((line) =>
        line.includes(`Index Scan using ${RETAINED_TARGET_INDEX}`)
      );

      expect(probe).toBeGreaterThanOrEqual(0);
      // The expressions must be IN the index condition, not a filter after it:
      // the leading (organization_id, artifact_id) columns alone also use this
      // index, and would walk every retained row of the session.
      expect(lines[probe + 1]).toContain(
        "COALESCE((after ->> 'branchName'::text), (after ->> 'prNumber'::text)) = wanted.target_name"
      );
      expect(lines[probe + 1]).toContain(
        "(after ->> 'repositoryFullName'::text) = wanted.repository_full_name"
      );
    });
  });
});

function candidate(
  target: MonitoredActivityCandidate["target"],
  sourceEventId = "monitored_session_v1:retained-read"
): MonitoredActivityCandidate {
  return {
    target,
    event: {
      kind: MonitoredSessionActivityEventKind.AgentRead,
      sourceEventId,
      occurredAt: "2026-10-12T12:00:00.000Z",
      completeness: BranchActivityEvidenceCompleteness.Complete,
    },
    transportOnly: false,
  };
}

function retainedRow(
  organizationId: string,
  sessionArtifactId: string,
  retained: MonitoredActivityCandidate
) {
  return {
    id: retainedMonitoredActivityEventId(sessionArtifactId, retained),
    organizationId,
    artifactId: sessionArtifactId,
    actorType: ArtifactActivityActorType.System,
    actorId: null,
    action: ArtifactActivityAction.MonitoredActivityRetained,
    after: retainedMonitoredActivitySnapshot(
      retained,
      MonitoredTargetDisposition.HoldExpired,
      MonitoredHoldExpiryCause.OwnAge
    ),
  };
}
