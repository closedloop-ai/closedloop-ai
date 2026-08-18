import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeMigrationSql,
  migrationChecksum,
  readMigrationSql,
} from "../scripts/db-utils";
import {
  migrationsToPrestampForPreview,
  PREVIEW_PLAIN_BUILD_CONCURRENT_INDEX_MIGRATIONS,
} from "../scripts/preview-heavy-migrations";
import {
  type PrestampClient,
  prestampSkippableMigrationsViaSql,
} from "../scripts/preview-prestamp";

const PREVIEW_SCHEMA = "preview_my_branch_abc12345";
// The prestamp iterates exactly what `migrationsToPrestampForPreview` returns for
// a preview schema (the union of the perf-skip and plain-build lists — one INSERT,
// and one log/warn, per entry), so these counts are derived from that set, never
// hardcoded to a single migration (which broke when FEA-3915 added a second
// skippable entry, and again when ISS-4437 added the plain-build category).
const SKIPPABLE = migrationsToPrestampForPreview(PREVIEW_SCHEMA);
const PLAIN_BUILD = new Set<string>(
  PREVIEW_PLAIN_BUILD_CONCURRENT_INDEX_MIGRATIONS
);
const REFUSING_ON_ERROR_RE = /refusing to proceed/i;
const PUBLIC_MIGRATIONS_TABLE_RE = /public\."_prisma_migrations"/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const STAMPED_RE = /Pre-stamped .* as applied on/;
const ALREADY_APPLIED_RE =
  /already applied on .* \(lock-free preview skip already in effect\)/;
const COULD_NOT_READ_RE = /could not read/i;
// A perf-only (never plain-build) entry, used to prove the FAIL-OPEN half of the
// per-category read contract without depending on list ordering.
const PERF_ONLY_MIGRATION = SKIPPABLE.find((name) => !PLAIN_BUILD.has(name));
// A realistic corruption rather than random noise: a migration saved as Latin-1,
// so `í` is the bare byte 0xED — a UTF-8 3-byte lead followed by a
// non-continuation byte, which is malformed. Shared by the decoder tests and the
// real-`readMigrationSql` tests at the bottom of this file.
const LATIN1_MIGRATION_BYTES = Buffer.from(
  '-- índice\nCREATE INDEX CONCURRENTLY IF NOT EXISTS "i" ON "T" ("c");\n',
  "latin1"
);

function makeClient(
  overrides: Partial<PrestampClient> & {
    queryImpl?: (text: string, values?: unknown[]) => Promise<unknown>;
  } = {}
) {
  const calls: { text: string; values?: unknown[] }[] = [];
  const client: PrestampClient = {
    connect: overrides.connect ?? vi.fn(() => Promise.resolve()),
    end: overrides.end ?? vi.fn(() => Promise.resolve()),
    query: vi.fn((text: string, values?: unknown[]) => {
      calls.push({ text, values });
      return overrides.queryImpl
        ? overrides.queryImpl(text, values)
        : Promise.resolve({ rowCount: 1 });
    }),
  };
  return { client, calls };
}

function makeLogger() {
  return { log: vi.fn(), warn: vi.fn() };
}

// Stand-in migration bodies, keyed by name, so the stamp has a file to checksum
// without touching the real migrations tree.
function fakeMigrationSql(migrationName: string): string {
  return `-- ${migrationName}\nCREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_${migrationName}" ON "T" ("c");\n`;
}

/** The messages passed to `logger.log`, in call order. */
function loggedMessages(logger: { log: { mock: { calls: unknown[][] } } }) {
  return logger.log.mock.calls.map((call) => String(call[0]));
}

describe("prestampSkippableMigrationsViaSql", () => {
  it("does nothing (no client created) for a non-preview schema", async () => {
    const createClient = vi.fn();
    await prestampSkippableMigrationsViaSql("postgres://x", "public", {
      createClient,
    });
    expect(createClient).not.toHaveBeenCalled();
  });

  it("does nothing for a null schema", async () => {
    const createClient = vi.fn();
    await prestampSkippableMigrationsViaSql("postgres://x", null, {
      createClient,
    });
    expect(createClient).not.toHaveBeenCalled();
  });

  it("on a preview schema: creates _prisma_migrations then stamps each migration with its derived checksum", async () => {
    const { client, calls } = makeClient();
    const logger = makeLogger();
    await prestampSkippableMigrationsViaSql("postgres://x", PREVIEW_SCHEMA, {
      createClient: () => client,
      readMigrationSql: fakeMigrationSql,
      logger,
    });

    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.end).toHaveBeenCalledTimes(1);
    // 1 CREATE TABLE IF NOT EXISTS, then exactly one INSERT per skippable
    // migration — no follow-up presence query, because `NOT EXISTS` leaves only
    // one reason for the INSERT to affect zero rows.
    expect(calls).toHaveLength(1 + SKIPPABLE.length);
    expect(calls[0].text).toContain("CREATE TABLE IF NOT EXISTS");
    expect(calls[0].text).toContain(`"${PREVIEW_SCHEMA}"."_prisma_migrations"`);
    for (const [i, migrationName] of SKIPPABLE.entries()) {
      const insert = calls[i + 1];
      expect(insert.text).toContain("INSERT INTO");
      expect(insert.values).toEqual([
        migrationName,
        migrationChecksum(fakeMigrationSql(migrationName)),
      ]);
    }
    // Assert the MESSAGE, not just the call count: rowCount > 0 is the
    // "newly stamped" branch, and inverting the condition must fail this test.
    expect(loggedMessages(logger)).toHaveLength(SKIPPABLE.length);
    for (const message of loggedMessages(logger)) {
      expect(message).toMatch(STAMPED_RE);
    }
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("logs (does NOT warn) on the steady-state redeploy where the row is already present in the preview schema", async () => {
    // The INSERT's `NOT EXISTS` guard matches nothing (row already there) → 0
    // rows → benign, no false CONCURRENTLY-risk warning, no throw.
    const { client } = makeClient({
      queryImpl: () => Promise.resolve({ rowCount: 0 }),
    });
    const logger = makeLogger();
    await prestampSkippableMigrationsViaSql("postgres://x", PREVIEW_SCHEMA, {
      createClient: () => client,
      readMigrationSql: fakeMigrationSql,
      logger,
    });
    expect(logger.warn).not.toHaveBeenCalled();
    // The OTHER branch — again by message, so the two cannot be swapped silently.
    expect(loggedMessages(logger)).toHaveLength(SKIPPABLE.length);
    for (const message of loggedMessages(logger)) {
      expect(message).toMatch(ALREADY_APPLIED_RE);
    }
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  // ————————————————————————————————————————————————————————————————
  // ISS-4600: the introducing PR's own previews.
  //
  // Before this fix the stamp was `INSERT ... SELECT FROM public."_prisma_migrations"`,
  // so a migration that had not yet landed on stage `public` had no row to copy:
  // the INSERT affected 0 rows and a perf migration fell through to the
  // CONCURRENTLY build (fail-open) while a plain-build one threw. Both of the
  // tests below fail against that implementation.
  // ————————————————————————————————————————————————————————————————

  it("stamps a brand-new migration with NO applied row anywhere in public (ISS-4600)", async () => {
    // The introducing-PR shape is expressed by ASSERTING that no statement reads
    // `public."_prisma_migrations"` at all (below), not by mocking a public
    // lookup to return nothing — the fixed implementation issues no such query,
    // so a mock keyed on it would be inert scaffolding that proves nothing.
    const { client, calls } = makeClient();
    const logger = makeLogger();

    await prestampSkippableMigrationsViaSql("postgres://x", PREVIEW_SCHEMA, {
      createClient: () => client,
      readMigrationSql: fakeMigrationSql,
      logger,
    });

    // Every migration — perf-skip AND plain-build — was positively stamped.
    expect(logger.log).toHaveBeenCalledTimes(SKIPPABLE.length);
    expect(logger.warn).not.toHaveBeenCalled();
    // The stamp must not depend on `public` at all: NO statement issued may read
    // it (not just the INSERT), and every INSERT must carry a real derived
    // sha256 as its checksum.
    for (const call of calls) {
      expect(call.text).not.toMatch(PUBLIC_MIGRATIONS_TABLE_RE);
    }
    const inserts = calls.filter((c) => c.text.includes("INSERT INTO"));
    expect(inserts).toHaveLength(SKIPPABLE.length);
    for (const insert of inserts) {
      expect(insert.values?.[1]).toMatch(SHA256_HEX_RE);
    }
    // Including the correctness (plain-build) entries, which used to hard-fail
    // every preview deploy on their own PR until the migration reached public.
    for (const migrationName of PLAIN_BUILD) {
      expect(inserts.some((i) => i.values?.[0] === migrationName)).toBe(true);
    }
  });

  it("FAIL-OPEN: an unreadable PERF-ONLY migration warns and still stamps the rest", async () => {
    // The per-category contract: a perf index is worth a seq scan, never a failed
    // deploy. Without the per-migration read guard this aborts the whole loop and
    // (the plain-build list being non-empty) hard-fails the deploy — and leaves
    // the plain-build entry, which comes last, unstamped.
    expect(PERF_ONLY_MIGRATION).toBeDefined();
    const { client, calls } = makeClient();
    const logger = makeLogger();

    await prestampSkippableMigrationsViaSql("postgres://x", PREVIEW_SCHEMA, {
      createClient: () => client,
      readMigrationSql: (name) => {
        if (name === PERF_ONLY_MIGRATION) {
          throw new Error("ENOENT: migration.sql missing");
        }
        return fakeMigrationSql(name);
      },
      logger,
    });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0][0])).toMatch(COULD_NOT_READ_RE);
    // Every OTHER migration still got stamped — including the plain-build entry.
    const inserts = calls.filter((c) => c.text.includes("INSERT INTO"));
    expect(inserts).toHaveLength(SKIPPABLE.length - 1);
    for (const migrationName of PLAIN_BUILD) {
      expect(inserts.some((i) => i.values?.[0] === migrationName)).toBe(true);
    }
  });

  it("FAIL-CLOSED: an unreadable PLAIN-BUILD migration refuses to proceed", async () => {
    // The correctness half of the same contract: we could not confirm its
    // CONCURRENTLY build is skipped, so never let migrate deploy run it.
    const { client } = makeClient();
    const logger = makeLogger();

    await expect(
      prestampSkippableMigrationsViaSql("postgres://x", PREVIEW_SCHEMA, {
        createClient: () => client,
        readMigrationSql: (name) => {
          if (PLAIN_BUILD.has(name)) {
            throw new Error("ENOENT: migration.sql missing");
          }
          return fakeMigrationSql(name);
        },
        logger,
      })
    ).rejects.toThrow(REFUSING_ON_ERROR_RE);
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it("derives Prisma's canonical checksum: sha256 of the migration file (ISS-4600)", () => {
    // Provenance: this exact byte sequence was applied by `prisma migrate deploy`
    // 7.8.0 against a throwaway Postgres 16, and Prisma wrote the checksum below
    // into `_prisma_migrations`.
    //
    // SCOPE — this is a RECORDED value, not a live comparison. It never invokes
    // the installed Prisma, so it pins OUR derivation against the OBSERVED 7.8.0
    // output: it fails when we change the algorithm, NOT when a Prisma upgrade
    // does. Grounding it against Prisma would need a real Postgres for Prisma to
    // write a fresh row (7.8.0 computes the checksum in the Rust schema engine
    // and exposes no JS API), i.e. a DB-backed integration test rather than this
    // fixture. Do not restate the stronger claim here (ISS-4600 review).
    //
    // That grounded comparison now lives in
    // `__tests__/integration/preview-prestamp.integration.test.ts` (ISS-5788),
    // which reads the checksums Prisma wrote into `public._prisma_migrations`.
    // This fixture keeps its narrower job: fast, DB-free, ours-only.
    const migrationSql =
      '-- Perf-only index, PRD-547 shape.\nCREATE INDEX CONCURRENTLY IF NOT EXISTS "Widget_name_idx" ON "Widget" ("name");\n';
    expect(migrationChecksum(migrationSql)).toBe(
      "b1cd125bfe09a8baf14ccb29adef0cbea307212c517cff7a49ffcd5c8ee5d22f"
    );
  });

  /*
   * ISS-6814. On a FRESH schema (created or reset in this run) every table is
   * empty during `migrate deploy`, and the plain-build entries are the unique
   * correctness indexes a LATER migration's foreign key may reference
   * (`iss6058_branch_activity_atoms` references its predecessor's two). Stamping
   * them and rebuilding after migrate leaves that FK with nothing to point at
   * (42830, before the rebuild runs), so on a fresh schema they are NOT stamped
   * — they run natively, in milliseconds, on empty tables. Perf entries still are.
   */
  it("on a FRESH preview schema: stamps only the perf-skip entries, never a plain-build one", async () => {
    const { client, calls } = makeClient();
    const logger = makeLogger();
    await prestampSkippableMigrationsViaSql("postgres://x", PREVIEW_SCHEMA, {
      createClient: () => client,
      readMigrationSql: fakeMigrationSql,
      logger,
      freshSchema: true,
    });

    const stamped = calls.slice(1).map((call) => String(call.values?.[0]));
    const perfOnly = migrationsToPrestampForPreview(PREVIEW_SCHEMA, {
      freshSchema: true,
    });
    expect(stamped).toEqual([...perfOnly]);
    expect(stamped.length).toBeGreaterThan(0);
    for (const name of stamped) {
      expect(PLAIN_BUILD.has(name), name).toBe(false);
    }
    // And the non-fresh scope is strictly larger by exactly the plain-build set.
    expect(SKIPPABLE.length - perfOnly.length).toBe(PLAIN_BUILD.size);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("on a FRESH preview schema a query error is fail-OPEN (no plain-build entry in scope)", async () => {
    // Nothing correctness-critical is being stamped, so an error just means
    // migrate deploy runs the perf builds itself — on empty tables, harmless.
    const { client } = makeClient({
      queryImpl: () => Promise.reject(new Error("connection reset")),
    });
    const logger = makeLogger();
    await expect(
      prestampSkippableMigrationsViaSql("postgres://x", PREVIEW_SCHEMA, {
        createClient: () => client,
        readMigrationSql: fakeMigrationSql,
        logger,
        freshSchema: true,
      })
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("THROWS (fail-closed) on a connection/query error while a plain-build entry is in scope", async () => {
    // A connect/query failure means we cannot confirm the plain-build entry's
    // CONCURRENTLY build is skipped → refuse rather than risk re-arming the storm.
    const { client } = makeClient({
      queryImpl: () => Promise.reject(new Error("connection reset")),
    });
    const logger = makeLogger();
    await expect(
      prestampSkippableMigrationsViaSql("postgres://x", PREVIEW_SCHEMA, {
        createClient: () => client,
        logger,
      })
    ).rejects.toThrow(REFUSING_ON_ERROR_RE);
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  // With a plain-build (correctness) entry in scope, ANY error is fail-CLOSED
  // (ISS-4437): we cannot confirm its CONCURRENTLY build is skipped, so refuse
  // rather than let migrate deploy re-arm the storm. (Perf-only would fail-open,
  // but the plain-build list is non-empty.)
  it("is fail-closed: a synchronous client-factory throw propagates", async () => {
    const logger = makeLogger();
    await expect(
      prestampSkippableMigrationsViaSql("postgres://x", PREVIEW_SCHEMA, {
        createClient: () => {
          throw new Error("bad url");
        },
        logger,
      })
    ).rejects.toThrow(REFUSING_ON_ERROR_RE);
  });

  it("is fail-closed: a query error propagates (connection still closed)", async () => {
    const { client } = makeClient({
      queryImpl: () => Promise.reject(new Error("boom")),
    });
    const logger = makeLogger();
    await expect(
      prestampSkippableMigrationsViaSql("postgres://x", PREVIEW_SCHEMA, {
        createClient: () => client,
        logger,
      })
    ).rejects.toThrow(REFUSING_ON_ERROR_RE);
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it("is fail-closed: a connect error propagates (no queries issued)", async () => {
    const client: PrestampClient = {
      connect: vi.fn(() => Promise.reject(new Error("no connect"))),
      query: vi.fn(() => Promise.resolve({ rowCount: 0 })),
      end: vi.fn(() => Promise.resolve()),
    };
    const logger = makeLogger();
    await expect(
      prestampSkippableMigrationsViaSql("postgres://x", PREVIEW_SCHEMA, {
        createClient: () => client,
        logger,
      })
    ).rejects.toThrow(REFUSING_ON_ERROR_RE);
    expect(client.query).not.toHaveBeenCalled();
  });
});

describe("decodeMigrationSql: malformed migration.sql (ISS-4600 review)", () => {
  it("throws instead of substituting U+FFFD like readFileSync(…, 'utf8') does", () => {
    // Proves the fixture is genuinely malformed AND that the lenient decode this
    // replaced was silent about it: it returns a plausible string whose bytes are
    // not the file's, which is exactly what got hashed and stamped as applied.
    expect(LATIN1_MIGRATION_BYTES.toString("utf8")).toContain("�");
    expect(() => decodeMigrationSql(LATIN1_MIGRATION_BYTES)).toThrow();
  });

  it("is byte-exact on valid UTF-8, keeping a BOM as a real character", () => {
    // `ignoreBOM: true` means "do not strip it". Stripping would silently change
    // the bytes `migrationChecksum` hashes for a BOM'd file.
    const withBom = Buffer.from("﻿-- ok\n", "utf8");
    expect(decodeMigrationSql(withBom)).toBe("﻿-- ok\n");
  });

  it("routes a corrupt PLAIN-BUILD migration to the existing fail-CLOSED path", () => {
    // The production consequence, through the real decoder: before this, the
    // corrupt file produced a checksum over U+FFFD bytes and the migration was
    // stamped APPLIED — and `migrate deploy` matches an applied row without
    // validating the checksum, so it skipped the build of an unreadable
    // migration. It must take the same refusal an unreadable file already takes.
    const { client, calls } = makeClient();
    const logger = makeLogger();

    return expect(
      prestampSkippableMigrationsViaSql("postgres://x", PREVIEW_SCHEMA, {
        createClient: () => client,
        readMigrationSql: (name) =>
          PLAIN_BUILD.has(name)
            ? decodeMigrationSql(LATIN1_MIGRATION_BYTES)
            : fakeMigrationSql(name),
        logger,
      })
    )
      .rejects.toThrow(REFUSING_ON_ERROR_RE)
      .then(() => {
        const inserts = calls.filter((c) => c.text.includes("INSERT INTO"));
        expect(
          inserts.some((i) => PLAIN_BUILD.has(String(i.values?.[0])))
        ).toBe(false);
      });
  });
});

// ————————————————————————————————————————————————————————————————
// ISS-5788: the REAL `readMigrationSql`, not an injected stub.
//
// Every test above (and every one in the integration file) passes its own
// `readMigrationSql` through `deps`, so the production read+decode composition
// and its `process.cwd()` path resolution — which the prestamp depends on for the
// first time as of ISS-4600 — had NO coverage at all: reverting the body to
// `readFileSync(join(...), "utf8")` left the whole suite green while a Latin-1
// `migration.sql` was again hashed over U+FFFD-substituted bytes and stamped
// APPLIED. These drive the real function against real files on disk.
// ————————————————————————————————————————————————————————————————
describe("readMigrationSql (production read+decode, ISS-5788)", () => {
  const MIGRATION_NAME = "20260101000000_iss5788_fixture";
  let fakeCwd: string;

  beforeEach(() => {
    fakeCwd = mkdtempSync(join(tmpdir(), "iss5788-migrations-"));
    vi.spyOn(process, "cwd").mockReturnValue(fakeCwd);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(fakeCwd, { recursive: true, force: true });
  });

  /** Writes `<cwd>/prisma/migrations/<name>/migration.sql`, returning its path. */
  function writeMigrationFile(
    migrationName: string,
    bytes: Uint8Array
  ): string {
    const migrationDir = join(fakeCwd, "prisma", "migrations", migrationName);
    mkdirSync(migrationDir, { recursive: true });
    const migrationSqlPath = join(migrationDir, "migration.sql");
    writeFileSync(migrationSqlPath, bytes);
    return migrationSqlPath;
  }

  it("resolves prisma/migrations/<name>/migration.sql off process.cwd() and returns its bytes verbatim", () => {
    // The path resolution the prestamp newly depends on, plus a byte-exact
    // round trip: a BOM survives, because `migrationChecksum` hashes what this
    // returns and stripping it would hash bytes the file does not contain.
    const migrationSql = '﻿-- ok\nCREATE INDEX "i" ON "T" ("c");\n';
    writeMigrationFile(MIGRATION_NAME, Buffer.from(migrationSql, "utf8"));

    expect(readMigrationSql(MIGRATION_NAME)).toBe(migrationSql);
  });

  it("THROWS on a malformed (Latin-1) migration.sql, naming the resolved path", () => {
    // Two things at once. That it throws AT ALL is the composition test: with a
    // lenient `readFileSync(…, "utf8")` this returns a plausible U+FFFD string
    // and nothing downstream notices. That the message carries the PATH is the
    // operator surface: Node's ERR_ENCODING_INVALID_ENCODED_DATA says only "The
    // encoded data was not valid for encoding utf-8", and the prestamp's
    // fail-CLOSED refusal interpolates just that — a red preview deploy with no
    // pointer to which of 302 migration files is corrupt.
    const migrationSqlPath = writeMigrationFile(
      MIGRATION_NAME,
      LATIN1_MIGRATION_BYTES
    );

    expect(() => readMigrationSql(MIGRATION_NAME)).toThrow(migrationSqlPath);
  });

  it("names the resolved path when migration.sql is missing entirely", () => {
    // The sibling failure, kept on the same contract so the two read errors are
    // equally actionable in the deploy log.
    expect(() => readMigrationSql(MIGRATION_NAME)).toThrow(
      join(fakeCwd, "prisma", "migrations", MIGRATION_NAME, "migration.sql")
    );
  });
});
