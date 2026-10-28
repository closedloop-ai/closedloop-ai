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
import {
  MonitoredSessionActivityEventKind,
  normalizeSyncedMonitoredSessionActivity,
} from "@repo/api/src/types/session-monitored-activity";
import { test } from "vitest";
import { normalizeBranchActivityScopes } from "../src/main/database/branch-activity-identity.js";
import { queryBranchActivityRows } from "../src/main/database/branch-activity-query.js";
import type { BranchCanonicalActivityKey } from "../src/main/database/branch-activity-read.js";
import type { SqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { openTestDb } from "./agent-db-test-utils.js";

const REPOSITORY = "closedloop-ai/closedloop-ai";
const FIRST_BRANCH = "fix/first";
const SECOND_BRANCH = "fix/second";
const THIRD_BRANCH = "fix/third";
const FIRST_AT = "2026-08-12T12:00:00.000Z";
const SECOND_AT = "2026-08-12T12:05:00.000Z";
const OVERSIZED_JSON_PADDING_LENGTH = 300_000;

test("ISS-6061: reads regular and private carriers with exact Branch and PR attribution", async () => {
  await withActivityDatabase(async (db) => {
    await seedBranch(db, "branch-first", REPOSITORY, FIRST_BRANCH);
    await seedBranch(db, "branch-second", REPOSITORY, SECOND_BRANCH);
    await seedSession(db, "regular-session", null);
    await seedRegularCarrier(
      db,
      "regular-link",
      "regular-session",
      "branch-first",
      carrier("regular-event", FIRST_AT)
    );
    await seedPullRequest(db, "pr-42", REPOSITORY, 42, FIRST_BRANCH);
    await seedSession(
      db,
      "private-session",
      privateMetadata([
        activityRef({
          kind: ArtifactRefTargetKind.Branch,
          repositoryFullName: `/${REPOSITORY.toUpperCase()}.git/`,
          branchName: SECOND_BRANCH,
          carrier: carrier("private-branch-event", SECOND_AT),
        }),
        activityRef({
          kind: ArtifactRefTargetKind.PullRequest,
          repositoryFullName: REPOSITORY,
          prNumber: 42,
          carrier: carrier("private-pr-event", SECOND_AT),
        }),
      ])
    );

    const rows = await readActivity(db, [FIRST_BRANCH, SECOND_BRANCH]);

    assert.deepEqual(rows, [
      activityRow(FIRST_BRANCH, "private-pr-event", SECOND_AT),
      activityRow(SECOND_BRANCH, "private-branch-event", SECOND_AT),
    ]);
    assert.deepEqual(
      await db.readBranchCanonicalActivityRows({
        branchKeys: [{ repoFullName: REPOSITORY, branchName: SECOND_BRANCH }],
      }),
      [activityRow(SECOND_BRANCH, "private-branch-event", SECOND_AT)]
    );
  });
});

test("ISS-6061: replay dedupe preserves partial and marks conflicting identities partial", async () => {
  await withActivityDatabase(async (db) => {
    await seedBranch(db, "branch-first", REPOSITORY, FIRST_BRANCH);
    await seedSession(db, "regular-session", null);
    await seedRegularCarrier(
      db,
      "regular-link",
      "regular-session",
      "branch-first",
      carrier("replayed-event", FIRST_AT)
    );
    await seedSession(
      db,
      "private-session",
      privateMetadata([
        activityRef({
          kind: ArtifactRefTargetKind.Branch,
          repositoryFullName: REPOSITORY,
          branchName: FIRST_BRANCH,
          carrier: carrier(
            "replayed-event",
            FIRST_AT,
            BranchActivityEvidenceCompleteness.Partial
          ),
        }),
        activityRef({
          kind: ArtifactRefTargetKind.Branch,
          repositoryFullName: REPOSITORY,
          branchName: FIRST_BRANCH,
          carrier: carrier("conflicting-event", FIRST_AT),
        }),
      ])
    );
    await seedSession(db, "conflicting-session", null);
    await seedRegularCarrier(
      db,
      "conflicting-link",
      "conflicting-session",
      "branch-first",
      carrier("conflicting-event", SECOND_AT)
    );

    assert.deepEqual(await readActivity(db, [FIRST_BRANCH]), [
      activityRow(
        FIRST_BRANCH,
        "replayed-event",
        FIRST_AT,
        BranchActivityEvidenceCompleteness.Partial
      ),
    ]);
  });
});

test("ISS-6061: an attributable malformed carrier degrades a valid sibling without fabricating time", async () => {
  await withActivityDatabase(async (db) => {
    await seedBranch(db, "branch-first", REPOSITORY, FIRST_BRANCH);
    await seedSession(db, "valid-session", null);
    await seedRegularCarrier(
      db,
      "valid-link",
      "valid-session",
      "branch-first",
      carrier("valid-event", FIRST_AT)
    );
    await seedSession(db, "malformed-session", null);
    await seedRegularCarrier(
      db,
      "malformed-link",
      "malformed-session",
      "branch-first",
      {
        completeness: BranchActivityEvidenceCompleteness.Complete,
        events: [{ sourceEventId: "missing-required-event-fields" }],
      }
    );

    assert.deepEqual(await readActivity(db, [FIRST_BRANCH]), [
      activityRow(
        "fix/first",
        "valid-event",
        FIRST_AT,
        BranchActivityEvidenceCompleteness.Partial
      ),
    ]);
  });
});

test("ISS-6061: malformed carriers and ambiguous PR or Branch targets fail closed", async () => {
  await withActivityDatabase(async (db) => {
    await seedBranch(db, "branch-first", REPOSITORY, FIRST_BRANCH);
    await seedBranch(
      db,
      "branch-duplicate",
      REPOSITORY.toUpperCase(),
      FIRST_BRANCH
    );
    await seedBranch(db, "branch-second", REPOSITORY, SECOND_BRANCH);
    await seedPullRequest(db, "pr-42", REPOSITORY, 42, FIRST_BRANCH);
    await seedPullRequest(db, "pr-42-conflict", REPOSITORY, 42, SECOND_BRANCH);
    await seedSession(db, "regular-session", null);
    await seedRegularCarrier(
      db,
      "malformed-link",
      "regular-session",
      "branch-first",
      {
        completeness: BranchActivityEvidenceCompleteness.Complete,
        events: [{ sourceEventId: "missing-required-event-fields" }],
      }
    );
    await seedSession(
      db,
      "private-session",
      privateMetadata([
        activityRef({
          kind: ArtifactRefTargetKind.Branch,
          repositoryFullName: REPOSITORY,
          branchName: FIRST_BRANCH,
          carrier: carrier("ambiguous-branch-event", FIRST_AT),
        }),
        activityRef({
          kind: ArtifactRefTargetKind.PullRequest,
          repositoryFullName: REPOSITORY,
          prNumber: 42,
          carrier: carrier("ambiguous-pr-event", SECOND_AT),
        }),
        activityRef({
          kind: ArtifactRefTargetKind.PullRequest,
          repositoryFullName: REPOSITORY,
          prNumber: 99,
          carrier: carrier("missing-pr-event", SECOND_AT),
        }),
      ])
    );

    assert.deepEqual(await readActivity(db, [FIRST_BRANCH, SECOND_BRANCH]), []);
  });
});

test("ISS-6061: normalized lookup emits the exact unique persisted Branch identity", async () => {
  await withActivityDatabase(async (db) => {
    const persistedRepository = `/${REPOSITORY.toUpperCase()}/.git/`;
    await seedBranch(db, "legacy-branch", persistedRepository, FIRST_BRANCH);
    await seedSession(db, "legacy-session", null);
    await seedRegularCarrier(
      db,
      "legacy-link",
      "legacy-session",
      "legacy-branch",
      carrier("legacy-event", FIRST_AT)
    );

    assert.deepEqual(
      await db.readBranchCanonicalActivityRows({
        branchKeys: [{ repoFullName: REPOSITORY, branchName: FIRST_BRANCH }],
      }),
      [
        {
          repoFullName: persistedRepository,
          branchName: FIRST_BRANCH,
          sourceEventId: "legacy-event",
          occurredAt: FIRST_AT,
          completeness: BranchActivityEvidenceCompleteness.Complete,
        },
      ]
    );
  });
});

test("ISS-6061: invalid private ref envelopes cannot contribute a Complete instant", async () => {
  await withActivityDatabase(async (db) => {
    await seedBranch(db, "branch-first", REPOSITORY, FIRST_BRANCH);
    const valid = activityRef({
      kind: ArtifactRefTargetKind.Branch,
      repositoryFullName: REPOSITORY,
      branchName: FIRST_BRANCH,
      carrier: carrier("untrusted-event", SECOND_AT),
    });
    const missingMethod = { ...valid };
    Reflect.deleteProperty(missingMethod, "method");
    const missingActivityOnly = { ...valid };
    Reflect.deleteProperty(missingActivityOnly, "monitoredActivityOnly");
    await seedSession(
      db,
      "invalid-private",
      privateMetadata([
        missingMethod,
        { ...valid, method: 42 },
        { ...valid, relation: "not-a-relation" },
        missingActivityOnly,
        { ...valid, monitoredActivityOnly: false },
      ])
    );

    assert.deepEqual(await readActivity(db, [FIRST_BRANCH]), [
      activityRow(
        FIRST_BRANCH,
        "malformed-carrier:invalid-private:0",
        null,
        BranchActivityEvidenceCompleteness.Partial
      ),
    ]);
  });
});

test("ISS-9860: a 51-event carrier reads Complete with its newest instant now that the per-target cap is retired", async () => {
  await withActivityDatabase(async (db) => {
    await seedBranch(db, "branch-first", REPOSITORY, FIRST_BRANCH);
    await seedBranch(db, "branch-second", REPOSITORY, SECOND_BRANCH);
    await seedSession(db, "fifty-session", null);
    await seedRegularCarrier(
      db,
      "fifty-link",
      "fifty-session",
      "branch-first",
      carrierWithEvents("fifty", 50, 0)
    );
    await seedSession(db, "fifty-one-session", null);
    await seedRegularCarrier(
      db,
      "fifty-one-link",
      "fifty-one-session",
      "branch-second",
      carrierWithEvents("fifty-one", 51, 100)
    );

    assert.deepEqual(await readActivity(db, [FIRST_BRANCH, SECOND_BRANCH]), [
      activityRow(FIRST_BRANCH, "fifty-49", timestamp(49)),
      activityRow(SECOND_BRANCH, "fifty-one-50", timestamp(150)),
    ]);
  });
});

test("ISS-9860: 100 and 101 events across regular and private carriers in one Session read Complete now that the Session cap is retired", async () => {
  await withActivityDatabase(async (db) => {
    await seedBranch(db, "branch-first", REPOSITORY, FIRST_BRANCH);
    await seedBranch(db, "branch-second", REPOSITORY, SECOND_BRANCH);
    await seedSession(
      db,
      "hundred-session",
      privateMetadata([
        activityRef({
          kind: ArtifactRefTargetKind.Branch,
          repositoryFullName: REPOSITORY,
          branchName: SECOND_BRANCH,
          carrier: carrierWithEvents("hundred-private", 50, 50),
        }),
      ])
    );
    await seedRegularCarrier(
      db,
      "hundred-link",
      "hundred-session",
      "branch-first",
      carrierWithEvents("hundred-regular", 50, 0)
    );

    assert.deepEqual(await readActivity(db, [FIRST_BRANCH, SECOND_BRANCH]), [
      activityRow(FIRST_BRANCH, "hundred-regular-49", timestamp(49)),
      activityRow(SECOND_BRANCH, "hundred-private-49", timestamp(99)),
    ]);
  });

  await withActivityDatabase(async (db) => {
    await seedBranch(db, "branch-first", REPOSITORY, FIRST_BRANCH);
    await seedBranch(db, "branch-second", REPOSITORY, SECOND_BRANCH);
    await seedBranch(db, "branch-third", REPOSITORY, THIRD_BRANCH);
    await seedSession(
      db,
      "hundred-one-session",
      privateMetadata([
        activityRef({
          kind: ArtifactRefTargetKind.Branch,
          repositoryFullName: REPOSITORY,
          branchName: THIRD_BRANCH,
          carrier: carrierWithEvents("hundred-one-private", 1, 200),
        }),
      ])
    );
    await seedRegularCarrier(
      db,
      "hundred-one-first-link",
      "hundred-one-session",
      "branch-first",
      carrierWithEvents("hundred-one-first", 50, 0)
    );
    await seedRegularCarrier(
      db,
      "hundred-one-second-link",
      "hundred-one-session",
      "branch-second",
      carrierWithEvents("hundred-one-second", 50, 50)
    );

    assert.deepEqual(
      await readActivity(db, [FIRST_BRANCH, SECOND_BRANCH, THIRD_BRANCH]),
      [
        activityRow(FIRST_BRANCH, "hundred-one-first-49", timestamp(49)),
        activityRow(SECOND_BRANCH, "hundred-one-second-49", timestamp(99)),
        activityRow(THIRD_BRANCH, "hundred-one-private-0", timestamp(200)),
      ]
    );
  });
});

test("ISS-6061: the private ref overflow sentinel remains attributable", async () => {
  await withActivityDatabase(async (db) => {
    await seedBranch(db, "branch-first", REPOSITORY, FIRST_BRANCH);
    await seedSession(
      db,
      "private-ref-overflow",
      privateMetadata(
        Array.from({ length: 101 }, (_, index) =>
          activityRef({
            kind: ArtifactRefTargetKind.Branch,
            repositoryFullName: REPOSITORY,
            branchName: index === 100 ? FIRST_BRANCH : SECOND_BRANCH,
            carrier: carrier(`overflow-${index}`, timestamp(index)),
          })
        )
      )
    );

    assert.deepEqual(await readActivity(db, [FIRST_BRANCH]), [
      activityRow(
        FIRST_BRANCH,
        "carrier-cap:private-ref-overflow",
        null,
        BranchActivityEvidenceCompleteness.Partial
      ),
    ]);
  });
});

test("ISS-6422: SQL validation drops strict-invalid siblings and degrades the survivor", async () => {
  await withActivityDatabase(async (db) => {
    await seedBranch(db, "branch-first", REPOSITORY, FIRST_BRANCH);
    await seedSession(db, "mixed-validation-session", null);
    await seedRegularCarrier(
      db,
      "mixed-validation-link",
      "mixed-validation-session",
      "branch-first",
      {
        completeness: BranchActivityEvidenceCompleteness.Complete,
        events: [
          {
            kind: MonitoredSessionActivityEventKind.AgentAction,
            sourceEventId: "valid-sibling",
            occurredAt: FIRST_AT,
            completeness: BranchActivityEvidenceCompleteness.Complete,
          },
          {
            kind: MonitoredSessionActivityEventKind.AgentAction,
            sourceEventId: "strict-invalid-sibling",
            occurredAt: SECOND_AT,
            completeness: BranchActivityEvidenceCompleteness.Complete,
            additiveField: true,
          },
          {
            kind: MonitoredSessionActivityEventKind.AgentRead,
            sourceEventId: "invalid-calendar-date",
            occurredAt: "2026-02-30T12:00:00.000Z",
            completeness: BranchActivityEvidenceCompleteness.Complete,
          },
        ],
      }
    );

    assert.deepEqual(await readRawActivity(db, [FIRST_BRANCH]), [
      activityRow(
        FIRST_BRANCH,
        "valid-sibling",
        FIRST_AT,
        BranchActivityEvidenceCompleteness.Partial
      ),
    ]);
  });
});

test("ISS-6422: SQL latest-event ties use the stable source identity", async () => {
  await withActivityDatabase(async (db) => {
    await seedBranch(db, "branch-first", REPOSITORY, FIRST_BRANCH);
    await seedSession(db, "tie-session", null);
    await seedRegularCarrier(db, "tie-link", "tie-session", "branch-first", {
      completeness: BranchActivityEvidenceCompleteness.Complete,
      events: [
        {
          kind: MonitoredSessionActivityEventKind.AgentAction,
          sourceEventId: "tie-zeta",
          occurredAt: SECOND_AT,
          completeness: BranchActivityEvidenceCompleteness.Complete,
        },
        {
          kind: MonitoredSessionActivityEventKind.AgentRead,
          sourceEventId: "tie-alpha",
          occurredAt: SECOND_AT,
          completeness: BranchActivityEvidenceCompleteness.Complete,
        },
      ],
    });

    assert.deepEqual(await readRawActivity(db, [FIRST_BRANCH]), [
      activityRow(FIRST_BRANCH, "tie-alpha", SECOND_AT),
    ]);
  });
});

test("ISS-6422: regular and private carrier IDs remain lane- and session-specific", async () => {
  await withActivityDatabase(async (db) => {
    await seedBranch(db, "branch-first", REPOSITORY, FIRST_BRANCH);
    await seedBranch(db, "branch-second", REPOSITORY, SECOND_BRANCH);
    await seedSession(db, "regular-session", null);
    await seedRegularCarrier(
      db,
      "private-session:0",
      "regular-session",
      "branch-first",
      carrier("regular-collision-event", FIRST_AT)
    );
    await seedSession(
      db,
      "private-session",
      privateMetadata([
        activityRef({
          kind: ArtifactRefTargetKind.Branch,
          repositoryFullName: REPOSITORY,
          branchName: SECOND_BRANCH,
          carrier: carrier("private-collision-event", SECOND_AT),
        }),
      ])
    );

    assert.deepEqual(await readRawActivity(db, [FIRST_BRANCH, SECOND_BRANCH]), [
      activityRow(FIRST_BRANCH, "regular-collision-event", FIRST_AT),
      activityRow(SECOND_BRANCH, "private-collision-event", SECOND_AT),
    ]);
  });
});

test("ISS-6422: SQL ranking truncates sub-milliseconds like Date.parse", async () => {
  await withActivityDatabase(async (db) => {
    await seedBranch(db, "branch-first", REPOSITORY, FIRST_BRANCH);
    await seedSession(db, "sub-millisecond-session", null);
    await seedRegularCarrier(
      db,
      "sub-millisecond-link",
      "sub-millisecond-session",
      "branch-first",
      {
        completeness: BranchActivityEvidenceCompleteness.Complete,
        events: [
          activityEvent("z-higher-fraction", "2026-08-12T12:05:00.0009Z"),
          activityEvent("a-lower-fraction", "2026-08-12T12:05:00.0001Z"),
        ],
      }
    );

    assert.deepEqual(await readRawActivity(db, [FIRST_BRANCH]), [
      activityRow(
        FIRST_BRANCH,
        "a-lower-fraction",
        "2026-08-12T12:05:00.0001Z"
      ),
    ]);
  });
});

test("ISS-6422: SQL and shared normalization use Unicode code-point ties", async () => {
  const events = [
    activityEvent("z-lowercase", SECOND_AT),
    activityEvent("Z-uppercase", SECOND_AT),
    activityEvent("é-accent", SECOND_AT),
    activityEvent("😀-supplementary", SECOND_AT),
    activityEvent("!punctuation", SECOND_AT),
  ];
  const normalized = normalizeSyncedMonitoredSessionActivity({
    completeness: BranchActivityEvidenceCompleteness.Complete,
    events,
  });
  assert.equal(normalized?.events.at(0)?.sourceEventId, "!punctuation");

  await withActivityDatabase(async (db) => {
    await seedBranch(db, "branch-first", REPOSITORY, FIRST_BRANCH);
    await seedSession(db, "unicode-tie-session", null);
    await seedRegularCarrier(
      db,
      "unicode-tie-link",
      "unicode-tie-session",
      "branch-first",
      {
        completeness: BranchActivityEvidenceCompleteness.Complete,
        events,
      }
    );

    assert.deepEqual(await readRawActivity(db, [FIRST_BRANCH]), [
      activityRow(FIRST_BRANCH, "!punctuation", SECOND_AT),
    ]);
  });
});

test("ISS-6422: final rows validate lookup identities and preserve persisted bytes", async () => {
  const repository = `${"o".repeat(99)}/${"r".repeat(100)}`;
  const branch = "b".repeat(300);
  const persistedRepository = `//${repository}.git//`;
  const persistedBranch = `\u3000${branch}\u2029`;
  await withActivityDatabase(async (db) => {
    await seedBranch(
      db,
      "unicode-whitespace-branch",
      persistedRepository,
      persistedBranch
    );
    await seedSession(
      db,
      "unicode-whitespace-session",
      privateMetadata([
        activityRef({
          kind: ArtifactRefTargetKind.Branch,
          repositoryFullName: repository,
          branchName: branch,
          carrier: carrier("\ufefftrimmed-source\t", SECOND_AT),
        }),
      ])
    );

    const rows = await queryBranchActivityRows(
      db.prisma,
      normalizeBranchActivityScopes([
        { repoFullName: repository, branchName: branch },
      ])
    );
    assert.deepEqual(rows, [
      {
        repoFullName: persistedRepository,
        branchName: persistedBranch,
        sourceEventId: "trimmed-source",
        occurredAt: SECOND_AT,
        completeness: BranchActivityEvidenceCompleteness.Complete,
      },
    ]);
  });
});

test("ISS-6422: private timestamp validation survives large session metadata", async () => {
  await withActivityDatabase(async (db) => {
    await seedBranch(db, "branch-first", REPOSITORY, FIRST_BRANCH);
    await seedBranch(db, "branch-second", REPOSITORY, SECOND_BRANCH);
    await seedBranch(db, "branch-third", REPOSITORY, THIRD_BRANCH);
    await seedSession(
      db,
      "timestamp-session",
      privateMetadata(
        [
          {
            ...activityRef({
              kind: ArtifactRefTargetKind.Branch,
              repositoryFullName: REPOSITORY,
              branchName: FIRST_BRANCH,
              carrier: carrier("basic-offset-event", FIRST_AT),
            }),
            observedAt: "2026-08-12T14:05:00+0200",
          },
          {
            ...activityRef({
              kind: ArtifactRefTargetKind.Branch,
              repositoryFullName: REPOSITORY,
              branchName: SECOND_BRANCH,
              carrier: carrier("rfc-event", SECOND_AT),
            }),
            observedAt: "Wed, 12 Aug 2026 12:00:00 GMT",
          },
          {
            ...activityRef({
              kind: ArtifactRefTargetKind.Branch,
              repositoryFullName: REPOSITORY,
              branchName: THIRD_BRANCH,
              carrier: carrier("sqlite-only-event", SECOND_AT),
            }),
            observedAt: "now",
          },
        ],
        OVERSIZED_JSON_PADDING_LENGTH
      )
    );

    assert.deepEqual(
      await readRawActivity(db, [FIRST_BRANCH, SECOND_BRANCH, THIRD_BRANCH]),
      [
        activityRow(FIRST_BRANCH, "basic-offset-event", FIRST_AT),
        activityRow(SECOND_BRANCH, "rfc-event", SECOND_AT),
        {
          repoFullName: REPOSITORY,
          branchName: THIRD_BRANCH,
          sourceEventId: "malformed-carrier:timestamp-session:2",
          occurredAt: null,
          completeness: BranchActivityEvidenceCompleteness.Partial,
        },
      ]
    );
  });
});

test("ISS-9860: a 500-event carrier reads its newest event Complete now that the first-200 raw scan is retired", async () => {
  await withActivityDatabase(async (db) => {
    await seedBranch(db, "branch-first", REPOSITORY, FIRST_BRANCH);
    await seedSession(db, "oversized-events-session", null);
    await seedRegularCarrier(
      db,
      "oversized-events-link",
      "oversized-events-session",
      "branch-first",
      carrierWithEvents("oversized", 500, 0)
    );

    assert.deepEqual(await readRawActivity(db, [FIRST_BRANCH]), [
      activityRow(FIRST_BRANCH, "oversized-499", timestamp(499)),
    ]);
  });
});

test("ISS-9860: oversized attributable carrier JSON reads whole now that the 256 KiB guard is retired", async () => {
  await withActivityDatabase(async (db) => {
    await seedBranch(db, "branch-first", REPOSITORY, FIRST_BRANCH);
    await seedSession(db, "oversized-json-session", null);
    await seedRegularCarrier(
      db,
      "oversized-json-link",
      "oversized-json-session",
      "branch-first",
      carrier("oversized-json-event", SECOND_AT)
    );
    await db.run(
      "UPDATE session_artifact_links SET evidence = $1 WHERE id = $2",
      JSON.stringify({
        monitoredSessionActivity: carrier("oversized-json-event", SECOND_AT),
        padding: "x".repeat(OVERSIZED_JSON_PADDING_LENGTH),
      }),
      "oversized-json-link"
    );

    assert.deepEqual(await readRawActivity(db, [FIRST_BRANCH]), [
      activityRow(FIRST_BRANCH, "oversized-json-event", SECOND_AT),
    ]);
  });
});

function readActivity(db: SqliteAgentDatabase, branchNames: readonly string[]) {
  const branchKeys: BranchCanonicalActivityKey[] = branchNames.map(
    (branchName) => ({ repoFullName: REPOSITORY, branchName })
  );
  return db.readBranchCanonicalActivityRows({ branchKeys });
}

async function readRawActivity(
  db: SqliteAgentDatabase,
  branchNames: readonly string[]
) {
  const branchKeys: BranchCanonicalActivityKey[] = branchNames.map(
    (branchName) => ({ repoFullName: REPOSITORY, branchName })
  );
  const directRows = await queryBranchActivityRows(
    db.prisma,
    normalizeBranchActivityScopes(branchKeys)
  );
  return directRows;
}

async function withActivityDatabase(
  run: (db: SqliteAgentDatabase) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss6061-branch-activity-"));
  const db = await openTestDb(dir);
  try {
    await run(db);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function seedSession(
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

async function seedBranch(
  db: SqliteAgentDatabase,
  id: string,
  repository: string,
  branch: string
): Promise<void> {
  await db.run(
    `INSERT INTO artifacts
       (id, identity_key, kind, repo_full_name, branch_name, created_at, last_seen_at)
     VALUES ($1, $2, '${ArtifactRefTargetKind.Branch}', $3, $4, $5, $5)`,
    id,
    `identity:${id}`,
    repository,
    branch,
    FIRST_AT
  );
}

async function seedPullRequest(
  db: SqliteAgentDatabase,
  id: string,
  repository: string,
  prNumber: number,
  branchName: string
): Promise<void> {
  await db.run(
    `INSERT INTO pull_requests
       (id, pr_url, pr_number, repo_full_name, branch_name, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    id,
    `https://github.com/${repository}/pull/${prNumber}`,
    prNumber,
    repository,
    branchName,
    FIRST_AT
  );
}

async function seedRegularCarrier(
  db: SqliteAgentDatabase,
  id: string,
  sessionId: string,
  artifactId: string,
  monitoredSessionActivity: unknown
): Promise<void> {
  await db.run(
    `INSERT INTO session_artifact_links
       (id, session_id, artifact_id, relation, method, evidence,
        extractor_version, observed_at, created_at)
     VALUES ($1, $2, $3, '${ArtifactRefRelation.Created}',
       '${ArtifactRefMethod.UrlInMessage}', $4, 25, $5, $5)`,
    id,
    sessionId,
    artifactId,
    JSON.stringify({ monitoredSessionActivity }),
    FIRST_AT
  );
}

function privateMetadata(refs: readonly unknown[], paddingLength = 0): string {
  return JSON.stringify({
    ...(paddingLength > 0 ? { padding: "x".repeat(paddingLength) } : {}),
    __monitoredSessionActivityRefs: refs,
  });
}

function activityRef(input: {
  kind:
    | typeof ArtifactRefTargetKind.Branch
    | typeof ArtifactRefTargetKind.PullRequest;
  repositoryFullName: string;
  branchName?: string;
  prNumber?: number;
  carrier: unknown;
}): Record<string, unknown> {
  return {
    kind: input.kind,
    repositoryFullName: input.repositoryFullName,
    ...(input.branchName ? { branchName: input.branchName } : {}),
    ...(input.prNumber ? { prNumber: input.prNumber } : {}),
    method: ArtifactRefMethod.UrlInMessage,
    relation: ArtifactRefRelation.Referenced,
    monitoredActivityOnly: true,
    monitoredSessionActivity: input.carrier,
  };
}

function carrier(
  sourceEventId: string,
  occurredAt: string,
  completeness: BranchActivityEvidenceCompleteness = BranchActivityEvidenceCompleteness.Complete
): Record<string, unknown> {
  return {
    completeness,
    events: [
      {
        kind: MonitoredSessionActivityEventKind.AgentAction,
        sourceEventId,
        occurredAt,
        completeness,
      },
    ],
  };
}

function activityEvent(sourceEventId: string, occurredAt: string) {
  return {
    kind: MonitoredSessionActivityEventKind.AgentAction,
    sourceEventId,
    occurredAt,
    completeness: BranchActivityEvidenceCompleteness.Complete,
  };
}

function carrierWithEvents(
  sourcePrefix: string,
  count: number,
  startIndex: number
): Record<string, unknown> {
  return {
    completeness: BranchActivityEvidenceCompleteness.Complete,
    events: Array.from({ length: count }, (_, index) => ({
      kind: MonitoredSessionActivityEventKind.AgentAction,
      sourceEventId: `${sourcePrefix}-${index}`,
      occurredAt: timestamp(startIndex + index),
      completeness: BranchActivityEvidenceCompleteness.Complete,
    })),
  };
}

function timestamp(index: number): string {
  return new Date(Date.parse(FIRST_AT) + index * 1000).toISOString();
}

function activityRow(
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
