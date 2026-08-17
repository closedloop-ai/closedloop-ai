/**
 * ISS-4601 unit coverage for the post-deploy INVALID-index sweep: the report
 * text, the honest "unknown" result when the sweep cannot run, and — the part a
 * pure-helper test would miss — that `applyMigrationsToSchema` actually calls the
 * sweep and puts its finding on the emitted `migrate_deploy` telemetry event.
 *
 * The end-to-end proof against a real Postgres (a genuinely invalid index forced
 * by a failed concurrent unique build) is
 * `__tests__/integration/invalid-index-sweep.integration.test.ts`.
 */

import { describe, expect, it, vi } from "vitest";
import type { SqlClient } from "../scripts/db-utils";
import {
  formatInvalidIndexReport,
  formatMigrateCompletionLine,
  INVALID_INDEX_SWEEP_SQL,
  type InvalidIndex,
  resolveSweepSchema,
  sweepInvalidIndexes,
} from "../scripts/invalid-index-sweep";
import {
  type MigrateDeployEvent,
  MigrateOutcome,
} from "../scripts/migrate-telemetry";
import {
  applyMigrationsToSchema,
  type MigrationPipelineDeps,
} from "../scripts/migration-pipeline";

const DB_URL = "postgresql://user:pw@db.example.com:5432/cl?sslmode=require";
const PREVIEW_SCHEMA = "preview_iss_4601_unit";

// `ready: false` — the FIRST build pass never finished. Verified against a real
// Postgres: a `CREATE UNIQUE INDEX CONCURRENTLY` over duplicate keys (the
// integration fixture) detects the duplicate during that first pass, so it is
// this state, not the ready=true one below.
const INVALID: InvalidIndex = {
  schema: "public",
  name: "session_detail_model_started_at_idx",
  table: "session_detail",
  ready: false,
  definition:
    "CREATE INDEX session_detail_model_started_at_idx ON public.session_detail USING btree (model, session_started_at)",
};

// `ready: true` — the other remnant state, and the one the module header is
// about: the first pass completed (indisready flipped true) and the build was
// then cancelled before its second/validation pass could set indisvalid.
// Verified against a real Postgres: a CIC parked in "waiting for old snapshots"
// reads ready=true, valid=false.
const INVALID_READY: InvalidIndex = {
  schema: "public",
  name: "session_transcript_identity_idx",
  table: "session_transcript",
  ready: true,
  definition:
    "CREATE INDEX session_transcript_identity_idx ON public.session_transcript USING btree (organization_id)",
};

function fakeClient(
  onQuery: (text: string, values?: unknown[]) => unknown
): SqlClient {
  return {
    connect: () => Promise.resolve(),
    query: (text, values) => Promise.resolve(onQuery(text, values)),
    end: () => Promise.resolve(),
  };
}

function makePipelineDeps(
  overrides: Partial<MigrationPipelineDeps> = {}
): Partial<MigrationPipelineDeps> {
  return {
    ensureSchemaExists: vi.fn(() => Promise.resolve(false)),
    upsertSchemaRegistry: vi.fn(() => Promise.resolve()),
    probePreviewSchemaAtHead: vi.fn(() => Promise.resolve(false)),
    withMigrationSerializeLock: vi.fn((_opts, fn) => fn()),
    prestampSkippableMigrationsViaSql: vi.fn(() => Promise.resolve()),
    plainBuildPreviewConcurrentIndexes: vi.fn(() => Promise.resolve()),
    runMigrate: vi.fn(() => Promise.resolve(false)),
    cloneDataFromPublic: vi.fn(() => Promise.resolve(true)),
    runPreviewSeed: vi.fn(),
    withRetry: vi.fn((fn: () => Promise<void>) => fn()),
    sweepInvalidIndexes: vi.fn(() => Promise.resolve([])),
    ...overrides,
  };
}

describe("sweepInvalidIndexes (ISS-4601)", () => {
  it("targets the given schema and returns the invalid indexes it finds", async () => {
    const seen: { text: string; values?: unknown[] }[] = [];
    const found = await sweepInvalidIndexes(DB_URL, PREVIEW_SCHEMA, {
      createClient: () =>
        fakeClient((text, values) => {
          seen.push({ text, values });
          return { rows: [INVALID] };
        }),
      logger: { warn: () => undefined },
    });

    expect(found).toEqual([INVALID]);
    const sweepQuery = seen.find((q) => q.text === INVALID_INDEX_SWEEP_SQL);
    expect(sweepQuery?.values).toEqual([PREVIEW_SCHEMA]);
  });

  it("bounds the connect and the query so it can never hang the deploy", async () => {
    // This is the LAST step of a deploy: an unbounded wait hangs the build rather
    // than failing it, which the never-throws contract alone does not cover.
    const connectOpts: unknown[] = [];
    const statements: string[] = [];
    await sweepInvalidIndexes(DB_URL, "public", {
      createClient: (_url, opts) => {
        connectOpts.push(opts);
        return fakeClient((text) => {
          statements.push(text);
          return { rows: [] };
        });
      },
      logger: { warn: () => undefined },
    });

    expect(connectOpts[0]).toEqual({ connectionTimeoutMillis: 15_000 });
    expect(statements[0]).toBe("SET statement_timeout = '30000ms'");
  });

  it("clamps both bounds to the caller's remaining budget, never to zero", async () => {
    const connectOpts: unknown[] = [];
    const statements: string[] = [];
    await sweepInvalidIndexes(DB_URL, "public", {
      budgetMs: 0,
      createClient: (_url, opts) => {
        connectOpts.push(opts);
        return fakeClient((text) => {
          statements.push(text);
          return { rows: [] };
        });
      },
      logger: { warn: () => undefined },
    });

    // Postgres reads statement_timeout = 0 as "no timeout", so the floor matters.
    expect(connectOpts[0]).toEqual({ connectionTimeoutMillis: 1000 });
    expect(statements[0]).toBe("SET statement_timeout = '1000ms'");
  });

  it("sweeps public when neither the url nor the caller names a schema", async () => {
    let target: unknown;
    await sweepInvalidIndexes(DB_URL, null, {
      createClient: () =>
        fakeClient((text, values) => {
          if (text === INVALID_INDEX_SWEEP_SQL) {
            target = (values as string[])[0];
          }
          return { rows: [] };
        }),
      logger: { warn: () => undefined },
    });

    expect(target).toBe("public");
    expect(resolveSweepSchema(DB_URL, null)).toBe("public");
  });

  it("sweeps the schema the url names when the caller resolved none", async () => {
    // `resolveSchemaName` returns null whenever PGSCHEMA is unset and the deploy
    // is not a Vercel preview, and `addSchemaToUrl` then leaves DATABASE_URL
    // alone — so Prisma migrates the url's OWN schema. Defaulting to `public`
    // here swept a schema nobody migrated and printed a clean line about it.
    const url = `${DB_URL}&schema=app`;
    let target: unknown;
    await sweepInvalidIndexes(url, null, {
      createClient: () =>
        fakeClient((text, values) => {
          if (text === INVALID_INDEX_SWEEP_SQL) {
            target = (values as string[])[0];
          }
          return { rows: [] };
        }),
      logger: { warn: () => undefined },
    });

    expect(target).toBe("app");
  });

  it("lets the url's schema win over the argument, mirroring addSchemaToUrl", () => {
    // `addSchemaToUrl` only sets `schema` when the url does not already carry
    // one, so an existing url param is what Prisma actually migrated.
    expect(resolveSweepSchema(`${DB_URL}&schema=app`, PREVIEW_SCHEMA)).toBe(
      "app"
    );
    expect(resolveSweepSchema(DB_URL, PREVIEW_SCHEMA)).toBe(PREVIEW_SCHEMA);
    expect(resolveSweepSchema("not-a-url", PREVIEW_SCHEMA)).toBe(
      PREVIEW_SCHEMA
    );
  });

  it("spends the caller's budget ONCE across the connect and the query", async () => {
    // Clamping both bounds to `budgetMs` independently let one sweep consume up
    // to 2x the walk's remaining admission deadline.
    vi.useFakeTimers();
    try {
      const connectOpts: unknown[] = [];
      const statements: string[] = [];
      await sweepInvalidIndexes(DB_URL, "public", {
        budgetMs: 20_000,
        createClient: (_url, opts) => {
          connectOpts.push(opts);
          return {
            // The connect burns 5s of the 20s budget.
            connect: () => {
              vi.advanceTimersByTime(5000);
              return Promise.resolve();
            },
            query: (text: string) => {
              statements.push(text);
              return Promise.resolve({ rows: [] });
            },
            end: () => Promise.resolve(),
          };
        },
        logger: { warn: () => undefined },
      });

      expect(connectOpts[0]).toEqual({ connectionTimeoutMillis: 15_000 });
      // 20s budget - 5s spent connecting = 15s left, not the full 20s again.
      expect(statements[0]).toBe("SET statement_timeout = '15000ms'");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports unknown rather than clean when the driver result has no rows array", async () => {
    const found = await sweepInvalidIndexes(DB_URL, "public", {
      createClient: () => fakeClient(() => ({ notRows: true })),
      logger: { warn: () => undefined },
    });

    // `[]` would claim a verified-clean schema this run never actually read.
    expect(found).toBeNull();
  });

  it("still reports the other findings when one index vanishes mid-sweep", async () => {
    // `pg_get_indexdef` returns NULL (it does not error) for an index dropped
    // between the catalog scan and the function call, so a non-string definition
    // is reachable. Throwing on it would discard the whole batch.
    const warnings: string[] = [];
    const vanished = {
      ...INVALID,
      name: "gone_idx",
      definition: null,
    } as unknown as InvalidIndex;
    const found = await sweepInvalidIndexes(DB_URL, "public", {
      createClient: () => fakeClient(() => ({ rows: [vanished, INVALID] })),
      logger: { warn: (message) => warnings.push(message) },
    });

    expect(found?.map((index) => index.name)).toEqual([
      "gone_idx",
      "session_detail_model_started_at_idx",
    ]);
    expect(warnings[0]).toContain("definition unavailable");
    expect(warnings[0]).toContain("public.session_detail_model_started_at_idx");
  });

  it("warns with the named index when one is invalid, and stays silent when none are", async () => {
    const warnings: string[] = [];
    const logger = { warn: (message: string) => warnings.push(message) };

    await sweepInvalidIndexes(DB_URL, "public", {
      createClient: () => fakeClient(() => ({ rows: [] })),
      logger,
    });
    expect(warnings).toEqual([]);

    await sweepInvalidIndexes(DB_URL, "public", {
      createClient: () => fakeClient(() => ({ rows: [INVALID] })),
      logger,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("public.session_detail_model_started_at_idx");
  });

  it("returns null (unknown), not an empty list, when the sweep itself fails", async () => {
    const warnings: string[] = [];
    const found = await sweepInvalidIndexes(DB_URL, "public", {
      createClient: () =>
        fakeClient(() => {
          throw new Error("connection terminated unexpectedly");
        }),
      logger: { warn: (message) => warnings.push(message) },
    });

    // An empty array would claim "verified clean", which this run did not earn.
    expect(found).toBeNull();
    expect(warnings[0]).toContain("UNVERIFIED");
  });

  it("closes the connection even when the query throws", async () => {
    const end = vi.fn(() => Promise.resolve());
    await sweepInvalidIndexes(DB_URL, "public", {
      createClient: () => ({
        connect: () => Promise.resolve(),
        query: () => Promise.reject(new Error("boom")),
        end,
      }),
      logger: { warn: () => undefined },
    });

    expect(end).toHaveBeenCalledTimes(1);
  });
});

describe("formatInvalidIndexReport (ISS-4601)", () => {
  it("renders the ISS-4565 recovery recipe for the specific index", () => {
    const report = formatInvalidIndexReport([INVALID]);

    expect(report).toContain("public.session_detail_model_started_at_idx");
    expect(report).toContain("on session_detail");
    expect(report).toContain("SET lock_timeout = '5s';");
    expect(report).toContain(
      'DROP INDEX CONCURRENTLY IF EXISTS "public"."session_detail_model_started_at_idx";'
    );
    // The rebuild is derived from the live definition, with CONCURRENTLY added —
    // a plain DROP/CREATE would take ACCESS EXCLUSIVE on a hot table.
    expect(report).toContain(
      "CREATE INDEX CONCURRENTLY session_detail_model_started_at_idx ON public.session_detail USING btree (model, session_started_at);"
    );
    expect(report).toContain("never from a migration file");
  });

  it("does not claim migrate deploy can never repair an invalid index", () => {
    // The sweep is schema-wide and reads no migration history, so it cannot know
    // whether the owning migration is recorded applied. Asserting the
    // already-applied case unconditionally walks an operator whose fail-closed
    // migration is still PENDING into a hand-rebuild, and the next
    // `migrate deploy` then wedges on SQLSTATE 42P07.
    const report = formatInvalidIndexReport([INVALID]);

    expect(report).not.toContain(
      "`prisma migrate deploy` will NOT repair these"
    );
    expect(report).toContain("RECORDED APPLIED");
    expect(report).toContain("NOT RECORDED APPLIED");
    expect(report).toContain("_prisma_migrations");
    expect(report).toContain("42P07");
  });

  it("adds CONCURRENTLY to a unique rebuild too, and names every index", () => {
    const report = formatInvalidIndexReport([
      INVALID,
      {
        schema: "public",
        name: "search_document_key",
        table: "search_document",
        ready: true,
        definition:
          "CREATE UNIQUE INDEX search_document_key ON public.search_document USING btree (organization_id)",
      },
    ]);

    expect(report).toContain("2 INVALID index(es)");
    expect(report).toContain(
      "CREATE UNIQUE INDEX CONCURRENTLY search_document_key ON public.search_document USING btree (organization_id);"
    );
  });

  it("labels BOTH remnant states, including the cancelled-validation one", () => {
    // `indisready` is TRUE once the FIRST pass finishes; `indisvalid` only flips
    // after the SECOND. The ready=true case is the one the module exists for and
    // used to print no label at all.
    expect(formatInvalidIndexReport([INVALID_READY])).toContain(
      "(built, but its validation pass never finished)"
    );
    expect(formatInvalidIndexReport([INVALID])).toContain(
      "(its first build pass never finished)"
    );
  });

  it("never renders a null table as the string 'null'", () => {
    // `pg_get_indexdef` returns NULL for an index dropped between the catalog
    // scan and the call, which takes the table name with it.
    const report = formatInvalidIndexReport([
      { ...INVALID, table: null, ready: null, definition: null },
    ]);

    expect(report).not.toContain("on null");
    expect(report).toContain("table unknown");
    expect(report).toContain("definition unavailable");
  });

  it("gives case (b) the same lock-bounded concurrent drop as case (a) (ISS-6397)", () => {
    // Why the shipped "an unused invalid index is instant" rationale does not
    // make a plain drop safe: see `lockSafeDropLines`.
    const report = formatInvalidIndexReport([INVALID]);

    expect(report).toContain(
      `${CONCURRENT_DROP_INDEX} IF EXISTS <schema>.<index>;`
    );
    expect(report).not.toContain("an unused invalid index is instant");
  });

  it("warns about AUTOCOMMIT above every drop, not below one (ISS-6397)", () => {
    // Case (b) is now a CONCURRENTLY statement too, so the transaction warning
    // has to reach an operator reading top-down BEFORE the drop they paste —
    // below it, it arrives after the SQLSTATE 25001 it exists to prevent.
    const lines = formatInvalidIndexReport([INVALID]).split("\n");
    const warningAt = lines.findIndex((line) =>
      line.includes(AUTOCOMMIT_WARNING)
    );
    const firstDropAt = lines.findIndex(isDropStatement);

    expect(warningAt).toBeGreaterThanOrEqual(0);
    expect(firstDropAt).toBeGreaterThan(warningAt);
  });

  it("emits no blocking DROP INDEX in any report it can render (ISS-6397)", () => {
    // The durable half of ISS-6397: executed over real emitted output, across
    // every branch of the renderer, so a third recipe cannot reintroduce a
    // blocking drop without turning this red.
    const reports = [
      formatInvalidIndexReport([]),
      formatInvalidIndexReport([INVALID]),
      formatInvalidIndexReport([
        INVALID_READY,
        { ...INVALID, table: null, ready: null, definition: null },
      ]),
      formatInvalidIndexReport([
        { ...INVALID, name: "foo'bar", definition: null },
      ]),
    ];

    for (const report of reports) {
      const dropLines = report.split("\n").filter(isDropStatement);

      // Per report, not summed: an aggregate floor over all four reports stays
      // satisfied when the case (b) drop is deleted, because the per-index
      // recipes still render enough lines to meet it. The empty report is what
      // makes this a real per-site sentinel — it carries case (b) and nothing else.
      expect(dropLines.length).toBeGreaterThan(0);
      for (const line of dropLines) {
        // Anchored, not `toContain`: a plain drop whose trailing comment merely
        // MENTIONS the concurrent form would satisfy a substring search. That is
        // not hypothetical — a shipped migration comment of exactly that shape is
        // the fixture in preview-heavy-migrations.test.ts's comment-evasion test.
        expect(line.trim().startsWith(CONCURRENT_DROP_INDEX)).toBe(true);
      }
    }
  });

  it("owns the lock_timeout failure instead of sending the operator back to Prisma (ISS-6397)", () => {
    // `SET lock_timeout = '5s'` makes failure after five seconds an EXPECTED
    // outcome of the drop, and the invalid index SURVIVES it. The guidance an
    // operator reads next therefore differs from the success path: it shipped as
    // an unconditional "re-run `prisma migrate deploy`", which walks a timed-out
    // drop straight into the 42P07 this same report warns about two lines above.
    // Asserted at EVERY drop site, because case (a)'s rebuild has the identical
    // hazard and both route through `lockSafeDropLines`.
    const lines = formatInvalidIndexReport([INVALID]).split("\n");
    const dropSites = lines.flatMap((line, at) =>
      isDropStatement(line) ? [at] : []
    );

    expect(dropSites.length).toBeGreaterThan(0);
    for (const at of dropSites) {
      const onTimeout = lines[at + 1];

      expect(onTimeout).toContain(LOCK_TIMEOUT);
      expect(onTimeout.toLowerCase()).toContain("retry");
      // The timeout path must NOT be the success path: no rerun instruction here.
      expect(onTimeout).not.toContain(MIGRATE_DEPLOY);
    }

    // ...and the rerun itself is gated on the drop having actually succeeded.
    const rerunLines = lines.filter((line) =>
      line.includes(RERUN_MIGRATE_DEPLOY)
    );

    expect(rerunLines).toHaveLength(1);
    expect(rerunLines[0]).toContain("ONLY once that DROP has succeeded");
  });

  it("escapes an apostrophe in the ::regclass verification literal", () => {
    // `quoteIdentifier` escapes double quotes only. Embedded raw in a '...'
    // literal, an apostrophe in the index name terminates it early and the
    // operator's pasted recipe breaks AFTER the DROP above it has already run.
    const report = formatInvalidIndexReport([
      { ...INVALID, name: "foo'bar", table: "t", definition: null },
    ]);

    expect(report).toContain(
      `SELECT indisvalid FROM pg_index WHERE indexrelid = '"public"."foo''bar"'::regclass;`
    );
  });
});

describe("formatMigrateCompletionLine (ISS-4601)", () => {
  it("only reports unqualified success for a sweep that ran and found nothing", () => {
    expect(formatMigrateCompletionLine([])).toBe(
      "✓ Migrations completed successfully"
    );
  });

  it("qualifies the line and names the index when one is invalid", () => {
    const line = formatMigrateCompletionLine([INVALID]);

    expect(line).not.toContain("✓ Migrations completed successfully");
    expect(line).toContain("NOT a clean deploy");
    expect(line).toContain("public.session_detail_model_started_at_idx");
  });

  it("reports UNVERIFIED rather than success when the sweep did not run", () => {
    const line = formatMigrateCompletionLine(null);

    expect(line).not.toContain("✓ Migrations completed successfully");
    expect(line).toContain("UNVERIFIED");
  });
});

describe("pipeline wiring (ISS-4601)", () => {
  it("sweeps after the migrate and puts the finding on the migrate_deploy event", async () => {
    const events: MigrateDeployEvent[] = [];
    const sweep = vi.fn(() => Promise.resolve([INVALID]));
    const runMigrate = vi.fn(() => Promise.resolve(false));
    const plainBuild = vi.fn(() => Promise.resolve());
    const deps = makePipelineDeps({
      sweepInvalidIndexes: sweep,
      runMigrate,
      plainBuildPreviewConcurrentIndexes: plainBuild,
    });

    const result = await applyMigrationsToSchema(
      DB_URL,
      PREVIEW_SCHEMA,
      "some-branch",
      {
        isNew: false,
        telemetry: { emit: (event) => events.push(event) },
      },
      deps
    );

    expect(sweep).toHaveBeenCalledWith(DB_URL, PREVIEW_SCHEMA, {
      budgetMs: undefined,
    });
    // Ordering is load-bearing: the sweep reads the state migrate deploy left, so
    // it must be LAST. Moving it above the migrate would otherwise stay green.
    const sweepOrder = sweep.mock.invocationCallOrder[0];
    expect(sweepOrder).toBeGreaterThan(
      runMigrate.mock.invocationCallOrder[0] ?? 0
    );
    expect(sweepOrder).toBeGreaterThan(
      plainBuild.mock.invocationCallOrder[0] ?? 0
    );
    expect(result.invalidIndexes).toEqual([INVALID]);
    expect(events).toHaveLength(1);
    expect(events[0].invalid_index_count).toBe(1);
    expect(events[0].invalid_indexes).toEqual([
      "session_detail_model_started_at_idx",
    ]);
  });

  it("runs the sweep even when the at-head probe skipped the migrate entirely", async () => {
    // The invalid index this exists to catch was left by an EARLIER deploy, so
    // gating the sweep on "this deploy applied something" would never see it.
    const deps = makePipelineDeps({
      probePreviewSchemaAtHead: vi.fn(() => Promise.resolve(true)),
      sweepInvalidIndexes: vi.fn(() => Promise.resolve([INVALID])),
    });

    const result = await applyMigrationsToSchema(
      DB_URL,
      PREVIEW_SCHEMA,
      "some-branch",
      { isNew: false, telemetry: { emit: () => undefined } },
      deps
    );

    expect(deps.runMigrate).not.toHaveBeenCalled();
    expect(deps.sweepInvalidIndexes).toHaveBeenCalledTimes(1);
    expect(result.invalidIndexes).toEqual([INVALID]);
  });

  it("leaves the telemetry count null when the sweep could not run", async () => {
    const events: MigrateDeployEvent[] = [];
    const deps = makePipelineDeps({
      sweepInvalidIndexes: vi.fn(() => Promise.resolve(null)),
    });

    const result = await applyMigrationsToSchema(
      DB_URL,
      PREVIEW_SCHEMA,
      "some-branch",
      { isNew: false, telemetry: { emit: (event) => events.push(event) } },
      deps
    );

    expect(result.invalidIndexes).toBeNull();
    // Null, never 0 — a monitor must not read an unrun sweep as clean.
    expect(events[0].invalid_index_count).toBeNull();
    expect(events[0].invalid_indexes).toBeNull();
  });

  it("keeps the deploy green and the outcome successful when the sweep REJECTS", async () => {
    // "Warn, never fail" lives inside the default sweep, but this is an
    // overridable dep and the pipeline spreads arbitrary overrides into it.
    // Unguarded, a rejecting seam reached the catch, was classified as a migrate
    // FAILURE, and printed `❌ Migration failed` with exitCode 1 — even though
    // migrate deploy, the clone and the plain-index build had all succeeded.
    const events: MigrateDeployEvent[] = [];
    const deps = makePipelineDeps({
      sweepInvalidIndexes: vi.fn(() =>
        Promise.reject(new Error("sweep seam exploded"))
      ),
    });

    const result = await applyMigrationsToSchema(
      DB_URL,
      PREVIEW_SCHEMA,
      "some-branch",
      { isNew: false, telemetry: { emit: (event) => events.push(event) } },
      deps
    );

    // Unknown, NOT clean — and the deploy still completed.
    expect(result.invalidIndexes).toBeNull();
    expect(formatMigrateCompletionLine(result.invalidIndexes)).toContain(
      "UNVERIFIED"
    );
    expect(events[0].outcome).toBe(MigrateOutcome.Ok);
    expect(events[0].invalid_index_count).toBeNull();
  });

  it("sweeps with the ISS-5285 re-minted url and the caller's remaining budget", async () => {
    // The sweep runs after the clone, the one step that can outlive the 15-minute
    // IAM token baked into the original url, so it must get the refreshed one.
    const refreshed = `${DB_URL}&token=fresh`;
    const sweep = vi.fn(() => Promise.resolve([]));
    const deps = makePipelineDeps({
      refreshDatabaseUrl: vi.fn(() => Promise.resolve(refreshed)),
      sweepInvalidIndexes: sweep,
    });

    await applyMigrationsToSchema(
      DB_URL,
      PREVIEW_SCHEMA,
      "some-branch",
      {
        isNew: false,
        serializeBudgetMs: 45_000,
        telemetry: { emit: () => undefined },
      },
      deps
    );

    expect(sweep).toHaveBeenCalledWith(refreshed, PREVIEW_SCHEMA, {
      budgetMs: 45_000,
    });
  });
});

/** The blocking form ISS-6397 removed, and the only form the report may emit. */
const DROP_INDEX = "DROP INDEX";
const CONCURRENT_DROP_INDEX = `${DROP_INDEX} CONCURRENTLY`;
const AUTOCOMMIT_WARNING = "psql in AUTOCOMMIT";
const LOCK_TIMEOUT = "lock_timeout";
const MIGRATE_DEPLOY = "migrate deploy";
const RERUN_MIGRATE_DEPLOY = "re-run `prisma migrate deploy`";

/**
 * A rendered DROP statement, not prose that merely mentions one — so a future
 * sentence like "never use a plain `DROP INDEX` here" cannot turn the guard red
 * and pressure the next author into loosening it.
 */
function isDropStatement(line: string): boolean {
  return line.trim().startsWith(DROP_INDEX);
}
