import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { migrationChecksum, stripConcurrentlyKeyword } from "../db-utils";
import { replayPendingMigrationsViaSql } from "../preview-sql-replay";

const URL = "postgresql://user:pw@db.example.com:5432/cl";
const SCHEMA = "preview_feat_iss_8039";
const MIGRATIONS_DIR = join(
  import.meta.dirname,
  "..",
  "..",
  "prisma",
  "migrations"
);
// Every `concurrently` occurrence, so the scan below can classify each one.
const CONCURRENTLY_OCCURRENCE_REGEX = /concurrently/i;
// The only executable shapes the strip is allowed to reach: a concurrent index
// build, and the one-statement concurrent drop ISS-12825 introduced, which the
// strip turns into a plain `DROP INDEX`.
const INDEX_HEAD_CONCURRENTLY_REGEX =
  /(?:create\s+(?:unique\s+)?|drop\s+)index\s+concurrently\b/i;
const MIGRATION_DDL_HEAD_REGEX = /^CREATE (?:UNIQUE )?(?:TABLE|INDEX)\s/;
const WHITESPACE_RUN_REGEX = /\s+/g;
const DOLLAR_TAG_OPEN_REGEX = /^\$[A-Za-z_]?[A-Za-z0-9_]*\$/;
const SILENT = { log: () => undefined, warn: () => undefined };

/** The migration DDL only — not the `_prisma_migrations` bookkeeping create. */
function migrationDdl(statements: { text: string }[]): string[] {
  return statements
    .map((s) => s.text)
    .filter(
      (text) =>
        MIGRATION_DDL_HEAD_REGEX.test(text) &&
        !text.includes("_prisma_migrations")
    );
}

/** A client that records every statement and can be told to fail on one. */
function makeClient(opts: { applied?: string[]; failOn?: string } = {}) {
  const statements: { text: string; values?: unknown[] }[] = [];
  const client = {
    connect: vi.fn(() => Promise.resolve()),
    end: vi.fn(() => Promise.resolve()),
    query: vi.fn((text: string, values?: unknown[]) => {
      statements.push({ text, values });
      if (opts.failOn && text.includes(opts.failOn)) {
        return Promise.reject(new Error(`boom: ${opts.failOn}`));
      }
      if (text.includes('SELECT "migration_name"')) {
        return Promise.resolve({
          rows: (opts.applied ?? []).map((migration_name) => ({
            migration_name,
          })),
        });
      }
      return Promise.resolve({ rowCount: 1 });
    }),
  };
  return { client, statements };
}

function deps(
  client: ReturnType<typeof makeClient>["client"],
  files: Record<string, string>
) {
  return {
    createClient: () => client,
    listMigrationDirs: () => Object.keys(files),
    readMigrationSql: (name: string) => {
      const sql = files[name];
      if (sql === undefined) {
        throw new Error(`no such migration ${name}`);
      }
      return sql;
    },
    logger: SILENT,
  };
}

const TWO_FILES = {
  "20260101000000_a": 'CREATE TABLE "a" ("id" TEXT);',
  "20260102000000_b": 'CREATE TABLE "b" ("id" TEXT);',
};

describe("replayPendingMigrationsViaSql (ISS-8039)", () => {
  it("applies each pending migration and records it applied", async () => {
    const { client, statements } = makeClient();
    const ok = await replayPendingMigrationsViaSql(
      URL,
      SCHEMA,
      deps(client, TWO_FILES)
    );

    expect(ok).toBe(true);
    expect(migrationDdl(statements)).toEqual([
      'CREATE TABLE "a" ("id" TEXT);',
      'CREATE TABLE "b" ("id" TEXT);',
    ]);
    const stamps = statements.filter((s) => s.text.includes("INSERT INTO"));
    expect(stamps.map((s) => s.values?.[0])).toEqual([
      "20260101000000_a",
      "20260102000000_b",
    ]);
    // Prisma's own checksum algorithm, over the file as read — NOT over the
    // CONCURRENTLY-stripped form, or a later `migrate deploy` would see drift.
    expect(stamps[0]?.values?.[1]).toBe(
      migrationChecksum(TWO_FILES["20260101000000_a"])
    );
  });

  it("scopes search_path to the preview schema before any DDL", async () => {
    const { client, statements } = makeClient();
    await replayPendingMigrationsViaSql(URL, SCHEMA, deps(client, TWO_FILES));

    const searchPathAt = statements.findIndex((s) =>
      s.text.startsWith("SET search_path")
    );
    const firstDdlAt = statements.findIndex(
      (s) => s.text === 'CREATE TABLE "a" ("id" TEXT);'
    );
    expect(statements[searchPathAt]?.text).toBe(
      `SET search_path TO "${SCHEMA}"`
    );
    // Unqualified DDL lands in the FIRST schema on the path; without this
    // ordering every migration would build in the shared stage `public`.
    expect(searchPathAt).toBeGreaterThanOrEqual(0);
    expect(searchPathAt).toBeLessThan(firstDdlAt);
  });

  it("refuses a schema that is not a preview schema", async () => {
    const { client, statements } = makeClient();
    for (const schema of ["public", "staging", null]) {
      const ok = await replayPendingMigrationsViaSql(
        URL,
        schema,
        deps(client, TWO_FILES)
      );
      expect(ok).toBe(false);
    }
    // PGSCHEMA accepts non-preview names, so the guard is what keeps `db push`-
    // class DDL off a production-adjacent schema. No connection, no statement.
    expect(client.connect).not.toHaveBeenCalled();
    expect(statements).toEqual([]);
  });

  it("skips migrations the pre-stamp already recorded applied", async () => {
    const { client, statements } = makeClient({
      applied: ["20260101000000_a"],
    });
    const ok = await replayPendingMigrationsViaSql(
      URL,
      SCHEMA,
      deps(client, TWO_FILES)
    );

    expect(ok).toBe(true);
    expect(migrationDdl(statements)).toEqual(['CREATE TABLE "b" ("id" TEXT);']);
  });

  it("strips CONCURRENTLY, which cannot run inside the implicit transaction", async () => {
    const { client, statements } = makeClient();
    const files = {
      "20260101000000_idx":
        'CREATE INDEX CONCURRENTLY "i" ON "t" ("c");\nCREATE UNIQUE INDEX CONCURRENTLY "u" ON "t" ("d");',
    };
    await replayPendingMigrationsViaSql(URL, SCHEMA, deps(client, files));

    const ddl = statements.find((s) => s.text.includes("CREATE INDEX"));
    // Whitespace is insignificant to Postgres and the strip leaves the keyword's
    // trailing space, exactly as `preview-plain-index.ts` always has; what must
    // hold is that both statements survive and neither still says CONCURRENTLY.
    expect(ddl?.text.replace(WHITESPACE_RUN_REGEX, " ")).toBe(
      'CREATE INDEX "i" ON "t" ("c"); CREATE UNIQUE INDEX "u" ON "t" ("d");'
    );
    expect(ddl?.text).not.toMatch(CONCURRENTLY_OCCURRENCE_REGEX);
  });

  it("declines instead of reporting success when the listing is empty", async () => {
    const { client, statements } = makeClient();
    const ok = await replayPendingMigrationsViaSql(URL, SCHEMA, {
      createClient: () => client,
      listMigrationDirs: () => [],
      readMigrationSql: () => "",
      logger: SILENT,
    });

    // An empty listing is a wrong migrations directory (ISS-6810), not "nothing
    // to do" — reporting true would leave the schema empty and every step green.
    expect(ok).toBe(false);
    expect(statements).toEqual([]);
  });

  it("falls back without throwing when a migration fails, keeping earlier ones recorded", async () => {
    const { client, statements } = makeClient({ failOn: 'CREATE TABLE "b"' });
    const ok = await replayPendingMigrationsViaSql(
      URL,
      SCHEMA,
      deps(client, TWO_FILES)
    );

    expect(ok).toBe(false);
    // The first migration is still recorded, so the `migrate deploy` fallback
    // resumes at "b" rather than re-running "a" against objects that exist.
    expect(
      statements
        .filter((s) => s.text.includes("INSERT INTO"))
        .map((s) => s.values?.[0])
    ).toEqual(["20260101000000_a"]);
    expect(client.end).toHaveBeenCalled();
  });
});

/**
 * Every quoted region in `sql`, in order — the bytes the strip must never reach.
 *
 * A REAL scan, not a regex: SQL comments contain apostrophes ("the deploy's hot
 * tables"), and a `/'(?:[^']|'')*'/` treats the first of those as an opening
 * quote and swallows everything to the next one — reporting whole comment
 * blocks as literals. Comments have to be consumed BEFORE literals can be found,
 * which is a lexer's job.
 */
function quotedRegions(sql: string): string[] {
  const regions: string[] = [];
  let i = 0;
  while (i < sql.length) {
    const rest = sql.slice(i);
    if (rest.startsWith("--")) {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl + 1;
      continue;
    }
    if (rest.startsWith("/*")) {
      // Postgres block comments nest.
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (sql.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      continue;
    }
    const dollarTag = DOLLAR_TAG_OPEN_REGEX.exec(rest)?.[0];
    if (dollarTag) {
      const close = sql.indexOf(dollarTag, i + dollarTag.length);
      const end = close === -1 ? sql.length : close + dollarTag.length;
      regions.push(sql.slice(i, end));
      i = end;
      continue;
    }
    if (rest.startsWith("'")) {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      regions.push(sql.slice(i, j));
      i = j;
      continue;
    }
    i++;
  }
  return regions;
}

/** `sql` with every quoted region replaced by an empty one, so a scan cannot see inside. */
function withoutQuotedRegions(sql: string): string {
  let out = sql;
  for (const region of quotedRegions(sql)) {
    out = out.replace(region, region.startsWith("'") ? "''" : "$q$$q$");
  }
  return out;
}

describe("the file-wide CONCURRENTLY strip is safe on the real migrations", () => {
  it("never alters a quoted region of any migration", () => {
    const offenders: string[] = [];
    for (const entry of readdirSync(MIGRATIONS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const sql = readFileSync(
        join(MIGRATIONS_DIR, entry.name, "migration.sql"),
        "utf8"
      );
      // The load-bearing assertion, and the one a line-classifying scan cannot
      // make: a literal riding on the SAME LINE as an index head passes any
      // head-matching check, and the strip is global, so it would rewrite the
      // literal's bytes while the original file's checksum is what gets
      // recorded applied. Compare the regions themselves.
      if (
        JSON.stringify(quotedRegions(stripConcurrentlyKeyword(sql))) !==
        JSON.stringify(quotedRegions(sql))
      ) {
        offenders.push(entry.name);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("finds the keyword only in an index head or a comment, outside quoted regions", () => {
    const offenders: string[] = [];
    for (const entry of readdirSync(MIGRATIONS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const sql = readFileSync(
        join(MIGRATIONS_DIR, entry.name, "migration.sql"),
        "utf8"
      );
      // Blank the quoted regions FIRST so an occurrence inside one cannot be
      // excused by an index head elsewhere on its line.
      for (const line of withoutQuotedRegions(sql).split("\n")) {
        if (!CONCURRENTLY_OCCURRENCE_REGEX.test(line)) {
          continue;
        }
        const isComment = line.trimStart().startsWith("--");
        if (!(isComment || INDEX_HEAD_CONCURRENTLY_REGEX.test(line))) {
          offenders.push(`${entry.name}: ${line.trim().slice(0, 90)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("REJECTS a predicate literal that rides on an index-head line", () => {
    // whitlockk's case: the head matches, so a line-classifying scan accepts the
    // whole line — and the global strip then rewrites the predicate's literal
    // while the checksum recorded applied is the ORIGINAL file's. If this ever
    // stops failing, the check above has stopped being able to see it.
    const hostile = `CREATE INDEX CONCURRENTLY "i" ON "t" ("c") WHERE "note" <> 'run concurrently';`;

    expect(INDEX_HEAD_CONCURRENTLY_REGEX.test(hostile)).toBe(true);
    expect(quotedRegions(stripConcurrentlyKeyword(hostile))).not.toEqual(
      quotedRegions(hostile)
    );
  });
});

describe("replayPendingMigrationsViaSql appliedInSchema (ISS-11785)", () => {
  it("replays only the migrations that schema has applied", async () => {
    const { client, statements } = makeClient();
    client.query.mockImplementation((text: string, values?: unknown[]) => {
      statements.push({ text, values });
      if (text.includes('SELECT "migration_name"')) {
        const rows = text.includes('"public"."_prisma_migrations"')
          ? [{ migration_name: "20260101000000_a" }]
          : [];
        return Promise.resolve({ rows });
      }
      return Promise.resolve({ rowCount: 1 });
    });

    const ok = await replayPendingMigrationsViaSql(URL, SCHEMA, {
      ...deps(client, TWO_FILES),
      appliedInSchema: "public",
    });

    expect(ok).toBe(true);
    expect(migrationDdl(statements)).toEqual(['CREATE TABLE "a" ("id" TEXT);']);
  });
});
