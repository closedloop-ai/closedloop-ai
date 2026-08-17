import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  containsConcurrentIndexBuild,
  isPreviewSkippableConcurrentIndexSql,
  migrationsToPrestampForPreview,
  PREVIEW_PLAIN_BUILD_CONCURRENT_INDEX_MIGRATIONS,
  PREVIEW_SKIPPABLE_CONCURRENT_INDEX_MIGRATIONS,
} from "../scripts/preview-heavy-migrations";
import { parsePlainIndexBuilds } from "../scripts/preview-plain-index";

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "prisma", "migrations");

const SQL_LINE_COMMENT_G = /--[^\n]*/g;
const SQL_BLOCK_COMMENT_G = /\/\*[\s\S]*?\*\//g;
const DROP_OR_ALTER_INDEX_RE = /\b(?:drop|alter)\s+index\b/i;

// Every migration directory that ships a migration.sql, paired with its raw SQL.
// Read once at collection time so the drift guard can scan the whole history.
const MIGRATION_SQL_BY_DIR: ReadonlyArray<readonly [string, string]> =
  readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry): readonly [string, string] | null => {
      const sqlPath = join(MIGRATIONS_DIR, entry.name, "migration.sql");
      return existsSync(sqlPath)
        ? [entry.name, readFileSync(sqlPath, "utf8")]
        : null;
    })
    .filter((pair): pair is readonly [string, string] => pair !== null);

describe("migrationsToPrestampForPreview", () => {
  it("returns the union of perf-skip and plain-build lists for a preview_ schema", () => {
    expect(migrationsToPrestampForPreview("preview_my_branch_abc123")).toEqual([
      ...PREVIEW_SKIPPABLE_CONCURRENT_INDEX_MIGRATIONS,
      ...PREVIEW_PLAIN_BUILD_CONCURRENT_INDEX_MIGRATIONS,
    ]);
  });

  // ISS-6814: a fresh schema is empty during migrate, so the plain-build
  // (unique, FK-referenced) entries run natively and only perf entries stamp.
  it("returns only the perf-skip list for a FRESH preview_ schema", () => {
    expect(
      migrationsToPrestampForPreview("preview_my_branch_abc123", {
        freshSchema: true,
      })
    ).toEqual([...PREVIEW_SKIPPABLE_CONCURRENT_INDEX_MIGRATIONS]);
    expect(
      migrationsToPrestampForPreview("public", { freshSchema: true })
    ).toEqual([]);
  });

  it("returns nothing for the public (non-preview) schema", () => {
    expect(migrationsToPrestampForPreview("public")).toEqual([]);
  });

  it("returns nothing for a null schema (default/prod deploy)", () => {
    expect(migrationsToPrestampForPreview(null)).toEqual([]);
  });

  it("does not treat a non-preview schema that merely contains 'preview' as preview", () => {
    expect(migrationsToPrestampForPreview("staging_preview_ish")).toEqual([]);
  });
});

describe("PREVIEW_SKIPPABLE_CONCURRENT_INDEX_MIGRATIONS", () => {
  // Config guard: every skip entry must name a real migration directory, so a
  // rename/typo fails CI instead of silently skipping nothing (or skipping the
  // wrong migration). Reads directory NAMES only — a declarative-artifact check,
  // not a source-text assertion over implementation .ts.
  it.each(
    PREVIEW_SKIPPABLE_CONCURRENT_INDEX_MIGRATIONS
  )("%s names an existing migration directory", (migrationName) => {
    expect(existsSync(join(MIGRATIONS_DIR, migrationName))).toBe(true);
  });

  it("has no duplicate entries", () => {
    const unique = new Set(PREVIEW_SKIPPABLE_CONCURRENT_INDEX_MIGRATIONS);
    expect(unique.size).toBe(
      PREVIEW_SKIPPABLE_CONCURRENT_INDEX_MIGRATIONS.length
    );
  });
});

describe("isPreviewSkippableConcurrentIndexSql", () => {
  it("flags a pure non-unique CREATE INDEX CONCURRENTLY body", () => {
    const sql = `-- CreateIndex
CREATE INDEX CONCURRENTLY "foo_bar_idx" ON "foo"("bar");`;
    expect(isPreviewSkippableConcurrentIndexSql(sql)).toBe(true);
  });

  it("flags a multi-statement bare non-unique CONCURRENTLY body with IF NOT EXISTS", () => {
    const sql = `CREATE INDEX CONCURRENTLY IF NOT EXISTS "a_idx" ON "t"("a");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "b_idx" ON "t"("b");`;
    expect(isPreviewSkippableConcurrentIndexSql(sql)).toBe(true);
  });

  it("does NOT flag a CREATE UNIQUE INDEX CONCURRENTLY (correctness constraint)", () => {
    // FEA-3857 shape: perf indexes bundled with a unique upsert key.
    const sql = `CREATE INDEX CONCURRENTLY "s_gin_idx" ON "s" USING GIN ("tsv");
CREATE UNIQUE INDEX CONCURRENTLY "s_org_type_id_key" ON "s"("org","type","id");`;
    expect(isPreviewSkippableConcurrentIndexSql(sql)).toBe(false);
  });

  it("does NOT flag a migration that also changes schema shape", () => {
    const sql = `CREATE TABLE "s" ("id" TEXT);
CREATE INDEX CONCURRENTLY "s_id_idx" ON "s"("id");`;
    expect(isPreviewSkippableConcurrentIndexSql(sql)).toBe(false);
  });

  it("does NOT flag a migration that DROPs an index alongside CREATE INDEX CONCURRENTLY", () => {
    // A DROP/ALTER INDEX is subtractive/mutating, not additive — skipping it on
    // preview would leave an index public no longer has, breaking the "sole
    // effect is additive perf indexes" contract.
    const sql = `CREATE INDEX CONCURRENTLY "t_new_idx" ON "t"("a");
DROP INDEX "t_old_idx";`;
    expect(isPreviewSkippableConcurrentIndexSql(sql)).toBe(false);
  });

  it("does NOT flag an ALTER INDEX alongside CREATE INDEX CONCURRENTLY", () => {
    const sql = `CREATE INDEX CONCURRENTLY "t_new_idx" ON "t"("a");
ALTER INDEX "t_old_idx" RENAME TO "t_renamed_idx";`;
    expect(isPreviewSkippableConcurrentIndexSql(sql)).toBe(false);
  });

  it("does NOT flag a DROP INDEX migration that only MENTIONS CONCURRENTLY in comments", () => {
    // PRD-536 G7 drop-redundant shape: the DDL is a plain DROP; CONCURRENTLY
    // appears only in the explanatory comment, which must be stripped first.
    const sql = `-- This is deliberately a plain DROP, not CREATE INDEX CONCURRENTLY,
-- because DROP INDEX CONCURRENTLY defeats Prisma's statement splitter.
DROP INDEX IF EXISTS "t_org_idx";`;
    expect(isPreviewSkippableConcurrentIndexSql(sql)).toBe(false);
  });

  it("does NOT flag a plain (non-concurrent) CREATE INDEX", () => {
    expect(
      isPreviewSkippableConcurrentIndexSql(
        `CREATE INDEX "t_a_idx" ON "t"("a");`
      )
    ).toBe(false);
  });
});

describe("PREVIEW_PLAIN_BUILD_CONCURRENT_INDEX_MIGRATIONS", () => {
  it.each(
    PREVIEW_PLAIN_BUILD_CONCURRENT_INDEX_MIGRATIONS
  )("%s names an existing migration directory", (migrationName) => {
    expect(existsSync(join(MIGRATIONS_DIR, migrationName))).toBe(true);
  });

  it("has no duplicate entries", () => {
    const unique = new Set(PREVIEW_PLAIN_BUILD_CONCURRENT_INDEX_MIGRATIONS);
    expect(unique.size).toBe(
      PREVIEW_PLAIN_BUILD_CONCURRENT_INDEX_MIGRATIONS.length
    );
  });

  it("does not overlap the perf-skip list (a migration is one category or the other)", () => {
    const perf = new Set<string>(PREVIEW_SKIPPABLE_CONCURRENT_INDEX_MIGRATIONS);
    for (const name of PREVIEW_PLAIN_BUILD_CONCURRENT_INDEX_MIGRATIONS) {
      expect(perf.has(name)).toBe(false);
    }
  });
});

describe("containsConcurrentIndexBuild", () => {
  it("flags a non-unique CREATE INDEX CONCURRENTLY", () => {
    expect(
      containsConcurrentIndexBuild(`CREATE INDEX CONCURRENTLY "x" ON "t"("a");`)
    ).toBe(true);
  });

  it("flags a CREATE UNIQUE INDEX CONCURRENTLY (the shape the perf classifier excludes)", () => {
    expect(
      containsConcurrentIndexBuild(
        `CREATE UNIQUE INDEX CONCURRENTLY "x_key" ON "t"("a","b");`
      )
    ).toBe(true);
  });

  it("flags the FEA-3857 mixed unique+perf bundle", () => {
    const sql = `CREATE INDEX CONCURRENTLY IF NOT EXISTS "s_gin" ON "s" USING GIN ("tsv");
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "s_key" ON "s"("o","t","e");`;
    expect(containsConcurrentIndexBuild(sql)).toBe(true);
  });

  it("does NOT flag a CONCURRENTLY mention that only appears in a comment", () => {
    const sql = `-- deliberately a plain DROP, not CREATE INDEX CONCURRENTLY
DROP INDEX IF EXISTS "t_idx";`;
    expect(containsConcurrentIndexBuild(sql)).toBe(false);
  });

  it("does NOT flag a plain (non-concurrent) CREATE INDEX", () => {
    expect(
      containsConcurrentIndexBuild(`CREATE INDEX "t_a_idx" ON "t"("a");`)
    ).toBe(false);
  });
});

describe("preview CONCURRENTLY universe drift guard (ISS-4437)", () => {
  // The load-bearing guard: EVERY migration that builds a `CREATE [UNIQUE] INDEX
  // CONCURRENTLY` must be accounted for on preview — pre-stamped as perf-skip,
  // listed for plain-build, or explicitly opted out. Without this a mixed
  // unique+perf bundle (the FEA-3857 shape, which the perf-only classifier
  // deliberately ignores) silently re-arms the P1002 CONCURRENTLY amplifier on
  // every preview deploy. Reads declarative migration.sql DDL only.
  const concurrentIndexMigrations = MIGRATION_SQL_BY_DIR.filter(([, sql]) =>
    containsConcurrentIndexBuild(sql)
  );

  it("scans a non-empty set of CONCURRENTLY-index migrations (sanity: the scan ran)", () => {
    expect(concurrentIndexMigrations.length).toBeGreaterThan(0);
  });

  it.each(
    concurrentIndexMigrations
  )("%s is perf-skipped or plain-built on preview (no opt-out escape)", (name) => {
    // ISS-4437 requires ZERO CONCURRENTLY builds on any preview schema, so the
    // `preview-skip: no` opt-out is NOT a valid pass here — it would leave the
    // migration to run CREATE INDEX CONCURRENTLY on every preview, re-arming the
    // storm. Every match MUST be perf-skipped (skipped) or plain-built (rebuilt
    // plain). (shafty023)
    const perfSkipped = PREVIEW_SKIPPABLE_CONCURRENT_INDEX_MIGRATIONS.some(
      (m) => m === name
    );
    const plainBuilt = PREVIEW_PLAIN_BUILD_CONCURRENT_INDEX_MIGRATIONS.some(
      (m) => m === name
    );
    expect(perfSkipped || plainBuilt).toBe(true);
  });

  it("classifies the FEA-3857 mixed bundle as plain-build (not perf-skip)", () => {
    const fea3857: string =
      "20260723030001_fea3857_search_document_concurrent_indexes";
    expect(
      PREVIEW_PLAIN_BUILD_CONCURRENT_INDEX_MIGRATIONS.some((m) => m === fea3857)
    ).toBe(true);
    expect(
      PREVIEW_SKIPPABLE_CONCURRENT_INDEX_MIGRATIONS.some((m) => m === fea3857)
    ).toBe(false);
  });
});

describe("preview CONCURRENTLY skip-list drift guard", () => {
  // Behavioral guard over the real migration history: any migration whose SQL is
  // a pure non-unique CREATE INDEX CONCURRENTLY body (the only safely-skippable
  // shape) MUST be pre-stamped on preview. Without this,
  // a forgotten perf-index migration silently re-arms the stage P1002 amplifier
  // on every preview deploy (PRD-536 G7's identity index did exactly this on
  // 2026-07-22). Reads declarative migration.sql DDL only — not implementation
  // .ts source.
  const skippableByShape = MIGRATION_SQL_BY_DIR.filter(([, sql]) =>
    isPreviewSkippableConcurrentIndexSql(sql)
  );

  it("scans a non-empty migration history (sanity: the scan actually ran)", () => {
    expect(skippableByShape.length).toBeGreaterThan(0);
  });

  it.each(
    skippableByShape
  )("%s (pure non-unique CREATE INDEX CONCURRENTLY) is pre-stamped on preview", (name) => {
    const listed = PREVIEW_SKIPPABLE_CONCURRENT_INDEX_MIGRATIONS.some(
      (m) => m === name
    );
    expect(listed).toBe(true);
  });
});

describe("preview plain-build index lifecycle guard (ISS-4437)", () => {
  // The plain-build path REPLAYS each entry's index DDL on every preview deploy.
  // If a LATER migration DROPs/ALTERs one of those indexes, the replay would undo
  // it → preview diverges from public. Fail CI so the plain-build list is
  // reconciled (see the RETIREMENT note on PREVIEW_PLAIN_BUILD_*).
  const cases = PREVIEW_PLAIN_BUILD_CONCURRENT_INDEX_MIGRATIONS.flatMap(
    (migrationName) => {
      const sql =
        MIGRATION_SQL_BY_DIR.find(([name]) => name === migrationName)?.[1] ??
        "";
      return parsePlainIndexBuilds(sql).map((build) => ({
        migrationName,
        indexName: build.name,
      }));
    }
  );

  it("has plain-build index names to guard (sanity)", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(
    cases
  )("$migrationName index $indexName is not DROP/ALTERed by any later migration", ({
    migrationName,
    indexName,
  }) => {
    const offenders = MIGRATION_SQL_BY_DIR.filter(
      ([name]) => name > migrationName
    )
      .filter(([, sql]) => {
        const code = sql
          .replace(SQL_BLOCK_COMMENT_G, " ")
          .replace(SQL_LINE_COMMENT_G, " ");
        return DROP_OR_ALTER_INDEX_RE.test(code) && code.includes(indexName);
      })
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });
});
