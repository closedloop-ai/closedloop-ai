import assert from "node:assert/strict";
import { BranchActivityEvidenceCompleteness } from "@repo/api/src/types/branch-activity";
import { test } from "vitest";
import { BRANCH_ACTIVITY_FAST_PATH_SQL } from "../src/main/database/branch-activity-fast-path-sql.js";
import {
  MAX_BRANCH_ACTIVITY_NAME_LENGTH,
  MAX_BRANCH_ACTIVITY_REPOSITORY_LENGTH,
  normalizeActivityBranchName,
  normalizeActivityRepository,
  normalizeBranchActivityScopes,
} from "../src/main/database/branch-activity-identity.js";
import { queryBranchActivityRows } from "../src/main/database/branch-activity-query.js";
import { createBranchCanonicalActivityReadMethods } from "../src/main/database/branch-activity-read.js";
import {
  BRANCH_ACTIVITY_CARRIER_EXISTS_SQL,
  BRANCH_ACTIVITY_READ_SQL,
} from "../src/main/database/branch-activity-sql.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";

const REPOSITORY = "closedloop-ai/closedloop-ai";
const OCCURRED_AT = "2026-08-12T12:00:00.000Z";

test("ISS-6422: Branch activity identities reject malformed and oversized lookup input", () => {
  assert.equal(
    normalizeActivityRepository(`/${REPOSITORY.toUpperCase()}.git/`),
    REPOSITORY
  );
  assert.equal(normalizeActivityRepository(null), undefined);
  assert.equal(normalizeActivityRepository("owner-only"), undefined);
  assert.equal(normalizeActivityRepository("owner/repo/extra"), undefined);
  assert.equal(normalizeActivityRepository("owner /repo"), undefined);
  assert.equal(
    normalizeActivityRepository(
      `${"o".repeat(MAX_BRANCH_ACTIVITY_REPOSITORY_LENGTH)}/repo`
    ),
    undefined
  );

  assert.equal(normalizeActivityBranchName("  fix/activity  "), "fix/activity");
  assert.equal(
    normalizeActivityBranchName("b".repeat(MAX_BRANCH_ACTIVITY_NAME_LENGTH)),
    "b".repeat(MAX_BRANCH_ACTIVITY_NAME_LENGTH)
  );
  assert.equal(normalizeActivityBranchName(null), undefined);
  assert.equal(normalizeActivityBranchName("  "), undefined);
  assert.equal(
    normalizeActivityBranchName(
      "b".repeat(MAX_BRANCH_ACTIVITY_NAME_LENGTH + 1)
    ),
    undefined
  );
});

test("ISS-6422: Branch activity scopes normalize, reject, and deduplicate before SQL", () => {
  assert.deepEqual(
    normalizeBranchActivityScopes([
      { repoFullName: REPOSITORY, branchName: "fix/activity" },
      {
        repoFullName: `/${REPOSITORY.toUpperCase()}.git/`,
        branchName: " fix/activity ",
      },
      { repoFullName: null, branchName: "fix/missing-repo" },
      { repoFullName: "owner-only", branchName: "fix/malformed-repo" },
      { repoFullName: REPOSITORY, branchName: "" },
    ]),
    [{ repoFullName: REPOSITORY, branchName: "fix/activity" }]
  );
});

test("ISS-6422: an empty normalized scope never crosses the SQLite boundary", async () => {
  const prisma = fakePrisma(() => {
    throw new Error("query must not run");
  });

  assert.deepEqual(await queryBranchActivityRows(prisma, []), []);
  assert.deepEqual(
    await queryBranchActivityRows(prisma, [
      { repoFullName: "owner-only", branchName: "fix/activity" },
      { repoFullName: REPOSITORY, branchName: "" },
    ]),
    []
  );
});

test("ISS-6422: the production read method also suppresses empty normalized scopes", async () => {
  const methods = createBranchCanonicalActivityReadMethods(
    fakePrisma(() => {
      throw new Error("query must not run");
    })
  );

  assert.deepEqual(
    await methods.readBranchCanonicalActivityRows({
      branchKeys: [
        { repoFullName: null, branchName: "fix/missing-repo" },
        { repoFullName: REPOSITORY, branchName: "" },
      ],
    }),
    []
  );
});

test("ISS-6422: the SQLite boundary rejects malformed envelopes", async () => {
  const scopes = normalizeBranchActivityScopes([
    { repoFullName: REPOSITORY, branchName: "fix/activity" },
  ]);

  assert.deepEqual(
    await queryBranchActivityRows(
      fakePrisma((sql) =>
        sql === BRANCH_ACTIVITY_CARRIER_EXISTS_SQL
          ? [{ hasCarrier: 1 }]
          : { rows: [] }
      ),
      scopes
    ),
    []
  );
});

test("ISS-7522: a narrow exact Branch activity read skips the global carrier preflight", async () => {
  const seenSql: string[] = [];
  const scopes = normalizeBranchActivityScopes([
    { repoFullName: REPOSITORY, branchName: "fix/activity" },
  ]);

  assert.deepEqual(
    await queryBranchActivityRows(
      fakePrisma((sql) => {
        seenSql.push(sql);
        if (sql === BRANCH_ACTIVITY_CARRIER_EXISTS_SQL) {
          throw new Error("narrow exact read must not run global preflight");
        }
        return [];
      }),
      scopes
    ),
    []
  );
  assert.deepEqual(seenSql, [
    BRANCH_ACTIVITY_FAST_PATH_SQL,
    BRANCH_ACTIVITY_READ_SQL,
  ]);
});

test("ISS-7703: a supported fast-path result skips full canonical SQL", async () => {
  const seenSql: string[] = [];
  const scopes = normalizeBranchActivityScopes([
    { repoFullName: REPOSITORY, branchName: "fix/activity" },
  ]);

  assert.deepEqual(
    await queryBranchActivityRows(
      fakePrisma((sql) => {
        seenSql.push(sql);
        if (sql === BRANCH_ACTIVITY_FAST_PATH_SQL) {
          return [
            {
              fastPathSupported: 1,
              ...activityRow(
                REPOSITORY,
                "fix/activity",
                "fast-event",
                OCCURRED_AT
              ),
            },
          ];
        }
        throw new Error("full canonical SQL should not run");
      }),
      scopes
    ),
    [activityRow(REPOSITORY, "fix/activity", "fast-event", OCCURRED_AT)]
  );
  assert.deepEqual(seenSql, [BRANCH_ACTIVITY_FAST_PATH_SQL]);
});

test("ISS-7703: an unsupported fast-path result falls back to canonical SQL", async () => {
  const seenSql: string[] = [];
  const scopes = normalizeBranchActivityScopes([
    { repoFullName: REPOSITORY, branchName: "fix/activity" },
  ]);

  assert.deepEqual(
    await queryBranchActivityRows(
      fakePrisma((sql) => {
        seenSql.push(sql);
        if (sql === BRANCH_ACTIVITY_FAST_PATH_SQL) {
          return [
            {
              fastPathSupported: 0,
              repoFullName: null,
              branchName: null,
              sourceEventId: null,
              occurredAt: null,
              completeness: BranchActivityEvidenceCompleteness.Complete,
            },
          ];
        }
        return [
          activityRow(
            REPOSITORY,
            "fix/activity",
            "canonical-event",
            OCCURRED_AT
          ),
        ];
      }),
      scopes
    ),
    [activityRow(REPOSITORY, "fix/activity", "canonical-event", OCCURRED_AT)]
  );
  assert.deepEqual(seenSql, [
    BRANCH_ACTIVITY_FAST_PATH_SQL,
    BRANCH_ACTIVITY_READ_SQL,
  ]);
});

test("ISS-6422: independently valid final rows survive malformed database siblings", async () => {
  const alphaRepository = "alpha/repo";
  const betaRepository = "beta/repo";
  const scopes = normalizeBranchActivityScopes([
    { repoFullName: alphaRepository, branchName: "fix/a" },
    { repoFullName: alphaRepository, branchName: "fix/b" },
    { repoFullName: alphaRepository, branchName: "fix/partial" },
    { repoFullName: betaRepository, branchName: "fix/a" },
    { repoFullName: REPOSITORY, branchName: "fix/duplicate" },
  ]);
  const rows = [
    activityRow(betaRepository, "fix/a", "beta-event", OCCURRED_AT),
    activityRow(alphaRepository, "fix/b", "alpha-b-event", OCCURRED_AT),
    activityRow(alphaRepository, "fix/a", "alpha-a-event", OCCURRED_AT),
    activityRow(
      alphaRepository,
      "fix/partial",
      "partial-event",
      null,
      BranchActivityEvidenceCompleteness.Partial
    ),
    null,
    {
      ...activityRow(REPOSITORY, "fix/type", "type-event", OCCURRED_AT),
      repoFullName: 42,
    },
    activityRow(" ", "fix/empty-repo", "empty-repo-event", OCCURRED_AT),
    activityRow(
      "owner-only",
      "fix/malformed-repo",
      "malformed-repo-event",
      OCCURRED_AT
    ),
    activityRow(
      `${"o".repeat(MAX_BRANCH_ACTIVITY_REPOSITORY_LENGTH)}/repo`,
      "fix/oversized-repo",
      "oversized-repo-event",
      OCCURRED_AT
    ),
    activityRow(
      REPOSITORY,
      "b".repeat(MAX_BRANCH_ACTIVITY_NAME_LENGTH + 1),
      "oversized-branch-event",
      OCCURRED_AT
    ),
    {
      ...activityRow(REPOSITORY, "fix/unknown", "unknown-event", OCCURRED_AT),
      extra: true,
    },
    activityRow(REPOSITORY, "fix/blank-source", " ", OCCURRED_AT),
    {
      ...activityRow(
        REPOSITORY,
        "fix/completeness",
        "completeness-event",
        OCCURRED_AT
      ),
      completeness: "future",
    },
    activityRow(REPOSITORY, "fix/missing-time", "missing-time-event", null),
    activityRow(
      REPOSITORY,
      "fix/invalid-time",
      "invalid-time-event",
      "not-a-date"
    ),
    activityRow(
      REPOSITORY,
      "fix/out-of-scope",
      "out-of-scope-event",
      OCCURRED_AT
    ),
    activityRow(REPOSITORY, "fix/duplicate", "duplicate-a", OCCURRED_AT),
    activityRow(
      `/${REPOSITORY.toUpperCase()}.git/`,
      " fix/duplicate ",
      "duplicate-b",
      OCCURRED_AT
    ),
  ];

  assert.deepEqual(
    await queryBranchActivityRows(
      fakePrisma((sql) =>
        sql === BRANCH_ACTIVITY_CARRIER_EXISTS_SQL ? [{ hasCarrier: 1 }] : rows
      ),
      scopes
    ),
    [
      activityRow(alphaRepository, "fix/a", "alpha-a-event", OCCURRED_AT),
      activityRow(alphaRepository, "fix/b", "alpha-b-event", OCCURRED_AT),
      activityRow(
        alphaRepository,
        "fix/partial",
        "partial-event",
        null,
        BranchActivityEvidenceCompleteness.Partial
      ),
      activityRow(betaRepository, "fix/a", "beta-event", OCCURRED_AT),
    ]
  );
});

function activityRow(
  repoFullName: string,
  branchName: string,
  sourceEventId: string,
  occurredAt: string | null,
  completeness: BranchActivityEvidenceCompleteness = BranchActivityEvidenceCompleteness.Complete
) {
  return {
    repoFullName,
    branchName,
    sourceEventId,
    occurredAt,
    completeness,
  };
}

function fakePrisma(query: (sql: string) => unknown): DesktopPrisma {
  const read: DesktopPrisma["read"] = async (run) =>
    run({
      $queryRawUnsafe: async <T>(sql: string): Promise<T> => query(sql) as T,
    } as never);
  return { read } as unknown as DesktopPrisma;
}
