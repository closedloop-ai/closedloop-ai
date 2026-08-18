import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import {
  TokenCostBasis,
  TokenCostCompleteness,
  TokenCostCompletenessReason,
  TokenSourceIdentityAvailability,
  TokenSourceIdentityUnavailableReason,
} from "@repo/api/src/types/token-cost-provenance";
import { claudeTranscriptEntryUuidScheme } from "@repo/lib/harness/usage-dedup";
import { compareMigrationDirNames } from "../scripts/migration-order.mjs";
import {
  HistoricalParseWorkerResponseType,
  historicalParseWorkerResponseSchema,
} from "../src/main/collectors/engine/historical-parse-worker-protocol.js";
import {
  Harness,
  type NormalizedTokenRecord,
} from "../src/main/collectors/types.js";
import { openMigrationDatabase } from "../src/main/database/migration/migration-executor.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import {
  appendTokenEvents,
  isLocallyDerivedStoredTokenCostSummary,
  parseStoredTokenCostSummary,
  replaceTokenEvents,
  serializeTokenEventCostSummary,
} from "../src/main/database/token-event-contract.js";
import { mapSyncedTokenEvent } from "../src/main/database/token-event-sync.js";
import { emptyAttributionCache } from "./attribution-test-helpers.js";
import { makeSession } from "./normalized-session-test-utils.js";

const NOW = "2026-08-02T07:00:00.000Z";
const EVENT_AT = "2026-08-02T06:59:00.000Z";
const APP_DIR = path.join(import.meta.dirname, "..");
const MIGRATIONS_DIR = path.join(APP_DIR, "prisma", "migrations");
const PROVENANCE_MIGRATION = "0043_iss4881_token_event_provenance";
const TRANSPORT_IDENTITY_COLLISION_PATTERN = /transport identity collision/;
const TRANSPORT_IDENTITY_DIGEST_PATTERN = /digest=/;
const UNIQUE_CONSTRAINT_PATTERN = /UNIQUE constraint failed/;

type Db = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

test("local unavailable cost evidence is tagged without changing its parsed contract", () => {
  const localStored = serializeTokenEventCostSummary(
    legacyTokenRecord(),
    undefined
  );
  assert.equal(isLocallyDerivedStoredTokenCostSummary(localStored), true);
  assert.deepEqual(parseStoredTokenCostSummary(localStored), {
    completeness: TokenCostCompleteness.Unavailable,
    reason: TokenCostCompletenessReason.LegacyRecord,
  });

  const producerSummary = {
    completeness: TokenCostCompleteness.Unavailable,
    reason: TokenCostCompletenessReason.SourceIdentityUnavailable,
  } as const;
  const producerStored = serializeTokenEventCostSummary(
    { ...legacyTokenRecord(), costSummary: producerSummary },
    undefined
  );
  assert.equal(isLocallyDerivedStoredTokenCostSummary(producerStored), false);
  assert.deepEqual(
    parseStoredTokenCostSummary(producerStored),
    producerSummary
  );
});

test("normalized token provenance round-trips through SQLite and sync without collapsing equal content", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "token-provenance-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "api",
    now: () => NOW,
  });
  const records = [
    explicitTokenRecord("transport-a"),
    explicitTokenRecord("transport-b"),
  ];
  try {
    const session = makeSession({
      sessionId: "token-provenance-session",
      model: "claude-opus-4-5",
      startedAt: "2026-08-02T06:58:00.000Z",
      tokensByModel: {
        "claude-opus-4-5": {
          input: 20,
          output: 10,
          cacheRead: 0,
          cacheWrite: 0,
        },
      },
      tokenSeries: records,
    });

    const workerResponse = historicalParseWorkerResponseSchema.parse({
      type: HistoricalParseWorkerResponseType.Parsed,
      requestId: "iss-4881-round-trip",
      sessions: [session],
    });
    if (workerResponse.type !== HistoricalParseWorkerResponseType.Parsed) {
      throw new Error("expected a parsed historical worker response");
    }
    const workerSession = workerResponse.sessions[0];
    assert.ok(workerSession);

    await db.importer.importSession(workerSession, Harness.Claude);
    const firstRows = await readPersistedTokenRows(db);
    assert.deepEqual(
      firstRows.map((row) => row.transport_id),
      ["transport-a", "transport-b"]
    );
    assert.equal(firstRows[0]?.source_identity, firstRows[1]?.source_identity);
    assert.equal(firstRows[0]?.cost_summary, firstRows[1]?.cost_summary);

    const [synced] = await db.syncSource.loadSyncedSessions(
      [workerSession.sessionId],
      emptyAttributionCache()
    );
    assert.deepEqual(
      synced?.tokenEvents?.map((event) => event.externalEventId),
      ["transport-a", "transport-b"]
    );
    assert.deepEqual(synced?.tokenEvents?.[0]?.sourceIdentity, {
      availability: TokenSourceIdentityAvailability.Available,
      scheme: "synthetic-provider-neutral-v1",
      sourceRecordIds: ["record-2", "record-1"],
    });
    assert.deepEqual(synced?.tokenEvents?.[0]?.costSummary, {
      completeness: TokenCostCompleteness.Partial,
      reason: TokenCostCompletenessReason.ClassificationIncomplete,
      subtotalUsd: 0,
      lanes: [
        {
          basis: TokenCostBasis.SubscriptionEquivalent,
          subtotalUsd: 0,
        },
        { basis: TokenCostBasis.ApiEstimated, subtotalUsd: 0 },
      ],
    });

    await db.importer.importSession(workerSession, Harness.Claude);
    assert.deepEqual(await readPersistedTokenRows(db), firstRows);

    await assert.rejects(
      db.prisma.write((tx) =>
        replaceTokenEvents(tx, workerSession.sessionId, [
          { ...records[0], output: 6 },
          records[1],
        ])
      ),
      TRANSPORT_IDENTITY_COLLISION_PATTERN
    );

    const replayed = await db.prisma.write((tx) =>
      appendTokenEvents(tx, workerSession.sessionId, records)
    );
    assert.deepEqual(replayed, []);
    await assert.rejects(
      db.prisma.write((tx) =>
        appendTokenEvents(tx, workerSession.sessionId, [
          { ...records[0], output: 6 },
          records[1],
        ])
      ),
      TRANSPORT_IDENTITY_COLLISION_PATTERN
    );
    await assert.rejects(
      db.prisma.write((tx) =>
        appendTokenEvents(tx, workerSession.sessionId, [
          {
            ...records[0],
            sourceIdentity: {
              availability: TokenSourceIdentityAvailability.Available,
              scheme: "synthetic-provider-neutral-v1",
              sourceRecordIds: ["different-source-record"],
            },
          },
          records[1],
        ])
      ),
      TRANSPORT_IDENTITY_COLLISION_PATTERN
    );

    const equalHwmExtension = {
      ...records[1],
      sourceIdentity: {
        availability: TokenSourceIdentityAvailability.Available,
        scheme: "synthetic-provider-neutral-v1",
        sourceRecordIds: ["record-2", "record-1", "record-3"],
      },
    } satisfies NormalizedTokenRecord;
    assert.deepEqual(
      await db.prisma.write((tx) =>
        appendTokenEvents(tx, workerSession.sessionId, [equalHwmExtension])
      ),
      []
    );
    assert.deepEqual(
      JSON.parse(
        (await readPersistedTokenRows(db)).find(
          (row) => row.transport_id === "transport-b"
        )?.source_identity ?? "null"
      ),
      equalHwmExtension.sourceIdentity
    );

    const [newerRecord] = await db.prisma.write((tx) =>
      appendTokenEvents(tx, workerSession.sessionId, [
        {
          ...records[0],
          timestamp: "2026-08-02T06:59:30.000Z",
          transportId: "transport-newer",
        },
      ])
    );
    assert.equal(newerRecord?.transportId, "transport-newer");
    assert.deepEqual(
      await db.prisma.write((tx) =>
        appendTokenEvents(tx, workerSession.sessionId, [records[0]])
      ),
      []
    );
    await assert.rejects(
      db.prisma.write((tx) =>
        appendTokenEvents(tx, workerSession.sessionId, [
          { ...records[0], output: 6 },
        ])
      ),
      TRANSPORT_IDENTITY_COLLISION_PATTERN
    );
    const olderExplicitExtension = {
      ...records[0],
      sourceIdentity: {
        availability: TokenSourceIdentityAvailability.Available,
        scheme: "synthetic-provider-neutral-v1",
        sourceRecordIds: ["record-2", "record-1", "record-4"],
      },
    } satisfies NormalizedTokenRecord;
    assert.deepEqual(
      await db.prisma.write((tx) =>
        appendTokenEvents(tx, workerSession.sessionId, [olderExplicitExtension])
      ),
      []
    );
    assert.deepEqual(
      JSON.parse(
        (await readPersistedTokenRows(db)).find(
          (row) => row.transport_id === "transport-a"
        )?.source_identity ?? "null"
      ),
      olderExplicitExtension.sourceIdentity
    );

    const diagnosticTransportId = `diagnostic-${"x".repeat(256)}`;
    await assert.rejects(
      db.prisma.write((tx) =>
        appendTokenEvents(tx, workerSession.sessionId, [
          { ...records[0], transportId: diagnosticTransportId },
          { ...records[0], transportId: diagnosticTransportId },
        ])
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, TRANSPORT_IDENTITY_DIGEST_PATTERN);
        assert.equal(error.message.includes(diagnosticTransportId), false);
        return true;
      }
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("new legacy-shaped rows degrade to typed source unavailability and partial priced cost", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "token-legacy-new-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "subscription",
    now: () => NOW,
  });
  try {
    const record = legacyTokenRecord();
    await db.importer.importSession(
      makeSession({
        sessionId: "new-legacy-session",
        model: record.model,
        startedAt: "2026-08-02T06:58:00.000Z",
        tokensByModel: {
          [record.model]: {
            input: record.input * 2,
            output: record.output * 2,
            cacheRead: record.cacheRead,
            cacheWrite: record.cacheWrite,
          },
        },
        tokenSeries: [record, { ...record }],
      }),
      Harness.Claude
    );

    const [synced] = await db.syncSource.loadSyncedSessions(
      ["new-legacy-session"],
      emptyAttributionCache()
    );
    const tokenEvents = synced?.tokenEvents ?? [];
    assert.equal(tokenEvents.length, 2);
    assert.equal(
      new Set(tokenEvents.map((event) => event.externalEventId)).size,
      2
    );
    const event = tokenEvents[0];
    assert.ok(event?.externalEventId.startsWith("token-event-"));
    assert.deepEqual(event?.sourceIdentity, {
      availability: TokenSourceIdentityAvailability.Unavailable,
      reason: TokenSourceIdentityUnavailableReason.LegacyRecord,
    });
    assert.equal(
      event?.costSummary?.completeness,
      TokenCostCompleteness.Partial
    );
    assert.equal(
      event?.costSummary?.reason,
      TokenCostCompletenessReason.LegacyRecord
    );
    assert.equal(event?.costSummary?.subtotalUsd, event?.estimatedCostUsd);
    assert.deepEqual(event?.costSummary?.lanes, [
      {
        basis: TokenCostBasis.ApiEstimated,
        subtotalUsd: event?.estimatedCostUsd,
      },
    ]);
    const firstIds = tokenEvents.map(
      (tokenEvent) => tokenEvent.externalEventId
    );
    const provenanceUpgradeReplay = await db.prisma.write((tx) =>
      appendTokenEvents(tx, "new-legacy-session", [
        {
          ...record,
          sourceIdentity: {
            availability: TokenSourceIdentityAvailability.Available,
            scheme: claudeTranscriptEntryUuidScheme,
            sourceRecordIds: ["00000000-0000-4000-8000-000000000001"],
          },
        },
      ])
    );
    assert.deepEqual(provenanceUpgradeReplay, []);
    await db.importer.importSession(
      makeSession({
        sessionId: "new-legacy-session",
        model: record.model,
        startedAt: "2026-08-02T06:58:00.000Z",
        tokensByModel: {
          [record.model]: {
            input: record.input * 2,
            output: record.output * 2,
            cacheRead: record.cacheRead,
            cacheWrite: record.cacheWrite,
          },
        },
        tokenSeries: [record, { ...record }],
      }),
      Harness.Claude
    );
    const [replayed] = await db.syncSource.loadSyncedSessions(
      ["new-legacy-session"],
      emptyAttributionCache()
    );
    assert.deepEqual(
      replayed?.tokenEvents?.map((tokenEvent) => tokenEvent.externalEventId),
      firstIds
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("unpriced new legacy-shaped rows keep cost unavailable without a fabricated subtotal", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "token-unpriced-legacy-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "api",
    now: () => NOW,
  });
  try {
    const record = legacyTokenRecord();
    await db.importer.importSession(
      makeSession({
        sessionId: "unpriced-legacy-session",
        model: record.model,
        startedAt: "2026-08-02T06:58:00.000Z",
        tokensByModel: {},
        tokenSeries: [],
      }),
      Harness.Claude
    );
    await db.prisma.write((tx) =>
      replaceTokenEvents(tx, "unpriced-legacy-session", [record])
    );

    const [synced] = await db.syncSource.loadSyncedSessions(
      ["unpriced-legacy-session"],
      emptyAttributionCache()
    );
    const event = synced?.tokenEvents?.[0];
    assert.equal("estimatedCostUsd" in (event ?? {}), false);
    assert.deepEqual(event?.costSummary, {
      completeness: TokenCostCompleteness.Unavailable,
      reason: TokenCostCompletenessReason.LegacyRecord,
    });
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("sync omits absent legacy fields and degrades malformed or unknown stored shapes", () => {
  const legacy = mapSyncedTokenEvent("legacy-session", sqliteTokenRow());
  const replay = mapSyncedTokenEvent("legacy-session", sqliteTokenRow());
  assert.equal(legacy.externalEventId, replay.externalEventId);
  assert.equal("sourceIdentity" in legacy, false);
  assert.equal("costSummary" in legacy, false);

  const degraded = mapSyncedTokenEvent(
    "malformed-session",
    sqliteTokenRow({
      transport_id: "transport-malformed",
      source_identity: "{broken-json",
      cost_summary: JSON.stringify({ completeness: "future_state" }),
    })
  );
  assert.equal(degraded.externalEventId, "transport-malformed");
  assert.deepEqual(degraded.sourceIdentity, {
    availability: TokenSourceIdentityAvailability.Unavailable,
    reason: TokenSourceIdentityUnavailableReason.Malformed,
  });
  assert.deepEqual(degraded.costSummary, {
    completeness: TokenCostCompleteness.Unavailable,
    reason: TokenCostCompletenessReason.Unknown,
  });
});

test("0043 upgrades a legacy store without backfill and enforces non-null transport uniqueness", async () => {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "token-provenance-migration-")
  );
  const { db } = await openMigrationDatabase(path.join(dir, "legacy.sqlite"));
  try {
    const migrationNames = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(compareMigrationDirNames);
    for (const name of migrationNames) {
      if (name === PROVENANCE_MIGRATION) {
        break;
      }
      await db.exec(
        readFileSync(path.join(MIGRATIONS_DIR, name, "migration.sql"), "utf8")
      );
    }
    await db.query(
      `INSERT INTO sessions (id, status, harness, started_at, updated_at)
       VALUES ($1, $3, $4, $2, $2)`,
      ["legacy-session", NOW, SESSION_STATUS.INACTIVE, Harness.Claude]
    );
    await db.query(
      `INSERT INTO token_events
         (session_id, model, created_at, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens)
       VALUES ($1, 'legacy-model', $2, 1, 0, 0, 0)`,
      ["legacy-session", EVENT_AT]
    );
    await db.exec(
      readFileSync(
        path.join(MIGRATIONS_DIR, PROVENANCE_MIGRATION, "migration.sql"),
        "utf8"
      )
    );

    const upgraded = await db.query<{
      transport_id: string | null;
      source_identity: string | null;
      cost_summary: string | null;
    }>(
      `SELECT transport_id, source_identity, cost_summary
         FROM token_events
        WHERE session_id = $1`,
      ["legacy-session"]
    );
    assert.deepEqual(upgraded.rows, [
      { transport_id: null, source_identity: null, cost_summary: null },
    ]);
    await db.query(
      `INSERT INTO token_events
         (session_id, model, created_at, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens)
       VALUES ($1, 'legacy-model', $2, 1, 0, 0, 0)`,
      ["legacy-session", EVENT_AT]
    );
    await db.query(
      `INSERT INTO token_events
         (session_id, transport_id, model, created_at, input_tokens,
          output_tokens, cache_read_tokens, cache_write_tokens)
       VALUES ($1, 'transport-1', 'legacy-model', $2, 1, 0, 0, 0)`,
      ["legacy-session", EVENT_AT]
    );
    await assert.rejects(
      db.query(
        `INSERT INTO token_events
           (session_id, transport_id, model, created_at, input_tokens,
            output_tokens, cache_read_tokens, cache_write_tokens)
         VALUES ($1, 'transport-1', 'legacy-model', $2, 1, 0, 0, 0)`,
        ["legacy-session", EVENT_AT]
      ),
      UNIQUE_CONSTRAINT_PATTERN
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function explicitTokenRecord(transportId: string): NormalizedTokenRecord {
  return {
    ...legacyTokenRecord(),
    transportId,
    sourceIdentity: {
      availability: TokenSourceIdentityAvailability.Available,
      scheme: "synthetic-provider-neutral-v1",
      sourceRecordIds: ["record-2", "record-1"],
    },
    costSummary: {
      completeness: TokenCostCompleteness.Partial,
      reason: TokenCostCompletenessReason.ClassificationIncomplete,
      subtotalUsd: 0,
      lanes: [
        {
          basis: TokenCostBasis.SubscriptionEquivalent,
          subtotalUsd: 0,
        },
        { basis: TokenCostBasis.ApiEstimated, subtotalUsd: 0 },
      ],
    },
  };
}

function legacyTokenRecord(): NormalizedTokenRecord {
  return {
    timestamp: EVENT_AT,
    model: "claude-opus-4-5",
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
  };
}

function readPersistedTokenRows(db: Db) {
  return db.prisma.client.$queryRawUnsafe<
    {
      transport_id: string;
      source_identity: string;
      cost_summary: string;
    }[]
  >(
    `SELECT transport_id, source_identity, cost_summary
       FROM token_events
      WHERE session_id = $1
      ORDER BY transport_id ASC`,
    "token-provenance-session"
  );
}

function sqliteTokenRow(
  overrides: Partial<Parameters<typeof mapSyncedTokenEvent>[1]> = {}
): Parameters<typeof mapSyncedTokenEvent>[1] {
  return {
    session_id: "legacy-session",
    transport_id: null,
    model: "legacy-model",
    created_at: EVENT_AT,
    input_tokens: 1,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cache_write_5m_tokens: null,
    cache_write_1h_tokens: null,
    cost_usd_estimated: null,
    input_cost_usd_estimated: null,
    output_cost_usd_estimated: null,
    cache_read_cost_usd_estimated: null,
    cache_creation_cost_usd_estimated: null,
    source_identity: null,
    cost_summary: null,
    ...overrides,
  };
}
