/**
 * ISS-6119: a hydration whose caller provably discards the
 * `OMITTED_METADATA_KEYS` metadata keys reads `sessions.metadata` WITHOUT them,
 * stripped in SQL before the driver materializes the column.
 *
 * `tokenSeries` — the sole member of that set — is 52.5% of the real 2.1 GB
 * snapshot's 132.7 MB of `sessions.metadata` (69.6 MB), and 2.59 MB of the
 * heaviest single session's 2.83 MB. Parsing it into an object graph so that
 * `compactMetadataForPreview` can drop it again was the largest wasted metadata
 * term on the hydration path.
 *
 * The bar this file exists to clear is PARITY, not the heap number: a streamed
 * or narrowed read that silently drops content looks exactly like a large memory
 * win. So the assertions drive the real SQLite -> `loadSyncedSessions` boundary,
 * load the SAME rows twice (once each way), and compare the artifact each opted-in
 * caller actually consumes:
 *
 *   - the cloud-sync drain consumes `sanitizeSessionForSync(session)`;
 *   - the list/analytics folds consume every field EXCEPT `metadata` (they read
 *     `metadata.messages` only through the assembled trace fields, which are
 *     compared here as part of the whole object).
 *
 * Boundary rows are seeded deliberately: `json_remove` RAISES on malformed JSON
 * rather than returning NULL, so a corrupt or absent blob must reach the
 * `json_valid` guard and pass through untouched instead of aborting the read for
 * every session in the chunk.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  compactMetadataForPreview,
  MAX_METADATA_KEYS,
  OMITTED_METADATA_KEYS,
} from "@repo/lib/agent-sessions/metadata-preview";
import { sanitizeSessionForSync } from "../src/main/agent-sync/agent-session-sync-payload.js";
import { sessionMetadataSelectExpression } from "../src/main/database/session-metadata-projection.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { loadSyncedSessionHydrationCosts } from "../src/main/database/synced-session-hydration-plan.js";
import { mapListItem } from "../src/main/session/shared-agent-sessions-api.js";

function emptyAttributionCache() {
  return {
    attributionByCwd: new Map(),
    launchMetadataRootByCwd: new Map(),
    repoFullNameByPath: new Map(),
  };
}

/** The shape the opted-in callers use: sync drain / list fold. */
const NARROWED = {
  omitEventData: true,
  includeComponentUsage: true,
  omitPreviewStrippedMetadata: true,
};
const FULL = { omitEventData: true, includeComponentUsage: true };

/**
 * A metadata blob whose dropped key dwarfs everything the preview keeps — the
 * real corpus's shape, so a read that failed to strip it is visible by size as
 * well as by identity.
 */
function metadataBlob(messageCount: number): string {
  return JSON.stringify({
    slug: "iss-6119",
    gitBranch: "fix/iss-6119",
    messages: Array.from({ length: messageCount }, (_, index) => ({
      role: index % 2 === 0 ? "human" : "assistant",
      timestamp: `2026-07-10T0${index % 6}:0${index % 6}:00.000Z`,
      model: "model-a",
      text: `turn ${index} ${"y".repeat(64)}`,
    })),
    // Numbers and a deep nested object: `json_remove` re-serializes, so these
    // pin that it preserves number literals and structure verbatim.
    usageExtras: {
      web_search_requests: 3,
      ratio: 1.5,
      big: 12_345_678_901_234,
    },
    tokenSeries: Array.from({ length: 400 }, (_, index) => ({
      timestamp: `2026-07-10T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
      model: "model-a",
      inputTokens: index,
      outputTokens: index * 2,
      padding: "z".repeat(256),
    })),
  });
}

function metadataAtKeyCap(): string {
  const entries: [string, unknown][] = Array.from(
    { length: MAX_METADATA_KEYS + 1 },
    (_, index) => [`key${index}`, index]
  );
  entries[40] = ["tokenSeries", [{ inputTokens: 1 }]];
  return JSON.stringify(Object.fromEntries(entries));
}

async function seedSession(
  db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>,
  id: string,
  metadata: string | null,
  relationCount: number
) {
  await db.run(
    `INSERT INTO sessions (id, status, started_at, updated_at, ended_at, metadata)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    "inactive",
    "2026-07-10T00:00:00.000Z",
    "2026-07-10T06:00:00.000Z",
    "2026-07-10T05:00:00.000Z",
    metadata
  );
  for (let index = 0; index < relationCount; index++) {
    await db.run(
      `INSERT INTO events (id, session_id, event_type, created_at, data)
       VALUES (?, ?, ?, ?, ?)`,
      `${id}-evt-${index}`,
      id,
      "PostToolUse",
      `2026-07-10T0${index % 6}:10:00.000Z`,
      JSON.stringify({ payload: "p".repeat(128) })
    );
    await db.run(
      `INSERT INTO token_events
         (session_id, model, created_at, input_tokens, output_tokens, cost_usd_estimated, cost_summary)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      `model-${index}`,
      `2026-07-10T0${index % 6}:20:00.000Z`,
      100 + index,
      200 + index,
      0.25,
      JSON.stringify({
        completeness: "partial",
        reason: "legacy_record",
        subtotalUsd: 0.25,
        lanes: [{ basis: "api_estimated", subtotalUsd: 0.25 }],
      })
    );
  }
}

async function withSeededDb<T>(
  run: (db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>) => Promise<T>
): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss6119-metadata-"));
  try {
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.pgdata"),
      detectBillingMode: () => "metered_api",
      now: () => "2026-07-10T06:00:00.000Z",
    });
    try {
      // Zero / one / many relations, plus the two blobs `json_remove` cannot
      // narrow (NULL and malformed) and one that never carried the dropped key.
      await seedSession(db, "many", metadataBlob(40), 6);
      await seedSession(db, "one", metadataBlob(1), 1);
      await seedSession(db, "none", metadataBlob(0), 0);
      await seedSession(db, "null-metadata", null, 1);
      await seedSession(db, "malformed-metadata", "{not json", 1);
      await seedSession(
        db,
        "no-dropped-key",
        JSON.stringify({ slug: "plain", messages: [] }),
        1
      );
      await seedSession(db, "key-cap", metadataAtKeyCap(), 0);
      return await run(db);
    } finally {
      await db.close?.();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The two halves of the opted-in projection the expression test pins. */
const JSON_VALID_GUARD = /json_valid\(metadata\)/;
const JSON_REPLACE_CALL = /json_replace\(metadata, '\$\.tokenSeries', 0\)/;
/** Any metadata projection, used to pin that the SIZING read grew none. */
const JSON_REPLACE_ANY = /json_replace\(/;
const SIZING_BARE_METADATA_SQL = /LENGTH\(CAST\(s\.metadata AS BLOB\)\)/;

const ALL_IDS = [
  "many",
  "one",
  "none",
  "null-metadata",
  "malformed-metadata",
  "no-dropped-key",
];

test("ISS-6119: the narrowed hydration strips exactly the omitted key values", async () => {
  await withSeededDb(async (db) => {
    const [full] = await db.syncSource.loadSyncedSessions(
      ["many"],
      emptyAttributionCache(),
      FULL
    );
    const [narrow] = await db.syncSource.loadSyncedSessions(
      ["many"],
      emptyAttributionCache(),
      NARROWED
    );
    assert.ok(full && narrow, "both reads hydrated the session");

    const fullMetadata = full.metadata as Record<string, unknown>;
    const narrowMetadata = narrow.metadata as Record<string, unknown>;
    for (const key of OMITTED_METADATA_KEYS) {
      assert.ok(
        key in fullMetadata,
        `the un-narrowed read still materializes ${key}`
      );
      assert.equal(
        narrowMetadata[key],
        0,
        `the narrowed read never materializes ${key}'s payload`
      );
    }

    // Everything else survives byte-for-byte. This is the assertion that fails
    // if the SQL projection ever removes more than it was asked to.
    const expected = { ...fullMetadata };
    for (const key of OMITTED_METADATA_KEYS) {
      expected[key] = 0;
    }
    assert.deepEqual(
      narrowMetadata,
      expected,
      "outside the dropped keys the narrowed metadata is identical"
    );
  });
});

test("ISS-6119: stripping a key does not pull the 81st key into the preview", async () => {
  await withSeededDb(async (db) => {
    const [full] = await db.syncSource.loadSyncedSessions(
      ["key-cap"],
      emptyAttributionCache(),
      FULL
    );
    const [narrow] = await db.syncSource.loadSyncedSessions(
      ["key-cap"],
      emptyAttributionCache(),
      NARROWED
    );
    assert.ok(full && narrow, "both key-cap reads hydrated the session");
    const fullPreview = compactMetadataForPreview(full.metadata);
    const narrowPreview = compactMetadataForPreview(narrow.metadata);
    assert.deepEqual(narrowPreview, fullPreview);
    assert.ok(fullPreview && !("key80" in fullPreview));
  });
});

test("ISS-6119: the cloud-sync payload is byte-identical across both arms", async () => {
  await withSeededDb(async (db) => {
    const full = await db.syncSource.loadSyncedSessions(
      ALL_IDS,
      emptyAttributionCache(),
      FULL
    );
    const narrow = await db.syncSource.loadSyncedSessions(
      ALL_IDS,
      emptyAttributionCache(),
      NARROWED
    );
    assert.equal(
      narrow.length,
      full.length,
      "the narrowed read returns every session the full read did"
    );
    assert.equal(full.length, ALL_IDS.length, "every seeded session hydrated");

    // The payload — not the hydration — is what the sync drain ships, and it is
    // the artifact whose equivalence the revert of the previous attempt at this
    // seam turned on.
    for (const [index, fullSession] of full.entries()) {
      const narrowSession = narrow[index];
      assert.equal(
        narrowSession.externalSessionId,
        fullSession.externalSessionId,
        "order is preserved"
      );
      assert.deepEqual(
        JSON.parse(JSON.stringify(sanitizeSessionForSync(narrowSession))),
        JSON.parse(JSON.stringify(sanitizeSessionForSync(fullSession))),
        `the synced payload for ${fullSession.externalSessionId} is unchanged`
      );
    }
  });
});

test("ISS-6119: every field the list fold reads is identical across both arms", async () => {
  await withSeededDb(async (db) => {
    const full = await db.syncSource.loadSyncedSessions(
      ALL_IDS,
      emptyAttributionCache(),
      FULL
    );
    const narrow = await db.syncSource.loadSyncedSessions(
      ALL_IDS,
      emptyAttributionCache(),
      NARROWED
    );
    for (const [index, fullSession] of full.entries()) {
      // `metadata` is the ONE field allowed to differ; the trace/timeline fields
      // assembled FROM `metadata.messages` are compared with everything else, so
      // a strip that reached `messages` fails here.
      assert.deepEqual(
        withoutMetadata(narrow[index]),
        withoutMetadata(fullSession),
        `${fullSession.externalSessionId}: the list-visible projection is unchanged`
      );
    }
  });
});

test("ISS-6119: the rendered list row is identical across both arms", async () => {
  await withSeededDb(async (db) => {
    // The test above compares the hydrated fields; this one runs the actual
    // production fold over them. That distinction is the whole risk: if
    // `mapListItem` (or anything it calls) ever starts reading a dropped key,
    // a field-level comparison that excludes `metadata` stays green while the
    // RENDERED row moves.
    const full = await db.syncSource.loadSyncedSessions(
      ALL_IDS,
      emptyAttributionCache(),
      FULL
    );
    const narrow = await db.syncSource.loadSyncedSessions(
      ALL_IDS,
      emptyAttributionCache(),
      NARROWED
    );
    for (const [index, fullSession] of full.entries()) {
      assert.deepEqual(
        mapListItem(narrow[index]),
        mapListItem(fullSession),
        `${fullSession.externalSessionId}: the rendered list row is unchanged`
      );
    }
  });
});

test("ISS-6119: a NULL or malformed metadata blob passes through instead of aborting the read", async () => {
  await withSeededDb(async (db) => {
    // `json_replace` raises on malformed JSON. Without the `json_valid` guard this
    // read throws and takes every session in the chunk with it, so the assertion
    // is that the WHOLE chunk still hydrates and the two rows keep their values.
    const narrow = await db.syncSource.loadSyncedSessions(
      ["null-metadata", "malformed-metadata", "many"],
      emptyAttributionCache(),
      NARROWED
    );
    assert.equal(narrow.length, 3, "the corrupt rows did not abort the chunk");
    const byId = new Map(narrow.map((s) => [s.externalSessionId, s]));
    assert.equal(
      byId.get("null-metadata")?.metadata ?? null,
      null,
      "a NULL blob stays null"
    );
    assert.equal(
      byId.get("malformed-metadata")?.metadata ?? null,
      null,
      "a malformed blob still parses to null, exactly as the un-narrowed read leaves it"
    );
    assert.ok(
      byId.get("many")?.metadata,
      "the healthy session in the same chunk still hydrated"
    );
  });
});

test("ISS-6119: the oversized-session probe sizes the same payload it always did", async () => {
  await withSeededDb(async (db) => {
    // The probe decides whether a session is dead-lettered as locally oversized,
    // so a narrowing that moved its byte estimate would change WHICH sessions
    // sync at all. It now reads the narrowed column; the estimate must not move,
    // because its own `sanitizeSessionForSync` step already dropped those keys.
    // A cap of 1 byte makes every session oversized, so the assertion is on the
    // reported `payloadBytes` rather than on an empty list.
    const probe = db.syncSource.findLocallyOversizedSessions;
    assert.ok(probe, "the sync source exposes the oversized probe");
    const oversized = await probe(ALL_IDS, 1);
    assert.equal(
      oversized.length,
      ALL_IDS.length,
      "a 1-byte cap reports every seeded session, so every estimate is observable"
    );
    for (const entry of oversized) {
      assert.ok(
        entry.payloadBytes > 1,
        `${entry.id}: the probe reports a real byte estimate`
      );
    }
    // The heavy session's dropped key is ~10x everything else in its blob; if the
    // probe were sizing the RAW row its estimate would dwarf the compacted one.
    const many = oversized.find((entry) => entry.id === "many");
    const none = oversized.find((entry) => entry.id === "none");
    assert.ok(many && none, "both cohorts were probed");
    assert.ok(
      many.payloadBytes < none.payloadBytes * 20,
      "the estimate tracks the COMPACTED payload, not the raw metadata blob"
    );
  });
});

test("ISS-6119: the detail/branch-trace shape keeps the full blob", async () => {
  await withSeededDb(async (db) => {
    // The option is opt-in. A caller that does not pass it — the session detail
    // and the branch merged trace, which hand the blob to the renderer — must
    // still see every key.
    const [detail] = await db.syncSource.loadSyncedSessions(
      ["many"],
      emptyAttributionCache()
    );
    assert.ok(detail?.metadata, "the detail shape hydrated metadata");
    for (const key of OMITTED_METADATA_KEYS) {
      assert.ok(
        key in (detail.metadata as Record<string, unknown>),
        `the default shape still carries ${key}`
      );
    }
  });
});

test("ISS-6119: the SIZING read never pays for the narrowing it does not benefit from", async () => {
  // Measured on the real 2,972-session corpus: applying this projection to the
  // sizing read costs 283ms against 93ms — ~190ms of extra SYNCHRONOUS db-host
  // CPU per sweep — to compute bytes that are thrown away once a chunk boundary
  // is picked. The bare column over-estimates instead, which can only make a
  // chunk smaller. This pins the decision so the cost cannot come back silently.
  const statements: string[] = [];
  const reader = {
    read: (
      fn: (client: {
        $queryRawUnsafe: (sql: string) => Promise<unknown[]>;
      }) => unknown
    ) =>
      fn({
        $queryRawUnsafe: (sql: string) => {
          statements.push(sql);
          return Promise.resolve([]);
        },
      }),
  } as unknown as Parameters<typeof loadSyncedSessionHydrationCosts>[0];

  await loadSyncedSessionHydrationCosts(reader, ["s"], {
    omitEventData: true,
    omitTokenEventCostColumns: true,
  });
  assert.equal(statements.length, 1, "the sizing read is one statement");
  assert.ok(
    !JSON_REPLACE_ANY.test(statements[0]),
    "the sizing read does not re-parse metadata it only measures"
  );
  assert.ok(
    SIZING_BARE_METADATA_SQL.test(statements[0]),
    "it sizes the bare stored column, accepting the documented over-estimate"
  );
});

test("ISS-6119: the SQL projection is opt-in and degrades to the bare column", () => {
  assert.equal(
    sessionMetadataSelectExpression(false),
    "metadata",
    "off is the bare column — the read is byte-for-byte what it was"
  );
  const on = sessionMetadataSelectExpression(true);
  assert.match(on, JSON_VALID_GUARD, "the malformed-JSON guard is present");
  assert.match(on, JSON_REPLACE_CALL);
  assert.equal(
    sessionMetadataSelectExpression(true, "s.metadata", ["ok", "not ok"]),
    "s.metadata",
    "a key that is not a plain identifier degrades to no strip, never a malformed path"
  );
  assert.equal(
    sessionMetadataSelectExpression(true, "s.metadata", []),
    "s.metadata",
    "an empty key set is a no-op projection"
  );
});

/** The one field the narrowed read is allowed to change. */
function withoutMetadata(session: Record<string, unknown>): unknown {
  const { metadata, ...rest } = session;
  return rest;
}
