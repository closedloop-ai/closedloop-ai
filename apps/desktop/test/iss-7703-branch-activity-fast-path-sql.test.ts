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
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { test } from "vitest";
import { BRANCH_ACTIVITY_FAST_PATH_SQL } from "../src/main/database/branch-activity-fast-path-sql.js";
import { normalizeBranchActivityScopes } from "../src/main/database/branch-activity-identity.js";
import { BRANCH_ACTIVITY_SCOPE_BATCH_SIZE } from "../src/main/database/branch-activity-sql.js";
import type { SqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { MONITORED_ACTIVITY_ONLY_METADATA_KEY } from "../src/main/database/synced-monitored-session-activity.js";
import { openTestDb } from "./agent-db-test-utils.js";

const REPOSITORY = "closedloop-ai/closedloop-ai";
const FIRST_BRANCH = "fix/first";
const SECOND_BRANCH = "fix/second";
const TARGET_CAP_BRANCH = "fix/target-cap";
const SOURCE_CONFLICT_BRANCH = "fix/source-conflict";
const FIRST_AT = "2026-08-12T12:00:00.000Z";
const SECOND_AT = "2026-08-12T12:05:00.000Z";
/**
 * ISS-9860 retired these three producer caps and the carrier byte guard. The
 * cases below exceed each retired bound on purpose, so the numbers stay here
 * as the record of what a fixture is exceeding.
 */
const RETIRED_TARGET_EVENT_CAP = 50;
const RETIRED_SESSION_EVENT_CAP = 100;
const RETIRED_RAW_EVENT_SCAN_CAP = 200;
const RETIRED_CARRIER_MAX_BYTES = 262_144;

test("ISS-7703: complete regular Branch carriers take the fast path", async () => {
  await withActivityDatabase(async (db) => {
    await seedBranch(db, "regular-branch", FIRST_BRANCH);
    await seedSession(db, "regular-session", null);
    await seedSession(
      db,
      "unrelated-private-session",
      JSON.stringify({
        [MONITORED_ACTIVITY_ONLY_METADATA_KEY]: [
          {
            kind: ArtifactRefTargetKind.Branch,
            repositoryFullName: REPOSITORY,
            branchName: SECOND_BRANCH,
            method: ArtifactRefMethod.UrlInMessage,
            relation: ArtifactRefRelation.Referenced,
            monitoredActivityOnly: true,
            monitoredSessionActivity: activityCarrier(
              "unrelated-private-event",
              SECOND_AT
            ),
          },
        ],
      })
    );
    await seedCarrierLink(db, {
      id: "regular-link",
      sessionId: "regular-session",
      artifactId: "regular-branch",
      evidence: JSON.stringify({
        monitoredSessionActivity: activityCarrier("regular-event", FIRST_AT),
      }),
    });

    assert.deepEqual(await readFastPathRows(db, [FIRST_BRANCH]), [
      fastPathActivityResult(FIRST_BRANCH, "regular-event", FIRST_AT),
    ]);
    assert.deepEqual(await readActivityRows(db, [FIRST_BRANCH]), [
      activityResult(FIRST_BRANCH, "regular-event", FIRST_AT),
    ]);
  });
});

test("ISS-7703/ISS-9860: partial and malformed carriers fall back; an oversized valid carrier is admitted whole", async () => {
  const malformedBranch = "fix/fallback-malformed";
  const oversizedBranch = "fix/fallback-oversized";
  const partialBranch = "fix/fallback-partial";
  await withActivityDatabase(async (db) => {
    await seedBranch(db, "malformed-branch", malformedBranch);
    await seedBranch(db, "oversized-branch", oversizedBranch);
    await seedBranch(db, "partial-branch", partialBranch);
    await seedSession(db, "malformed-session", null);
    await seedSession(db, "oversized-session", null);
    await seedSession(db, "partial-session", null);
    await seedCarrierLink(db, {
      id: "malformed-link",
      sessionId: "malformed-session",
      artifactId: "malformed-branch",
      evidence: "{not-json",
    });
    await seedCarrierLink(db, {
      id: "oversized-link",
      sessionId: "oversized-session",
      artifactId: "oversized-branch",
      evidence: JSON.stringify({
        monitoredSessionActivity: activityCarrier("oversized-event", FIRST_AT),
        padding: "x".repeat(RETIRED_CARRIER_MAX_BYTES + 1),
      }),
    });
    await seedCarrierLink(db, {
      id: "partial-link",
      sessionId: "partial-session",
      artifactId: "partial-branch",
      evidence: JSON.stringify({
        monitoredSessionActivity: activityCarrier(
          "partial-event",
          FIRST_AT,
          BranchActivityEvidenceCompleteness.Partial
        ),
      }),
    });

    assert.deepEqual(await readFastPathRows(db, [malformedBranch]), [
      unsupportedFastPathRow(),
    ]);
    assert.deepEqual(await readFastPathRows(db, [oversizedBranch]), [
      fastPathActivityResult(oversizedBranch, "oversized-event", FIRST_AT),
    ]);
    assert.deepEqual(await readFastPathRows(db, [partialBranch]), [
      unsupportedFastPathRow(),
    ]);
    assert.deepEqual(
      await readActivityRows(db, [
        malformedBranch,
        oversizedBranch,
        partialBranch,
      ]),
      [
        activityResult(
          malformedBranch,
          "malformed-carrier:malformed-link",
          null,
          BranchActivityEvidenceCompleteness.Partial
        ),
        activityResult(oversizedBranch, "oversized-event", FIRST_AT),
        activityResult(
          partialBranch,
          "partial-event",
          FIRST_AT,
          BranchActivityEvidenceCompleteness.Partial
        ),
      ]
    );
  });
});

test("ISS-7703: invalid carrier siblings with matching event identity fall back", async () => {
  const partialSiblingBranch = "fix/carrier-partial-sibling";
  const strictInvalidSiblingBranch = "fix/carrier-invalid-sibling";
  await withActivityDatabase(async (db) => {
    await seedBranch(db, "partial-sibling-branch", partialSiblingBranch);
    await seedBranch(
      db,
      "strict-invalid-sibling-branch",
      strictInvalidSiblingBranch
    );
    await seedSession(db, "partial-sibling-session", null);
    await seedSession(db, "strict-invalid-sibling-session", null);
    await seedCarrierLink(db, {
      id: "partial-sibling-complete-link",
      sessionId: "partial-sibling-session",
      artifactId: "partial-sibling-branch",
      evidence: JSON.stringify({
        monitoredSessionActivity: activityCarrier("sibling-event", FIRST_AT),
      }),
    });
    await seedCarrierLink(db, {
      id: "partial-sibling-partial-link",
      sessionId: "partial-sibling-session",
      artifactId: "partial-sibling-branch",
      relation: ArtifactRefRelation.Referenced,
      evidence: JSON.stringify({
        monitoredSessionActivity: activityCarrier(
          "sibling-event",
          FIRST_AT,
          BranchActivityEvidenceCompleteness.Partial
        ),
      }),
    });
    await seedCarrierLink(db, {
      id: "strict-invalid-sibling-complete-link",
      sessionId: "strict-invalid-sibling-session",
      artifactId: "strict-invalid-sibling-branch",
      evidence: JSON.stringify({
        monitoredSessionActivity: activityCarrier("sibling-event", FIRST_AT),
      }),
    });
    await seedCarrierLink(db, {
      id: "strict-invalid-sibling-invalid-link",
      sessionId: "strict-invalid-sibling-session",
      artifactId: "strict-invalid-sibling-branch",
      relation: ArtifactRefRelation.Referenced,
      evidence: JSON.stringify({
        monitoredSessionActivity: strictInvalidActivityCarrier(
          "sibling-event",
          FIRST_AT
        ),
      }),
    });

    assert.deepEqual(await readFastPathRows(db, [partialSiblingBranch]), [
      unsupportedFastPathRow(),
    ]);
    assert.deepEqual(await readFastPathRows(db, [strictInvalidSiblingBranch]), [
      unsupportedFastPathRow(),
    ]);
    assert.deepEqual(
      await readActivityRows(db, [
        partialSiblingBranch,
        strictInvalidSiblingBranch,
      ]),
      [
        activityResult(
          strictInvalidSiblingBranch,
          "sibling-event",
          FIRST_AT,
          BranchActivityEvidenceCompleteness.Partial
        ),
        activityResult(
          partialSiblingBranch,
          "sibling-event",
          FIRST_AT,
          BranchActivityEvidenceCompleteness.Partial
        ),
      ]
    );
  });
});

test("ISS-7703: private metadata and PR carriers fall back without attribution drift", async () => {
  await withActivityDatabase(async (db) => {
    await seedBranch(db, "pr-head-branch", FIRST_BRANCH);
    await seedBranch(db, "private-branch", SECOND_BRANCH);
    await seedPullRequest(db, "pr-42", 42, FIRST_BRANCH);
    await seedPullRequestArtifact(db, "pr-artifact-42", 42, FIRST_BRANCH);
    await seedSession(db, "pr-session", null);
    await seedSession(
      db,
      "private-session",
      JSON.stringify({
        [MONITORED_ACTIVITY_ONLY_METADATA_KEY]: [
          {
            kind: ArtifactRefTargetKind.Branch,
            repositoryFullName: REPOSITORY,
            branchName: SECOND_BRANCH,
            method: ArtifactRefMethod.UrlInMessage,
            relation: ArtifactRefRelation.Referenced,
            monitoredActivityOnly: true,
            monitoredSessionActivity: activityCarrier(
              "private-event",
              SECOND_AT
            ),
          },
        ],
      })
    );
    await seedCarrierLink(db, {
      id: "pr-link",
      sessionId: "pr-session",
      artifactId: "pr-artifact-42",
      evidence: JSON.stringify({
        monitoredSessionActivity: activityCarrier("pr-event", FIRST_AT),
      }),
    });

    assert.deepEqual(await readFastPathRows(db, [FIRST_BRANCH]), [
      unsupportedFastPathRow(),
    ]);
    assert.deepEqual(await readFastPathRows(db, [SECOND_BRANCH]), [
      unsupportedFastPathRow(),
    ]);
    assert.deepEqual(
      await readActivityRows(db, [FIRST_BRANCH, SECOND_BRANCH]),
      [
        activityResult(FIRST_BRANCH, "pr-event", FIRST_AT),
        activityResult(SECOND_BRANCH, "private-event", SECOND_AT),
      ]
    );
  });
});

test("ISS-9860: a carrier past the retired target cap reads Complete; conflicting evidence still falls back Partial", async () => {
  await withActivityDatabase(async (db) => {
    await seedBranch(db, "target-cap-branch", TARGET_CAP_BRANCH);
    await seedBranch(db, "source-conflict-branch", SOURCE_CONFLICT_BRANCH);
    await seedSession(db, "target-cap-session", null);
    await seedSession(db, "first-conflict-session", null);
    await seedSession(db, "second-conflict-session", null);
    await seedCarrierLink(db, {
      id: "target-cap-link",
      sessionId: "target-cap-session",
      artifactId: "target-cap-branch",
      evidence: JSON.stringify({
        monitoredSessionActivity: carrierWithEvents(
          "target-cap",
          RETIRED_TARGET_EVENT_CAP + 1
        ),
      }),
    });
    await seedCarrierLink(db, {
      id: "first-conflict-link",
      sessionId: "first-conflict-session",
      artifactId: "source-conflict-branch",
      evidence: JSON.stringify({
        monitoredSessionActivity: activityCarrier("conflict-event", FIRST_AT),
      }),
    });
    await seedCarrierLink(db, {
      id: "second-conflict-link",
      sessionId: "second-conflict-session",
      artifactId: "source-conflict-branch",
      evidence: JSON.stringify({
        monitoredSessionActivity: activityCarrier("conflict-event", SECOND_AT),
      }),
    });

    assert.deepEqual(await readFastPathRows(db, [SOURCE_CONFLICT_BRANCH]), [
      unsupportedFastPathRow(),
    ]);
    assert.deepEqual(await readFastPathRows(db, [TARGET_CAP_BRANCH]), [
      unsupportedFastPathRow(),
    ]);
    assert.deepEqual(
      await readActivityRows(db, [SOURCE_CONFLICT_BRANCH, TARGET_CAP_BRANCH]),
      [
        activityResult(
          SOURCE_CONFLICT_BRANCH,
          "conflicting-source:conflict-event",
          null,
          BranchActivityEvidenceCompleteness.Partial
        ),
        activityResult(
          TARGET_CAP_BRANCH,
          `target-cap-${RETIRED_TARGET_EVENT_CAP}`,
          timestamp(RETIRED_TARGET_EVENT_CAP)
        ),
      ]
    );
  });
});

test("ISS-7703: one carrier per session across many sessions takes the fast path", async () => {
  const sessionCount = RETIRED_TARGET_EVENT_CAP + 1;
  const latestSourceEventId = `target-cap-session-${sessionCount - 1}`;
  const latestOccurredAt = timestamp(sessionCount - 1);

  await withActivityDatabase(async (db) => {
    await seedBranch(db, "per-session-target-cap-branch", TARGET_CAP_BRANCH);
    for (let index = 0; index < sessionCount; index += 1) {
      const sessionId = `target-cap-session-${index}`;
      await seedSession(db, sessionId, null);
      await seedCarrierLink(db, {
        id: `target-cap-link-${index}`,
        sessionId,
        artifactId: "per-session-target-cap-branch",
        evidence: JSON.stringify({
          monitoredSessionActivity: activityCarrier(
            `target-cap-session-${index}`,
            timestamp(index)
          ),
        }),
      });
    }

    assert.deepEqual(await readFastPathRows(db, [TARGET_CAP_BRANCH]), [
      fastPathActivityResult(
        TARGET_CAP_BRANCH,
        latestSourceEventId,
        latestOccurredAt
      ),
    ]);
    assert.deepEqual(await readActivityRows(db, [TARGET_CAP_BRANCH]), [
      activityResult(TARGET_CAP_BRANCH, latestSourceEventId, latestOccurredAt),
    ]);
  });
});

test("ISS-7703: one single-event carrier per relation on one session and Branch takes the fast path", async () => {
  // The densest regular shape one (session, Branch) can hold: the link table is
  // UNIQUE on (session_id, artifact_id, relation) and `eligible_branches` admits
  // one artifact per Branch, so six carriers is the ceiling. That ceiling is why
  // the fast path's retired per-target (50) and per-session (100) event arms
  // could never fire on single-event carriers; this pins the reachable shape.
  const relations = Object.values(ArtifactRefRelation);
  const latestIndex = relations.length - 1;
  const latestSourceEventId = `dense-${latestIndex}`;
  const latestOccurredAt = timestamp(latestIndex);

  await withActivityDatabase(async (db) => {
    await seedBranch(db, "dense-branch", TARGET_CAP_BRANCH);
    await seedSession(db, "dense-session", null);
    for (const [index, relation] of relations.entries()) {
      await seedCarrierLink(db, {
        id: `dense-link-${index}`,
        sessionId: "dense-session",
        artifactId: "dense-branch",
        relation,
        evidence: JSON.stringify({
          monitoredSessionActivity: activityCarrier(
            `dense-${index}`,
            timestamp(index)
          ),
        }),
      });
    }

    assert.deepEqual(await readFastPathRows(db, [TARGET_CAP_BRANCH]), [
      fastPathActivityResult(
        TARGET_CAP_BRANCH,
        latestSourceEventId,
        latestOccurredAt
      ),
    ]);
    assert.deepEqual(await readActivityRows(db, [TARGET_CAP_BRANCH]), [
      activityResult(TARGET_CAP_BRANCH, latestSourceEventId, latestOccurredAt),
    ]);
  });
});

test("ISS-9860: a 300-event Complete carrier reads Complete with its newest event", async () => {
  const eventCount = RETIRED_RAW_EVENT_SCAN_CAP + 100;
  await withActivityDatabase(async (db) => {
    await seedBranch(db, "wide-branch", FIRST_BRANCH);
    await seedSession(db, "wide-session", null);
    await seedCarrierLink(db, {
      id: "wide-link",
      sessionId: "wide-session",
      artifactId: "wide-branch",
      evidence: JSON.stringify({
        monitoredSessionActivity: carrierWithEvents("wide", eventCount),
      }),
    });

    assert.deepEqual(await readActivityRows(db, [FIRST_BRANCH]), [
      activityResult(
        FIRST_BRANCH,
        `wide-${eventCount - 1}`,
        timestamp(eventCount - 1)
      ),
    ]);
  });
});

test("ISS-9860: more than 100 events across one session's Branches read Complete on every Branch", async () => {
  const eventsPerBranch = RETIRED_SESSION_EVENT_CAP / 2 + 10;
  assert.ok(eventsPerBranch * 2 > RETIRED_SESSION_EVENT_CAP);
  await withActivityDatabase(async (db) => {
    await seedBranch(db, "spread-first-branch", FIRST_BRANCH);
    await seedBranch(db, "spread-second-branch", SECOND_BRANCH);
    await seedSession(db, "spread-session", null);
    await seedCarrierLink(db, {
      id: "spread-first-link",
      sessionId: "spread-session",
      artifactId: "spread-first-branch",
      evidence: JSON.stringify({
        monitoredSessionActivity: carrierWithEvents(
          "spread-first",
          eventsPerBranch
        ),
      }),
    });
    await seedCarrierLink(db, {
      id: "spread-second-link",
      sessionId: "spread-session",
      artifactId: "spread-second-branch",
      evidence: JSON.stringify({
        monitoredSessionActivity: carrierWithEvents(
          "spread-second",
          eventsPerBranch
        ),
      }),
    });

    assert.deepEqual(
      await readActivityRows(db, [FIRST_BRANCH, SECOND_BRANCH]),
      [
        activityResult(
          FIRST_BRANCH,
          `spread-first-${eventsPerBranch - 1}`,
          timestamp(eventsPerBranch - 1)
        ),
        activityResult(
          SECOND_BRANCH,
          `spread-second-${eventsPerBranch - 1}`,
          timestamp(eventsPerBranch - 1)
        ),
      ]
    );
  });
});

async function withActivityDatabase(
  run: (db: SqliteAgentDatabase) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss7703-fast-path-"));
  const db = await openTestDb(dir);
  try {
    await run(db);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
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

function readFastPathRows(
  db: SqliteAgentDatabase,
  branchNames: readonly string[]
) {
  const scopes = normalizeBranchActivityScopes(
    branchNames.map((branchName) => ({
      repoFullName: REPOSITORY,
      branchName,
    }))
  );
  return db.prisma.read((reader) =>
    reader.$queryRawUnsafe(
      BRANCH_ACTIVITY_FAST_PATH_SQL,
      JSON.stringify(batchScopes(scopes))
    )
  );
}

async function seedBranch(
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

async function seedPullRequest(
  db: SqliteAgentDatabase,
  id: string,
  prNumber: number,
  branchName: string
): Promise<void> {
  await db.run(
    `INSERT INTO pull_requests
       (id, pr_url, pr_number, repo_full_name, branch_name, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    id,
    `https://github.com/${REPOSITORY}/pull/${prNumber}`,
    prNumber,
    REPOSITORY,
    branchName,
    FIRST_AT
  );
}

async function seedPullRequestArtifact(
  db: SqliteAgentDatabase,
  id: string,
  prNumber: number,
  branchName: string
): Promise<void> {
  await db.run(
    `INSERT INTO artifacts
       (id, identity_key, kind, repo_full_name, pr_number, branch_name,
        created_at, last_seen_at)
     VALUES ($1, $2, '${ArtifactRefTargetKind.PullRequest}', $3, $4, $5, $6, $6)`,
    id,
    `identity:${id}`,
    REPOSITORY,
    prNumber,
    branchName,
    FIRST_AT
  );
}

async function seedSession(
  db: SqliteAgentDatabase,
  id: string,
  metadata: string | null
): Promise<void> {
  await db.run(
    "INSERT INTO sessions (id, status, metadata) VALUES ($1, $2, $3)",
    id,
    SESSION_STATUS.INACTIVE,
    metadata
  );
}

async function seedCarrierLink(
  db: SqliteAgentDatabase,
  input: {
    id: string;
    sessionId: string;
    artifactId: string;
    relation?: ArtifactRefRelation;
    evidence: string;
  }
): Promise<void> {
  await db.run(
    `INSERT INTO session_artifact_links
       (id, session_id, artifact_id, relation, method, evidence,
        extractor_version, observed_at, created_at)
     VALUES ($1, $2, $3, $4, '${ArtifactRefMethod.UrlInMessage}',
       $5, 25, $6, $6)`,
    input.id,
    input.sessionId,
    input.artifactId,
    input.relation ?? ArtifactRefRelation.Created,
    input.evidence,
    FIRST_AT
  );
}

function activityCarrier(
  sourceEventId: string,
  occurredAt: string,
  completeness: BranchActivityEvidenceCompleteness = BranchActivityEvidenceCompleteness.Complete
) {
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

function carrierWithEvents(sourcePrefix: string, count: number) {
  return {
    completeness: BranchActivityEvidenceCompleteness.Complete,
    events: Array.from({ length: count }, (_, index) => ({
      kind: MonitoredSessionActivityEventKind.AgentAction,
      sourceEventId: `${sourcePrefix}-${index}`,
      occurredAt: timestamp(index),
      completeness: BranchActivityEvidenceCompleteness.Complete,
    })),
  };
}

function strictInvalidActivityCarrier(
  sourceEventId: string,
  occurredAt: string
) {
  return {
    completeness: BranchActivityEvidenceCompleteness.Complete,
    events: [
      {
        kind: MonitoredSessionActivityEventKind.AgentAction,
        sourceEventId,
        occurredAt,
        completeness: BranchActivityEvidenceCompleteness.Complete,
        extra: true,
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

function fastPathActivityResult(
  branchName: string,
  sourceEventId: string,
  occurredAt: string
) {
  return {
    fastPathSupported: 1,
    ...activityResult(branchName, sourceEventId, occurredAt),
  };
}

function unsupportedFastPathRow() {
  return {
    fastPathSupported: 0,
    repoFullName: null,
    branchName: null,
    sourceEventId: null,
    occurredAt: null,
    completeness: BranchActivityEvidenceCompleteness.Complete,
  };
}

function batchScopes<T>(scopes: readonly T[]): T[][] {
  const batches: T[][] = [];
  for (
    let index = 0;
    index < scopes.length;
    index += BRANCH_ACTIVITY_SCOPE_BATCH_SIZE
  ) {
    batches.push(scopes.slice(index, index + BRANCH_ACTIVITY_SCOPE_BATCH_SIZE));
  }
  return batches;
}

function timestamp(index: number): string {
  return new Date(Date.parse(FIRST_AT) + index * 1000).toISOString();
}
