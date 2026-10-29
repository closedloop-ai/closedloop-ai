/**
 * #8737 follow-up — the untracked-repositories read against a real Postgres.
 *
 * The unit suites stub `$queryRaw` with the rows this statement would return,
 * so only this file proves the statement: it returns one row per target
 * (the earliest untracked one) plus every row it cannot certify, the caller's
 * answer is unchanged, its certification never accepts a row the snapshot
 * schema refuses, and its reads stay indexed on a multi-tenant table.
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
import {
  ArtifactRefTargetKind,
  PR_INT_MAX,
} from "@repo/api/src/types/session-artifact-link";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { log } from "@repo/observability/log";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestSessionDetail,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { MONITORED_ACTIVITY_RETAINED_SNAPSHOT_SCHEMA } from "./monitored-session-activity-retained-snapshot";
import {
  readSessionUntrackedRepositoryTargets,
  resetUnreadableUntrackedRepositoryRowEmissionBudget,
  UNREADABLE_UNTRACKED_REPOSITORY_ROWS_EVENT,
} from "./session-untracked-repositories";
import { sessionUntrackedRepositoryRowsQuery } from "./session-untracked-repositories-rows";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const CHOSEN_ROWS_BY_PRIMARY_KEY =
  /(?:Bitmap Index Scan on artifact_activity_events_pkey|Index Scan using artifact_activity_events_pkey on artifact_activity_events event)[\s\S]*Index Cond: \(id = ANY/;
const UNCERTIFIED_ROWS_BY_INDEX =
  /(?:Index Scan using|Bitmap Index Scan on) artifact_activity_events_monitored_retained_uncertified_idx/;
const SESSION_CANDIDATES_BY_INDEX =
  /Index (?:Scan using|Scan on) artifact_activity_events_(?:monitored_retained_target_idx|artifact_id_idx|organization_id_artifact_id_create_idx)[^\n]*\n\s*Index Cond: [^\n]*artifact_id =/;

const UNTRACKED = [
  MonitoredTargetDisposition.RepositoryOutOfScope,
  MonitoredTargetDisposition.RepositoryUnfetchable,
];

describeIfDb("session untracked-repositories read (integration)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetUnreadableUntrackedRepositoryRowEmissionBudget();
  });

  it("returns one row per target and every uncertifiable row, and the answer is unchanged", async () => {
    await autoRollbackTransaction(async () => {
      const { organizationId, sessionArtifactId } = await seedSession("rows");
      const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
      await insertRows(organizationId, sessionArtifactId, [
        // Three deliveries of one untracked target: the earliest wins.
        ["a1", 1, pr("acme/one", 1, { url: url("acme/one", 1) })],
        ["a2", 2, pr("acme/one", 1)],
        ["a3", 3, pr("acme/one", 1)],
        // A tracked earliest row does not claim the target; the later
        // untracked one renders.
        [
          "b1",
          4,
          pr("acme/two", 2, {
            disposition: MonitoredTargetDisposition.IntentionallyAbsent,
          }),
        ],
        ["b2", 5, pr("acme/two", 2)],
        // A valid row the SQL cannot certify (29 February) still wins over a
        // later certified delivery of its target.
        [
          "c1",
          6,
          pr("acme/three", 3, {
            occurredAt: "2028-02-29T00:00:00.000Z",
            url: url("acme/three", 3),
          }),
        ],
        ["c2", 7, pr("acme/three", 3)],
        // Two corrupt rows, counted however many deliveries their target had.
        ["d1", 8, { kind: "not-a-kind" }],
        ["d2", 9, pr("", 4)],
      ]);

      const rows = await withDb((db) =>
        db.$queryRaw<{ id: string }[]>(
          sessionUntrackedRepositoryRowsQuery({
            organizationId,
            sessionArtifactId,
            untrackedDispositions: UNTRACKED,
          })
        )
      );
      const targets = await readSessionUntrackedRepositoryTargets({
        organizationId,
        sessionArtifactId,
      });

      // The whole session holds nine rows; the read ships six: each target's
      // earliest certified untracked row (a1, b2, c2) and every row it cannot
      // certify (c1, d1, d2). c1 is earlier than c2, so c1 is what renders.
      expect(rows.map((row) => row.id)).toEqual(
        ["a1", "b2", "c1", "c2", "d1", "d2"].map(rowId)
      );
      expect(targets).toEqual([
        {
          kind: ArtifactRefTargetKind.PullRequest,
          repositoryFullName: "acme/one",
          prNumber: 1,
          url: url("acme/one", 1),
        },
        {
          kind: ArtifactRefTargetKind.PullRequest,
          repositoryFullName: "acme/three",
          prNumber: 3,
          url: url("acme/three", 3),
        },
        {
          kind: ArtifactRefTargetKind.PullRequest,
          repositoryFullName: "acme/two",
          prNumber: 2,
        },
      ]);
      expect(warn).toHaveBeenCalledWith(
        UNREADABLE_UNTRACKED_REPOSITORY_ROWS_EVENT,
        { organizationId, sessionId: sessionArtifactId, unreadableRows: 2 }
      );
    });
  });

  it("never certifies a row the snapshot schema refuses", async () => {
    await autoRollbackTransaction(async () => {
      const { organizationId, sessionArtifactId } =
        await seedSession("certify");
      // Tracked, so a CERTIFIED row is never returned and every returned row
      // is one the SQL refused to certify.
      const tracked = {
        disposition: MonitoredTargetDisposition.IntentionallyAbsent,
      };
      const fixtures: [string, unknown][] = [
        ["valid-pr", pr("acme/a", 1, tracked)],
        ["valid-branch", branch("acme/a", "main", tracked)],
        ["extra-key", { ...pr("acme/a", 2, tracked), extra: true }],
        [
          "hold-cause",
          pr("acme/a", 3, {
            ...tracked,
            holdExpiryCause: MonitoredHoldExpiryCause.OwnAge,
          }),
        ],
        [
          "fractional-seconds",
          pr("acme/a", 4, {
            ...tracked,
            occurredAt: "2026-10-12T01:02:03.123456Z",
          }),
        ],
        [
          "minutes-only",
          pr("acme/a", 5, { ...tracked, occurredAt: "2026-10-12T01:02Z" }),
        ],
        [
          "leap-day",
          pr("acme/a", 6, { ...tracked, occurredAt: "2028-02-29T00:00:00Z" }),
        ],
        [
          "feb-30",
          pr("acme/a", 7, { ...tracked, occurredAt: "2026-02-30T00:00:00Z" }),
        ],
        [
          "hour-24",
          pr("acme/a", 8, { ...tracked, occurredAt: "2026-10-12T24:00:00Z" }),
        ],
        [
          "offset",
          pr("acme/a", 9, {
            ...tracked,
            occurredAt: "2026-10-12T01:00:00+01:00",
          }),
        ],
        [
          "no-zone",
          pr("acme/a", 10, { ...tracked, occurredAt: "2026-10-12T01:00:00" }),
        ],
        [
          "unicode-digit",
          pr("acme/a", 11, { ...tracked, occurredAt: "２026-10-12T01:00:00Z" }),
        ],
        ["pr-zero", pr("acme/a", 0, tracked)],
        ["pr-negative", pr("acme/a", -1, tracked)],
        ["pr-fraction", pr("acme/a", 1.5, tracked)],
        ["pr-too-large", pr("acme/a", PR_INT_MAX + 1, tracked)],
        ["pr-string", { ...pr("acme/a", 12, tracked), prNumber: "12" }],
        ["branch-empty", branch("acme/a", "", tracked)],
        ["branch-number", { ...branch("acme/a", "x", tracked), branchName: 5 }],
        ["repo-empty", pr("", 13, tracked)],
        [
          "repo-number",
          { ...pr("acme/a", 14, tracked), repositoryFullName: 7 },
        ],
        ["url-null", { ...pr("acme/a", 15, tracked), url: null }],
        ["url-number", { ...pr("acme/a", 16, tracked), url: 1 }],
        ["cause-null", { ...pr("acme/a", 17, tracked), holdExpiryCause: null }],
        [
          "cause-unknown",
          { ...pr("acme/a", 18, tracked), holdExpiryCause: "later" },
        ],
        ["event-unknown", { ...pr("acme/a", 19, tracked), eventKind: "later" }],
        [
          "completeness-unknown",
          { ...pr("acme/a", 20, tracked), completeness: "most" },
        ],
        [
          "disposition-unknown",
          { ...pr("acme/a", 21, tracked), disposition: "later" },
        ],
        [
          "disposition-missing",
          { ...pr("acme/a", 22, tracked), disposition: undefined },
        ],
        ["kind-unknown", { ...pr("acme/a", 23, tracked), kind: "commit" }],
        ["array", [1, 2]],
        ["string", "retained"],
      ];
      await insertRows(
        organizationId,
        sessionArtifactId,
        fixtures.map(([name, after], index) => [name, index, after])
      );

      const returned = new Set(
        (
          await withDb((db) =>
            db.$queryRaw<{ id: string }[]>(
              sessionUntrackedRepositoryRowsQuery({
                organizationId,
                sessionArtifactId,
                untrackedDispositions: UNTRACKED,
              })
            )
          )
        ).map((row) => row.id)
      );

      for (const [name, after] of fixtures) {
        if (returned.has(rowId(name))) {
          continue;
        }
        const parsed = MONITORED_ACTIVITY_RETAINED_SNAPSHOT_SCHEMA.safeParse(
          JSON.parse(JSON.stringify(after))
        );
        expect(parsed.success, `${name} was certified`).toBe(true);
        expect(parsed.data?.repositoryFullName, name).not.toBe("");
      }
      // The writer's own rows certify, so the read stays small in practice.
      for (const name of ["valid-pr", "valid-branch", "hold-cause"]) {
        expect(returned.has(rowId(name)), name).toBe(false);
      }
    });
  });

  it("reads uncertified rows through their partial index, keeps candidates session-scoped, and fetches chosen rows by key", async () => {
    await autoRollbackTransaction(async () => {
      const { organizationId, sessionArtifactId } = await seedSession("plan");
      const foreign = await seedSession("plan-foreign");
      const plan = await withDb.tx(async (tx) => {
        // Writer-shaped rows: 100 untracked targets, 50 deliveries each.
        await tx.$executeRaw`
          INSERT INTO artifact_activity_events (id, organization_id, artifact_id, actor_type, action, after)
          SELECT gen_random_uuid(), ${organizationId}::uuid, ${sessionArtifactId}::uuid,
                 ${ArtifactActivityActorType.System}, ${ArtifactActivityAction.MonitoredActivityRetained},
                 jsonb_build_object('kind', ${ArtifactRefTargetKind.PullRequest}::text,
                                    'repositoryFullName', 'acme/repo-' || (g % 10),
                                    'prNumber', (g % 100) + 1,
                                    'eventKind', ${MonitoredSessionActivityEventKind.AgentRead}::text,
                                    'occurredAt', '2026-10-12T00:00:00.000Z',
                                    'completeness', ${BranchActivityEvidenceCompleteness.Complete}::text,
                                    'disposition', ${MonitoredTargetDisposition.RepositoryOutOfScope}::text)
            FROM generate_series(1, 5000) AS g`;
        // A session is a slice of a multi-tenant table. With only its own
        // rows in the table, a sequential scan is a valid cheaper plan.
        await tx.$executeRaw`
          INSERT INTO artifact_activity_events (id, organization_id, artifact_id, actor_type, action, after)
          SELECT gen_random_uuid(), ${foreign.organizationId}::uuid, ${foreign.sessionArtifactId}::uuid,
                 ${ArtifactActivityActorType.System}, ${ArtifactActivityAction.MonitoredActivityRetained},
                 jsonb_build_object('kind', ${ArtifactRefTargetKind.PullRequest}::text,
                                    'repositoryFullName', 'foreign/repo-' || (g % 10),
                                    'prNumber', (g % 100) + 1)
            FROM generate_series(1, 20000) AS g`;
        await tx.$executeRawUnsafe("ANALYZE artifact_activity_events");
        const query = sessionUntrackedRepositoryRowsQuery({
          organizationId,
          sessionArtifactId,
          untrackedDispositions: UNTRACKED,
        });
        return tx.$queryRawUnsafe<{ "QUERY PLAN": string }[]>(
          `EXPLAIN ${query.text}`,
          ...query.values
        );
      });
      const text = plan.map((row) => row["QUERY PLAN"]).join("\n");

      expect(text).not.toContain("Seq Scan on artifact_activity_events");
      // Certification must use its own partial index, rather than evaluate
      // the JSON predicate over the session on every read.
      expect(text).toMatch(UNCERTIFIED_ROWS_BY_INDEX);
      // PostgreSQL may prefer the existing artifact/session index to the
      // target index before sorting the DISTINCT ON candidates. Both bound
      // the read to this session; pin the indexed predicate, not a cost-based
      // choice between equivalent access paths.
      expect(text).toMatch(SESSION_CANDIDATES_BY_INDEX);
      // The chosen rows are fetched by primary key (an Index Scan or a Bitmap
      // Index Scan, as the planner prefers), not by re-reading the session.
      expect(text).toMatch(CHOSEN_ROWS_BY_PRIMARY_KEY);
    });
  });
});

async function seedSession(label: string) {
  const organizationId = await createTestOrganization();
  const user = await createTestUser(organizationId);
  const sessionArtifactId = await createTestSessionDetail({
    organizationId,
    userId: user.id,
    label: `untracked-${label}`,
  });
  return { organizationId, sessionArtifactId };
}

async function insertRows(
  organizationId: string,
  sessionArtifactId: string,
  rows: readonly [name: string, minute: number, after: unknown][]
): Promise<void> {
  await withDb((db) =>
    db.artifactActivityEvent.createMany({
      data: rows.map(([name, minute, after]) => ({
        id: rowId(name),
        organizationId,
        artifactId: sessionArtifactId,
        actorType: ArtifactActivityActorType.System,
        actorId: null,
        action: ArtifactActivityAction.MonitoredActivityRetained,
        after: JSON.parse(JSON.stringify(after)),
        createdAt: new Date(Date.UTC(2026, 9, 12, 0, minute)),
      })),
    })
  );
}

/** A stable uuid per fixture name, so assertions can name rows. */
function rowId(name: string): string {
  const hex = Buffer.from(name).toString("hex").padEnd(32, "0").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function url(repositoryFullName: string, prNumber: number): string {
  return `https://github.com/${repositoryFullName}/pull/${prNumber}`;
}

function snapshotFields(overrides: Record<string, unknown>) {
  return {
    eventKind: MonitoredSessionActivityEventKind.AgentRead,
    occurredAt: "2026-10-12T00:00:00.000Z",
    completeness: BranchActivityEvidenceCompleteness.Complete,
    disposition: MonitoredTargetDisposition.RepositoryOutOfScope,
    ...overrides,
  };
}

function pr(
  repositoryFullName: string,
  prNumber: number,
  overrides: Record<string, unknown> = {}
) {
  return {
    kind: ArtifactRefTargetKind.PullRequest,
    repositoryFullName,
    prNumber,
    ...snapshotFields(overrides),
  };
}

function branch(
  repositoryFullName: string,
  branchName: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    kind: ArtifactRefTargetKind.Branch,
    repositoryFullName,
    branchName,
    ...snapshotFields(overrides),
  };
}
