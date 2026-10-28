import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BranchActivityEvidenceCompleteness } from "@repo/api/src/types/branch-activity";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
} from "@repo/api/src/types/session-artifact-link";
import { MonitoredSessionActivityEventKind } from "@repo/api/src/types/session-monitored-activity";
import { test } from "vitest";
import { normalizeBranchActivityScopes } from "../src/main/database/branch-activity-identity.js";
import { queryBranchActivityRows } from "../src/main/database/branch-activity-query.js";
import {
  BRANCH_ACTIVITY_CARRIER_EXISTS_SQL,
  BRANCH_ACTIVITY_SCOPE_BATCH_SIZE,
} from "../src/main/database/branch-activity-sql.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import type { SqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { MONITORED_ACTIVITY_ONLY_METADATA_KEY } from "../src/main/database/synced-monitored-session-activity.js";
import { openTestDb } from "./agent-db-test-utils.js";

const REPOSITORY = "closedloop-ai/closedloop-ai";
const FIRST_BRANCH = "fix/first";
const SECOND_BRANCH = "fix/second";
const FIRST_AT = "2026-08-12T12:00:00.000Z";
const CARRIER_COUNT = 120;
const FINAL_ROW_KEYS = [
  "branchName",
  "completeness",
  "occurredAt",
  "repoFullName",
  "sourceEventId",
];

test("ISS-6422: raw SQLite activity output is final and Branch-bounded", async () => {
  await withLargeActivityDatabase(async (db) => {
    const scopes = normalizeBranchActivityScopes([
      { repoFullName: REPOSITORY, branchName: FIRST_BRANCH },
      { repoFullName: REPOSITORY, branchName: SECOND_BRANCH },
    ]);

    const rows = await queryBranchActivityRows(db.prisma, scopes);

    assert.ok(rows.length <= scopes.length);
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), FINAL_ROW_KEYS);
    }
    assert.deepEqual(rows, expectedLargeCorpusRows());
  });
});

test("ISS-6422: unrelated history does not change the bounded SQL result", async () => {
  await withLargeActivityDatabase(async (db) => {
    const scopes = normalizeBranchActivityScopes([
      { repoFullName: REPOSITORY, branchName: FIRST_BRANCH },
      { repoFullName: REPOSITORY, branchName: SECOND_BRANCH },
    ]);
    const before = await queryBranchActivityRows(db.prisma, scopes);

    await seedUnrelatedActivityCorpus(db);

    assert.deepEqual(await queryBranchActivityRows(db.prisma, scopes), before);
    assert.deepEqual(before, expectedLargeCorpusRows());
  });
});

test("ISS-6422: public Branch activity callers preserve canonical parity", async () => {
  await withLargeActivityDatabase(async (db) => {
    const rows = await db.readBranchCanonicalActivityRows({
      branchKeys: [
        { repoFullName: REPOSITORY, branchName: FIRST_BRANCH },
        { repoFullName: REPOSITORY, branchName: SECOND_BRANCH },
      ],
    });

    assert.deepEqual(rows, expectedLargeCorpusRows());
  });
});

test("ISS-6422: the JavaScript boundary rejects invalid, duplicate, and out-of-scope rows", async () => {
  const scopes = normalizeBranchActivityScopes([
    { repoFullName: REPOSITORY, branchName: "fix/valid" },
    { repoFullName: REPOSITORY, branchName: "fix/invalid-date" },
    { repoFullName: REPOSITORY, branchName: "fix/empty" },
    { repoFullName: REPOSITORY, branchName: "fix/duplicate" },
  ]);
  const validRow = activityResult("fix/valid", "valid-event", FIRST_AT);
  const prisma = fakePrisma((sql) =>
    sql === BRANCH_ACTIVITY_CARRIER_EXISTS_SQL
      ? [{ hasCarrier: 1 }]
      : [
          validRow,
          activityResult("fix/invalid-date", "invalid-date", "not-a-date"),
          activityResult("fix/empty", "", FIRST_AT),
          activityResult("fix/out-of-scope", "out-of-scope", FIRST_AT),
          activityResult("fix/duplicate", "duplicate-first", FIRST_AT),
          activityResult("fix/duplicate", "duplicate-second", FIRST_AT),
          {
            ...activityResult("fix/empty", "complete-without-time", null),
            completeness: BranchActivityEvidenceCompleteness.Complete,
          },
        ]
  );

  assert.deepEqual(await queryBranchActivityRows(prisma, scopes), [validRow]);
});

test("ISS-6422: requested Branch scopes use bounded sub-batches across SQL reads", async () => {
  const batchSizes: number[] = [];
  let queryCount = 0;
  const prisma = fakePrisma((sql, parameters) => {
    if (sql === BRANCH_ACTIVITY_CARRIER_EXISTS_SQL) {
      return [{ hasCarrier: 1 }];
    }
    queryCount += 1;
    const serializedScopes = parameters[0];
    assert.equal(typeof serializedScopes, "string");
    const batches = JSON.parse(serializedScopes as string) as unknown[][];
    batchSizes.push(...batches.map((batch) => batch.length));
    return [];
  });
  const scopes = normalizeBranchActivityScopes(
    Array.from(
      { length: BRANCH_ACTIVITY_SCOPE_BATCH_SIZE * 2 + 5 },
      (_, index) => ({
        repoFullName: REPOSITORY,
        branchName: `fix/batch-${index}`,
      })
    )
  );

  assert.deepEqual(await queryBranchActivityRows(prisma, scopes), []);
  assert.equal(queryCount, 2);
  assert.deepEqual(batchSizes, [
    BRANCH_ACTIVITY_SCOPE_BATCH_SIZE,
    BRANCH_ACTIVITY_SCOPE_BATCH_SIZE,
    5,
    BRANCH_ACTIVITY_SCOPE_BATCH_SIZE,
    BRANCH_ACTIVITY_SCOPE_BATCH_SIZE,
    5,
  ]);
});

test("ISS-7522: broad zero-carrier corpora skip canonical activity SQL", async () => {
  const seenSql: string[] = [];
  const prisma = fakePrisma((sql) => {
    seenSql.push(sql);
    if (sql === BRANCH_ACTIVITY_CARRIER_EXISTS_SQL) {
      return [{ hasCarrier: 0 }];
    }
    throw new Error("canonical activity query should not run without carriers");
  });
  const scopes = normalizeBranchActivityScopes(
    Array.from(
      { length: BRANCH_ACTIVITY_SCOPE_BATCH_SIZE + 1 },
      (_, index) => ({
        repoFullName: REPOSITORY,
        branchName: `fix/no-carrier-${index}`,
      })
    )
  );

  assert.deepEqual(await queryBranchActivityRows(prisma, scopes), []);
  assert.deepEqual(seenSql, [BRANCH_ACTIVITY_CARRIER_EXISTS_SQL]);
});

test("ISS-7522: carrier preflight is false for payload-free Branch links", async () => {
  await withActivityDatabase(async (db) => {
    await seedCarrierBranch(db, "payload-free-branch", FIRST_BRANCH);
    await seedCarrierSession(db, "payload-free-session", null);
    await seedCarrierLink(db, {
      id: "payload-free-link",
      sessionId: "payload-free-session",
      artifactId: "payload-free-branch",
      evidence: "{}",
    });

    assert.equal(await readCarrierPreflight(db), false);
    assert.deepEqual(await readActivityRows(db, [FIRST_BRANCH]), []);
  });
});

test("ISS-7522: carrier preflight is true for regular monitored activity", async () => {
  await withActivityDatabase(async (db) => {
    await seedCarrierBranch(db, "regular-branch", FIRST_BRANCH);
    await seedCarrierSession(db, "regular-session", null);
    await seedCarrierLink(db, {
      id: "regular-link",
      sessionId: "regular-session",
      artifactId: "regular-branch",
      evidence: JSON.stringify({
        monitoredSessionActivity: activityCarrier("regular-event", FIRST_AT),
      }),
    });

    assert.equal(await readCarrierPreflight(db), true);
    assert.deepEqual(await readActivityRows(db, [FIRST_BRANCH]), [
      activityResult(FIRST_BRANCH, "regular-event", FIRST_AT),
    ]);
  });
});

test("ISS-7522: carrier preflight is true for malformed regular evidence", async () => {
  await withActivityDatabase(async (db) => {
    await seedCarrierBranch(db, "malformed-branch", FIRST_BRANCH);
    await seedCarrierSession(db, "malformed-session", null);
    await seedCarrierLink(db, {
      id: "malformed-link",
      sessionId: "malformed-session",
      artifactId: "malformed-branch",
      evidence: "{not-json",
    });

    assert.equal(await readCarrierPreflight(db), true);
    assert.deepEqual(await readActivityRows(db, [FIRST_BRANCH]), [
      activityResult(
        FIRST_BRANCH,
        "malformed-carrier:malformed-link",
        null,
        BranchActivityEvidenceCompleteness.Partial
      ),
    ]);
  });
});

test("ISS-7522/ISS-9860: carrier preflight is true for oversized regular evidence, which now reads whole", async () => {
  await withActivityDatabase(async (db) => {
    await seedCarrierBranch(db, "oversized-branch", FIRST_BRANCH);
    await seedCarrierSession(db, "oversized-session", null);
    await seedCarrierLink(db, {
      id: "oversized-link",
      sessionId: "oversized-session",
      artifactId: "oversized-branch",
      evidence: JSON.stringify({
        monitoredSessionActivity: activityCarrier("oversized-event", FIRST_AT),
        padding: "x".repeat(300_000),
      }),
    });

    assert.equal(await readCarrierPreflight(db), true);
    assert.deepEqual(await readActivityRows(db, [FIRST_BRANCH]), [
      activityResult(FIRST_BRANCH, "oversized-event", FIRST_AT),
    ]);
  });
});

test("ISS-7522: carrier preflight is true for private metadata activity", async () => {
  await withActivityDatabase(async (db) => {
    await seedCarrierBranch(db, "private-branch", FIRST_BRANCH);
    await seedCarrierSession(
      db,
      "private-session",
      JSON.stringify({
        [MONITORED_ACTIVITY_ONLY_METADATA_KEY]: [
          {
            kind: ArtifactRefTargetKind.Branch,
            repositoryFullName: REPOSITORY,
            branchName: FIRST_BRANCH,
            method: ArtifactRefMethod.UrlInMessage,
            relation: ArtifactRefRelation.Referenced,
            monitoredActivityOnly: true,
            monitoredSessionActivity: activityCarrier(
              "private-event",
              FIRST_AT
            ),
          },
        ],
      })
    );

    assert.equal(await readCarrierPreflight(db), true);
    assert.deepEqual(await readActivityRows(db, [FIRST_BRANCH]), [
      activityResult(FIRST_BRANCH, "private-event", FIRST_AT),
    ]);
  });
});

test("ISS-6422: session caps span requested-scope sub-batches", async () => {
  const branchCount = BRANCH_ACTIVITY_SCOPE_BATCH_SIZE + 1;
  await withActivityDatabase(async (db) => {
    await seedCrossBatchSession(db, branchCount);
    const branchKeys = Array.from({ length: branchCount }, (_, index) => ({
      repoFullName: REPOSITORY,
      branchName: crossBatchBranch(index),
    }));

    const rows = await db.readBranchCanonicalActivityRows({ branchKeys });

    assert.equal(rows.length, branchCount);
    assert.ok(
      rows.every(
        (row) => row.completeness === BranchActivityEvidenceCompleteness.Partial
      )
    );
    assert.deepEqual(rows.at(-1), {
      repoFullName: REPOSITORY,
      branchName: crossBatchBranch(branchCount - 1),
      sourceEventId: "carrier-cap:cross-batch-session",
      occurredAt: null,
      completeness: BranchActivityEvidenceCompleteness.Partial,
    });
  });
});

test("ISS-6422: payload-free ordinary links do not consume carrier rank", async () => {
  const branchCount = BRANCH_ACTIVITY_SCOPE_BATCH_SIZE + 2;
  await withActivityDatabase(async (db) => {
    await db.run(
      `WITH RECURSIVE branch(index_value) AS (
         SELECT 0
         UNION ALL
         SELECT index_value + 1 FROM branch
         WHERE index_value + 1 < $1
       )
       INSERT INTO artifacts
         (id, identity_key, kind, repo_full_name, branch_name, created_at, last_seen_at)
       SELECT
         printf('ranked-branch-%03d', index_value),
         printf('identity:ranked:%03d', index_value),
         '${ArtifactRefTargetKind.Branch}',
         $2,
         printf('fix/ranked-%03d', index_value),
         $3,
         $3
       FROM branch`,
      branchCount,
      REPOSITORY,
      FIRST_AT
    );
    await db.run(
      "INSERT INTO sessions (id, status, metadata) VALUES ('ranked-session', 'inactive', NULL)"
    );
    await db.run(
      `WITH RECURSIVE link(index_value) AS (
         SELECT 0
         UNION ALL
         SELECT index_value + 1 FROM link
         WHERE index_value + 1 < ${BRANCH_ACTIVITY_SCOPE_BATCH_SIZE}
       )
       INSERT INTO session_artifact_links
         (id, session_id, artifact_id, relation, method, evidence,
          extractor_version, observed_at, created_at)
       SELECT
         printf('payload-free-%03d', index_value),
         'ranked-session',
         printf('ranked-branch-%03d', index_value),
         '${ArtifactRefRelation.Created}',
         '${ArtifactRefMethod.UrlInMessage}',
         '{}',
         25,
         $1,
         $1
       FROM link`,
      FIRST_AT
    );
    await db.run(
      `INSERT INTO session_artifact_links
         (id, session_id, artifact_id, relation, method, evidence,
          extractor_version, observed_at, created_at)
       VALUES
         ('yy-malformed', 'ranked-session', 'ranked-branch-100',
          '${ArtifactRefRelation.Created}', '${ArtifactRefMethod.UrlInMessage}',
          '{not-json', 25, $1, $1),
         ('zz-activity', 'ranked-session', 'ranked-branch-101',
          '${ArtifactRefRelation.Created}', '${ArtifactRefMethod.UrlInMessage}',
          json_object(
            'monitoredSessionActivity',
            json_object(
              'completeness', '${BranchActivityEvidenceCompleteness.Complete}',
              'events', json_array(json_object(
                'kind', '${MonitoredSessionActivityEventKind.AgentAction}',
                'sourceEventId', 'ranked-event',
                'occurredAt', $1,
                'completeness', '${BranchActivityEvidenceCompleteness.Complete}'
              ))
            )
          ),
          25,
          $1,
          $1)`,
      FIRST_AT
    );

    assert.deepEqual(
      await db.readBranchCanonicalActivityRows({
        branchKeys: Array.from({ length: branchCount }, (_, index) => ({
          repoFullName: REPOSITORY,
          branchName: rankedBranch(index),
        })),
      }),
      [
        {
          repoFullName: REPOSITORY,
          branchName: rankedBranch(BRANCH_ACTIVITY_SCOPE_BATCH_SIZE),
          sourceEventId: "malformed-carrier:yy-malformed",
          occurredAt: null,
          completeness: BranchActivityEvidenceCompleteness.Partial,
        },
        activityResult(
          rankedBranch(BRANCH_ACTIVITY_SCOPE_BATCH_SIZE + 1),
          "ranked-event",
          FIRST_AT
        ),
      ]
    );
  });
});

async function withLargeActivityDatabase(
  run: (db: SqliteAgentDatabase) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss6422-sql-boundary-"));
  const db = await openTestDb(dir);
  try {
    await seedLargeActivityCorpus(db);
    await run(db);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function withActivityDatabase(
  run: (db: SqliteAgentDatabase) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss6422-sql-remediation-"));
  const db = await openTestDb(dir);
  try {
    await run(db);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function seedCrossBatchSession(
  db: SqliteAgentDatabase,
  branchCount: number
): Promise<void> {
  await db.run(
    "INSERT INTO sessions (id, status, metadata) VALUES ('cross-batch-session', 'inactive', NULL)"
  );
  await db.run(
    `WITH RECURSIVE branch(index_value) AS (
       SELECT 0
       UNION ALL
       SELECT index_value + 1 FROM branch
       WHERE index_value + 1 < $1
     )
     INSERT INTO artifacts
       (id, identity_key, kind, repo_full_name, branch_name, created_at, last_seen_at)
     SELECT
       printf('cross-batch-branch-%03d', index_value),
       printf('identity:cross-batch:%03d', index_value),
       '${ArtifactRefTargetKind.Branch}',
       $2,
       printf('fix/cross-batch-%03d', index_value),
       $3,
       $3
     FROM branch`,
    branchCount,
    REPOSITORY,
    FIRST_AT
  );
  await db.run(
    `WITH RECURSIVE link(index_value) AS (
       SELECT 0
       UNION ALL
       SELECT index_value + 1 FROM link
       WHERE index_value + 1 < $1
     )
     INSERT INTO session_artifact_links
       (id, session_id, artifact_id, relation, method, evidence,
        extractor_version, observed_at, created_at)
     SELECT
       printf('cross-batch-link-%03d', index_value),
       'cross-batch-session',
       printf('cross-batch-branch-%03d', index_value),
       '${ArtifactRefRelation.Created}',
       '${ArtifactRefMethod.UrlInMessage}',
       json_object(
         'monitoredSessionActivity',
         json_object(
           'completeness', '${BranchActivityEvidenceCompleteness.Complete}',
           'events', json_array(json_object(
             'kind', '${MonitoredSessionActivityEventKind.AgentAction}',
             'sourceEventId', printf('cross-batch-event-%03d', index_value),
             'occurredAt', $2,
             'completeness', '${BranchActivityEvidenceCompleteness.Complete}'
           ))
         )
       ),
       25,
       $2,
       $2
     FROM link`,
    branchCount,
    FIRST_AT
  );
}

function crossBatchBranch(index: number): string {
  return `fix/cross-batch-${index.toString().padStart(3, "0")}`;
}

function rankedBranch(index: number): string {
  return `fix/ranked-${index.toString().padStart(3, "0")}`;
}

async function seedLargeActivityCorpus(db: SqliteAgentDatabase): Promise<void> {
  await db.run(
    `INSERT INTO artifacts
       (id, identity_key, kind, repo_full_name, branch_name, created_at, last_seen_at)
     VALUES
       ('branch-first', 'identity:first', '${ArtifactRefTargetKind.Branch}', $1, $2, $4, $4),
       ('branch-second', 'identity:second', '${ArtifactRefTargetKind.Branch}', $1, $3, $4, $4)`,
    REPOSITORY,
    FIRST_BRANCH,
    SECOND_BRANCH,
    FIRST_AT
  );
  await db.run(
    `WITH RECURSIVE carrier(index_value) AS (
       SELECT 0
       UNION ALL
       SELECT index_value + 1 FROM carrier WHERE index_value + 1 < ${CARRIER_COUNT}
     )
     INSERT INTO sessions (id, status, metadata)
     SELECT printf('session-%03d', index_value), 'inactive', NULL FROM carrier`
  );
  await db.run(
    `WITH RECURSIVE carrier(index_value) AS (
       SELECT 0
       UNION ALL
       SELECT index_value + 1 FROM carrier WHERE index_value + 1 < ${CARRIER_COUNT}
     )
     INSERT INTO session_artifact_links
       (id, session_id, artifact_id, relation, method, evidence,
        extractor_version, observed_at, created_at)
     SELECT
       printf('link-%03d', index_value),
       printf('session-%03d', index_value),
       CASE WHEN index_value % 2 = 0 THEN 'branch-first' ELSE 'branch-second' END,
       '${ArtifactRefRelation.Created}',
       '${ArtifactRefMethod.UrlInMessage}',
       json_object(
         'monitoredSessionActivity',
         json_object(
           'completeness', '${BranchActivityEvidenceCompleteness.Complete}',
           'events', json_array(json_object(
             'kind', '${MonitoredSessionActivityEventKind.AgentAction}',
             'sourceEventId', printf('event-%d', index_value),
             'occurredAt', printf('2026-08-12T12:%02d:00.000Z', index_value % 60),
             'completeness', '${BranchActivityEvidenceCompleteness.Complete}'
           ))
         )
       ),
       25,
       $1,
       $1
     FROM carrier`,
    FIRST_AT
  );
}

async function seedUnrelatedActivityCorpus(
  db: SqliteAgentDatabase
): Promise<void> {
  await db.run(
    `INSERT INTO artifacts
       (id, identity_key, kind, repo_full_name, branch_name, created_at, last_seen_at)
     VALUES
       ('branch-unrelated', 'identity:unrelated', '${ArtifactRefTargetKind.Branch}',
        $1, 'fix/unrelated', $2, $2)`,
    REPOSITORY,
    FIRST_AT
  );
  await db.run(
    `WITH RECURSIVE carrier(index_value) AS (
       SELECT 0
       UNION ALL
       SELECT index_value + 1 FROM carrier WHERE index_value + 1 < 200
     )
     INSERT INTO sessions (id, status, metadata)
     SELECT printf('unrelated-session-%03d', index_value), 'inactive', NULL
     FROM carrier`
  );
  await db.run(
    `WITH RECURSIVE carrier(index_value) AS (
       SELECT 0
       UNION ALL
       SELECT index_value + 1 FROM carrier WHERE index_value + 1 < 200
     )
     INSERT INTO session_artifact_links
       (id, session_id, artifact_id, relation, method, evidence,
        extractor_version, observed_at, created_at)
     SELECT
       printf('unrelated-link-%03d', index_value),
       printf('unrelated-session-%03d', index_value),
       'branch-unrelated',
       '${ArtifactRefRelation.Created}',
       '${ArtifactRefMethod.UrlInMessage}',
       json_object(
         'monitoredSessionActivity',
         json_object(
           'completeness', '${BranchActivityEvidenceCompleteness.Complete}',
           'events', json_array(json_object(
             'kind', '${MonitoredSessionActivityEventKind.AgentAction}',
             'sourceEventId', printf('unrelated-event-%d', index_value),
             'occurredAt', '2026-08-13T12:00:00.000Z',
             'completeness', '${BranchActivityEvidenceCompleteness.Complete}'
           ))
         )
       ),
       25,
       $1,
       $1
     FROM carrier`,
    FIRST_AT
  );
}

function expectedLargeCorpusRows() {
  return [
    {
      repoFullName: REPOSITORY,
      branchName: FIRST_BRANCH,
      sourceEventId: "event-118",
      occurredAt: "2026-08-12T12:58:00.000Z",
      completeness: BranchActivityEvidenceCompleteness.Complete,
    },
    {
      repoFullName: REPOSITORY,
      branchName: SECOND_BRANCH,
      sourceEventId: "event-119",
      occurredAt: "2026-08-12T12:59:00.000Z",
      completeness: BranchActivityEvidenceCompleteness.Complete,
    },
  ];
}

async function readCarrierPreflight(db: SqliteAgentDatabase): Promise<boolean> {
  const rows = await db.prisma.read((reader) =>
    reader.$queryRawUnsafe<{ hasCarrier: unknown }[]>(
      BRANCH_ACTIVITY_CARRIER_EXISTS_SQL
    )
  );
  return Number(rows[0]?.hasCarrier ?? 0) === 1;
}

function readActivityRows(
  db: SqliteAgentDatabase,
  branchNames: readonly string[]
) {
  return db.readBranchCanonicalActivityRows({
    branchKeys: branchNames.map((branchName) => ({
      repoFullName: REPOSITORY,
      branchName,
    })),
  });
}

async function seedCarrierBranch(
  db: SqliteAgentDatabase,
  id: string,
  branchName: string
): Promise<void> {
  await db.run(
    `INSERT INTO artifacts
       (id, identity_key, kind, repo_full_name, branch_name, created_at, last_seen_at)
     VALUES ($1, $2, '${ArtifactRefTargetKind.Branch}', $3, $4, $5, $5)`,
    id,
    `identity:${id}`,
    REPOSITORY,
    branchName,
    FIRST_AT
  );
}

async function seedCarrierSession(
  db: SqliteAgentDatabase,
  id: string,
  metadata: string | null
): Promise<void> {
  await db.run(
    "INSERT INTO sessions (id, status, metadata) VALUES ($1, 'inactive', $2)",
    id,
    metadata
  );
}

async function seedCarrierLink(
  db: SqliteAgentDatabase,
  input: {
    id: string;
    sessionId: string;
    artifactId: string;
    evidence: string;
  }
): Promise<void> {
  await db.run(
    `INSERT INTO session_artifact_links
       (id, session_id, artifact_id, relation, method, evidence,
        extractor_version, observed_at, created_at)
     VALUES ($1, $2, $3, '${ArtifactRefRelation.Created}',
       '${ArtifactRefMethod.UrlInMessage}', $4, 25, $5, $5)`,
    input.id,
    input.sessionId,
    input.artifactId,
    input.evidence,
    FIRST_AT
  );
}

function activityCarrier(sourceEventId: string, occurredAt: string) {
  return {
    completeness: BranchActivityEvidenceCompleteness.Complete,
    events: [
      {
        kind: MonitoredSessionActivityEventKind.AgentAction,
        sourceEventId,
        occurredAt,
        completeness: BranchActivityEvidenceCompleteness.Complete,
      },
    ],
  };
}

function activityResult(
  branchName: string,
  sourceEventId: string,
  occurredAt: string | null,
  completeness: BranchActivityEvidenceCompleteness = BranchActivityEvidenceCompleteness.Complete
) {
  return {
    repoFullName: REPOSITORY,
    branchName,
    sourceEventId,
    occurredAt,
    completeness,
  };
}

function fakePrisma(
  query: (sql: string, parameters: readonly unknown[]) => unknown
): DesktopPrisma {
  const read: DesktopPrisma["read"] = async (run) =>
    run({
      $queryRawUnsafe: async <T>(
        sql: string,
        ...parameters: unknown[]
      ): Promise<T> => query(sql, parameters) as T,
    } as never);
  return {
    read,
  } as unknown as DesktopPrisma;
}
