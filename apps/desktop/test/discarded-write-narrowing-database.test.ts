/**
 * @file discarded-write-narrowing-database.test.ts
 * @description ISS-6321 (batch 5/6) — the discarded wide writes under
 * `main/database/` other than the transcript-sync cluster (which has its own
 * sibling suite) and `branch-pr-attribution` (covered where its branch/PR
 * fixture already lives, in `maintenance-branch-pr-propagation.test.ts`).
 *
 * Seven sites: `opencode-withheld-store` x2, `repository-default-authority-store`
 * x2, `sync-cursor-state` x1, `sync-outbox-store` x2, plus `activity-metrics`.
 *
 * Every one keeps its verb and takes a `select` on the table's REAL primary
 * key. That key is compound on four of them, and named something other than
 * `id` on all of them:
 *
 * | table | primary key |
 * | --- | --- |
 * | `session_activity_metrics` | `sessionId` |
 * | `opencode_withheld_subagent_root` | `[sourcePath, rootRawId]` |
 * | `opencode_withheld_scan` | `sourcePath` |
 * | `repository_default_authorities` | `[identityKey, provider, providerRepositoryId]` |
 * | `sync_state` | `sourceKey` |
 * | `agent_session_sync_outbox` | `[sourceKey, externalSessionId]` |
 *
 * The two `repository-default-authority-store` sites keep `create`/`update`
 * because `reconcileObservation` reads the current row with `findUnique` and
 * then writes INSIDE THE SAME interactive transaction, branching on that read —
 * the shape batch 4 refused.
 *
 * Be precise about how strong that is: no production path deletes from
 * `repository_default_authorities`, and the `findUnique` and the `update` share
 * one interactive transaction on the single writer connection, so the `update`'s
 * P2025 is NOT reachable today. It is defence-in-depth against a future delete
 * path, not a currently-live throw — which is why there is deliberately no
 * missing-row test here, unlike the transcript-sync and scheduler suites where
 * the throw IS reachable and IS pinned. What this suite pins instead is the verb:
 * a silent conversion to `updateMany` fails `refuses to batch the authority
 * write` below.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import {
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultSource,
} from "@repo/api/src/types/repository-default-identity";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import { upsertActivityMetricsRollup } from "../src/main/database/activity-metrics.js";
import { recordOpencodeWithheldSubagents } from "../src/main/database/opencode-withheld-store.js";
import { writeRepositoryDefaultAuthorities } from "../src/main/database/repository-default-authority-store.js";
import { sqliteAdvanceSyncState } from "../src/main/database/sync-cursor-state.js";
import {
  sqliteMarkOutboxDeadLettered,
  sqliteRecordOutboxRetry,
} from "../src/main/database/sync-outbox-store.js";
import {
  assertNarrowedTo,
  recordDesktopWrites,
} from "./discarded-write-narrowing-utils.js";
import { openTestPrisma } from "./prisma-test-utils.js";

const OBSERVED_AT = "2026-08-11T01:00:00.000Z";
const LATER = "2026-08-12T01:00:00.000Z";
const SOURCE_PATH = "/tmp/iss6321/opencode.db";
const SOURCE_KEY = "iss6321-source";
const SESSION_ID = "iss6321-session";
const IDENTITY_KEY = "iss6321-identity";
const REPO_ID = "iss6321-repo";

async function open() {
  const opened = await openTestPrisma();
  return { ...opened, recorded: recordDesktopWrites(opened.prisma) };
}

async function rowsOf<T extends Record<string, unknown>>(
  db: Awaited<ReturnType<typeof openTestPrisma>>["db"],
  sql: string
): Promise<T[]> {
  const result = await db.query<T>(sql);
  return result.rows;
}

// ───────────── opencode-withheld-store (58 root, 79 scan) ─────────────

const withheldReport = (withheldCount: number) => ({
  sourcePath: SOURCE_PATH,
  roots: [
    {
      rootRawId: "root-1",
      withheldCount,
      reason: "unparseable",
      withheldTokens: 10,
      withheldCacheTokens: 2,
      earliestChildStartedAt: OBSERVED_AT,
      latestChildEndedAt: OBSERVED_AT,
      windowPartial: false,
    },
  ],
});

test("PARITY: recordOpencodeWithheldSubagents persists the root and its scan verdict", async () => {
  const { db, recorded, close } = await open();
  try {
    await recordOpencodeWithheldSubagents(
      recorded.prisma,
      withheldReport(3),
      OBSERVED_AT
    );
    // A second load with a different count must UPDATE the same compound row.
    await recordOpencodeWithheldSubagents(
      recorded.prisma,
      withheldReport(5),
      LATER
    );

    const roots = await rowsOf<{ root_raw_id: string; withheld_count: number }>(
      db,
      "SELECT root_raw_id, withheld_count FROM opencode_withheld_subagent_root"
    );
    assert.equal(roots.length, 1);
    assert.equal(Number(roots[0].withheld_count), 5);

    const scans = await rowsOf<{ source_path: string; observed_at: string }>(
      db,
      "SELECT source_path, observed_at FROM opencode_withheld_scan"
    );
    assert.equal(scans.length, 1);
    assert.equal(
      scans[0].observed_at,
      LATER,
      "the scan verdict must land in the same transaction as the reconcile"
    );
  } finally {
    await close();
  }
});

test("NARROWING: both opencode writes RETURNING only their primary key", async () => {
  const { recorded, close } = await open();
  try {
    await recordOpencodeWithheldSubagents(
      recorded.prisma,
      withheldReport(3),
      OBSERVED_AT
    );

    assertNarrowedTo(
      recorded.only("opencodeWithheldSubagentRoot", "upsert"),
      { sourcePath: true, rootRawId: true },
      "withheld root"
    );
    assertNarrowedTo(
      recorded.only("opencodeWithheldScan", "upsert"),
      { sourcePath: true },
      "withheld scan verdict"
    );
  } finally {
    await close();
  }
});

// ────────── repository-default-authority-store (245 create, 264 update) ──────────

const authorityObservation = (defaultBranch: string, observedAt: string) => ({
  repository: {
    provider: VcsProviderKind.GitHub,
    providerRepositoryId: REPO_ID,
    fullName: "acme/demo",
  },
  evidence: {
    availability: RepositoryDefaultAvailability.Available,
    completeness: RepositoryDefaultCompleteness.Complete,
    defaultBranch,
  },
  provenance: {
    source: RepositoryDefaultSource.RepositoryRest,
    mechanism: GitHubFetchMechanism.Rest,
    trigger: GitHubFetchTrigger.SurfaceOpen,
    credentialType: GitHubFetchCredentialType.GitHubApp,
    observationKey: `observation-${observedAt}`,
    observedAt,
  },
});

test("PARITY: a first authority observation CREATEs, a newer one UPDATEs in place", async () => {
  const { db, recorded, close } = await open();
  try {
    const first = await writeRepositoryDefaultAuthorities(
      recorded.prisma,
      IDENTITY_KEY,
      [authorityObservation("main", OBSERVED_AT)]
    );
    assert.equal(
      first.accepted,
      1,
      "the observation must parse and be accepted"
    );
    assert.equal(
      recorded.callsFor("repositoryDefaultAuthority", "create").length,
      1
    );

    recorded.reset();
    const second = await writeRepositoryDefaultAuthorities(
      recorded.prisma,
      IDENTITY_KEY,
      [authorityObservation("trunk", LATER)]
    );
    assert.equal(second.accepted, 1);
    assert.equal(
      recorded.callsFor("repositoryDefaultAuthority", "create").length,
      0,
      "the second observation must take the UPDATE branch, not create"
    );

    const rows = await rowsOf<{ default_branch: string }>(
      db,
      "SELECT default_branch FROM repository_default_authorities"
    );
    assert.equal(rows.length, 1, "both writes target one compound-keyed row");
    assert.equal(rows[0].default_branch, "trunk");
  } finally {
    await close();
  }
});

test("NARROWING: both authority writes RETURNING only the compound identity", async () => {
  const { recorded, close } = await open();
  try {
    const key = {
      identityKey: true,
      provider: true,
      providerRepositoryId: true,
    } as const;

    await writeRepositoryDefaultAuthorities(recorded.prisma, IDENTITY_KEY, [
      authorityObservation("main", OBSERVED_AT),
    ]);
    assertNarrowedTo(
      recorded.only("repositoryDefaultAuthority", "create"),
      key,
      "authority create"
    );

    recorded.reset();
    await writeRepositoryDefaultAuthorities(recorded.prisma, IDENTITY_KEY, [
      authorityObservation("trunk", LATER),
    ]);
    assertNarrowedTo(
      recorded.only("repositoryDefaultAuthority", "update"),
      key,
      "authority update"
    );
  } finally {
    await close();
  }
});

/**
 * The regression guard for the refusal itself. `updateMany` would resolve
 * `{count: 0}` for a row that vanished between the `findUnique` and the write,
 * committing the reconcile as if it had applied. Assert the throwing verbs are
 * still the ones used, and that no batch verb crept in.
 */
test("PARITY: the authority reconcile refuses to batch the authority write", async () => {
  const { recorded, close } = await open();
  try {
    await writeRepositoryDefaultAuthorities(recorded.prisma, IDENTITY_KEY, [
      authorityObservation("main", OBSERVED_AT),
    ]);
    await writeRepositoryDefaultAuthorities(recorded.prisma, IDENTITY_KEY, [
      authorityObservation("trunk", LATER),
    ]);

    const verbs = recorded.calls
      .filter((c) => c.model === "repositoryDefaultAuthority")
      .map((c) => c.method);
    assert.deepEqual(
      verbs,
      ["create", "update"],
      "both writes must keep a verb that throws when the row is absent"
    );
  } finally {
    await close();
  }
});

// ───────────────────── sync-cursor-state (161) ─────────────────────

test("PARITY: sqliteAdvanceSyncState upserts the durable cursor", async () => {
  const { db, recorded, close } = await open();
  try {
    await sqliteAdvanceSyncState(recorded.prisma, SOURCE_KEY, {
      observedTopUpdatedAt: OBSERVED_AT,
      observedIdsAtTopUpdatedAt: [SESSION_ID],
      deadLetteredIds: [],
    });
    await sqliteAdvanceSyncState(recorded.prisma, SOURCE_KEY, {
      observedTopUpdatedAt: LATER,
      observedIdsAtTopUpdatedAt: [SESSION_ID],
      deadLetteredIds: [],
    });

    const rows = await rowsOf<{
      source_key: string;
      observed_top_updated_at: string;
    }>(db, "SELECT source_key, observed_top_updated_at FROM sync_state");
    assert.equal(rows.length, 1, "the cursor advances in place");
    assert.equal(rows[0].observed_top_updated_at, LATER);
  } finally {
    await close();
  }
});

test("NARROWING: sqliteAdvanceSyncState RETURNINGs only the source key", async () => {
  const { recorded, close } = await open();
  try {
    await sqliteAdvanceSyncState(recorded.prisma, SOURCE_KEY, {
      observedTopUpdatedAt: OBSERVED_AT,
      observedIdsAtTopUpdatedAt: [],
      deadLetteredIds: [],
    });

    assertNarrowedTo(
      recorded.only("syncState", "upsert"),
      { sourceKey: true },
      "sqliteAdvanceSyncState"
    );
  } finally {
    await close();
  }
});

// ───────────── sync-outbox-store (149 retry, 210 dead-letter) ─────────────

const OUTBOX_KEY = { sourceKey: true, externalSessionId: true } as const;

/**
 * Both outbox writes are `upsert` precisely BECAUSE a missing row must not
 * throw — their docstrings say so ("an upsert keeps this robust to a missing
 * row … without throwing"). So the parity contract here is the create branch,
 * and narrowing must not disturb which branch runs.
 */
test("PARITY: recordOutboxRetry creates a pending row when none exists, then updates it", async () => {
  const { db, recorded, close } = await open();
  try {
    await sqliteRecordOutboxRetry(
      recorded.prisma,
      SOURCE_KEY,
      SESSION_ID,
      1,
      LATER,
      "transient"
    );
    await sqliteRecordOutboxRetry(
      recorded.prisma,
      SOURCE_KEY,
      SESSION_ID,
      2,
      LATER,
      "transient again"
    );

    const rows = await rowsOf<{ status: string; attempt_count: number }>(
      db,
      "SELECT status, attempt_count FROM agent_session_sync_outbox"
    );
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].attempt_count), 2);
  } finally {
    await close();
  }
});

test("PARITY: markOutboxDeadLettered stamps the dead-letter status and burned attempts", async () => {
  const { db, recorded, close } = await open();
  try {
    await sqliteMarkOutboxDeadLettered(
      recorded.prisma,
      SOURCE_KEY,
      SESSION_ID,
      "exhausted",
      4
    );

    const rows = await rowsOf<{ status: string; attempt_count: number }>(
      db,
      "SELECT status, attempt_count FROM agent_session_sync_outbox"
    );
    assert.equal(rows.length, 1, "an absent row is CREATED, never thrown on");
    assert.equal(Number(rows[0].attempt_count), 4);
  } finally {
    await close();
  }
});

test("NARROWING: both outbox writes RETURNING only the compound identity", async () => {
  const { recorded, close } = await open();
  try {
    await sqliteRecordOutboxRetry(
      recorded.prisma,
      SOURCE_KEY,
      SESSION_ID,
      1,
      LATER,
      "transient"
    );
    assertNarrowedTo(
      recorded.only("agentSessionSyncOutbox", "upsert"),
      OUTBOX_KEY,
      "recordOutboxRetry"
    );

    recorded.reset();
    await sqliteMarkOutboxDeadLettered(
      recorded.prisma,
      SOURCE_KEY,
      SESSION_ID,
      "exhausted",
      4
    );
    assertNarrowedTo(
      recorded.only("agentSessionSyncOutbox", "upsert"),
      OUTBOX_KEY,
      "markOutboxDeadLettered"
    );
  } finally {
    await close();
  }
});

// ───────────────────── activity-metrics (329) ─────────────────────

/**
 * A minimal segments+analytics seed. Deliberately NOT shared with
 * `activity-metrics.test.ts`: that suite runs on the heavier
 * `openSqliteAgentDatabase` boot harness (it exercises the boot backfill),
 * while this one only needs the three rows `computeActivityMetricsRow` reads
 * before it writes.
 */
async function seedSessionWithSegment(
  db: Awaited<ReturnType<typeof openTestPrisma>>["db"]
): Promise<void> {
  await db.query(
    `INSERT INTO sessions (id, name, status, started_at, updated_at, last_activity_at, harness)
     VALUES ($1, $1, 'inactive', $2, $2, $2, 'claude')`,
    [SESSION_ID, OBSERVED_AT]
  );
  await db.query(
    `INSERT INTO session_analytics
       (session_id, harness, human_turns, agent_turns, runtime_ms, started_day, is_human, event_count, updated_at)
     VALUES ($1, 'claude', 2, 8, 60000, '2026-08-11', 0, 0, $2)`,
    [SESSION_ID, OBSERVED_AT]
  );
  await db.query(
    `INSERT INTO session_activity_segments
       (id, session_id, phase, start_ms, end_ms, confidence, evidence_layers, version, work_item_ref, observed_at)
     VALUES ($1, $2, 'implementation', 0, 60000, 0.9, '[]', 4, NULL, $3)`,
    ["seg-1", SESSION_ID, OBSERVED_AT]
  );
}

test("PARITY: upsertActivityMetricsRollup writes the rollup row inside the caller's transaction", async () => {
  const { db, recorded, close } = await open();
  try {
    await seedSessionWithSegment(db);
    await recorded.prisma.write((client) =>
      client.$transaction((tx) =>
        upsertActivityMetricsRollup(tx, SESSION_ID, OBSERVED_AT)
      )
    );

    const rows = await rowsOf<{ session_id: string; segment_count: number }>(
      db,
      "SELECT session_id, segment_count FROM session_activity_metrics"
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].session_id, SESSION_ID);
    assert.equal(Number(rows[0].segment_count), 1);
  } finally {
    await close();
  }
});

test("NARROWING: upsertActivityMetricsRollup RETURNINGs only the session id", async () => {
  const { db, recorded, close } = await open();
  try {
    await seedSessionWithSegment(db);
    recorded.reset();
    await recorded.prisma.write((client) =>
      client.$transaction((tx) =>
        upsertActivityMetricsRollup(tx, SESSION_ID, OBSERVED_AT)
      )
    );

    assertNarrowedTo(
      recorded.only("sessionActivityMetrics", "upsert"),
      { sessionId: true },
      "upsertActivityMetricsRollup"
    );
  } finally {
    await close();
  }
});
